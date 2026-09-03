from __future__ import annotations
import hashlib, io, json, sqlite3, tempfile, unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from Auvra.providers import *
from Auvra.providers.adapters import MediaJob, TextResult, _fal_cdn_url
from Auvra.providers.descriptors import ProviderFeature
import Auvra.providers.jobs as jobs_module


class FakeTransport:
    def __init__(self, responses): self.responses, self.requests = list(responses), []
    def request(self, request):
        self.requests.append(request)
        response = self.responses.pop(0)
        if isinstance(response, Exception): raise response
        return response


class StreamingTransport(FakeTransport):
    def __init__(self, responses, chunks):
        super().__init__(responses); self.chunks = list(chunks); self.stream_calls = []

    def stream(self, request, sink, *, max_bytes):
        self.stream_calls.append((request, max_bytes))
        for chunk in self.chunks:
            sink.write(chunk)
        return self.responses.pop(0)


class FakeCredentials:
    def __init__(self, value="test-secret"): self.value = value
    def read(self, target): return self.value


class ProviderCoreTests(unittest.TestCase):
    def test_registry_is_static_and_capability_features_are_separate(self):
        self.assertEqual(set(PROVIDER_REGISTRY), {"fal", "openai", "anthropic", "xai", "openrouter", "ollama", "llama.cpp"})
        self.assertIn(ProviderFeature.QUEUE, PROVIDER_REGISTRY["fal"].features)
        self.assertNotIn(ProviderFeature.QUEUE.value, {x.value for x in PROVIDER_REGISTRY["fal"].capabilities})

    def test_credential_memory_only_and_no_secret_repr(self):
        store = MemoryCredentialStore(); store.write("openai_api_key", "secret-value")
        self.assertEqual(store.read("openai_api_key"), "secret-value")
        self.assertNotIn("secret-value", repr(store))
        with self.assertRaises(CredentialError): store.write("x", "a" * 1300)

    def test_provider_errors_redact_sensitive_text_in_all_public_forms(self):
        error = ProviderError(ErrorCode.REMOTE, "request failed: api_key=super-secret")
        for rendered in (str(error), repr(error), json.dumps(error.as_dict())):
            self.assertNotIn("super-secret", rendered)

    def test_route_is_explicit_and_local_never_falls_back(self):
        policy = RoutePolicy()
        policy.registry.discover_models("ollama", ["llama3.2"])
        selected = policy.select(RouteRequest(Capability.TEXT, "ollama", "llama3.2"))
        self.assertEqual(selected.route.provider, "ollama")
        with self.assertRaises(ProviderError): policy.select(RouteRequest(Capability.TEXT, "ollama", "llama3.2", allow_cross_route_fallback=True))

    def test_bounded_transport_rejects_body_and_bad_origin(self):
        fake = FakeTransport([HttpResponse(200, {}, b"{}")])
        transport = BoundedTransport(fake, max_request_bytes=2, allowed_origins=("https://api.openai.com",))
        with self.assertRaises(ProviderError): transport.request(HttpRequest("POST", "https://evil.test", {}, b"{}"))
        with self.assertRaises(ProviderError): transport.request(HttpRequest("POST", "https://api.openai.com", {}, b"123"))

    def test_endpoint_policy_rejects_credentials_queries_and_ports(self):
        registry = ProviderRegistry(); registry.discover_models("openai", ["gpt-test"]); policy = RoutePolicy(registry)
        for endpoint in ("https://user:password@api.openai.com", "https://api.openai.com/?token=x", "https://api.openai.com:444"):
            with self.assertRaises(ProviderError):
                policy.select(RouteRequest(Capability.TEXT, "openai", "gpt-test", endpoint=endpoint))

        fake = FakeTransport([HttpResponse(200, {}, b"{}")])
        bounded = BoundedTransport(fake, allowed_origins=("https://api.openai.com",))
        with self.assertRaises(ProviderError):
            bounded.request(HttpRequest("GET", "https://user:secret@api.openai.com/v1/models"))

    def test_stream_parsers_are_bounded_and_incremental(self):
        self.assertEqual(list(parse_sse([b"event: progress\n", b"data: {\"n\":1}\n\n"]))[0].event, "progress")
        self.assertEqual(list(parse_ndjson([b'{"n":1}\n']))[0]["n"], 1)
        with self.assertRaises(ProviderError): list(parse_ndjson([b"x" * 20], max_line_bytes=2))
        with self.assertRaises(ProviderError): list(parse_sse([b"data: 1234\n", b"data: 5678\n\n"], max_event_bytes=8))

    def test_stream_and_upload_response_bounds_are_enforced(self):
        chunks = [b"123", b"456"]
        fake = StreamingTransport([HttpResponse(200, {}, b"")], chunks)
        bounded = BoundedTransport(fake, max_response_bytes=5, allowed_origins=("https://api.openai.com",))
        with self.assertRaises(ProviderError):
            bounded.stream(HttpRequest("GET", "https://api.openai.com/file"), io.BytesIO(), max_bytes=5)

        class UploadTransport(FakeTransport):
            def upload(self, request, source, *, size):
                return HttpResponse(200, {}, b"x" * 9)
        bounded = BoundedTransport(UploadTransport([]), max_response_bytes=8, allowed_origins=("https://api.openai.com",))
        with self.assertRaises(ProviderError):
            bounded.upload(HttpRequest("PUT", "https://api.openai.com/file"), io.BytesIO(b"x"), size=1)

    def test_openai_responses_and_no_raw_payload_exposed(self):
        response = HttpResponse(200, {}, json.dumps({"output": [{"content": [{"type": "output_text", "text": "hello"}]}]}).encode())
        fake = FakeTransport([response]); adapter = OpenAIAdapter(fake, credential_store=FakeCredentials()); adapter.registry.discover_models("openai", ["gpt-4o-mini"]); result = adapter.complete(model="gpt-4o-mini", prompt="hi")
        self.assertIsInstance(result, TextResult); self.assertEqual(result.text, "hello"); self.assertFalse(hasattr(result, "raw"))
        self.assertEqual(fake.requests[0].url, "https://api.openai.com/v1/responses")
        self.assertNotIn("private-output", repr(TextResult("openai", "m", "private-output")))

    def test_cloud_unknown_price_is_fail_closed_and_retry_is_bounded(self):
        registry = ProviderRegistry(); registry.discover_models("openai", ["gpt-test"])
        policy = RoutePolicy(registry, max_retries=2, budget=Budget(max_aggregate_cost=5))
        selection = policy.select(RouteRequest(Capability.TEXT, "openai", "gpt-test"))
        with self.assertRaises(ProviderError): policy.execute(selection, lambda route: object())
        attempts = []
        def fail(_route):
            attempts.append(1)
            raise ProviderError(ErrorCode.NETWORK, "temporary failure", retryable=True)
        with self.assertRaises(ProviderError): policy.execute(selection, fail, estimated_cost=5)
        self.assertEqual(len(attempts), 3)
        with self.assertRaises(ProviderError): policy.execute(selection, lambda route: object(), estimated_cost=1)

    def test_openrouter_provider_policy_is_fail_closed(self):
        response = HttpResponse(200, {}, b'{"choices":[{"message":{"content":"ok"}}]}')
        fake = FakeTransport([response]); adapter = OpenRouterAdapter(fake, credential_store=FakeCredentials()); adapter.registry.discover_models("openrouter", ["openai/gpt-4o-mini"]); adapter.complete(model="openai/gpt-4o-mini", prompt="hi")
        self.assertEqual(fake.requests[0].url, "https://openrouter.ai/api/v1/chat/completions")
        body = json.loads(fake.requests[0].body)
        self.assertEqual(body["provider"], {"allow_fallbacks": False, "require_parameters": True, "data_collection": "deny"})

    def test_provider_gets_have_no_object_body_and_local_origins_are_exact(self):
        fake = FakeTransport([HttpResponse(200, {}, b'{"models":[]}')])
        OpenRouterAdapter(fake, credential_store=FakeCredentials()).list_models()
        self.assertEqual(fake.requests[0].url, "https://openrouter.ai/api/v1/models")
        self.assertEqual(fake.requests[0].body, b"")
        bounded = BoundedTransport(FakeTransport([]), allowed_origins=("http://127.0.0.1:11434",))
        with self.assertRaises(ProviderError):
            bounded.request(HttpRequest("GET", "http://127.0.0.1:11434/api/tags", {}, b"{}"))
        with self.assertRaises(ProviderError):
            OllamaAdapter(FakeTransport([]), endpoint="http://127.0.0.1:11435")

    def test_structured_adapter_uses_trusted_target_binding(self):
        command = {"commands": [{"op": "update", "name": "target", "delta": {"isVisible": False}}]}
        response = HttpResponse(200, {}, json.dumps({"output": [{"content": [{"type": "output_text", "text": json.dumps(command)}]}]}).encode())
        registry = ProviderRegistry(); registry.discover_models("openai", ["gpt-test"])
        result = OpenAIAdapter(FakeTransport([response]), credential_store=FakeCredentials(), registry=registry).complete(
            model="gpt-test", prompt="update", structured_command=True, target_element_id="target")
        self.assertEqual(result.commands[0]["name"], "target")
        command["commands"][0]["name"] = "other"
        response = HttpResponse(200, {}, json.dumps({"output": [{"content": [{"type": "output_text", "text": json.dumps(command)}]}]}).encode())
        with self.assertRaises(ProviderError):
            OpenAIAdapter(FakeTransport([response]), credential_store=FakeCredentials(), registry=registry).complete(
                model="gpt-test", prompt="update", structured_command=True, target_element_id="target")

    def test_fal_key_auth_queue_and_cancel(self):
        fake = FakeTransport([HttpResponse(200, {}, b'{"request_id":"r1"}'), HttpResponse(202, {}, b'{}')])
        adapter = FalAdapter(fake, credential_store=FakeCredentials()); job = adapter.submit(model="fal-ai/flux/dev", payload={"prompt":"x"}); adapter.cancel(job)
        self.assertEqual(fake.requests[0].headers["Authorization"], "Key test-secret")
        self.assertEqual(fake.requests[0].url, "https://queue.fal.run/fal-ai/flux/dev")
        with self.assertRaises(ProviderError):
            adapter.submit(model="fal-ai/flux/dev", payload={}, capability=None)
        with self.assertRaises(ProviderError):
            adapter.submit(model="fal-ai/flux/dev", payload=None)

    def test_fal_upload_metadata_is_strict_and_bounded(self):
        adapter = FalAdapter(FakeTransport([]), credential_store=FakeCredentials())
        for filename in ("", ".", "..", "dir/file.png", "dir\\file.png", "bad\nname.png", "x" * 129, None):
            with self.subTest(filename=filename), self.assertRaises(ProviderError):
                adapter.upload_input(source=io.BytesIO(b"x"), size=1, filename=filename)
        for content_type in ("", "image", "image/", "/png", "image/png; charset=utf-8", "image/png\n", "x" * 128, None):
            with self.subTest(content_type=content_type), self.assertRaises(ProviderError):
                adapter.upload_input(source=io.BytesIO(b"x"), size=1, content_type=content_type)

    def test_fal_upload_uses_validated_metadata_without_truncation(self):
        class UploadTransport(FakeTransport):
            def upload(self, request, source, *, size):
                self.upload_request = request
                self.uploaded = source.read(size)
                return HttpResponse(200, {}, b"")

        fake = UploadTransport([HttpResponse(200, {}, json.dumps({
            "upload_url": "https://fal.media/uploads/put",
            "file_url": "https://v3.fal.media/files/input.png",
        }).encode())])
        adapter = FalAdapter(fake, credential_store=FakeCredentials())
        filename = "asset source.png"
        self.assertEqual(adapter.upload_input(source=io.BytesIO(b"x"), size=1, filename=filename, content_type="image/png"), "https://v3.fal.media/files/input.png")
        self.assertEqual(json.loads(fake.requests[0].body)["file_name"], filename)
        self.assertEqual(json.loads(fake.requests[0].body)["content_type"], "image/png")
        self.assertEqual(fake.upload_request.headers["Content-Type"], "image/png")
        self.assertEqual(fake.uploaded, b"x")

    def test_fal_job_paths_reject_untrusted_public_job_ids_and_urls(self):
        fake = FakeTransport([])
        adapter = FalAdapter(fake, credential_store=FakeCredentials())
        for request_id in ("../other", "id?secret=x", "id#fragment"):
            with self.assertRaises(ProviderError):
                adapter.status(MediaJob("fal", "fal-ai/flux/dev", request_id))
        with self.assertRaises(ProviderError):
            adapter.result(MediaJob("other", "fal-ai/flux/dev", "id"))

        for value in ("https://fal.media:444/file", "https://fal.media:bad/file", "https://user:pw@fal.media/file", "https://fal.media"):
            self.assertFalse(_fal_cdn_url(value))
        self.assertTrue(_fal_cdn_url("https://v3.fal.media/files/opaque/result.png?token=signature"))

    def test_media_redirect_is_exact_origin_and_never_follows_to_userinfo(self):
        for location in ("https://evil.test/result.png", "https://user:pw@fal.media/result.png", "https://fal.media:444/result.png"):
            fake = FakeTransport([HttpResponse(302, {"Location": location}, b"")])
            with self.assertRaises(ProviderError):
                MediaDownloader().download("https://fal.media/start.png", transport=fake, sink=io.BytesIO())

    def test_jobs_are_durable_redacted_and_idempotent(self):
        with tempfile.TemporaryDirectory() as folder:
            db = str(Path(folder) / "jobs.sqlite"); store = SQLiteJobStore(db)
            job = store.create(project_id="project-1", provider="fal", model="fal-ai/flux/dev", capability="media.generate", prompt_hash=hashlib.sha256(b"do not persist").hexdigest())
            self.assertEqual(job.project_id, "project-1")
            self.assertTrue(job.job_id.startswith("job-")); store.transition(job.job_id, JobState.SUBMITTING, remote_id="r1")
            store.transition(job.job_id, JobState.RUNNING); store.request_cancel(job.job_id); store.cancel(job.job_id); store.cancel(job.job_id)
            store.close(); reopened = SQLiteJobStore(db); loaded = reopened.get(job.job_id)
            self.assertEqual(loaded.state, JobState.CANCELLED); self.assertEqual(len(reopened.pending_reconciliation()), 0)
            self.assertNotIn("do not persist", Path(db).read_bytes().decode("latin1", "ignore"))
            reopened.close()

    def test_cancel_requested_remote_success_becomes_terminal_cancelled(self):
        store = SQLiteJobStore()
        try:
            job = store.create(
                project_id="project-1", provider="fal", model="fal-ai/flux/dev",
                capability="media.generate", prompt_hash="a" * 64,
            )
            store.transition(job.job_id, JobState.SUBMITTING, project_id="project-1")
            store.transition(job.job_id, JobState.RUNNING, project_id="project-1")
            store.request_cancel(job.job_id, project_id="project-1")
            reconciled = store.reconcile(job.job_id, remote_state="succeeded", project_id="project-1")
            self.assertEqual(reconciled.state, JobState.CANCELLED)
            self.assertNotIn(job.job_id, {item.job_id for item in store.pending_reconciliation()})
            self.assertEqual(store.events(job.job_id)[-1].state, JobState.CANCELLED)
        finally:
            store.close()

    def test_retry_cost_is_bucketed_by_reservation_time(self):
        old = datetime(2026, 1, 31, 23, 59, tzinfo=timezone.utc).timestamp()
        current = datetime(2026, 2, 1, 0, 1, tzinfo=timezone.utc).timestamp()
        store = SQLiteJobStore()
        try:
            with mock.patch.object(jobs_module.time, "time", return_value=old):
                job = store.create(
                    project_id="project-1", provider="fal", model="fal-ai/flux/dev",
                    capability="media.generate", prompt_hash="a" * 64,
                    cost_micro_usd=10,
                )
            with mock.patch.object(jobs_module.time, "time", return_value=current):
                store.add_cost(job.job_id, 5, project_id="project-1")
            self.assertEqual(
                store.cost_totals("fal", at=datetime(2026, 1, 31, 23, 59, tzinfo=timezone.utc)),
                {"aggregate": 15, "daily": 10, "monthly": 10},
            )
            self.assertEqual(
                store.cost_totals("fal", at=datetime(2026, 2, 1, 0, 1, tzinfo=timezone.utc)),
                {"aggregate": 15, "daily": 5, "monthly": 5},
            )
        finally:
            store.close()

    def test_jobs_are_project_scoped_and_sensitive_events_never_persist(self):
        store = SQLiteJobStore()
        job = store.create(project_id="project-a", provider="fal", model="fal-ai/flux/dev", capability="media.generate", prompt_hash="a" * 64)
        self.assertEqual(store.list(project_id="project-a")[0].job_id, job.job_id)
        self.assertEqual(store.list(project_id="project-b"), ())
        with self.assertRaises(KeyError): store.get(job.job_id, project_id="project-b")
        with self.assertRaises(KeyError): store.events(job.job_id, project_id="project-b")
        with self.assertRaises(ValueError): store.transition(job.job_id, JobState.SUBMITTING, project_id="project-a", message="token=never-persist")
        self.assertNotIn("never-persist", repr(store.events(job.job_id)))
        store.close()

    def test_old_ownerless_inflight_jobs_fail_closed_on_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            db = str(Path(folder) / "old.sqlite")
            raw = sqlite3.connect(db)
            raw.executescript("""
                CREATE TABLE jobs (job_id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
                  capability TEXT NOT NULL, state TEXT NOT NULL, prompt_hash TEXT NOT NULL,
                  artifact_hash TEXT, remote_id TEXT, attempts INTEGER NOT NULL, cost_micro_usd INTEGER NOT NULL,
                  reconcile_json TEXT NOT NULL, provenance_json TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL);
                CREATE TABLE job_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL,
                  state TEXT NOT NULL, message TEXT, at REAL NOT NULL);
            """)
            now = 1.0
            raw.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", ("job-old-1", "fal", "fal-ai/flux/dev", "media.generate", "running", "a" * 64, None, "remote", 0, 0, '{"durable":true}', "{}", now, now))
            raw.commit(); raw.close()
            store = SQLiteJobStore(db); recovered = store.reconcile_restart()
            self.assertEqual(recovered, ())
            self.assertEqual(store.get("job-old-1").state, JobState.FAILED)
            store.close()

    def test_durable_restart_moves_pending_jobs_to_recovering(self):
        with tempfile.TemporaryDirectory() as folder:
            db = str(Path(folder) / "jobs.sqlite"); store = SQLiteJobStore(db)
            job = store.create(project_id="project-1", provider="fal", model="fal-ai/flux/dev", capability="media.generate", prompt_hash=hashlib.sha256(b"x").hexdigest())
            store.transition(job.job_id, JobState.SUBMITTING, reconcile={"durable": True}); store.close()
            reopened = SQLiteJobStore(db); durable = reopened.reconcile_restart()
            self.assertEqual(durable[0].state, JobState.RECOVERING); reopened.close()

    def test_provider_settings_roundtrip_conflict_endpoint_and_budget(self):
        with tempfile.TemporaryDirectory() as folder:
            db = str(Path(folder) / "settings.sqlite"); registry = ProviderRegistry(); registry.discover_models("openai", ["gpt-test"]); store = ProviderSettingsStore(db, registry=registry)
            saved = store.set("openai", enabled=True, routes={Capability.TEXT: "gpt-test"}, max_job_cost_micro_usd=4)
            self.assertEqual(store.get("openai").routes["text"], "gpt-test")
            with self.assertRaises(ValueError): store.set("openai", enabled=True, routes={Capability.TEXT: "gpt-test"}, expected_revision=saved.revision - 1)
            with self.assertRaises(ValueError): store.set("openai", enabled=True, routes={Capability.TEXT: "gpt-test"}, endpoint="http://evil.test:80")
            with self.assertRaises(ValueError): store.set("openai", enabled=True, routes={Capability.TEXT: "gpt-test"}, max_daily_cost_micro_usd=-1)
            store.close()

    def test_all_text_adapters_parse_strict_commands_offline(self):
        command = {"commands":[{"op":"create", "element":{"name":"e", "type":"Text", "props":{"text":"ok"}, "position":{"x":0,"y":0}, "size":{"width":1,"height":1}, "zIndex":0, "isVisible":True, "isLocked":False}}]}
        responses = {
            "openai": {"output":[{"content":[{"type":"output_text","text":json.dumps(command)}]}]},
            "xai": {"output":[{"content":[{"type":"output_text","text":json.dumps(command)}]}]},
            "anthropic": {"content":[{"type":"text","text":json.dumps(command)}]},
            "openrouter": {"choices":[{"message":{"content":json.dumps(command)}}]},
            "ollama": {"message":{"content":json.dumps(command)}},
            "llama.cpp": {"choices":[{"message":{"content":json.dumps(command)}}]},
        }
        classes = {"openai":OpenAIAdapter, "xai":XAIAdapter, "anthropic":AnthropicAdapter, "openrouter":OpenRouterAdapter, "ollama":OllamaAdapter, "llama.cpp":LlamaCppAdapter}
        for provider, cls in classes.items():
            registry = ProviderRegistry(); model = provider + "-test"; registry.discover_models(provider, [model])
            fake = FakeTransport([HttpResponse(200, {}, json.dumps(responses[provider]).encode())]); result = cls(fake, credential_store=FakeCredentials(), registry=registry).complete(model=model, prompt="make", structured_command=True)
            self.assertIsInstance(result, CommandProposal)

    def test_media_preview_discard_commit_and_magic(self):
        store = MediaPreviewStore(); sink = io.BytesIO(); artifact = store.ingest(b"\x89PNG\r\n\x1a\nbody", sink=sink, content_type="image/png")
        self.assertFalse(store.preview(artifact).committed); self.assertTrue(store.commit(artifact).committed)
        self.assertTrue(store.discard(artifact)); self.assertTrue(store.discard(artifact))

    def test_media_downloader_streams_and_cleans_owned_sink_on_hash_failure(self):
        data = b"\x89PNG\r\n\x1a\nbody"; fake = FakeTransport([HttpResponse(200, {"Content-Type":"image/png"}, data)])
        downloader = MediaDownloader(); sink = io.BytesIO(); artifact = downloader.download("https://fal.media/a.png", transport=fake, sink=sink, expected_sha256=hashlib.sha256(data).hexdigest())
        self.assertEqual(artifact.size, len(data)); self.assertEqual(sink.getvalue(), data)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "x.png"; bad = FakeTransport([HttpResponse(200, {"Content-Type":"image/png"}, data)])
            with self.assertRaises(ProviderError): downloader.download("https://fal.media/a.png", transport=bad, sink=path, expected_sha256="0" * 64)
            self.assertFalse(path.exists())

    def test_hud_commands_reject_code_and_hash_deterministically(self):
        element = {"name":"label", "type":"Text", "props":{"text":"Hi"}, "position":{"x":0,"y":0}, "size":{"width":10,"height":10}, "zIndex":1, "isVisible":True, "isLocked":False}
        proposal = validate_command({"base_revision": 3, "commands": [{"op":"create", "element":element}]})
        self.assertEqual(proposal, validate_command({"base_revision": 3, "commands": [{"op":"create", "element":element}]}))
        with self.assertRaises(CommandValidationError): validate_command({"commands":[{"op":"create","element":{**element,"type":"Custom"}}]})

    def test_all_authored_hud_types_and_update_delete(self):
        base = {"name":"e", "props":{}, "position":{"x":0,"y":0}, "size":{"width":1,"height":1}, "zIndex":0, "isVisible":True, "isLocked":False}
        for kind in ("Container", "Text", "HealthBar", "Crosshair", "Scope"):
            self.assertEqual(validate_command({"commands":[{"op":"create", "element":{**base, "type":kind}}]}).commands[0]["element"]["type"], kind)
        self.assertEqual(validate_command({"commands":[{"op":"update","name":"e","delta":{"isVisible":False}}]}, target_element_id="e").commands[0]["op"], "update")
        self.assertEqual(validate_command({"commands":[{"op":"delete","name":"e"}]}, target_element_id="e").commands[0]["op"], "delete")
        for bad in ({"code":"x"}, {"nested":{"path":"x"}}):
            with self.assertRaises(CommandValidationError): validate_command({"commands":[{"op":"create", "element":{**base, "type":"Text", "props":bad}}]})
        with self.assertRaises(CommandValidationError): validate_command({"commands":[{"op":"update","name":"e","delta":{"isVisible":False}}]})
        with self.assertRaises(CommandValidationError): validate_command({"commands":[{"op":"delete","name":"other"}]}, target_element_id="e")


if __name__ == "__main__": unittest.main()
