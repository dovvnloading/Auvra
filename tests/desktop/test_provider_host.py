from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock
from types import SimpleNamespace

from Auvra.desktop.credential_prompt import CredentialPromptUnavailableError
from Auvra.desktop.dialogs import DialogSelection, DialogUnavailableError
from Auvra.desktop.previews import PreviewStore
from Auvra.desktop.provider_host import NativeProviderHost
from Auvra.host.dispatcher import HostOperationError
from Auvra.project import ProjectIndex, ProjectService
from Auvra.providers import Capability
from Auvra.providers.adapters import TextResult
from Auvra.providers.jobs import JobState


@dataclass
class _Active:
    project_id: str = "project-1"
    revision: int = 0
    read_only: bool = False


class _Service:
    def __init__(self) -> None:
        self.active = _Active()


class _Project:
    def __init__(self) -> None:
        self.service = _Service()


class _Prompt:
    def __init__(self, secret: str) -> None:
        self.secret = secret

    def prompt(self, _label: str) -> str:
        return self.secret


def _key_window_outcome(host: NativeProviderHost) -> dict:
    """What a person's answer to the key window came to, once they have given it."""
    for _ in range(500):
        for name, payload in host.drain_events():
            if name == "provider.status" and str(payload.get("operation", "")).startswith("key."):
                return payload
        time.sleep(0.01)
    raise AssertionError("the key window never reported back")


def _folder_window_outcome(host: NativeProviderHost) -> dict:
    """What a person's answer to the folder window came to, once they have given it."""
    for _ in range(500):
        for name, payload in host.drain_events():
            if name == "provider.status" and str(payload.get("operation", "")).startswith("folder."):
                return payload
        time.sleep(0.01)
    raise AssertionError("the folder window never reported back")


class _Folders:
    """Answers the folder window with one folder, or nothing."""

    def __init__(self, folder: Path | None) -> None:
        self.folder = folder
        self.asked: list[str] = []

    def choose_folder(self, description: str) -> DialogSelection | None:
        self.asked.append(description)
        return DialogSelection(self.folder) if self.folder else None


class _Adapter:
    def complete(self, *, model: str, prompt: str, capability="text", structured_command: bool = False):
        assert not structured_command
        return TextResult("openai", model, "safe normalized output")

    def health(self) -> bool:
        return True

    def list_models(self) -> tuple[str, ...]:
        return ("gpt-4o-mini",)


