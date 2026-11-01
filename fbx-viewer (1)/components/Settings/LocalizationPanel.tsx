import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Languages, Plus, RotateCcw, Save, Search, Star, Trash2, X } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import { useNativeProjectDocument } from '../../utils/useNativeProjectDocument';
import {
  LOCALIZATION_DOCUMENT_ID,
  LocalizationDocument,
  LocalizationSettings,
  collectStringKeys,
  createDefaultLocalizationDocument,
  isValidLocale,
  isValidStringKey,
  localization,
  normalizeLocalizationSettings,
  translate,
} from '../../runtime/localization';

interface LocalizationPanelProps { onClose: () => void; }

const mapTables = (settings: LocalizationSettings, change: (locale: string, table: Record<string, string>) => Record<string, string>): LocalizationSettings => ({
  ...settings,
  locales: Object.fromEntries(Object.entries(settings.locales).map(([locale, table]) => [locale, change(locale, table)])),
});

/** A locale's own text for key, or ''. Keys such as 'toString' must not reach Object.prototype. */
const cellText = (settings: LocalizationSettings, locale: string, key: string): string => {
  const table = settings.locales[locale];
  return table && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : '';
};

/** Adds key to every locale as untranslated text so it shows up as a row everywhere. */
const addKey = (settings: LocalizationSettings, key: string): LocalizationSettings =>
  mapTables(settings, (_locale, table) => (Object.prototype.hasOwnProperty.call(table, key) ? table : { ...table, [key]: '' }));

const withoutEntry = <T,>(record: Record<string, T>, name: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([entry]) => entry !== name));

const removeKey = (settings: LocalizationSettings, key: string): LocalizationSettings =>
  mapTables(settings, (_locale, table) => withoutEntry(table, key));

const setText = (settings: LocalizationSettings, locale: string, key: string, text: string): LocalizationSettings =>
  mapTables(settings, (current, table) => (current === locale ? { ...table, [key]: text } : table));

/** A new locale starts with every known key untranslated, so missing strings are visible. */
const addLocale = (settings: LocalizationSettings, locale: string): LocalizationSettings => ({
  ...settings,
  locales: {
    ...settings.locales,
    [locale]: Object.fromEntries(collectStringKeys(settings).map((key) => [key, ''])),
  },
});

const removeLocale = (settings: LocalizationSettings, locale: string): LocalizationSettings => {
  if (locale === settings.defaultLocale) return settings;
  return { ...settings, locales: withoutEntry(settings.locales, locale) };
};

const sectionClass = 'rounded-lg border border-gray-800 bg-gray-950/60 p-3 space-y-3';
const sectionTitleClass = 'text-[10px] font-bold uppercase tracking-wider text-gray-500';
const inputClass = 'w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-xs text-white disabled:opacity-50';
const smallButtonClass = 'flex shrink-0 items-center gap-1 rounded border border-gray-700 px-2 py-1.5 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50';

