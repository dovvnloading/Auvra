from __future__ import annotations

import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor

from Auvra.desktop.assets import (
    ASSET_ORIGIN,
    AssetTransferRegistry,
    AssetTransportError,
    is_asset_resource_url,
)


class AssetTransferRegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.clock = [100.0]
        self.registry = AssetTransferRegistry(
            Path(self.temp.name),
            session_id="session-asset-test",
            trusted_origin="http://127.0.0.1:3000",
            now=lambda: self.clock[0],
        )

    def tearDown(self) -> None:
        self.registry.close()
        self.temp.cleanup()

    def test_exact_asset_origin_only(self) -> None:
        self.assertTrue(is_asset_resource_url(f"{ASSET_ORIGIN}/v1/get/token"))
        for value in (
            "http://assets.auvra.local/v1/get/token",
            "https://assets.auvra.local.evil/v1/get/token",
            "https://assets.auvra.local/v1/get/token?x=1",
            "file:///tmp/asset",
        ):
            self.assertFalse(is_asset_resource_url(value))

    def test_upload_is_bounded_hashed_single_use_and_claimed_privately(self) -> None:
        payload = b"asset-payload" * 1024
        digest = hashlib.sha256(payload).hexdigest()
        ticket = self.registry.issue_upload(
            mime_type="application/octet-stream",
            max_size=len(payload),
            expected_hash=digest,
        )
        response = self.registry.handle(
            method="PUT",
            url=ticket.url,
            headers={
                "Origin": "http://127.0.0.1:3000",
                "Content-Type": "application/octet-stream",
                "Content-Length": str(len(payload)),
            },
            body=io.BytesIO(payload),
        )
        self.assertEqual(response.status, 204)
        upload = self.registry.claim_upload(ticket.url)
        self.assertEqual(upload.sha256, digest)
        self.assertEqual(upload.size, len(payload))
        self.assertEqual(upload.path.read_bytes(), payload)
        self.assertNotIn(str(upload.path), ticket.protocol_value().values())
        with self.assertRaises(AssetTransportError):
            self.registry.claim_upload(ticket.url)

    def test_preflight_does_not_consume_upload(self) -> None:
        ticket = self.registry.issue_upload(mime_type="image/png", max_size=8)
        response = self.registry.handle(
            method="OPTIONS",
            url=ticket.url,
            headers={
                "Origin": "http://127.0.0.1:3000",
                "Access-Control-Request-Method": "PUT",
            },
        )
        self.assertEqual(response.status, 204)
        self.registry.handle(
            method="PUT",
            url=ticket.url,
            headers={"Origin": "http://127.0.0.1:3000", "Content-Type": "image/png"},
            body=io.BytesIO(b"png"),
        )

    def test_upload_completion_callback_and_stream_download_are_bounded(self) -> None:
        completed = []
        ticket = self.registry.issue_upload(
            mime_type="application/octet-stream",
            max_size=8,
            on_upload=completed.append,
        )
        response = self.registry.handle(
            method="PUT",
            url=ticket.url,
            headers={"Origin": "http://127.0.0.1:3000", "Content-Type": "application/octet-stream"},
            body=io.BytesIO(b"payload"),
        )
        self.assertEqual(completed[0].sha256, response.headers["X-Auvra-Asset-Sha256"])
        self.assertFalse(completed[0].path.exists())
        download = self.registry.issue_download_stream(
            io.BytesIO(b"payload"),
            mime_type="application/octet-stream",
            expected_hash=completed[0].sha256,
            max_size=8,
        )
        served = self.registry.handle(
            method="GET",
            url=download.url,
            headers={"Origin": "http://127.0.0.1:3000"},
        )
        self.assertEqual(served.body.read(), b"payload")
        served.body.close()

        class OversizedReader:
            done = False
            def read(self, _size: int) -> bytes:
                if self.done:
                    return b""
                self.done = True
                return b"x" * (1024 * 1024 + 1)

        with self.assertRaises(AssetTransportError) as raised:
            self.registry.issue_download_stream(
                OversizedReader(),
                mime_type="application/octet-stream",
                expected_hash="0" * 64,
                max_size=2 * 1024 * 1024,
            )
        self.assertEqual(raised.exception.code, "asset_stream_invalid")

    def test_staged_download_is_removed_on_body_close_and_expiry(self) -> None:
        payload = b"staged-download"
        digest = hashlib.sha256(payload).hexdigest()
        ticket = self.registry.issue_download_stream(
            io.BytesIO(payload),
            mime_type="application/octet-stream",
            expected_hash=digest,
            max_size=64,
        )
        staged = list(self.registry.root.glob("download-*"))
        self.assertEqual(len(staged), 1)
        served = self.registry.handle(
            method="GET",
            url=ticket.url,
            headers={"Origin": "http://127.0.0.1:3000"},
        )
        self.assertEqual(served.body.read(), payload)
        self.assertFalse(staged[0].exists())
        served.body.close()

        manual = self.registry.issue_download_stream(
            io.BytesIO(payload),
            mime_type="application/octet-stream",
            expected_hash=digest,
            max_size=64,
        )
        manual_path = list(self.registry.root.glob("download-*"))[0]
        manual_response = self.registry.handle(
            method="GET",
            url=manual.url,
            headers={"Origin": "http://127.0.0.1:3000"},
        )
        self.assertEqual(manual_response.body.read(1), payload[:1])
        self.assertTrue(manual_path.exists())
        manual_response.body.close()
        self.assertFalse(manual_path.exists())

        expiring = self.registry.issue_download_stream(
            io.BytesIO(payload),
            mime_type="application/octet-stream",
            expected_hash=digest,
            max_size=64,
            ttl=1,
        )
        expiring_path = list(self.registry.root.glob("download-*"))[0]
        self.clock[0] += 2
        with self.assertRaises(AssetTransportError) as raised:
            self.registry.handle(
                method="GET",
                url=expiring.url,
                headers={"Origin": "http://127.0.0.1:3000"},
            )
        self.assertEqual(raised.exception.code, "asset_ticket_expired")
        self.assertFalse(expiring_path.exists())

    def test_wrong_origin_mime_size_hash_and_expiry_fail_closed(self) -> None:
        cases = []
        ticket = self.registry.issue_upload(mime_type="image/png", max_size=3)
        cases.append((ticket, {"Origin": "https://evil.test", "Content-Type": "image/png"}, b"png", "asset_origin_denied"))
        ticket = self.registry.issue_upload(mime_type="image/png", max_size=3)
        cases.append((ticket, {"Origin": "http://127.0.0.1:3000", "Content-Type": "text/plain"}, b"png", "asset_mime_denied"))
        ticket = self.registry.issue_upload(mime_type="image/png", max_size=2)
        cases.append((ticket, {"Origin": "http://127.0.0.1:3000", "Content-Type": "image/png"}, b"png", "asset_too_large"))
        ticket = self.registry.issue_upload(mime_type="image/png", max_size=3, expected_hash="0" * 64)
        cases.append((ticket, {"Origin": "http://127.0.0.1:3000", "Content-Type": "image/png"}, b"png", "asset_hash_mismatch"))
        for ticket, headers, payload, code in cases:
            with self.subTest(code=code):
                with self.assertRaises(AssetTransportError) as raised:
                    self.registry.handle(method="PUT", url=ticket.url, headers=headers, body=io.BytesIO(payload))
                self.assertEqual(raised.exception.code, code)
        expired = self.registry.issue_upload(mime_type="image/png", max_size=3, ttl=1)
        self.clock[0] += 2
        with self.assertRaises(AssetTransportError) as raised:
            self.registry.handle(
                method="PUT",
                url=expired.url,
                headers={"Origin": "http://127.0.0.1:3000", "Content-Type": "image/png"},
                body=io.BytesIO(b"png"),
            )
        self.assertEqual(raised.exception.code, "asset_ticket_expired")

    def test_download_rechecks_hash_and_streams_once(self) -> None:
        source = Path(self.temp.name) / "source.bin"
        source.write_bytes(b"download")
        digest = hashlib.sha256(b"download").hexdigest()
        ticket = self.registry.issue_download(
            source,
            mime_type="application/octet-stream",
            expected_hash=digest,
            max_size=32,
        )
        response = self.registry.handle(
            method="GET",
            url=ticket.url,
            headers={"Origin": "http://127.0.0.1:3000"},
        )
        self.assertEqual(response.body.read(), b"download")
        response.body.close()
        with self.assertRaises(AssetTransportError) as raised:
            self.registry.handle(
                method="GET",
                url=ticket.url,
                headers={"Origin": "http://127.0.0.1:3000"},
            )
        self.assertEqual(raised.exception.code, "asset_ticket_consumed")

    def test_concurrent_download_consumes_ticket_atomically(self) -> None:
        source = Path(self.temp.name) / "concurrent.bin"
        source.write_bytes(b"concurrent")
        digest = hashlib.sha256(b"concurrent").hexdigest()
        ticket = self.registry.issue_download(
            source, mime_type="application/octet-stream", expected_hash=digest, max_size=32,
        )
        def fetch() -> str:
            try:
                response = self.registry.handle(
                    method="GET", url=ticket.url,
                    headers={"Origin": "http://127.0.0.1:3000"},
                )
                response.body.close()
                return "ok"
            except AssetTransportError as exc:
                return exc.code
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(lambda _value: fetch(), range(2)))
        self.assertEqual(sorted(outcomes), ["asset_ticket_consumed", "ok"])

    def test_cleanup_removes_only_owned_transfer_directory(self) -> None:
        sibling = Path(self.temp.name) / "keep.txt"
        sibling.write_text("keep", encoding="utf-8")
        root = self.registry.root
        self.registry.close()
        self.assertFalse(root.exists())
        self.assertEqual(sibling.read_text(encoding="utf-8"), "keep")


if __name__ == "__main__":
    unittest.main()
