from contextlib import suppress
import asyncio
import base64
import json
import os
import struct
import unittest
import unittest.mock as mock

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

    async def receive(self, timeout: float = 2.0, *, max_payload_bytes: int | None = None):
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
            if max_payload_bytes is not None and length > max_payload_bytes:
                raise AssertionError(f"relay sent {length} bytes, receiver limit is {max_payload_bytes}")
            payload = await self.reader.readexactly(length)
            opcode = first & 0x0F
            if opcode == 0x8:
                return "close"
            if opcode == 0xA:
                return {"t": "__pong_frame__", "payload": payload.decode("utf-8")}
            return json.loads(payload.decode("utf-8"))
        return await asyncio.wait_for(read(), timeout)

    async def hello(self, room: str = "main", name: str = "Ann", game: str = "demo", **extra) -> dict:
        await self.send({"t": "hello", "v": relay.PROTOCOL_VERSION, "game": game, "room": room, "name": name, **extra})
        return await self.receive()

    async def close(self) -> None:
        self.writer.close()
        with suppress(ConnectionError, OSError):
            await self.writer.wait_closed()


class RelayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.handle = await relay.start_relay("127.0.0.1", 0, insecure_local=True, max_players=3)
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

    async def test_global_connection_budget_includes_half_open_handshakes(self) -> None:
        handle = await relay.start_relay("127.0.0.1", 0, insecure_local=True, max_connections=1)
        raw_writer = None
        rejected = None
        try:
            _reader, raw_writer = await asyncio.open_connection("127.0.0.1", handle.port)
            for _ in range(50):
                if len(handle.relay._writers) == 1:
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(len(handle.relay._writers), 1)
            rejected = await Client.connect(handle.port)
            self.assertEqual(rejected.status, "503")
            self.assertLessEqual(len(handle.relay._writers), 1)

            raw_writer.close()
            await raw_writer.wait_closed()
            for _ in range(50):
                if not handle.relay._writers:
                    break
                await asyncio.sleep(0.01)
            self.assertFalse(handle.relay._writers)
            permitted = await Client.connect(handle.port)
            self.assertEqual(permitted.status, "101")
            await permitted.close()
        finally:
            if raw_writer is not None:
                raw_writer.close()
            if rejected is not None:
                await rejected.close()
            await handle.close()

    async def test_global_room_limit_rejects_new_rooms_but_allows_existing_ones(self) -> None:
        handle = await relay.start_relay("127.0.0.1", 0, insecure_local=True, max_rooms=2)
        clients = []
        try:
            async def client():
                instance = await Client.connect(handle.port)
                clients.append(instance)
                return instance

            first, second, rejected, same_room = await client(), await client(), await client(), await client()
            self.assertEqual((await first.hello(room="alpha"))["t"], "welcome")
            self.assertEqual((await second.hello(room="beta"))["t"], "welcome")
            rejected_error = await rejected.hello(room="third")
            self.assertEqual(rejected_error["code"], "full")
            self.assertEqual(len(handle.relay.rooms), 2)
            self.assertEqual((await same_room.hello(room="alpha"))["t"], "welcome")
            await first.receive()  # joined

            await second.close()
            for _ in range(50):
                if "beta" not in handle.relay.rooms:
                    break
                await asyncio.sleep(0.01)
            self.assertNotIn("beta", handle.relay.rooms)
            next_room = await client()
            self.assertEqual((await next_room.hello(room="third"))["t"], "welcome")
        finally:
            for item in clients:
                await item.close()
            await handle.close()

    async def test_idle_joined_client_is_disconnected_and_room_reclaimed(self) -> None:
        handle = await relay.start_relay("127.0.0.1", 0, insecure_local=True, max_rooms=1, idle_timeout=0.05)
        client = await Client.connect(handle.port)
        try:
            self.assertEqual((await client.hello(room="temporary"))["t"], "welcome")
            self.assertIsNone(await client.receive(timeout=1))
            for _ in range(50):
                if not handle.relay.rooms:
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(handle.relay.rooms, {})
        finally:
            await client.close()
            await handle.close()

    async def test_cancelled_join_does_not_leave_a_ghost_peer_or_room(self) -> None:

        hello = json.dumps({"t": "hello", "v": relay.PROTOCOL_VERSION, "game": "demo", "room": "main", "name": "Late"}).encode()
        reader = asyncio.StreamReader()
        writer = object()
        relay_instance = relay.Relay(max_players=2, insecure_local=True)

        async def hang(_peer, _message):
            await asyncio.Event().wait()

        with mock.patch.object(relay, "read_message", return_value=(relay._OP_TEXT, hello)), \
             mock.patch.object(relay.Peer, "send", hang):
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(relay_instance._join(reader, writer), 0.01)
        self.assertNotIn("main", relay_instance.rooms)

        # When the welcome succeeds but broadcast stalls, keep the existing
        # host and make the provisional slot available again.
        host = relay.Peer("original", "Host", object(), 0.0)
        room = relay.Room("main", "demo", [host])
        relay_instance.rooms["main"] = room

        async def delivered(_peer, _message):
            return None

        async def hang_broadcast(_room, _message, *, skip=None):
            await asyncio.Event().wait()

        with mock.patch.object(relay, "read_message", return_value=(relay._OP_TEXT, hello)), \
             mock.patch.object(relay.Peer, "send", delivered), \
             mock.patch.object(relay_instance, "broadcast", hang_broadcast):
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(relay_instance._join(reader, writer), 0.01)
        self.assertIs(relay_instance.rooms["main"], room)
        self.assertEqual(room.peers, [host])
        self.assertIs(room.host, host)

    async def test_a_stalled_reader_does_not_delay_healthy_room_peers(self) -> None:
        class FakeTransport:
            def get_write_buffer_size(self):
                return 0

        class FakeWriter:
            def __init__(self, *, stalled=False, pending=0):
                self.stalled = stalled
                self.pending = pending
                self.transport = FakeTransport()
                self.transport.get_write_buffer_size = lambda: self.pending
                self.writes = []
                self.closed = False
                self.sent = asyncio.Event()
                self.block = asyncio.Event()

            def write(self, data):
                self.writes.append(data)
                self.sent.set()

            async def drain(self):
                if self.stalled:
                    await self.block.wait()

            def close(self):
                self.closed = True

        slow_writer = FakeWriter(stalled=True)
        fast_writer = FakeWriter()
        slow = relay.Peer("slow", "Slow", slow_writer, 0.0)
        fast = relay.Peer("fast", "Fast", fast_writer, 0.0)
        room = relay.Room("test", "demo", [slow, fast])
        relay_instance = relay.Relay(insecure_local=True)
        with mock.patch.object(relay, "PEER_SEND_TIMEOUT_SECONDS", 1.0):
            broadcasting = asyncio.create_task(relay_instance.broadcast(room, {"t": "event", "name": "ping", "payload": 1}))
            # Give busy Windows CI runners time to schedule the healthy writer,
            # but require delivery before the slow peer's one-second deadline.
            await asyncio.wait_for(fast_writer.sent.wait(), 0.5)
            self.assertFalse(broadcasting.done())
            await asyncio.wait_for(broadcasting, 2.0)
        self.assertTrue(slow_writer.closed)
        self.assertFalse(fast_writer.closed)
        self.assertEqual(len(fast_writer.writes), 1)

        # A peer already past the outgoing byte cap is dropped before another
        # frame is queued, without impacting the healthy client.
        slow_writer.pending = relay.MAX_PEER_PENDING_BYTES
        slow_writer.closed = False
        slow_writer.writes.clear()
        await relay_instance.broadcast(room, {"t": "event", "name": "ping", "payload": 2})
        self.assertTrue(slow_writer.closed)
        self.assertEqual(slow_writer.writes, [])
        self.assertEqual(len(fast_writer.writes), 2)

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

    async def test_state_relay_rejects_outbound_frame_over_receiver_budget(self) -> None:
        # A near-limit inbound state can grow past 64 KiB when the relay
        # appends its sender ID. Keep the incoming packet valid in both the
        # ASCII and UTF-8 cases, so only the outgoing check can reject it.
        for prefix in ("x" * 200, "\u00e9" * 20 + "x" * 150):
            with self.subTest(prefix=prefix[:4]):
                ann, bob = await self.client(), await self.client()
                ann_id = (await ann.hello(name="Ann"))["you"]
                await bob.hello(name="Bob")
                await ann.receive()  # joined
                entity = {"id": prefix, "position": [0, 0, 0], "rotation": [0, 0, 0]}
                message = {"t": "state", "seq": 1, "time": 1, "entities": [dict(entity) for _ in range(256)]}
                remaining = relay.MAX_MESSAGE_BYTES - 4 - len(relay._wire_bytes(message))
                self.assertGreater(remaining, 0)
                for current in message["entities"]:
                    grow = min(remaining, 256 - len(current["id"]))
                    current["id"] += "x" * grow
                    remaining -= grow
                    if not remaining:
                        break
                self.assertEqual(remaining, 0)
                inbound = relay._wire_bytes(message)
                self.assertEqual(len(inbound), relay.MAX_MESSAGE_BYTES - 4)
                outgoing = {"t": "state", "from": ann_id, "seq": 1, "time": 1, "entities": message["entities"]}
                self.assertGreater(len(relay._wire_bytes(outgoing)), relay.MAX_MESSAGE_BYTES)

                await ann.send_raw(0x1, inbound)
                await self.assertRejected(ann, "bad_message")
                self.assertEqual((await bob.receive(max_payload_bytes=relay.MAX_MESSAGE_BYTES))["t"], "left")
                await bob.close()

    async def test_large_unicode_and_ascii_events_reach_all_peers_within_wire_budget(self) -> None:
        ann, bob, cat = await self.client(), await self.client(), await self.client()
        ann_id = (await ann.hello(name="Ann"))["you"]
        await bob.hello(name="Bob")
        await ann.receive()
        await cat.hello(name="Cat")
        await ann.receive()
        await bob.receive()

        # Default Python json.dumps would expand each emoji into 12 ASCII bytes,
        # making this accepted 32-KiB inbound event exceed the browser's limit.
        for text in ("\U0001f600" * 8000, "a" * (relay.MAX_MESSAGE_BYTES - 128)):
            with self.subTest(text_size=len(text)):
                event = {"t": "event", "name": "large", "payload": text}
                wire = json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                self.assertLessEqual(len(wire), relay.MAX_MESSAGE_BYTES)
                await ann.send_raw(0x1, wire)
                expected = {"t": "event", "from": ann_id, "name": "large", "payload": text}
                for recipient in (bob, cat):
                    self.assertEqual(
                        await recipient.receive(max_payload_bytes=relay.MAX_MESSAGE_BYTES), expected,
                    )

    async def test_event_that_grows_beyond_wire_limit_is_rejected_at_sender(self) -> None:
        ann, bob = await self.client(), await self.client()
        await ann.hello(name="Ann")
        await bob.hello(name="Bob")
        await ann.receive()
        minimal = {"t": "event", "name": "edge", "payload": ""}
        overhead = len(json.dumps(minimal, separators=(",", ":")).encode("utf-8"))
        minimal["payload"] = "x" * (relay.MAX_MESSAGE_BYTES - overhead)
        wire = json.dumps(minimal, separators=(",", ":")).encode("utf-8")
        self.assertEqual(len(wire), relay.MAX_MESSAGE_BYTES)
        await ann.send_raw(0x1, wire)
        await self.assertRejected(ann, "bad_message")
        # It must not be broadcast silently as an oversized, unreadable event.
        self.assertEqual((await bob.receive(max_payload_bytes=relay.MAX_MESSAGE_BYTES))["t"], "left")

    async def test_escaped_unpaired_surrogate_remains_json_safe(self) -> None:
        ann, bob = await self.client(), await self.client()
        await ann.hello(name="Ann")
        await bob.hello(name="Bob")
        await ann.receive()
        await ann.send({"t": "event", "name": "edge", "payload": "\ud800"})
        delivered = await bob.receive(max_payload_bytes=relay.MAX_MESSAGE_BYTES)
        self.assertEqual(delivered["payload"], "\ud800")

    async def test_ping_returns_server_time_and_control_pings_get_pongs(self) -> None:
        ann = await self.client()
        await ann.hello()
        await ann.send({"t": "ping", "id": 4, "time": 99.5})
        pong = await ann.receive()
        self.assertEqual((pong["t"], pong["id"], pong["time"]), ("pong", 4, 99.5))
        self.assertGreaterEqual(pong["serverTime"], 0)
        await ann.send_raw(0x9, b"hi")
        self.assertEqual(await ann.receive(), {"t": "__pong_frame__", "payload": "hi"})

    async def test_control_frame_flood_is_bounded_across_messages_and_fragments(self) -> None:
        def frame(opcode: int, body: bytes, *, final: bool = True) -> bytes:
            self.assertLess(len(body), 126)
            mask = b"\x01\x02\x03\x04"
            return (bytes([(0x80 if final else 0) | opcode, 0x80 | len(body)]) + mask
                    + bytes(value ^ mask[index & 3] for index, value in enumerate(body)))

        for mode in ("plain", "interleaved", "fragmented"):
            with self.subTest(mode=mode):
                client = await self.client()
                await client.hello()
                frames = []
                if mode == "fragmented":
                    # No complete JSON message ever arrives; the control budget
                    # must be checked inside read_message's fragment loop.
                    frames.append(frame(0x1, b'{"t":"ping",', final=False))
                for index in range(relay.MAX_CONTROL_FRAMES_PER_SECOND + 4):
                    frames.append(frame(0x9, b"ok"))
                    if mode == "interleaved" and index % 8 == 7:
                        # The limit must survive multiple read_message calls.
                        frames.append(frame(0x1, b'{"t":"ping","id":1,"time":0}'))
                # Send one burst so runner scheduling cannot split it into multiple
                # one-second accounting windows.
                client.writer.write(b"".join(frames))
                await client.writer.drain()
                pongs = 0
                while True:
                    result = await client.receive(timeout=3.0)
                    self.assertIsNotNone(result)
                    self.assertNotEqual(result, "close")
                    if result["t"] == "error":
                        self.assertEqual(result["code"], "rate_limited")
                        break
                    if result["t"] == "__pong_frame__":
                        pongs += 1
                self.assertLessEqual(pongs, relay.MAX_CONTROL_FRAMES_PER_SECOND)
                self.assertEqual(await client.receive(), "close")

        # One attacker's counter must not restrict healthy connections.
        healthy = await self.client()
        await healthy.hello()
        await healthy.send_raw(0x9, b"ok")
        self.assertEqual(await healthy.receive(), {"t": "__pong_frame__", "payload": "ok"})

    async def test_control_pong_write_has_a_deadline(self) -> None:

        class SlowWriter:
            class Transport:
                def get_write_buffer_size(self):
                    return 0

            transport = Transport()

            def write(self, _data):
                pass

            async def drain(self):
                await asyncio.Event().wait()

        mask = b"\x01\x02\x03\x04"
        reader = asyncio.StreamReader()
        reader.feed_data(b"\x89\x81" + mask + bytes([ord("x") ^ mask[0]]))
        with mock.patch.object(relay, "PEER_SEND_TIMEOUT_SECONDS", 0.01):
            with self.assertRaises(relay.ProtocolError) as raised:
                await relay.read_message(reader, SlowWriter())
        self.assertEqual(raised.exception.code, "rate_limited")

    async def test_fragmented_messages_are_joined(self) -> None:
        ann = await self.client()
        body = json.dumps({"t": "hello", "v": relay.PROTOCOL_VERSION, "game": "demo", "room": "main", "name": "Ann"}).encode("utf-8")
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
            {"t": "hello", "v": relay.PROTOCOL_VERSION, "game": "demo", "room": "bad/room", "name": "Ann"},
            {"t": "hello", "v": relay.PROTOCOL_VERSION, "game": "", "room": "main", "name": "Ann"},
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
        await other_game.send({"t": "hello", "v": relay.PROTOCOL_VERSION, "game": "other", "room": "main", "name": "Bob"})
        await self.assertRejected(other_game, "game_mismatch")
        for name in ("Bob", "Cat"):
            joined = await self.client()
            await joined.hello(name=name)
        full = await self.client()
        await full.send({"t": "hello", "v": relay.PROTOCOL_VERSION, "game": "demo", "room": "main", "name": "Dan"})
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
        self.handle = await relay.start_relay("127.0.0.1", 0, insecure_local=True, allowed_origins=["https://game.example"])
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


class AuthenticatedRelayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.token = relay.secrets.token_urlsafe(32)
        self.handle = await relay.start_relay("127.0.0.1", 0, host_token=self.token)
        self.clients: list[Client] = []

    async def asyncTearDown(self) -> None:
        for client in self.clients:
            await client.close()
        await self.handle.close()

    async def client(self) -> Client:
        client = await Client.connect(self.handle.port)
        self.clients.append(client)
        return client

    async def test_guest_cannot_reserve_room_and_bad_credentials_do_not_leak(self) -> None:
        early = await self.client()
        self.assertEqual((await early.hello(game="other"))["code"], "host_required")
        self.assertEqual(self.handle.relay.rooms, {})
        for credential in (None, 123, "short", "x" * 43, "\u00e9" * 43, "x" * 129):
            with self.subTest(kind=type(credential).__name__):
                invalid = await self.client()
                result = await invalid.hello(hostToken=credential)
                self.assertEqual(result["code"], "host_auth")
                self.assertNotIn(str(credential), result["message"])
                self.assertEqual(await invalid.receive(), "close")
        self.assertEqual(self.handle.relay.rooms, {})
        host = await self.client()
        welcome = await host.hello(name="Host", hostToken=self.token)
        self.assertEqual(welcome["host"], welcome["you"])
        self.assertNotIn(self.token, json.dumps(welcome))
        guest = await self.client()
        guest_welcome = await guest.hello(name="Guest")
        self.assertEqual(guest_welcome["host"], welcome["you"])
        self.assertNotIn(self.token, json.dumps(guest_welcome))
        self.assertEqual((await host.receive())["t"], "joined")
        duplicate = await self.client()
        self.assertEqual((await duplicate.hello(hostToken=self.token))["code"], "host_exists")
        wrong = await self.client()
        self.assertEqual((await wrong.hello(hostToken="x" * 43))["code"], "host_auth")

    async def test_host_departure_closes_room_without_guest_promotion_and_host_can_return(self) -> None:
        host = await self.client()
        first = await host.hello(hostToken=self.token)
        guest = await self.client()
        self.assertEqual((await guest.hello(name="Guest"))["host"], first["you"])
        await host.receive()  # joined
        previous_room = self.handle.relay.rooms["main"]
        previous_peer = previous_room.peers[1]
        await host.close()
        self.assertIsNone(await guest.receive())
        self.assertNotIn("main", self.handle.relay.rooms)
        early = await self.client()
        self.assertEqual((await early.hello())["code"], "host_required")
        replacement = await self.client()
        welcome = await replacement.hello(hostToken=self.token)
        self.assertEqual(welcome["host"], welcome["you"])
        self.assertNotEqual(welcome["you"], first["you"])
        # Old connection cleanup/dispatch cannot affect the replacement room.
        await self.handle.relay._leave(previous_peer, previous_room)
        self.assertIsNot(self.handle.relay.rooms["main"], previous_room)
        with self.assertRaises(relay.ProtocolError):
            await self.handle.relay._dispatch(previous_peer, previous_room, {"t": "ping", "id": 1, "time": 0})
        returning = await self.client()
        self.assertEqual((await returning.hello())["host"], welcome["you"])

    async def test_only_host_can_send_level_state_and_neither_can_impersonate_an_avatar(self) -> None:
        host = await self.client()
        host_id = (await host.hello(hostToken=self.token))["you"]
        guest = await self.client()
        guest_id = (await guest.hello(name="Guest"))["you"]
        await host.receive()

        def state(entity_id):
            return {"t": "state", "seq": 1, "time": 1, "entities": [
                {"id": entity_id, "position": [0, 0, 0], "rotation": [0, 0, 0]},
            ]}

        await host.send(state("door"))
        self.assertEqual((await guest.receive())["from"], host_id)
        await guest.send(state(f"player:{guest_id}"))
        self.assertEqual((await host.receive())["from"], guest_id)
        await guest.send(state("door"))
        self.assertEqual((await guest.receive())["code"], "state_owner")
        self.assertEqual((await host.receive())["t"], "left")
        guest2 = await self.client()
        guest2_id = (await guest2.hello())["you"]
        await host.receive()
        await guest2.send(state(f"player:{host_id}"))
        self.assertEqual((await guest2.receive())["code"], "state_owner")
        self.assertEqual((await host.receive())["t"], "left")
        await host.send(state(f"player:{guest2_id}"))
        self.assertEqual((await host.receive())["code"], "state_owner")

    async def test_provisional_host_cannot_admit_guests_and_failed_welcome_reclaims_room(self) -> None:
        instance = self.handle.relay
        host_hello = json.dumps({"t": "hello", "v": relay.PROTOCOL_VERSION, "game": "demo",
                                 "room": "main", "name": "Host", "hostToken": self.token}).encode()
        guest_hello = json.dumps({"t": "hello", "v": relay.PROTOCOL_VERSION, "game": "demo",
                                  "room": "main", "name": "Guest"}).encode()
        welcome_started = asyncio.Event()
        release = asyncio.Event()

        async def stalled(_peer, _message):
            welcome_started.set()
            await release.wait()
            return False

        host_writer = mock.Mock()
        with mock.patch.object(relay, "read_message", side_effect=[(relay._OP_TEXT, host_hello),
                                                                   (relay._OP_TEXT, guest_hello)]), \
             mock.patch.object(relay.Peer, "send", stalled):
            joining = asyncio.create_task(instance._join(asyncio.StreamReader(), host_writer))
            try:
                await asyncio.wait_for(welcome_started.wait(), 1)
                with self.assertRaises(relay.ProtocolError) as rejected:
                    await instance._join(asyncio.StreamReader(), mock.Mock())
                self.assertEqual(rejected.exception.code, "host_required")
                release.set()
                with self.assertRaises(ConnectionError):
                    await joining
            finally:
                release.set()
                if not joining.done():
                    joining.cancel()
                    with suppress(asyncio.CancelledError):
                        await joining
        self.assertEqual(instance.rooms, {})
        host_writer.close.assert_called_once()

    async def test_public_or_unconfigured_insecure_relay_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            await relay.start_relay("0.0.0.0", 0, insecure_local=True)
        with self.assertRaises(ValueError):
            await relay.start_relay("127.0.0.1", 0)
        with self.assertRaises(ValueError):
            await relay.start_relay("127.0.0.1", 0, host_token="short")
        with self.assertRaises(ValueError):
            await relay.start_relay("127.0.0.1", 0, host_token=self.token, insecure_local=True)


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
