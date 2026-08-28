/// <reference path="../host/webview2.d.ts" />

export type DiagnosticComponent = 'frontend' | 'worker' | 'operation' | 'renderer';
export type DiagnosticScalar = null | boolean | number | string;
export type DiagnosticValue = DiagnosticScalar | DiagnosticScalar[];
export type DiagnosticAttributes = Record<string, DiagnosticValue>;

export interface DiagnosticContext {
  operationId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
}

interface BrowserRecord extends DiagnosticContext {
  component: DiagnosticComponent;
  event: string;
  attributes: DiagnosticAttributes;
}

interface PendingBatch {
  count: number;
  timer: ReturnType<typeof setTimeout>;
}

const PROTOCOL = 'auvra.diagnostics/1';
const MAX_RECORDS = 256;
const MAX_BUFFER_BYTES = 512 * 1024;
const MAX_RECORD_BYTES = 2 * 1024;
const MAX_BATCH_RECORDS = 16;
const MAX_BATCH_BYTES = 32 * 1024;
const MAX_PENDING_BATCHES = 4;
const FLUSH_MS = 250;
const ACK_TIMEOUT_MS = 5_000;
const HEARTBEAT_MS = 1_000;
const EVENT_LOOP_STALL_MS = 2_500;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const ATTRIBUTE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const FILE_LIKE = /\.(?:fbx|gltf|glb|png|jpe?g|webp|wav|mp3|ogg|flac|auvra)$/i;
const URL_OR_PATH = /(?:\b(?:https?|file|data|blob):\/\/|(?:^|\s)[A-Za-z]:[\\/]|\\\\|(?:^|\s)\/(?:[^\s/]+\/)+)/i;
const SAFE_ATTRIBUTE_KEYS = new Set([
  'phase', 'outcome', 'durationMs', 'code', 'errorType', 'method', 'status',
  'success', 'timeoutMs', 'queueDepth', 'queueCapacity', 'fallback', 'backend',
  'fallbackReason', 'count', 'bytes', 'operationKind', 'stallMs', 'escalation',
  'state', 'assetAlias', 'assetKind', 'mimeCategory', 'extensionCategory',
  'itemCount', 'clipCount', 'bindingMode', 'progressBucket', 'workerState',
  'queueState', 'activeCount', 'visibility', 'averageFrameMs', 'p95FrameMs',
  'budgetMs', 'failedDeliveryCount', 'batchCount', 'surfaceRole', 'reason',
]);

const encodedSize = (value: unknown): number => {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === 'string' ? new TextEncoder().encode(encoded).byteLength : Number.MAX_SAFE_INTEGER;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
};

export const diagnosticErrorType = (error: unknown): string => {
  if (error instanceof DOMException || error instanceof Error) {
    return CODE_PATTERN.test(error.name) || /^[A-Z][A-Za-z0-9]{0,63}$/.test(error.name)
      ? error.name.slice(0, 64)
      : 'Error';
  }
  return typeof error === 'string' ? 'StringError' : 'UnknownError';
};

export const assetDiagnosticAttributes = (
  file: Blob & { name?: string; type: string },
  assetKind: 'model' | 'animation' | 'attachment' | 'texture' | 'audio',
  assetAlias: string,
): DiagnosticAttributes => {
  const extension = typeof file.name === 'string' ? file.name.split('.').pop()?.toLowerCase() : undefined;
  const extensionCategory = extension && /^(?:fbx|gltf|glb|png|jpg|jpeg|webp|wav|mp3|ogg|flac)$/.test(extension)
    ? extension.replace('jpeg', 'jpg') : 'other';
  const primaryMime = file.type.split('/')[0]?.toLowerCase();
  const mimeCategory = ['model', 'image', 'audio', 'application'].includes(primaryMime) ? primaryMime : 'other';
  return { assetAlias, assetKind, extensionCategory, mimeCategory, bytes: file.size };
};

const safeString = (value: string): string | null => {
  if (!value || value.length > 256 || !ATTRIBUTE_TEXT.test(value) || FILE_LIKE.test(value) || URL_OR_PATH.test(value)) return null;
  return value;
};

