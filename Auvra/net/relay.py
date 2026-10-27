"""Multiplayer relay for Auvra games (standard library only).

Games connect over WebSocket and exchange JSON text frames (the wire format is
``fbx-viewer (1)/runtime/net/protocol.ts``). The relay groups clients into
rooms, forwards state and events to the other members of a room, and names one
member the host: the first to join, then the oldest remaining member when the
host leaves. It holds no game logic.

Run it with ``python -m Auvra.net.relay --port 7777``. The module imports
nothing outside the standard library, so it also runs as a single file copied
next to a game build (``python relay.py --port 7777``).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import math
import re
import secrets
import struct
import time
from dataclasses import dataclass, field
from typing import Any, Iterable

PROTOCOL_VERSION = 1
MAX_MESSAGE_BYTES = 64 * 1024
MAX_PEERS_PER_ROOM = 16
MAX_ROOM_LENGTH = 64
MAX_NAME_LENGTH = 32
MAX_GAME_LENGTH = 128
MAX_EVENT_NAME_LENGTH = 64
MAX_ENTITIES_PER_STATE = 256
MAX_VARS_PER_ENTITY = 32
MAX_MESSAGES_PER_SECOND = 120
MAX_HANDSHAKE_BYTES = 8 * 1024
HANDSHAKE_TIMEOUT_SECONDS = 10.0
HELLO_TIMEOUT_SECONDS = 10.0
NAME_PATTERN = re.compile(r"^[A-Za-z0-9 _.-]+$")
_WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

_OP_CONTINUATION, _OP_TEXT, _OP_BINARY, _OP_CLOSE, _OP_PING, _OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


class ProtocolError(Exception):
    """A client broke the WebSocket or relay protocol; ``code`` goes back to it in an error message."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


# --- WebSocket framing ---------------------------------------------------------

