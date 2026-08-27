import unittest
from Auvra.host.dispatcher import HostDispatcher
from Auvra.host.fake import FakeHost
from Auvra.host.session import SessionManager


class DispatcherTests(unittest.TestCase):
    def setUp(self): self.dispatcher = HostDispatcher(SessionManager("s1"))
    def request(self, **kwargs):
        value = {"protocol":"auvra.host/1","type":"request","id":"r1","session":"s1","revision":0,"method":"host.ping","payload":{}}
        value.update(kwargs); return value
    def test_success(self):
        response = self.dispatcher.dispatch(self.request())
        self.assertTrue(response["ok"]); self.assertEqual(response["result"], {"pong": True})
    def test_session_unknown_and_invalid(self):
        self.assertEqual(self.dispatcher.dispatch(self.request(session="other"))["error"]["code"], "session_mismatch")
        self.assertEqual(self.dispatcher.dispatch(self.request(method="host.nope"))["error"]["code"], "unknown_method")
        response = self.dispatcher.dispatch({"bad": object()})
        self.assertEqual(response["error"]["code"], "invalid_request")
        self.assertNotIn("traceback", str(response).lower())
    def test_malformed_id_and_revision_conflict_are_normalized(self):
        malformed = self.request(id={"secret": "do-not-leak"})
        response = self.dispatcher.dispatch(malformed)
        self.assertEqual(response["error"]["code"], "invalid_request")
        self.assertEqual(response["id"], "invalid")
        self.assertEqual(self.dispatcher.dispatch(self.request(revision=1))["error"]["code"], "revision_conflict")
    def test_fake_host_is_deterministic_and_validates_events(self):
        host = FakeHost()
        request = {"protocol":"auvra.host/1","type":"request","id":"r1","session":"fake-session-0001","revision":0,"method":"host.ping","payload":{}}
        self.assertEqual(host.request(request)["result"], {"pong": True})
        self.assertEqual(host.emit_revision()["revision"], 1)
        self.assertEqual(host.request(dict(request, revision=1))["revision"], 1)

    def test_engine_methods_and_capabilities_are_explicit(self):
        capabilities = self.dispatcher.dispatch(self.request(method="host.getCapabilities"))
        self.assertEqual(capabilities["result"]["engineMethods"], [
            "engine.getStatus", "engine.getSnapshot", "engine.applyChanges",
            "engine.openViewport", "engine.closeViewport", "engine.renderReference",
            "engine.getMetrics", "engine.recover",
        ])
        status = self.dispatcher.dispatch(self.request(method="engine.getStatus"))
        self.assertEqual(status["result"]["kind"], "engine.status")
        snapshot = self.dispatcher.dispatch(self.request(method="engine.getSnapshot"))
        self.assertEqual(snapshot["result"]["kind"], "engine.snapshot")
        applied = self.dispatcher.dispatch(self.request(
            method="engine.applyChanges",
            payload={"expectedRevision": 0, "entities": [{
                "id": "reference", "position": [0, 0, 0], "color": [0.2, 0.6, 1, 1],
            }]},
        ))
        self.assertTrue(applied["ok"])
        conflict = self.dispatcher.dispatch(self.request(
            id="engine-conflict", revision=applied["revision"], method="engine.applyChanges",
            payload={"expectedRevision": 0, "entities": []},
        ))
        self.assertEqual(conflict["error"]["code"], "revision_conflict")

    def test_bound_engine_service_survives_reload_and_drains_safe_events(self):
        class EngineService:
            def __init__(self):
                self.revision = 0
                self.entities = []
                self.events = []

            def handle(self, method, payload):
                base = {"kind": "engine.status", "protocol": "auvra.native/1",
                        "status": "ready", "worldRevision": self.revision,
                        "viewport": "closed", "backend": "Vulkan", "adapter": "test"}
                if method == "engine.getSnapshot":
                    return {**base, "kind": "engine.snapshot", "entities": list(self.entities)}
                if method == "engine.applyChanges":
                    if payload["expectedRevision"] != self.revision:
                        from Auvra.host.dispatcher import HostOperationError
                        raise HostOperationError("revision_conflict", "Native revision does not match", {
                            "expectedRevision": payload["expectedRevision"], "actualRevision": self.revision,
                        })
                    self.entities = list(payload["entities"]); self.revision += 1
                    self.events.append(("engine.revision", {"status": "ready", "worldRevision": self.revision, "viewport": "closed"}))
                    return {**base, "kind": "engine.applyChanges", "worldRevision": self.revision, "entities": list(self.entities)}
                return base

            def drain_events(self):
                events, self.events = self.events, []
                return events

        service = EngineService()
        dispatcher = HostDispatcher(SessionManager("s1"))
        dispatcher.bind_services(engine_service=service)
        first = dispatcher.dispatch(self.request(method="engine.applyChanges", payload={
            "expectedRevision": 0, "entities": [{"id": "cube", "position": [1, 2, 3], "color": [1, 0, 0, 1]}],
        }))
        self.assertTrue(first["ok"])
        reload_request = self.request(id="reload", revision=first["revision"], method="engine.getSnapshot")
        after_reload = dispatcher.dispatch(reload_request)
        self.assertEqual(after_reload["result"]["entities"][0]["id"], "cube")
        event = dispatcher.drain_bound_events()[0]
        self.assertEqual(event["event"], "engine.revision")
        self.assertEqual(event["payload"]["worldRevision"], 1)
        self.assertNotIn("token", str(event).lower())

    def test_project_workflow_is_bounded_and_revision_checked(self):
        create = self.request(method="project.create", payload={"name": "Demo"})
        created = self.dispatcher.dispatch(create)
        self.assertTrue(created["ok"])
        project_id = created["result"]["projectId"]
        host_revision = created["revision"]
        mutation = {"protocol": "auvra.host/1", "type": "request", "id": "change1",
                    "session": "s1", "revision": host_revision, "method": "project.applyChanges",
                    "payload": {"projectId": project_id, "expectedRevision": 0, "changes": [
                        {"domain": "levels", "documentId": "level-1", "operation": "upsert", "document": {"name": "Start"}}
                    ]}}
        changed = self.dispatcher.dispatch(mutation)
        self.assertTrue(changed["ok"])
        conflict = dict(mutation, id="change2", revision=changed["revision"], payload=dict(mutation["payload"], expectedRevision=0))
        self.assertEqual(self.dispatcher.dispatch(conflict)["error"]["code"], "revision_conflict")

    def test_bound_services_receive_protocol_method_without_paths(self):
        calls = []
        class Service:
            def handle(self, method, payload):
                calls.append((method, payload))
                return {"projectId": "service-project", "status": "open"}
        dispatcher = HostDispatcher(SessionManager("s1"))
        dispatcher.bind_services(project_service=Service())
        request = self.request(method="project.getStatus", payload={"projectId": "service-project"})
        self.assertTrue(dispatcher.dispatch(request)["ok"])
        self.assertEqual(calls, [("project.getStatus", {"projectId": "service-project"})])

    def test_bound_mutations_advance_host_revision_and_events_are_ordered(self):
        class Service:
            def __init__(self): self.events = [("project.revision", {"projectId": "service-project", "revision": 4, "status": "open"})]
            def handle(self, method, payload):
                return {"projectId": "service-project", "revision": 4, "status": "open"}
            def drain_events(self):
                events, self.events = self.events, []
                return events

        service = Service()
        dispatcher = HostDispatcher(SessionManager("s1"))
        dispatcher.bind_services(project_service=service)
        request = self.request(method="project.save", payload={
            "projectId": "service-project", "expectedRevision": 4,
        })
        response = dispatcher.dispatch(request)
        self.assertTrue(response["ok"])
        self.assertEqual(response["revision"], 1)
        event = dispatcher.drain_bound_events()[0]
        self.assertEqual(event["revision"], 2)
        self.assertEqual(event["payload"]["projectId"], "service-project")
        self.assertEqual(event["payload"]["status"], "open")
        self.assertEqual(dispatcher.drain_bound_events(), [])

    def test_fake_asset_ticket_is_bounded_single_use_and_addressed(self):
        host = FakeHost()
        request = {"protocol":"auvra.host/1","type":"request","id":"r1","session":host.session.session_id,"revision":0,"method":"project.create","payload":{"name":"Demo"}}
        created = host.request(request)
        project_id = created["result"]["projectId"]
        upload = {"protocol":"auvra.host/1","type":"request","id":"r2","session":host.session.session_id,"revision":created["revision"],"method":"asset.beginUpload","payload":{"projectId":project_id,"expectedRevision":0,"size":3,"mime":"application/octet-stream","name":"asset.bin"}}
        ticket = host.request(upload)
        uploaded = host.request_asset(method="PUT", url=ticket["result"]["url"], origin="https://assets.auvra.local", mime="application/octet-stream", body=b"abc")
        self.assertEqual(uploaded["status"], 204)
        with self.assertRaises(ValueError):
            host.request_asset(method="PUT", url=ticket["result"]["url"], origin="https://assets.auvra.local", mime="application/octet-stream", body=b"abc")
        resolve = {"protocol":"auvra.host/1","type":"request","id":"r3","session":host.session.session_id,"revision":ticket["revision"],"method":"asset.resolve","payload":{"projectId":project_id,"assetId":uploaded["sha256"]}}
        resolved = host.request(resolve)
        self.assertEqual(host.request_asset(method="GET", url=resolved["result"]["url"], origin="https://assets.auvra.local")["sha256"], uploaded["sha256"])

    def test_provider_methods_are_explicit_and_non_project_mutating(self):
        create = self.dispatcher.dispatch(self.request(method="project.create", payload={"name": "Demo"}))
        project_id = create["result"]["projectId"]
        host_revision = create["revision"]
        listed = self.dispatcher.dispatch(self.request(revision=host_revision, method="provider.list", payload={}))
        self.assertTrue(listed["ok"])
        self.assertEqual({item["providerId"] for item in listed["result"]["providers"]},
                         {"fal", "openai", "anthropic", "xai", "openrouter", "ollama", "llama.cpp"})
        configured = self.dispatcher.dispatch(self.request(revision=host_revision, method="provider.configureCredential",
            payload={"providerId": "ollama", "storageMode": "memoryOnly"}))
        self.assertEqual(configured["result"]["configured"], True)
        submitted = self.dispatcher.dispatch(self.request(revision=host_revision, method="inference.submit",
            payload={"projectId": project_id, "expectedRevision": 0, "providerId": "ollama",
                     "modelId": "llama3.1:8b", "capability": "text", "route": "local"}))
        self.assertEqual(submitted["result"]["job"]["outputText"], "deterministic fake response")
        self.assertEqual(submitted["result"]["job"]["status"], "succeeded")
        self.assertEqual(submitted["revision"], host_revision)

    def test_provider_settings_status_and_ownership_are_strict(self):
        create = self.dispatcher.dispatch(self.request(method="project.create", payload={"name": "Demo"}))
        project_id = create["result"]["projectId"]
        host_revision = create["revision"]
        status = self.dispatcher.dispatch(self.request(revision=host_revision,
            method="provider.getStatus", payload={"providerId": "ollama"}))
        self.assertTrue(status["ok"])
        self.assertEqual(status["result"]["credentialStatus"], "notRequired")
        settings = {"enabled": True, "routes": [{"capability": "text", "modelId": "llama3.1:8b"}],
                    "fallbackPolicy": "none", "requireCostConfirmation": True,
                    "budgets": {"perJobMicroUsd": 10, "dailyMicroUsd": 20, "monthlyMicroUsd": 30}}
        configured = self.dispatcher.dispatch(self.request(revision=host_revision,
            method="provider.configure", payload={"providerId": "ollama",
                "expectedSettingsRevision": 0, "settings": settings}))
        self.assertEqual(configured["result"]["settingsRevision"], 1)
        old_shape = self.dispatcher.dispatch(self.request(revision=host_revision,
            method="provider.configure", payload={"providerId": "ollama", "route": "local",
                "selectedModels": {"text": "llama3.1:8b"}, "budgets": {"perJob": 1, "daily": 1, "monthly": 1}}))
        self.assertEqual(old_shape["error"]["code"], "invalid_request")
        missing_owner = self.dispatcher.dispatch(self.request(revision=host_revision,
            method="inference.get", payload={"jobId": "job-00000001"}))
        self.assertEqual(missing_owner["error"]["code"], "invalid_request")
        self.assertEqual(project_id, "fake-project-0001")

    def test_command_preview_is_host_owned_and_commit_advances_project_once(self):
        create = self.dispatcher.dispatch(self.request(method="project.create", payload={"name": "Demo"}))
        project_id = create["result"]["projectId"]
        host_revision = create["revision"]
        configured = self.dispatcher.dispatch(self.request(revision=host_revision, method="provider.configureCredential",
            payload={"providerId": "openai", "storageMode": "memoryOnly"}))
        submitted = self.dispatcher.dispatch(self.request(revision=host_revision, method="inference.submit",
            payload={"projectId": project_id, "expectedRevision": 0, "providerId": "openai",
                     "modelId": "openai/gpt-test", "capability": "commands", "route": "cloud"}))
        job = submitted["result"]["job"]
        preview = self.dispatcher.dispatch(self.request(revision=host_revision, method="command.preview",
            payload={"projectId": project_id, "expectedRevision": 0, "jobId": job["jobId"]}))
        self.assertTrue(preview["ok"])
        approved = self.dispatcher.dispatch(self.request(revision=host_revision, method="command.approve",
            payload={"projectId": project_id, "expectedRevision": 0, "proposalId": preview["result"]["proposalId"]}))
        self.assertEqual(approved["result"]["projectRevision"], 1)
        self.assertEqual(approved["revision"], host_revision + 1)