export const LocalizationPanel: React.FC<LocalizationPanelProps> = ({ onClose }) => {
  const { projectStatus } = useScene();
  const { document, hydrated, error, replace } = useNativeProjectDocument<LocalizationDocument>(
    'metadata', LOCALIZATION_DOCUMENT_ID, createDefaultLocalizationDocument,
  );
  const stored = useMemo(() => normalizeLocalizationSettings(document.settings), [document]);
  const [draft, setDraft] = useState<LocalizationSettings>(stored);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [newKey, setNewKey] = useState('');
  const [newLocale, setNewLocale] = useState('');
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // JSON of the stored settings the draft was last synced to. The draft is unedited while it matches.
  const baselineRef = useRef(JSON.stringify(stored));

  // An unedited draft follows the stored document (hydrate, another writer). An edited draft is kept:
  // a failed save rolls the document back and every revision bump re-hydrates it, and neither may
  // discard typed text. A content check against the last `stored` would not do, because the
  // optimistic write makes the draft look clean just before the rollback arrives. Decided here, not
  // in a setDraft updater, which StrictMode calls twice (the second call would see the moved baseline).
  useEffect(() => {
    const next = JSON.stringify(stored);
    if (next === baselineRef.current) return;
    if (JSON.stringify(normalizeLocalizationSettings(draftRef.current)) !== baselineRef.current) return;
    baselineRef.current = next;
    setDraft(stored);
  }, [stored]);

  // A project switch always discards the draft.
  useEffect(() => {
    baselineRef.current = JSON.stringify(stored);
    setDraft(stored);
  }, [projectStatus.projectId]);

  const locales = useMemo(() => {
    const others = Object.keys(draft.locales).filter((locale) => locale !== draft.defaultLocale).sort((a, b) => a.localeCompare(b));
    return [draft.defaultLocale, ...others];
  }, [draft]);
  const keys = useMemo(() => collectStringKeys(draft), [draft]);
  const visibleKeys = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return keys;
    return keys.filter((key) => key.toLowerCase().includes(query)
      || locales.some((locale) => cellText(draft, locale, key).toLowerCase().includes(query)));
  }, [draft, filter, keys, locales]);
  const missing = useMemo(() => keys.reduce((count, key) => count + locales.filter((locale) => !cellText(draft, locale, key)).length, 0), [draft, keys, locales]);

  const dirty = JSON.stringify(normalizeLocalizationSettings(draft)) !== JSON.stringify(stored);
  const writable = Boolean(projectStatus.projectId) && !projectStatus.readOnly;
  const disabled = !hydrated || saving;

  const trimmedKey = newKey.trim();
  const keyProblem = !trimmedKey ? null
    : !isValidStringKey(trimmedKey) ? 'Keys are up to 200 characters and cannot be __proto__, constructor or prototype.'
    : keys.includes(trimmedKey) ? `The key "${trimmedKey}" already exists.`
    : null;
  const trimmedLocale = newLocale.trim();
  const localeProblem = !trimmedLocale ? null
    : !isValidLocale(trimmedLocale) ? 'Use a locale code such as en, fr, pt-BR or zh-Hant.'
    : Object.prototype.hasOwnProperty.call(draft.locales, trimmedLocale) ? `The locale "${trimmedLocale}" already exists.`
    : null;

  const update = (change: (current: LocalizationSettings) => LocalizationSettings) => {
    setMessage(null);
    setDraft((current) => change(current));
  };

  const submitKey = () => {
    if (!trimmedKey || keyProblem) return;
    update((current) => addKey(current, trimmedKey));
    setNewKey('');
  };

  const submitLocale = () => {
    if (!trimmedLocale || localeProblem) return;
    update((current) => addLocale(current, trimmedLocale));
    setNewLocale('');
  };

  const save = async () => {
    setSaving(true); setMessage(null);
    try {
      const settings = normalizeLocalizationSettings(draft);
      await replace({ ...document, id: LOCALIZATION_DOCUMENT_ID, settings });
      baselineRef.current = JSON.stringify(settings);
      // Editor previews (HUD text keys) read the shared runtime store.
      localization.load(settings);
      setMessage('Localization saved to the project.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Localization could not be saved.');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-label="Localization">
      <div className="flex w-full max-w-5xl max-h-[90vh] flex-col overflow-hidden rounded-xl border border-gray-700 bg-gray-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-800 bg-gray-950 px-5 py-4">
          <div className="flex items-center gap-3"><Languages size={18} className="text-blue-400" /><div><h2 className="text-sm font-bold text-white">Localization</h2><p className="text-[10px] text-gray-500">String tables stored in the project · used by HUD text keys and t()</p></div></div>
          <button type="button" onClick={onClose} className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-white" aria-label="Close localization"><X size={16} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5 space-y-4">
          {!hydrated && <div className="text-xs text-gray-500">Loading localization…</div>}
          {!projectStatus.projectId && <div className="rounded border border-amber-900 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-300">Open or create a project to save localization.</div>}
          {projectStatus.readOnly && <div className="rounded border border-amber-900 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-300">This project is read-only.</div>}

          <div className={sectionClass}>
            <div className={sectionTitleClass}>Locales</div>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block text-[9px] uppercase text-gray-500">Default locale
                <select aria-label="Default locale" value={draft.defaultLocale} disabled={disabled} onChange={(event) => { const defaultLocale = event.target.value; update((current) => ({ ...current, defaultLocale })); }} className={`mt-1 ${inputClass}`}>
                  {locales.map((locale) => <option key={locale} value={locale}>{locale}</option>)}
                </select>
              </label>
              <form className="block text-[9px] uppercase text-gray-500" onSubmit={(event) => { event.preventDefault(); submitLocale(); }}>
                <label htmlFor="localization-new-locale">Add locale</label>
                <div className="mt-1 flex gap-2">
                  <input id="localization-new-locale" type="text" value={newLocale} placeholder="fr, de, pt-BR…" disabled={disabled} onChange={(event) => setNewLocale(event.target.value)} className={inputClass} />
                  <button type="submit" disabled={disabled || !trimmedLocale || Boolean(localeProblem)} className={smallButtonClass}><Plus size={13} /> Add</button>
                </div>
              </form>
            </div>
            {localeProblem && <p className="text-[10px] text-amber-400">{localeProblem}</p>}
            <p className="text-[10px] text-gray-500">Missing text falls back to the base language (fr for fr-CA), then the default locale, then the key itself.</p>
          </div>

          <div className={sectionClass}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className={sectionTitleClass}>Strings · {keys.length} key{keys.length === 1 ? '' : 's'}{missing > 0 ? ` · ${missing} untranslated` : ''}</div>
              <label className="relative block w-full sm:w-56">
                <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" />
                <input type="search" aria-label="Filter strings" value={filter} placeholder="Filter keys or text" onChange={(event) => setFilter(event.target.value)} className={`${inputClass} pl-7`} />
              </label>
            </div>
            <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); submitKey(); }}>
              <input type="text" aria-label="New string key" value={newKey} placeholder="New key, e.g. hud.score" disabled={disabled} onChange={(event) => setNewKey(event.target.value)} className={`${inputClass} font-mono`} />
              <button type="submit" disabled={disabled || !trimmedKey || Boolean(keyProblem)} className={smallButtonClass}><Plus size={13} /> Add key</button>
            </form>
            {keyProblem && <p className="text-[10px] text-amber-400">{keyProblem}</p>}
            <p className="text-[10px] text-gray-500">Use {'{name}'} in text for values passed to t(key, {'{ name }'}).</p>

            {keys.length === 0 ? (
              <div className="rounded border border-dashed border-gray-800 px-3 py-6 text-center text-xs text-gray-500">No strings yet. Add a key to start a string table.</div>
            ) : (
              <div className="overflow-x-auto rounded border border-gray-800">
                <table className="w-full border-collapse text-xs">
                  <thead className="bg-gray-950 text-[10px] uppercase text-gray-500">
                    <tr>
                      <th scope="col" className="sticky left-0 z-10 min-w-[10rem] bg-gray-950 px-2 py-2 text-left font-bold">Key</th>
                      {locales.map((locale) => (
                        <th key={locale} scope="col" className="min-w-[12rem] px-2 py-2 text-left font-bold">
                          <div className="flex items-center gap-1">
                            {locale === draft.defaultLocale && <Star size={11} className="text-amber-400" aria-label="Default locale" />}
                            <span className="normal-case text-gray-300">{locale}</span>
                            {locale !== draft.defaultLocale && (
                              <button type="button" disabled={disabled} onClick={() => update((current) => removeLocale(current, locale))} className="ml-auto rounded p-0.5 text-gray-600 hover:bg-gray-800 hover:text-red-400 disabled:opacity-50" aria-label={`Remove locale ${locale}`} title={`Remove ${locale}`}><Trash2 size={12} /></button>
                            )}
                          </div>
                        </th>
                      ))}
                      <th scope="col" className="w-8 px-2 py-2"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleKeys.map((key) => (
                      <tr key={key} className="border-t border-gray-800">
                        <th scope="row" className="sticky left-0 z-10 bg-gray-900 px-2 py-1.5 text-left align-top font-mono text-[11px] font-normal text-gray-300 break-all">{key}</th>
                        {locales.map((locale) => {
                          const text = cellText(draft, locale, key);
                          const fallback = text ? '' : translate(draft, locale, key);
                          return (
                            <td key={locale} className="px-2 py-1.5 align-top">
                              <input
                                type="text"
                                aria-label={`${key} in ${locale}`}
                                value={text}
                                placeholder={fallback === key ? 'Untranslated' : fallback}
                                disabled={disabled}
                                onChange={(event) => { const next = event.target.value; update((current) => setText(current, locale, key, next)); }}
                                className={`${inputClass} ${text ? '' : 'border-amber-900/70'}`}
                              />
                            </td>
                          );
                        })}
                        <td className="px-2 py-1.5 align-top">
                          <button type="button" disabled={disabled} onClick={() => update((current) => removeKey(current, key))} className="rounded p-1 text-gray-600 hover:bg-gray-800 hover:text-red-400 disabled:opacity-50" aria-label={`Remove key ${key}`} title="Remove key from every locale"><Trash2 size={13} /></button>
                        </td>
                      </tr>
                    ))}
                    {visibleKeys.length === 0 && (
                      <tr className="border-t border-gray-800"><td colSpan={locales.length + 2} className="px-2 py-4 text-center text-gray-500">No strings match “{filter}”.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {(message || error) && <div className="rounded border border-gray-700 bg-gray-950 p-3 text-xs text-gray-300">{message || error?.message}</div>}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-gray-800 bg-gray-950 px-5 py-3">
          <button type="button" disabled={disabled || !dirty} onClick={() => { setMessage(null); baselineRef.current = JSON.stringify(stored); setDraft(stored); }} className="flex items-center gap-2 rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50"><RotateCcw size={13} /> Revert</button>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-white">Close</button>
            <button type="button" disabled={disabled || !dirty || !writable} onClick={() => void save()} className="flex items-center gap-2 rounded bg-blue-600 px-3 py-1.5 text-xs font-bold text-accent-ink hover:bg-blue-500 disabled:opacity-50" title={writable ? 'Save localization' : 'Open a writable project to save'}><Save size={13} /> {saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
};
