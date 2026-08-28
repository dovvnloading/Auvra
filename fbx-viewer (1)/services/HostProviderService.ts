import { getHostTransport } from '../host/bootstrap';
import { projectService } from '../utils/projectService';
import { frontendDiagnostics } from '../diagnostics/runtime';

const QUIET_PROVIDER_METHODS = new Set([
  'provider.list', 'provider.getStatus', 'provider.listModels', 'provider.health',
  'inference.get', 'inference.list',
]);

/**
 * Stage 4 deliberately talks to the native host through a tiny structural
 * seam. Generated protocol types are allowed to grow independently; the UI
 * only knows that requests are versioned envelopes and that responses contain
 * an `ok` bit. Provider credentials and provider payloads never cross this
 * module into browser storage.
 */
export type ProviderRoute = 'cloud' | 'local';
export type ProviderCapability = 'media.generate' | 'media.edit' | 'text' | 'code' | 'commands';
export type CredentialStatus = 'configured' | 'memoryOnly' | 'absent' | 'notRequired' | 'unavailable';

export interface ProviderSettings {
  enabled: boolean;
  routes: Array<{ capability: ProviderCapability; modelId: string }>;
  fallbackPolicy: 'none';
  requireCostConfirmation: boolean;
  budgets: { perJobMicroUsd: number; dailyMicroUsd: number; monthlyMicroUsd: number };
  endpoint?: string;
}

export interface ProviderSettingsResult extends Omit<ProviderSettings, 'endpoint'> { endpointConfigured?: boolean; }

export interface ProviderDescriptor {
  id: string;
  name: string;
  route: ProviderRoute;
  capabilities: ProviderCapability[];
  configured?: boolean;
  credentialStatus?: CredentialStatus;
  requiresCredential?: boolean;
  settingsRevision?: number;
  settings?: ProviderSettingsResult;
  pricing?: { unit?: string; estimate?: number | null; currency?: string };
  [key: string]: unknown;
}

export interface ProviderModel {
  id: string;
  name?: string;
  providerId?: string;
  capabilities?: ProviderCapability[];
  route?: ProviderRoute;
  [key: string]: unknown;
}

export interface ProviderHealth {
  providerId: string;
  status: 'healthy' | 'degraded' | 'unavailable' | 'unknown';
  latencyMs?: number;
  message?: string;
  [key: string]: unknown;
}

export interface InferenceJob {
  jobId: string;
  status: 'queued' | 'submitting' | 'running' | 'succeeded' | 'failed' | 'cancel_requested' | 'cancelled' | 'recovering' | 'unknown';
  progress?: number;
  providerId?: string;
  modelId?: string;
  route?: ProviderRoute;
  capability?: string;
  result?: unknown;
  error?: { code?: string; message?: string; retryable?: boolean };
  [key: string]: unknown;
}

export interface MediaPreview {
  assetId?: string;
  previewAssetId?: string;
  mime?: string;
  size?: number;
  dimensions?: { width: number; height: number };
  provenance?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CommandProposal {
  proposalId: string;
  summary?: string;
  diff?: unknown;
  commands?: unknown[];
  revision?: number;
  [key: string]: unknown;
}

type HostResponse = {
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string; details?: unknown };
  revision?: number;
};

type HostBridge = {
  request(request: unknown): Promise<HostResponse>;
  subscribe?(listener: (event: unknown) => void): () => void;
  ready?: () => Promise<{ session?: string; revision?: number }>;
  session?: string | null;
  currentRevision?: number;
};

const safeResult = <T>(value: unknown): T => (value ?? {}) as T;

export class HostProviderError extends Error {
  readonly code?: string;
  readonly retryable?: boolean;
  constructor(message: string, code?: string, retryable?: boolean) {
    super(message);
    this.name = 'HostProviderError';
    this.code = code;
    this.retryable = retryable;
  }
}

