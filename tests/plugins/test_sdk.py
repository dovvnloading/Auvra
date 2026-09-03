from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path
import struct
import sys
import tempfile
import threading
import unittest
from unittest import mock
import zipfile

from Auvra.plugins.install import InstallError, PluginInstaller
from Auvra.plugins.package import PackageError, PluginPackage, attach_signature, build_unsigned_package, signature_body
from Auvra.plugins.protocol import ProviderProtocolError, encode, read_frame
from Auvra.plugins.security import CngSignatureVerifier, PersistentSecurityState, PermissionGrantStore, RevocationStore, SecurityError, TrustStore
from Auvra.plugins.worker import IsolationUnavailable, PluginLoader, PluginWorker, ProviderBroker, WindowsAppContainerPolicy


class PluginSdkTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="auvra-plugin-fixture-")
        self.root = Path(self.temp.name)
        self.entry = self.root / "payload" / "provider.exe"
        self.entry.parent.mkdir()
        self.entry.write_bytes(b"deterministic-provider-fixture")
        key = b"\x01" * 64
        self.key_id = hashlib.sha256(key).hexdigest()
        self.manifest = {
            "schemaVersion": 1,
            "pluginId": "fixture.provider",
            "publisherKeyId": self.key_id,
            "pluginVersion": "1.0.0",
            "entrypoint": {"path": "payload/provider.exe", "sha256": hashlib.sha256(self.entry.read_bytes()).hexdigest()},
            "abi": "auvra.provider/1",
            "capabilities": ["text"],
            "models": ["fixture-model"],
            "permissions": {"networkProxy": ["https://api.example.test"], "credentialUse": True},
            "resources": {"memoryMiB": 64, "cpuMsPerRequest": 1000, "wallMsPerRequest": 2000, "maxArtifactBytes": 1024},
        }

    def tearDown(self) -> None:
        self.temp.cleanup()

    def build(self) -> Path:
        first = build_unsigned_package(self.root, self.root / "one.auvraplugin", self.manifest)
        second = build_unsigned_package(self.root, self.root / "two.auvraplugin", self.manifest)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        return first

    def signed(self, destination: Path | None = None) -> tuple[Path, bytes]:
        unsigned = self.build()
        package = PluginPackage.open(unsigned, allow_unsigned=True)
        body = signature_body(package.manifest, package.files)
        signature = hashlib.sha256(body).digest() + hashlib.sha256(b"test:" + body).digest()
        signed = attach_signature(unsigned, destination or (self.root / "signed.auvraplugin"),
                                  key_id=self.key_id, signature=signature)
        return signed, signature

    def test_deterministic_unsigned_fixture_and_strict_open(self) -> None:
        package = PluginPackage.open(self.build(), allow_unsigned=True)
        self.assertEqual(package.manifest["pluginId"], "fixture.provider")
        self.assertFalse(package.signed)
        with self.assertRaises(PackageError):
            PluginPackage.open(package.path)

    def test_tamper_and_unsafe_archive_fail_before_use(self) -> None:
        package = self.build()
        tampered = self.root / "tampered.auvraplugin"
        with zipfile.ZipFile(package) as source, zipfile.ZipFile(tampered, "w") as target:
            for info in source.infolist():
                target.writestr(info, b"tampered" if info.filename == "payload/provider.exe" else source.read(info))
        with self.assertRaises(PackageError): PluginPackage.open(tampered, allow_unsigned=True)
        unsafe = self.root / "unsafe.auvraplugin"
        with zipfile.ZipFile(unsafe, "w") as target:
            target.writestr("plugin.json", b"{}")
            target.writestr("files.sha256", b"")
            target.writestr("../escape", b"x")
        with self.assertRaises(PackageError): PluginPackage.open(unsafe, allow_unsigned=True)
        symlink = self.root / "symlink.auvraplugin"
        with zipfile.ZipFile(symlink, "w") as target:
            for name, data in (("plugin.json", b"{}"), ("files.sha256", b"")):
                target.writestr(name, data)
            info = zipfile.ZipInfo("payload/provider.exe")
            info.external_attr = 0o120777 << 16
            target.writestr(info, b"x")
        with self.assertRaises(PackageError): PluginPackage.open(symlink, allow_unsigned=True)
        reparse = self.root / "reparse.auvraplugin"
        with zipfile.ZipFile(reparse, "w") as target:
            for name, data in (("plugin.json", b"{}"), ("files.sha256", b"")):
                target.writestr(name, data)
            info = zipfile.ZipInfo("payload/provider.exe")
            info.external_attr = 0x400
            target.writestr(info, b"x")
        with self.assertRaises(PackageError): PluginPackage.open(reparse, allow_unsigned=True)

    def test_manifest_must_be_canonical_and_origins_exact(self) -> None:
        package = self.build()
        noncanonical = self.root / "noncanonical.auvraplugin"
        with zipfile.ZipFile(package) as source, zipfile.ZipFile(noncanonical, "w") as target:
            manifest = source.read("plugin.json")
            target.writestr("plugin.json", b"{" + b'"schemaVersion":1,"pluginId":"fixture.provider"' + manifest[manifest.find(b',"publisherKeyId"'):])
            target.writestr("files.sha256", source.read("files.sha256"))
            target.writestr("payload/provider.exe", source.read("payload/provider.exe"))
        with self.assertRaises(PackageError): PluginPackage.open(noncanonical, allow_unsigned=True)
        bad = dict(self.manifest)
        for suffix in ("/path", "?query=1", "#fragment", "user@api.example.test", ":443"):
            bad["permissions"] = {"networkProxy": ["https://api.example.test" + suffix]}
            with self.assertRaises(PackageError):
                build_unsigned_package(self.root, self.root / "bad-origin.auvraplugin", bad)

    def test_permissions_are_default_deny_and_project_bound(self) -> None:
        package = PluginPackage.open(self.build(), allow_unsigned=True)
        grants = PermissionGrantStore()
        broker = ProviderBroker(package, project_id="project-a", grants=grants)
        self.assertFalse(broker.authorize("broker.http", {"origin": "https://api.example.test"}).allowed)
        with self.assertRaises(SecurityError):
            grants.grant(project_id="p" * 129, plugin_id=package.manifest["pluginId"],
                         publisher_key_id=package.manifest["publisherKeyId"], package_digest=package.package_digest,
                         permissions={}, requested=package.manifest["permissions"])
        grants.grant(project_id="project-a", plugin_id=package.manifest["pluginId"],
                     publisher_key_id=package.manifest["publisherKeyId"], package_digest=package.package_digest,
                     permissions={"networkProxy": ["https://api.example.test"], "credentialUse": True},
                     requested=package.manifest["permissions"])
        self.assertTrue(broker.authorize("broker.http", {"origin": "https://api.example.test"}).allowed)
        self.assertFalse(ProviderBroker(package, project_id="project-b", grants=grants).authorize("broker.http", {"origin": "https://api.example.test"}).allowed)
        self.assertFalse(broker.authorize("broker.http", {"origin": "https://other.example.test"}).allowed)
        self.assertFalse(broker.authorize("broker.http", {"origin": "https://api.example.test", "secret": "nope"}).allowed)
        self.assertFalse(broker.authorize("engine.applyChanges", {}).allowed)

    def test_loader_rejects_revoked_package_and_unsigned_fixture_is_test_only(self) -> None:
        package = PluginPackage.open(self.build(), allow_unsigned=True)
        trust = TrustStore()
        grants = PermissionGrantStore()
        revocations = RevocationStore()
        loader = PluginLoader(trust, grants, revocations, allow_unsigned=True)
        self.assertEqual(loader.load(package.path, project_id="project-a").package_digest, package.package_digest)
        revocations.revoke(package_digest=package.package_digest)
        with self.assertRaises(PackageError): loader.load(package.path, project_id="project-a")

    def test_signed_package_helpers_verify_identity_tamper_and_revocation(self) -> None:
        signed, signature = self.signed()
        class DeterministicVerifier:
            def verify(self, *, key_id: str, signed: bytes, signature: bytes) -> bool:
                return key_id == self_key and signature == hashlib.sha256(signed).digest() + hashlib.sha256(b"test:" + signed).digest()
        self_key = self.key_id
        verifier = DeterministicVerifier()
        trust = TrustStore()
        trust.trust_publisher(b"\x01" * 64, plugin_ids={"fixture.provider"})
        signed_package = PluginPackage.open(signed, verifier=verifier, trusted_keys=trust.key_ids)
        grants = PermissionGrantStore()
        grants.grant(project_id="project-a", plugin_id="fixture.provider", publisher_key_id=self.key_id,
                     package_digest=signed_package.package_digest, permissions={}, requested=signed_package.manifest["permissions"])
        revocations = RevocationStore()
        loader = PluginLoader(trust, grants, revocations)
        self.assertEqual(loader.load(signed, project_id="project-a", verifier=verifier).package_digest, signed_package.package_digest)
        revocations.revoke(package_digest=signed_package.package_digest)
        with self.assertRaises(PackageError): loader.load(signed, project_id="project-a", verifier=verifier)
        wrong = self.root / "wrong-key.auvraplugin"
        with self.assertRaises(PackageError):
            attach_signature(self.root / "one.auvraplugin", wrong,
                             key_id=hashlib.sha256(b"\x02" * 64).hexdigest(), signature=signature)
        tampered = self.root / "signed-tampered.auvraplugin"
        with zipfile.ZipFile(signed) as source, zipfile.ZipFile(tampered, "w") as target:
            for info in source.infolist():
                target.writestr(info, b"tampered" if info.filename == "payload/provider.exe" else source.read(info))
        with self.assertRaises(PackageError): PluginPackage.open(tampered, verifier=verifier)

    @unittest.skipUnless(sys.platform == "win32", "Windows CNG is Windows-only")
    def test_cng_signature_verifier_uses_production_bcrypt_boundary(self) -> None:
        class NativeFunction:
            def __init__(self, result, *, assign=None):
                self.result = result
                self.assign = assign
                self.calls = []

            def __call__(self, *args):
                self.calls.append(args)
                if self.assign is not None:
                    self.assign(args)
                return self.result

        def assign_algorithm(args):
            args[0]._obj.value = 101

        def assign_key(args):
            args[3]._obj.value = 202

        class BCrypt:
            def __init__(self):
                self.BCryptOpenAlgorithmProvider = NativeFunction(0, assign=assign_algorithm)
                self.BCryptImportKeyPair = NativeFunction(0, assign=assign_key)
                self.BCryptVerifySignature = NativeFunction(0)
                self.BCryptDestroyKey = NativeFunction(0)
                self.BCryptCloseAlgorithmProvider = NativeFunction(0)

        bcrypt = BCrypt()
        public_key = b"k" * 64
        key_id = hashlib.sha256(public_key).hexdigest()
        verifier = CngSignatureVerifier({key_id: public_key})
        with mock.patch("ctypes.WinDLL", return_value=bcrypt):
            self.assertTrue(verifier.verify(key_id=key_id, signed=b"signed payload", signature=b"s" * 64))
        self.assertEqual(len(bcrypt.BCryptOpenAlgorithmProvider.calls), 1)
        self.assertEqual(len(bcrypt.BCryptImportKeyPair.calls), 1)
        self.assertEqual(len(bcrypt.BCryptVerifySignature.calls), 1)
        self.assertFalse(verifier.verify(key_id=key_id, signed=b"signed payload", signature=b"short"))

    def test_install_is_digest_addressed_and_rolls_back_failed_acl(self) -> None:
        package = self.build()
        install_root = self.root / "installed"
        def deny(_staging: Path, _package: PluginPackage) -> None:
            raise InstallError("test ACL refusal")
        with self.assertRaises(InstallError):
            PluginInstaller(install_root, acl_grant=deny).install(package, allow_unsigned=True)
        self.assertFalse(install_root.exists() and any(install_root.iterdir()))
        installed = PluginInstaller(install_root, acl_grant=lambda _staging, _package: None).install(package, allow_unsigned=True)
        self.assertEqual(installed.executable.read_bytes(), self.entry.read_bytes())
        self.assertEqual(installed.directory.name, installed.package.package_digest)

    def test_nested_entrypoint_remains_bound_through_install_and_worker(self) -> None:
        nested = self.root / "payload" / "subdir" / "provider.exe"
        nested.parent.mkdir()
        nested.write_bytes(self.entry.read_bytes())
        self.manifest["entrypoint"] = {
            "path": "payload/subdir/provider.exe",
            "sha256": hashlib.sha256(nested.read_bytes()).hexdigest(),
        }
        package = PluginPackage.open(self.build(), allow_unsigned=True)
        installer = PluginInstaller(self.root / "nested-install", acl_grant=lambda *_: None)
        installed = installer.install(package.path, allow_unsigned=True)
        self.assertEqual(installed.executable, installed.directory / "payload" / "subdir" / "provider.exe")
        self.assertEqual(installed.executable.read_bytes(), nested.read_bytes())
        reopened = installer.install(package.path, allow_unsigned=True)
        self.assertEqual(reopened.executable, installed.executable)

        class Policy:
            def __init__(self): self.launched = None
            def launch(self, executable: Path, *, package: PluginPackage):
                self.launched = (executable, package)
                return object()

        policy = Policy()
        worker = PluginWorker(package, project_id="project-a", grants=PermissionGrantStore(), policy=policy)
        worker.start(installed.executable)
        self.assertEqual(policy.launched[0], installed.executable)

    def test_persistent_security_state_is_atomic_and_fails_closed_on_corruption(self) -> None:
        state_path = self.root / "security.json"
        state = PersistentSecurityState(state_path)
        state.trust.trust_publisher(b"\x01" * 64, plugin_ids={"fixture.provider"})
        state.grants.grant(project_id="project-a", plugin_id="fixture.provider", publisher_key_id=self.key_id,
                           package_digest="0" * 64, permissions={}, requested={})
        state.revocations.revoke(plugin_id="fixture.provider")
        state.save()
        restored = PersistentSecurityState.load(state_path)
        self.assertTrue(restored.trust.contains(self.key_id, "fixture.provider"))
        self.assertTrue(restored.grants.has_grant(project_id="project-a", plugin_id="fixture.provider",
                                                  publisher_key_id=self.key_id, package_digest="0" * 64))
        self.assertTrue(restored.revocations.is_revoked(package_digest="0" * 64, signer_id=self.key_id, plugin_id="fixture.provider"))
        state_path.write_text("{}", encoding="utf-8")
        with self.assertRaises(SecurityError): PersistentSecurityState.load(state_path)

    def test_provider_protocol_is_framed_bounded_and_path_free(self) -> None:
        frame = encode({"protocol": "auvra.provider/1", "id": "1", "method": "provider.hello", "payload": {}})
        decoded = read_frame(io.BytesIO(frame))
        self.assertEqual(decoded["method"], "provider.hello")
        with self.assertRaises(ProviderProtocolError):
            encode({"protocol": "auvra.provider/1", "id": "1", "method": "x", "payload": {"filePath": "C:/secret"}})
        for payload in ({"File_Path": "opaque"}, {"value": r"C:\secret"}, {"value": "/private/file"}):
            with self.assertRaises(ProviderProtocolError):
                encode({"protocol": "auvra.provider/1", "id": "1", "method": "provider.complete", "payload": payload})
        with self.assertRaises(ProviderProtocolError):
            encode({"protocol": "auvra.provider/1", "id": "1", "method": "x", "payload": {"x": "x" * 70000}})
        class ShortReader(io.BytesIO):
            def read(self, size: int = -1) -> bytes:
                return super().read(1 if size > 1 else size)
        self.assertEqual(read_frame(ShortReader(frame))["id"], "1")
        response = encode({"protocol": "auvra.provider/1", "id": "1", "ok": True, "result": {"text": "done"}})
        self.assertEqual(read_frame(io.BytesIO(response))["result"], {"text": "done"})
        with self.assertRaises(ProviderProtocolError):
            encode({"protocol": "auvra.provider/1", "id": "1", "ok": True, "result": {}, "extra": True})

    def test_worker_exchange_is_bounded_and_uses_digest_addressed_install(self) -> None:
        package = PluginPackage.open(self.build(), allow_unsigned=True)
        installed = PluginInstaller(self.root / "worker-install", acl_grant=lambda *_: None).install(
            package.path, allow_unsigned=True)

        class ReplyStream:
            def __init__(self, request_stream: io.BytesIO) -> None:
                self.request_stream = request_stream
                self.reply: io.BytesIO | None = None
            def read(self, size: int = -1) -> bytes:
                if self.reply is None:
                    request = read_frame(io.BytesIO(self.request_stream.getvalue()))
                    self.reply = io.BytesIO(encode({"protocol": "auvra.provider/1", "id": request["id"],
                                                    "ok": True, "result": {"text": "done"}}))
                return self.reply.read(size)

        class Process:
            def __init__(self) -> None:
                self.stdin = io.BytesIO()
                self.stdout = ReplyStream(self.stdin)
                self.terminated = False
                self.closed = False
                self._cpu = iter((0.0, 1.0))
            def cpu_time_ms(self) -> float: return next(self._cpu)
            def terminate(self) -> None: self.terminated = True
            def wait(self, timeout=None) -> int: return 0
            def close(self) -> None: self.closed = True

        process = Process()
        class Policy:
            def launch(self, executable: Path, *, package: PluginPackage): return process
        worker = PluginWorker(package, project_id="project-a", grants=PermissionGrantStore(), policy=Policy())
        worker.start(installed.executable)
        self.assertEqual(worker.request("provider.complete", {"prompt": "hello"})["result"], {"text": "done"})
        worker.stop()
        self.assertTrue(process.terminated)
        self.assertTrue(process.closed)

    def test_worker_cpu_ceiling_stops_a_valid_but_over_budget_response(self) -> None:
        package = PluginPackage.open(self.build(), allow_unsigned=True)
        installed = PluginInstaller(self.root / "cpu-limit-install", acl_grant=lambda *_: None).install(
            package.path, allow_unsigned=True)

        class ReplyStream:
            def __init__(self, request_stream: io.BytesIO) -> None:
                self.request_stream = request_stream
                self.reply: io.BytesIO | None = None

            def read(self, size: int = -1) -> bytes:
                if self.reply is None:
                    request = read_frame(io.BytesIO(self.request_stream.getvalue()))
                    self.reply = io.BytesIO(encode({
                        "protocol": "auvra.provider/1", "id": request["id"], "ok": True, "result": {},
                    }))
                return self.reply.read(size)

        class Process:
            def __init__(self) -> None:
                self.stdin = io.BytesIO()
                self.stdout = ReplyStream(self.stdin)
                self.terminated = False
                self.closed = False
                self._cpu = iter((0.0, 1001.0))

            def cpu_time_ms(self) -> float: return next(self._cpu)
            def terminate(self) -> None: self.terminated = True
            def wait(self, timeout=None) -> int: return 0
            def close(self) -> None: self.closed = True

        process = Process()
        class Policy:
            def launch(self, executable: Path, *, package: PluginPackage): return process

        worker = PluginWorker(package, project_id="project-a", grants=PermissionGrantStore(), policy=Policy())
        worker.start(installed.executable)
        with self.assertRaisesRegex(IsolationUnavailable, "CPU-time limit"):
            worker.request("provider.complete", {"prompt": "over-budget"})
        self.assertTrue(process.terminated)
        self.assertTrue(process.closed)
        self.assertTrue(worker.disabled)

    def test_worker_wall_ceiling_stops_a_stuck_response_reader(self) -> None:
        self.manifest["resources"]["wallMsPerRequest"] = 20
        package = PluginPackage.open(self.build(), allow_unsigned=True)
        installed = PluginInstaller(self.root / "wall-limit-install", acl_grant=lambda *_: None).install(
            package.path, allow_unsigned=True)

        class BlockingStream:
            def __init__(self) -> None:
                self.released = threading.Event()

            def read(self, size: int = -1) -> bytes:
                self.released.wait(2.0)
                raise OSError("reader released by process termination")

        class Process:
            def __init__(self) -> None:
                self.stdin = io.BytesIO()
                self.stdout = BlockingStream()
                self.terminated = False
                self.closed = False

            def terminate(self) -> None:
                self.terminated = True
                self.stdout.released.set()

            def wait(self, timeout=None) -> int: return 0
            def close(self) -> None: self.closed = True

        process = Process()
        class Policy:
            def launch(self, executable: Path, *, package: PluginPackage): return process

        worker = PluginWorker(package, project_id="project-a", grants=PermissionGrantStore(), policy=Policy())
        worker.start(installed.executable)
        with self.assertRaisesRegex(IsolationUnavailable, "wall-time limit"):
            worker.request("provider.complete", {"prompt": "stuck"})
        self.assertTrue(process.terminated)
        self.assertTrue(process.closed)
        self.assertTrue(worker.disabled)

    def test_worker_malformed_response_stops_the_process(self) -> None:
        package = PluginPackage.open(self.build(), allow_unsigned=True)
        installed = PluginInstaller(self.root / "malformed-response-install", acl_grant=lambda *_: None).install(
            package.path, allow_unsigned=True)

        class Process:
            def __init__(self) -> None:
                self.stdin = io.BytesIO()
                self.stdout = io.BytesIO(b"\x00\x00\x00\x01x")
                self.terminated = False
                self.closed = False

            def terminate(self) -> None: self.terminated = True
            def wait(self, timeout=None) -> int: return 0
            def close(self) -> None: self.closed = True

        process = Process()
        class Policy:
            def launch(self, executable: Path, *, package: PluginPackage): return process

        worker = PluginWorker(package, project_id="project-a", grants=PermissionGrantStore(), policy=Policy())
        worker.start(installed.executable)
        with self.assertRaisesRegex(IsolationUnavailable, "invalid response"):
            worker.request("provider.complete", {"prompt": "malformed"})
        self.assertTrue(process.terminated)
        self.assertTrue(process.closed)

    def test_worker_stop_escalates_to_kill_when_graceful_wait_times_out(self) -> None:
        package = PluginPackage.open(self.build(), allow_unsigned=True)
        installed = PluginInstaller(self.root / "kill-escalation-install", acl_grant=lambda *_: None).install(
            package.path, allow_unsigned=True)

        class Process:
            def __init__(self) -> None:
                self.stdin = io.BytesIO()
                self.stdout = io.BytesIO()
                self.terminated = False
                self.killed = False
                self.closed = False

            def terminate(self) -> None: self.terminated = True
            def wait(self, timeout=None) -> int: raise TimeoutError("still running")
            def kill(self) -> None: self.killed = True
            def close(self) -> None: self.closed = True

        process = Process()
        class Policy:
            def launch(self, executable: Path, *, package: PluginPackage): return process

        worker = PluginWorker(package, project_id="project-a", grants=PermissionGrantStore(), policy=Policy())
        worker.start(installed.executable)
        worker.stop()
        self.assertTrue(process.terminated)
        self.assertTrue(process.killed)
        self.assertTrue(process.closed)
        self.assertIsNone(worker.process)

    def test_windows_isolation_gate_fails_closed_without_injected_backend(self) -> None:
        policy = WindowsAppContainerPolicy()
        with self.assertRaises(IsolationUnavailable):
            policy.launch(Path("provider.exe"), package=object())  # type: ignore[arg-type]

    @unittest.skipUnless(sys.platform == "win32", "real isolation smoke is Windows-only")
    def test_real_windows_isolation_smoke_is_guarded_and_fail_closed(self) -> None:
        """Exercise the ctypes backend when available; never fall back to Popen."""
        policy = WindowsAppContainerPolicy()
        build = int(sys.getwindowsversion().build)
        if build < 26100:
            with self.assertRaises(IsolationUnavailable):
                policy.require_supported()
            return
        system_exe = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "where.exe"
        if not system_exe.is_file():
            self.skipTest("Windows smoke executable is unavailable")
        # A real system executable keeps this smoke independent of a compiler.
        self.entry.write_bytes(system_exe.read_bytes())
        self.manifest["entrypoint"]["sha256"] = hashlib.sha256(self.entry.read_bytes()).hexdigest()
        package = PluginPackage.open(self.build(), allow_unsigned=True)
        installed = PluginInstaller(self.root / "isolated", acl_grant=None).install(
            package.path, allow_unsigned=True)
        try:
            process = policy.launch(installed.executable, package=package)
        except IsolationUnavailable as exc:
            if "(50)" in str(exc):
                self.skipTest("host Windows reports AppContainer APIs unsupported")
            self.fail(f"supported Windows reported unavailable isolation: {exc}")
        self.assertGreater(process.pid, 0)
        process.terminate()
        try:
            process.wait(timeout=5)
        finally:
            process.close()


if __name__ == "__main__":
    unittest.main()
