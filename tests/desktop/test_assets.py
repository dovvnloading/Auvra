from __future__ import annotations

import errno
import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor

from Auvra.project.errors import AssetContentError, ReadOnlyError
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

    def test_a_failure_says_what_went_wrong_to_the_page_that_asked_and_no_one_else(self) -> None:
        asked = {"Origin": "http://127.0.0.1:3000"}
        for error, status in (
            (AssetTransportError("asset_too_large", 413), 413),
            (ReadOnlyError("read only"), 423),
            (AssetContentError("not what it says"), 415),
            (OSError(errno.ENOSPC, "disk full"), 507),
            (OSError(errno.EACCES, "denied"), 500),
            (ValueError("anything else"), 500),
        ):
            answer = self.registry.failure_response(asked, error)
            self.assertEqual(answer.status, status)
            self.assertEqual(answer.headers["Access-Control-Allow-Origin"], "http://127.0.0.1:3000")
            stranger = self.registry.failure_response({"Origin": "https://example.com"}, error)
            self.assertEqual(stranger.status, status)
            self.assertNotIn("Access-Control-Allow-Origin", stranger.headers)

    def _send_piece(self, ticket, piece: bytes, first: int, total: int):
        return self.registry.handle(
            method="PUT",
            url=ticket.url,
            headers={
                "Origin": "http://127.0.0.1:3000",
                "Content-Type": "application/octet-stream",
                "Content-Range": f"bytes {first}-{first + len(piece) - 1}/{total}",
            },
            body=io.BytesIO(piece),
        )

    def test_a_file_sent_in_pieces_arrives_whole_and_hashed(self) -> None:
        payload = bytes(range(256)) * 40
        stored = []
        ticket = self.registry.issue_upload(
            mime_type="application/octet-stream",
            max_size=len(payload),
            on_upload=lambda upload: stored.append((upload.path.read_bytes(), upload.sha256)),
        )
        size = 4096
        answers = [
            self._send_piece(ticket, payload[at:at + size], at, len(payload))
            for at in range(0, len(payload), size)
        ]
        self.assertEqual(stored, [(payload, hashlib.sha256(payload).hexdigest())])
        self.assertTrue(all(answer.status == 204 for answer in answers))
        for answer in answers[:-1]:
            self.assertNotIn("X-Auvra-Asset-Sha256", answer.headers)
        self.assertEqual(answers[-1].headers["X-Auvra-Asset-Sha256"], hashlib.sha256(payload).hexdigest())
        self.assertEqual(list(self.registry.root.glob("*.upload")), [])
        with self.assertRaises(AssetTransportError) as raised:
            self._send_piece(ticket, payload[:size], 0, len(payload))
        self.assertEqual(raised.exception.code, "asset_ticket_consumed")

    def test_pieces_out_of_order_are_refused_and_the_right_one_still_goes_in(self) -> None:
        ticket = self.registry.issue_upload(mime_type="application/octet-stream", max_size=6)
        self._send_piece(ticket, b"abc", 0, 6)
        for wrong in (0, 1, 2):
            with self.assertRaises(AssetTransportError) as raised:
                self._send_piece(ticket, b"def", wrong, 6)
            self.assertEqual(raised.exception.code, "asset_piece_out_of_order")
        self._send_piece(ticket, b"def", 3, 6)
        self.assertEqual(self.registry.claim_upload(ticket.url).path.read_bytes(), b"abcdef")

    def test_a_piece_that_lies_ends_the_ticket_and_leaves_nothing_behind(self) -> None:
        for stated, code in (
            ("bytes 0-9/4", "asset_piece_invalid"),
            ("bytes 3-1/4", "asset_piece_invalid"),
            ("bytes=0-1/4", "asset_piece_invalid"),
            ("bytes 0-1/99", "asset_too_large"),
        ):
            ticket = self.registry.issue_upload(mime_type="application/octet-stream", max_size=4)
            with self.subTest(stated=stated), self.assertRaises(AssetTransportError) as raised:
                self.registry.handle(
                    method="PUT",
                    url=ticket.url,
                    headers={"Origin": "http://127.0.0.1:3000", "Content-Type": "application/octet-stream", "Content-Range": stated},
                    body=io.BytesIO(b"ab"),
                )
            self.assertEqual(raised.exception.code, code)
        ticket = self.registry.issue_upload(mime_type="application/octet-stream", max_size=8)
        self._send_piece(ticket, b"ab", 0, 8)
        with self.assertRaises(AssetTransportError) as raised:
            self.registry.handle(
                method="PUT",
                url=ticket.url,
                headers={"Origin": "http://127.0.0.1:3000", "Content-Type": "application/octet-stream", "Content-Range": "bytes 2-3/8"},
                body=io.BytesIO(b"xyz"),
            )
        self.assertEqual(raised.exception.code, "asset_piece_invalid")
        self.assertEqual(list(self.registry.root.glob("*.upload")), [])
        with self.assertRaises(AssetTransportError) as raised:
            self._send_piece(ticket, b"cd", 2, 8)
        self.assertEqual(raised.exception.code, "asset_ticket_consumed")

    def test_each_piece_buys_the_next_one_its_time(self) -> None:
        ticket = self.registry.issue_upload(mime_type="application/octet-stream", max_size=6, ttl=10)
        for at, piece in ((0, b"ab"), (2, b"cd"), (4, b"ef")):
            self.clock[0] += 8
            self._send_piece(ticket, piece, at, 6)
        self.assertEqual(self.registry.claim_upload(ticket.url).path.read_bytes(), b"abcdef")

    def test_an_upload_abandoned_part_way_is_gone_once_its_ticket_runs_out(self) -> None:
        ticket = self.registry.issue_upload(mime_type="application/octet-stream", max_size=6, ttl=10)
        self._send_piece(ticket, b"abc", 0, 6)
        self.assertEqual(len(list(self.registry.root.glob("*.upload"))), 1)
        self.registry.issue_upload(mime_type="application/octet-stream", max_size=6, ttl=10)
        self.assertEqual(len(list(self.registry.root.glob("*.upload"))), 1)
        self.clock[0] += 11
        self.registry.issue_upload(mime_type="application/octet-stream", max_size=6, ttl=10)
        self.assertEqual(list(self.registry.root.glob("*.upload")), [])

    def test_a_download_nobody_fetched_is_gone_once_its_ticket_runs_out(self) -> None:
        self.registry.issue_download_stream(
            io.BytesIO(b"png"),
            mime_type="image/png",
            expected_hash=hashlib.sha256(b"png").hexdigest(),
            max_size=3,
            ttl=10,
        )
        self.assertEqual(len(list(self.registry.root.glob("download-*"))), 1)
        self.clock[0] += 11
        self.registry.issue_upload(mime_type="image/png", max_size=3)
        self.assertEqual(list(self.registry.root.glob("download-*")), [])

    def test_an_upload_waiting_to_be_claimed_outlives_its_ticket(self) -> None:
        ticket = self.registry.issue_upload(mime_type="image/png", max_size=3, ttl=10)
        self.registry.handle(
            method="PUT",
            url=ticket.url,
            headers={"Origin": "http://127.0.0.1:3000", "Content-Type": "image/png"},
            body=io.BytesIO(b"png"),
        )
        self.clock[0] += 11
        self.registry.issue_upload(mime_type="image/png", max_size=3)
        self.assertEqual(self.registry.claim_upload(ticket.url).path.read_bytes(), b"png")

    def test_a_preflight_allows_the_range_a_piece_states(self) -> None:
        ticket = self.registry.issue_upload(mime_type="image/png", max_size=3)
        answer = self.registry.handle(
            method="OPTIONS",
            url=ticket.url,
            headers={"Origin": "http://127.0.0.1:3000", "Access-Control-Request-Method": "PUT"},
        )
        self.assertIn("Content-Range", answer.headers["Access-Control-Allow-Headers"])
        self.assertIn("Range", answer.headers["Access-Control-Allow-Headers"].replace("Content-Range", ""))

    def test_what_a_crashed_session_left_is_removed_and_nothing_else(self) -> None:
        parent = Path(self.temp.name)
        crashed = parent / "asset-transfer-crashed"
        crashed.mkdir()
        (crashed / ".auvra-asset-transfer").write_text("marker\n", encoding="ascii")
        (crashed / "download-left-behind").write_bytes(b"x" * 16)
        unrelated = parent / "asset-transfer-not-ours"
        unrelated.mkdir()
        (unrelated / "keep").write_bytes(b"x")
        other = AssetTransferRegistry(parent, session_id="session-other", trusted_origin="http://127.0.0.1:3000")
        try:
            self.assertFalse(crashed.exists())
            self.assertTrue((unrelated / "keep").exists())
            self.assertTrue(self.registry.root.exists(), "a session still running keeps its folder")
            self.assertTrue((self.registry.root / ".auvra-asset-transfer").exists())
            third = AssetTransferRegistry(parent, session_id="session-third", trusted_origin="http://127.0.0.1:3000")
            self.assertTrue(other.root.exists())
            third.close()
        finally:
            other.close()

    def _ask_for_piece(self, ticket, first: int, last: int):
        return self.registry.handle(
            method="GET",
            url=ticket.url,
            headers={"Origin": "http://127.0.0.1:3000", "Range": f"bytes={first}-{last}"},
        )

    def _download_ticket(self, payload: bytes, **options):
        return self.registry.issue_download_stream(
            io.BytesIO(payload),
            mime_type="model/fbx",
            expected_hash=hashlib.sha256(payload).hexdigest(),
            max_size=len(payload),
            **options,
        )

    def test_a_stored_file_can_be_read_a_piece_at_a_time_and_is_let_go_with_the_last(self) -> None:
        payload = bytes(range(256)) * 40
        ticket = self._download_ticket(payload)
        self.assertEqual(len(list(self.registry.root.glob("download-*"))), 1)
        received = b""
        size = 4096
        for first in range(0, len(payload), size):
            last = min(first + size, len(payload)) - 1
            answer = self._ask_for_piece(ticket, first, last)
            self.assertEqual(answer.status, 206)
            self.assertEqual(answer.headers["Content-Range"], f"bytes {first}-{last}/{len(payload)}")
            self.assertEqual(answer.headers["Content-Length"], str(last - first + 1))
            self.assertEqual(answer.headers["Access-Control-Allow-Origin"], "http://127.0.0.1:3000")
            with answer.body as body:
                self.assertEqual(body.span, (first, last - first + 1))
                received += body.read()
        self.assertEqual(received, payload)
        self.assertEqual(list(self.registry.root.glob("download-*")), [])
        with self.assertRaises(AssetTransportError) as raised:
            self._ask_for_piece(ticket, 0, 1)
        self.assertEqual(raised.exception.code, "asset_ticket_consumed")

    def test_a_piece_outside_the_file_is_refused_and_the_file_can_still_be_read(self) -> None:
        ticket = self._download_ticket(b"abcdef")
        for first, last, status in ((0, 6, 416), (4, 2, 416)):
            with self.assertRaises(AssetTransportError) as raised:
                self._ask_for_piece(ticket, first, last)
            self.assertEqual(raised.exception.status, status)
        with self.assertRaises(AssetTransportError) as raised:
            self.registry.handle(method="GET", url=ticket.url, headers={"Origin": "http://127.0.0.1:3000", "Range": "bytes=0-"})
        self.assertEqual(raised.exception.status, 400)
        with self._ask_for_piece(ticket, 0, 5).body as body:
            self.assertEqual(body.read(), b"abcdef")

    def test_a_file_changed_on_disk_is_not_served_in_pieces(self) -> None:
        ticket = self._download_ticket(b"abcdef")
        staged = next(self.registry.root.glob("download-*"))
        staged.write_bytes(b"xxxxxx")
        with self.assertRaises(AssetTransportError) as raised:
            self._ask_for_piece(ticket, 0, 2)
        self.assertEqual(raised.exception.code, "asset_hash_mismatch")
        self.assertFalse(staged.exists())

    def test_a_download_abandoned_part_way_is_gone_once_its_ticket_runs_out(self) -> None:
        ticket = self._download_ticket(b"abcdef", ttl=10)
        with self._ask_for_piece(ticket, 0, 2).body:
            pass
        self.clock[0] += 8
        with self._ask_for_piece(ticket, 3, 4).body:
            pass
        self.clock[0] += 8
        self.registry.issue_upload(mime_type="image/png", max_size=3)
        self.assertEqual(len(list(self.registry.root.glob("download-*"))), 1, "each piece buys the next one its time")
        self.clock[0] += 3
        self.registry.issue_upload(mime_type="image/png", max_size=3)
        self.assertEqual(list(self.registry.root.glob("download-*")), [])

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