export class HostProviderService {
  private host: HostBridge | null;
  private session: string | null = null;
  private revision = 0;
  private projectRevision = projectService.getStatus().revision;
  private sequence = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly progressListeners = new Set<(job: InferenceJob) => void>();
  private readonly providerEventListeners = new Set<(event: { event: string; payload: unknown }) => void>();
  private readonly providerRoutes = new Map<string, ProviderRoute>();
  private configuredModels: Partial<Record<ProviderCapability, { providerId: string; modelId: string; route: ProviderRoute }>> = {};
  private configurationHydrated = false;
  private configurationLoad: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(host?: HostBridge) {
    this.host = host ?? null;
    if (host?.subscribe) this.unsubscribe = host.subscribe((event) => this.handleEvent(event));
  }

  subscribe(listener: (job: InferenceJob) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }
  subscribeProviderEvents(listener: (event: { event: string; payload: unknown }) => void): () => void {
    this.providerEventListeners.add(listener); return () => this.providerEventListeners.delete(listener);
  }

  async listProviders(): Promise<ProviderDescriptor[]> {
    const result = await this.call<unknown>('provider.list', {});
    const rows = Array.isArray(result) ? result : (result as { providers?: unknown[] })?.providers;
    if (!Array.isArray(rows)) return [];
    const normalized = rows.map(normalizeProvider);
    normalized.forEach((provider) => this.providerRoutes.set(provider.id, provider.route));
    return normalized;
  }

  async getProviderStatus(providerId: string): Promise<ProviderDescriptor> {
    if (!providerId) throw new HostProviderError('Choose a provider before requesting status.', 'provider_unavailable');
    const result = await this.call<unknown>('provider.getStatus', { providerId });
    const route = this.providerRoutes.get(providerId);
    return normalizeProvider(route ? { ...(result as Record<string, unknown>), route } : result);
  }

  /** Opens the OS-native credential prompt. Secret text is intentionally not accepted. */
  async configureCredential(providerId: string, options: { remember?: boolean; memoryOnly?: boolean } = {}): Promise<unknown> {
    return this.call('provider.configureCredential', { providerId, storageMode: options.memoryOnly ? 'memoryOnly' : 'osVault' });
  }

  async deleteCredential(providerId: string): Promise<unknown> {
    return this.call('provider.deleteCredential', { providerId });
  }

  async configure(providerId: string, options: ProviderSettings, expectedSettingsRevision = 0): Promise<unknown> {
    const route = this.providerRoutes.get(providerId);
    if (!route) throw new HostProviderError('Refresh the host provider registry before saving settings.', 'provider_unavailable');
    const result = await this.call('provider.configure', { providerId, expectedSettingsRevision, settings: options });
    this.clearConfiguration(providerId);
    if (!options.enabled) return result;
    options.routes.forEach(({ capability, modelId }) => {
      if (modelId && capability && route) {
        this.configuredModels[capability] = { providerId, modelId, route };
      }
    });
    return result;
  }

  async listModels(providerId: string, capability?: ProviderCapability): Promise<ProviderModel[]> {
    if (!providerId) throw new HostProviderError('Choose a provider before listing models.', 'provider_unavailable');
    const result = await this.call<unknown>('provider.listModels', {
      providerId, ...(capability ? { capability } : {}),
    });
    const rows = Array.isArray(result) ? result : (result as { models?: unknown[] })?.models;
    return Array.isArray(rows) ? rows.map(normalizeModel) :
      [];
  }

  async health(providerId: string): Promise<ProviderHealth> {
    if (!providerId) throw new HostProviderError('Choose a provider before checking health.', 'provider_unavailable');
    const result = await this.call<unknown>('provider.health', { providerId });
    return normalizeHealth(result);
  }

  async submitInference(payload: Record<string, unknown>): Promise<InferenceJob> {
    const capability = payload.capability as ProviderCapability;
    await this.ensureConfiguredRoutes();
    const configured = this.configuredModels[capability];
    if (!configured) throw new HostProviderError('Configure a provider and model for this capability in Settings first.', 'provider_not_configured');
    if (configured.route === 'cloud' && payload.consent !== 'explicit') throw new HostProviderError('Explicit cost consent is required before submitting cloud work.');
    // Route and model are always sourced from host-backed Settings state. A
    // component cannot silently select a browser-only provider or fallback.
    const effective = { ...payload, providerId: configured.providerId, modelId: configured.modelId, route: configured.route };
    return normalizeJob(await this.call('inference.submit', this.withProjectRevision(effective)));
  }

