import React, { useMemo, useState } from 'react';
import { Box, Search } from 'lucide-react';
import type { LoadedModelData } from '../../../types';
import { TextInput } from '../../UI/kit';

const CATEGORY_ORDER = ['Character', 'Prop', 'Environment'];

/** The project's models, by kind. Animation files have nothing to paint. */
export const AssetRail: React.FC<{
  models: readonly LoadedModelData[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
}> = ({ models, selectedId, onSelect, loading }) => {
  const [search, setSearch] = useState('');
  const groups = useMemo(() => {
    const wanted = search.trim().toLowerCase();
    const byCategory = new Map<string, LoadedModelData[]>();
    for (const model of models) {
      if (model.category === 'Animation' || !model.name.toLowerCase().includes(wanted)) continue;
      const category = model.category || 'Other';
      byCategory.set(category, [...(byCategory.get(category) ?? []), model]);
    }
    const rank = (category: string) => { const index = CATEGORY_ORDER.indexOf(category); return index < 0 ? CATEGORY_ORDER.length : index; };
    return [...byCategory.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  }, [models, search]);

  return (
    <>
      <div className="shrink-0 border-b border-line p-2">
        <div className="relative">
          <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3" />
          <TextInput value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter models" aria-label="Filter models" className="pl-6" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {groups.length === 0 && <p className="px-3 py-6 text-center text-2xs text-ink-3">{models.length ? 'No model matches.' : loading ? 'Loading the project' : 'Import a model to paint it.'}</p>}
        {groups.map(([category, rows]) => (
          <div key={category}>
            <h3 className="sticky top-0 z-[1] bg-panel px-3 pb-1 pt-2 text-2xs font-medium text-ink-3">{category}</h3>
            {rows.map((model) => (
              <button
                key={model.id}
                type="button"
                aria-current={model.id === selectedId || undefined}
                onClick={() => onSelect(model.id)}
                className={`flex h-9 w-full items-center gap-2 px-3 text-left transition-colors duration-75 ${model.id === selectedId ? 'bg-accent/15 text-ink' : 'text-ink-2 hover:bg-white/5 hover:text-ink'}`}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-well">
                  {model.thumbnail ? <img src={model.thumbnail} alt="" draggable={false} className="h-full w-full object-cover" /> : <Box size={13} className="text-ink-3" />}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs">{model.name}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  );
};
