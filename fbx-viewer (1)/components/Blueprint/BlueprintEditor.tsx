import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileCode } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import { Blueprint } from '../../types';
import { useEditorHistory } from '../../utils/history';
import { BlueprintListPanel } from './BlueprintListPanel';
import { BlueprintViewport } from './BlueprintViewport';
import { BlueprintInspectorPanel } from './BlueprintInspectorPanel';
import type { WeaponFocus } from './WeaponsPanel';

interface BlueprintEditorProps {
    visible: boolean;
}

/** Continuous edits (typing, scrubbing) sharing a coalesce key within this window form one undo step. */
const COALESCE_WINDOW_MS = 800;

export const BlueprintEditor: React.FC<BlueprintEditorProps> = ({ visible }) => {
    const { 
        blueprints, 
        addBlueprint, 
        updateBlueprint, 
        removeBlueprint, 
        isCreatingPlayerBlueprint,
        selectedBlueprintId, 
        selectBlueprint, 
        models 
    } = useScene();
    
    const selectedBlueprint = blueprints.find(bp => bp.id === selectedBlueprintId);

    // Undo/redo over the selected blueprint. Snapshots are whole blueprints; restoring one goes
    // through the normal update path so it is persisted like any other edit.
    const lastEditRef = useRef<{ key: string; at: number } | null>(null);

    const restoreBlueprint = useCallback((restored: Blueprint | undefined) => {
        if (!restored) return;
        const current = blueprints.find(bp => bp.id === restored.id);
        if (!current) return;
        // updateBlueprint merges, so optional fields absent from the snapshot must be cleared explicitly.
        const patch: Record<string, unknown> = { ...restored };
        Object.keys(current).forEach(key => {
            if (!(key in restored)) patch[key] = undefined;
        });
        lastEditRef.current = null;
        updateBlueprint(restored.id, patch as Partial<Blueprint>);
    }, [blueprints, updateBlueprint]);

    const history = useEditorHistory<Blueprint | undefined>({
        value: selectedBlueprint,
        apply: restoreBlueprint,
        active: visible && !!selectedBlueprint,
        resetKey: selectedBlueprintId,
    });
    const { record } = history;

    const handleUpdate = useCallback((id: string, updates: Partial<Blueprint>, options?: { coalesce?: string }) => {
        const before = blueprints.find(bp => bp.id === id);
        if (before && id === selectedBlueprintId) {
            const changed = (Object.keys(updates) as (keyof Blueprint)[]).some(key => updates[key] !== before[key]);
            if (changed) {
                const now = Date.now();
                const key = options?.coalesce ? `${id}:${options.coalesce}` : null;
                const last = lastEditRef.current;
                const continuesBurst = key !== null && last !== null && last.key === key && now - last.at < COALESCE_WINDOW_MS;
                if (!continuesBurst) record(before);
                lastEditRef.current = key ? { key, at: now } : null;
            }
        }
        updateBlueprint(id, updates);
    }, [blueprints, selectedBlueprintId, record, updateBlueprint]);

    // The weapon being fitted to the hands: shown in hand in the preview, where a click picks a point on it.
    const [weaponFocus, setWeaponFocus] = useState<WeaponFocus | null>(null);
    useEffect(() => setWeaponFocus(null), [selectedBlueprintId]);
    const pickWeaponPoint = useCallback((point: [number, number, number]) => {
        if (!weaponFocus?.field || !selectedBlueprint) return;
        const { weaponId, field } = weaponFocus;
        handleUpdate(selectedBlueprint.id, {
            weapons: (selectedBlueprint.weapons ?? []).map(weapon => (weapon.id === weaponId ? { ...weapon, [field]: point } : weapon)),
        });
        setWeaponFocus({ weaponId, field: null });
    }, [weaponFocus, selectedBlueprint, handleUpdate]);

    // Derived state for linked model
    const linkedModel = useMemo(() => 
        models.find(m => m.id === selectedBlueprint?.linkedModelId), 
    [models, selectedBlueprint]);

    // Aggregate animations for the preview
    const allSceneClips = useMemo(() => {
        return models.flatMap(m => 
            (m.animations || []).map(clip => ({
                name: clip.name,
                source: m.name,
                clip: clip
            }))
        );
    }, [models]);

    // Memoize the array of raw clips to prevent mixer churn
    const rawClips = useMemo(() => allSceneClips.map(c => c.clip), [allSceneClips]);

    return (
        <div className="flex h-full w-full bg-gray-950 text-white font-sans overflow-hidden">
            
            {/* LEFT: File Manager */}
            <BlueprintListPanel 
                blueprints={blueprints}
                selectedId={selectedBlueprintId}
                onSelect={selectBlueprint}
                onAdd={addBlueprint}
                isCreatingPlayer={isCreatingPlayerBlueprint}
                onRemove={removeBlueprint}
            />

            {/* CENTER & RIGHT: Editor Content */}
            {selectedBlueprint ? (
                <div className="flex-1 flex min-w-0 bg-gray-900 relative">
                    
                    {/* CENTER: 3D View & Setup */}
                    <BlueprintViewport 
                        blueprint={selectedBlueprint}
                        linkedModel={linkedModel}
                        models={models}
                        allClips={rawClips}
                        onUpdate={handleUpdate}
                        onRemove={removeBlueprint}
                        visible={visible}
                        history={history}
                        weaponFocus={weaponFocus}
                        onWeaponPoint={pickWeaponPoint}
                    />

                    {/* RIGHT: Properties */}
                    <BlueprintInspectorPanel
                        blueprint={selectedBlueprint}
                        onUpdate={handleUpdate}
                        weaponFocus={weaponFocus}
                        onWeaponFocus={setWeaponFocus}
                    />
                </div>
            ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-gray-500 bg-gray-950">
                    <div className="w-16 h-16 rounded-full bg-gray-900 flex items-center justify-center mb-4">
                            <FileCode size={32} className="opacity-50" />
                    </div>
                    <h2 className="text-lg font-bold text-gray-300">No Blueprint Selected</h2>
                    <p className="text-sm mt-2 max-w-xs text-center">Select a blueprint from the list on the left or create a new one to start editing your character.</p>
                </div>
            )}
        </div>
    );
};
