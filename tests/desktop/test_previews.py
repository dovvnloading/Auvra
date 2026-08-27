from __future__ import annotations

import hashlib
import io
from pathlib import Path
import tempfile
import unittest

from Auvra.desktop.previews import PreviewError, PreviewStore


def _png(width: int = 2, height: int = 3) -> bytes:
    return (
        b"\x89PNG\r\n\x1a\n"
        + b"\x00\x00\x00\rIHDR"
        + width.to_bytes(4, "big")
        + height.to_bytes(4, "big")
        + b"\x08\x06\x00\x00\x00"
    )


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

    def test_jpeg_and_webp_dimensions_are_parsed_without_image_dependency(self) -> None:
        jpeg = b"\xff\xd8\xff\xc0\x00\x07\x08\x00\x02\x00\x03"
        record = self.store.ingest("job-0123456789abcdef", io.BytesIO(jpeg), declared_mime="image/jpeg")
        self.assertEqual((record.width, record.height), (3, 2))

        webp = (
            b"RIFF" + (22).to_bytes(4, "little") + b"WEBPVP8X"
            + (10).to_bytes(4, "little") + b"\x00\x00\x00\x00"
            + (4).to_bytes(3, "little") + (6).to_bytes(3, "little")
        )
        record = self.store.ingest("job-fedcba9876543210", io.BytesIO(webp), declared_mime="image/webp")
        self.assertEqual((record.width, record.height), (5, 7))

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
