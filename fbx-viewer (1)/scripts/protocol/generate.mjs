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
  "export type Method = \"host.ping\" | \"host.getCapabilities\" | \"project.getStatus\" | \"project.create\" | \"project.open\" | \"project.openRecent\" | \"project.close\" | \"project.getSnapshot\" | \"project.applyChanges\" | \"project.save\" | \"project.saveAs\" | \"project.exportPack\" | \"project.importPack\" | \"project.importLegacy\" | \"asset.beginUpload\" | \"asset.resolve\";",
  "export type ErrorCode = \"invalid_request\" | \"invalid_response\" | \"session_mismatch\" | \"unknown_method\" | \"revision_conflict\" | \"cancelled\" | \"locking\" | \"read_only\" | \"invalid_project\" | \"unsupported_version\" | \"migration_failed\" | \"disk_failure\" | \"permission_denied\" | \"recovery_required\" | \"internal_error\";",
  "export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };",
  "export interface Request { protocol: \"auvra.host/1\"; type: \"request\"; id: ProtocolId; session: SessionId; revision: Revision; method: Method; payload: Record<string, unknown>; }",
  "export interface PingResult { pong: true; }",
  "export interface CapabilitiesResult { protocol: \"auvra.host/1\"; methods: [\"host.ping\", \"host.getCapabilities\"]; projectMethods?: Method[]; }",
  "export interface ProjectResult { projectId?: string | null; revision?: Revision; name?: string | null; readOnly?: boolean; dirty?: boolean; busy?: boolean; progress?: number | null; recoveryAvailable?: boolean; recoveryId?: string; recoveryKind?: \"manual\" | \"autosave\"; recoveryPoints?: Array<{ recoveryId: string; kind: \"manual\" | \"autosave\"; size?: number }>; recentProjects?: Array<{ projectId: string; name: string }>; status?: \"closed\" | \"opening\" | \"open\" | \"saving\" | \"recovering\"; domains?: string[] | { [key: string]: JsonValue }; documents?: JsonValue[]; cursor?: string; hasMore?: boolean; handle?: string; uploadId?: string; expiresAt?: number; method?: \"GET\" | \"PUT\"; url?: string; assetId?: string; size?: number; sha256?: string; mime?: string; report?: Record<string, JsonValue>; pong?: never; }",
  "export type SuccessResult = PingResult | CapabilitiesResult | ProjectResult;",
  "export interface SuccessResponse { protocol: \"auvra.host/1\"; type: \"response\"; id: ProtocolId; session: SessionId; revision: Revision; ok: true; result: SuccessResult; }",
  "export interface ErrorResponse { protocol: \"auvra.host/1\"; type: \"response\"; id: ProtocolId; session: SessionId; revision: Revision; ok: false; error: { code: ErrorCode; message: string; details?: Record<string, never> }; }",
  "export type Response = SuccessResponse | ErrorResponse;",
  "export interface Event { protocol: \"auvra.host/1\"; type: \"event\"; event: \"host.session\" | \"host.revision\" | \"project.status\" | \"project.opening\" | \"project.opened\" | \"project.closing\" | \"project.closed\" | \"project.revision\" | \"project.dirty\" | \"project.readOnly\" | \"project.progress\" | \"project.recovery\"; session: SessionId; revision: Revision; payload: Record<string, unknown>; }",
  "export interface Session { protocol: \"auvra.host/1\"; type: \"session\"; session: SessionId; revision: Revision; status: \"created\" | \"active\" | \"closed\"; }",
  "export type Message = Request | Response | Event | Session;", "",
].join("\n");
const py = [
  '"""Generated convenience types for auvra.host/1."""',
  "from typing import Literal, NotRequired, TypedDict", "ProtocolId = str", "SessionId = str", "Revision = int",
  'Method = Literal["host.ping", "host.getCapabilities", "project.getStatus", "project.create", "project.open", "project.openRecent", "project.close", "project.getSnapshot", "project.applyChanges", "project.save", "project.saveAs", "project.exportPack", "project.importPack", "project.importLegacy", "asset.beginUpload", "asset.resolve"]',
  'ErrorCode = Literal["invalid_request", "invalid_response", "session_mismatch", "unknown_method", "revision_conflict", "cancelled", "locking", "read_only", "invalid_project", "unsupported_version", "migration_failed", "disk_failure", "permission_denied", "recovery_required", "internal_error"]',
  "class Request(TypedDict):", '    protocol: Literal["auvra.host/1"]', '    type: Literal["request"]', "    id: ProtocolId", "    session: SessionId", "    revision: Revision", "    method: Method", "    payload: dict[str, object]",
  "class PingResult(TypedDict):", "    pong: Literal[True]",
  "class CapabilitiesResult(TypedDict, total=False):", '    protocol: Literal["auvra.host/1"]', '    methods: list[Method]', "    projectMethods: list[Method]",
  "class ProjectResult(TypedDict, total=False):", "    projectId: str | None", "    revision: Revision", "    name: str | None", "    readOnly: bool", "    dirty: bool", "    busy: bool", "    progress: float | None", "    recoveryAvailable: bool", "    recoveryId: str", "    recoveryKind: str", "    recoveryPoints: list[dict[str, object]]", "    recentProjects: list[dict[str, str]]", "    status: str", "    domains: list[str] | dict[str, object]", "    documents: list[object]", "    cursor: str", "    hasMore: bool", "    handle: str", "    uploadId: str", "    expiresAt: float", "    method: str", "    url: str", "    assetId: str", "    size: int", "    sha256: str", "    mime: str", "    report: dict[str, object]",
  "SuccessResult = PingResult | CapabilitiesResult | ProjectResult",
  "class SuccessResponse(TypedDict):", '    protocol: Literal["auvra.host/1"]', '    type: Literal["response"]', "    id: ProtocolId", "    session: SessionId", "    revision: Revision", "    ok: Literal[True]", "    result: PingResult | CapabilitiesResult | ProjectResult",
  "class ErrorBody(TypedDict):", "    code: ErrorCode", "    message: str", "    details: NotRequired[dict[str, object]]",
  "class ErrorResponse(TypedDict):", '    protocol: Literal["auvra.host/1"]', '    type: Literal["response"]', "    id: ProtocolId", "    session: SessionId", "    revision: Revision", "    ok: Literal[False]", "    error: ErrorBody",
  "class Event(TypedDict):", '    protocol: Literal["auvra.host/1"]', '    type: Literal["event"]', '    event: Literal["host.session", "host.revision", "project.status", "project.opening", "project.opened", "project.closing", "project.closed", "project.revision", "project.dirty", "project.readOnly", "project.progress", "project.recovery"]', "    session: SessionId", "    revision: Revision", "    payload: dict[str, object]",
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
