from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock

from Auvra.desktop.provider_host import NativeProviderHost
from Auvra.host.dispatcher import HostOperationError
from Auvra.providers import Capability
from Auvra.providers.adapters import TextResult


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
