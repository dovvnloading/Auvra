import type { Event, Request, Response, Session } from "./generated/protocolV1";
import { assertRequest, assertResponse, isValidMessage } from "./protocol";
import type { HostTransport } from "./transport";
import { frontendDiagnostics, type FrontendDiagnosticSpan } from "../diagnostics/runtime";

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_PENDING = 64;
const MAX_COMPLETED_IDS = 256;
const REQUEST_TIMEOUT_MS = 15_000;
const LONG_REQUEST_TIMEOUT_MS = 120_000;
const LONG_RUNNING_METHODS = new Set<Request['method']>([
  'project.create', 'project.open', 'project.openRecent', 'project.save', 'project.saveAs',
  'project.exportPack', 'project.importPack', 'project.importLegacy',
]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface NativeTransportOptions {
  readonly timeoutMs?: number;
  readonly maxPending?: number;
}

export class NativeTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeTransportError";
  }
}

interface PendingRequest {
  readonly resolve: (response: Response) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly span: FrontendDiagnosticSpan;
}

/**
 * Exact WebView2 message-channel transport. There is deliberately no generic
 * invoke/eval surface: only canonical protocol envelopes cross this boundary.
 */
export class NativeHostTransport implements HostTransport {
  private readonly webview: WebView2Host;
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly completed = new Set<string>();
  private readonly listeners = new Set<(event: Event) => void>();
  private readonly readyRejectors = new Set<(error: Error) => void>();
  private readonly completedOrder: string[] = [];
  private sessionEnvelope: Session | null = null;
  private closed = false;
  private revision = 0;

