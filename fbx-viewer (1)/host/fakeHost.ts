import { assertRequest, assertResponse, isValidMessage } from "./protocol";
import type { ErrorCode, Event, ProjectResult, Request, Response, SuccessResult } from "./generated/protocolV1";
import type { HostTransport } from "./transport";

const PROJECT_METHODS = ["project.getStatus", "project.create", "project.open", "project.openRecent", "project.close", "project.getSnapshot", "project.applyChanges", "project.save", "project.saveAs", "project.exportPack", "project.importPack", "project.importLegacy", "asset.beginUpload", "asset.resolve"] as const;
const METHODS = ["host.ping", "host.getCapabilities", ...PROJECT_METHODS] as const;
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
  private clock = 1_000;
  private readonly listeners = new Set<(event: Event) => void>();
  private closed = false;

  constructor(session = "fake-session-0001") { this.session = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(session) ? session : "fake-session-0001"; }

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
    if (request.method === "host.getCapabilities") return this.reply(request, { protocol: "auvra.host/1", methods: ["host.ping", "host.getCapabilities"], projectMethods: [...PROJECT_METHODS] });
    try { return this.reply(request, this.projectRequest(request.method, payload)); }
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
  subscribe(listener: (event: Event) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  close(): void { this.closed = true; this.listeners.clear(); }

  private projectRequest(method: Request["method"], payload: Payload): ProjectResult {
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
      case "project.openRecent": return this.projectRequest("project.open", { projectHandle: payload.recentId });
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
      default: throw { code: "unknown_method", message: "Unknown host method" };
    }
  }

  private status(projectId: string | null): ProjectResult { return projectId === this.projectId && this.projectOpen ? this.result() : { projectId, revision: 0, name: null, readOnly: false, dirty: false, busy: false, progress: null, recoveryAvailable: false, recentProjects: [], status: "closed" }; }
  private result(extra: Partial<ProjectResult> = {}): ProjectResult { return { projectId: this.projectId, revision: this.projectRevision, name: this.projectName, readOnly: this.projectReadOnly, dirty: this.projectDirty, status: "open", ...extra }; }
  private requireProject(payload: Payload): void { if (payload.projectId !== this.projectId || !this.projectOpen) throw { code: "invalid_project", message: "Project is not open" }; }
  private requireMutation(payload: Payload): void { this.requireProject(payload); if (payload.expectedRevision !== this.projectRevision) throw { code: "revision_conflict", message: "Project revision does not match" }; if (this.projectReadOnly) throw { code: "read_only", message: "Project is read-only" }; }
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