def accept_key(key: str) -> str:
    """The Sec-WebSocket-Accept value for a client's Sec-WebSocket-Key."""
    digest = hashlib.sha1((key + _WEBSOCKET_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def encode_frame(opcode: int, payload: bytes) -> bytes:
    """One unmasked, final server frame."""
    header = bytearray([0x80 | opcode])
    length = len(payload)
    if length < 126:
        header.append(length)
    elif length < 1 << 16:
        header.append(126)
        header += struct.pack("!H", length)
    else:
        header.append(127)
        header += struct.pack("!Q", length)
    return bytes(header) + payload


async def read_message(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> tuple[int, bytes] | None:
    """The next complete text message (fragments joined), answering pings on the way.

    Returns (opcode, payload) for a text message, (close opcode, payload) for a close, and None at end of stream.
    """
    fragments: list[bytes] = []
    total = 0
    while True:
        try:
            first, second = await reader.readexactly(2)
        except asyncio.IncompleteReadError:
            return None
        fin = bool(first & 0x80)
        if first & 0x70:
            raise ProtocolError("bad_message", "reserved frame bits are set")
        opcode = first & 0x0F
        if not second & 0x80:
            raise ProtocolError("bad_message", "client frames must be masked")
        length = second & 0x7F
        if length == 126:
            (length,) = struct.unpack("!H", await reader.readexactly(2))
        elif length == 127:
            (length,) = struct.unpack("!Q", await reader.readexactly(8))
        if opcode >= 0x8 and (length > 125 or not fin):
            raise ProtocolError("bad_message", "invalid control frame")
        if opcode < 0x8 and total + length > MAX_MESSAGE_BYTES:
            raise ProtocolError("bad_message", "message is too large")
        mask = await reader.readexactly(4)
        data = bytearray(await reader.readexactly(length))
        for index in range(length):
            data[index] ^= mask[index & 3]
        payload = bytes(data)

        if opcode == _OP_PING:
            writer.write(encode_frame(_OP_PONG, payload))
            await writer.drain()
            continue
        if opcode == _OP_PONG:
            continue
        if opcode == _OP_CLOSE:
            return _OP_CLOSE, payload
        if opcode == _OP_BINARY:
            raise ProtocolError("bad_message", "binary frames are not accepted")
        if opcode == _OP_TEXT:
            if fragments:
                raise ProtocolError("bad_message", "a new message started inside a fragmented one")
        elif opcode == _OP_CONTINUATION:
            if not fragments:
                raise ProtocolError("bad_message", "continuation without a message")
        else:
            raise ProtocolError("bad_message", "unknown opcode")
        fragments.append(payload)
        total += length
        if fin:
            return _OP_TEXT, b"".join(fragments)


async def handshake(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, allowed_origins: frozenset[str]) -> None:
    """Reads the HTTP upgrade request and answers 101 Switching Protocols (or an HTTP error, then raises)."""
    request = await reader.readuntil(b"\r\n\r\n")
    if len(request) > MAX_HANDSHAKE_BYTES:
        raise ProtocolError("bad_message", "handshake is too large")
    lines = request.decode("latin-1").split("\r\n")
    method, _, _ = (lines[0].split(" ") + ["", ""])[:3]
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if ":" in line:
            name, value = line.split(":", 1)
            headers[name.strip().lower()] = value.strip()
    upgrade_ok = (
        method == "GET"
        and headers.get("upgrade", "").lower() == "websocket"
        and "upgrade" in headers.get("connection", "").lower()
        and headers.get("sec-websocket-version") == "13"
        and headers.get("sec-websocket-key")
    )
    origin = headers.get("origin")
    if upgrade_ok and allowed_origins and origin not in allowed_origins:
        writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        await writer.drain()
        raise ProtocolError("bad_message", "origin is not allowed")
    if not upgrade_ok:
        writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        await writer.drain()
        raise ProtocolError("bad_message", "not a WebSocket upgrade")
    writer.write((
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept_key(headers['sec-websocket-key'])}\r\n\r\n"
    ).encode("ascii"))
    await writer.drain()


# --- Message validation --------------------------------------------------------

def _name(value: Any, limit: int) -> str | None:
    if isinstance(value, str) and 0 < len(value) <= limit and NAME_PATTERN.fullmatch(value):
        return value
    return None


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _vector(value: Any) -> bool:
    return isinstance(value, list) and len(value) == 3 and all(_finite(item) for item in value)


def validate_entities(entities: Any) -> list[dict[str, Any]]:
    """The entity states of a state message, or ProtocolError."""
    if not isinstance(entities, list) or len(entities) > MAX_ENTITIES_PER_STATE:
        raise ProtocolError("bad_message", "entities must be a list of at most 256 states")
    clean: list[dict[str, Any]] = []
    for entity in entities:
        if not isinstance(entity, dict) or set(entity) - {"id", "position", "rotation", "velocity", "vars"}:
            raise ProtocolError("bad_message", "invalid entity state")
        if not isinstance(entity.get("id"), str) or not 0 < len(entity["id"]) <= 256:
            raise ProtocolError("bad_message", "entity ids are 1-256 characters")
        if not _vector(entity.get("position")) or not _vector(entity.get("rotation")):
            raise ProtocolError("bad_message", "entity position and rotation are three finite numbers")
        if "velocity" in entity and not _vector(entity["velocity"]):
            raise ProtocolError("bad_message", "entity velocity is three finite numbers")
        if "vars" in entity:
            values = entity["vars"]
            if (not isinstance(values, dict) or len(values) > MAX_VARS_PER_ENTITY
                    or not all(isinstance(key, str) and len(key) <= 64 and (isinstance(item, bool) or _finite(item)) for key, item in values.items())):
                raise ProtocolError("bad_message", "entity vars are at most 32 numbers or booleans")
        clean.append(entity)
    return clean


def _payload(value: Any) -> bool:
    scalar = lambda item: isinstance(item, (str, bool)) or _finite(item)  # noqa: E731
    if value is None or scalar(value):
        return True
    if isinstance(value, list):
        return all(scalar(item) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and scalar(item) for key, item in value.items())
    return False


# --- Rooms ---------------------------------------------------------------------

@dataclass(eq=False)
class Peer:
    id: str
    name: str
    writer: asyncio.StreamWriter
    joined: float
    window_start: float = 0.0
    window_count: int = 0

    async def send(self, message: dict[str, Any]) -> None:
        try:
            self.writer.write(encode_frame(_OP_TEXT, json.dumps(message, separators=(",", ":")).encode("utf-8")))
            await self.writer.drain()
        except (ConnectionError, RuntimeError):
            pass


@dataclass(eq=False)
class Room:
    name: str
    game: str
    peers: list[Peer] = field(default_factory=list)

    @property
    def host(self) -> Peer | None:
        return self.peers[0] if self.peers else None


class Relay:
    """The room bookkeeping shared by every connection of one server."""

    def __init__(self, max_players: int = MAX_PEERS_PER_ROOM, allowed_origins: Iterable[str] = ()) -> None:
        self.max_players = max(1, min(MAX_PEERS_PER_ROOM, max_players))
        self.allowed_origins = frozenset(allowed_origins)
        self.rooms: dict[str, Room] = {}
        self._started = time.monotonic()
        self._writers: set[asyncio.StreamWriter] = set()

    def server_time(self) -> int:
        """Milliseconds since the relay started (monotonic)."""
        return int((time.monotonic() - self._started) * 1000)

    async def broadcast(self, room: Room, message: dict[str, Any], *, skip: Peer | None = None) -> None:
        for peer in list(room.peers):
            if peer is not skip:
                await peer.send(message)

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._writers.add(writer)
        peer: Peer | None = None
        room: Room | None = None
        try:
            await asyncio.wait_for(handshake(reader, writer, self.allowed_origins), HANDSHAKE_TIMEOUT_SECONDS)
            peer, room = await asyncio.wait_for(self._join(reader, writer), HELLO_TIMEOUT_SECONDS)
            while True:
                received = await read_message(reader, writer)
                if received is None or received[0] == _OP_CLOSE:
                    break
                self._count(peer)
                await self._dispatch(peer, room, self._decode(received[1]))
        except ProtocolError as error:
            await self._fail(writer, error)
        except (asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
            pass
        finally:
            if peer and room:
                await self._leave(peer, room)
            self._writers.discard(writer)
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass

    @staticmethod
    def _decode(payload: bytes) -> dict[str, Any]:
        try:
            message = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as error:
            raise ProtocolError("bad_message", "messages are JSON objects") from error
        if not isinstance(message, dict) or not isinstance(message.get("t"), str):
            raise ProtocolError("bad_message", "messages are JSON objects with a type")
        return message

    async def _join(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> tuple[Peer, Room]:
        received = await read_message(reader, writer)
        if received is None or received[0] == _OP_CLOSE:
            raise asyncio.IncompleteReadError(b"", None)
        hello = self._decode(received[1])
        if hello.get("t") != "hello":
            raise ProtocolError("bad_message", "the first message must be hello")
        if hello.get("v") != PROTOCOL_VERSION:
            raise ProtocolError("version", f"this relay speaks protocol version {PROTOCOL_VERSION}")
        game = hello.get("game")
        room_name = _name(hello.get("room"), MAX_ROOM_LENGTH)
        name = _name(hello.get("name"), MAX_NAME_LENGTH)
        if not isinstance(game, str) or not 0 < len(game) <= MAX_GAME_LENGTH or not room_name or not name:
            raise ProtocolError("bad_message", "hello needs a game id, a room and a name")
        room = self.rooms.get(room_name)
        if room is None:
            room = self.rooms[room_name] = Room(room_name, game)
        elif room.game != game:
            raise ProtocolError("game_mismatch", "this room is playing a different game")
        if len(room.peers) >= self.max_players:
            raise ProtocolError("full", "the room is full")
        peer = Peer(secrets.token_hex(6), name, writer, time.monotonic())
        room.peers.append(peer)
        await peer.send({
            "t": "welcome", "v": PROTOCOL_VERSION, "you": peer.id, "host": room.host.id if room.host else peer.id,
            "peers": [{"id": other.id, "name": other.name} for other in room.peers if other is not peer],
            "serverTime": self.server_time(),
        })
        await self.broadcast(room, {"t": "joined", "peer": {"id": peer.id, "name": peer.name}}, skip=peer)
        return peer, room

    def _count(self, peer: Peer) -> None:
        now = time.monotonic()
        if now - peer.window_start >= 1.0:
            peer.window_start = now
            peer.window_count = 0
        peer.window_count += 1
        if peer.window_count > MAX_MESSAGES_PER_SECOND:
            raise ProtocolError("rate_limited", "too many messages")

    async def _dispatch(self, peer: Peer, room: Room, message: dict[str, Any]) -> None:
        kind = message["t"]
        if kind == "state":
            if not isinstance(message.get("seq"), int) or isinstance(message.get("seq"), bool) or not _finite(message.get("time")):
                raise ProtocolError("bad_message", "state needs a seq and a time")
            entities = validate_entities(message.get("entities"))
            await self.broadcast(room, {"t": "state", "from": peer.id, "seq": message["seq"], "time": message["time"], "entities": entities}, skip=peer)
        elif kind == "event":
            name = message.get("name")
            if not isinstance(name, str) or not 0 < len(name) <= MAX_EVENT_NAME_LENGTH or not _payload(message.get("payload")):
                raise ProtocolError("bad_message", "events need a name and a plain payload")
            relayed = {"t": "event", "from": peer.id, "name": name, "payload": message.get("payload")}
            target = message.get("to")
            if target is None:
                await self.broadcast(room, relayed, skip=peer)
            elif isinstance(target, str):
                recipient = next((other for other in room.peers if other.id == target), None)
                if recipient and recipient is not peer:
                    await recipient.send(relayed)
            else:
                raise ProtocolError("bad_message", "event 'to' is a peer id")
        elif kind == "ping":
            if not isinstance(message.get("id"), int) or not _finite(message.get("time")):
                raise ProtocolError("bad_message", "ping needs an id and a time")
            await peer.send({"t": "pong", "id": message["id"], "time": message["time"], "serverTime": self.server_time()})
        else:
            raise ProtocolError("bad_message", f"unknown message type {kind[:32]!r}")

    async def _leave(self, peer: Peer, room: Room) -> None:
        was_host = room.host is peer
        if peer in room.peers:
            room.peers.remove(peer)
        if not room.peers:
            self.rooms.pop(room.name, None)
            return
        await self.broadcast(room, {"t": "left", "id": peer.id})
        if was_host and room.host:
            await self.broadcast(room, {"t": "host", "id": room.host.id})

    @staticmethod
    async def _fail(writer: asyncio.StreamWriter, error: ProtocolError) -> None:
        try:
            body = json.dumps({"t": "error", "code": error.code, "message": str(error)[:256]}).encode("utf-8")
            writer.write(encode_frame(_OP_TEXT, body))
            writer.write(encode_frame(_OP_CLOSE, struct.pack("!H", 1008)))
            await writer.drain()
        except (ConnectionError, RuntimeError):
            pass

    def close_connections(self) -> None:
        for writer in list(self._writers):
            writer.close()


@dataclass
class RelayHandle:
    """A running relay: the port it listens on, and close()."""

    server: asyncio.Server
    relay: Relay
    port: int

    async def close(self) -> None:
        self.server.close()
        self.relay.close_connections()
        await self.server.wait_closed()


async def start_relay(host: str = "127.0.0.1", port: int = 7777, *, max_players: int = MAX_PEERS_PER_ROOM,
                      allowed_origins: Iterable[str] = ()) -> RelayHandle:
    """Starts a relay; port 0 picks a free port (see the handle's port)."""
    relay = Relay(max_players, allowed_origins)
    server = await asyncio.start_server(relay.handle, host, port, limit=MAX_HANDSHAKE_BYTES)
    bound = server.sockets[0].getsockname()[1]
    return RelayHandle(server, relay, bound)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Auvra multiplayer relay")
    parser.add_argument("--host", default="0.0.0.0", help="address to listen on (default all interfaces)")
    parser.add_argument("--port", type=int, default=7777)
    parser.add_argument("--max-players", type=int, default=MAX_PEERS_PER_ROOM, help=f"players per room, at most {MAX_PEERS_PER_ROOM}")
    parser.add_argument("--allow-origin", action="append", default=[], help="accept only browsers from this origin (repeatable)")
    args = parser.parse_args(argv)

    async def serve() -> None:
        handle = await start_relay(args.host, args.port, max_players=args.max_players, allowed_origins=args.allow_origin)
        print(f"Auvra relay listening on {args.host}:{handle.port}", flush=True)
        try:
            await asyncio.Event().wait()
        finally:
            await handle.close()

    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
