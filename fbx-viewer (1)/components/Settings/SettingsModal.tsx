import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Cloud, Cpu, RefreshCw, X } from 'lucide-react';
import {
  hostProviderService,
  ProviderDescriptor,
  ProviderCapability,
  ProviderHealth,
  ProviderModel,
  ProviderSettings,
} from '../../services/HostProviderService';
import { Button, IconButton } from '../UI/kit';
import { AiRouteBar } from './AiRouteBar';

interface SettingsModalProps { onClose: () => void; }

type SettingsPage = 'models' | 'keys' | 'spending';

const PAGES: readonly { id: SettingsPage; label: string }[] = [
  { id: 'models', label: 'Models' },
  { id: 'keys', label: 'Keys' },
  { id: 'spending', label: 'Spending' },
];

const JOBS: readonly { capability: ProviderCapability; label: string; hint: string }[] = [
  { capability: 'media.edit', label: 'Restyling textures', hint: 'Retexture, from what a part has now' },
  { capability: 'media.generate', label: 'New textures', hint: 'Retexture, from a description alone' },
  { capability: 'media.mesh', label: 'Whole models', hint: 'Retexture, painting a whole model at once' },
  { capability: 'code', label: 'Writing scripts', hint: 'The AI panel in the script editor' },
  { capability: 'commands', label: 'Changing the HUD', hint: 'The AI Coder in the HUD editor' },
  { capability: 'text', label: 'Plain text', hint: 'Anything else that needs words' },
];

const KEY_WORDS: Record<string, { text: string; good: boolean }> = {
  configured: { text: 'Key saved on this computer', good: true },
  memoryOnly: { text: 'Key held until the editor closes', good: true },
  notRequired: { text: 'No key needed', good: true },
  unavailable: { text: 'This computer cannot keep keys', good: false },
  absent: { text: 'No key', good: false },
};

const dollarsOf = (microUsd: number | undefined): string => (microUsd ? String(microUsd / 1_000_000) : '');
const microUsdOf = (dollars: string): number => Math.max(0, Math.round((Number(dollars) || 0) * 1_000_000));

/** An amount in dollars that saves when left. Empty means no limit. */
const LimitField: React.FC<{ label: string; value: number | undefined; onCommit: (microUsd: number) => void }> = ({ label, value, onCommit }) => {
  const [text, setText] = useState(dollarsOf(value));
  useEffect(() => { setText(dollarsOf(value)); }, [value]);
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-2xs text-ink-3">$</span>
      <input
        type="number"
        min={0}
        step={0.01}
        aria-label={label}
        placeholder="No limit"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => { if (microUsdOf(text) !== (value ?? 0)) onCommit(microUsdOf(text)); }}
        className="h-6 w-full rounded border border-line bg-well pl-4 pr-1 text-xs tabular-nums text-ink placeholder:text-ink-3 hover:border-gray-700 focus:border-accent/70 focus:outline-none"
      />
    </div>
  );
};

