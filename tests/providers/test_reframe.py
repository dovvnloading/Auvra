from __future__ import annotations

import importlib.util
import io
import math
import json
import struct
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from Auvra.providers.adapters import MediaJob
from Auvra.providers.errors import ProviderError
from Auvra.providers.reframe import MODEL, ReframeAdapter, _Blobs, build_render_config, find_home, read_bundle_header
from Auvra.providers.reframe_worker import fog_transmittance, panorama_along_view
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

    def test_what_is_see_through_by_its_picture_stays_so(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            picture = {"offset": 0, "length": 4}
            config = self.config({"meshes": [dict(MESH, material={"baseColorTexture": picture, "opacityTexture": picture})]}, bytes(96), Path(raw))
            self.assertTrue(config["objects"][0]["material"]["opacityTexture"].startswith("data:image/png;base64,"))

    def _config(self, **extra: object) -> dict:
        with tempfile.TemporaryDirectory() as raw:
            data = bundle({"meshes": [MESH], **extra}, bytes(96))
            path = Path(raw) / "bundle.bin"
            path.write_bytes(data)
            with path.open("rb") as stream:
                header, start = read_bundle_header(stream)
                return build_render_config(header, {}, _Blobs(stream, start, len(data), Path(raw)))

    def test_it_matches_the_views_exposure_and_limits_fireflies(self) -> None:
        self.assertAlmostEqual(self._config(exposure=1.5)["exposure"], 1.5)
        self.assertAlmostEqual(self._config()["exposure"], 0.737)
        self.assertGreater(self._config()["firefly_clamp"], 0)
        self.assertLessEqual(self._config(exposure=1e9)["exposure"], 20)

    def test_a_views_fog_goes_to_the_worker_in_its_own_kind(self) -> None:
        self.assertEqual(self._config()["volumetric_fog"]["kind"], "none")
        squared = self._config(fog={"color": [0.1, 0.2, 0.3], "density": 0.01})["volumetric_fog"]
        self.assertEqual((squared["kind"], squared["density"], squared["enabled"]), ("squared", 0.01, True))
        self.assertEqual(squared["color"], [0.1, 0.2, 0.3])
        linear = self._config(fog={"color": [0, 0, 0], "near": 10, "far": 90})["volumetric_fog"]
        self.assertEqual((linear["kind"], linear["near"], linear["far"]), ("linear", 10.0, 90.0))

    def test_fog_that_would_do_nothing_is_left_out(self) -> None:
        for fog in ({"color": [0, 0, 0], "density": 0}, {"color": [0, 0, 0], "near": 50, "far": 50}, "thick"):
            self.assertEqual(self._config(fog=fog)["volumetric_fog"]["kind"], "none")

    def test_a_frame_is_lit_by_what_lights_the_view_and_shows_the_sky_the_view_shows(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            part = {"offset": 0, "length": 4}
            config = self.config(
                {"meshes": [dict(MESH)], "environment": {"lightAround": part, "panorama": part, "panoramaIsLight": True, "intensity": 2.0, "rotation": 30},
                 "camera": {"position": [1, 2, 3], "target": [0, 0, 0], "fov": 40}},
                bytes(96), Path(root),
            )
        environment, finish = config["environment"], config["volumetric_fog"]
        self.assertTrue(environment["hdri_path"].endswith(".hdr"))
        self.assertEqual(environment["intensity"], 1.0)
        self.assertNotIn("rotation_deg", environment)
        shown = finish["sky"]
        self.assertEqual(shown["light_around"], environment["hdri_path"])
        self.assertTrue(shown["panorama"].endswith(".hdr"))
        self.assertEqual((shown["intensity"], shown["rotation_deg"]), (2.0, 30.0))
        self.assertEqual(finish["camera"], {"lookfrom": [1.0, 2.0, 3.0], "lookat": [0.0, 0.0, 0.0], "vfov": 40.0})

    def test_what_a_views_stack_does_reaches_the_worker(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            part = {"offset": 0, "length": 4}
            config = self.config(
                {"meshes": [dict(MESH)], "toneMapping": "reinhard", "blendsOnScreen": False, "cloudShade": {"picture": part, "width": 16, "height": 16}, "over": {"picture": part, "width": 16, "height": 16},
                 "post": {"saturation": 0.5, "brightness": 9, "vignette": 0.4, "whiteBalance": [1.1, 1, 0.9], "look": {"table": part, "size": 32, "strength": 0.5}, "bloom": {"intensity": 1, "threshold": 2}, "fringe": 0.5}},
                bytes(96), Path(root),
            )
        finish = config["volumetric_fog"]
        self.assertEqual(config["tone_map"], "reinhard")
        self.assertFalse(finish["on_screen"])
        self.assertEqual((finish["over"]["width"], finish["cloud_shade"]["height"]), (16, 16))
        self.assertTrue(finish["over"]["picture"].endswith(".bin"))
        grade = finish["grade"]
        self.assertEqual((grade["saturation"], grade["brightness"], grade["vignette"]), (0.5, 1.0, 0.4))
        self.assertEqual(grade["white_balance"], [1.1, 1.0, 0.9])
        self.assertEqual((grade["look"]["size"], grade["look"]["strength"]), (32, 0.5))
        self.assertEqual(config["post"]["bloom"]["threshold"], 2.0)
        self.assertTrue(config["post"]["chromatic_aberration"]["enabled"])

    def test_a_views_depth_of_field_becomes_a_lens_of_the_same_blur(self) -> None:
        self.assertNotIn("fstop", self._config()["camera"])
        camera = self._config(post={"depthOfField": {"focus": 10, "bokeh": 5}}, camera={"fov": 90})["camera"]
        self.assertEqual(camera["focus_distance"], 10.0)
        # A lens this wide takes a point at any great distance to 3% of the height of the frame.
        radius = camera["focal_length"] / camera["fstop"] / 2.0
        self.assertAlmostEqual(radius / 10.0, 0.03)
        self.assertNotIn("fstop", self._config(post={"depthOfField": {"focus": 10, "bokeh": 0}})["camera"])

    @unittest.skipUnless(importlib.util.find_spec("numpy"), "reads a picture with numpy, which runs under Reframe's own Python")
    def test_a_panorama_is_read_the_way_round_the_renderer_reads_one(self) -> None:
        import numpy as np

        # Longitude from atan(z, x), the middle of the picture at zero: straight along +x is its middle.
        panorama = np.zeros((4, 8, 3), dtype=np.float32)
        panorama[:, 4:] = 1.0
        camera = {"lookfrom": [0.0, 0.0, 0.0], "lookat": [1.0, 0.0, 0.0], "vfov": 20.0}
        along = panorama_along_view(np, panorama, 0.0, camera, 8, 8)
        self.assertEqual(along.shape, (8, 8, 3))
        # Looking along +x, +z is to the right.
        self.assertLess(float(along[4, 0, 0]), float(along[4, 7, 0]))
        turned = panorama_along_view(np, panorama, 180.0, camera, 8, 8)
        self.assertGreater(float(turned[4, 0, 0]), float(turned[4, 7, 0]))

    def test_the_worker_thins_fog_by_the_viewports_law(self) -> None:
        clip = lambda value, low, high: max(low, min(high, value))  # noqa: E731
        squared = {"kind": "squared", "density": 0.01}
        self.assertAlmostEqual(fog_transmittance(0.0, squared, math.exp, clip), 1.0)
        self.assertAlmostEqual(fog_transmittance(100.0, squared, math.exp, clip), math.exp(-1.0))
        linear = {"kind": "linear", "near": 10.0, "far": 30.0}
        self.assertAlmostEqual(fog_transmittance(5.0, linear, math.exp, clip), 1.0)
        self.assertAlmostEqual(fog_transmittance(20.0, linear, math.exp, clip), 0.5)
        self.assertAlmostEqual(fog_transmittance(99.0, linear, math.exp, clip), 0.0)

    def test_settings_stay_within_what_a_renderer_can_do(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            config = self.config({"meshes": [MESH]}, bytes(96), Path(raw), {"width": 10 ** 9, "height": -5, "samples": "lots", "bounces": True})
            self.assertEqual((config["width"], config["height"]), (8192, 16))
            self.assertEqual((config["samples_per_pixel"], config["max_bounces"]), (64, 6))
            self.assertEqual(config["denoise"], {"enabled": False, "provider": "oidn"})
            self.assertEqual(self.config({"meshes": [MESH]}, bytes(96), Path(raw), {"denoise": True})["denoise"], {"enabled": True, "provider": "oidn"})

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

    def _reframe_in(self, folder: Path) -> Path:
        engine = folder / "gi_renderer" / "engine"
        engine.mkdir(parents=True)
        (engine / "render.py").write_text("")
        return folder

    def test_it_finds_reframe_where_someone_chose(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            kept = self._reframe_in(root / "kept here")
            with mock.patch.dict("os.environ", {"AUVRA_REFRAME_HOME": ""}), mock.patch("Auvra.providers.reframe.Path.home", return_value=root / "nobody"), mock.patch("Auvra.providers.reframe.find_python", return_value="python"):
                adapter = self.adapter(root)
                self.assertFalse(adapter.health())
                self.assertTrue(adapter.choose_home(kept))
                self.assertTrue(adapter.health())
                # It is still known after a restart.
                self.assertTrue(self.adapter(root).health())

    def test_it_refuses_a_folder_reframe_is_not_in_and_keeps_what_it_had(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            kept = self._reframe_in(root / "kept here")
            (root / "empty").mkdir()
            with mock.patch.dict("os.environ", {"AUVRA_REFRAME_HOME": ""}), mock.patch("Auvra.providers.reframe.Path.home", return_value=root / "nobody"), mock.patch("Auvra.providers.reframe.find_python", return_value="python"):
                adapter = self.adapter(root)
                self.assertTrue(adapter.choose_home(kept))
                self.assertFalse(adapter.choose_home(root / "empty"))
                self.assertTrue(adapter.health())

    def test_a_chosen_folder_that_has_gone_is_looked_past(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            usual = self._reframe_in(root / "home" / "source" / "repos" / "Reframe-Diffused" / "Reframe-Diffused")
            self.assertEqual(usual.name, "Reframe-Diffused")
            with mock.patch.dict("os.environ", {"AUVRA_REFRAME_HOME": ""}), mock.patch("Auvra.providers.reframe.Path.home", return_value=root / "home"):
                self.assertEqual(find_home(root / "gone"), usual)

    def test_the_variable_wins_over_a_chosen_folder(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            named = self._reframe_in(root / "named")
            chosen = self._reframe_in(root / "chosen")
            with mock.patch.dict("os.environ", {"AUVRA_REFRAME_HOME": str(named)}):
                self.assertEqual(find_home(chosen), named)

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
