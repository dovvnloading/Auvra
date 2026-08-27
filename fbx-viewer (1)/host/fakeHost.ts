import { assertRequest, assertResponse, isValidMessage } from "./protocol";
import type { ErrorCode, Event, ProjectResult, Request, Response, SuccessResult } from "./generated/protocolV1";
import type { HostTransport } from "./transport";

const PROJECT_METHODS = ["project.getStatus", "project.create", "project.open", "project.openRecent", "project.close", "project.getSnapshot", "project.applyChanges", "project.save", "project.saveAs", "project.exportPack", "project.importPack", "project.importLegacy", "asset.beginUpload", "asset.resolve"] as const;
const PROVIDER_METHODS = ["provider.list", "provider.getStatus", "provider.configureCredential", "provider.deleteCredential", "provider.configure", "provider.listModels", "provider.health", "inference.submit", "inference.get", "inference.list", "inference.cancel", "inference.retry", "media.discard", "media.commit", "command.preview", "command.approve", "command.undo"] as const;
const ENGINE_METHODS = ["engine.getStatus", "engine.getSnapshot", "engine.applyChanges", "engine.openViewport", "engine.closeViewport", "engine.renderReference", "engine.getMetrics", "engine.recover"] as const;
const METHODS = ["host.ping", "host.getCapabilities", ...PROJECT_METHODS, ...PROVIDER_METHODS, ...ENGINE_METHODS] as const;
const MEDIA_CAPABILITIES = ["media.generate", "media.edit"] as const;
type Payload = Record<string, unknown>;

/** In-memory, deterministic project host for browser development and protocol tests. */
export class FakeHost implements HostTransport {
  readonly session: string;
  private revision = 0;
  private projectRevision = 0;
  private projectId = "fake-project-0001";
  private projectName = "Untitled";
  private projectOpen = false;
  private projectDirty = false;
  private projectReadOnly = false;
  private readonly documents = new Map<string, unknown>();
  private readonly tickets = new Map<string, { method: "PUT" | "GET"; size: number; mime: string; expiresAt: number; consumed: boolean; sha256?: string }>();
  private readonly uploaded = new Set<string>();
  private readonly providerConfigured = new Set<string>();
  private readonly providerSettings = new Map<string, Record<string, unknown>>();
  private readonly providerSettingsRevision = new Map<string, number>();
  private readonly jobs = new Map<string, Record<string, unknown>>();
  private readonly jobProjects = new Map<string, string>();
  private readonly proposals = new Map<string, Record<string, unknown>>();
  private readonly transactions = new Map<string, string>();
  private engineRevision = 0;
  private engineViewport: "closed" | "open" = "closed";
  private engineRecoveries = 0;
  private engineEntities: unknown[] = [];
  private clock = 1_000;
  private readonly listeners = new Set<(event: Event) => void>();
  private closed = false;

  constructor(session = "fake-session-0001") { this.session = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(session) ? session : "fake-session-0001"; }
  get currentRevision(): number { return this.revision; }

  async request(request: Request): Promise<Response> {
    const candidateId = (request as unknown as { id?: unknown })?.id;
    const safeId = typeof candidateId === "string" ? candidateId : "invalid";
    if (this.closed) return this.error(safeId, "internal_error", "Host is closed");
    if (!isValidMessage(request) || request.type !== "request") return this.error(safeId, "invalid_request", "Invalid host request");
    assertRequest(request);
    if (request.session !== this.session) return this.error(request.id, "session_mismatch", "Session does not match");
    if (request.revision !== this.revision) return this.error(request.id, "revision_conflict", "Host revision does not match");
    const payload = request.payload as Payload;
    if (request.method === "host.ping") return this.reply(request, { pong: true });
    if (request.method === "host.getCapabilities") return this.reply(request, { protocol: "auvra.host/1", methods: ["host.ping", "host.getCapabilities"], projectMethods: [...PROJECT_METHODS], providerMethods: [...PROVIDER_METHODS], engineMethods: [...ENGINE_METHODS] });
    try { return this.reply(request, this.operationRequest(request.method, payload)); }
    catch (error) {
      const operation = error as { code?: ErrorCode; message?: string };
      return this.error(request.id, operation.code ?? "internal_error", operation.message ?? "Host operation failed");
    }
  }