class ProviderHostTests(unittest.TestCase):
    def _reframe_folder(self, root: Path) -> Path:
        folder = root / "kept here"
        (folder / "gi_renderer" / "engine").mkdir(parents=True)
        (folder / "gi_renderer" / "engine" / "render.py").write_text("")
        return folder

    def test_choosing_reframes_folder_opens_on_the_ui_thread_and_finds_it(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            folders = _Folders(self._reframe_folder(root))
            host = NativeProviderHost(root / "state", project_host=_Project(), folder_dialogs=folders)
            ran = []
            host.set_ui_invoker(lambda callback: ran.append("ui") or callback())
            try:
                with mock.patch.dict("os.environ", {"AUVRA_REFRAME_HOME": ""}), mock.patch("Auvra.providers.reframe.Path.home", return_value=root / "nobody"), mock.patch("Auvra.providers.reframe.find_python", return_value="python"):
                    self.assertFalse(host.handle("provider.health", {"providerId": "reframe"})["healthy"])
                    opened = host.handle("provider.chooseFolder", {"providerId": "reframe"})
                    self.assertEqual(opened, {"kind": "provider.folder", "providerId": "reframe", "waiting": True})
                    outcome = _folder_window_outcome(host)
                    self.assertEqual(outcome["operation"], "folder.saved")
                    self.assertEqual(outcome["status"], "ready")
                    self.assertEqual(ran, ["ui"])
                    self.assertIn("Reframe", folders.asked[0])
                    self.assertTrue(host.handle("provider.health", {"providerId": "reframe"})["healthy"])
                    # The page is told how it went, and never where.
                    self.assertNotIn("kept here", str(opened) + str(outcome))
            finally:
                host.shutdown()

    def test_a_folder_reframe_is_not_in_is_refused_with_what_to_look_for(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "empty").mkdir()
            host = NativeProviderHost(root / "state", project_host=_Project(), folder_dialogs=_Folders(root / "empty"))
            try:
                host.handle("provider.chooseFolder", {"providerId": "reframe"})
                outcome = _folder_window_outcome(host)
                self.assertEqual(outcome["operation"], "folder.refused")
                self.assertIn("gi_renderer", outcome["message"])
            finally:
                host.shutdown()

    def test_closing_the_folder_window_complains_of_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            host = NativeProviderHost(Path(raw), project_host=_Project(), folder_dialogs=_Folders(None))
            try:
                host.handle("provider.chooseFolder", {"providerId": "reframe"})
                outcome = _folder_window_outcome(host)
                self.assertEqual(outcome["operation"], "folder.cancelled")
                self.assertNotIn("message", outcome)
            finally:
                host.shutdown()

    def test_a_folder_window_that_cannot_open_says_so(self) -> None:
        class Unavailable:
            def choose_folder(self, _description: str) -> None:
                raise DialogUnavailableError("no")

        with tempfile.TemporaryDirectory() as raw:
            host = NativeProviderHost(Path(raw), project_host=_Project(), folder_dialogs=Unavailable())
            try:
                host.handle("provider.chooseFolder", {"providerId": "reframe"})
                self.assertEqual(_folder_window_outcome(host)["operation"], "folder.failed")
            finally:
                host.shutdown()

    def test_an_open_folder_window_holds_up_nothing_else_and_opens_once(self) -> None:
        answered = threading.Event()

        class Waiting:
            def choose_folder(self, _description: str) -> None:
                answered.wait(5)

        with tempfile.TemporaryDirectory() as raw:
            host = NativeProviderHost(Path(raw), project_host=_Project(), folder_dialogs=Waiting())
            try:
                host.handle("provider.chooseFolder", {"providerId": "reframe"})
                self.assertEqual(host.handle("provider.list", {})["kind"], "provider.list")
                with self.assertRaises(HostOperationError) as second:
                    host.handle("provider.chooseFolder", {"providerId": "reframe"})
                self.assertEqual(second.exception.code, "locking")
                answered.set()
                _folder_window_outcome(host)
            finally:
                answered.set()
                host.shutdown()

    def test_a_provider_not_kept_in_a_folder_has_no_window(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            host = NativeProviderHost(Path(raw), project_host=_Project(), folder_dialogs=_Folders(None), adapters={"openai": _Adapter()})
            try:
                with self.assertRaises(HostOperationError) as refused:
                    host.handle("provider.chooseFolder", {"providerId": "openai"})
                self.assertEqual(refused.exception.code, "invalid_request")
            finally:
                host.shutdown()

    def test_credential_prompt_and_status_never_persist_secret(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            host = NativeProviderHost(root, project_host=_Project(), credential_prompt=_Prompt("super-secret"))
            try:
                result = host.handle("provider.configureCredential", {"providerId": "openai", "storageMode": "memoryOnly"})
                self.assertIs(result["waiting"], True)
                outcome = _key_window_outcome(host)
                self.assertEqual(outcome["operation"], "key.saved")
                self.assertEqual(outcome["status"], "ready")
                self.assertNotIn("secret", str(result).lower() + str(outcome).lower())
                status = host.handle("provider.getStatus", {"providerId": "openai"})
                self.assertEqual(status["credentialStatus"], "memoryOnly")
            finally:
                host.shutdown()
            for path in root.rglob("*"):
                if path.is_file():
                    self.assertNotIn(b"super-secret", path.read_bytes())

    def test_an_open_key_window_holds_up_nothing_else(self) -> None:
        answered = threading.Event()

        class Waiting:
            def prompt(self, _label: str) -> str:
                answered.wait(5)
                return "key"

        with tempfile.TemporaryDirectory() as raw:
            host = NativeProviderHost(Path(raw), project_host=_Project(), credential_prompt=Waiting())
            try:
                opened = host.handle("provider.configureCredential", {"providerId": "openai", "storageMode": "memoryOnly"})
                self.assertIs(opened["waiting"], True)
                self.assertFalse(opened["configured"])
                self.assertIn(host.handle("provider.getStatus", {"providerId": "openai"})["credentialStatus"], {"absent", "unavailable"})
                with self.assertRaises(HostOperationError) as second:
                    host.handle("provider.configureCredential", {"providerId": "fal", "storageMode": "memoryOnly"})
                self.assertEqual(second.exception.code, "locking")
                answered.set()
                self.assertEqual(_key_window_outcome(host)["providerId"], "openai")
                self.assertEqual(host.handle("provider.getStatus", {"providerId": "openai"})["credentialStatus"], "memoryOnly")
                host.handle("provider.configureCredential", {"providerId": "fal", "storageMode": "memoryOnly"})
                self.assertEqual(_key_window_outcome(host)["providerId"], "fal")
            finally:
                answered.set()
                host.shutdown()

    def test_the_key_window_opens_on_the_frames_ui_thread(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            host = NativeProviderHost(Path(raw), project_host=_Project(), credential_prompt=_Prompt("key"))
            ran = []
            host.set_ui_invoker(lambda callback: ran.append("ui") or callback())
            try:
                host.handle("provider.configureCredential", {"providerId": "openai", "storageMode": "memoryOnly"})
                _key_window_outcome(host)
                self.assertEqual(ran, ["ui"])
            finally:
                host.shutdown()

    def test_closing_the_key_window_saves_nothing_and_complains_of_nothing(self) -> None:
        class Closed:
            def prompt(self, _label: str) -> None:
                return None

        with tempfile.TemporaryDirectory() as raw:
            host = NativeProviderHost(Path(raw), project_host=_Project(), credential_prompt=Closed())
            try:
                host.handle("provider.configureCredential", {"providerId": "openai", "storageMode": "memoryOnly"})
                outcome = _key_window_outcome(host)
                self.assertEqual(outcome["operation"], "key.cancelled")
                self.assertEqual(outcome["status"], "unconfigured")
                self.assertNotIn("message", outcome)
                self.assertIn(host.handle("provider.getStatus", {"providerId": "openai"})["credentialStatus"], {"absent", "unavailable"})
            finally:
                host.shutdown()

    def test_a_key_that_cannot_be_kept_says_so_without_the_key(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            host = NativeProviderHost(Path(raw), project_host=_Project(), credential_prompt=_Prompt("super-secret"))
            try:
                with mock.patch("Auvra.desktop.provider_host.MemoryCredentialStore.write", side_effect=OSError("vault broke: super-secret")):
                    host.handle("provider.configureCredential", {"providerId": "openai", "storageMode": "memoryOnly"})
                    outcome = _key_window_outcome(host)
                self.assertEqual(outcome["operation"], "key.failed")
                self.assertEqual(outcome["message"], "The key could not be saved on this computer.")
                self.assertNotIn("super-secret", str(outcome))
            finally:
                host.shutdown()

    def test_when_the_key_window_cannot_open_it_says_so(self) -> None:
        class Broken:
            def prompt(self, _label: str) -> None:
                raise CredentialPromptUnavailableError("no window")

        with tempfile.TemporaryDirectory() as raw:
            host = NativeProviderHost(Path(raw), project_host=_Project(), credential_prompt=Broken())
            try:
                host.handle("provider.configureCredential", {"providerId": "openai", "storageMode": "memoryOnly"})
                outcome = _key_window_outcome(host)
                self.assertEqual(outcome["operation"], "key.failed")
                self.assertEqual(outcome["message"], "The key window could not open on this computer.")
            finally:
                host.shutdown()

    def test_local_route_submission_is_async_and_does_not_change_project_revision(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            project = _Project()
            host = NativeProviderHost(Path(raw), project_host=project, adapters={"ollama": _Adapter()})
            try:
                host.registry.discover_models("ollama", ("local-model",))
                host.handle("provider.configure", {"providerId": "ollama", "expectedSettingsRevision": 0, "settings": {
                    "enabled": True, "routes": [{"capability": "text", "modelId": "local-model"}],
                    "fallbackPolicy": "none", "requireCostConfirmation": False,
                    "budgets": {"perJobMicroUsd": 0, "dailyMicroUsd": 0, "monthlyMicroUsd": 0}}})
                submitted = host.handle("inference.submit", {"projectId": "project-1", "expectedRevision": 0,
                    "providerId": "ollama", "modelId": "local-model", "capability": "text", "route": "local",
                    "input": "private prompt"})
                job_id = submitted["job"]["jobId"]
                for _ in range(50):
                    current = host.handle("inference.get", {"projectId": "project-1", "jobId": job_id})
                    if current["job"]["status"] == "succeeded":
                        break
                    time.sleep(0.01)
                self.assertEqual(current["job"]["outputText"], "safe normalized output")
                self.assertEqual(project.service.active.revision, 0)
                self.assertTrue(any(event[0] == "provider.progress" for event in host.drain_events()))
            finally:
                host.shutdown()

    def test_local_cloud_route_mismatch_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            host = NativeProviderHost(Path(raw), project_host=_Project())
            try:
                with self.assertRaises(Exception):
                    host.handle("inference.submit", {"projectId": "project-1", "expectedRevision": 0,
                        "providerId": "ollama", "modelId": "llama3.2", "capability": "text", "route": "cloud"})
            finally:
                host.shutdown()

    def test_undo_rejects_intervening_project_revision(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            project = _Project()
            project.service.active.revision = 2
            host = NativeProviderHost(Path(raw), project_host=project)
            try:
                host._last_transaction = {
                    "projectId": "project-1", "revision": 1,
                    "hud": {"schemaVersion": 1, "documents": []},
                    "transactionId": "transaction-test",
                }
                with self.assertRaises(HostOperationError) as raised:
                    host._undo_command({
                        "projectId": "project-1", "expectedRevision": 2,
                        "transactionId": "transaction-test",
                    })
                self.assertEqual(raised.exception.code, "revision_conflict")
            finally:
                host.shutdown()

    def test_command_worker_binds_provider_output_to_selected_target(self) -> None:
        class CaptureAdapter:
            def __init__(self) -> None:
                self.target = None

            def complete(self, **kwargs):
                self.target = kwargs.get("target_element_id")
                return TextResult("ollama", kwargs["model"], "done")

        with tempfile.TemporaryDirectory() as raw:
            adapter = CaptureAdapter()
            host = NativeProviderHost(Path(raw), project_host=_Project(), adapters={"ollama": adapter})
            try:
                job = host.jobs.create(
                    project_id="project-1", provider="ollama", model="gpt-test",
                    capability=Capability.COMMANDS.value, prompt_hash="a" * 64,
                )
                host._meta[job.job_id] = {
                    "projectId": "project-1", "prompt": "update target", "assetIds": [],
                    "route": "local", "providerId": "ollama", "modelId": "gpt-test",
                    "capability": Capability.COMMANDS.value, "settingsHash": "a" * 64,
                    "createdAt": 0, "promptHash": "a" * 64, "estimatedCostMicroUsd": 0,
                    "projectRevision": 0, "targetElementId": "element-1",
                    "targetElementName": "Target",
                }
                host._run_job(job.job_id, "ollama", "gpt-test", Capability.COMMANDS)
                self.assertEqual(adapter.target, "Target")
                self.assertEqual(host.jobs.get(job.job_id).state.value, "succeeded")
            finally:
                host.shutdown()

    def test_model_discovery_instantiates_adapter_without_prior_health_call(self) -> None:
        class DiscoveryAdapter:
            def list_models(self):
                return ("fresh-local-model",)

        with tempfile.TemporaryDirectory() as raw:
            host = NativeProviderHost(Path(raw), project_host=_Project())
            try:
                with mock.patch.object(host, "_adapter", return_value=DiscoveryAdapter()) as make_adapter:
                    result = host._list_models({"providerId": "ollama"})
                make_adapter.assert_called_once_with("ollama")
                self.assertEqual([item["modelId"] for item in result["models"]], ["fresh-local-model"])
            finally:
                host.shutdown()

    def test_a_long_model_list_comes_a_page_at_a_time(self) -> None:
        class ManyModels:
            def list_models(self):
                return tuple(f"model-{index:03}" for index in range(450))

        with tempfile.TemporaryDirectory() as raw:
            host = NativeProviderHost(Path(raw), project_host=_Project(), adapters={"openrouter": ManyModels()})
            try:
                seen, cursor = [], ""
                for _ in range(5):
                    page = host._list_models({"providerId": "openrouter", **({"cursor": cursor} if cursor else {})})
                    seen.extend(item["modelId"] for item in page["models"])
                    self.assertLessEqual(len(page["models"]), 256)
                    if not page["hasMore"]:
                        break
                    cursor = page["cursor"]
                self.assertEqual(len(seen), 450)
                self.assertEqual(len(set(seen)), 450)
                with self.assertRaises(HostOperationError):
                    host._list_models({"providerId": "openrouter", "cursor": "-1"})
            finally:
                host.shutdown()

    def test_a_model_is_described_with_its_price_and_prices_arrive_behind_the_list(self) -> None:
        from Auvra.providers.fal_catalog import CatalogModel

        class Catalog:
            prices_stale = True

            def __init__(self) -> None:
                self.refreshes = 0

            def refresh_prices(self, _stop) -> bool:
                self.refreshes += 1
                self.prices_stale = False
                return True

        class Priced:
            catalog = Catalog()

            def list_models(self):
                return ("a/b",)

            def model_details(self, _model):
                return CatalogModel("a/b", "A B", frozenset({Capability.MEDIA_EDIT}), "image-to-image", "Paints.", 3000, "megapixels")

        with tempfile.TemporaryDirectory() as raw:
            host = NativeProviderHost(Path(raw), project_host=_Project(), adapters={"fal": Priced()})
            try:
                host.registry.discover_models("fal", ["a/b"], {"a/b": {Capability.MEDIA_EDIT}})
                model = host._list_models({"providerId": "fal"})["models"][0]
                self.assertEqual(model, {"modelId": "a/b", "displayName": "A B", "capabilities": ["media.edit"], "category": "image-to-image",
                                         "description": "Paints.", "priceMicroUsd": 3000, "priceUnit": "megapixels"})
                host._price_refresh.join(5)
                self.assertEqual(Priced.catalog.refreshes, 1)
                self.assertIn(("provider.status", {"providerId": "fal", "status": "ready"}), host.drain_events())
                host._list_models({"providerId": "fal"})
                self.assertEqual(Priced.catalog.refreshes, 1)
            finally:
                host.shutdown()

    def test_paid_cloud_providers_are_unavailable_and_cannot_be_enabled(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            host = NativeProviderHost(Path(raw), project_host=_Project())
            try:
                providers = host._provider_list({})["providers"]
                self.assertTrue(any(p["providerId"] == "ollama" and p["available"] for p in providers))
                for provider in providers:
                    if provider["providerId"] in {"ollama", "llama.cpp", "reframe"}:
                        continue
                    with self.subTest(provider=provider["providerId"]):
                        self.assertFalse(provider["available"])
                        self.assertEqual(provider["capabilities"], [])
                        status = host._provider_status({"providerId": provider["providerId"]})
                        self.assertFalse(status["available"])
                        self.assertFalse(status["settings"]["enabled"])
                        self.assertEqual(status["settings"]["routes"], [])
                        self.assertEqual(host._list_models({"providerId": provider["providerId"]})["models"], [])
                        self.assertFalse(host._health({"providerId": provider["providerId"]})["healthy"])
                        with self.assertRaises(HostOperationError) as blocked:
                            host._configure({"providerId": provider["providerId"],
                                             "expectedSettingsRevision": status["settingsRevision"],
                                             "settings": {
                                                 "enabled": True, "routes": [],
                                                 "fallbackPolicy": "none", "requireCostConfirmation": False,
                                                 "budgets": {"perJobMicroUsd": 0, "dailyMicroUsd": 0,
                                                             "monthlyMicroUsd": 0},
                                             }})
                        self.assertEqual(blocked.exception.code, "endpoint_denied")
            finally:
                host.shutdown()

    def test_paid_cloud_requests_never_dispatch_even_with_legacy_settings(self) -> None:
        class Spy:
            def __init__(self):
                self.calls = []

            def complete(self, **kwargs):
                self.calls.append(("complete", kwargs))
                raise AssertionError("paid cloud execution must never run")

            def submit(self, **kwargs):
                self.calls.append(("submit", kwargs))
                raise AssertionError("paid cloud execution must never run")

            def model_details(self, model):
                self.calls.append(("price", model))
                return None

        with tempfile.TemporaryDirectory() as raw:
            spies = {p: Spy() for p in ("fal", "openai", "anthropic", "xai", "openrouter")}
            host = NativeProviderHost(Path(raw), project_host=_Project(), adapters=spies)
            try:
                for provider_id, adapter in spies.items():
                    capability = Capability.MEDIA_GENERATE if provider_id == "fal" else Capability.TEXT
                    model = "fal-ai/flux/dev" if provider_id == "fal" else "legacy-model"
                    host.registry.discover_models(provider_id, [model])
                    # Simulate a saved route from an older version with budgets and consent.
                    host.settings.set(provider_id, enabled=True, routes={capability: model},
                                      max_job_cost_micro_usd=1_000_000,
                                      max_daily_cost_micro_usd=1_000_000,
                                      max_monthly_cost_micro_usd=1_000_000)
                    for hint in (None, 0, 1, 40_000, 1_000_000):
                        with self.subTest(provider=provider_id, hint=hint):
                            with self.assertRaises(HostOperationError) as blocked:
                                host._submit({
                                    "projectId": "project-1", "expectedRevision": 0,
                                    "providerId": provider_id, "modelId": model,
                                    "capability": capability.value, "route": "cloud",
                                    "input": "test", "estimatedCostMicroUsd": hint,
                                    "consent": "explicit",
                                })
                            self.assertEqual(blocked.exception.code, "endpoint_denied")
                    old = host.jobs.create(project_id="project-1", provider=provider_id,
                                           model=model, capability=capability.value,
                                           prompt_hash="a" * 64)
                    host.jobs.transition(old.job_id, "submitting")
                    host.jobs.transition(old.job_id, "failed")
                    with self.assertRaises(HostOperationError) as blocked:
                        host._retry({"projectId": "project-1", "expectedRevision": 0,
                                     "jobId": old.job_id})
                    self.assertEqual(blocked.exception.code, "endpoint_denied")
                    self.assertEqual(host.jobs.get(old.job_id).state.value, "failed")
                    self.assertEqual(host.jobs.cost_totals(provider_id)["aggregate"], 0)
                    self.assertEqual(adapter.calls, [])
                self.assertEqual(len(host.jobs.list(project_id="project-1")), len(spies))
            finally:
                host.shutdown()

    def test_legacy_queued_paid_job_fails_terminally_without_network(self) -> None:
        class Spy:
            def __init__(self):
                self.calls = []

            def complete(self, **kwargs):
                self.calls.append(kwargs)
                raise AssertionError("cloud provider called")

        with tempfile.TemporaryDirectory() as raw:
            adapter = Spy()
            host = NativeProviderHost(Path(raw), project_host=_Project(), adapters={"openai": adapter})
            try:
                job = host.jobs.create(project_id="project-1", provider="openai",
                                       model="legacy-model", capability=Capability.TEXT.value,
                                       prompt_hash="a" * 64)
                host._run_job(job.job_id, "openai", "legacy-model", Capability.TEXT)
                self.assertEqual(adapter.calls, [])
                self.assertEqual(host.jobs.get(job.job_id).state.value, "failed")
                self.assertEqual(host.jobs.get(job.job_id).cost_micro_usd, 0)
            finally:
                host.shutdown()

    def test_legacy_cloud_configuration_cannot_block_local_route_selection(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            host = NativeProviderHost(Path(raw), project_host=_Project())
            try:
                host.registry.discover_models("openai", ("old-cloud-model",))
                host.registry.discover_models("ollama", ("local-model",))
                host.settings.set("openai", enabled=True, routes={Capability.TEXT: "old-cloud-model"})
                result = host._configure({
                    "providerId": "ollama", "expectedSettingsRevision": 0,
                    "settings": {"enabled": True, "routes": [{"capability": "text", "modelId": "local-model"}],
                                 "fallbackPolicy": "none", "requireCostConfirmation": False,
                                 "budgets": {"perJobMicroUsd": 0, "dailyMicroUsd": 0,
                                             "monthlyMicroUsd": 0}},
                })
                self.assertTrue(result["settings"]["enabled"])
                self.assertEqual(result["settings"]["routes"],
                                 [{"capability": "text", "modelId": "local-model"}])
            finally:
                host.shutdown()

    def test_a_queued_job_is_waited_for_as_long_as_a_real_queue_takes(self) -> None:
        waits = []
        for wait in NativeProviderHost._poll_waits():
            waits.append(wait)
        self.assertLess(waits[0], 0.1)
        self.assertLessEqual(max(waits), 2.0)
        self.assertGreaterEqual(sum(waits), 10 * 60)

    def test_what_a_provider_said_went_wrong_reaches_the_job(self) -> None:
        from Auvra.providers import ProviderError

        class Failing:
            def complete(self, **_kwargs):
                raise ProviderError("authorization", "Exhausted balance", "ollama", False, 403)

        class Generic:
            def complete(self, **_kwargs):
                raise ProviderError("authorization", "provider request failed", "ollama", False, 403)

        for adapter, expected in ((Failing(), "Exhausted balance"), (Generic(), "provider_authorization")):
            with tempfile.TemporaryDirectory() as raw:
                host = NativeProviderHost(Path(raw), project_host=_Project(), adapters={"ollama": adapter})
                try:
                    job = host.jobs.create(project_id="project-1", provider="ollama", model="gpt-test", capability=Capability.TEXT.value, prompt_hash="a" * 64)
                    host._meta[job.job_id] = {"projectId": "project-1", "prompt": "x", "assetIds": [], "route": "local", "providerId": "ollama", "modelId": "gpt-test", "capability": "text"}
                    host._run_job(job.job_id, "ollama", "gpt-test", Capability.TEXT)
                    self.assertEqual(host._job_value(job.job_id)["message"], expected)
                finally:
                    host.shutdown()

    def test_an_approved_hud_change_lands_on_a_real_project_with_no_hud_yet_and_undoes(self) -> None:
        from Auvra.providers.commands import validate_command

        element = {"name": "score", "type": "Text", "props": {"text": "0"}, "position": {"x": 0, "y": 0}, "size": {"width": 9, "height": 9}, "zIndex": 0, "isVisible": True, "isLocked": False}
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            service = ProjectService(index=ProjectIndex(root / "projects.sqlite3"))
            service.create(root / "Project", "Project")
            host = NativeProviderHost(root / "state", project_host=SimpleNamespace(service=service))
            active = service.active
            try:
                job = host.jobs.create(project_id=active.project_id, provider="openai", model="gpt-test", capability=Capability.COMMANDS.value, prompt_hash="a" * 64)
                proposal = validate_command({"commands": [{"op": "create", "element": element}]}, proposal_id="proposal-1", base_revision=active.revision)
                host._meta[job.job_id] = {"projectId": active.project_id, "projectRevision": active.revision, "proposal": proposal, "proposalId": "proposal-1",
                                          "providerId": "openai", "modelId": "gpt-test", "promptHash": "a" * 64}
                approved = host._approve_command({"projectId": active.project_id, "expectedRevision": active.revision, "proposalId": "proposal-1"})
                main = next(item for item in active.get_domain("hud")["documents"] if item["id"] == "hud-main")
                self.assertEqual([item["name"] for item in main["elements"]], ["score"])
                self.assertEqual(main["commands"][0]["jobId"], job.job_id)
                host._undo_command({"projectId": active.project_id, "expectedRevision": approved["projectRevision"], "transactionId": approved["transactionId"]})
                self.assertEqual(active.get_domain("hud")["documents"], [])
            finally:
                host.shutdown()
                service.shutdown()

    def test_shutdown_does_not_wait_for_a_running_provider_future(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            host = NativeProviderHost(Path(raw), project_host=_Project())
            stuck = mock.Mock()
            stuck.cancel.return_value = False
            stuck.done.return_value = False
            stuck.result.side_effect = TimeoutError("provider call is still blocked")
            host._futures["job-stuck"] = stuck
            with mock.patch.object(host._executor, "shutdown") as stop_executor:
                started = time.monotonic()
                host.shutdown()
                elapsed = time.monotonic() - started
            self.assertLess(elapsed, 1.0)
            stop_executor.assert_called_once_with(wait=False, cancel_futures=True)
            deadline = time.monotonic() + 1.0
            while not host._stores_closed and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(host._stores_closed)

    def test_media_commit_records_only_the_sources_the_project_still_has(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            service = ProjectService(index=ProjectIndex(root / "projects.sqlite3"))
            service.create(root / "project", "Media")
            previews = PreviewStore(root / "previews")
            host = NativeProviderHost(root / "provider", project_host=SimpleNamespace(service=service), preview_store=previews)
            try:
                project_id = service.active.project_id
                job_id = "job-media-f039-00002"
                payload = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x02\x00\x00\x00\x03\x08\x06\x00\x00\x00"
                preview = previews.ingest(job_id, io.BytesIO(payload), project_id=project_id)
                host.jobs.create(project_id=project_id, provider="fal", model="gpt-test", capability=Capability.MEDIA_EDIT.value, prompt_hash="a" * 64, job_id=job_id)
                for state in (JobState.SUBMITTING, JobState.RUNNING, JobState.SUCCEEDED):
                    host.jobs.transition(job_id, state, project_id=project_id)
                source = service.active.assets.put_stream(io.BytesIO(b"source"), mime="application/octet-stream")
                host._meta[job_id] = {"route": "cloud", "createdAt": 0, "assetIds": [source.asset_id, "b" * 64]}
                host._commit_media({
                    "projectId": project_id, "expectedRevision": 0, "jobId": job_id, "previewAssetId": preview.asset_id,
                    "textureId": "texture-one", "name": "Generated",
                })
                generation = service.active.get_domain("textures")["documents"][0]["generation"]
                self.assertEqual(generation["inputAssetIds"], [source.asset_id])
            finally:
                host.shutdown()
                previews.close()
                service.shutdown()

    def test_media_commit_keeps_the_picture_as_finished_and_can_again_after_the_preview_has_gone(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            service = ProjectService(index=ProjectIndex(root / "projects.sqlite3"))
            service.create(root / "project", "Media")
            previews = PreviewStore(root / "previews")
            host = NativeProviderHost(root / "provider", project_host=SimpleNamespace(service=service), preview_store=previews)
            try:
                project_id = service.active.project_id
                job_id = "job-media-f039-00003"
                picture = lambda width, height: b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + width.to_bytes(4, "big") + height.to_bytes(4, "big") + b"\x08\x06\x00\x00\x00"
                preview = previews.ingest(job_id, io.BytesIO(picture(2, 3)), project_id=project_id)
                host.jobs.create(project_id=project_id, provider="fal", model="gpt-test", capability=Capability.MEDIA_EDIT.value, prompt_hash="a" * 64, job_id=job_id)
                for state in (JobState.SUBMITTING, JobState.RUNNING, JobState.SUCCEEDED):
                    host.jobs.transition(job_id, state, project_id=project_id)
                host._meta[job_id] = {"route": "cloud", "createdAt": 0, "assetIds": []}
                revision = lambda: service.active.revision
                for width in (40, 50):
                    finished = service.active.assets.put_stream(io.BytesIO(picture(width, 60)), mime="image/png").asset_id
                    host._commit_media({
                        "projectId": project_id, "expectedRevision": revision(), "jobId": job_id, "previewAssetId": preview.asset_id,
                        "finishedAssetId": finished, "textureId": finished, "name": f"Finished {width}",
                    })
                    kept = next(item for item in service.active.get_domain("textures")["documents"] if item["id"] == finished)
                    self.assertEqual(kept["assetId"], finished)
                    self.assertEqual(kept["generation"]["artifactSha256"], finished)
                    self.assertEqual(kept["dimensions"], {"width": width, "height": 60})
                self.assertFalse(service.active.assets.verify(preview.asset_id))
                with self.assertRaises(HostOperationError) as gone:
                    host._commit_media({
                        "projectId": project_id, "expectedRevision": revision(), "jobId": job_id, "previewAssetId": preview.asset_id,
                        "finishedAssetId": "c" * 64, "textureId": "texture-gone", "name": "Gone",
                    })
                self.assertEqual(gone.exception.code, "invalid_job")
            finally:
                host.shutdown()
                previews.close()
                service.shutdown()

    def test_media_commit_onto_a_material_makes_a_painted_copy_the_model_owns(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            service = ProjectService(index=ProjectIndex(root / "projects.sqlite3"))
            service.create(root / "project", "Media")
            previews = PreviewStore(root / "previews")
            host = NativeProviderHost(root / "provider", project_host=SimpleNamespace(service=service), preview_store=previews)
            try:
                project_id = service.active.project_id
                job_id = "job-media-f039-00004"
                picture = lambda width, height: b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + width.to_bytes(4, "big") + height.to_bytes(4, "big") + b"\x08\x06\x00\x00\x00"
                preview = previews.ingest(job_id, io.BytesIO(picture(2, 3)), project_id=project_id)
                host.jobs.create(project_id=project_id, provider="fal", model="gpt-test", capability=Capability.MEDIA_EDIT.value, prompt_hash="a" * 64, job_id=job_id)
                for state in (JobState.SUBMITTING, JobState.RUNNING, JobState.SUCCEEDED):
                    host.jobs.transition(job_id, state, project_id=project_id)
                host._meta[job_id] = {"route": "cloud", "createdAt": 0, "assetIds": []}
                older = service.active.assets.put_stream(io.BytesIO(picture(4, 4)), mime="image/png").asset_id
                model_asset = service.active.assets.put_stream(io.BytesIO(b"model"), mime="application/octet-stream").asset_id
                service.apply_changes({
                    "textures": [{"id": "older", "name": "Older", "assetId": older, "dimensions": {"width": 4, "height": 4}}],
                    "models": [{
                        "id": "robot", "name": "Robot.fbx", "assetId": model_asset,
                        # A picture put on the old way, which the commit lets go of for the material it paints.
                        "textureOverrides": {"Body": "older", "Visor": "older"},
                        "materialOverrides": {"Body": {"roughness": 0.4}},
                    }],
                }, project_id=project_id, expected_revision=service.active.revision)
                host._commit_media({
                    "projectId": project_id, "expectedRevision": service.active.revision, "jobId": job_id, "previewAssetId": preview.asset_id,
                    "textureId": "painted", "name": "Painted", "materialName": "Body", "targetModelId": "robot",
                })
                model = service.active.get_domain("models")["documents"][0]
                materials = service.active.get_domain("materials")["documents"]
                self.assertEqual(len(materials), 1)
                painted_copy = materials[0]
                self.assertEqual(model["materialOverrides"], {"Body": {"roughness": 0.4, "materialId": painted_copy["id"]}})
                self.assertEqual(painted_copy["owner"], {"modelId": "robot", "material": "Body"})
                self.assertEqual(painted_copy["pictures"], {"baseColor": "painted"})
                self.assertEqual(painted_copy["textureIds"], ["painted"])
                self.assertEqual(painted_copy["name"], "Painted Body")
                output = next(node for node in painted_copy["graph"]["nodes"] if node["type"] == "output")
                self.assertTrue(output["params"]["ownMaps"])
                self.assertEqual(model["textureOverrides"], {"Visor": "older"})
                # Painted again, the same copy shows the new picture.
                second_job = "job-media-f039-00005"
                second = previews.ingest(second_job, io.BytesIO(picture(3, 3)), project_id=project_id)
                host.jobs.create(project_id=project_id, provider="fal", model="gpt-test", capability=Capability.MEDIA_EDIT.value, prompt_hash="b" * 64, job_id=second_job)
                for state in (JobState.SUBMITTING, JobState.RUNNING, JobState.SUCCEEDED):
                    host.jobs.transition(second_job, state, project_id=project_id)
                host._meta[second_job] = {"route": "cloud", "createdAt": 0, "assetIds": []}
                host._commit_media({
                    "projectId": project_id, "expectedRevision": service.active.revision, "jobId": second_job, "previewAssetId": second.asset_id,
                    "textureId": "painted-again", "name": "Painted again", "materialName": "Body", "targetModelId": "robot",
                })
                materials = service.active.get_domain("materials")["documents"]
                self.assertEqual([(item["id"], item["pictures"]) for item in materials], [(painted_copy["id"], {"baseColor": "painted-again"})])
                self.assertEqual(service.active.get_domain("models")["documents"][0]["materialOverrides"], {"Body": {"roughness": 0.4, "materialId": painted_copy["id"]}})
            finally:
                host.shutdown()
                previews.close()
                service.shutdown()

    def test_media_commit_validates_before_ingest_rolls_back_and_tolerates_discard_failure(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            service = ProjectService(index=ProjectIndex(root / "projects.sqlite3"))
            service.create(root / "project", "Media")
            project_host = SimpleNamespace(service=service)
            previews = PreviewStore(root / "previews")
            host = NativeProviderHost(root / "provider", project_host=project_host, preview_store=previews)
            try:
                project_id = service.active.project_id
                job_id = "job-media-f039-00001"
                payload = (
                    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
                    b"\x00\x00\x00\x02\x00\x00\x00\x03\x08\x06\x00\x00\x00"
                )
                preview = previews.ingest(job_id, io.BytesIO(payload), project_id=project_id)
                host.jobs.create(
                    project_id=project_id,
                    provider="fal",
                    model="gpt-test",
                    capability=Capability.MEDIA_GENERATE.value,
                    prompt_hash="a" * 64,
                    job_id=job_id,
                )
                for state in (JobState.SUBMITTING, JobState.RUNNING, JobState.SUCCEEDED):
                    host.jobs.transition(job_id, state, project_id=project_id)
                host._meta[job_id] = {"route": "cloud", "createdAt": 0, "assetIds": []}
                base = {
                    "projectId": project_id,
                    "expectedRevision": 0,
                    "jobId": job_id,
                    "previewAssetId": preview.asset_id,
                    "textureId": "texture-one",
                    "name": "Generated",
                }

                with mock.patch.object(service, "begin_upload", wraps=service.begin_upload) as ingest:
                    with self.assertRaises(HostOperationError) as raised:
                        host._commit_media({
                            **base,
                            "materialName": "Albedo",
                            "targetModelId": "missing-model",
                        })
                self.assertEqual(raised.exception.code, "invalid_project")
                ingest.assert_not_called()
                self.assertFalse(service.active.assets.path_for(preview.asset_id).exists())

                with mock.patch.object(service, "apply_changes", side_effect=RuntimeError("apply failed")):
                    with self.assertRaises(RuntimeError):
                        host._commit_media(base)
                self.assertFalse(service.active.assets.path_for(preview.asset_id).exists())

                with mock.patch.object(previews, "discard", side_effect=RuntimeError("cleanup failed")):
                    result = host._commit_media(base)
                self.assertEqual(result["assetId"], preview.asset_id)
                self.assertEqual(service.active.revision, 1)
                self.assertEqual(
                    service.active.get_domain("textures")["documents"][0]["assetId"],
                    preview.asset_id,
                )
                self.assertEqual(previews.get(job_id, preview.asset_id, project_id=project_id), preview)
            finally:
                host.shutdown()
                previews.close()
                service.shutdown()
