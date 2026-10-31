from __future__ import annotations
import copy, json, unittest

from jsonschema import Draft202012Validator

from Auvra.providers.adapters import (
    COMMAND_TOOL_NAME, AnthropicAdapter, FalAdapter, LlamaCppAdapter, OllamaAdapter, OpenAIAdapter, OpenRouterAdapter, TextAdapter, XAIAdapter,
)
from Auvra.providers.commands import (
    COMMAND_JSON_SCHEMA, COMMAND_SCHEMA_PROVIDERS, HUD_TYPES, PROP_FIELDS, CommandProposal, CommandValidationError,
    provider_command_schema, strip_optional_nulls, validate_command, validate_provider_command,
)
from Auvra.providers.descriptors import ProviderRegistry
from Auvra.providers.errors import ProviderError
from Auvra.providers.transport import HttpResponse


ADAPTERS = {"openai": OpenAIAdapter, "xai": XAIAdapter, "anthropic": AnthropicAdapter, "openrouter": OpenRouterAdapter, "ollama": OllamaAdapter, "llama.cpp": LlamaCppAdapter, "fal": FalAdapter}
# Providers whose structured-output mode needs every property in required and additionalProperties false.
STRICT = frozenset({"openai", "openrouter", "fal"})
# Keywords the researched provider documentation marks unsupported (or leaves undocumented, treated as
# unsupported). Descriptions are kept everywhere: they guide the model and no provider rejects them.
_LLAMA_UNSUPPORTED = frozenset({"uniqueItems", "contains", "minContains", "maxContains", "not", "if", "then", "else", "dependentSchemas", "patternProperties", "$anchor", "multipleOf", "minProperties", "maxProperties", "nullable"})
_OPENAI_UNSUPPORTED = frozenset({"allOf", "oneOf", "not", "if", "then", "else", "dependentRequired", "dependentSchemas", "patternProperties", "propertyNames", "minProperties", "maxProperties", "unevaluatedProperties", "uniqueItems", "contains", "minContains", "maxContains", "prefixItems", "default", "dependencies", "definitions", "minLength", "maxLength", "const"})
_ANTHROPIC_UNSUPPORTED = frozenset({"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems", "uniqueItems", "prefixItems", "contains", "oneOf", "not", "if", "then", "else", "patternProperties", "propertyNames", "minProperties", "maxProperties", "dependentRequired", "pattern"})
UNSUPPORTED = {
    "openai": _OPENAI_UNSUPPORTED,
    "xai": frozenset({"not", "if", "then", "else", "minContains", "maxContains", "multipleOf", "uniqueItems", "contains", "propertyNames", "patternProperties", "dependentRequired", "dependentSchemas", "unevaluatedProperties", "unevaluatedItems"}),
    "anthropic": _ANTHROPIC_UNSUPPORTED,
    "openrouter": _OPENAI_UNSUPPORTED | _ANTHROPIC_UNSUPPORTED,
    "fal": _OPENAI_UNSUPPORTED | _ANTHROPIC_UNSUPPORTED,
    "ollama": _LLAMA_UNSUPPORTED,
    "llama.cpp": _LLAMA_UNSUPPORTED,
}
_RANGES = ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum")

CREATE = {"commands": [
    {"op": "create", "element": {"name": "score", "type": "Text", "props": {"text": "0", "color": "#fff", "fontSize": 24, "textAlign": "center", "bind": {"text": "vars.score"}},
                                 "position": {"x": 10, "y": 20}, "size": {"width": 200, "height": 40}, "zIndex": 2, "isVisible": True, "isLocked": False, "align": "top-left"}},
    {"op": "create", "element": {"name": "play", "type": "Button", "props": {"label": "Play", "labelKey": "menu.play", "action": "play", "variant": "primary"},
                                 "position": {"x": 0, "y": 0}, "size": {"width": 320, "height": 64}, "zIndex": 1, "isVisible": True, "isLocked": False}},
]}
UPDATE = {"commands": [
    {"op": "update", "name": "e", "delta": {"props": {"action": "save", "backgroundColor": "#000", "bind": {"label": "level.id"}}, "position": {"x": 1, "y": 2}, "isVisible": False}},
    {"op": "delete", "name": "e"},
]}
SAMPLES = ((CREATE, None), (UPDATE, "e"))


