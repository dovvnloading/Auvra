import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, KeyRound } from 'lucide-react';
import { hostProviderService, ProviderCapability, ProviderDescriptor, ProviderModel } from '../../services/HostProviderService';
import { formatModelPrice, formatShortPrice } from '../../services/providerPricing';
import { Button, Popover, type PopoverPlacement } from '../UI/kit';
import { Select } from '../UI/Select';
import { ModelPicker } from './ModelPicker';

interface AiRouteBarProps {
  capability: ProviderCapability;
  /** What the model is for, e.g. "Retexture model". */
  label: string;
  /** Told of the model in use whenever it changes, or null with none chosen. */
  onModelChange?: (model: ProviderModel | null) => void;
  placement?: PopoverPlacement;
  className?: string;
}

interface ActiveRoute {
  providerId: string;
  modelId: string;
  model?: ProviderModel;
}

/**
 * The provider and model an AI tool uses, right where it is used: says what is chosen and what it costs, and lets it be
 * changed on the spot, key included, without going through Settings. The list floats, so the tool keeps its place.
 */
export const AiRouteBar: React.FC<AiRouteBarProps> = ({ capability, label, onModelChange, placement = 'bottom-start', className = '' }) => {
  const [route, setRoute] = useState<ActiveRoute | null>(null);
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [providerId, setProviderId] = useState('fal');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  const loadRoute = useCallback(async () => {
    try {
      const active = await hostProviderService.loadConfiguredRoute(capability);
      if (!active) { setRoute(null); return; }
      setProviderId(active.providerId);
      setRoute((current) => ({ providerId: active.providerId, modelId: active.modelId, model: current?.modelId === active.modelId ? current.model : undefined }));
      const models = await hostProviderService.listModels(active.providerId, capability).catch(() => [] as ProviderModel[]);
      setRoute({ providerId: active.providerId, modelId: active.modelId, model: models.find((model) => model.id === active.modelId) });
    } catch {
      setRoute(null);
    }
  }, [capability]);

  const loadProviders = useCallback(async () => {
    try {
      const listed = await hostProviderService.listProviders();
      const statuses = await Promise.all(listed.filter((provider) => provider.capabilities.includes(capability)).map((provider) => hostProviderService.getProviderStatus(provider.id)));
      setProviders(statuses.map((status) => ({ ...status, name: listed.find((provider) => provider.id === status.id)?.name || status.id })));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Providers are unavailable until the host is ready.');
    }
  }, [capability]);

  useEffect(() => {
    setMessage(null);
    void loadRoute();
    return hostProviderService.subscribeProviderEvents((event) => { if (event.event === 'provider.status') void loadRoute(); });
  }, [loadRoute]);

  useEffect(() => { if (open) void loadProviders(); }, [open, loadProviders]);

  useEffect(() => { onModelChange?.(route?.model ?? (route ? { id: route.modelId } : null)); }, [onModelChange, route]);

  const provider = useMemo(() => providers.find((item) => item.id === providerId), [providers, providerId]);
  const needsKey = Boolean(provider?.requiresCredential) && provider?.credentialStatus !== 'configured' && provider?.credentialStatus !== 'memoryOnly';
  const price = route?.model ? formatShortPrice(route.model) : null;
  const name = route ? route.model?.name || route.modelId : null;
  // "OpenAI: gpt-oss-20b": the model is what tells them apart here.
  const shortName = name?.replace(/^[^:/]+:\s*/, '') ?? null;
  const description = route?.model ? [route.model.id, formatModelPrice(route.model)].filter(Boolean).join(', ') : route?.modelId;

  const addKey = async () => {
    setBusy(true); setMessage(null);
    try {
      await hostProviderService.addKey(providerId, { remember: true });
      await loadProviders();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'The key was not added.');
    } finally { setBusy(false); }
  };

  const choose = async (model: ProviderModel) => {
    setBusy(true); setMessage(null);
    try {
      await hostProviderService.routeCapability(providerId, capability, model.id);
      setRoute({ providerId, modelId: model.id, model });
      setOpen(false);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'The model could not be chosen.');
    } finally { setBusy(false); }
  };

  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${label}: ${name ?? 'none chosen'}`}
        title={description ? `${label}: ${description}` : label}
        className={`flex h-7 w-full min-w-0 items-center gap-2 rounded border bg-well px-2 text-left transition-colors duration-75 ${open ? 'border-accent/70' : 'border-line hover:border-gray-700'} ${className}`}
      >
        <span className={`min-w-0 flex-1 truncate text-xs ${name ? 'text-ink' : 'text-accent'}`}>{shortName ?? 'Choose a model'}</span>
        {price && <span className="shrink-0 whitespace-nowrap text-2xs tabular-nums text-ink-3">{price}</span>}
        <ChevronDown size={12} className="shrink-0 text-ink-3" />
      </button>
      {message && <div role="alert" className="mt-1 text-2xs text-bad">{message}</div>}
      <Popover anchor={trigger} open={open} onClose={close} placement={placement} width={380} label={label}>
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          <span className="shrink-0 text-2xs text-ink-3">Provider</span>
          <Select className="min-w-0 flex-1" placeholder="Provider" value={providerId} onChange={setProviderId} options={providers.map((item) => ({ value: item.id, label: item.name || item.id }))} />
          {needsKey && (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void addKey()} icon={<KeyRound size={11} />}>Add key</Button>
          )}
        </div>
        {message && <div role="alert" className="shrink-0 px-3 pt-2 text-2xs text-bad">{message}</div>}
        <div className="flex h-[360px] min-h-0 flex-col">
          <ModelPicker providerId={providerId} capability={capability} value={route?.providerId === providerId ? route.modelId : undefined} onChoose={(model) => void choose(model)} />
        </div>
      </Popover>
    </>
  );
};