const safeAttributes = (attributes: DiagnosticAttributes): DiagnosticAttributes => {
  const result: DiagnosticAttributes = {};
  for (const [key, raw] of Object.entries(attributes).slice(0, 16)) {
    if (!SAFE_ATTRIBUTE_KEYS.has(key)) continue;
    if (Array.isArray(raw)) {
      const values = raw.slice(0, 16).map((value) => (
        typeof value === 'string' ? safeString(value) : value
      )).filter((value): value is DiagnosticScalar => value !== null);
      result[key] = values;
    } else if (typeof raw === 'string') {
      const value = safeString(raw);
      if (value !== null) result[key] = value;
    } else if (raw === null || typeof raw === 'boolean' || (typeof raw === 'number' && Number.isFinite(raw))) {
      result[key] = raw;
    }
  }
  return result;
};

class FrontendDiagnostics {
  private readonly webview = typeof window === 'undefined' ? undefined : window.chrome?.webview;
  private readonly records: Array<{ value: BrowserRecord; bytes: number }> = [];
  private readonly pending = new Map<string, PendingBatch>();
  private bufferBytes = 0;
  private failedDeliveryCount = 0;
  private batchCounter = 0;
  private assetCounter = 0;
  private activeCount = 0;
  private session: string | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeat = 0;
  private eventLoopStalledAt: number | null = null;
  private started = false;

  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    this.lastHeartbeat = performance.now();
    this.webview?.addEventListener('message', this.onMessage);
    window.addEventListener('error', this.onGlobalError);
    window.addEventListener('unhandledrejection', this.onUnhandledRejection);
    window.addEventListener('beforeunload', this.onBeforeUnload);
    document.addEventListener('visibilitychange', this.sendHeartbeat);
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
    this.heartbeatTimer = setInterval(this.heartbeat, HEARTBEAT_MS);
    this.record('frontend', 'frontend.session_started', {
      state: 'ready', visibility: this.visibility(),
    });
    this.sendHeartbeat();
  }

  stop(): void {
    if (!this.started || typeof window === 'undefined') return;
    this.onBeforeUnload();
    this.started = false;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.flushTimer = null;
    this.heartbeatTimer = null;
    this.webview?.removeEventListener('message', this.onMessage);
    window.removeEventListener('error', this.onGlobalError);
    window.removeEventListener('unhandledrejection', this.onUnhandledRejection);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    document.removeEventListener('visibilitychange', this.sendHeartbeat);
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
  }

  setSession(session: string | null): void {
    this.session = session && ID_PATTERN.test(session) ? session : null;
  }

  setActiveOperations(count: number): void {
    this.activeCount = Math.max(0, Math.min(64, Math.floor(count)));
  }

  nextAssetAlias(): string {
    this.assetCounter += 1;
    return `asset-${this.assetCounter}`;
  }

  record(component: DiagnosticComponent, event: string, attributes: DiagnosticAttributes = {},
         context: DiagnosticContext = {}, immediate = false): void {
    if (!CODE_PATTERN.test(event) || !['frontend', 'worker', 'operation', 'renderer'].includes(component)) return;
    const value: BrowserRecord = { component, event, attributes: safeAttributes(attributes) };
    for (const key of ['operationId', 'traceId', 'spanId', 'parentSpanId'] as const) {
      const candidate = context[key];
      if (candidate && ID_PATTERN.test(candidate)) value[key] = candidate;
    }
    const bytes = encodedSize(value);
    if (bytes > MAX_RECORD_BYTES) {
      this.failedDeliveryCount += 1;
      return;
    }
    while (this.records.length >= MAX_RECORDS || this.bufferBytes + bytes > MAX_BUFFER_BYTES) {
      const removed = this.records.shift();
      if (!removed) break;
      this.bufferBytes -= removed.bytes;
      this.failedDeliveryCount += 1;
    }
    this.records.push({ value, bytes });
    this.bufferBytes += bytes;
    if (immediate) queueMicrotask(() => this.flush());
  }

  failure(code: string, error?: unknown): void {
    this.record('frontend', 'frontend.failure', {
      code: CODE_PATTERN.test(code) ? code : 'frontend_failure',
      errorType: diagnosticErrorType(error),
    }, {}, true);
  }

  warning(code: string, count = 1): void {
    this.record('frontend', 'frontend.warning', {
      code: CODE_PATTERN.test(code) ? code : 'frontend_warning', count,
    });
  }

  transportFailure(code: string, method?: string, error?: unknown, timeoutMs?: number): void {
    this.record('frontend', 'frontend.transport_failed', {
      code: CODE_PATTERN.test(code) ? code : 'transport_failure',
      errorType: diagnosticErrorType(error),
      ...(method && CODE_PATTERN.test(method) ? { method } : {}),
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    }, {}, true);
  }

  private flush(): void {
    if (!this.webview || !this.records.length || this.pending.size >= MAX_PENDING_BATCHES) return;
    const selected: Array<{ value: BrowserRecord; bytes: number }> = [];
    let batchBytes = 0;
    while (this.records.length && selected.length < MAX_BATCH_RECORDS) {
      const candidate = this.records[0];
      if (selected.length && batchBytes + candidate.bytes > MAX_BATCH_BYTES - 512) break;
      selected.push(this.records.shift()!);
      this.bufferBytes -= candidate.bytes;
      batchBytes += candidate.bytes;
    }
    if (!selected.length) return;
    const id = `diag-batch-${++this.batchCounter}`;
    const lost = this.failedDeliveryCount;
    const envelope = {
      protocol: PROTOCOL,
      type: 'event-batch',
      id,
      records: selected.map((item) => item.value),
      ...(lost ? { failedDeliveryCount: lost } : {}),
    };
    if (encodedSize(envelope) > MAX_BATCH_BYTES) {
      this.failedDeliveryCount += selected.length;
      return;
    }
    try {
      this.webview.postMessage(envelope);
      this.failedDeliveryCount = 0;
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        this.failedDeliveryCount += pending.count;
      }, ACK_TIMEOUT_MS);
      this.pending.set(id, { count: selected.length, timer });
    } catch {
      this.failedDeliveryCount += selected.length;
    }
  }

  private readonly onMessage = (event: WebView2MessageEvent): void => {
    const value = event.data as { protocol?: unknown; type?: unknown; id?: unknown; ok?: unknown } | null;
    if (!value || value.protocol !== PROTOCOL || value.type !== 'response' || typeof value.id !== 'string') return;
    const pending = this.pending.get(value.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(value.id);
    if (value.ok !== true) this.failedDeliveryCount += pending.count;
    if (this.records.length) queueMicrotask(() => this.flush());
  };

  private readonly heartbeat = (): void => {
    const now = performance.now();
    const elapsed = now - this.lastHeartbeat;
    this.lastHeartbeat = now;
    if (this.visibility() === 'active' && elapsed >= EVENT_LOOP_STALL_MS) {
      this.eventLoopStalledAt = now - elapsed;
      this.record('frontend', 'frontend.event_loop_stalled', {
        durationMs: elapsed, visibility: 'active',
      }, {}, true);
    } else if (this.eventLoopStalledAt !== null) {
      this.record('frontend', 'frontend.event_loop_recovered', {
        durationMs: now - this.eventLoopStalledAt,
      }, {}, true);
      this.eventLoopStalledAt = null;
    }
    this.sendHeartbeat();
  };

  private readonly sendHeartbeat = (): void => {
    if (!this.webview) return;
    try {
      this.webview.postMessage({
        protocol: PROTOCOL,
        type: 'heartbeat',
        visibility: this.visibility(),
        activeCount: this.activeCount,
      });
    } catch {
      // The next accepted event batch reports delivery loss; heartbeats stay silent.
    }
  };

  private visibility(): 'active' | 'hidden' | 'starting' | 'closing' {
    if (!this.started) return 'starting';
    return document.visibilityState === 'hidden' ? 'hidden' : 'active';
  }

  private readonly onGlobalError = (event: ErrorEvent): void => {
    this.record('frontend', 'frontend.global_error', {
      code: 'global_error', errorType: diagnosticErrorType(event.error),
    }, {}, true);
  };

  private readonly onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    this.record('frontend', 'frontend.unhandled_rejection', {
      code: 'unhandled_rejection', errorType: diagnosticErrorType(event.reason),
    }, {}, true);
  };

  private readonly onBeforeUnload = (): void => {
    if (this.webview) {
      try {
        this.webview.postMessage({ protocol: PROTOCOL, type: 'heartbeat', visibility: 'closing', activeCount: 0 });
      } catch { /* bounded shutdown */ }
    }
    this.flush();
  };
}

export const frontendDiagnostics = new FrontendDiagnostics();
