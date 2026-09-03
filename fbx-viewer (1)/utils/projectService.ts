import { getHostTransport } from '../host/bootstrap';
import type { Event, Response } from '../host/generated/protocolV1';
import { frontendDiagnostics, type DiagnosticContext } from '../diagnostics/runtime';

/** Host-owned project state. Paths and binary data intentionally never enter this type. */
export interface ProjectStatus {
  projectId: string | null;
  name: string | null;
  revision: number;
  dirty: boolean;
  readOnly: boolean;
  busy: boolean;
  progress: number | null;
  recoveryAvailable: boolean;
  recoveryPoints: Array<{ recoveryId: string; kind: 'manual' | 'autosave'; size?: number }>;
  recentProjects: Array<{ projectId: string; name: string }>;
}

export interface ProjectSnapshot {
  revision: number;
  projectId?: string;
  documents?: unknown[];
  cursor?: string;
  hasMore?: boolean;
  domains?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ProjectChange {
  domain: string;
  operation: 'upsert' | 'remove' | 'replace';
  id?: string;
  value?: unknown;
}

export interface AssetTransferOptions {
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
  onPhase?: (phase: 'project_upload' | 'project_record_commit') => void;
  diagnostics?: DiagnosticContext & { assetAlias?: string };
}

type HostLike = {
  session?: string | null;
  currentRevision: number;
  ready?: () => Promise<unknown>;
  request: (request: unknown) => Promise<Response>;
  subscribe: (listener: (event: Event) => void) => () => void;
};

const EMPTY_STATUS: ProjectStatus = {
  projectId: null,
  name: null,
  revision: 0,
  dirty: false,
  readOnly: false,
  busy: false,
  progress: null,
  recoveryAvailable: false,
  recoveryPoints: [],
  recentProjects: [],
};
const QUIET_PROJECT_METHODS = new Set(['project.getStatus', 'project.getSnapshot', 'asset.resolve']);

/**
 * The only browser-side entry point for project persistence. It speaks the
 * versioned host boundary and deliberately has no filesystem, archive, or
 * binary serialization capability.
 */
export class ProjectService {
  private host: HostLike | null;
  private status: ProjectStatus = { ...EMPTY_STATUS };
  private session: string | null = null;
  private requestCounter = 0;
  private requestQueue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(status: ProjectStatus) => void>();
  private unsubscribeHost: (() => void) | null = null;

  constructor(host?: HostLike) {
    this.host = host ?? null;
    if (host) this.unsubscribeHost = host.subscribe((event) => this.handleEvent(event));
  }

  getStatus(): ProjectStatus {
    return {
      ...this.status,
      recoveryPoints: [...this.status.recoveryPoints],
      recentProjects: [...this.status.recentProjects],
    };
  }

  /** Fail before optimistic UI mutations when the host has no writable project. */
  assertWritable(): void {
    this.requireProjectId();
    if (this.status.readOnly) throw new Error('Project is read-only');
  }

