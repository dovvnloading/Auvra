from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import Auvra.desktop.contracts as contracts
from Auvra.desktop.controller import _new_profile
from Auvra.desktop.contracts import FrameConfig, FrameConfigurationError, FrameMode
from Auvra.desktop.policy import FramePolicy


class PolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dev = FramePolicy(FrameMode.DEVELOPMENT, "http://127.0.0.1:3000")
        self.pkg = FramePolicy(FrameMode.PACKAGED, "https://app.auvra.local")

    def test_development_exact_origin_and_hmr(self):
        self.assertTrue(self.dev.navigation("http://127.0.0.1:3000/").allowed)
        self.assertTrue(self.dev.resource("ws://127.0.0.1:3000/@vite/client").allowed)
        self.assertTrue(self.dev.resource("blob:http://127.0.0.1:3000/4e4a").allowed)
        self.assertTrue(self.dev.resource("data:image/png;base64,AA==").allowed)
        self.assertFalse(self.dev.navigation("ws://127.0.0.1:3000/").allowed)
        self.assertFalse(self.dev.resource("wss://127.0.0.1:3000/x").allowed)

    def test_bypass_and_lookalike_hosts_are_denied(self):
        for value in (
            "file:///C:/secret",
            "file://server/share/secret",
            "https://127.0.0.1:3000/",
            "http://127.0.0.1:3000.evil/",
            "http://127.0.0.1@evil.test/",
            "http://127.0.0.1:bad/",
            "http://127.0.0.1:3000\\evil",
            "//127.0.0.1:3000/",
            "javascript:alert(1)",
        ):
            self.assertFalse(self.dev.resource(value).allowed, value)

    def test_packaged_origin_and_path(self):
        self.assertTrue(self.pkg.navigation("https://app.auvra.local/index.html").allowed)
        self.assertTrue(self.pkg.resource("blob:https://app.auvra.local/4e4a").allowed)
        self.assertTrue(self.pkg.resource("data:text/plain,preview").allowed)
        self.assertFalse(self.pkg.resource("https://app.auvra.local/../secret").allowed)
        self.assertFalse(self.pkg.resource("https://app.auvra.local/%2fsecret").allowed)
        self.assertFalse(self.pkg.resource("https://app.auvra.local:444/").allowed)
        self.assertFalse(self.pkg.resource("https://app.auvra.local.evil/").allowed)
        self.assertFalse(self.pkg.resource("blob:https://evil.test/4e4a").allowed)
        self.assertFalse(self.pkg.resource("blob:file:///C:/secret").allowed)
        self.assertFalse(self.pkg.navigation("data:text/html,evil").allowed)

    def test_message_requires_exact_source(self):
        self.assertTrue(self.pkg.allow_message("https://app.auvra.local/index.html"))
        self.assertFalse(self.pkg.allow_message("https://app.auvra.local.evil/index.html"))
        self.assertFalse(self.pkg.allow_message("https://app.auvra.local/index.html", "https://evil.test/"))

    def test_packaged_root_is_existing_and_has_no_link_component(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "assets"
            root.mkdir()
            (root / "index.html").write_text("<!doctype html>")
            with patch("Auvra.desktop.contracts._REPO_FRONTEND_DIST", root):
                config = FrameConfig(FrameMode.PACKAGED, packaged_root=root)
            self.assertEqual(config.packaged_root, root.resolve())
            link = Path(temp) / "link"
            try:
                link.symlink_to(root, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("symlinks unavailable")
            with patch("Auvra.desktop.contracts._REPO_FRONTEND_DIST", link):
                with self.assertRaises(FrameConfigurationError):
                    FrameConfig(FrameMode.PACKAGED, packaged_root=link)

    def test_arbitrary_directory_cannot_be_mapped_as_packaged_content(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "dist"
            root.mkdir()
            (root / "index.html").write_text("<!doctype html>")
            (root / ".auvra-packaged-root").write_bytes(b"AUVRA_PACKAGED_ROOT_V1\n")
            with self.assertRaises(FrameConfigurationError):
                FrameConfig(FrameMode.PACKAGED, packaged_root=root)

    def test_profile_must_have_launcher_owned_per_launch_name(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(contracts, "_CONTROLLED_TEST_PROFILE_PARENTS", {Path(temp)}):
                with self.assertRaises(FrameConfigurationError):
                    FrameConfig(FrameMode.DEVELOPMENT,
                                development_origin="http://127.0.0.1:3000",
                                user_data_folder=Path(temp) / "shared-profile")
                lease = _new_profile(Path(temp))
                config = FrameConfig(FrameMode.DEVELOPMENT,
                                     development_origin="http://127.0.0.1:3000",
                                     user_data_folder=lease.path)
                self.assertEqual(config.user_data_folder, lease.path)
                from Auvra.desktop.controller import _remove_profile
                _remove_profile(lease)

    def test_profile_marker_without_lease_cannot_authorize_cleanup(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(contracts, "_CONTROLLED_TEST_PROFILE_PARENTS", {Path(temp)}):
            forged = Path(temp) / "webview2-forged"
            forged.mkdir()
            (forged / contracts._PROFILE_LEASE_MARKER).write_text("A" * 43 + "\n", encoding="ascii")
            from Auvra.desktop.controller import _remove_profile
            _remove_profile(type("ForgedLease", (), {"path": forged, "token": "A" * 43})())
            self.assertTrue(forged.exists())

    def test_profile_lease_mismatch_and_linked_marker_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(contracts, "_CONTROLLED_TEST_PROFILE_PARENTS", {Path(temp)}):
            lease = _new_profile(Path(temp))
            marker = lease.path / contracts._PROFILE_LEASE_MARKER
            marker.write_text("wrong-token\n", encoding="ascii")
            from Auvra.desktop.controller import _remove_profile
            _remove_profile(lease)
            self.assertTrue(lease.path.exists())
            marker.unlink()
            target = Path(temp) / "target-marker"
            target.write_text(lease.token + "\n", encoding="ascii")
            try:
                marker.symlink_to(target)
            except (OSError, NotImplementedError):
                _remove_profile(lease)
                self.assertTrue(lease.path.exists())
            else:
                _remove_profile(lease)
                self.assertTrue(lease.path.exists())
            # Restore the real marker and prove cleanup remains idempotent.
            marker.unlink(missing_ok=True)
            marker.write_text(lease.token + "\n", encoding="ascii")
            _remove_profile(lease)
            _remove_profile(lease)
            self.assertFalse(lease.path.exists())

    def test_linked_profile_path_cannot_redirect_cleanup(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(contracts, "_CONTROLLED_TEST_PROFILE_PARENTS", {Path(temp)}):
            lease = _new_profile(Path(temp))
            target = lease.path
            alias = Path(temp) / "webview2-alias"
            try:
                alias.symlink_to(target, target_is_directory=True)
            except (OSError, NotImplementedError):
                _remove_profile(lease)
                self.skipTest("directory symlinks unavailable")
            original = lease.path
            lease.path = alias
            from Auvra.desktop.controller import _remove_profile
            _remove_profile(lease)
            lease.path = original
            self.assertTrue(target.exists())
            _remove_profile(lease)
            self.assertFalse(target.exists())
