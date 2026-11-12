"""Real, tiny PNG fixtures for preview ingestion tests."""

import zlib


def png_chunk(kind: bytes, data: bytes) -> bytes:
    return len(data).to_bytes(4, "big") + kind + data + zlib.crc32(kind + data).to_bytes(4, "big")


def png(width: int = 2, height: int = 3) -> bytes:
    header = width.to_bytes(4, "big") + height.to_bytes(4, "big") + b"\x08\x06\x00\x00\x00"
    rows = b"".join(b"\x00" + b"\x00\x00\x00\xff" * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", header)
        + png_chunk(b"IDAT", zlib.compress(rows)) + png_chunk(b"IEND", b"")
    )
