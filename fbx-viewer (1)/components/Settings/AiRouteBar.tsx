import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, ChevronDown, ChevronUp, KeyRound } from 'lucide-react';
import { hostProviderService, ProviderCapability, ProviderDescriptor, ProviderModel } from '../../services/HostProviderService';
import { formatModelPrice } from '../../services/providerPricing';
import { ModelPicker } from './ModelPicker';

interface AiRouteBarProps {
  capability: ProviderCapability;
  /** What the model is for, e.g. "Retexture model". */
  label: string;
}

interface ActiveRoute {
  providerId: string;
  modelId: string;
  model?: ProviderModel;
}

/**
 * The provider and model an AI tool uses, right where it is used: says what is chosen and what it costs, and lets it be
 * changed on the spot, key included, without going through Settings.
 */
export const AiRouteBar: React.FC<AiRouteBarProps> = ({ capability, label }) => {
  const [route, setRoute] = useState<ActiveRoute | null>(null);
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [providerId, setProviderId] = useState('fal');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadRoute = useCallback(async () => {
    try {
      const active = await hostProviderService.loadConfiguredRoute(capability);
      if (!active) { setRoute(null); return; }
      setProviderId(active.providerId);
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

  const provider = useMemo(() => providers.find((item) => item.id === providerId), [providers, providerId]);
  const needsKey = Boolean(provider?.requiresCredential) && provider?.credentialStatus !== 'configured' && provider?.credentialStatus !== 'memoryOnly';
  const price = route?.model ? formatModelPrice(route.model) : null;

  const addKey = async () => {
    setBusy(true); setMessage(null);
    try {
      await hostProviderService.configureCredential(providerId, { remember: true });
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

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-left hover:border-gray-600"
      >
        <Bot size={12} className="shrink-0 text-blue-400" />
        <span className="min-w-0 flex-1">
          <span className="block text-[9px] font-bold uppercase tracking-wider text-gray-500">{label}</span>
          <span className="block truncate text-[11px] text-gray-200" title={route?.modelId}>{route ? route.model?.name || route.modelId : 'None chosen yet'}</span>
        </span>
        {price && <span className="shrink-0 text-[9px] text-emerald-400">{price}</span>}
        {open ? <ChevronUp size={12} className="shrink-0 text-gray-500" /> : <ChevronDown size={12} className="shrink-0 text-gray-500" />}
      </button>
      {open && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <select aria-label="Provider" value={providerId} onChange={(event) => setProviderId(event.target.value)} className="min-w-0 flex-1 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-[11px] text-gray-200">
              {providers.map((item) => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
            </select>
            {needsKey && (
              <button type="button" disabled={busy} onClick={() => void addKey()} className="flex shrink-0 items-center gap-1 rounded bg-blue-600 px-2 py-1 text-[10px] font-bold text-white hover:bg-blue-500 disabled:opacity-50">
                <KeyRound size={10} /> Add key
              </button>
            )}
          </div>
          <ModelPicker providerId={providerId} capability={capability} value={route?.providerId === providerId ? route.modelId : undefined} onChoose={(model) => void choose(model)} />
        </div>
      )}
      {message && <div className="text-[10px] text-red-400">{message}</div>}
    </div>
  );
};