  subscribe(listener: (status: ProjectStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  async create(name = 'Untitled', diagnostics?: DiagnosticContext): Promise<ProjectSnapshot | null> {
    return this.call<ProjectSnapshot>('project.create', { name }, diagnostics);
  }
  async open(recoveryId?: string, diagnostics?: DiagnosticContext): Promise<ProjectSnapshot | null> {
    return this.call<ProjectSnapshot>('project.open', { projectHandle: 'dialog', ...(recoveryId ? { recoveryId } : {}) }, diagnostics);
  }
  async openRecent(projectId?: string, recoveryId?: string, diagnostics?: DiagnosticContext): Promise<ProjectSnapshot | null> {
    return this.call<ProjectSnapshot>('project.openRecent', { recentId: projectId || 'dialog', ...(recoveryId ? { recoveryId } : {}) }, diagnostics);
  }
  async recover(recoveryId: string, diagnostics?: DiagnosticContext): Promise<ProjectSnapshot | null> {
    if (!recoveryId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(recoveryId)) throw new Error('Recovery identity is invalid');
    return this.status.projectId
      ? this.openRecent(this.status.projectId, recoveryId, diagnostics)
      : this.open(recoveryId, diagnostics);
  }
  async close(diagnostics?: DiagnosticContext): Promise<void> {
    await this.call('project.close', { projectId: this.requireProjectId(), expectedRevision: this.status.revision }, diagnostics);
    this.setStatus({ ...EMPTY_STATUS });
  }
  /** Refresh the authoritative host status. Empty payload is valid when no project is open. */
  async refreshStatus(): Promise<ProjectStatus> {
    await this.call<ProjectSnapshot>('project.getStatus', this.status.projectId ? { projectId: this.status.projectId } : {});
    return this.getStatus();
  }
  async getSnapshot(domain?: string, cursor?: string, diagnostics?: DiagnosticContext): Promise<ProjectSnapshot | null> {
    const payload: Record<string, unknown> = {};
    payload.projectId = this.requireProjectId();
    if (domain) payload.domain = domain;
    if (cursor) payload.cursor = cursor;
    payload.pageSize = 128;
    return this.call<ProjectSnapshot>('project.getSnapshot', payload, diagnostics);
  }
  async getSnapshotAll(domain?: string, diagnostics?: DiagnosticContext): Promise<ProjectSnapshot | null> {
    const documents: unknown[] = [];
    const domains: Record<string, unknown[]> = {};
    let latest: ProjectSnapshot | null = null;
    let cursor: string | undefined;
    do {
      const page = await this.getSnapshot(domain, cursor, diagnostics);
      if (!page) break;
      latest = page;
      if (Array.isArray(page.documents)) documents.push(...page.documents);
      if (page.domains && typeof page.domains === 'object') {
        for (const [name, value] of Object.entries(page.domains)) {
          const pageDocuments = Array.isArray(value)
            ? value
            : value && typeof value === 'object' && Array.isArray((value as { documents?: unknown[] }).documents)
              ? (value as { documents: unknown[] }).documents
              : [];
          (domains[name] ||= []).push(...pageDocuments);
        }
      }
      cursor = page.hasMore && page.cursor ? page.cursor : undefined;
    } while (cursor);
    if (!latest) return null;
    return { ...latest, documents, domains };
  }
  async applyChanges(changes: ProjectChange[], diagnostics?: DiagnosticContext): Promise<ProjectSnapshot | null> {
    return this.call<ProjectSnapshot>('project.applyChanges', {
      projectId: this.requireProjectId(), expectedRevision: this.status.revision,
      changes: changes.map(sanitizeChange),
    }, diagnostics);
  }
  async save(diagnostics?: DiagnosticContext): Promise<ProjectSnapshot | null> { return this.call<ProjectSnapshot>('project.save', { projectId: this.requireProjectId(), expectedRevision: this.status.revision }, diagnostics); }
  async saveAs(name = this.status.name || 'Untitled', diagnostics?: DiagnosticContext): Promise<ProjectSnapshot | null> { return this.call<ProjectSnapshot>('project.saveAs', { projectId: this.requireProjectId(), expectedRevision: this.status.revision, name }, diagnostics); }
  async exportPack(diagnostics?: DiagnosticContext): Promise<void> { await this.call('project.exportPack', { projectId: this.requireProjectId(), expectedRevision: this.status.revision, destinationHandle: 'dialog' }, diagnostics); }
  async importPack(diagnostics?: DiagnosticContext): Promise<ProjectSnapshot | null> { return this.call<ProjectSnapshot>('project.importPack', { sourceHandle: 'dialog' }, diagnostics); }
  async importLegacy(diagnostics?: DiagnosticContext): Promise<ProjectSnapshot | null> { return this.call<ProjectSnapshot>('project.importLegacy', { sourceHandle: 'dialog' }, diagnostics); }

  async beginAssetUpload(file: Blob, mime: string, name: string, diagnostics?: DiagnosticContext): Promise<{ url: string; method: 'PUT'; mime: string }> {
    const result = await this.call<{ url?: string; method?: string; mime?: string }>('asset.beginUpload', {
      projectId: this.requireProjectId(), expectedRevision: this.status.revision,
      size: file.size, mime, name,
    }, diagnostics);
    if (!result?.url || !/^https:\/\/assets\.auvra\.local\/v1\/put\/[A-Za-z0-9_-]{43}$/.test(result.url)) throw new Error('Host returned an invalid asset upload URL');
    if (result.method !== 'PUT' || result.mime !== mime) throw new Error('Host returned an invalid asset upload ticket');
    return { url: result.url, method: 'PUT', mime: result.mime };
  }

  async resolveAsset(assetId: string, diagnostics?: DiagnosticContext): Promise<string> {
    if (!/^[A-Fa-f0-9]{64}$/.test(assetId)) throw new Error('Asset identity is invalid');
    const result = await this.call<{ url?: string; method?: string }>('asset.resolve', { projectId: this.requireProjectId(), assetId }, diagnostics);
    if (!result?.url || !/^https:\/\/assets\.auvra\.local\/v1\/get\/[A-Za-z0-9_-]{43}$/.test(result.url)) throw new Error('Host returned an invalid asset URL');
    if (result.method !== 'GET') throw new Error('Host returned an invalid asset resolve ticket');
    return result.url;
  }

  async uploadAsset(file: File, options: AssetTransferOptions = {}): Promise<string> {
    if (options.signal?.aborted) throw new DOMException('Asset upload was cancelled.', 'AbortError');
    const mime = file.type || 'application/octet-stream';
    options.onPhase?.('project_upload');
    const ticket = await this.beginAssetUpload(file, mime, file.name, options.diagnostics);
    const assetId = await this.putAsset(ticket, file, options);
    if (!assetId || !/^[A-Fa-f0-9]{64}$/.test(assetId)) throw new Error('Asset upload did not return a verified SHA-256 asset id');
    return assetId.toLowerCase();
  }

  private putAsset(
    ticket: { url: string; method: 'PUT'; mime: string },
    file: File,
    options: AssetTransferOptions,
  ): Promise<string | null> {
    // XMLHttpRequest is deliberately used for this local, ticketed transfer:
    // Fetch has no upload-progress surface. The native WebView handler streams
    // the body on its bounded background owner.
    if (typeof XMLHttpRequest === 'undefined') {
      return fetch(ticket.url, {
        method: ticket.method,
        headers: { 'Content-Type': ticket.mime },
        body: file,
        signal: options.signal,
      }).then((response) => {
        if (!response.ok) throw new Error(`Asset upload failed (${response.status})`);
        options.onProgress?.(1);
        return response.headers.get('X-Auvra-Asset-Sha256');
      });
    }
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = () => {
        request.abort();
        finish(() => reject(new DOMException('Asset upload was cancelled.', 'AbortError')));
      };
      request.open(ticket.method, ticket.url, true);
      request.setRequestHeader('Content-Type', ticket.mime);
      request.upload.onprogress = (event) => {
        const total = event.lengthComputable && event.total > 0 ? event.total : file.size;
        if (total > 0) options.onProgress?.(Math.max(0, Math.min(1, event.loaded / total)));
      };
      request.onload = () => finish(() => {
        if (request.status < 200 || request.status >= 300) {
          reject(new Error(`Asset upload failed (${request.status})`));
          return;
        }
        options.onProgress?.(1);
        resolve(request.getResponseHeader('X-Auvra-Asset-Sha256'));
      });
      request.onerror = () => finish(() => reject(new Error('Asset upload failed.')));
      request.onabort = () => finish(() => reject(new DOMException('Asset upload was cancelled.', 'AbortError')));
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      else request.send(file);
    });
  }


