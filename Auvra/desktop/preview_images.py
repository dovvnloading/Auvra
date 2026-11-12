"""Validate bounded generated images before exposing them as previews.

This module checks complete image containers, not just their dimension headers.
PNG compressed scanlines are inflated with an output budget; JPEG/WebP image
payloads must have complete enclosing structures and be fully decoded under a pixel budget.
"""

from __future__ import annotations

import io
from pathlib import Path
import struct
import zlib

from PIL import Image

# 16 megapixels is a 64-MiB RGBA8 surface, before decoder overhead.
MAX_PREVIEW_PIXELS = 16_777_216
_READ = 64 * 1024
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_PNG_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


class InvalidPreviewImage(ValueError):
    """The image is incomplete, structurally invalid, or too large to decode."""


def dimensions(path: Path, mime: str) -> tuple[int, int]:
    # First check the complete container and enforce bounds without allocating pixels.
    with path.open("rb") as stream:
        if mime == "image/png":
            parsed = _png(stream)
        elif mime == "image/jpeg":
            parsed = _jpeg(stream)
        elif mime == "image/webp":
            parsed = _webp(stream)
        else:
            raise InvalidPreviewImage("generated image type is unsupported")
    # Container validation alone cannot detect corrupt JPEG/WebP entropy payloads,
    # missing JPEG Huffman tables, or invalid PNG palette data.
    _decode_pixels(path, mime, parsed)
    return parsed


def _decode_pixels(path: Path, mime: str, expected_size: tuple[int, int]) -> None:
    """Decode one bounded frame using a restricted, maintained image codec."""
    expected_format = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}[mime]
    try:
        # Restrict plugin dispatch to the claimed image type; do not allow Pillow
        # to sniff unrelated formats such as EPS, TIFF or multi-page documents.
        with Image.open(path, formats=[expected_format]) as image:
            if image.format != expected_format or _bounds(*image.size) != expected_size:
                raise InvalidPreviewImage("generated image dimensions disagree")
            if getattr(image, "n_frames", 1) != 1:
                raise InvalidPreviewImage("generated preview must be a single frame")
            image.load()
    except (OSError, ValueError, SyntaxError, OverflowError, struct.error) as exc:
        raise InvalidPreviewImage("generated image could not be fully decoded") from exc


def _bounds(width: int, height: int) -> tuple[int, int]:
    if not 1 <= width <= 65536 or not 1 <= height <= 65536 or width * height > MAX_PREVIEW_PIXELS:
        raise InvalidPreviewImage("generated image exceeds the pixel budget")
    return width, height


def _exact(stream, size: int) -> bytes:
    data = stream.read(size)
    if len(data) != size:
        raise InvalidPreviewImage("generated image is truncated")
    return data