  async getInference(jobId: string): Promise<InferenceJob> {
    return normalizeJob(await this.call('inference.get', this.withProjectId({ jobId })));
  }

  async listInference(payload: Record<string, unknown> = {}): Promise<InferenceJob[]> {
    const result = await this.call<unknown>('inference.list', this.withProjectId(payload));
    const rows = Array.isArray(result) ? result : (result as { jobs?: unknown[] })?.jobs;
    return Array.isArray(rows) ? rows.map(normalizeJob) :
      [];
  }

  async cancelInference(jobId: string): Promise<InferenceJob> {
    return normalizeJob(await this.call('inference.cancel', this.withProjectId({ jobId })));
  }

  async retryInference(jobId: string): Promise<InferenceJob> {
    return normalizeJob(await this.call('inference.retry', this.withProjectRevision({ jobId, consent: 'same-route' })));
  }

  async discardMedia(assetId: string, jobId: string): Promise<unknown> {
    const status = projectService.getStatus();
    return this.call('media.discard', { projectId: status.projectId, jobId, previewAssetId: assetId });
  }
  async commitMedia(payload: Record<string, unknown>): Promise<MediaPreview> { return safeResult(await this.call('media.commit', this.withProjectRevision(payload))); }

  async previewCommand(payload: Record<string, unknown>): Promise<CommandProposal> {
    return safeResult(await this.call('command.preview', this.withProjectRevision(payload)));
  }
  async approveCommand(payload: Record<string, unknown>): Promise<unknown> { return this.call('command.approve', this.withProjectRevision(payload)); }
  async undoCommand(payload: Record<string, unknown>): Promise<unknown> { return this.call('command.undo', this.withProjectRevision(payload)); }

  dispose(): void { this.unsubscribe?.(); this.unsubscribe = null; this.progressListeners.clear(); this.providerEventListeners.clear(); this.providerRoutes.clear(); this.configuredModels = {}; this.configurationHydrated = false; this.configurationLoad = null; }

  getConfiguredRoute(capability: ProviderCapability): { providerId: string; modelId: string; route: ProviderRoute } | null { return this.configuredModels[capability] || null; }
  hydrateConfiguration(providerId: string, route: ProviderRoute, settings?: ProviderSettingsResult | Record<string, unknown>): void {
    this.clearConfiguration(providerId);
    if (settings?.enabled === false) return;
    const routes = Array.isArray(settings?.routes) ? settings.routes as Array<{ capability?: string; modelId?: string }> : [];
    routes.forEach(({ capability, modelId }) => { if (capability && modelId && ['text', 'code', 'commands', 'media.generate', 'media.edit'].includes(capability)) this.configuredModels[capability as ProviderCapability] = { providerId, modelId, route }; });
  }
  clearConfiguration(providerId: string): void { Object.keys(this.configuredModels).forEach((capability) => { if (this.configuredModels[capability as ProviderCapability]?.providerId === providerId) delete this.configuredModels[capability as ProviderCapability]; }); }

  private async ensureConfiguredRoutes(): Promise<void> {
    if (this.configurationHydrated) return;
    if (!this.configurationLoad) {
      this.configurationLoad = (async () => {
        const providers = await this.listProviders();
        const statuses = await Promise.all(providers.map((provider) => this.getProviderStatus(provider.id)));
        statuses.forEach((status) => this.hydrateConfiguration(status.id, status.route, status.settings));
        this.configurationHydrated = true;
      })().finally(() => { this.configurationLoad = null; });
    }
    await this.configurationLoad;
  }

