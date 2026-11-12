from __future__ import annotations

import base64
import hashlib
import io
from pathlib import Path
import tempfile
import unittest
import zlib

from Auvra.desktop.previews import PreviewError, PreviewStore
from tests.desktop.preview_fixtures import png as _png, png_chunk as _png_chunk



# Real tiny encoded fixtures, not dimension-only headers.
_JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eH4eHh7/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5/ooor0jzz//Z"
)
_WEBP = base64.b64decode("UklGRjgAAABXRUJQVlA4ICwAAADQAQCdASoDAAIAAoBCJaACdLoB+AADsAD+3FH/8guWF1yNf+WfP4bOjAAAAA==")


class PreviewStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.parent = Path(self.temp.name) / "preview parent"
        self.store = PreviewStore(self.parent, max_size=1024)

    def tearDown(self) -> None:
        self.store.close()
        self.temp.cleanup()

    def test_streams_validates_and_resolves_content_addressed_preview(self) -> None:
        payload = _png()
        digest = hashlib.sha256(payload).hexdigest()
        record = self.store.ingest(
            "job-0123456789abcdef",
            io.BytesIO(payload),
            declared_mime="image/png",
            expected_hash=digest,
            provenance={"providerId": "fal", "promptSha256": "a" * 64},
        )
        self.assertEqual((record.asset_id, record.width, record.height), (digest, 2, 3))
        with self.store.open(record.asset_id) as stream:
            self.assertEqual(stream.read(), payload)
        self.assertNotIn(str(self.parent), repr(record))

    def test_mime_hash_oversize_and_sensitive_provenance_fail_closed(self) -> None:
        with self.assertRaises(PreviewError):
            self.store.ingest(
                "job-0123456789abcdef", io.BytesIO(_png()),
                declared_mime="image/jpeg",
            )
        with self.assertRaises(PreviewError):
            self.store.ingest(
                "job-0123456789abcdef", io.BytesIO(_png()),
                expected_hash="0" * 64,
            )
        with self.assertRaises(PreviewError):
            self.store.ingest(
                "job-0123456789abcdef", io.BytesIO(_png()),
                provenance={"prompt": "do not retain"},
            )
        with self.assertRaises(PreviewError):
            self.store.ingest(
                "job-0123456789abcdef", io.BytesIO(_png()),
                provenance={"Prompt": "case variants are not accepted"},
            )
        with self.assertRaises(PreviewError):
            self.store.ingest(
                "job-0123456789abcdef", io.BytesIO(_png()),
                provenance={"jobId": "job-fedcba9876543210"},
            )
        with self.assertRaises(PreviewError):
            self.store.ingest(
                "job-0123456789abcdef", io.BytesIO(_png()),
                provenance={"inputAssetIds": ["not-a-content-hash"]},
            )

        class Oversized:
            def read(self, _size):
                return b"x" * (1024 * 1024 + 1)

        with self.assertRaises(PreviewError):
            self.store.ingest("job-0123456789abcdef", Oversized())

    def test_discard_is_job_scoped_and_shared_content_is_reference_safe(self) -> None:
        first = self.store.ingest("job-0123456789abcdef", io.BytesIO(_png()))
        second = self.store.ingest("job-fedcba9876543210", io.BytesIO(_png()))
        self.assertEqual(first.asset_id, second.asset_id)
        self.store.discard(first.job_id, first.asset_id)
        with self.store.open(second.asset_id) as stream:
            self.assertTrue(stream.read(8).startswith(b"\x89PNG"))
        self.store.discard(second.job_id, second.asset_id)
        with self.assertRaises(PreviewError):
            self.store.open(second.asset_id)

    def test_project_scope_is_required_for_cross_project_lookup(self) -> None:
        record = self.store.ingest(
            "job-0123456789abcdef", io.BytesIO(_png()), project_id="project-a",
        )
        with self.assertRaises(PreviewError):
            self.store.find(record.asset_id, project_id="project-b")
        self.assertEqual(self.store.find(record.asset_id, project_id="project-a"), record)

    def test_jpeg_and_webp_require_complete_containers(self) -> None:
        jpeg = self.store.ingest("job-0123456789abcdef", io.BytesIO(_JPEG), declared_mime="image/jpeg")
        self.assertEqual((jpeg.width, jpeg.height), (3, 2))
        webp = self.store.ingest("job-fedcba9876543210", io.BytesIO(_WEBP), declared_mime="image/webp")
        self.assertEqual((webp.width, webp.height), (3, 2))
        for mime, payload in (("image/jpeg", _JPEG), ("image/webp", _WEBP)):
            with self.subTest(mime=mime), self.assertRaises(PreviewError):
                self.store.ingest("job-1111111111111111", io.BytesIO(payload[:-1]), declared_mime=mime)

    def test_full_decoder_rejects_corrupt_jpeg_tables_and_webp_payload(self) -> None:
        # The container scanner sees a SOF, SOS, entropy bytes and EOI even when
        # the Huffman table is unusable. Only actual JPEG decoding catches it.
        bad_jpeg = bytearray(_JPEG)
        table = bad_jpeg.index(b"\xff\xc4")
        bad_jpeg[table + 4] = 0xff
        # Preserve RIFF size, VP8 tag and canvas fields, but corrupt VP8 entropy.
        bad_webp = bytearray(_WEBP)
        bad_webp[30] = 0xff
        for mime, payload in (("image/jpeg", bad_jpeg), ("image/webp", bad_webp)):
            with self.subTest(mime=mime), self.assertRaises(PreviewError):
                self.store.ingest("job-1111111111111111", io.BytesIO(payload), declared_mime=mime)
        self.assertEqual(self.store._records, {})
        self.assertEqual(list(self.store._root.glob("incoming-*")), [])

    def test_jpeg_and_webp_large_canvas_rejected_before_decode(self) -> None:
        huge_jpeg = bytearray(_JPEG)
        frame = huge_jpeg.index(b"\xff\xc0")
        huge_jpeg[frame + 5:frame + 9] = (5000).to_bytes(2, "big") * 2
        huge_webp = bytearray(_WEBP)
        huge_webp[26:30] = (5000).to_bytes(2, "little") * 2
        for mime, payload in (("image/jpeg", huge_jpeg), ("image/webp", huge_webp)):
            with self.subTest(mime=mime), self.assertRaises(PreviewError):
                self.store.ingest("job-1111111111111111", io.BytesIO(payload), declared_mime=mime)
        self.assertEqual(self.store._records, {})

    def test_truncated_crc_invalid_and_oversized_pngs_do_not_publish(self) -> None:
        valid = _png()
        # Regression: the old 24-byte IHDR prefix alone was accepted as an image.
        broken_crc = bytearray(valid)
        broken_crc[-5] ^= 1
        header = (65536).to_bytes(4, "big") * 2 + b"\x08\x06\x00\x00\x00"
        huge_canvas = valid[:8] + _png_chunk(b"IHDR", header) + valid[33:]
        enormous_expansion = (
            valid[:33] + _png_chunk(b"IDAT", zlib.compress(b"\0" * 100_000))
            + _png_chunk(b"IEND", b"")
        )
        no_pixels = valid[:33] + _png_chunk(b"IEND", b"")
        for malformed in (valid[:24], valid[:-12], bytes(broken_crc), huge_canvas, enormous_expansion, no_pixels):
            with self.subTest(size=len(malformed)), self.assertRaises(PreviewError):
                self.store.ingest("job-1111111111111111", io.BytesIO(malformed))
        self.assertEqual(self.store._records, {})
        self.assertEqual(list(self.store._root.glob("incoming-*")), [])


    def test_open_returns_the_verified_handle_and_rejects_link_replacement(self) -> None:
        record = self.store.ingest("job-0123456789abcdef", io.BytesIO(_png()))
        stream = self.store.open(record.asset_id)
        try:
            self.assertEqual(stream.tell(), 0)
            self.assertEqual(stream.read(), _png())
        finally:
            stream.close()

        preview_path = self.store._path(record.asset_id)
        replacement = self.parent / "replacement.preview"
        replacement.write_bytes(_png())
        preview_path.unlink()
        try:
            preview_path.symlink_to(replacement)
        except (OSError, NotImplementedError):
            self.skipTest("symlink creation is unavailable")
        with self.assertRaises(PreviewError):
            self.store.open(record.asset_id)


if __name__ == "__main__":
    unittest.main()
