from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock
from types import SimpleNamespace

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


class _Adapter:
    def complete(self, *, model: str, prompt: str, capability="text", structured_command: bool = False):
        assert not structured_command
        return TextResult("openai", model, "safe normalized output")

    def health(self) -> bool:
        return True

    def list_models(self) -> tuple[str, ...]:
        return ("gpt-4o-mini",)


class ProviderHostTests(unittest.TestCase):
    def test_credential_prompt_and_status_never_persist_secret(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            host = NativeProviderHost(root, project_host=_Project(), credential_prompt=_Prompt("super-secret"))
            try:
                result = host.handle("provider.configureCredential", {"providerId": "openai", "storageMode": "memoryOnly"})
                self.assertEqual(result["configured"], True)
                self.assertNotIn("secret", str(result).lower())
                status = host.handle("provider.getStatus", {"providerId": "openai"})
                self.assertEqual(status["credentialStatus"], "memoryOnly")
            finally:
                host.shutdown()
            for path in root.rglob("*"):
                if path.is_file():
                    self.assertNotIn(b"super-secret", path.read_bytes())

    def test_exact_route_submission_is_async_and_does_not_change_project_revision(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            project = _Project()
            host = NativeProviderHost(Path(raw), project_host=project, credential_prompt=_Prompt("key"), adapters={"openai": _Adapter()})
            try:
                host.handle("provider.configureCredential", {"providerId": "openai", "storageMode": "memoryOnly"})
                host.registry.discover_models("openai", ("gpt-4o-mini",))
                host.handle("provider.configure", {"providerId": "openai", "expectedSettingsRevision": 0, "settings": {
                    "enabled": True, "routes": [{"capability": "text", "modelId": "gpt-4o-mini"}],
                    "fallbackPolicy": "none", "requireCostConfirmation": False,
                    "budgets": {"perJobMicroUsd": 0, "dailyMicroUsd": 0, "monthlyMicroUsd": 0}}})
                submitted = host.handle("inference.submit", {"projectId": "project-1", "expectedRevision": 0,
                    "providerId": "openai", "modelId": "gpt-4o-mini", "capability": "text", "route": "cloud",
                    "input": "private prompt", "consent": "explicit"})
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
                return TextResult("openai", kwargs["model"], "done")

        with tempfile.TemporaryDirectory() as raw:
            adapter = CaptureAdapter()
            host = NativeProviderHost(Path(raw), project_host=_Project(), adapters={"openai": adapter})
            try:
                job = host.jobs.create(
                    project_id="project-1", provider="openai", model="gpt-test",
                    capability=Capability.COMMANDS.value, prompt_hash="a" * 64,
                )
                host._meta[job.job_id] = {
                    "projectId": "project-1", "prompt": "update target", "assetIds": [],
                    "route": "cloud", "providerId": "openai", "modelId": "gpt-test",
                    "capability": Capability.COMMANDS.value, "settingsHash": "a" * 64,
                    "createdAt": 0, "promptHash": "a" * 64, "estimatedCostMicroUsd": 0,
                    "projectRevision": 0, "targetElementId": "element-1",
                    "targetElementName": "Target",
                }
                host._run_job(job.job_id, "openai", "gpt-test", Capability.COMMANDS)
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

    def test_a_job_with_budgets_set_is_held_to_them_by_the_catalog_price(self) -> None:
        from Auvra.providers.fal_catalog import CatalogModel

        class Priced:
            def model_details(self, _model):
                return CatalogModel("a/b", "A B", frozenset({Capability.MEDIA_EDIT}), "image-to-image", "", 40_000, "images")

        with tempfile.TemporaryDirectory() as raw:
            host = NativeProviderHost(Path(raw), project_host=_Project(), adapters={"fal": Priced()})
            try:
                unset = SimpleNamespace(max_job_cost_micro_usd=0, max_daily_cost_micro_usd=0, max_monthly_cost_micro_usd=0)
                self.assertIsNone(host._cost_estimate("fal", unset, {"modelId": "a/b"}))
                limits = SimpleNamespace(max_job_cost_micro_usd=10_000, max_daily_cost_micro_usd=100_000, max_monthly_cost_micro_usd=100_000)
                self.assertEqual(host._cost_estimate("fal", limits, {"modelId": "a/b"}), 40_000)
                self.assertEqual(host._cost_estimate("fal", limits, {"modelId": "a/b", "estimatedCostMicroUsd": 7}), 7)
                with self.assertRaises(HostOperationError) as raised:
                    host._check_budget("fal", limits, 40_000)
                self.assertEqual(raised.exception.code, "budget_exceeded")
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
                raise ProviderError("authorization", "Exhausted balance", "openai", False, 403)

        class Generic:
            def complete(self, **_kwargs):
                raise ProviderError("authorization", "provider request failed", "openai", False, 403)

        for adapter, expected in ((Failing(), "Exhausted balance"), (Generic(), "provider_authorization")):
            with tempfile.TemporaryDirectory() as raw:
                host = NativeProviderHost(Path(raw), project_host=_Project(), adapters={"openai": adapter})
                try:
                    job = host.jobs.create(project_id="project-1", provider="openai", model="gpt-test", capability=Capability.TEXT.value, prompt_hash="a" * 64)
                    host._meta[job.job_id] = {"projectId": "project-1", "prompt": "x", "assetIds": [], "route": "cloud", "providerId": "openai", "modelId": "gpt-test", "capability": "text"}
                    host._run_job(job.job_id, "openai", "gpt-test", Capability.TEXT)
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