def _png_rows(width: int, height: int, bits: int, channels: int, interlace: int):
    passes = ((0, 0, 1, 1),) if not interlace else (
        (0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4),
        (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2),
    )
    for x, y, dx, dy in passes:
        pw = max(0, (width - x + dx - 1) // dx)
        ph = max(0, (height - y + dy - 1) // dy)
        if pw:
            row_bytes = (pw * bits * channels + 7) // 8
            for _ in range(ph):
                yield row_bytes


def _png(stream) -> tuple[int, int]:
    if _exact(stream, 8) != _PNG_SIGNATURE:
        raise InvalidPreviewImage("generated PNG signature is invalid")
    seen_header = seen_data = ended_data = seen_end = False
    width = height = 0
    rows = iter(())
    row_left = 0
    inflater = zlib.decompressobj()
    total = 0
    expected = 0

    def consume(output: bytes) -> None:
        nonlocal total, row_left
        total += len(output)
        if total > expected:
            raise InvalidPreviewImage("generated PNG expands beyond its pixel budget")
        pos = 0
        while pos < len(output):
            if not row_left:
                try:
                    row_left = next(rows)
                except StopIteration as exc:
                    raise InvalidPreviewImage("generated PNG contains extra scanlines") from exc
                if output[pos] > 4:
                    raise InvalidPreviewImage("generated PNG has an invalid row filter")
                pos += 1
            step = min(row_left, len(output) - pos)
            row_left -= step
            pos += step

    while not seen_end:
        length = int.from_bytes(_exact(stream, 4), "big")
        kind = _exact(stream, 4)
        if not all(65 <= byte <= 90 or 97 <= byte <= 122 for byte in kind):
            raise InvalidPreviewImage("generated PNG chunk type is invalid")
        if not seen_header and (kind != b"IHDR" or length != 13):
            raise InvalidPreviewImage("generated PNG has no valid IHDR")
        if kind == b"IHDR" and seen_header:
            raise InvalidPreviewImage("generated PNG has duplicate IHDR")
        if kind == b"IDAT":
            if ended_data or not seen_header:
                raise InvalidPreviewImage("generated PNG IDAT chunks are out of order")
            seen_data = True
        elif seen_data:
            ended_data = True
        if kind == b"IEND" and (length != 0 or not seen_data):
            raise InvalidPreviewImage("generated PNG has invalid IEND")
        if kind[0] & 0x20 == 0 and kind not in {b"IHDR", b"PLTE", b"IDAT", b"IEND"}:
            raise InvalidPreviewImage("generated PNG has an unknown critical chunk")
        if kind == b"PLTE" and (seen_data or not 3 <= length <= 768 or length % 3):
            raise InvalidPreviewImage("generated PNG palette is invalid")
        crc = zlib.crc32(kind)
        remaining = length
        header = bytearray()
        while remaining:
            chunk = _exact(stream, min(_READ, remaining))
            crc = zlib.crc32(chunk, crc)
            remaining -= len(chunk)
            if kind == b"IHDR":
                header.extend(chunk)
            elif kind == b"IDAT":
                pending = chunk
                while pending:
                    # Do not allow one compressed chunk to materialize an unbounded output.
                    output = inflater.decompress(pending, min(_READ, expected - total + 1))
                    consume(output)
                    pending = inflater.unconsumed_tail
                    if inflater.unused_data or (inflater.eof and pending):
                        raise InvalidPreviewImage("generated PNG contains trailing compressed data")
                    if not output and not pending:
                        break
        if crc != int.from_bytes(_exact(stream, 4), "big"):
            raise InvalidPreviewImage("generated PNG chunk CRC does not match")
        if kind == b"IHDR":
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", header)
            _bounds(width, height)
            valid_depth = {0: {1, 2, 4, 8, 16}, 2: {8, 16}, 3: {1, 2, 4, 8}, 4: {8, 16}, 6: {8, 16}}
            if depth not in valid_depth.get(color, ()) or compression or filtering or interlace not in (0, 1):
                raise InvalidPreviewImage("generated PNG IHDR settings are invalid")
            rows = iter(_png_rows(width, height, depth, _PNG_CHANNELS[color], interlace))
            # Count the expected decompression size without retaining row buffers.
            expected = sum(1 + size for size in _png_rows(width, height, depth, _PNG_CHANNELS[color], interlace))
            seen_header = True
        elif kind == b"IEND":
            seen_end = True
    if stream.read(1) or not inflater.eof or inflater.unused_data or total != expected or row_left or next(rows, None) is not None:
        raise InvalidPreviewImage("generated PNG has incomplete or extra image data")
    return width, height


def _jpeg(stream) -> tuple[int, int]:
    if _exact(stream, 2) != b"\xff\xd8":
        raise InvalidPreviewImage("generated JPEG signature is invalid")
    frame = None
    saw_scan = False
    in_scan = False
    scan_bytes = 0
    while True:
        if in_scan:
            # Skip entropy bytes in buffered blocks, not one read() per byte.
            buffered = stream.peek(_READ)
            if not buffered:
                raise InvalidPreviewImage("generated JPEG is missing EOI")
            offset = buffered.find(b"\xff")
            if offset < 0:
                scan_bytes += len(buffered)
                stream.read(len(buffered))
                continue
            if offset:
                scan_bytes += offset
                stream.read(offset)
        marker_start = stream.read(1)
        if not marker_start:
            raise InvalidPreviewImage("generated JPEG is missing EOI")
        if marker_start != b"\xff":
            raise InvalidPreviewImage("generated JPEG marker is invalid")
        marker = _exact(stream, 1)[0]
        while marker == 0xFF:
            marker = _exact(stream, 1)[0]
        if marker == 0x00 and in_scan:
            scan_bytes += 1
            continue
        if 0xD0 <= marker <= 0xD7 and in_scan:
            continue
        in_scan = False
        if marker == 0xD9:
            if frame is None or not saw_scan or not scan_bytes or stream.read(1):
                raise InvalidPreviewImage("generated JPEG is missing image data or has trailing bytes")
            return frame
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            raise InvalidPreviewImage("generated JPEG marker is out of order")
        length = int.from_bytes(_exact(stream, 2), "big")
        if length < 2:
            raise InvalidPreviewImage("generated JPEG segment size is invalid")
        payload = _exact(stream, length - 2)
        if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
            if len(payload) < 6 or frame is not None:
                raise InvalidPreviewImage("generated JPEG frame is invalid")
            height, width = int.from_bytes(payload[1:3], "big"), int.from_bytes(payload[3:5], "big")
            frame = _bounds(width, height)
        if marker == 0xDA:
            if frame is None or len(payload) < 4:
                raise InvalidPreviewImage("generated JPEG scan is invalid")
            saw_scan = True
            in_scan = True


def _webp(stream) -> tuple[int, int]:
    header = _exact(stream, 12)
    if header[:4] != b"RIFF" or header[8:] != b"WEBP":
        raise InvalidPreviewImage("generated WebP signature is invalid")
    declared = int.from_bytes(header[4:8], "little")
    if declared < 18 or declared & 1 or declared + 8 != stream.seek(0, io.SEEK_END):
        raise InvalidPreviewImage("generated WebP container size is invalid")
    stream.seek(12)
    first = True
    image_chunks = 0
    frame = None
    while stream.tell() < declared + 8:
        kind = _exact(stream, 4)
        length = int.from_bytes(_exact(stream, 4), "little")
        if length > declared + 8 - stream.tell() or length + (length & 1) > declared + 8 - stream.tell():
            raise InvalidPreviewImage("generated WebP chunk is truncated")
        payload = _exact(stream, min(length, 30))
        stream.seek(length - len(payload) + (length & 1), io.SEEK_CUR)
        if first and kind not in {b"VP8 ", b"VP8L", b"VP8X"}:
            raise InvalidPreviewImage("generated WebP has no image frame")
        first = False
        if kind == b"VP8X":
            if length != 10 or frame is not None:
                raise InvalidPreviewImage("generated WebP extended header is invalid")
            frame = _bounds(1 + int.from_bytes(payload[4:7], "little"), 1 + int.from_bytes(payload[7:10], "little"))
        elif kind == b"VP8 ":
            if length < 16 or payload[3:6] != b"\x9d\x01\x2a":
                raise InvalidPreviewImage("generated WebP lossy frame is invalid")
            actual = _bounds(int.from_bytes(payload[6:8], "little") & 0x3FFF,
                             int.from_bytes(payload[8:10], "little") & 0x3FFF)
            if frame is not None and frame != actual:
                raise InvalidPreviewImage("generated WebP frame dimensions disagree")
            frame = actual
            image_chunks += 1
        elif kind == b"VP8L":
            if length < 10 or payload[0] != 0x2F:
                raise InvalidPreviewImage("generated WebP lossless frame is invalid")
            bits = int.from_bytes(payload[1:5], "little")
            actual = _bounds(1 + (bits & 0x3FFF), 1 + ((bits >> 14) & 0x3FFF))
            if frame is not None and frame != actual:
                raise InvalidPreviewImage("generated WebP frame dimensions disagree")
            frame = actual
            image_chunks += 1
    if stream.tell() != declared + 8 or frame is None or image_chunks != 1:
        raise InvalidPreviewImage("generated WebP has no complete image frame")
    return frame