/** Which model does which job, the keys that pay for them, and how much they may spend. */
export const SettingsModal: React.FC<SettingsModalProps> = ({ onClose }) => {
  const [page, setPage] = useState<SettingsPage>('models');
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [health, setHealth] = useState<Record<string, ProviderHealth>>({});
  const [rememberCredential, setRememberCredential] = useState(true);
  const [busy, setBusy] = useState(false);
  const [keyWindowFor, setKeyWindowFor] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [, setRoutesSeen] = useState(0);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const listed = await hostProviderService.listProviders();
      const statuses = await Promise.all(listed.map((provider) => hostProviderService.getProviderStatus(provider.id)));
      setProviders(listed.map((provider) => {
        const status = statuses.find((row) => row.id === provider.id);
        if (status?.settings) hostProviderService.hydrateConfiguration(provider.id, provider.route, status.settings);
        return status ? { ...provider, ...status, name: provider.name, route: provider.route } : provider;
      }));
      const local = listed.filter((provider) => provider.route === 'local');
      const rows = await Promise.all(local.map((provider) => hostProviderService.health(provider.id)));
      setHealth(Object.fromEntries(rows.filter((row) => row?.providerId).map((row) => [row.providerId, row])));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'These settings are unavailable until the editor has finished starting.');
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => hostProviderService.subscribeProviderEvents((event) => { if (event.event === 'provider.status' || event.event === 'provider.recovery') void refresh(); }), [refresh]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async (provider: ProviderDescriptor, changes: Partial<ProviderSettings>) => {
    setMessage(null);
    try {
      const settings = provider.settings;
      await hostProviderService.configure(provider.id, {
        enabled: settings?.enabled ?? false,
        routes: Array.isArray(settings?.routes) ? settings.routes : [],
        fallbackPolicy: 'none',
        requireCostConfirmation: settings?.requireCostConfirmation ?? true,
        budgets: settings?.budgets ?? { perJobMicroUsd: 0, dailyMicroUsd: 0, monthlyMicroUsd: 0 },
        ...changes,
      }, provider.settingsRevision ?? 0);
      await refresh();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'That could not be saved.'); }
  };

  const addKey = async (provider: ProviderDescriptor) => {
    setBusy(true); setMessage(null);
    setKeyWindowFor(provider.id);
    try {
      await hostProviderService.addKey(provider.id, { remember: rememberCredential, memoryOnly: !rememberCredential });
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'The key was not added.');
    } finally {
      setKeyWindowFor(null);
      await refresh();
    }
  };

  const removeKey = async (provider: ProviderDescriptor) => {
    setBusy(true); setMessage(null);
    try {
      await hostProviderService.deleteCredential(provider.id);
      hostProviderService.clearConfiguration(provider.id);
      await refresh();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'The key could not be removed.'); setBusy(false); }
  };

  const cloudProviders = useMemo(() => providers.filter((provider) => provider.route === 'cloud'), [providers]);
  const localProviders = useMemo(() => providers.filter((provider) => provider.route === 'local'), [providers]);
  const providerName = (id?: string) => providers.find((provider) => provider.id === id)?.name ?? id;
  const noteRoute = useCallback((_model: ProviderModel | null) => setRoutesSeen((value) => value + 1), []);

  const keyRow = (provider: ProviderDescriptor) => {
    const local = provider.route === 'local';
    const words = local ? null : KEY_WORDS[provider.credentialStatus ?? 'absent'] ?? KEY_WORDS.absent;
    const hasKey = provider.credentialStatus === 'configured' || provider.credentialStatus === 'memoryOnly';
    const running = health[provider.id]?.status === 'healthy';
    const waitingForKey = keyWindowFor === provider.id;
    return (
      <li key={provider.id} className="flex h-10 items-center gap-2.5 px-4">
        <span className="shrink-0 text-ink-3">{local ? <Cpu size={14} /> : <Cloud size={14} />}</span>
        <span className="w-28 shrink-0 truncate text-xs text-ink">{provider.name || provider.id}</span>
        <span className={`min-w-0 flex-1 truncate text-2xs ${waitingForKey ? 'text-ink' : local ? (running ? 'text-ok' : 'text-ink-3') : words?.good ? 'text-ok' : 'text-ink-3'}`}>
          {waitingForKey ? 'Paste the key in the window that opened' : local ? (running ? 'Running on this computer' : 'Not running on this computer') : words?.text}
        </span>
        {!local && hasKey && <Button variant="ghost" size="sm" disabled={busy || keyWindowFor !== null} onClick={() => void removeKey(provider)}>Remove</Button>}
        {!local && <Button size="sm" disabled={busy || keyWindowFor !== null || provider.credentialStatus === 'unavailable'} onClick={() => void addKey(provider)}>{hasKey ? 'Replace key' : 'Add key'}</Button>}
        <label className="flex shrink-0 items-center gap-1 text-2xs text-ink-3" title="Off, this provider does no work, whatever it has been chosen for">
          <input type="checkbox" className="accent-accent" checked={Boolean(provider.settings?.enabled)} onChange={(event) => void save(provider, { enabled: event.target.checked })} /> On
        </label>
      </li>
    );
  };

  // On the page itself: inside the top bar it would sit under anything a tab raises above the bar.
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4" role="dialog" aria-modal="true" aria-label="AI settings">
      <div className="flex h-[min(560px,90vh)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-[0_24px_64px_rgb(0_0_0/0.6)]">
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-line pl-4 pr-2">
          <h2 className="text-xs font-semibold text-ink">AI settings</h2>
          <div className="flex items-center gap-0.5">
            <IconButton label="Check again" disabled={busy} onClick={() => void refresh()}><RefreshCw size={13} className={busy ? 'animate-spin' : ''} /></IconButton>
            <IconButton label="Close settings" onClick={onClose}><X size={15} /></IconButton>
          </div>
        </div>
        <div className="flex min-h-0 flex-1">
          <nav aria-label="Settings pages" className="w-36 shrink-0 border-r border-line py-1.5">
            {PAGES.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={page === item.id ? 'page' : undefined}
                onClick={() => setPage(item.id)}
                className={`flex h-7 w-full items-center px-4 text-left text-xs transition-colors duration-75 ${page === item.id ? 'bg-accent/15 text-ink' : 'text-ink-2 hover:bg-white/5 hover:text-ink'}`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {page === 'models' && (
              <>
                <p className="px-4 pb-1 pt-3 text-2xs text-ink-3">Which model does each job. Each tool also has this choice where it is used.</p>
                <ul>
                  {JOBS.map((job) => {
                    const route = hostProviderService.getConfiguredRoute(job.capability);
                    return (
                      <li key={job.capability} className="flex items-center gap-4 px-4 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs text-ink">{job.label}</div>
                          <div className="truncate text-2xs text-ink-3">{route ? `${job.hint}, on ${providerName(route.providerId)}` : job.hint}</div>
                        </div>
                        <div className="w-64 shrink-0"><AiRouteBar capability={job.capability} label={job.label} onModelChange={noteRoute} placement="bottom-end" /></div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}

            {page === 'keys' && (
              <>
                <p className="px-4 pb-1 pt-3 text-2xs text-ink-3">A key goes into a Windows prompt, and never reaches the editor's page or the project.</p>
                <label className="flex items-center gap-2 px-4 pb-2 text-2xs text-ink-2">
                  <input type="checkbox" className="accent-accent" checked={rememberCredential} onChange={(event) => setRememberCredential(event.target.checked)} />
                  Keep keys in the Windows vault. Off, a new key lasts until the editor closes.
                </label>
                <ul className="border-t border-line">{cloudProviders.map(keyRow)}</ul>
                {localProviders.length > 0 && (
                  <>
                    <p className="border-t border-line px-4 pb-1 pt-3 text-2xs text-ink-3">These run on this computer. Nothing leaves it, and they never fall back to the cloud.</p>
                    <ul>{localProviders.map(keyRow)}</ul>
                  </>
                )}
              </>
            )}

            {page === 'spending' && (
              <>
                <p className="px-4 pb-2 pt-3 text-2xs text-ink-3">
                  Set all three for a provider and each image job is checked against them using the catalog's price before it is sent. Language model jobs are not counted, as their cost depends on the answer.
                </p>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-y border-line text-left text-2xs text-ink-3">
                      <th className="px-4 py-1.5 font-normal">Provider</th>
                      <th className="w-24 py-1.5 pr-2 font-normal">Per job</th>
                      <th className="w-24 py-1.5 pr-2 font-normal">Per day</th>
                      <th className="w-24 py-1.5 pr-4 font-normal">Per month</th>
                      <th className="w-20 py-1.5 pr-4 text-center font-normal" title="Each job asks first">Confirm</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cloudProviders.map((provider) => {
                      const budgets = provider.settings?.budgets ?? { perJobMicroUsd: 0, dailyMicroUsd: 0, monthlyMicroUsd: 0 };
                      return (
                        <tr key={provider.id}>
                          <td className="px-4 py-1 text-ink">{provider.name || provider.id}</td>
                          <td className="py-1 pr-2"><LimitField label={`${provider.name} per job`} value={budgets.perJobMicroUsd} onCommit={(value) => void save(provider, { budgets: { ...budgets, perJobMicroUsd: value } })} /></td>
                          <td className="py-1 pr-2"><LimitField label={`${provider.name} per day`} value={budgets.dailyMicroUsd} onCommit={(value) => void save(provider, { budgets: { ...budgets, dailyMicroUsd: value } })} /></td>
                          <td className="py-1 pr-4"><LimitField label={`${provider.name} per month`} value={budgets.monthlyMicroUsd} onCommit={(value) => void save(provider, { budgets: { ...budgets, monthlyMicroUsd: value } })} /></td>
                          <td className="py-1 pr-4 text-center">
                            <input type="checkbox" className="accent-accent" aria-label={`Confirm the cost of each ${provider.name} job`} checked={provider.settings?.requireCostConfirmation ?? true} onChange={(event) => void save(provider, { requireCostConfirmation: event.target.checked })} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
        {message && <div role="alert" className="selectable shrink-0 border-t border-line bg-bad/10 px-4 py-1.5 text-2xs text-ink">{message}</div>}
      </div>
    </div>,
    document.body,
  );
};
