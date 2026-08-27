import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Cloud, Cpu, KeyRound, RefreshCw, Settings2, ShieldAlert, Trash2, X } from 'lucide-react';
import {
  hostProviderService,
  ProviderDescriptor,
  ProviderHealth,
  ProviderModel,
  ProviderRoute,
} from '../../services/HostProviderService';

interface SettingsModalProps { onClose: () => void; }

const routeLabel = (route: ProviderRoute) => route === 'local' ? 'LOCAL · loopback only' : 'CLOUD · explicit budget';

export const SettingsModal: React.FC<SettingsModalProps> = ({ onClose }) => {
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [health, setHealth] = useState<Record<string, ProviderHealth>>({});
  const [selectedId, setSelectedId] = useState('');
  const [rememberCredential, setRememberCredential] = useState(true);
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>({});
  const [budgets, setBudgets] = useState({ perJob: 0, daily: 0, monthly: 0 });
  const [requireCostConfirmation, setRequireCostConfirmation] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true); setMessage(null);
    try {
      const listed = await hostProviderService.listProviders();
      setProviders(listed);
      if (!selectedId && listed.length) setSelectedId(listed.find((provider) => provider.id === 'fal')?.id || listed[0].id);
      const [statusRows, healthRows, availableModels] = await Promise.all([
        Promise.all(listed.map((provider) => hostProviderService.getProviderStatus(provider.id))),
        Promise.all(listed.map((provider) => hostProviderService.health(provider.id))),
        selectedId ? hostProviderService.listModels(selectedId) : Promise.resolve([] as ProviderModel[]),
      ]);
      setProviders((previous) => previous.map((provider) => {
        const row = statusRows.find((candidate) => candidate.id === provider.id);
        if (row?.settings) hostProviderService.hydrateConfiguration(provider.id, provider.route, row.settings);
        if (provider.id === selectedId && row?.settingsRevision !== undefined) {
          setSettingsRevision(row.settingsRevision);
          const routes = Array.isArray(row.settings?.routes) ? row.settings.routes as Array<{ capability?: string; modelId?: string }> : [];
          const nextModels: Record<string, string> = {};
          routes.forEach((route) => { if (route.modelId && route.capability) nextModels[route.capability.startsWith('media.') ? 'media' : route.capability] = route.modelId; });
          setSelectedModels(nextModels);
          if (typeof row.settings?.enabled === 'boolean') setEnabled(row.settings.enabled);
          if (typeof row.settings?.requireCostConfirmation === 'boolean') setRequireCostConfirmation(row.settings.requireCostConfirmation);
          const configuredBudgets = row.settings?.budgets as { perJobMicroUsd?: unknown; dailyMicroUsd?: unknown; monthlyMicroUsd?: unknown } | undefined;
          if (configuredBudgets) setBudgets({ perJob: Number(configuredBudgets.perJobMicroUsd) || 0, daily: Number(configuredBudgets.dailyMicroUsd) || 0, monthly: Number(configuredBudgets.monthlyMicroUsd) || 0 });
        }
        return row ? { ...provider, configured: row.configured, credentialStatus: row.credentialStatus, settingsRevision: row.settingsRevision, settings: row.settings } : provider;
      }));
      setHealth(Object.fromEntries(healthRows.filter((row) => row?.providerId).map((row) => [row.providerId, row])));
      setModels(availableModels);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Provider settings are unavailable until the native host is ready.');
    } finally { setBusy(false); }
  }, [selectedId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => hostProviderService.subscribeProviderEvents((event) => { if (event.event === 'provider.status' || event.event === 'provider.recovery') void refresh(); }), [refresh]);

  useEffect(() => { if (selectedId) void hostProviderService.listModels(selectedId).then(setModels).catch((cause) => setMessage(cause instanceof Error ? cause.message : 'Models are unavailable.')); }, [selectedId]);

  const selected = useMemo(() => providers.find((provider) => provider.id === selectedId), [providers, selectedId]);
  const selectedHealth = health[selectedId];

  const persistConfiguration = async (nextModels = selectedModels, nextBudgets = budgets, nextCost = requireCostConfirmation, nextEnabled = enabled) => {
    if (!selected) return;
    try {
      const routes = Object.entries(nextModels).flatMap(([capability, modelId]) => {
        if (!modelId) return [];
        if (capability === 'media') return [{ capability: 'media.generate', modelId }, { capability: 'media.edit', modelId }];
        return [{ capability, modelId }];
      });
      const result = await hostProviderService.configure(selected.id, {
        enabled: nextEnabled,
        routes,
        fallbackPolicy: 'none',
        requireCostConfirmation: nextCost,
        budgets: { perJobMicroUsd: nextBudgets.perJob, dailyMicroUsd: nextBudgets.daily, monthlyMicroUsd: nextBudgets.monthly },
      }, settingsRevision);
      if (result && typeof result === 'object' && typeof (result as { settingsRevision?: unknown }).settingsRevision === 'number') setSettingsRevision((result as { settingsRevision: number }).settingsRevision);
      setMessage('Provider configuration saved by the native host.');
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Provider configuration was rejected.'); }
  };

  const configureCredential = async () => {
    setBusy(true); setMessage(null);
    try {
      await hostProviderService.configureCredential(selectedId, { remember: rememberCredential, memoryOnly: !rememberCredential });
      setMessage('Native credential prompt completed. The key remains host-owned.');
      await refresh();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Credential configuration was cancelled.'); setBusy(false); }
  };

  const removeCredential = async () => {
    setBusy(true); setMessage(null);
    try { await hostProviderService.deleteCredential(selectedId); hostProviderService.clearConfiguration(selectedId); setMessage('Credential removed from the host vault.'); await refresh(); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Credential could not be removed.'); setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-label="Provider settings">
      <div className="w-full max-w-3xl max-h-[90vh] overflow-hidden rounded-xl border border-gray-700 bg-gray-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-800 bg-gray-950 px-5 py-4">
          <div className="flex items-center gap-3"><Settings2 size={18} className="text-blue-400" /><div><h2 className="text-sm font-bold text-white">Provider Settings</h2><p className="text-[10px] text-gray-500">Host-owned credentials · explicit routing · no browser secrets</p></div></div>
          <button type="button" onClick={onClose} className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-white" aria-label="Close settings"><X size={16} /></button>
        </div>
        <div className="grid min-h-0 md:grid-cols-[220px_1fr]">
          <div className="max-h-[70vh] overflow-y-auto border-r border-gray-800 p-3 space-y-1">
            {providers.length === 0 && <div className="p-3 text-xs text-gray-500">No provider registry is available yet.</div>}
            {providers.map((provider) => {
              const isSelected = provider.id === selectedId;
              const status = provider.credentialStatus || (provider.configured ? 'configured' : 'absent');
              return <button type="button" key={provider.id} onClick={() => setSelectedId(provider.id)} className={`w-full rounded-lg border p-3 text-left transition-colors ${isSelected ? 'border-blue-500/60 bg-blue-950/30' : 'border-transparent hover:border-gray-700 hover:bg-gray-800'}`}>
                <div className="flex items-center gap-2 text-xs font-bold text-gray-200">{provider.route === 'local' ? <Cpu size={13} /> : <Cloud size={13} />}{provider.name || provider.id}</div>
                <div className="mt-1 text-[9px] uppercase tracking-wider text-gray-500">{routeLabel(provider.route)}</div>
                <div className={`mt-2 text-[9px] ${provider.route === 'local' || status === 'configured' || status === 'notRequired' ? 'text-emerald-400' : status === 'unavailable' ? 'text-red-400' : 'text-amber-400'}`}>{provider.route === 'local' || status === 'notRequired' ? 'No key required' : status === 'configured' ? 'Configured' : status === 'unavailable' ? 'Credential vault unavailable' : 'Credential absent'}</div>
              </button>;
            })}
          </div>
          <div className="max-h-[70vh] overflow-y-auto p-5 space-y-5">
            {selected ? <>
              <div className="flex items-start justify-between"><div><h3 className="text-base font-bold text-white">{selected.name || selected.id}</h3><p className="mt-1 text-[10px] uppercase tracking-wider text-blue-300">{routeLabel(selected.route)}</p></div><div className="flex items-center gap-3"><label className="flex items-center gap-1 text-[10px] text-gray-400"><input type="checkbox" checked={enabled} onChange={(event) => { setEnabled(event.target.checked); void persistConfiguration(selectedModels, budgets, requireCostConfirmation, event.target.checked); }} /> Enabled</label><div className={`flex items-center gap-1 text-[10px] ${selectedHealth?.status === 'healthy' ? 'text-emerald-400' : 'text-gray-500'}`}>{selectedHealth?.status === 'healthy' ? <CheckCircle2 size={13} /> : <ShieldAlert size={13} />}{selectedHealth?.status || 'Health not checked'}</div></div></div>
              <div><div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-gray-500">Capabilities</div><div className="flex flex-wrap gap-1.5">{(selected.capabilities || []).map((capability) => <span key={capability} className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-[10px] text-gray-300">{capability}</span>)}</div></div>
              <div><div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-gray-500">Selected models</div><div className="space-y-2">{(['media','text','code','commands'] as const).filter((capability) => selected.capabilities?.some((item) => item.startsWith(capability) || item === capability)).map((capability) => <label key={capability} className="flex items-center gap-2 text-xs text-gray-300"><span className="w-14 uppercase text-[10px] text-gray-500">{capability}</span><select aria-label={`${capability} model`} value={selectedModels[capability] || ''} className="flex-1 rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-xs text-white" onChange={(event) => { const next = { ...selectedModels, [capability]: event.target.value }; setSelectedModels(next); void persistConfiguration(next); }}><option value="">Select a host model…</option>{models.filter((model) => model.capabilities?.some((item) => item.startsWith(capability) || item === capability)).map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}</select></label>)}</div></div>
              <div className="rounded-lg border border-gray-800 bg-gray-950/60 p-3 space-y-3"><div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Routing & budget controls (microUSD)</div><div className="rounded border border-gray-800 bg-gray-950 px-2 py-1.5 text-[10px] text-gray-500">Fallback routing is disabled. Each job stays on its explicitly configured provider route.</div><label className="flex items-center justify-between gap-3 text-xs text-gray-300"><span>Confirm cloud cost per job</span><input type="checkbox" checked={requireCostConfirmation} onChange={(event) => { setRequireCostConfirmation(event.target.checked); void persistConfiguration(selectedModels, budgets, event.target.checked); }} /></label><div className="grid grid-cols-3 gap-2">{(['perJob','daily','monthly'] as const).map((key) => <label key={key} className="text-[9px] uppercase text-gray-500">{key}<input type="number" min={0} step={1} value={budgets[key]} onChange={(event) => setBudgets((current) => ({ ...current, [key]: Math.max(0, Math.floor(Number(event.target.value) || 0)) }))} onBlur={() => void persistConfiguration()} className="mt-1 w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-white" /></label>)}</div><button type="button" onClick={() => void persistConfiguration()} className="rounded bg-gray-800 px-3 py-1.5 text-[10px] font-bold text-gray-300 hover:bg-gray-700">Save host configuration</button></div>
              <div className="flex flex-wrap items-center gap-2">{selected.route === 'local' ? <span className="text-[10px] text-emerald-400">No key required.</span> : <><label className="flex items-center gap-2 text-[10px] text-gray-400"><input type="checkbox" checked={rememberCredential} onChange={(event) => setRememberCredential(event.target.checked)} /> Keep in OS vault</label><button type="button" disabled={busy} onClick={() => void configureCredential()} className="flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500 disabled:opacity-50"><KeyRound size={13} /> Configure Key…</button><button type="button" disabled={busy} onClick={() => void removeCredential()} className="flex items-center gap-2 rounded border border-gray-700 px-3 py-2 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50"><Trash2 size={13} /> Remove Key</button></>}<button type="button" disabled={busy} onClick={() => void refresh()} className="ml-auto rounded border border-gray-700 p-2 text-gray-400 hover:bg-gray-800 hover:text-white disabled:opacity-50" aria-label="Refresh providers"><RefreshCw size={13} className={busy ? 'animate-spin' : ''} /></button></div>
              <p className="text-[10px] text-gray-600">{selected.route === 'local' ? 'Local adapters are restricted to loopback endpoints and never fall back to cloud.' : 'Cloud work is host-mediated and budget-limited. The browser never receives the credential.'}</p>
            </> : <div className="py-10 text-center text-xs text-gray-500">Provider selection is unavailable.</div>}
            {message && <div className="rounded border border-gray-700 bg-gray-950 p-3 text-xs text-gray-300">{message}</div>}
          </div>
        </div>
      </div>
    </div>
  );
};
