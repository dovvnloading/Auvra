import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";

const root = resolve(import.meta.dirname, "..", "..", "..");
const schema = JSON.parse(await readFile(resolve(root, "protocol", "v1", "auvra-host.schema.json"), "utf8"));
if (!schema.$defs?.request || !schema.$defs?.successResponse || !schema.$defs?.errorResponse) throw new Error("unsupported protocol schema");

// Gate record: `npx --yes quicktype@26.0.0 --src <schema> --src-lang schema
// --lang typescript|python` was run locally. It resolved refs, but emitted
// permissive conversion helpers rather than strict unknown-field rejection;
// cross-runtime invalid vectors therefore fail its gate. This stable,
// repository-owned fallback is used instead. Runtime validators remain Ajv and
// python-jsonschema, never generated types.
const ts = [
  "/** Generated convenience types for auvra.host/1. Runtime validation lives in protocol.ts. */",
  "export type Revision = number;", "export type ProtocolId = string;", "export type SessionId = string;",
  "export type Method = \"host.ping\" | \"host.getCapabilities\";",
  "export type ErrorCode = \"invalid_request\" | \"invalid_response\" | \"session_mismatch\" | \"unknown_method\" | \"revision_conflict\" | \"internal_error\";",
  "export interface Request { protocol: \"auvra.host/1\"; type: \"request\"; id: ProtocolId; session: SessionId; revision: Revision; method: Method; payload: Record<string, never>; }",
  "export interface PingResult { pong: true; }",
  "export interface CapabilitiesResult { protocol: \"auvra.host/1\"; methods: [\"host.ping\", \"host.getCapabilities\"]; }",
  "export type SuccessResult = PingResult | CapabilitiesResult;",
  "export interface SuccessResponse { protocol: \"auvra.host/1\"; type: \"response\"; id: ProtocolId; session: SessionId; revision: Revision; ok: true; result: SuccessResult; }",
  "export interface ErrorResponse { protocol: \"auvra.host/1\"; type: \"response\"; id: ProtocolId; session: SessionId; revision: Revision; ok: false; error: { code: ErrorCode; message: string; details?: Record<string, never> }; }",
  "export type Response = SuccessResponse | ErrorResponse;",
  "export interface Event { protocol: \"auvra.host/1\"; type: \"event\"; event: \"host.session\" | \"host.revision\"; session: SessionId; revision: Revision; payload: Record<string, never>; }",
  "export interface Session { protocol: \"auvra.host/1\"; type: \"session\"; session: SessionId; revision: Revision; status: \"created\" | \"active\" | \"closed\"; }",
  "export type Message = Request | Response | Event | Session;", "",
].join("\n");
const py = [
  '"""Generated convenience types for auvra.host/1."""',
  "from typing import Literal, NotRequired, TypedDict", "ProtocolId = str", "SessionId = str", "Revision = int",
  'Method = Literal["host.ping", "host.getCapabilities"]',
  'ErrorCode = Literal["invalid_request", "invalid_response", "session_mismatch", "unknown_method", "revision_conflict", "internal_error"]',
  "class Request(TypedDict):", '    protocol: Literal["auvra.host/1"]', '    type: Literal["request"]', "    id: ProtocolId", "    session: SessionId", "    revision: Revision", "    method: Method", "    payload: dict[str, object]",
  "class PingResult(TypedDict):", "    pong: Literal[True]",
  "class CapabilitiesResult(TypedDict):", '    protocol: Literal["auvra.host/1"]', "    methods: list[Method]",
  "SuccessResult = PingResult | CapabilitiesResult",
  "class SuccessResponse(TypedDict):", '    protocol: Literal["auvra.host/1"]', '    type: Literal["response"]', "    id: ProtocolId", "    session: SessionId", "    revision: Revision", "    ok: Literal[True]", "    result: PingResult | CapabilitiesResult",
  "class ErrorBody(TypedDict):", "    code: ErrorCode", "    message: str", "    details: NotRequired[dict[str, object]]",
  "class ErrorResponse(TypedDict):", '    protocol: Literal["auvra.host/1"]', '    type: Literal["response"]', "    id: ProtocolId", "    session: SessionId", "    revision: Revision", "    ok: Literal[False]", "    error: ErrorBody",
  "class Event(TypedDict):", '    protocol: Literal["auvra.host/1"]', '    type: Literal["event"]', '    event: Literal["host.session", "host.revision"]', "    session: SessionId", "    revision: Revision", "    payload: dict[str, object]",
  "class Session(TypedDict):", '    protocol: Literal["auvra.host/1"]', '    type: Literal["session"]', '    session: SessionId', "    revision: Revision", '    status: Literal["created", "active", "closed"]',
  "Message = Request | SuccessResponse | ErrorResponse | Event | Session", "",
].join("\n");
const ajv = new Ajv2020({
  allErrors: false,
  allowUnionTypes: false,
  strict: true,
  code: { source: true, esm: true },
});
function makeBrowserSafeStandalone(code) {
  const rewritten = code.replace(
    /const (func\d+) = require\("ajv\/dist\/runtime\/ucs2length"\)\.default;/g,
    (_match, name) => `const ${name} = (value) => Array.from(value).length;`,
  );
  if (/\brequire\s*\(|\b(?:eval|Function)\s*\(/.test(rewritten)) {
    throw new Error("Ajv emitted a browser-unsafe standalone validator dependency");
  }
  return rewritten;
}
const standaloneValidator = [
  "/** Generated from the canonical protocol schema. Do not edit. */",
  "// @ts-nocheck",
  makeBrowserSafeStandalone(standaloneCode(ajv, ajv.compile(schema))),
  "",
].join("\n");
const outputs = [
  [resolve(root, "fbx-viewer (1)", "host", "generated", "protocolV1.ts"), ts],
  [resolve(root, "fbx-viewer (1)", "host", "generated", "validateProtocolV1.ts"), standaloneValidator],
  [resolve(root, "Auvra", "host", "generated", "protocol_v1.py"), py],
];
const check = process.argv.includes("--check");
for (const [path, content] of outputs) {
  if (check) {
    let existing;
    try { existing = await readFile(path, "utf8"); } catch { throw new Error(`missing generated file: ${path}`); }
    if (existing !== content) throw new Error(`generated output drift: ${path}`);
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}