def _nodes(schema, path="#"):
    """Every subschema of `schema` with its JSON pointer; property names are never treated as keywords."""
    yield path, schema
    for key in ("anyOf", "oneOf", "allOf"):
        for index, branch in enumerate(schema.get(key, ())): yield from _nodes(branch, f"{path}/{key}/{index}")
    for key in ("properties", "$defs"):
        for name, item in schema.get(key, {}).items(): yield from _nodes(item, f"{path}/{key}/{name}")
    for key in ("items", "additionalProperties"):
        if isinstance(schema.get(key), dict): yield from _nodes(schema[key], f"{path}/{key}")


def _tag(prop):
    if "const" in prop: return prop["const"]
    if len(prop.get("enum", ())) == 1: return prop["enum"][0]
    return None


def _branch(value, branches):
    for branch in branches:
        if branch.get("type") == "null" or isinstance(value, dict) != (branch.get("type") == "object"): continue
        tags = {key: _tag(prop) for key, prop in branch.get("properties", {}).items() if _tag(prop) is not None}
        if all(value.get(key) == tag for key, tag in tags.items()): return branch
    raise AssertionError(f"no schema branch for {value!r}")


def _densify(value, schema):
    """`value` as a strict-mode model writes it: every property present, null where the sparse value has none."""
    if value is not None and "anyOf" in schema: schema = _branch(value, schema["anyOf"])
    if isinstance(value, list): return [_densify(item, schema["items"]) for item in value]
    if isinstance(value, dict) and "properties" in schema:
        return {key: _densify(value[key], prop) if key in value else None for key, prop in schema["properties"].items()}
    return value


def _elements(schema):
    """Element type -> props schema of a projected command schema."""
    create = _branch({"op": "create"}, schema["properties"]["commands"]["items"]["anyOf"])
    return {_tag(branch["properties"]["type"]): branch["properties"]["props"] for branch in create["properties"]["element"]["anyOf"]}


def _depth(schema, level=0):
    level += schema.get("type") in ("object", "array")
    children = [*schema.get("anyOf", ()), *schema.get("properties", {}).values(), *([schema["items"]] if isinstance(schema.get("items"), dict) else [])]
    return max([level, *(_depth(child, level) for child in children)])


class FakeTransport:
    def __init__(self, responses): self.responses, self.requests = list(responses), []
    def request(self, request):
        self.requests.append(request)
        return self.responses.pop(0)


class FakeCredentials:
    def read(self, target): return "test-secret"


