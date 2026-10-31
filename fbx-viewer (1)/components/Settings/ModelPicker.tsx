import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, RefreshCw, Search } from 'lucide-react';
import { hostProviderService, ProviderCapability, ProviderModel } from '../../services/HostProviderService';
import { formatModelPrice, modelCostWeight } from '../../services/providerPricing';

/** Rows drawn at a time: a catalog runs to hundreds, and typing narrows it far faster than scrolling. */
const ROWS_SHOWN = 100;

type ModelSort = 'cheapest' | 'name';

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

interface ModelPickerProps {
  providerId: string;
  capability: ProviderCapability;
  value?: string;
  onChoose: (model: ProviderModel) => void;
}

/** Every model a provider offers for a capability, to search and sort by price. */
export const ModelPicker: React.FC<ModelPickerProps> = ({ providerId, capability, value, onChoose }) => {
  const [models, setModels] = useState<ProviderModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ModelSort>('cheapest');

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

  const matching = useMemo(() => sortModels(filterModels(models ?? [], search), sort), [models, search, sort]);
  const unpriced = useMemo(() => (models ?? []).filter((model) => formatModelPrice(model) === null).length, [models]);

  return (
    <div className="space-y-2 rounded border border-gray-800 bg-gray-950 p-2">
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={models ? `Search ${models.length} models...` : 'Search models...'}
            aria-label="Search models"
            className="w-full rounded border border-gray-700 bg-gray-900 py-1 pl-6 pr-2 text-[11px] text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <select aria-label="Sort models" value={sort} onChange={(event) => setSort(event.target.value as ModelSort)} className="rounded border border-gray-700 bg-gray-900 px-1 text-[11px] text-gray-300">
          <option value="cheapest">Cheapest</option>
          <option value="name">Name</option>
        </select>
      </div>
      {error && <div className="text-[10px] text-red-400">{error}</div>}
      {!models && !error && <div className="flex items-center gap-2 py-3 text-[10px] text-gray-500"><RefreshCw size={11} className="animate-spin" /> Reading the catalog...</div>}
      {models && (
        <ul className="max-h-64 space-y-0.5 overflow-y-auto custom-scrollbar" aria-label="Models">
          {matching.slice(0, ROWS_SHOWN).map((model) => {
            const price = formatModelPrice(model);
            const chosen = model.id === value;
            return (
              <li key={model.id}>
                <button
                  type="button"
                  onClick={() => onChoose(model)}
                  title={model.description || model.id}
                  aria-pressed={chosen}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left transition-colors ${chosen ? 'bg-blue-900/30' : 'hover:bg-gray-800'}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] text-gray-200">{model.name || model.id}</span>
                    <span className="block truncate font-mono text-[9px] text-gray-500">{model.id}</span>
                  </span>
                  {price && <span className="shrink-0 text-right text-[9px] text-emerald-400">{price}</span>}
                  {chosen && <Check size={11} className="shrink-0 text-blue-400" />}
                </button>
              </li>
            );
          })}
          {matching.length === 0 && <li className="px-2 py-3 text-center text-[10px] text-gray-500">No model matches.</li>}
          {matching.length > ROWS_SHOWN && <li className="px-2 py-1 text-center text-[9px] text-gray-500">{matching.length - ROWS_SHOWN} more: keep typing to narrow them down.</li>}
        </ul>
      )}
      {models && unpriced > 0 && <div className="text-[9px] text-gray-600">{unpriced} without a price yet: prices come in over the first couple of minutes.</div>}
    </div>
  );
};
