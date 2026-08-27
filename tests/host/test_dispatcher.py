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
