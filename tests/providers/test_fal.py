"""fal.ai: its catalog, the requests it is sent and the answers it gives."""

from __future__ import annotations

import io
import json
import tempfile
import threading
import unittest
from pathlib import Path

from Auvra.providers.adapters import FalAdapter, MediaJob
from Auvra.providers.commands import provider_command_schema
from Auvra.providers.descriptors import Capability, ProviderRegistry
from Auvra.providers.errors import ErrorCode, ProviderError
from Auvra.providers.fal_catalog import (
    FalCatalog, build_media_request, input_schema, media_output_url, parse_media_model, parse_router_model, rough_job_cost,
)
from Auvra.providers.transport import HttpResponse


class FakeCredentials:
    def read(self, _target):
        return "test-secret"


class CatalogTransport:
    """Answers each URL from a table by the first part of the URL that matches."""

    def __init__(self, routes):
        self.routes, self.requests = routes, []

    def request(self, request):
        self.requests.append(request)
        for part, answer in self.routes:
            if part in request.url:
                answer = answer(request) if callable(answer) else answer
                return answer if isinstance(answer, HttpResponse) else HttpResponse(200, {}, json.dumps(answer).encode())
        return HttpResponse(404, {}, b"{}")


def media_row(endpoint, category="image-to-image", status="active"):
    return {"endpoint_id": endpoint, "metadata": {"display_name": endpoint.upper(), "category": category, "status": status, "description": "A  model\nthat paints."}}


