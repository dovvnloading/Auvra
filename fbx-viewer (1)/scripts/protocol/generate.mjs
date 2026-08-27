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
  "export type Revision = number;", "export type ProtocolId = string;", "export type SessionId = string;", "export type JobId = string;", "export type ProposalId = string;", "export type TransactionId = string;", "export type PreviewAssetId = string;",
  "export type Method = \"host.ping\" | \"host.getCapabilities\" | \"project.getStatus\" | \"project.create\" | \"project.open\" | \"project.openRecent\" | \"project.close\" | \"project.getSnapshot\" | \"project.applyChanges\" | \"project.save\" | \"project.saveAs\" | \"project.exportPack\" | \"project.importPack\" | \"project.importLegacy\" | \"asset.beginUpload\" | \"asset.resolve\" | \"provider.list\" | \"provider.getStatus\" | \"provider.configureCredential\" | \"provider.deleteCredential\" | \"provider.configure\" | \"provider.listModels\" | \"provider.health\" | \"inference.submit\" | \"inference.get\" | \"inference.list\" | \"inference.cancel\" | \"inference.retry\" | \"media.discard\" | \"media.commit\" | \"command.preview\" | \"command.approve\" | \"command.undo\" | \"engine.getStatus\" | \"engine.getSnapshot\" | \"engine.applyChanges\" | \"engine.openViewport\" | \"engine.closeViewport\" | \"engine.renderReference\" | \"engine.getMetrics\" | \"engine.recover\";",
  "export type ErrorCode = \"invalid_request\" | \"invalid_response\" | \"session_mismatch\" | \"unknown_method\" | \"revision_conflict\" | \"cancelled\" | \"locking\" | \"read_only\" | \"invalid_project\" | \"unsupported_version\" | \"migration_failed\" | \"disk_failure\" | \"permission_denied\" | \"recovery_required\" | \"unsupported_capability\" | \"provider_not_configured\" | \"provider_unavailable\" | \"provider_authentication\" | \"provider_authorization\" | \"provider_rate_limited\" | \"provider_timeout\" | \"provider_network\" | \"provider_invalid_response\" | \"provider_not_found\" | \"invalid_job\" | \"budget_exceeded\" | \"invalid_command\" | \"approval_required\" | \"credential_unavailable\" | \"endpoint_denied\" | \"internal_error\";",
  "export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };",
  "export interface Request { protocol: \"auvra.host/1\"; type: \"request\"; id: ProtocolId; session: SessionId; revision: Revision; method: Method; payload: Record<string, unknown>; }",
  "export interface PingResult { pong: true; }",
  "export interface CapabilitiesResult { protocol: \"auvra.host/1\"; methods: [\"host.ping\", \"host.getCapabilities\"]; projectMethods: Method[]; providerMethods: Method[]; engineMethods: Method[]; }",
  "export interface ProjectResult { projectId?: string | null; revision?: Revision; name?: string | null; readOnly?: boolean; dirty?: boolean; busy?: boolean; progress?: number | null; recoveryAvailable?: boolean; recoveryId?: string; recoveryKind?: \"manual\" | \"autosave\"; recoveryPoints?: Array<{ recoveryId: string; kind: \"manual\" | \"autosave\"; size?: number }>; recentProjects?: Array<{ projectId: string; name: string }>; status?: \"closed\" | \"opening\" | \"open\" | \"saving\" | \"recovering\"; domains?: string[] | { [key: string]: JsonValue }; documents?: JsonValue[]; cursor?: string; hasMore?: boolean; handle?: string; uploadId?: string; expiresAt?: number; method?: \"GET\" | \"PUT\"; url?: string; assetId?: string; size?: number; sha256?: string; mime?: string; report?: Record<string, JsonValue>; pong?: never; }",
  "export interface ProviderDescriptor { providerId: string; displayName: string; route: \"cloud\" | \"local\"; capabilities: Array<\"text\" | \"code\" | \"commands\" | \"media.generate\" | \"media.edit\">; features: Array<\"streaming\" | \"queue\" | \"cancel\" | \"durable\" | \"upload\" | \"structured_output\">; requiresCredential: boolean; configured: boolean; available: boolean; }",
  "export interface ProviderSettings { enabled: boolean; routes: Array<{ capability: \"text\" | \"code\" | \"commands\" | \"media.generate\" | \"media.edit\"; modelId: string }>; fallbackPolicy: \"none\"; requireCostConfirmation: boolean; budgets: { perJobMicroUsd: number; dailyMicroUsd: number; monthlyMicroUsd: number }; endpoint?: string; }",
  "export interface ProviderSettingsResult { enabled: boolean; routes: Array<{ capability: \"text\" | \"code\" | \"commands\" | \"media.generate\" | \"media.edit\"; modelId: string }>; fallbackPolicy: \"none\"; requireCostConfirmation: boolean; budgets: { perJobMicroUsd: number; dailyMicroUsd: number; monthlyMicroUsd: number }; endpointConfigured?: boolean; }",
  "export type CredentialStatus = \"configured\" | \"memoryOnly\" | \"absent\" | \"notRequired\" | \"unavailable\";",
  "export interface ProviderStatusResult { kind: \"provider.status\"; providerId: string; configured: boolean; available: boolean; healthy: boolean; state: \"ready\" | \"unconfigured\" | \"unavailable\" | \"degraded\"; settings: ProviderSettingsResult; settingsRevision: Revision; credentialStatus: CredentialStatus; message?: string; }",
  "export interface Job { jobId: JobId; providerId: string; modelId: string; capability: \"text\" | \"code\" | \"commands\" | \"media.generate\" | \"media.edit\"; route: \"cloud\" | \"local\"; status: \"queued\" | \"submitting\" | \"running\" | \"succeeded\" | \"failed\" | \"cancel_requested\" | \"cancelled\" | \"recovering\"; progress: number | null; attempt: number; message?: string; retryable?: boolean; outputText?: string; proposalAvailable?: boolean; proposalId?: ProposalId; preview?: { previewAssetId: PreviewAssetId; mime: string; size: number; dimensions: { width: number; height: number } }; previewAssetIds?: PreviewAssetId[]; outputAssetIds?: PreviewAssetId[]; }",
  "export type SuccessResult = PingResult | CapabilitiesResult | ProjectResult | Record<string, unknown>;",
  "export interface SuccessResponse { protocol: \"auvra.host/1\"; type: \"response\"; id: ProtocolId; session: SessionId; revision: Revision; ok: true; result: SuccessResult; }",
  "export interface ErrorResponse { protocol: \"auvra.host/1\"; type: \"response\"; id: ProtocolId; session: SessionId; revision: Revision; ok: false; error: { code: ErrorCode; message: string; details?: Record<string, never> }; }",
  "export type Response = SuccessResponse | ErrorResponse;",
  "export interface Event { protocol: \"auvra.host/1\"; type: \"event\"; event: \"host.session\" | \"host.revision\" | \"project.status\" | \"project.opening\" | \"project.opened\" | \"project.closing\" | \"project.closed\" | \"project.revision\" | \"project.dirty\" | \"project.readOnly\" | \"project.progress\" | \"project.recovery\" | \"provider.job\" | \"provider.status\" | \"provider.progress\" | \"provider.recovery\" | \"engine.status\" | \"engine.revision\" | \"engine.viewport\" | \"engine.recovery\"; session: SessionId; revision: Revision; payload: Record<string, unknown>; }",
  "export interface Session { protocol: \"auvra.host/1\"; type: \"session\"; session: SessionId; revision: Revision; status: \"created\" | \"active\" | \"closed\"; }",
  "export type Message = Request | Response | Event | Session;", "",
].join("\n");
const py = [
  '"""Generated convenience types for auvra.host/1."""',
  "from typing import Literal, NotRequired, TypedDict", "ProtocolId = str", "SessionId = str", "Revision = int", "JobId = str", "ProposalId = str", "TransactionId = str", "PreviewAssetId = str",
  'Method = Literal["host.ping", "host.getCapabilities", "project.getStatus", "project.create", "project.open", "project.openRecent", "project.close", "project.getSnapshot", "project.applyChanges", "project.save", "project.saveAs", "project.exportPack", "project.importPack", "project.importLegacy", "asset.beginUpload", "asset.resolve", "provider.list", "provider.getStatus", "provider.configureCredential", "provider.deleteCredential", "provider.configure", "provider.listModels", "provider.health", "inference.submit", "inference.get", "inference.list", "inference.cancel", "inference.retry", "media.discard", "media.commit", "command.preview", "command.approve", "command.undo", "engine.getStatus", "engine.getSnapshot", "engine.applyChanges", "engine.openViewport", "engine.closeViewport", "engine.renderReference", "engine.getMetrics", "engine.recover"]',
  'ErrorCode = Literal["invalid_request", "invalid_response", "session_mismatch", "unknown_method", "revision_conflict", "cancelled", "locking", "read_only", "invalid_project", "unsupported_version", "migration_failed", "disk_failure", "permission_denied", "recovery_required", "unsupported_capability", "provider_not_configured", "provider_unavailable", "provider_authentication", "provider_authorization", "provider_rate_limited", "provider_timeout", "provider_network", "provider_invalid_response", "provider_not_found", "invalid_job", "budget_exceeded", "invalid_command", "approval_required", "credential_unavailable", "endpoint_denied", "internal_error"]',
  "class Request(TypedDict):", '    protocol: Literal["auvra.host/1"]', '    type: Literal["request"]', "    id: ProtocolId", "    session: SessionId", "    revision: Revision", "    method: Method", "    payload: dict[str, object]",
  "class PingResult(TypedDict):", "    pong: Literal[True]",
  "class CapabilitiesResult(TypedDict, total=False):", '    protocol: Literal["auvra.host/1"]', '    methods: list[Method]', "    projectMethods: list[Method]", "    providerMethods: list[Method]", "    engineMethods: list[Method]",
  "class ProjectResult(TypedDict, total=False):", "    projectId: str | None", "    revision: Revision", "    name: str | None", "    readOnly: bool", "    dirty: bool", "    busy: bool", "    progress: float | None", "    recoveryAvailable: bool", "    recoveryId: str", "    recoveryKind: str", "    recoveryPoints: list[dict[str, object]]", "    recentProjects: list[dict[str, str]]", "    status: str", "    domains: list[str] | dict[str, object]", "    documents: list[object]", "    cursor: str", "    hasMore: bool", "    handle: str", "    uploadId: str", "    expiresAt: float", "    method: str", "    url: str", "    assetId: str", "    size: int", "    sha256: str", "    mime: str", "    report: dict[str, object]",
  "class ProviderSettings(TypedDict):", "    enabled: bool", "    routes: list[dict[str, str]]", "    fallbackPolicy: Literal['none']", "    requireCostConfirmation: bool", "    budgets: dict[str, int]", "    endpoint: NotRequired[str]",
  "class ProviderSettingsResult(TypedDict):", "    enabled: bool", "    routes: list[dict[str, str]]", "    fallbackPolicy: Literal['none']", "    requireCostConfirmation: bool", "    budgets: dict[str, int]", "    endpointConfigured: NotRequired[bool]",
  "CredentialStatus = Literal['configured', 'memoryOnly', 'absent', 'notRequired', 'unavailable']",
  "class ProviderDescriptor(TypedDict):", "    providerId: str", "    displayName: str", "    route: Literal['cloud', 'local']", "    capabilities: list[str]", "    features: list[str]", "    requiresCredential: bool", "    configured: bool", "    available: bool",
  "class Job(TypedDict, total=False):", "    jobId: JobId", "    providerId: str", "    modelId: str", "    capability: str", "    route: str", "    status: str", "    progress: float | None", "    attempt: int", "    message: str", "    retryable: bool", "    outputText: str", "    proposalAvailable: bool", "    proposalId: ProposalId", "    preview: dict[str, object]", "    previewAssetIds: list[PreviewAssetId]", "    outputAssetIds: list[PreviewAssetId]",
  "SuccessResult = PingResult | CapabilitiesResult | ProjectResult | dict[str, object]",
  "class SuccessResponse(TypedDict):", '    protocol: Literal["auvra.host/1"]', '    type: Literal["response"]', "    id: ProtocolId", "    session: SessionId", "    revision: Revision", "    ok: Literal[True]", "    result: PingResult | CapabilitiesResult | ProjectResult | dict[str, object]",
  "class ErrorBody(TypedDict):", "    code: ErrorCode", "    message: str", "    details: NotRequired[dict[str, object]]",
  "class ErrorResponse(TypedDict):", '    protocol: Literal["auvra.host/1"]', '    type: Literal["response"]', "    id: ProtocolId", "    session: SessionId", "    revision: Revision", "    ok: Literal[False]", "    error: ErrorBody",
  "class Event(TypedDict):", '    protocol: Literal["auvra.host/1"]', '    type: Literal["event"]', '    event: Literal["host.session", "host.revision", "project.status", "project.opening", "project.opened", "project.closing", "project.closed", "project.revision", "project.dirty", "project.readOnly", "project.progress", "project.recovery", "provider.job", "provider.status", "provider.progress", "provider.recovery", "engine.status", "engine.revision", "engine.viewport", "engine.recovery"]', "    session: SessionId", "    revision: Revision", "    payload: dict[str, object]",
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
  ).replace(
    /const (func\d+) = require\("ajv\/dist\/runtime\/equal"\)\.default;/g,
    (_match, name) => `const ${name} = (a,b) => { if (a === b) return true; if (!a || !b || typeof a !== typeof b) return false; if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v,i) => ${name}(v,b[i])); if (typeof a === "object") { const ak = Object.keys(a), bk = Object.keys(b); return ak.length === bk.length && ak.every((k) => Object.prototype.hasOwnProperty.call(b,k) && ${name}(a[k],b[k])); } return false; };`,
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
