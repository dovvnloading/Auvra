import React, { useMemo, useState } from 'react';
import { Package, Upload, Undo2, Unlink } from 'lucide-react';
import type { LevelObject } from '../../types';
import { useScene } from '../../context/SceneContext';
import { usePrefabs } from '../../hooks/usePrefabs';
import { editorSession } from '../../utils/editorSession';
import { findInstanceRoot, overriddenFields } from '../../utils/prefabSync';

const FIELD_LABELS: Record<string, string> = {
    name: 'name', type: 'type', modelId: 'model', position: 'position', rotation: 'rotation', scale: 'scale',
    components: 'components', spawnConfig: 'spawner', audioConfig: 'audio', skyConfig: 'sky',
};

/**
 * Inspector section for an object that belongs to a prefab instance: which prefab, what this object
 * overrides, and Apply to Prefab (save the instance as the prefab and update every other instance),
 * Revert (drop the instance's overrides) and Unlink (make it plain objects).
 */
export const PrefabInstanceSection: React.FC<{ object: LevelObject }> = ({ object }) => {
    const { levelObjects } = useScene();
    const { prefabs, applyInstanceToPrefab, revertInstance, unlinkInstance } = usePrefabs();
    const [busy, setBusy] = useState(false);
    const prefab = prefabs.find(item => item.id === object.prefabId);
    const root = useMemo(() => (prefab ? findInstanceRoot(levelObjects, object, prefab) : null), [levelObjects, object, prefab]);
    const overrides = useMemo(() => (prefab ? overriddenFields(object, prefab) : []), [object, prefab]);

    if (!object.prefabId) return null;
    if (!prefab || !root) {
        return (
            <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-purple-900/30 border border-purple-700/50 text-[10px] font-bold text-purple-300" title={`Placed from prefab ${object.prefabId}`}>
                <Package size={10} /> Prefab Instance
            </div>
        );
    }

    const run = async (action: () => Promise<boolean> | boolean) => {
        if (busy || !editorSession.captureReady()) return;
        setBusy(true);
        try {
            await action();
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="rounded border border-purple-700/50 bg-purple-950/30 p-2 space-y-2" aria-label="Prefab instance">
            <div className="flex items-center gap-1.5 text-[10px] font-bold text-purple-300">
                <Package size={11} />
                <span className="truncate">Instance of {prefab.name}</span>
                {root.id !== object.id && <span className="text-purple-400/70 font-normal truncate">(under {root.name})</span>}
            </div>
            <div className="text-[10px] text-gray-400">
                {overrides.length
                    ? <>Overrides: {overrides.map(field => FIELD_LABELS[field] ?? field).join(', ')}. Prefab changes leave these alone.</>
                    : 'Matches the prefab; prefab changes update it.'}
            </div>
            <div className="grid grid-cols-3 gap-1">
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => applyInstanceToPrefab(object.id))}
                    className="flex items-center justify-center gap-1 py-1 rounded text-[10px] font-bold bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-50"
                    title="Save this instance as the prefab and update every other instance"
                >
                    <Upload size={10} /> Apply
                </button>
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => revertInstance(object.id))}
                    className="flex items-center justify-center gap-1 py-1 rounded text-[10px] font-bold bg-gray-800 hover:bg-gray-700 text-gray-200 disabled:opacity-50"
                    title="Drop this instance's overrides (its placement stays)"
                >
                    <Undo2 size={10} /> Revert
                </button>
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => unlinkInstance(object.id))}
                    className="flex items-center justify-center gap-1 py-1 rounded text-[10px] font-bold bg-gray-800 hover:bg-gray-700 text-gray-200 disabled:opacity-50"
                    title="Make this instance plain objects that prefab changes no longer reach"
                >
                    <Unlink size={10} /> Unlink
                </button>
            </div>
        </div>
    );
};
