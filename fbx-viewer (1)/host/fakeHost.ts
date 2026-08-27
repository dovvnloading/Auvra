import { assertRequest, assertResponse, isValidMessage } from "./protocol";
import type { ErrorCode, Event, Request, Response, SuccessResult } from "./generated/protocolV1";
import type { HostTransport } from "./transport";

export class FakeHost implements HostTransport {
  readonly session: string;
  private revision = 0;
  private listeners = new Set<(event: Event) => void>();
  private closed = false;
  constructor(session = "fake-session-0001") { this.session = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(session) ? session : "fake-session-0001"; }

  async request(request: Request): Promise<Response> {
    const candidateId = (request as unknown as { id?: unknown })?.id;
    const safeCandidateId = typeof candidateId === "string" ? candidateId : "invalid";
    if (this.closed) return this.error(safeCandidateId, "internal_error", "Host is closed");
    if (request && typeof request === "object" && (request as unknown as { type?: unknown }).type === "request" &&
        typeof (request as unknown as { method?: unknown }).method === "string" &&
        !["host.ping", "host.getCapabilities"].includes((request as unknown as { method: string }).method)) {
      return this.error(typeof (request as unknown as { id?: unknown }).id === "string" ? (request as unknown as { id: string }).id : "invalid", "unknown_method", "Unknown host method");
    }
    if (!isValidMessage(request) || request.type !== "request") {
      return this.error(
        typeof candidateId === "string" ? candidateId : "invalid",
        "invalid_request",
        "Invalid host request",
      );
    }
    assertRequest(request);
    if (request.session !== this.session) return this.error(request.id, "session_mismatch", "Session does not match");
    if (request.revision !== this.revision) return this.error(request.id, "revision_conflict", "Host revision does not match");
    if (request.method === "host.ping") return this.reply(request, { pong: true });
    if (request.method === "host.getCapabilities") return this.reply(request, { protocol: "auvra.host/1", methods: ["host.ping", "host.getCapabilities"] });
    return this.error(request.id, "unknown_method", "Unknown host method");
  }
  emitRevision(): Event {
    const event: Event = { protocol: "auvra.host/1", type: "event", event: "host.revision", session: this.session, revision: ++this.revision, payload: {} };
    if (!isValidMessage(event)) throw new Error("Invalid generated event");
    this.listeners.forEach((listener) => listener(event));
    return event;
  }
  subscribe(listener: (event: Event) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  close(): void { this.closed = true; this.listeners.clear(); }
  private reply(request: Request, result: SuccessResult): Response { const response: Response = { protocol: "auvra.host/1", type: "response", id: request.id, session: this.session, revision: this.revision, ok: true, result }; assertResponse(response); return response; }
  private error(id: string, code: ErrorCode, message: string): Response { const safeId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : "invalid"; const response: Response = { protocol: "auvra.host/1", type: "response", id: safeId, session: this.session, revision: this.revision, ok: false, error: { code, message } }; assertResponse(response); return response; }
}