  private call<T = unknown>(method: string, payload: Record<string, unknown>, diagnostics?: DiagnosticContext): Promise<T | null> {
    const span = frontendDiagnostics.startSpan('project', method, {
      context: diagnostics, category: 'service', detailedOnly: QUIET_PROJECT_METHODS.has(method),
    });
    span.phase('queued', { method });
    const run = () => {
      span.phase('executing', { method });
      return this.performCall<T>(method, payload, span.context);
    };
    const result = this.requestQueue.then(run, run);
    this.requestQueue = result.catch(() => undefined);
    void result.then(
      () => span.finish('success', 'project_result'),
      (error) => { span.fail(error, 'project_operation_failed'); span.finish('failure'); },
    );
    return result;
  }

  private async performCall<T = unknown>(method: string, payload: Record<string, unknown>, diagnostics?: DiagnosticContext): Promise<T | null> {
    await this.ensureSession();
    const host = this.getHost();
    if (!this.session) throw new Error('The native project host is not ready');
    const requestNumber = ++this.requestCounter;
    const traceId = diagnostics?.traceId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,100}$/.test(diagnostics.traceId)
      ? diagnostics.traceId : null;
    const request = {
      protocol: 'auvra.host/1', type: 'request',
      id: traceId ? `${traceId}.req-${requestNumber}` : `project-${requestNumber}`,
      session: this.session,
      revision: host.currentRevision,
      method,
      // Preserve the revision captured by the caller. The host, not this
      // queue, owns conflict detection; rebasing here can turn a stale
      // queued mutation into an overwrite of a newer project revision.
      payload,
    };
    const response = await frontendDiagnostics.withContext(
      diagnostics ?? {},
      () => host.request(request),
    );
    if (!response || !(response as unknown as { ok?: boolean }).ok) {
      const error = (response as unknown as { error?: { message?: string; code?: string } })?.error;
      throw new Error(error?.message || error?.code || `Project operation failed: ${method}`);
    }
    const result = (response as unknown as { result?: T }).result ?? null;
    this.updateFromResult(result);
    return result;
  }

