import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { hostProviderService, ProviderCapability, ProviderModel } from '../../services/HostProviderService';
import { formatModelPrice, modelCostWeight } from '../../services/providerPricing';
import { isUtilityModel, modelSample, picksFor, type PickTier } from '../../services/providerPicks';
import { Segmented, Spinner, TextInput } from '../UI/kit';

/** Rows drawn at a time: a catalog runs to hundreds, and typing narrows it far faster than scrolling. */
const ROWS_SHOWN = 100;

const TIERS: readonly PickTier[] = ['Fast', 'Balanced', 'Best quality'];

type ModelSort = 'cheapest' | 'name';
type PickerView = 'picks' | 'all';

export const sortModels = (models: readonly ProviderModel[], sort: ModelSort): ProviderModel[] => [...models].sort((a, b) => {
  if (sort === 'cheapest') {
    const difference = modelCostWeight(a) - modelCostWeight(b);
    // Two unknown prices are both infinite, whose difference is not a number.
    if (difference) return difference;
  }
  return (a.name || a.id).localeCompare(b.name || b.id);
});

export const filterModels = (models: readonly ProviderModel[], search: string): ProviderModel[] => {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...models];
  return models.filter((model) => {
    const text = `${model.name ?? ''} ${model.id} ${model.description ?? ''}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
};

const ModelRow: React.FC<{ model: ProviderModel; note?: string; sample?: string; chosen: boolean; onChoose: (model: ProviderModel) => void }> = ({ model, note, sample, chosen, onChoose }) => {
  const price = formatModelPrice(model);
  return (
    <li>
      <button
        type="button"
        onClick={() => onChoose(model)}
        title={[model.id, model.description].filter(Boolean).join('\n')}
        aria-pressed={chosen}
        className={`flex min-h-[28px] w-full items-center gap-2 px-3 py-1 text-left transition-colors duration-75 ${chosen ? 'bg-accent/15' : 'hover:bg-white/5'}`}
      >
        {sample && <img src={sample} alt="" draggable={false} className="h-8 w-8 shrink-0 rounded-sm object-cover" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-ink">{model.name || model.id}</span>
          {note && <span className="block truncate text-2xs text-ink-3">{note}</span>}
        </span>
        {price && <span className="shrink-0 text-right text-2xs tabular-nums text-ink-2">{price}</span>}
        {chosen && <Check size={12} className="shrink-0 text-accent" />}
      </button>
    </li>
  );
};

interface ModelPickerProps {
  providerId: string;
  capability: ProviderCapability;
  value?: string;
  onChoose: (model: ProviderModel) => void;
}

/** A provider's models for a capability: a short list by purpose where there is one, and all of them to search and sort by price. */
export const ModelPicker: React.FC<ModelPickerProps> = ({ providerId, capability, value, onChoose }) => {
  const [models, setModels] = useState<ProviderModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ModelSort>('cheapest');
  const [view, setView] = useState<PickerView>('picks');
  const [showUtilities, setShowUtilities] = useState(false);

  const load = useCallback(async (isCurrent: () => boolean) => {
    try {
      const listed = await hostProviderService.listModels(providerId, capability);
      if (isCurrent()) { setModels(listed); setError(null); }
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : 'Models are unavailable.');
    }
  }, [providerId, capability]);

  useEffect(() => {
    let current = true;
    setModels(null);
    void load(() => current);
    // Prices come in behind the list.
    const stop = hostProviderService.subscribeProviderEvents((event) => { if (event.event === 'provider.status') void load(() => current); });
    return () => { current = false; stop(); };
  }, [load]);

  const picks = useMemo(() => picksFor(providerId, capability, models ?? []), [providerId, capability, models]);
  const utilities = useMemo(() => (capability.startsWith('media.') ? (models ?? []).filter(isUtilityModel).length : 0), [capability, models]);
  // Searching always looks through everything: what is typed is what is wanted.
  const showingPicks = view === 'picks' && picks.length > 0 && !search.trim();
  const matching = useMemo(() => {
    const available = showUtilities || search.trim() || !capability.startsWith('media.') ? models ?? [] : (models ?? []).filter((model) => !isUtilityModel(model));
    return sortModels(filterModels(available, search), sort);
  }, [capability, models, search, showUtilities, sort]);
  const unpriced = useMemo(() => (models ?? []).filter((model) => formatModelPrice(model) === null).length, [models]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3" />
          <TextInput
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={models ? `Search ${models.length} models` : 'Search models'}
            aria-label="Search models"
            className="pl-6"
          />
        </div>
        {picks.length > 0 && !search.trim() && (
          <Segmented label="Which models" value={view} onChange={setView} options={[{ value: 'picks', label: 'Suggested' }, { value: 'all', label: 'All' }]} />
        )}
      </div>
      {error && <div className="px-3 pb-2 text-2xs text-bad">{error}</div>}
      {!models && !error && <div className="flex items-center gap-2 px-3 pb-3 text-2xs text-ink-3"><Spinner /> Reading the catalog</div>}
      {models && (showingPicks ? (
        <ul className="min-h-0 flex-1 overflow-y-auto pb-1" aria-label="Models">
          {TIERS.map((tier) => {
            const rows = picks.filter((pick) => pick.tier === tier);
            if (!rows.length) return null;
            return (
              <React.Fragment key={tier}>
                <li role="presentation" className="px-3 pb-0.5 pt-1.5 text-2xs text-ink-3">{tier}</li>
                {rows.map((pick) => <ModelRow key={pick.id} model={pick.model} note={pick.note} sample={modelSample(pick.id)} chosen={pick.id === value} onChoose={onChoose} />)}
              </React.Fragment>
            );
          })}
        </ul>
      ) : (
        <>
          <div className="flex shrink-0 items-center justify-between gap-2 px-3 pb-1.5">
            <Segmented label="Sort models" value={sort} onChange={setSort} options={[{ value: 'cheapest', label: 'Cheapest' }, { value: 'name', label: 'Name' }]} />
            {utilities > 0 && !search.trim() && (
              <label className="flex items-center gap-1.5 text-2xs text-ink-3">
                <input type="checkbox" checked={showUtilities} onChange={(event) => setShowUtilities(event.target.checked)} className="accent-accent" />
                {utilities} utilities
              </label>
            )}
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto pb-1" aria-label="Models">
            {matching.slice(0, ROWS_SHOWN).map((model) => <ModelRow key={model.id} model={model} chosen={model.id === value} onChoose={onChoose} />)}
            {matching.length === 0 && <li className="px-3 py-3 text-center text-2xs text-ink-3">No model matches.</li>}
            {matching.length > ROWS_SHOWN && <li className="px-3 py-1.5 text-center text-2xs text-ink-3">{matching.length - ROWS_SHOWN} more: keep typing to narrow them down.</li>}
          </ul>
        </>
      ))}
      {models && unpriced > 0 && <div className="shrink-0 border-t border-line px-3 py-1.5 text-2xs text-ink-3">{unpriced} without a price yet: they come in over the first couple of minutes.</div>}
    </div>
  );
};