  emitRevision(): Event { this.revision++; return this.emit("host.revision", {}); }
  emitProjectEvent(event: Exclude<Event["event"], "host.session" | "host.revision">, payload: Payload = {}): Event {
    const status = this.status(this.projectId);
    return this.emit(event, {
      projectId: this.projectId,
      revision: status.revision ?? 0,
      name: status.name ?? null,
      dirty: status.dirty ?? false,
      readOnly: status.readOnly ?? false,
      busy: status.busy ?? false,
      progress: status.progress ?? null,
      recoveryAvailable: status.recoveryAvailable ?? false,
      recentProjects: status.recentProjects ?? [],
      status: status.status ?? "closed",
      domains: status.domains && !Array.isArray(status.domains) ? status.domains : {},
      ...payload,
    });
  }
  emitProviderEvent(event: "provider.job" | "provider.status" | "provider.progress" | "provider.recovery", payload: Payload = {}): Event {
    return this.emit(event, { providerId: "ollama", status: "queued", progress: null, attempt: 1, ...payload });
  }
  subscribe(listener: (event: Event) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  close(): void { this.closed = true; this.listeners.clear(); }

  private operationRequest(method: Request["method"], payload: Payload): SuccessResult {
    switch (method) {
      case "project.getStatus": return this.status(typeof payload.projectId === "string" ? payload.projectId : null);
      case "project.create": this.projectOpen = true; this.projectReadOnly = false; this.projectDirty = true; this.projectRevision = 0; this.projectName = String(payload.name); this.revision++; return this.result();
      case "project.open": {
        const handle = String(payload.projectHandle);
        if (handle === "locked") throw { code: "locking", message: "Project is locked by another writer" };
        if (handle === "cancel") throw { code: "cancelled", message: "Project open was cancelled" };
        this.projectOpen = true; this.projectReadOnly = handle === "readonly"; this.projectDirty = false; this.revision++;
        return this.result({ handle });
      }
      case "project.openRecent": return this.operationRequest("project.open", { projectHandle: payload.recentId });
      case "project.close": this.requireMutation(payload); this.projectOpen = false; this.projectDirty = false; this.revision++; return { projectId: this.projectId, revision: this.projectRevision, status: "closed", dirty: false, readOnly: false };
      case "project.getSnapshot": {
        this.requireProject(payload); const domain = typeof payload.domain === "string" ? payload.domain : ""; const docs = [...this.documents.entries()].filter(([key]) => !domain || key.startsWith(`${domain}:`)).sort().map(([, value]) => value); const offset = Number(payload.cursor || 0); const pageSize = Number(payload.pageSize || 1000); const page = docs.slice(offset, offset + pageSize); const next = offset + page.length; return this.result({ documents: page as ProjectResult["documents"], cursor: next < docs.length ? String(next) : "", hasMore: next < docs.length });
      }
      case "project.applyChanges": this.requireMutation(payload); for (const value of (payload.changes as Array<Record<string, unknown>>) || []) { const key = `${String(value.domain)}:${String(value.documentId)}`; if (value.operation === "remove") this.documents.delete(key); else this.documents.set(key, value.document); } this.projectRevision++; this.projectDirty = true; this.revision++; return this.result();
      case "project.save": this.requireMutation(payload); this.projectDirty = false; this.revision++; return this.result({ dirty: false });
      case "project.saveAs": this.requireMutation(payload); this.projectName = String(payload.name); this.projectDirty = false; this.revision++; return this.result({ name: this.projectName, dirty: false });
      case "project.exportPack": this.requireMutation(payload); return this.result({ handle: "pack-0001" });
      case "project.importPack": if (payload.sourceHandle === "invalid" || payload.sourceHandle === "bomb") throw { code: "invalid_project", message: "Project archive failed validation" }; this.projectOpen = true; this.projectReadOnly = false; this.revision++; return this.result({ handle: String(payload.sourceHandle) });
      case "project.importLegacy": if (payload.sourceHandle === "invalid") throw { code: "migration_failed", message: "Legacy source could not be migrated" }; this.projectOpen = true; this.revision++; return this.result({ report: { migrated: true } });
      case "asset.beginUpload": { this.requireMutation(payload); const token = "A".repeat(43); this.tickets.set(token, { method: "PUT", size: Number(payload.size), mime: String(payload.mime), expiresAt: this.clock + 300, consumed: false }); this.projectRevision++; this.revision++; return this.result({ uploadId: token, size: Number(payload.size), mime: String(payload.mime), method: "PUT", expiresAt: this.clock + 300, url: `https://assets.auvra.local/v1/put/${token}` }); }
      case "asset.resolve": { this.requireProject(payload); const assetId = String(payload.assetId); if (!this.uploaded.has(assetId)) throw { code: "invalid_project", message: "Asset is unavailable" }; const token = "B".repeat(43); this.tickets.set(token, { method: "GET", size: 0, mime: "application/octet-stream", expiresAt: this.clock + 300, consumed: false, sha256: assetId }); return this.result({ assetId, method: "GET", expiresAt: this.clock + 300, url: `https://assets.auvra.local/v1/get/${token}` }); }
      case "provider.list": return { kind: "provider.list", providers: [
        ["fal", "fal.ai", "cloud", ["media.generate", "media.edit"]], ["openai", "OpenAI", "cloud", ["text", "code", "commands"]],
        ["anthropic", "Anthropic", "cloud", ["text", "code", "commands"]], ["xai", "xAI", "cloud", ["text", "code", "commands"]],
        ["openrouter", "OpenRouter", "cloud", ["text", "code", "commands"]], ["ollama", "Ollama", "local", ["text", "code", "commands"]],
        ["llama.cpp", "llama.cpp", "local", ["text", "code", "commands"]],
      ].map(([providerId, displayName, route, capabilities]) => ({ providerId, displayName, route, capabilities, features: ["cancel", "structured_output"], requiresCredential: route === "cloud", configured: route === "local" || this.providerConfigured.has(String(providerId)), available: true })) } as unknown as SuccessResult;
      case "provider.getStatus": { const providerId = String(payload.providerId); this.assertProvider(providerId); const configured = this.providerConfigured.has(providerId); return this.providerStatus(providerId, configured); }
      case "provider.configureCredential": { const providerId = String(payload.providerId); this.assertProvider(providerId); this.providerConfigured.add(providerId); return { kind: "provider.credential", providerId, storageMode: payload.storageMode, configured: true, credentialStatus: payload.storageMode === "memoryOnly" ? "memoryOnly" : "configured" }; }
      case "provider.deleteCredential": { const providerId = String(payload.providerId); this.assertProvider(providerId); this.providerConfigured.delete(providerId); return this.providerStatus(providerId, false); }
      case "provider.configure": {
        const providerId = String(payload.providerId); this.assertProvider(providerId);
        const expected = Number(payload.expectedSettingsRevision); const current = this.providerSettingsRevision.get(providerId) ?? 0;
        if (expected !== current) throw { code: "revision_conflict", message: "Provider settings revision does not match" };
        const settings = payload.settings as Record<string, unknown>;
        if (settings.fallbackPolicy !== "none") throw { code: "invalid_request", message: "Provider fallback is disabled" };
        const routes = Array.isArray(settings.routes) ? settings.routes as Array<{ capability?: unknown }> : [];
        if (settings.enabled !== false) for (const route of routes) for (const [otherId, other] of this.providerSettings) {
          if (otherId === providerId || other.enabled === false || !Array.isArray(other.routes)) continue;
          if ((other.routes as Array<{ capability?: unknown }>).some((candidate) => candidate.capability === route.capability)) throw { code: "invalid_request", message: "That capability already has an enabled provider route" };
        }
        this.providerSettings.set(providerId, settings); this.providerSettingsRevision.set(providerId, current + 1);
        return this.providerStatus(providerId, this.providerConfigured.has(providerId));
      }
      case "provider.listModels": { const providerId = String(payload.providerId); this.assertProvider(providerId); const capabilities = providerId === "fal" ? [...MEDIA_CAPABILITIES] : ["text", "code", "commands"] as const; return { kind: "provider.models", providerId, models: [{ modelId: `${providerId}.default`, displayName: "Default", capabilities }] }; }
      case "provider.health": { const providerId = String(payload.providerId); this.assertProvider(providerId); const healthy = ["ollama", "llama.cpp"].includes(providerId) || this.providerConfigured.has(providerId); return { kind: "provider.health", providerId, healthy, latencyMs: 0, message: "deterministic fake host" }; }
      case "inference.submit": {
        this.requireProject(payload); if (payload.expectedRevision !== this.projectRevision) throw { code: "revision_conflict", message: "Project revision does not match" };
        const providerId = String(payload.providerId); this.assertProvider(providerId); const route = ["ollama", "llama.cpp"].includes(providerId) ? "local" : "cloud";
        const supported = providerId === "fal" ? MEDIA_CAPABILITIES : ["text", "code", "commands"];
        if (!(supported as readonly unknown[]).includes(payload.capability)) throw { code: "unsupported_capability", message: "Provider does not support capability" };
        if (payload.targetElementId !== undefined && payload.capability !== "commands") throw { code: "unsupported_capability", message: "targetElementId is valid only for command jobs" };
        if (payload.route !== route) throw { code: "endpoint_denied", message: "Provider route does not match explicit request" };
        const settings = this.providerSettings.get(providerId); const configuredRoute = Array.isArray(settings?.routes) ? (settings?.routes as Array<{ capability?: unknown; modelId?: unknown }>).find((candidate) => candidate.capability === payload.capability) : undefined;
        if (settings?.enabled !== true || configuredRoute?.modelId !== payload.modelId) throw { code: "provider_not_configured", message: "The exact provider capability and model route is not configured" };
        if (route === "cloud" && !this.providerConfigured.has(providerId)) throw { code: "provider_not_configured", message: "Provider credential is not configured" };
        const jobId = `job-${String(this.jobs.size + 1).padStart(8, "0")}`; const job: Record<string, unknown> = { jobId, providerId: payload.providerId, modelId: payload.modelId, capability: payload.capability, route: payload.route, status: "succeeded", progress: 1, attempt: 1 };
        if (payload.capability === "text" || payload.capability === "code") job.outputText = "deterministic fake response";
        if (payload.capability === "media.generate" || payload.capability === "media.edit") { const previewAssetId = String(this.jobs.size + 1).padStart(64, "0"); this.uploaded.add(previewAssetId); job.preview = { previewAssetId, mime: "image/png", size: 1, dimensions: { width: 1, height: 1 } }; }
        if (payload.capability === "commands") { const proposalId = `proposal-${String(this.jobs.size + 1).padStart(8, "0")}`; job.proposalAvailable = true; job.proposalId = proposalId; this.proposals.set(proposalId, { jobId, projectId: this.projectId }); }
        this.jobs.set(jobId, job); this.jobProjects.set(jobId, this.projectId); return { kind: "inference.submit", job } as unknown as SuccessResult;
      }
      case "inference.get": { this.requireProject(payload); const job = this.jobs.get(String(payload.jobId)); if (!job || this.jobProjects.get(String(payload.jobId)) !== this.projectId) throw { code: "invalid_job", message: "Inference job is unavailable" }; return { kind: "inference.get", job } as unknown as SuccessResult; }
      case "inference.list": this.requireProject(payload); return { kind: "inference.list", jobs: [...this.jobs.entries()].filter(([jobId]) => this.jobProjects.get(jobId) === this.projectId).map(([, job]) => job), cursor: "", hasMore: false } as unknown as SuccessResult;
      case "inference.cancel": { this.requireProject(payload); const job = this.jobs.get(String(payload.jobId)); if (!job || this.jobProjects.get(String(payload.jobId)) !== this.projectId) throw { code: "invalid_job", message: "Inference job is unavailable" }; job.status = "cancelled"; job.progress = null; return { kind: "inference.cancel", job } as unknown as SuccessResult; }
      case "inference.retry": { this.requireMutation(payload); const job = this.jobs.get(String(payload.jobId)); if (!job || this.jobProjects.get(String(payload.jobId)) !== this.projectId) throw { code: "invalid_job", message: "Inference job is unavailable" }; job.attempt = Number(job.attempt) + 1; job.status = "succeeded"; job.progress = 1; return { kind: "inference.retry", job } as unknown as SuccessResult; }
      case "media.discard": { this.requireProject(payload); const job = this.requireJob(payload); if ((job.preview as { previewAssetId?: unknown } | undefined)?.previewAssetId !== payload.previewAssetId) throw { code: "invalid_job", message: "Preview does not belong to this job" }; return { kind: "media.discard", projectId: this.projectId, jobId: payload.jobId, previewAssetId: payload.previewAssetId, projectRevision: this.projectRevision } as unknown as SuccessResult; }
      case "media.commit": { this.requireMutation(payload); const job = this.requireJob(payload); if ((job.preview as { previewAssetId?: unknown } | undefined)?.previewAssetId !== payload.previewAssetId) throw { code: "invalid_job", message: "Preview does not belong to this job" }; this.projectRevision++; this.revision++; this.uploaded.add("a".repeat(64)); return { kind: "media.commit", projectId: this.projectId, jobId: payload.jobId, previewAssetId: payload.previewAssetId, projectRevision: this.projectRevision, assetId: "a".repeat(64) } as unknown as SuccessResult; }
      case "command.preview": { this.requireProject(payload); const job = this.requireJob(payload); const proposalId = String(job.proposalId || ""); if (!this.proposals.has(proposalId)) throw { code: "invalid_job", message: "Command proposal is unavailable" }; return { kind: "command.preview", projectId: this.projectId, projectRevision: this.projectRevision, proposalId, diff: [] } as unknown as SuccessResult; }
      case "command.approve": { this.requireMutation(payload); const proposalId = String(payload.proposalId); const proposal = this.proposals.get(proposalId); if (!proposal || proposal.projectId !== this.projectId) throw { code: "approval_required", message: "Command proposal is unavailable" }; this.projectRevision++; this.revision++; const transactionId = `transaction-${String(this.transactions.size + 1).padStart(8, "0")}`; this.transactions.set(transactionId, proposalId); this.proposals.delete(proposalId); return { kind: "command.approve", projectId: this.projectId, projectRevision: this.projectRevision, transactionId } as unknown as SuccessResult; }
      case "command.undo": { this.requireMutation(payload); const transactionId = String(payload.transactionId); if (!this.transactions.has(transactionId)) throw { code: "invalid_command", message: "Command transaction is unavailable" }; this.projectRevision++; this.revision++; this.transactions.delete(transactionId); return { kind: "command.undo", projectId: this.projectId, projectRevision: this.projectRevision, transactionId } as unknown as SuccessResult; }
      case "engine.getStatus": return this.engineResult("engine.status");
      case "engine.getSnapshot": return this.engineResult("engine.snapshot", { entities: [...this.engineEntities] });
      case "engine.applyChanges": {
        if (payload.expectedRevision !== this.engineRevision) throw { code: "revision_conflict", message: "Native world revision does not match" };
        this.engineEntities = Array.isArray(payload.entities) ? [...payload.entities] : [];
        this.engineRevision++; this.revision++;
        return this.engineResult("engine.applyChanges", { entities: [...this.engineEntities] });
      }
      case "engine.openViewport": this.engineViewport = "open"; this.revision++; return this.engineResult("engine.openViewport");
      case "engine.closeViewport": this.engineViewport = "closed"; this.revision++; return this.engineResult("engine.closeViewport");
      case "engine.renderReference": return this.engineResult("engine.renderReference", { signature: "47ed61f4e0a9caba", width: Number(payload.width ?? 64), height: Number(payload.height ?? 64) });
      case "engine.getMetrics": return this.engineResult("engine.metrics", { metrics: this.engineMetrics() });
      case "engine.recover": this.engineRecoveries++; this.revision++; return this.engineResult("engine.recover", { metrics: this.engineMetrics() });
      default: throw { code: "unknown_method", message: "Unknown host method" };
    }
  }

  private status(projectId: string | null): ProjectResult { return projectId === this.projectId && this.projectOpen ? this.result() : { projectId, revision: 0, name: null, readOnly: false, dirty: false, busy: false, progress: null, recoveryAvailable: false, recentProjects: [], status: "closed" }; }
  private result(extra: Partial<ProjectResult> = {}): ProjectResult { return { projectId: this.projectId, revision: this.projectRevision, name: this.projectName, readOnly: this.projectReadOnly, dirty: this.projectDirty, status: "open", ...extra }; }
  private requireProject(payload: Payload): void { if (payload.projectId !== this.projectId || !this.projectOpen) throw { code: "invalid_project", message: "Project is not open" }; }
  private requireMutation(payload: Payload): void { this.requireProject(payload); if (payload.expectedRevision !== this.projectRevision) throw { code: "revision_conflict", message: "Project revision does not match" }; if (this.projectReadOnly) throw { code: "read_only", message: "Project is read-only" }; }
  private requireJob(payload: Payload): Record<string, unknown> { const jobId = String(payload.jobId); const job = this.jobs.get(jobId); if (!job || this.jobProjects.get(jobId) !== this.projectId) throw { code: "invalid_job", message: "Inference job is unavailable" }; return job; }
  private assertProvider(providerId: string): void { if (!["fal", "openai", "anthropic", "xai", "openrouter", "ollama", "llama.cpp"].includes(providerId)) throw { code: "provider_unavailable", message: "Provider is not registered" }; }
  private providerStatus(providerId: string, configured: boolean): SuccessResult { const local = ["ollama", "llama.cpp"].includes(providerId); const stored = this.providerSettings.get(providerId) ?? { enabled: false, routes: [], fallbackPolicy: "none", requireCostConfirmation: true, budgets: { perJobMicroUsd: 0, dailyMicroUsd: 0, monthlyMicroUsd: 0 } }; const settings = { ...stored }; if ("endpoint" in settings) { delete settings.endpoint; settings.endpointConfigured = true; } return { kind: "provider.status", providerId, configured: configured || local, available: true, healthy: configured || local, state: configured || local ? "ready" : "unconfigured", settings, settingsRevision: this.providerSettingsRevision.get(providerId) ?? 0, credentialStatus: local ? "notRequired" : configured ? "configured" : "absent" } as unknown as SuccessResult; }
  private engineMetrics(): Record<string, unknown> { return { startupMs: 0, frameCpuMs: 0, gpuFrameMs: null, memoryBytes: 0, recoveryCount: this.engineRecoveries }; }
  private engineResult(kind: string, extra: Record<string, unknown> = {}): SuccessResult { return { kind, protocol: "auvra.native/1", status: "ready", worldRevision: this.engineRevision, viewport: this.engineViewport, backend: "WebGL2 fake fallback", adapter: "deterministic fake host", fallbackReason: "Native engine process is not started in browser development mode", ...extra } as unknown as SuccessResult; }
  async requestAsset(request: { method: string; url: string; origin: string; mime?: string; body?: Uint8Array; now?: number }): Promise<{ status: number; sha256?: string }> {
    const expectedOrigin = "https://assets.auvra.local";
    if (request.origin !== expectedOrigin) throw { code: "asset_origin_denied" };
    const match = /^https:\/\/assets\.auvra\.local\/v1\/(get|put)\/([A-Za-z0-9_-]{43})$/.exec(request.url);
    if (!match) throw { code: "asset_url_invalid" };
    const ticket = this.tickets.get(match[2]);
    if (!ticket || ticket.method.toLowerCase() !== match[1] || ticket.consumed) throw { code: "asset_ticket_consumed" };
    this.clock = request.now ?? this.clock;
    if (this.clock >= ticket.expiresAt) throw { code: "asset_ticket_expired" };
    if (request.method.toUpperCase() !== ticket.method) throw { code: "asset_method_denied" };
    if (ticket.method === "PUT") {
      if (request.mime !== ticket.mime || !request.body || request.body.byteLength !== ticket.size) throw { code: "asset_size_or_mime_denied" };
      const digest = await crypto.subtle.digest("SHA-256", request.body);
      const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      ticket.sha256 = sha256; ticket.consumed = true; this.uploaded.add(sha256); return { status: 204, sha256 };
    }
    ticket.consumed = true; return { status: 200, sha256: ticket.sha256 };
  }
  private reply(request: Request, result: SuccessResult): Response { const response: Response = { protocol: "auvra.host/1", type: "response", id: request.id, session: this.session, revision: this.revision, ok: true, result }; assertResponse(response); return response; }
  private error(id: string, code: ErrorCode, message: string): Response { const safeId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : "invalid"; const response: Response = { protocol: "auvra.host/1", type: "response", id: safeId, session: this.session, revision: this.revision, ok: false, error: { code, message } }; assertResponse(response); return response; }
  private emit(event: Event["event"], payload: Payload): Event { const value: Event = { protocol: "auvra.host/1", type: "event", event, session: this.session, revision: this.revision, payload }; if (!isValidMessage(value)) throw new Error("Invalid generated event"); this.listeners.forEach((listener) => listener(value)); return value; }
}