  private async ensureSession(): Promise<void> {
    if (this.session) return;
    const host = this.getHost();
    if (host.ready) {
      const envelope = await host.ready() as { session?: string; revision?: number };
      if (envelope?.session) {
        this.session = envelope.session;
        this.publish();
        return;
      }
    }
    if (host.session) this.session = host.session;
  }

  private getHost(): HostLike {
    if (!this.host) {
      this.host = getHostTransport() as unknown as HostLike;
      this.unsubscribeHost = this.host.subscribe((event) => this.handleEvent(event));
    }
    return this.host;
  }

  private handleEvent(event: Event): void {
    const value = event as unknown as { event?: string; session?: string; revision?: number; payload?: Record<string, unknown> };
    if (value.event === 'host.session') {
      this.session = value.session || this.session || this.host?.session || null;
    }
    const payload = value.payload || {};
    if (value.event?.startsWith('project.')) this.updateFromResult(payload);
    if (value.event === 'project.opening' || value.event === 'project.closing') this.setStatus({ ...this.status, busy: true });
    if (value.event === 'project.opened' || value.event === 'project.closed') this.setStatus({ ...this.status, busy: false });
    if (value.event === 'project.recovery') {
      const recoveryId = typeof payload.recoveryId === 'string' ? payload.recoveryId : null;
      const kind: 'manual' | 'autosave' = payload.recoveryKind === 'manual' || payload.recoveryKind === 'autosave' ? payload.recoveryKind : 'autosave';
      const size = typeof payload.size === 'number' ? payload.size : undefined;
      const recoveryPoints = recoveryId && !this.status.recoveryPoints.some((point) => point.recoveryId === recoveryId)
        ? [...this.status.recoveryPoints, { recoveryId, kind, ...(size === undefined ? {} : { size }) }]
        : this.status.recoveryPoints;
      this.setStatus({ ...this.status, recoveryAvailable: true, recoveryPoints });
      if (!recoveryId) void this.refreshStatus().catch(() => undefined);
    }
  }