  private async ensureSession(host: HostBridge): Promise<void> {
    if (this.session) return;
    if (host.ready) {
      const envelope = await host.ready();
      if (envelope?.session) {
        this.session = envelope.session;
        this.revision = envelope.revision ?? this.revision;
        return;
      }
    }
    this.session = host.session ?? null;
    this.revision = host.currentRevision ?? this.revision;
    if (!this.session) throw new HostProviderError('The native provider host is not ready', 'host_not_ready', true);
  }

  private async getHost(): Promise<HostBridge> {
    if (!this.host) {
      this.host = getHostTransport() as unknown as HostBridge;
      if (this.host.subscribe) this.unsubscribe = this.host.subscribe((event) => this.handleEvent(event));
    }
    await this.ensureSession(this.host);
    return this.host;
  }

  private call<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T> {
    const span = frontendDiagnostics.startSpan('provider', method, {
      category: 'service', detailedOnly: QUIET_PROVIDER_METHODS.has(method),
    });
    span.phase('queued', { method });
    const run = async (): Promise<T> => {
      span.phase('executing', { method });
      const host = await this.getHost();
      const wireRevision = typeof host.currentRevision === 'number' ? host.currentRevision : this.revision;
      this.revision = wireRevision;
      const response = await frontendDiagnostics.withContext(span.context, () => host.request({
        protocol: 'auvra.host/1', type: 'request',
        id: `${span.context.traceId}.req-${++this.sequence}`,
        session: this.session, revision: wireRevision, method, payload,
      }));
      if (typeof response.revision === 'number') this.revision = response.revision;
      const responseResult = response.result && typeof response.result === 'object' ? response.result as Record<string, unknown> : {};
      if (typeof responseResult.projectRevision === 'number') this.projectRevision = responseResult.projectRevision;
      if (!response.ok) throw new HostProviderError(
        response.error?.message || response.error?.code || `Provider operation failed: ${method}`,
        response.error?.code,
        Boolean((response.error?.details as { retryable?: unknown })?.retryable),
      );
      return safeResult<T>(response.result);
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    void result.then(
      () => span.finish('success', 'provider_result'),
      (error) => { span.fail(error, 'provider_operation_failed'); span.finish('failure'); },
    );
    return result;
  }

  private handleEvent(event: unknown): void {
    const value = event as { event?: string; revision?: number; payload?: unknown };
    if (typeof value.revision === 'number') this.revision = value.revision;
    if (value.event !== 'provider.progress' && value.event !== 'provider.job' && value.event !== 'provider.status' && value.event !== 'provider.recovery') return;
    const payload = value.payload && typeof value.payload === 'object' ? value.payload : {};
    this.providerEventListeners.forEach((listener) => listener({ event: value.event || 'provider.status', payload }));
    const job = normalizeJob(payload);
    if (job.jobId) this.progressListeners.forEach((listener) => listener(job));
  }
  private withProjectRevision(payload: Record<string, unknown>): Record<string, unknown> {
  const status = projectService.getStatus();
  // ProjectService is the authority for the current project revision. Never
  // carry a revision from a previous project or a concurrent host mutation.
  this.projectRevision = status.revision;
  return { ...payload, ...(status.projectId ? { projectId: status.projectId } : {}), expectedRevision: this.projectRevision };
  }
  private withProjectId(payload: Record<string, unknown>): Record<string, unknown> {
    const projectId = projectService.getStatus().projectId;
    return { ...payload, ...(projectId ? { projectId } : {}) };
  }
}

function normalizeProvider(value: unknown): ProviderDescriptor {
  const row = safeResult<Record<string, unknown>>(value);
  const id = String(row.id || row.providerId || '');
  if (row.route !== 'local' && row.route !== 'cloud') throw new HostProviderError('The host returned an invalid provider route.', 'provider_unavailable');
  const route = row.route as ProviderRoute;
  const credential = row.credentialStatus;
  const credentialState = credential && typeof credential === 'object'
    ? (credential as { state?: unknown }).state
    : credential;
  const configured = Boolean(row.configured) || credentialState === 'osVault' || credentialState === 'memoryOnly' || credentialState === 'configured';
  const credentialStatus: CredentialStatus = credentialState === 'unavailable'
    ? 'unavailable' : credentialState === 'memoryOnly' ? 'memoryOnly' : credentialState === 'notRequired'
      ? 'notRequired' : configured ? 'configured' : 'absent';
  return {
    id,
    name: String(row.name || row.displayName || row.providerId || id),
    route,
    capabilities: Array.isArray(row.capabilities) ? row.capabilities as ProviderCapability[] : [],
    configured,
    credentialStatus,
    requiresCredential: typeof row.requiresCredential === 'boolean' ? row.requiresCredential : route !== 'local',
    settingsRevision: typeof row.settingsRevision === 'number' ? row.settingsRevision : undefined,
    settings: row.settings && typeof row.settings === 'object' ? row.settings as ProviderSettingsResult : undefined,
  };
}
function normalizeModel(value: unknown): ProviderModel {
  const row = safeResult<Record<string, unknown>>(value);
  return { id: String(row.id || row.modelId || ''), name: String(row.name || row.displayName || row.modelId || ''),
    providerId: typeof row.providerId === 'string' ? row.providerId : undefined,
    capabilities: Array.isArray(row.capabilities) ? row.capabilities as ProviderCapability[] : undefined };
}
function normalizeHealth(value: unknown): ProviderHealth {
  const row = safeResult<Record<string, unknown>>(value);
  const status = row.status === 'healthy' || row.healthy === true ? 'healthy'
    : row.status === 'degraded' ? 'degraded'
      : row.status === 'unavailable' || row.healthy === false ? 'unavailable' : 'unknown';
  return { providerId: String(row.providerId || ''), status, latencyMs: typeof row.latencyMs === 'number' ? row.latencyMs : undefined, message: typeof row.message === 'string' ? row.message : undefined };
}
function normalizeJob(value: unknown): InferenceJob {
  const row = safeResult<Record<string, unknown>>(value);
  const job = row.job && typeof row.job === 'object' ? row.job as Record<string, unknown> : row;
  const status = ['queued', 'submitting', 'running', 'succeeded', 'failed', 'cancel_requested', 'cancelled', 'recovering'].includes(String(job.status)) ? String(job.status) as InferenceJob['status'] : 'unknown';
  const result = job.outputText !== undefined ? { outputText: String(job.outputText).slice(0, 65536) }
    : job.preview && typeof job.preview === 'object' ? job.preview : undefined;
  const message = typeof job.message === 'string' ? job.message : undefined;
  const error = status === 'failed' || status === 'cancelled'
    ? { code: status === 'cancelled' ? 'cancelled' : 'provider_failed', message, retryable: Boolean(job.retryable) }
    : undefined;
  return {
    jobId: String(job.jobId || ''), status,
    progress: typeof job.progress === 'number' ? job.progress : undefined,
    providerId: typeof job.providerId === 'string' ? job.providerId : undefined,
    modelId: typeof job.modelId === 'string' ? job.modelId : undefined,
    route: job.route === 'local' || job.route === 'cloud' ? job.route : undefined,
    capability: typeof job.capability === 'string' ? job.capability : undefined,
    result,
    ...(typeof job.outputText === 'string' ? { outputText: job.outputText.slice(0, 65536) } : {}),
    ...(typeof job.proposalAvailable === 'boolean' ? { proposalAvailable: job.proposalAvailable } : {}),
    ...(typeof job.proposalId === 'string' ? { proposalId: job.proposalId } : {}),
    ...(typeof job.preview === 'object' && job.preview ? { preview: job.preview } : {}),
    ...(typeof job.retryable === 'boolean' ? { retryable: job.retryable } : {}),
    ...(typeof job.message === 'string' ? { message: job.message.slice(0, 256) } : {}),
    ...(error ? { error } : {}),
  } as InferenceJob;
}

frontendDiagnostics.instrumentClass(HostProviderService, 'provider_service');
export const hostProviderService = new HostProviderService();