class ProviderCommandSchemaTests(unittest.TestCase):
    def test_every_text_adapter_has_a_schema_and_others_are_refused(self):
        self.assertEqual({cls.provider_id for cls in TextAdapter.__subclasses__()}, set(COMMAND_SCHEMA_PROVIDERS))
        self.assertEqual(set(ADAPTERS), set(COMMAND_SCHEMA_PROVIDERS))
        for provider in ("comfyui", "", "OpenAI"):
            with self.subTest(provider=provider), self.assertRaises(ValueError): provider_command_schema(provider)

    def test_projection_is_deterministic_and_never_mutates_the_canonical_schema(self):
        canonical = json.dumps(COMMAND_JSON_SCHEMA, sort_keys=True)
        for provider in sorted(COMMAND_SCHEMA_PROVIDERS):
            with self.subTest(provider=provider):
                first, second = provider_command_schema(provider), provider_command_schema(provider)
                self.assertEqual(first, second)
                self.assertEqual(json.dumps(first), json.dumps(second))
                first["properties"].clear(); first["description"] = "changed"
                self.assertEqual(provider_command_schema(provider), second)
                Draft202012Validator.check_schema(second)
        self.assertEqual(json.dumps(COMMAND_JSON_SCHEMA, sort_keys=True), canonical)

    def test_projection_contains_no_keyword_the_provider_rejects(self):
        for provider in sorted(COMMAND_SCHEMA_PROVIDERS):
            schema = provider_command_schema(provider)
            for path, node in _nodes(schema):
                with self.subTest(provider=provider, path=path):
                    self.assertFalse(set(node) & UNSUPPORTED[provider])
                    # oneOf is emitted as anyOf and local references are inlined for every provider.
                    self.assertFalse({"oneOf", "$ref", "$defs"} & set(node))
                    if node.get("type") == "object": self.assertIs(node.get("additionalProperties"), False)
                    for key in ("anyOf", "enum"):
                        if key in node: self.assertTrue(node[key])
                    if "allOf" in node: self.assertEqual(len(node["allOf"]), 1)
                    if provider == "openrouter": self.assertNotIsInstance(node.get("type"), list)
                    if provider == "xai":
                        self.assertLessEqual(node.get("maxLength", 0), 2048); self.assertLessEqual(node.get("maxItems", 0), 256); self.assertLessEqual(node.get("maxProperties", 0), 64)
                    if provider in ("anthropic", "openrouter"):
                        self.assertIn(node.get("minItems", 0), (0, 1))
                        for item in node.get("enum", ()): self.assertIsInstance(item, (str, int, float, bool, type(None)))
                    if provider in ("ollama", "llama.cpp"):
                        if node.get("type") != "integer": self.assertFalse(set(node) & set(_RANGES))
                        if "pattern" in node:
                            self.assertFalse({"minLength", "maxLength"} & set(node))
                            self.assertTrue(node["pattern"].startswith("^") and node["pattern"].endswith("$"))

    def test_strict_projections_require_every_property_and_close_every_object(self):
        for provider in sorted(STRICT):
            schema = provider_command_schema(provider)
            self.assertEqual(schema["type"], "object"); self.assertNotIn("anyOf", schema)
            objects = [(path, node) for path, node in _nodes(schema) if node.get("type") == "object"]
            self.assertTrue(objects)
            for path, node in objects:
                with self.subTest(provider=provider, path=path):
                    self.assertEqual(node["required"], list(node["properties"]))
                    self.assertIs(node["additionalProperties"], False)
            self.assertLessEqual(_depth(schema), 10)
            self.assertLessEqual(sum(len(node["properties"]) for _, node in objects), 5000)
            self.assertLessEqual(sum(len(node.get("enum", ())) for _, node in _nodes(schema)), 1000)

    def test_projection_keeps_the_vocabulary_and_descriptions(self):
        action = COMMAND_JSON_SCHEMA["properties"]["commands"]["items"]["oneOf"][0]["properties"]["element"]["oneOf"][0]["properties"]["props"]["properties"]["action"]["description"]
        for provider in sorted(COMMAND_SCHEMA_PROVIDERS):
            with self.subTest(provider=provider):
                schema = provider_command_schema(provider)
                self.assertEqual(schema["description"], COMMAND_JSON_SCHEMA["description"])
                elements = _elements(schema)
                self.assertEqual(set(elements), set(HUD_TYPES))
                for kind, props in elements.items(): self.assertEqual(set(props["properties"]), set(PROP_FIELDS[kind]))
                descriptions = [node["description"] for _, node in _nodes(schema) if "description" in node]
                self.assertTrue(any(text.startswith(action) for text in descriptions))
        # A constraint the provider cannot enforce is restated for the model instead of silently lost.
        text_props = _elements(provider_command_schema("anthropic"))["Text"]
        self.assertIn("Constraints: length <= 2048", text_props["properties"]["text"]["description"])
        self.assertIn("Constraints: >= 0, <= 10000", text_props["properties"]["fontSize"]["description"])

    def test_sample_proposals_validate_against_every_projection(self):
        for sample, _target in SAMPLES:
            self.assertFalse(list(Draft202012Validator(COMMAND_JSON_SCHEMA).iter_errors(sample)))
            for provider in sorted(COMMAND_SCHEMA_PROVIDERS):
                with self.subTest(provider=provider, op=sample["commands"][0]["op"]):
                    schema = provider_command_schema(provider)
                    output = _densify(sample, schema) if provider in STRICT else sample
                    self.assertEqual([error.message for error in Draft202012Validator(schema).iter_errors(output)], [])
                    if provider in STRICT:
                        # The sparse form is not what a strict model emits.
                        self.assertTrue(list(Draft202012Validator(schema).iter_errors(sample)))

    def test_strict_output_with_nulls_validates_like_the_sparse_proposal(self):
        for sample, target in SAMPLES:
            expected = validate_command(sample, target_element_id=target)
            for provider in sorted(STRICT):
                with self.subTest(provider=provider, op=sample["commands"][0]["op"]):
                    dense = _densify(sample, provider_command_schema(provider))
                    self.assertIn(None, json.loads(json.dumps(dense)).values())
                    snapshot = copy.deepcopy(dense)
                    self.assertEqual(strip_optional_nulls(dense), sample)
                    self.assertEqual(dense, snapshot)
                    self.assertEqual(validate_provider_command(dense, target_element_id=target), expected)
                    with self.assertRaises(CommandValidationError): validate_command(dense, target_element_id=target)

    def test_nulls_in_required_or_unknown_fields_still_fail(self):
        dense = _densify(CREATE, provider_command_schema("openai"))
        def element(proposal): return proposal["commands"][0]["element"]
        mutations = (
            lambda p: p.__setitem__("commands", None),
            lambda p: p["commands"].__setitem__(0, None),
            lambda p: p["commands"][0].__setitem__("element", None),
            lambda p: element(p).__setitem__("name", None),
            lambda p: element(p).__setitem__("type", None),
            lambda p: element(p).__setitem__("props", None),
            lambda p: element(p).__setitem__("position", None),
            lambda p: element(p).__setitem__("zIndex", None),
            lambda p: element(p).__setitem__("isVisible", None),
            lambda p: element(p)["position"].__setitem__("x", None),
            lambda p: element(p)["size"].__setitem__("height", None),
            lambda p: element(p).__setitem__("label", None),  # not an element field
            lambda p: element(p)["props"].__setitem__("label", None),  # a Button prop on a Text element
            lambda p: element(p)["props"].__setitem__("code", None),
            lambda p: element(p)["props"]["bind"].__setitem__("label", None),  # not bindable on Text
            lambda p: element(p).__setitem__("type", "Custom"),
        )
        for index, mutate in enumerate(mutations):
            proposal = copy.deepcopy(dense); mutate(proposal)
            with self.subTest(mutation=index), self.assertRaises(CommandValidationError): validate_provider_command(proposal)
        update = _densify(UPDATE, provider_command_schema("openai"))
        for mutate in (lambda p: p["commands"][0].__setitem__("delta", None), lambda p: p["commands"][0].__setitem__("name", None),
                       lambda p: p["commands"][1].__setitem__("name", None), lambda p: p["commands"][0].__setitem__("op", None),
                       lambda p: p["commands"][0].__setitem__("delta", dict.fromkeys(p["commands"][0]["delta"]))):
            proposal = copy.deepcopy(update); mutate(proposal)
            with self.subTest(update=proposal["commands"]), self.assertRaises(CommandValidationError): validate_provider_command(proposal, target_element_id="e")

    def test_every_adapter_sends_its_projection_and_accepts_strict_output(self):
        for provider, cls in sorted(ADAPTERS.items()):
            for sample, target in SAMPLES:
                with self.subTest(provider=provider, op=sample["commands"][0]["op"]):
                    schema = provider_command_schema(provider)
                    text = json.dumps(_densify(sample, provider_command_schema("openai")))
                    body = {
                        "openai": {"output": [{"content": [{"type": "output_text", "text": text}]}]},
                        "xai": {"output": [{"content": [{"type": "output_text", "text": text}]}]},
                        "anthropic": {"content": [{"type": "tool_use", "id": "toolu_1", "name": COMMAND_TOOL_NAME, "input": json.loads(text)}], "stop_reason": "tool_use"},
                        "openrouter": {"choices": [{"message": {"content": text}}]},
                        "ollama": {"message": {"content": text}},
                        "llama.cpp": {"choices": [{"message": {"content": text}}]},
                        "fal": {"choices": [{"message": {"content": text}}]},
                    }[provider]
                    registry = ProviderRegistry(); model = provider + "-test"; registry.discover_models(provider, [model])
                    fake = FakeTransport([HttpResponse(200, {}, json.dumps(body).encode())])
                    result = cls(fake, credential_store=FakeCredentials(), registry=registry).complete(model=model, prompt="make", structured_command=True, target_element_id=target)
                    self.assertIsInstance(result, CommandProposal)
                    self.assertEqual(result, validate_command(sample, target_element_id=target))
                    request = json.loads(fake.requests[0].body)
                    if provider in ("openai", "xai"):
                        self.assertEqual(request["text"]["format"], {"type": "json_schema", "name": COMMAND_TOOL_NAME, "strict": True, "schema": schema})
                    elif provider == "anthropic":
                        self.assertEqual(request["tools"], [{"name": COMMAND_TOOL_NAME, "description": request["tools"][0]["description"], "input_schema": schema}])
                        # Forced tool_choice is rejected by the newest Claude models.
                        self.assertEqual(request["tool_choice"], {"type": "auto"})
                        self.assertIn(COMMAND_TOOL_NAME, request["system"])
                        self.assertNotIn("output_config", request)
                    elif provider == "ollama":
                        self.assertEqual(request["format"], schema)
                        self.assertNotIn("response_format", request)
                    else:
                        self.assertEqual(request["response_format"], {"type": "json_schema", "json_schema": {"name": COMMAND_TOOL_NAME, "strict": True, "schema": schema}})

    def test_plain_text_requests_carry_no_schema_and_foreign_tools_are_ignored(self):
        for provider, body in (("openai", {"output": [{"content": [{"type": "output_text", "text": "hi"}]}]}), ("anthropic", {"content": [{"type": "text", "text": "hi"}]}), ("ollama", {"message": {"content": "hi"}})):
            with self.subTest(provider=provider):
                registry = ProviderRegistry(); model = provider + "-test"; registry.discover_models(provider, [model])
                fake = FakeTransport([HttpResponse(200, {}, json.dumps(body).encode())])
                self.assertEqual(ADAPTERS[provider](fake, credential_store=FakeCredentials(), registry=registry).complete(model=model, prompt="hi").text, "hi")
                self.assertFalse({"text", "tools", "tool_choice", "format", "response_format", "output_config"} & set(json.loads(fake.requests[0].body)))
        registry = ProviderRegistry(); registry.discover_models("anthropic", ["anthropic-test"])
        foreign = {"content": [{"type": "tool_use", "id": "toolu_1", "name": "other_tool", "input": CREATE}]}
        with self.assertRaises(ProviderError):
            AnthropicAdapter(FakeTransport([HttpResponse(200, {}, json.dumps(foreign).encode())]), credential_store=FakeCredentials(), registry=registry).complete(model="anthropic-test", prompt="make", structured_command=True)

    def test_openrouter_claude_models_get_the_command_as_a_tool_call(self):
        sample, target = SAMPLES[0]
        arguments = json.dumps(_densify(sample, provider_command_schema("openai")))
        body = {"choices": [{"message": {"content": None, "tool_calls": [
            {"id": "call_1", "type": "function", "function": {"name": COMMAND_TOOL_NAME, "arguments": arguments}}]}}]}
        registry = ProviderRegistry(); model = "anthropic/claude-test"; registry.discover_models("openrouter", [model])
        fake = FakeTransport([HttpResponse(200, {}, json.dumps(body).encode())])
        result = ADAPTERS["openrouter"](fake, credential_store=FakeCredentials(), registry=registry).complete(
            model=model, prompt="make", system="Be brief.", structured_command=True, target_element_id=target)
        self.assertEqual(result, validate_command(sample, target_element_id=target))
        request = json.loads(fake.requests[0].body)
        self.assertNotIn("response_format", request)
        self.assertEqual(request["tool_choice"], "auto")
        self.assertEqual(request["tools"][0]["function"]["name"], COMMAND_TOOL_NAME)
        self.assertEqual(request["tools"][0]["function"]["parameters"], provider_command_schema("anthropic"))
        self.assertEqual(request["messages"][0]["role"], "system")
        self.assertTrue(request["messages"][0]["content"].startswith("Be brief."))
        self.assertIn(COMMAND_TOOL_NAME, request["messages"][0]["content"])

    def test_an_empty_strict_proposal_id_falls_back_to_the_host_id(self):
        sample, target = SAMPLES[0]
        dense = _densify(sample, provider_command_schema("openai"))
        dense["proposal_id"] = ""
        self.assertEqual(validate_provider_command(dense, target_element_id=target), validate_command(sample, target_element_id=target))


if __name__ == "__main__":
    unittest.main()