  private updateFromResult(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const candidate = value as Record<string, unknown>;
    const next: Partial<ProjectStatus> = {};
    if (typeof candidate.revision === 'number') next.revision = candidate.revision;
    if (typeof candidate.projectId === 'string' || candidate.projectId === null) next.projectId = candidate.projectId as string | null;
    if (typeof candidate.name === 'string' || candidate.name === null) next.name = candidate.name as string | null;
    if (typeof candidate.dirty === 'boolean') next.dirty = candidate.dirty;
    if (typeof candidate.readOnly === 'boolean') next.readOnly = candidate.readOnly;
    if (typeof candidate.busy === 'boolean') next.busy = candidate.busy;
    if (typeof candidate.progress === 'number' || candidate.progress === null) next.progress = candidate.progress as number | null;
    if (typeof candidate.recoveryAvailable === 'boolean') next.recoveryAvailable = candidate.recoveryAvailable;
    if (Array.isArray(candidate.recoveryPoints)) {
      next.recoveryPoints = candidate.recoveryPoints as ProjectStatus['recoveryPoints'];
      if (candidate.recoveryAvailable === undefined) next.recoveryAvailable = candidate.recoveryPoints.length > 0;
    }
    if (Array.isArray(candidate.recentProjects)) next.recentProjects = candidate.recentProjects as ProjectStatus['recentProjects'];
    if (Object.keys(next).length) this.setStatus({ ...this.status, ...next });
  }

  private setStatus(status: ProjectStatus): void { this.status = status; this.publish(); }
  private requireProjectId(): string {
    if (!this.status.projectId) throw new Error('No project is open');
    return this.status.projectId;
  }
  private publish(): void { const copy = this.getStatus(); this.listeners.forEach((listener) => listener(copy)); }

  dispose(): void { this.unsubscribeHost?.(); this.unsubscribeHost = null; this.listeners.clear(); }
}

function sanitizeChange(change: ProjectChange): Record<string, unknown> {
  const documentId = change.id || (change.value && typeof change.value === 'object' && typeof (change.value as { id?: unknown }).id === 'string'
    ? (change.value as { id: string }).id : undefined);
  if (!documentId) throw new Error('Project changes require a stable document id');
  const output: Record<string, unknown> = { domain: change.domain, documentId, operation: change.operation };
  if (change.operation !== 'remove') output.document = sanitizeJson(change.value) ?? {};
  return output;
}


/** Keep filesystem paths, Blob instances, object URLs, and data URLs out of JSON. */
function sanitizeJson(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Project JSON cannot contain non-finite numbers');
    if (typeof value === 'string' && (/^(?:https?|blob|data|file):/i.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || /^\/(?:[^/]|$)/.test(value))) throw new Error('Project JSON cannot contain paths, URLs, or binary data');
    return value;
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) throw new Error('Project JSON cannot contain binary blobs');
  if (typeof ArrayBuffer !== 'undefined' && (value instanceof ArrayBuffer || ArrayBuffer.isView(value))) throw new Error('Project JSON cannot contain binary buffers');
  if (Array.isArray(value)) return value.map(sanitizeJson).filter((item) => item !== undefined);
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/^(?:file|animationFiles|object|url|path|filePath|sourcePath|localPath|assetPath|directoryPath|filesystemPath|absolutePath|base64|binary|bytes|blob)$/i.test(key)) throw new Error(`Project JSON cannot contain field ${key}`);
      const clean = sanitizeJson(child);
      if (clean !== undefined) output[key] = clean;
    }
    return output;
  }
  return undefined;
}

frontendDiagnostics.instrumentClass(ProjectService, 'project_service');
export const projectService = new ProjectService();
