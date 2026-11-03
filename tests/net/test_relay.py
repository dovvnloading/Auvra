import asyncio
import base64
import json
import os
import struct
import unittest

from Auvra.net import relay


class Client:
    """A minimal WebSocket client for the relay tests (masked text frames)."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.reader = reader
        self.writer = writer

    @classmethod
    async def connect(cls, port: int, origin: str | None = None) -> "Client":
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        headers = ["GET / HTTP/1.1", f"Host: 127.0.0.1:{port}", "Upgrade: websocket", "Connection: Upgrade",
                   f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13"]
        if origin:
            headers.append(f"Origin: {origin}")
        writer.write(("\r\n".join(headers) + "\r\n\r\n").encode("ascii"))
        await writer.drain()
        response = await reader.readuntil(b"\r\n\r\n")
        client = cls(reader, writer)
        client.status = response.split(b" ", 2)[1].decode("ascii")
        if client.status == "101":
            assert relay.accept_key(key).encode("ascii") in response
        return client

    async def send_raw(self, opcode: int, payload: bytes, fin: bool = True, masked: bool = True) -> None:
        header = bytearray([(0x80 if fin else 0) | opcode])
        length = len(payload)
        mask_bit = 0x80 if masked else 0
        if length < 126:
            header.append(mask_bit | length)
        elif length < 1 << 16:
            header.append(mask_bit | 126)
            header += struct.pack("!H", length)
        else:
            header.append(mask_bit | 127)
            header += struct.pack("!Q", length)
        if masked:
            mask = os.urandom(4)
            header += mask
            payload = bytes(byte ^ mask[index & 3] for index, byte in enumerate(payload))
        self.writer.write(bytes(header) + payload)
        await self.writer.drain()

    async def send(self, message: dict) -> None:
        await self.send_raw(0x1, json.dumps(message).encode("utf-8"))

    async def receive(self, timeout: float = 2.0):
        """The next text message as a dict, 'close' for a close frame, or None at end of stream."""
        async def read():
            try:
                first, second = await self.reader.readexactly(2)
            except asyncio.IncompleteReadError:
                return None
            length = second & 0x7F
            if length == 126:
                (length,) = struct.unpack("!H", await self.reader.readexactly(2))
            elif length == 127:
                (length,) = struct.unpack("!Q", await self.reader.readexactly(8))
            payload = await self.reader.readexactly(length)
            opcode = first & 0x0F
            if opcode == 0x8:
                return "close"
            if opcode == 0xA:
                return {"t": "__pong_frame__", "payload": payload.decode("utf-8")}
            return json.loads(payload.decode("utf-8"))
        return await asyncio.wait_for(read(), timeout)

    async def hello(self, room: str = "main", name: str = "Ann", game: str = "demo") -> dict:
        await self.send({"t": "hello", "v": 1, "game": game, "room": room, "name": name})
        return await self.receive()

    async def close(self) -> None:
        self.writer.close()
        try:
            await self.writer.wait_closed()
        except (ConnectionError, OSError):
            pass


class RelayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.handle = await relay.start_relay("127.0.0.1", 0, max_players=3)
        self.clients: list[Client] = []

    async def asyncTearDown(self) -> None:
        for client in self.clients:
            await client.close()
        await self.handle.close()

    async def client(self, **kwargs) -> Client:
        client = await Client.connect(self.handle.port, **kwargs)
        self.clients.append(client)
        return client

    async def test_welcome_names_the_host_and_peers_and_others_see_joins_and_leaves(self) -> None:
        ann = await self.client()
        welcome = await ann.hello(name="Ann")
        self.assertEqual(welcome["t"], "welcome")
        self.assertEqual(welcome["host"], welcome["you"])
        self.assertEqual(welcome["peers"], [])
        bob = await self.client()
        bob_welcome = await bob.hello(name="Bob")
        self.assertEqual(bob_welcome["host"], welcome["you"])
        self.assertEqual(bob_welcome["peers"], [{"id": welcome["you"], "name": "Ann"}])
        self.assertEqual(await ann.receive(), {"t": "joined", "peer": {"id": bob_welcome["you"], "name": "Bob"}})
        await bob.close()
        self.assertEqual(await ann.receive(), {"t": "left", "id": bob_welcome["you"]})

    async def test_host_moves_to_the_oldest_remaining_member(self) -> None:
        ann, bob, cat = await self.client(), await self.client(), await self.client()
        await ann.hello(name="Ann")
        bob_id = (await bob.hello(name="Bob"))["you"]
        await ann.receive()
        await cat.hello(name="Cat")
        await ann.receive()
        await bob.receive()
        await ann.close()
        self.assertEqual((await bob.receive())["t"], "left")
        self.assertEqual(await bob.receive(), {"t": "host", "id": bob_id})
        self.assertEqual((await cat.receive())["t"], "left")
        self.assertEqual(await cat.receive(), {"t": "host", "id": bob_id})

    async def test_state_and_events_reach_the_others_and_events_can_target_one_peer(self) -> None:
        ann, bob, cat = await self.client(), await self.client(), await self.client()
        ann_id = (await ann.hello(name="Ann"))["you"]
        bob_id = (await bob.hello(name="Bob"))["you"]
        await ann.receive()
        await cat.hello(name="Cat")
        await ann.receive()
        await bob.receive()
        entity = {"id": f"player:{ann_id}", "position": [1, 2, 3], "rotation": [0, 1.5, 0], "vars": {"Speed": 1, "IsJumping": False}}
        await ann.send({"t": "state", "seq": 7, "time": 1234.5, "entities": [entity]})
        for other in (bob, cat):
            self.assertEqual(await other.receive(), {"t": "state", "from": ann_id, "seq": 7, "time": 1234.5, "entities": [entity]})
        await ann.send({"t": "event", "name": "door", "payload": {"open": True}, "to": bob_id})
        self.assertEqual(await bob.receive(), {"t": "event", "from": ann_id, "name": "door", "payload": {"open": True}})
        await ann.send({"t": "event", "name": "score", "payload": 3})
        self.assertEqual((await cat.receive())["name"], "score")
        with self.assertRaises(asyncio.TimeoutError):
            await ann.receive(timeout=0.2)

    async def test_ping_returns_server_time_and_control_pings_get_pongs(self) -> None:
        ann = await self.client()
        await ann.hello()
        await ann.send({"t": "ping", "id": 4, "time": 99.5})
        pong = await ann.receive()
        self.assertEqual((pong["t"], pong["id"], pong["time"]), ("pong", 4, 99.5))
        self.assertGreaterEqual(pong["serverTime"], 0)
        await ann.send_raw(0x9, b"hi")
        self.assertEqual(await ann.receive(), {"t": "__pong_frame__", "payload": "hi"})

    async def test_fragmented_messages_are_joined(self) -> None:
        ann = await self.client()
        body = json.dumps({"t": "hello", "v": 1, "game": "demo", "room": "main", "name": "Ann"}).encode("utf-8")
        await ann.send_raw(0x1, body[:10], fin=False)
        await ann.send_raw(0x0, body[10:], fin=True)
        self.assertEqual((await ann.receive())["t"], "welcome")

    async def assertRejected(self, client: Client, code: str) -> None:
        error = await client.receive()
        self.assertEqual((error["t"], error["code"]), ("error", code))
        self.assertEqual(await client.receive(), "close")

    async def test_bad_messages_are_rejected(self) -> None:
        cases = [
            {"t": "state", "seq": 1, "time": 0, "entities": []},
            {"t": "hello", "v": 1, "game": "demo", "room": "bad/room", "name": "Ann"},
            {"t": "hello", "v": 1, "game": "", "room": "main", "name": "Ann"},
        ]
        for message in cases:
            with self.subTest(message=message):
                client = await self.client()
                await client.send(message)
                await self.assertRejected(client, "bad_message")
        unmasked = await self.client()
        await unmasked.send_raw(0x1, b"{}", masked=False)
        await self.assertRejected(unmasked, "bad_message")
        joined = await self.client()
        await joined.hello()
        await joined.send({"t": "state", "seq": 1, "time": 0, "entities": [{"id": "x", "position": [0, 0], "rotation": [0, 0, 0]}]})
        await self.assertRejected(joined, "bad_message")

    async def test_oversized_messages_are_rejected(self) -> None:
        client = await self.client()
        await client.hello()
        await client.send_raw(0x1, b"x" * (relay.MAX_MESSAGE_BYTES + 1))
        await self.assertRejected(client, "bad_message")

    async def test_version_game_and_capacity_are_enforced(self) -> None:
        old = await self.client()
        await old.send({"t": "hello", "v": 99, "game": "demo", "room": "main", "name": "Ann"})
        await self.assertRejected(old, "version")
        first = await self.client()
        await first.hello(game="demo")
        other_game = await self.client()
        await other_game.send({"t": "hello", "v": 1, "game": "other", "room": "main", "name": "Bob"})
        await self.assertRejected(other_game, "game_mismatch")
        for name in ("Bob", "Cat"):
            joined = await self.client()
            await joined.hello(name=name)
        full = await self.client()
        await full.send({"t": "hello", "v": 1, "game": "demo", "room": "main", "name": "Dan"})
        await self.assertRejected(full, "full")

    async def test_flooding_clients_are_dropped(self) -> None:
        client = await self.client()
        await client.hello()
        for index in range(relay.MAX_MESSAGES_PER_SECOND + 5):
            await client.send({"t": "ping", "id": index, "time": 0})
        while True:
            message = await client.receive()
            if message == "close" or message is None:
                self.fail("closed without a rate_limited error")
            if message["t"] == "error":
                self.assertEqual(message["code"], "rate_limited")
                break

    async def test_origin_allow_list(self) -> None:
        await self.handle.close()
        self.handle = await relay.start_relay("127.0.0.1", 0, allowed_origins=["https://game.example"])
        allowed = await self.client(origin="https://game.example")
        self.assertEqual(allowed.status, "101")
        denied = await self.client(origin="https://evil.example")
        self.assertEqual(denied.status, "403")

    async def test_rooms_are_separate(self) -> None:
        ann, bob = await self.client(), await self.client()
        await ann.hello(room="one")
        welcome = await bob.hello(room="two")
        self.assertEqual(welcome["peers"], [])
        self.assertEqual(welcome["host"], welcome["you"])


if __name__ == "__main__":
    unittest.main()


class QuietDisconnectTests(unittest.TestCase):
    def test_resets_are_quiet_and_other_errors_reach_the_default_handler(self):
        from Auvra.net import relay as relay_module
        seen = []

        class Loop:
            def default_exception_handler(self, context):
                seen.append(context)

        relay_module._quiet_disconnects(Loop(), {"exception": ConnectionResetError(10054, "reset")})
        relay_module._quiet_disconnects(Loop(), {"exception": ConnectionAbortedError()})
        self.assertEqual(seen, [])
        relay_module._quiet_disconnects(Loop(), {"exception": ValueError("real fault")})
        self.assertEqual(len(seen), 1)