ROUTER_ROWS = [
    {"id": "acme/writer", "name": "Acme: Writer", "pricing": {"prompt": "0.0000001", "completion": "0.0000002"},
     "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]}, "supported_parameters": ["structured_outputs"]},
    {"id": "acme/plain", "name": "Acme: Plain", "pricing": {"prompt": "0", "completion": "0"}, "supported_parameters": []},
    {"id": "anthropic/claude-x", "name": "Claude", "pricing": {"prompt": "-1", "completion": "-1"}, "supported_parameters": ["tools"]},
    {"id": "acme/painter", "name": "Paints", "architecture": {"output_modalities": ["image"]}},
    {"id": "~acme/alias", "name": "An alias"},
]


def catalog_routes():
    return [
        ("category=image-to-image", {"models": [media_row("acme/edit"), media_row("acme/retired", status="deprecated")], "has_more": False}),
        ("category=text-to-image", {"models": [media_row("acme/paint", "text-to-image")], "has_more": False}),
        ("openrouter.ai", {"data": ROUTER_ROWS}),
    ]


class CatalogParsingTests(unittest.TestCase):
    def test_a_media_row_becomes_a_capability_by_its_category(self):
        self.assertEqual(parse_media_model(media_row("a/b")).capabilities, {Capability.MEDIA_EDIT})
        self.assertEqual(parse_media_model(media_row("a/b", "text-to-image")).capabilities, {Capability.MEDIA_GENERATE})
        self.assertEqual(parse_media_model(media_row("a/b")).description, "A model that paints.")

    def test_rows_that_are_not_active_image_models_are_left_out(self):
        for row in (media_row("a/b", "text-to-video"), media_row("a/b", status="deprecated"), media_row("../evil"), {"endpoint_id": "a/b"}, None):
            with self.subTest(row=row):
                self.assertIsNone(parse_media_model(row))

    def test_a_router_model_can_do_hud_commands_only_with_constrained_output(self):
        writer, plain, claude = (parse_router_model(row) for row in ROUTER_ROWS[:3])
        self.assertIn(Capability.COMMANDS, writer.capabilities)
        self.assertNotIn(Capability.COMMANDS, plain.capabilities)
        self.assertEqual(plain.capabilities, {Capability.TEXT, Capability.CODE})
        self.assertIn(Capability.COMMANDS, claude.capabilities)

    def test_a_router_price_is_per_million_tokens_and_a_nonsense_one_is_no_price(self):
        writer, claude = parse_router_model(ROUTER_ROWS[0]), parse_router_model(ROUTER_ROWS[2])
        self.assertEqual((writer.price_micro_usd, writer.output_price_micro_usd), (100_000, 200_000))
        self.assertIsNone(claude.price_micro_usd)

    def test_router_models_that_write_no_text_or_cannot_be_named_are_left_out(self):
        self.assertIsNone(parse_router_model(ROUTER_ROWS[3]))
        self.assertIsNone(parse_router_model(ROUTER_ROWS[4]))


class CatalogTests(unittest.TestCase):
    def catalog(self, routes=None, **options):
        fake = CatalogTransport(routes if routes is not None else catalog_routes())
        return FalCatalog(fake, key=lambda: "test-secret", sleep=lambda _seconds: None, **options), fake

    def test_lists_image_and_language_models_and_only_fal_sees_the_key(self):
        catalog, fake = self.catalog()
        self.assertEqual({model.model_id for model in catalog.models()}, {"acme/edit", "acme/paint", "acme/writer", "acme/plain", "anthropic/claude-x"})
        for request in fake.requests:
            if "openrouter.ai" in request.url:
                self.assertNotIn("Authorization", request.headers)
            else:
                self.assertEqual(request.headers["Authorization"], "Key test-secret")

    def test_follows_every_page(self):
        pages = {"": {"models": [media_row("acme/one")], "has_more": True, "next_cursor": "two"}, "two": {"models": [media_row("acme/two")], "has_more": False}}
        catalog, _fake = self.catalog([
            ("category=image-to-image", lambda request: pages["two" if "cursor=two" in request.url else ""]),
            ("category=text-to-image", {"models": []}), ("openrouter.ai", {"data": []}),
        ])
        self.assertEqual({model.model_id for model in catalog.models()}, {"acme/one", "acme/two"})

    def test_keeps_the_image_models_when_the_language_list_is_out(self):
        routes = [route for route in catalog_routes() if route[0] != "openrouter.ai"] + [("openrouter.ai", HttpResponse(503, {}, b""))]
        catalog, _fake = self.catalog(routes)
        self.assertEqual({model.model_id for model in catalog.models()}, {"acme/edit", "acme/paint"})

    def test_offline_it_keeps_what_it_knew_without_failing(self):
        catalog, _fake = self.catalog([("", HttpResponse(503, {}, b""))])
        self.assertEqual(catalog.models(), ())

    def test_keeps_the_list_and_prices_in_its_file_for_the_next_start(self):
        with tempfile.TemporaryDirectory() as raw:
            path = Path(raw) / "catalog.json"
            routes = catalog_routes() + [("/pricing", {"prices": [{"endpoint_id": "acme/edit", "unit_price": 0.003, "unit": "megapixels", "currency": "USD"}]})]
            routes.insert(0, routes.pop())
            catalog, _fake = self.catalog(routes, cache_path=path)
            catalog.models()
            self.assertTrue(catalog.refresh_prices())
            again, fake = self.catalog([], cache_path=path)
            self.assertEqual(again.get("acme/edit").price_micro_usd, 3000)
            self.assertEqual(again.get("acme/edit").price_unit, "megapixels")
            self.assertEqual(len(again.models()), 5)
            self.assertEqual(fake.requests, [])
            self.assertFalse(again.prices_stale)
            path.write_text("not json", encoding="utf-8")
            self.assertEqual(self.catalog([], cache_path=path)[0].get("acme/edit"), None)

    def test_a_refreshed_list_does_not_lose_the_prices(self):
        moments = [0.0]
        routes = catalog_routes()
        routes.insert(0, ("/pricing", {"prices": [{"endpoint_id": "acme/edit", "unit_price": 0.01, "unit": "images"}]}))
        catalog, _fake = self.catalog(routes, now=lambda: moments[0])
        catalog.models()
        catalog.refresh_prices()
        moments[0] = 2 * 24 * 60 * 60.0
        catalog.models()
        self.assertEqual(catalog.get("acme/edit").price_micro_usd, 10_000)
        self.assertTrue(catalog.prices_stale)

    def test_waits_out_a_rate_limit_and_stops_when_told(self):
        answers = [HttpResponse(429, {"retry-after": "1"}, b""), HttpResponse(429, {}, b""), {"prices": []}]
        slept = []
        fake = CatalogTransport(catalog_routes())
        fake.routes.insert(0, ("/pricing", lambda _request: answers.pop(0)))
        catalog = FalCatalog(fake, key=lambda: None, sleep=slept.append)
        catalog.models()
        self.assertTrue(catalog.refresh_prices())
        self.assertEqual(slept[:2], [1.0, 4.0])
        stop = threading.Event()
        stop.set()
        self.assertFalse(catalog.refresh_prices(stop))

    def test_gives_up_on_prices_without_failing_the_list(self):
        routes = [("/pricing", HttpResponse(500, {}, b""))] + catalog_routes()
        catalog, _fake = self.catalog(routes)
        catalog.models()
        self.assertFalse(catalog.refresh_prices())
        self.assertIsNone(catalog.get("acme/edit").price_micro_usd)

    def test_reads_what_a_model_takes_once(self):
        document = {"paths": {"/acme/edit": {"post": {"requestBody": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/In"}}}}}}},
                    "components": {"schemas": {"In": {"required": ["prompt"], "properties": {"prompt": {"type": "string"}, "size": {"$ref": "#/components/schemas/Size"}}}, "Size": {"type": "object"}}}}
        catalog, fake = self.catalog([("expand=openapi", {"models": [{"endpoint_id": "acme/edit", "openapi": document}]})])
        schema = catalog.request_schema("acme/edit")
        self.assertEqual(schema["required"], ["prompt"])
        self.assertEqual(schema["properties"]["size"], {"type": "object"})
        catalog.request_schema("acme/edit")
        self.assertEqual(len(fake.requests), 1)
        self.assertIsNone(self.catalog([("", HttpResponse(404, {}, b""))])[0].request_schema("acme/edit"))

    def test_an_alias_is_read_under_the_name_it_documents_itself_by(self):
        body = {"requestBody": {"content": {"application/json": {"schema": {"properties": {"image_urls": {"type": "array"}}}}}}}
        document = {"paths": {"/fal-ai/real/edit": {"post": body}, "/fal-ai/real/edit/requests/{request_id}": {"get": {}}}}
        self.assertIn("image_urls", input_schema(document, "acme/alias")["properties"])


SCHEMA_ONE = {"properties": {"prompt": {"type": "string"}, "image_url": {"type": "string"}, "num_images": {"type": "integer"},
                             "image_size": {"anyOf": [{"$ref": "#/components/schemas/ImageSize"}, {"enum": ["square_hd", "portrait_4_3"]}]},
                             "output_format": {"enum": ["jpeg", "png"]}}, "required": ["prompt", "image_url"]}


class MediaRequestTests(unittest.TestCase):
    def build(self, schema, prompt="rust", images=("https://v3.fal.media/a.png",), size=None):
        return build_media_request(schema, model="acme/edit", prompt=prompt, images=list(images), size=size)

    def test_without_a_schema_it_sends_a_prompt_and_the_first_image(self):
        self.assertEqual(self.build(None), {"prompt": "rust", "image_url": "https://v3.fal.media/a.png"})

    def test_asks_for_one_picture_the_size_of_the_source(self):
        self.assertEqual(self.build(SCHEMA_ONE, size=(512, 256)), {
            "prompt": "rust", "image_url": "https://v3.fal.media/a.png", "num_images": 1,
            "image_size": {"width": 512, "height": 256}, "output_format": "png"})

    def test_a_new_picture_is_square(self):
        self.assertEqual(self.build(SCHEMA_ONE | {"required": ["prompt"]}, images=())["image_size"], "square_hd")
        schema = {"properties": {"prompt": {}, "aspect_ratio": {"enum": ["16:9", "1:1"]}}, "required": ["prompt"]}
        self.assertEqual(self.build(schema, images=())["aspect_ratio"], "1:1")

    def test_a_list_of_images_gets_a_list(self):
        schema = {"properties": {"prompt": {}, "image_urls": {"type": "array"}}, "required": ["prompt", "image_urls"]}
        self.assertEqual(self.build(schema)["image_urls"], ["https://v3.fal.media/a.png"])
        schema = {"properties": {"image_urls": {"anyOf": [{"type": "array"}, {"type": "null"}]}}, "required": []}
        self.assertEqual(self.build(schema)["image_urls"], ["https://v3.fal.media/a.png"])

    def test_a_model_without_a_prompt_is_not_sent_one(self):
        self.assertEqual(self.build({"properties": {"image_url": {}}, "required": ["image_url"]}), {"image_url": "https://v3.fal.media/a.png"})

    def test_a_model_that_takes_more_than_there_is_says_what(self):
        with self.assertRaises(ProviderError) as caught:
            self.build({"properties": {"prompt": {}, "image_url": {}, "mask_url": {}}, "required": ["prompt", "image_url", "mask_url"]})
        self.assertIn("mask_url", caught.exception.message)
        with self.assertRaises(ProviderError):
            self.build({"properties": {"prompt": {}}, "required": ["prompt"]})

    def test_finds_the_picture_in_any_shape_of_answer(self):
        self.assertEqual(media_output_url({"images": [{"url": "u", "width": 4, "height": 2, "content_type": "image/png"}]}), ("u", "image/png", {"width": 4, "height": 2}))
        self.assertEqual(media_output_url({"image": {"url": "u"}})[0], "u")
        self.assertEqual(media_output_url({"url": "u"})[0], "u")
        self.assertIsNone(media_output_url({"images": []}))

    def test_weighs_a_job_in_each_unit(self):
        catalog = {"images": 40_000, "megapixels": 31_500, "compute seconds": 320_000}
        for unit, expected in catalog.items():
            base = 40_000 if unit == "images" else (30_000 if unit == "megapixels" else 40_000)
            model = parse_media_model(media_row("a/b"))
            self.assertEqual(rough_job_cost(model.__class__(**{**{name: getattr(model, name) for name in model.__slots__}, "price_micro_usd": base, "price_unit": unit})), expected)
        self.assertIsNone(rough_job_cost(None))
        self.assertIsNone(rough_job_cost(parse_router_model(ROUTER_ROWS[0])))


class FalAdapterTests(unittest.TestCase):
    def adapter(self, routes):
        fake = CatalogTransport(routes)
        return FalAdapter(fake, credential_store=FakeCredentials(), registry=ProviderRegistry()), fake

    def test_any_listed_model_can_be_used_for_what_it_does_and_nothing_else(self):
        routes = catalog_routes() + [("queue.fal.run/acme/edit", {"request_id": "r1"})]
        adapter, _fake = self.adapter(routes)
        adapter.list_models()
        self.assertEqual(adapter.submit(model="acme/edit", payload={"prompt": "x"}, capability=Capability.MEDIA_EDIT).request_id, "r1")
        with self.assertRaises(ProviderError):
            adapter.submit(model="acme/edit", payload={"prompt": "x"}, capability=Capability.MEDIA_GENERATE)
        with self.assertRaises(ProviderError):
            adapter.submit(model="acme/unlisted", payload={"prompt": "x"}, capability=Capability.MEDIA_EDIT)
        self.assertFalse(adapter.registry.supports("fal", Capability.COMMANDS, "acme/plain"))
        self.assertTrue(adapter.registry.supports("fal", Capability.CODE, "acme/plain"))

    def test_a_job_is_followed_where_fal_says(self):
        adapter, fake = self.adapter([
            ("queue.fal.run/fal-ai/flux/dev/image-to-image", {"request_id": "r1", "status_url": "https://queue.fal.run/fal-ai/other/requests/r1/status"}),
            ("/requests/r1/status", {"status": "COMPLETED"}),
        ])
        job = adapter.submit(model="fal-ai/flux/dev/image-to-image", payload={}, capability=Capability.MEDIA_EDIT)
        self.assertEqual(job.queue_root, "fal-ai/other")
        self.assertEqual(adapter.status_state(adapter.status(job)), "succeeded")
        self.assertEqual(fake.requests[-1].url, "https://queue.fal.run/fal-ai/other/requests/r1/status")

    def test_with_nothing_said_a_job_is_followed_under_its_app(self):
        adapter, fake = self.adapter([("/requests/r1/status", {"status": "IN_QUEUE"})])
        adapter.status(MediaJob("fal", "fal-ai/flux/dev/image-to-image", "r1"))
        self.assertEqual(fake.requests[-1].url, "https://queue.fal.run/fal-ai/flux/requests/r1/status")

    def test_an_untrusted_status_url_is_not_followed(self):
        for url in ("https://evil.example/fal-ai/x/requests/r1/status", "http://queue.fal.run/fal-ai/x/requests/r1/status",
                    "https://queue.fal.run/../x/requests/r1/status", "https://queue.fal.run/fal-ai/x/requests/other/status", 7):
            adapter, _fake = self.adapter([("queue.fal.run/fal-ai/flux/dev", {"request_id": "r1", "status_url": url})])
            with self.subTest(url=url):
                self.assertIsNone(adapter.submit(model="fal-ai/flux/dev", payload={}).queue_root)

    def test_a_tampered_queue_root_is_refused(self):
        adapter, _fake = self.adapter([])
        for root in ("../other", "a/../b", "single"):
            with self.subTest(root=root), self.assertRaises(ProviderError):
                adapter.status(MediaJob("fal", "fal-ai/flux/dev", "r1", root))

    def test_says_what_fal_said_went_wrong(self):
        for body, expected in ((b'{"detail":"Exhausted balance"}', "Exhausted balance"), (b'{"detail":[{"msg":"Field required"}]}', "Field required")):
            adapter, _fake = self.adapter([("queue.fal.run", HttpResponse(403, {}, body))])
            with self.subTest(expected=expected), self.assertRaises(ProviderError) as caught:
                adapter.submit(model="fal-ai/flux/dev", payload={})
            self.assertEqual(caught.exception.message, expected)
            self.assertEqual(caught.exception.code, ErrorCode.AUTHORIZATION)
        adapter, _fake = self.adapter([("queue.fal.run", HttpResponse(500, {}, b"<html>"))])
        with self.assertRaises(ProviderError) as caught:
            adapter.submit(model="fal-ai/flux/dev", payload={})
        self.assertEqual(caught.exception.message, "provider request failed")

    def test_language_models_go_through_the_router_with_the_key(self):
        answer = {"choices": [{"message": {"content": "code"}}], "usage": {"prompt_tokens": 3, "cost": 0.5}}
        adapter, fake = self.adapter(catalog_routes() + [("fal.run/openrouter/router/openai/v1/chat/completions", answer)])
        adapter.list_models()
        result = adapter.complete(model="acme/plain", prompt="write", capability=Capability.CODE)
        self.assertEqual(result.text, "code")
        self.assertEqual(result.usage, {"prompt_tokens": 3})
        request = fake.requests[-1]
        self.assertEqual(request.url, "https://fal.run/openrouter/router/openai/v1/chat/completions")
        self.assertEqual(request.headers["Authorization"], "Key test-secret")
        body = json.loads(request.body)
        self.assertEqual(body["model"], "acme/plain")
        self.assertEqual(body["provider"]["data_collection"], "deny")
        self.assertNotIn("response_format", body)
        self.assertGreaterEqual(request.timeout, 120.0)

    def test_hud_commands_go_with_the_schema_and_claude_as_a_tool(self):
        command = {"proposal_id": "", "base_revision": None, "commands": [{"op": "create", "element": {"name": "score", "type": "Text", "props": {"text": "0"}, "position": {"x": 0, "y": 0}, "size": {"width": 9, "height": 9}, "zIndex": 0, "isVisible": True, "isLocked": False, "align": None}}]}
        answer = {"choices": [{"message": {"content": json.dumps(command)}}]}
        adapter, fake = self.adapter(catalog_routes() + [("fal.run/openrouter", answer)])
        adapter.list_models()
        proposal = adapter.complete(model="acme/writer", prompt="add", structured_command=True)
        self.assertEqual(proposal.commands[0]["op"], "create")
        body = json.loads(fake.requests[-1].body)
        self.assertEqual(body["response_format"]["json_schema"]["schema"], provider_command_schema("fal"))
        with self.assertRaises(ProviderError):
            adapter.complete(model="acme/plain", prompt="add", structured_command=True)
        answer["choices"][0]["message"] = {"tool_calls": [{"function": {"name": "auvra_hud_commands", "arguments": json.dumps(command)}}]}
        adapter.complete(model="anthropic/claude-x", prompt="add", structured_command=True)
        self.assertIn("tools", json.loads(fake.requests[-1].body))

    def test_a_routed_model_survives_leaving_the_catalog(self):
        adapter, _fake = self.adapter([("", HttpResponse(503, {}, b""))])
        adapter.registry.discover_models("fal", {"acme/kept"})
        self.assertIn("acme/kept", adapter.list_models())
        self.assertIn("fal-ai/flux/dev", adapter.list_models())


class StreamSizeTests(unittest.TestCase):
    def test_reads_a_size_from_png_and_jpeg_and_leaves_the_stream_where_it_was(self):
        from Auvra.desktop.provider_host import _stream_image_size
        png = io.BytesIO(b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0dIHDR" + (640).to_bytes(4, "big") + (480).to_bytes(4, "big") + b"rest")
        self.assertEqual(_stream_image_size(png, "image/png"), (640, 480))
        self.assertEqual(png.tell(), 0)
        jpeg = io.BytesIO(b"\xff\xd8\xff\xe0\x00\x04ab\xff\xc0\x00\x11\x08" + (300).to_bytes(2, "big") + (500).to_bytes(2, "big") + b"\x03" + b"\x00" * 16)
        self.assertEqual(_stream_image_size(jpeg, "image/jpeg"), (500, 300))
        self.assertIsNone(_stream_image_size(io.BytesIO(b"not an image"), "image/png"))


if __name__ == "__main__":
    unittest.main()
