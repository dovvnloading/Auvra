from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import tempfile
import time
import unittest

from Auvra.desktop.provider_host import NativeProviderHost
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
