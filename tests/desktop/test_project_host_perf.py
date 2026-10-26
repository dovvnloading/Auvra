"""Edit-time cost of the project host: asset verification and native mirroring."""

from __future__ import annotations

import io
import os
from pathlib import Path
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from Auvra.desktop.assets import AssetTransferRegistry
from Auvra.desktop.dialogs import DialogSelection
from Auvra.desktop.native_engine import NativeEngineState, NativeEngineUnavailableHost
from Auvra.desktop.project_host import NativeProjectHost
from Auvra.host.dispatcher import HostOperationError
from Auvra.project import assets as asset_module
from Auvra.project.assets import AssetStore

_ORIGIN = "http://127.0.0.1:3000"


def _glb(payload: bytes = b"{}  ") -> bytes:
    chunk = struct.pack("<II", len(payload), 0x4E4F534A) + payload
    return b"glTF" + struct.pack("<II", 2, 12 + len(chunk)) + chunk


class _Dialogs:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.created = 0

    def choose_create_location(self, suggested_name: str):
        self.created += 1
        return DialogSelection(self.root / f"{suggested_name}-{self.created}")


class _StoppableNative:
    """Native host double whose child can be stopped and made READY again."""

    def __init__(self, state: NativeEngineState = NativeEngineState.READY) -> None:
        self.engine = SimpleNamespace(state=state)
        self.hydrations: list[tuple[str, int]] = []
        self.validations: list[int] = []
        self.closed: list[str | None] = []

    def validate_project(self, project_id, revision, domains):
        self.validations.append(revision)

    def hydrate_project(self, project_id, revision, domains, *, asset_ids=()):
        self.hydrations.append((project_id, revision))

    def close_project(self, project_id=None):
        self.closed.append(project_id)

    def stage_asset(self, asset_id, stream):
        stream.read()


class ProjectHostEditPerformanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.registry = AssetTransferRegistry(
            self.root / "transfers", session_id="session-project-host-perf", trusted_origin=_ORIGIN,
        )
        self.host = NativeProjectHost(
            self.root / "state", asset_registry=self.registry, dialogs=_Dialogs(self.root / "projects"),
        )

    def tearDown(self) -> None:
        self.host.shutdown()
        self.registry.close()
        self.temp.cleanup()

    def _upload(self, project: dict, mime: str, data: bytes) -> str:
        ticket = self.host.handle("asset.beginUpload", {
            "projectId": project["projectId"], "expectedRevision": project["revision"],
            "size": len(data), "mime": mime, "name": "model",
        })
        response = self.registry.handle(
            method="PUT", url=ticket["url"],
            headers={"Origin": _ORIGIN, "Content-Type": mime, "Content-Length": str(len(data))},
            body=io.BytesIO(data),
        )
        return response.headers["X-Auvra-Asset-Sha256"]

    def _rename(self, project: dict, revision: int, name: str) -> dict:
        return self.host.handle("project.applyChanges", {
            "projectId": project["projectId"], "expectedRevision": revision,
            "changes": [{"domain": "metadata", "documentId": "project", "operation": "upsert",
                         "document": {"id": "project", "name": name}}],
        })

    def _add_model(self, project: dict, revision: int, asset_id: str) -> dict:
        return self.host.handle("project.applyChanges", {
            "projectId": project["projectId"], "expectedRevision": revision,
            "changes": [{"domain": "models", "documentId": "model", "operation": "upsert",
                         "document": {"id": "model", "name": "Model", "assetId": asset_id}}],
        })

    def test_edits_do_not_rehash_unchanged_referenced_assets(self) -> None:
        created = self.host.handle("project.create", {"name": "Perf"})
        asset_id = self._upload(created, "model/gltf-binary", _glb())
        with mock.patch.object(asset_module, "_file_digest", wraps=asset_module._file_digest) as digest:
            status = self._add_model(created, created["revision"], asset_id)
            for index in range(5):
                status = self._rename(created, status["revision"], f"Edit {index}")
            # The upload hashed the bytes while staging them; every later edit
            # only stats the unchanged blob.
            self.assertEqual(digest.call_count, 0)
            self.assertEqual(status["revision"], 6)

            # A modified blob is hashed again and fails the next edit closed.
            blob = self.host.service.active.assets.path_for(asset_id)
            data = bytearray(blob.read_bytes())
            data[-1] ^= 0xFF
            blob.write_bytes(bytes(data))
            info = blob.stat()
            os.utime(blob, ns=(info.st_atime_ns, info.st_mtime_ns + 1_000_000_000))
            with self.assertRaises(HostOperationError) as raised:
                self._rename(created, status["revision"], "Tampered")
            self.assertEqual(raised.exception.code, "invalid_project")
            self.assertGreaterEqual(digest.call_count, 1)

    def test_store_verification_is_cached_until_the_blob_changes(self) -> None:
        store = AssetStore(self.root / "store")
        reference = store.put_stream(io.BytesIO(b"cached-blob"), name="blob.bin")
        path = store.path_for(reference.asset_id)
        with mock.patch.object(asset_module, "_file_digest", wraps=asset_module._file_digest) as digest:
            # A fresh view of the same store shares the verified fingerprint.
            for _ in range(3):
                self.assertTrue(AssetStore(self.root / "store").verify(reference.asset_id))
            self.assertEqual(digest.call_count, 0)
            info = path.stat()
            os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns + 1_000_000_000))
            self.assertTrue(store.verify(reference.asset_id))
            self.assertEqual(digest.call_count, 1)
            self.assertTrue(store.verify(reference.asset_id))
            self.assertEqual(digest.call_count, 1)
            self.assertFalse(store.verify(reference.asset_id, expected_size=reference.size + 1))
            store.remove(reference.asset_id)
            self.assertFalse(store.verify(reference.asset_id))

    def test_model_uploads_accept_glb_gltf_json_and_obj(self) -> None:
        created = self.host.handle("project.create", {"name": "Models"})
        uploads = {
            "model/gltf-binary": _glb(),
            "model/gltf+json": b'\xef\xbb\xbf  {"asset": {"version": "2.0"}}',
            "model/obj": b"# cube\nmtllib cube.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n",
        }
        for mime, data in uploads.items():
            with self.subTest(mime=mime):
                asset_id = self._upload(created, mime, data)
                resolved = self.host.handle("asset.resolve", {
                    "projectId": created["projectId"], "assetId": asset_id,
                })
                self.assertEqual(resolved["mime"], mime)
                self.assertEqual(resolved["size"], len(data))

        rejected = {
            "model/gltf-binary": b"not a binary gltf",
            "model/gltf+json": b"solid cube\nfacet normal 0 0 1\n",
            "model/obj": b"\x00\x01\x02binary\x00",
        }
        for mime, data in rejected.items():
            with self.subTest(rejected=mime):
                with self.assertRaises(ValueError):
                    self._upload(created, mime, data)
        # A binary signature declared as a text model is refused too.
        with self.assertRaises(ValueError):
            AssetStore(self.root / "spoof").put_stream(io.BytesIO(_glb()), mime="model/obj")

    def test_unavailable_native_engine_skips_hydration_entirely(self) -> None:
        self.host.set_native_engine_host(NativeEngineUnavailableHost())
        created = self.host.handle("project.create", {"name": "WebOnly"})
        asset_id = self._upload(created, "model/gltf-binary", _glb())
        with mock.patch.object(self.host, "_native_domains", wraps=self.host._native_domains) as domains, \
                mock.patch.object(self.host, "_degrade_native_view") as degraded:
            status = self._add_model(created, created["revision"], asset_id)
            status = self._rename(created, status["revision"], "Still web")
        self.assertEqual(status["revision"], 2)
        domains.assert_not_called()
        degraded.assert_not_called()
        self.assertFalse(self.host._native_resync)

    def test_stopped_native_child_skips_edits_and_resyncs_on_tick(self) -> None:
        native = _StoppableNative()
        self.host.set_native_engine_host(native)
        first = self.host.handle("project.create", {"name": "First"})
        self.assertEqual(native.hydrations, [(first["projectId"], 0)])

        native.engine.state = NativeEngineState.FAILED
        status = self._rename(first, first["revision"], "Edited while stopped")
        self.assertEqual(len(native.hydrations), 1)
        self.assertEqual(native.validations, [])

        # Switching projects while stopped drops the previous native project
        # so a native restart cannot re-present it.
        second = self.host.handle("project.create", {"name": "Second"})
        self.assertEqual(native.closed, [first["projectId"]])
        self.host.tick()
        self.assertEqual(len(native.hydrations), 1)

        native.engine.state = NativeEngineState.READY
        self.host.tick()
        self.assertEqual(native.hydrations[-1], (second["projectId"], second["revision"]))
        self.host.tick()
        self.assertEqual(len(native.hydrations), 2)
        self.assertNotEqual(status["projectId"], second["projectId"])

    def test_running_native_reuses_unchanged_domains_read_for_validation(self) -> None:
        native = _StoppableNative()
        self.host.set_native_engine_host(native)
        created = self.host.handle("project.create", {"name": "Reuse"})
        with mock.patch.object(self.host, "_native_domains", wraps=self.host._native_domains) as domains:
            self._rename(created, created["revision"], "Renamed")
        # Every native domain is unchanged by a metadata edit, so hydration
        # reuses the documents validation already read instead of re-reading.
        self.assertEqual(domains.call_count, 1)
        reuse = domains.call_args.args[1]
        self.assertEqual(set(reuse), set(NativeProjectHost._native_fields()))
        self.assertEqual(native.validations, [1])
        self.assertEqual(native.hydrations[-1], (created["projectId"], 1))


if __name__ == "__main__":
    unittest.main()
