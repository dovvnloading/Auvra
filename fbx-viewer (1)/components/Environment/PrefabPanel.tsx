import React, { useState } from 'react';
import { Boxes, PackagePlus, MapPin, Trash2, RefreshCw } from 'lucide-react';
import { usePrefabs } from '../../hooks/usePrefabs';
import { editorSession } from '../../utils/editorSession';
import { appConfirm, appPrompt } from '../../utils/appDialogs';

interface PrefabPanelProps {
    /** Current World Editor selection; the prefab root is the primary's selection root. */
    selectedObjectIds: string[];
    primaryObjectId?: string | null;
    /** Where 'Place' puts a prefab (e.g. the viewport camera target); defaults to the origin. */
    placementTarget?: [number, number, number] | null;
    /** Called with the placed root so the editor can select it. */
    onPlaced?: (rootId: string) => void;
}

const ORIGIN: [number, number, number] = [0, 0, 0];

export const PrefabPanel: React.FC<PrefabPanelProps> = ({
    selectedObjectIds,
    primaryObjectId,
    placementTarget,
    onPlaced,
}) => {
    const { prefabs, isLoading, isPlacing, refresh, createFromSelection, deletePrefab, placePrefab } = usePrefabs();
    const [isCreating, setIsCreating] = useState(false);
    const canEdit = () => editorSession.captureReady() !== null;
    const hasSelection = selectedObjectIds.length > 0 || Boolean(primaryObjectId);

    const handleCreate = async () => {
        if (!canEdit() || isCreating) return;
        const name = await appPrompt('New prefab', { message: 'Name the prefab, or leave it empty to use the object name.', acceptLabel: 'Create' });
        if (name === null || !canEdit()) return;
        const ids = selectedObjectIds.length > 0 ? selectedObjectIds : primaryObjectId ? [primaryObjectId] : [];
        setIsCreating(true);
        try {
            await createFromSelection(ids, primaryObjectId, name);
        } finally {
            setIsCreating(false);
        }
    };

    const handlePlace = async (id: string) => {
        if (!canEdit()) return;
        const rootId = await placePrefab(id, placementTarget ?? ORIGIN);
        if (rootId) onPlaced?.(rootId);
    };

    const handleDelete = async (id: string, name: string) => {
        if (!canEdit()) return;
        if (!await appConfirm(`Delete prefab "${name}"?`, { message: 'Placed copies stay in their levels.', acceptLabel: 'Delete', danger: true }) || !canEdit()) return;
        await deletePrefab(id);
    };

    return (
        <div className="flex flex-col h-full min-h-0">
            <div className="flex items-center justify-between p-3 border-b border-gray-800 bg-gray-950 shrink-0">
                <span className="text-xs font-bold text-gray-300 flex items-center gap-2">
                    <Boxes size={14} className="text-sky-400" /> Prefabs
                </span>
                <button
                    onClick={() => void refresh()}
                    className="p-1 rounded text-gray-500 hover:text-white hover:bg-gray-800 transition-colors"
                    title="Reload prefabs"
                    aria-label="Reload prefabs"
                >
                    <RefreshCw size={12} className={isLoading ? 'animate-spin' : ''} />
                </button>
            </div>

            <div className="p-3 border-b border-gray-800 shrink-0">
                <button
                    onClick={handleCreate}
                    disabled={!hasSelection || isCreating}
                    className="w-full flex items-center justify-center gap-2 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all bg-sky-700 text-white hover:bg-sky-600 disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed"
                    title={hasSelection ? 'Save the selected object and its children as a prefab' : 'Select an object first'}
                >
                    <PackagePlus size={12} /> Create from selection
                </button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
                {prefabs.length === 0 && !isLoading && (
                    <div className="text-[11px] text-gray-500 text-center py-6 px-2">
                        No prefabs yet. Select an object and choose "Create from selection".
                    </div>
                )}
                {prefabs.map((prefab) => (
                    <div
                        key={prefab.id}
                        className="group flex items-center gap-2 px-2 py-1.5 rounded bg-gray-800/40 hover:bg-gray-800 border border-transparent hover:border-gray-700"
                    >
                        <Boxes size={12} className="text-sky-400 shrink-0" />
                        <div className="flex-1 min-w-0">
                            <div className="text-xs text-gray-200 truncate" title={prefab.name}>{prefab.name}</div>
                            <div className="text-[10px] text-gray-500">
                                {prefab.objects.length} object{prefab.objects.length === 1 ? '' : 's'}
                            </div>
                        </div>
                        <button
                            onClick={() => void handlePlace(prefab.id)}
                            disabled={isPlacing}
                            className="flex items-center gap-1 px-1.5 py-1 rounded text-[10px] font-bold uppercase text-emerald-300 hover:text-white hover:bg-emerald-700 disabled:text-gray-600 disabled:hover:bg-transparent"
                            title={placementTarget ? 'Place at the camera target' : 'Place at the origin'}
                        >
                            <MapPin size={11} /> Place
                        </button>
                        <button
                            onClick={() => void handleDelete(prefab.id, prefab.name)}
                            className="p-1 rounded text-gray-500 hover:text-red-300 hover:bg-red-900/40 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                            title="Delete prefab"
                            aria-label={`Delete prefab ${prefab.name}`}
                        >
                            <Trash2 size={11} />
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
};