  constructor(webview?: WebView2Host, options: NativeTransportOptions = {}) {
    const resolvedWebview = webview ?? globalThis.window?.chrome?.webview;
    if (!resolvedWebview || typeof resolvedWebview.postMessage !== "function" || typeof resolvedWebview.addEventListener !== "function") {
      throw new NativeTransportError("WebView2 native message channel is unavailable");
    }
    this.webview = resolvedWebview;
    this.timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? REQUEST_TIMEOUT_MS, 120_000));
    this.maxPending = Math.max(1, Math.min(options.maxPending ?? MAX_PENDING, MAX_PENDING));
    this.webview.addEventListener("message", this.handleMessage);
  }

  get session(): string | null {
    return this.sessionEnvelope?.session ?? null;
  }

  get currentRevision(): number {
    return this.revision;
  }

  /** Resolves only after the native host has supplied its authoritative session. */
  async ready(): Promise<Session> {
    if (this.closed) return Promise.reject(new NativeTransportError("Host transport is closed"));
    if (this.sessionEnvelope) return this.sessionEnvelope;
    return new Promise<Session>((resolve, reject) => {
      let unsubscribe = (): void => undefined;
      const rejectReady = (error: Error): void => {
        clearTimeout(timer);
        this.readyRejectors.delete(rejectReady);
        unsubscribe();
        reject(error);
      };
      const timer = setTimeout(() => {
        this.readyRejectors.delete(rejectReady);
        unsubscribe();
        reject(new NativeTransportError("Timed out waiting for native host session"));
      }, this.timeoutMs);
      this.readyRejectors.add(rejectReady);
      unsubscribe = this.subscribe((event) => {
        if (event.event !== "host.session") return;
        clearTimeout(timer);
        this.readyRejectors.delete(rejectReady);
        unsubscribe();
        if (this.sessionEnvelope) resolve(this.sessionEnvelope);
        else reject(new NativeTransportError("Native session was not accepted"));
      });
      if (this.closed) {
        clearTimeout(timer);
        this.readyRejectors.delete(rejectReady);
        unsubscribe();
        reject(new NativeTransportError("Host transport is closed"));
      }
    });
  }

  request(request: Request): Promise<Response> {
    if (this.closed) return Promise.reject(new NativeTransportError("Host transport is closed"));
    if (this.pending.size >= this.maxPending) return Promise.reject(new NativeTransportError("Too many pending host requests"));
    try {
      assertRequest(request);
    } catch {
      return Promise.reject(new NativeTransportError("Invalid host request"));
    }
    if (!this.sessionEnvelope || request.session !== this.sessionEnvelope.session || request.revision !== this.revision) {
      return Promise.reject(new NativeTransportError("Host session or revision is not current"));
    }
    if (!ID_PATTERN.test(request.id) || this.pending.has(request.id) || this.completed.has(request.id)) {
      return Promise.reject(new NativeTransportError("Duplicate or invalid host request id"));
    }
    const encodedSize = this.messageSize(request);
    if (encodedSize > MAX_MESSAGE_BYTES) return Promise.reject(new NativeTransportError("Host request exceeds message limit"));

    const span = frontendDiagnostics.startSpan('host', 'request', {
      context: frontendDiagnostics.currentContext(), category: 'boundary',
      detailedOnly: !LONG_RUNNING_METHODS.has(request.method),
    });
    span.phase('queued', { method: request.method, queueDepth: this.pending.size });

    return new Promise<Response>((resolve, reject) => {
      const requestTimeout = LONG_RUNNING_METHODS.has(request.method)
        ? Math.max(this.timeoutMs, LONG_REQUEST_TIMEOUT_MS)
        : this.timeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        this.rememberCompleted(request.id);
        span.fail(undefined, 'request_timeout');
        span.finish('failure');
        frontendDiagnostics.transportFailure('request_timeout', request.method, undefined, requestTimeout);
        reject(new NativeTransportError("Host request timed out"));
      }, requestTimeout);
      this.pending.set(request.id, { resolve, reject, timer, span });
      try {
        span.phase('dispatching', { method: request.method });
        this.webview.postMessage(request);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(request.id);
        this.rememberCompleted(request.id);
        span.fail(error, 'post_message_failed');
        span.finish('failure');
        frontendDiagnostics.transportFailure('post_message_failed', request.method, error);
        reject(new NativeTransportError("Host request failed"));
      }
    });
  }

  subscribe(listener: (event: Event) => void): () => void {
    if (this.closed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.webview.removeEventListener("message", this.handleMessage);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.span.fail(undefined, 'transport_closed');
      pending.span.finish('cancelled');
      pending.reject(new NativeTransportError("Host transport closed"));
      this.rememberCompleted(id);
    }
    this.pending.clear();
    for (const reject of Array.from(this.readyRejectors)) reject(new NativeTransportError("Host transport closed"));
    this.readyRejectors.clear();
    this.listeners.clear();
    frontendDiagnostics.setSession(null);
  }

  private readonly handleMessage = (messageEvent: WebView2MessageEvent): void => {
    if (this.closed) return;
    const value = messageEvent.data;
    if (value && typeof value === 'object' && (value as { protocol?: unknown }).protocol === 'auvra.diagnostics/1') {
      return;
    }
    if (this.messageSize(value) > MAX_MESSAGE_BYTES || !isValidMessage(value)) {
      this.failClosed("Malformed or oversized host message");
      return;
    }
    if (value.type === "session") {
      this.acceptSession(value);
      return;
    }
    if (!this.sessionEnvelope || value.session !== this.sessionEnvelope.session) {
      this.failClosed("Host message session mismatch");
      return;
    }
    if (value.revision < this.revision) {
      this.failClosed("Late host message revision");
      return;
    }
    if (value.type === "response") {
      this.acceptResponse(value);
      return;
    }
    if (value.type !== "event") {
      this.failClosed("Unexpected host message type");
      return;
    }
    this.revision = value.revision;
    this.notify(value);
  };

  private acceptSession(session: Session): void {
    if (session.status === "closed") {
      this.failClosed("Native host closed the session");
      return;
    }
    if (this.sessionEnvelope && this.sessionEnvelope.session !== session.session) {
      this.failClosed("Native host attempted to replace the session");
      return;
    }
    if (session.revision < this.revision) {
      this.failClosed("Late native session envelope");
      return;
    }
    this.sessionEnvelope = session;
    frontendDiagnostics.setSession(session.session);
    this.revision = session.revision;
    const event: Event = {
      protocol: "auvra.host/1",
      type: "event",
      event: "host.session",
      session: session.session,
      revision: session.revision,
      payload: {},
    };
    this.notify(event);
  }

  private acceptResponse(response: Response): void {
    const pending = this.pending.get(response.id);
    if (!pending || this.completed.has(response.id)) {
      this.failClosed("Late or duplicate host response");
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    this.rememberCompleted(response.id);
    this.revision = response.revision;
    if (response.ok) pending.span.finish('success', 'response');
    else {
      const error = 'error' in response ? response.error : undefined;
      pending.span.fail(undefined, error?.code || 'host_request_failed');
      pending.span.finish('failure');
    }
    pending.resolve(response);
  }

  private failClosed(message: string): void {
    frontendDiagnostics.transportFailure('protocol_closed', undefined, new NativeTransportError(message));
    this.close();
    // Keep protocol failures generic; payloads must never be reflected to
    // logs/UI, and a transport failure must not be disguised as a valid event.
    void message;
  }

  private notify(event: Event): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch {
        this.failClosed("Host event listener failed");
        return;
      }
    }
  }

  private rememberCompleted(id: string): void {
    if (this.completed.has(id)) return;
    this.completed.add(id);
    this.completedOrder.push(id);
    while (this.completedOrder.length > MAX_COMPLETED_IDS) {
      const evicted = this.completedOrder.shift();
      if (evicted) this.completed.delete(evicted);
    }
  }

  private messageSize(value: unknown): number {
    try {
      const json = JSON.stringify(value);
      return typeof json === "string" ? new TextEncoder().encode(json).byteLength : MAX_MESSAGE_BYTES + 1;
    } catch {
      return MAX_MESSAGE_BYTES + 1;
    }
  }
}
