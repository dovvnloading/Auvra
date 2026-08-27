from __future__ import annotations

import hashlib
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from Auvra.desktop import sdk


def make_archive(*, unsafe: str | None = None) -> tuple[bytes, dict[str, str]]:
    members = {
        "lib/net462/Microsoft.Web.WebView2.Core.dll": b"core",
        "lib/net462/Microsoft.Web.WebView2.WinForms.dll": b"forms",
        "runtimes/win-x64/native/WebView2Loader.dll": b"loader",
        "LICENSE.txt": b"license",
        "NOTICE.txt": b"notice",
    }
    if unsafe:
        members[unsafe] = b"bad"
    stream = BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        for name, content in members.items():
            archive.writestr(name, content)
    raw = stream.getvalue()
    hashes = {Path(name).name: hashlib.sha256(content).hexdigest() for name, content in members.items() if name in sdk._REQUIRED}
    return raw, hashes


class SdkTests(unittest.TestCase):
    def fixture(self, raw: bytes, hashes: dict[str, str]):
        return patch.object(sdk, "SDK_SHA256", hashlib.sha256(raw).hexdigest()), patch.object(sdk, "_FILE_HASHES", hashes)

    def test_offline_acquisition_and_tamper_detection(self):
        raw, hashes = make_archive()
        with tempfile.TemporaryDirectory() as temp, self.fixture(raw, hashes)[0], self.fixture(raw, hashes)[1]:
            first = sdk.acquire_sdk(temp, downloader=lambda url: raw)
            self.assertTrue(first.loader.exists())
            first.loader.write_bytes(b"tampered")
            calls: list[str] = []
            second = sdk.acquire_sdk(temp, downloader=lambda url: calls.append(url) or raw)
            self.assertEqual(calls, [sdk.SDK_URL])
            self.assertEqual(second.loader.read_bytes(), b"loader")

    def test_zip_slip_and_symlink_members_fail_closed(self):
        raw, hashes = make_archive(unsafe="../escape.txt")
        with tempfile.TemporaryDirectory() as temp, self.fixture(raw, hashes)[0], self.fixture(raw, hashes)[1]:
            with self.assertRaises(sdk.SdkError):
                sdk.acquire_sdk(temp, downloader=lambda url: raw)
            self.assertFalse((Path(temp) / "escape.txt").exists())

    def test_bad_digest_is_rejected(self):
        raw, _ = make_archive()
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(sdk.SdkError):
                sdk.acquire_sdk(temp, downloader=lambda url: raw)
