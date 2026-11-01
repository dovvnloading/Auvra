from __future__ import annotations

import io
import json
import struct
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from Auvra.providers.adapters import MediaJob
from Auvra.providers.errors import ProviderError
from Auvra.providers.reframe import MODEL, ReframeAdapter, _Blobs, build_render_config, find_home, read_bundle_header
from Auvra.providers.transport import StdlibTransport


def bundle(header: dict, data: bytes = b"") -> bytes:
    encoded = json.dumps(header).encode()
    return b"AUVRARB1" + struct.pack("<I", len(encoded)) + encoded + data


MESH = {"positions": {"offset": 0, "length": 36}, "uvs": {"offset": 36, "length": 24}, "normals": {"offset": 60, "length": 36}, "material": {"baseColor": [0.2, 0.3, 0.4], "roughness": 0.5}}


class BundleTests(unittest.TestCase):
    def config(self, header: dict, data: bytes, folder: Path, settings: dict | None = None) -> dict:
        raw = bundle(header, data)
        stream = io.BytesIO(raw)
        read, start = read_bundle_header(stream)
        return build_render_config(read, settings or {}, _Blobs(stream, start, len(raw), folder))

    def test_a_scene_becomes_files_in_the_jobs_folder_and_only_known_settings(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            folder = Path(raw)
            header = {"meshes": [MESH], "lights": [{"type": "directional", "direction": [0, -1, 0], "intensity": 3}, {"type": "made-up"}],
                      "camera": {"position": [1, 2, 3], "target": [0, 0, 0], "fov": 40}}
            config = self.config(header, bytes(96), folder, {"width": 320, "height": 200, "samples": 8, "shell": "calc.exe"})
            self.assertEqual((config["width"], config["height"], config["samples_per_pixel"]), (320, 200, 8))
            self.assertNotIn("shell", config)
            self.assertEqual([light["type"] for light in config["lights"]], ["directional"])
            mesh = config["objects"][0]
            self.assertEqual(Path(mesh["positionsPath"]).parent, folder)
            self.assertEqual(Path(mesh["positionsPath"]).stat().st_size, 36)
            self.assertEqual(mesh["material"]["baseColor"], [0.2, 0.3, 0.4])
            self.assertEqual(config["camera"]["vfov"], 40)

    def test_a_scene_cannot_name_a_file_of_its_own(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            folder = Path(raw)
            evil = dict(MESH, positionsPath="C:/Windows/win.ini", material={"baseColorTexture": {"offset": 0, "length": 4}, "hdri_path": "C:/x"})
            config = self.config({"meshes": [evil], "environment": {"hdri_path": "C:/secret.png"}}, bytes(96), folder)
            self.assertEqual(Path(config["objects"][0]["positionsPath"]).parent, folder)
            self.assertNotIn("hdri_path", config["objects"][0]["material"])
            self.assertNotIn("hdri_path", config["environment"])
            self.assertTrue(config["objects"][0]["material"]["baseColorTexture"].startswith("data:image/png;base64,"))

    def test_settings_stay_within_what_a_renderer_can_do(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            config = self.config({"meshes": [MESH]}, bytes(96), Path(raw), {"width": 10 ** 9, "height": -5, "samples": "lots", "bounces": True})
            self.assertEqual((config["width"], config["height"]), (8192, 16))
            self.assertEqual((config["samples_per_pixel"], config["max_bounces"]), (64, 6))
            self.assertIs(config["denoise"], False)
            self.assertIs(self.config({"meshes": [MESH]}, bytes(96), Path(raw), {"denoise": True})["denoise"], True)

    def test_parts_outside_the_bundle_are_refused(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            with self.assertRaises(ProviderError):
                self.config({"meshes": [dict(MESH, positions={"offset": 90, "length": 900})]}, bytes(96), Path(raw))

    def test_something_else_is_not_read_as_a_scene(self) -> None:
        with self.assertRaises(ProviderError):
            read_bundle_header(io.BytesIO(b"not a scene at all"))

    def test_an_empty_scene_says_so(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            with self.assertRaises(ProviderError):
                self.config({"meshes": []}, b"", Path(raw))


class AdapterTests(unittest.TestCase):
    def adapter(self, root: Path) -> ReframeAdapter:
        return ReframeAdapter(StdlibTransport(), jobs_root=root / "jobs")

    def test_it_offers_the_one_model(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            self.assertEqual(self.adapter(Path(raw)).list_models(), (MODEL,))

    def test_it_says_when_reframe_is_not_there(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            with mock.patch("Auvra.providers.reframe.find_home", return_value=None):
                adapter = self.adapter(Path(raw))
                self.assertFalse(adapter.health())
                job = adapter.upload_input(source=io.BytesIO(bundle({"meshes": [MESH]}, bytes(96))), size=1)
                with self.assertRaises(ProviderError) as refused:
                    adapter.submit(model=MODEL, payload=adapter.media_request(model=MODEL, prompt="{}", images=[job]))
                self.assertIn("not found", refused.exception.message)

    def test_it_finds_reframe_where_it_is_named(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            engine = Path(raw) / "gi_renderer" / "engine"
            engine.mkdir(parents=True)
            (engine / "render.py").write_text("")
            with mock.patch.dict("os.environ", {"AUVRA_REFRAME_HOME": raw}):
                self.assertEqual(find_home(), Path(raw))

    def test_a_job_id_cannot_leave_the_jobs_folder(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            adapter = self.adapter(Path(raw))
            with self.assertRaises(ProviderError):
                adapter.status(MediaJob("reframe", MODEL, "../../somewhere"))

    def test_a_worker_that_dies_without_a_word_is_a_failure(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            adapter = self.adapter(Path(raw))
            job_id = adapter.upload_input(source=io.BytesIO(b"x"), size=1)
            folder = Path(raw) / "jobs" / job_id
            (folder / "status.json").write_text(json.dumps({"state": "running", "progress": 0.2}))
            (folder / "worker.log").write_text("first\nCUDA is not available\n")
            gone = mock.Mock()
            gone.poll.return_value = 1
            adapter._processes[job_id] = gone
            status = adapter.status(MediaJob("reframe", MODEL, job_id))
            self.assertEqual(adapter.status_state(status), "failed")
            self.assertEqual(status["error"], "CUDA is not available")

    def test_stopping_leaves_word_for_the_worker(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            adapter = self.adapter(Path(raw))
            job_id = adapter.upload_input(source=io.BytesIO(b"x"), size=1)
            adapter.cancel(MediaJob("reframe", MODEL, job_id))
            self.assertTrue((Path(raw) / "jobs" / job_id / "cancel").exists())

    def test_a_render_that_does_not_stop_by_itself_is_ended(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            adapter = self.adapter(Path(raw))
            job_id = adapter.upload_input(source=io.BytesIO(b"x"), size=1)
            job = MediaJob("reframe", MODEL, job_id)
            compiling = mock.Mock()
            compiling.poll.return_value = None
            adapter._processes[job_id] = compiling
            (Path(raw) / "jobs" / job_id / "status.json").write_text(json.dumps({"state": "running", "progress": 0.0}))
            with mock.patch("Auvra.providers.reframe.time.monotonic", return_value=100.0):
                adapter.cancel(job)
                self.assertEqual(adapter.status_state(adapter.status(job)), "running")
                compiling.kill.assert_not_called()
            with mock.patch("Auvra.providers.reframe.time.monotonic", return_value=106.0):
                adapter.status(job)
                compiling.kill.assert_called_once()
            compiling.poll.return_value = -9
            self.assertEqual(adapter.status_state(adapter.status(job)), "cancelled")

    def test_the_finished_picture_is_handed_over_and_the_folder_goes(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            adapter = self.adapter(Path(raw))
            job_id = adapter.upload_input(source=io.BytesIO(b"x"), size=1)
            folder = Path(raw) / "jobs" / job_id
            (folder / "final.png").write_bytes(b"picture")
            sink = io.BytesIO()
            artifact = adapter.download_output(adapter.result(MediaJob("reframe", MODEL, job_id))["images"][0]["url"], sink=sink)
            self.assertEqual((sink.getvalue(), artifact.content_type, artifact.size), (b"picture", "image/png", 7))
            self.assertFalse(folder.exists())


if __name__ == "__main__":
    unittest.main()
