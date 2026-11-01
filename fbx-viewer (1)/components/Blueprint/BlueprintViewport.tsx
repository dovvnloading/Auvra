
import React, { useState, useMemo } from 'react';
import * as THREE from 'three';
import { Shield, Skull, Box, Trash2, Eye, ChevronUp, Search, Check, Undo2, Redo2, Wand2 } from 'lucide-react';
import { Blueprint, LoadedModelData } from '../../types';
import { GraphPreview, type AttachmentPointPick } from '../AnimationGraph/GraphPreview';
import { WEAPON_POINTS, type WeaponFocus } from './WeaponsPanel';
import { heldWeaponGrip } from '../Sandbox/CharacterIK';
import { useScene } from '../../context/SceneContext';
import { useNotification } from '../../context/NotificationContext';
import { matchGraphClips, matchUpperBodyClips, weaponLocomotionGraph } from '../AnimationGraph/utils/clipMatching';
import { weaponMoveClips, weaponPlacements } from '../../runtime/weapons';

interface BlueprintViewportProps {
    blueprint: Blueprint;
    linkedModel: LoadedModelData | undefined;
    models: LoadedModelData[];
    allClips: THREE.AnimationClip[];
    onUpdate: (id: string, updates: Partial<Blueprint>, options?: { coalesce?: string }) => void;
    onRemove: (id: string) => void;
    visible: boolean;
    history: { undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean };
    /** The weapon being fitted to the hands, shown in hand with its points; a click on it picks `field`. */
    weaponFocus?: WeaponFocus | null;
    onWeaponPoint?: (point: [number, number, number]) => void;
}

export const BlueprintViewport: React.FC<BlueprintViewportProps> = ({
    blueprint,
    linkedModel,
    models,
    allClips,
    onUpdate,
    onRemove,
    visible,
    history,
    weaponFocus = null,
    onWeaponPoint
}) => {
    const { textures, attachments } = useScene();
    const { addNotification } = useNotification();
    const [isMeshSelectorOpen, setIsMeshSelectorOpen] = useState(false);
    const [meshSearch, setMeshSearch] = useState('');
    // A player with weapons previews them as play shows them once every weapon is carried: the first
    // one carried from the start held, at rest (carried) or in use (in hand), the others at their
    // carry placements.
    const [weaponsInUse, setWeaponsInUse] = useState(false);
    const weapons = blueprint.weapons;
    const focusIndex = weapons && weaponFocus ? weapons.findIndex(weapon => weapon.id === weaponFocus.weaponId) : -1;
    const attachmentPlacements = useMemo(() => {
        if (!weapons?.length) return undefined;
        // A weapon being fitted is in use, so it is in the hands to pick points on.
        const held = focusIndex >= 0 ? focusIndex : Math.max(0, weapons.findIndex(weapon => weapon.startsOwned !== false));
        return weaponPlacements(weapons, { held, ready: weaponsInUse || focusIndex >= 0, owned: weapons.map(() => true) });
    }, [weapons, weaponsInUse, focusIndex]);
    const focusWeapon = focusIndex >= 0 ? weapons![focusIndex] : null;
    const pointPick = useMemo((): AttachmentPointPick | null => {
        if (!focusWeapon?.attachmentId) return null;
        const markers = WEAPON_POINTS.flatMap(([field, , color]) => {
            const point = focusWeapon[field];
            return point ? [{ point, color }] : [];
        });
        return { attachmentId: focusWeapon.attachmentId, markers, onPoint: weaponFocus?.field ? onWeaponPoint ?? null : null };
    }, [focusWeapon, weaponFocus?.field, onWeaponPoint]);
    // The held weapon's support grip, so the other hand takes hold of it in the preview as in play.
    const heldIndex = weapons?.length ? (focusIndex >= 0 ? focusIndex : Math.max(0, weapons.findIndex(weapon => weapon.startsOwned !== false))) : -1;
    const heldWeapon = heldIndex >= 0 ? weapons![heldIndex] : null;
    const heldAttachment = heldWeapon?.attachmentId && attachmentPlacements?.get(heldWeapon.attachmentId) === 'hand'
        ? attachments.find(item => item.id === heldWeapon.attachmentId)
        : null;
    const supportGrip = useMemo(() => heldWeaponGrip(heldWeapon, heldAttachment), [heldWeapon, heldAttachment]);
    // The held weapon's own locomotion plays in place of the graph's, as in play.
    const previewGraph = useMemo(
        () => weaponLocomotionGraph(blueprint.animationGraph, weaponMoveClips(heldWeapon), new Set(allClips.map(clip => clip.name))),
        [blueprint.animationGraph, heldWeapon, allClips],
    );
    const pickLabel = weaponFocus?.field? WEAPON_POINTS.find(([field]) => field === weaponFocus.field)?.[1] : null;

    /**
     * Gives the graph's states, and a player's fire and aim clips, the model's clips whose names fit
     * them (Idle, Walk, Run, Jump, Shooting, ...), where none is set or the model lacks the one that is.
     * Linking a mesh does this too.
     */
    const matchClips = (model: LoadedModelData, linking: boolean) => {
        const clips = (model.animations ?? []).map(clip => clip.name);
        const graph = matchGraphClips(blueprint.animationGraph, clips);
        const upper = blueprint.type === 'Player Character'
            ? matchUpperBodyClips(blueprint.upperBody, clips)
            : { settings: blueprint.upperBody, assigned: [] };
        const assigned = [...graph.assigned, ...upper.assigned];
        if (linking || assigned.length) {
            onUpdate(blueprint.id, {
                ...(linking ? { linkedModelId: model.id } : {}),
                ...(graph.assigned.length ? { animationGraph: graph.graph } : {}),
                ...(upper.assigned.length ? { upperBody: upper.settings } : {}),
            });
        }
        if (assigned.length) {
            const list = assigned.slice(0, 6).map(item => `${item.target} → ${item.clip}`).join(', ');
            addNotification({
                message: `Matched ${assigned.length} to ${model.name}'s clips: ${list}${assigned.length > 6 ? ', …' : ''}.`,
                type: 'success',
            });
        } else if (!linking) {
            addNotification({
                message: model.animations?.length
                    ? `Every state already plays one of ${model.name}'s clips, or none of its clip names fit a state.`
                    : `${model.name} has no animation clips. Import some with Import > Animation.`,
                type: 'info',
            });
        }
    };

    const filteredModels = useMemo(() => {
        return models.filter(m => m.name.toLowerCase().includes(meshSearch.toLowerCase()));
    }, [models, meshSearch]);

    // Resolve texture URL
    const textureUrl = useMemo(() => {
        const tex = textures.find(t => t.id === blueprint.textureId);
        return tex ? tex.url : null;
    }, [blueprint.textureId, textures]);

    return (
        <div className="flex-1 flex flex-col min-w-0 bg-gray-900 relative">
            {/* Blueprint Toolbar */}
            <div className="h-12 border-b border-gray-800 bg-gray-900 shrink-0 flex items-center justify-between px-4 z-20">
                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                        {blueprint.type === 'Player Character' ? <Shield size={18} className="text-blue-400" /> : <Skull size={18} className="text-red-400" />}
                        <input 
                            value={blueprint.name}
                            onChange={(e) => onUpdate(blueprint.id, { name: e.target.value }, { coalesce: 'name' })}
                            className="bg-transparent text-sm font-bold text-white focus:outline-none focus:border-b border-gray-600 w-48"
                        />
                    </div>
                    <div className="h-6 w-px bg-gray-800"></div>
                    <div className="flex items-center gap-2 text-xs text-gray-500">
                        <Box size={12} />
                        <span>Setup Mode</span>
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1">
                        <button
                            type="button"
                            onClick={history.undo}
                            disabled={!history.canUndo}
                            title="Undo (Ctrl+Z)"
                            aria-label="Undo"
                            className="p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400 transition-colors"
                        >
                            <Undo2 size={14} />
                        </button>
                        <button
                            type="button"
                            onClick={history.redo}
                            disabled={!history.canRedo}
                            title="Redo (Ctrl+Y)"
                            aria-label="Redo"
                            className="p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400 transition-colors"
                        >
                            <Redo2 size={14} />
                        </button>
                    </div>
                    <button
                        type="button"
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onRemove(blueprint.id);
                        }}
                        className="flex items-center gap-2 text-xs font-bold bg-red-900/20 hover:bg-red-900/50 text-red-400 hover:text-red-200 px-3 py-1.5 rounded border border-red-900/50 transition-colors"
                    >
                        <Trash2 size={12} /> Delete Blueprint
                    </button>
                </div>
            </div>

            {/* 3D Viewport with Overlays */}
            <div className="flex-1 bg-black relative border-r border-gray-800 overflow-hidden">
                <div className="absolute top-4 left-4 z-10 bg-black/50 backdrop-blur px-3 py-1 rounded-full text-[10px] text-gray-400 border border-white/10 flex items-center gap-2">
                    <Eye size={10} /> Mesh Preview
                </div>
                {pickLabel && (
                    <div className="absolute top-14 left-1/2 -translate-x-1/2 z-10 bg-blue-600/90 text-white text-xs px-3 py-1.5 rounded-full shadow">
                        Click the {pickLabel.toLowerCase()} on the weapon
                    </div>
                )}
                {attachmentPlacements && (
                    <div className="absolute top-4 right-4 z-10 flexrounded-full border border-white/10 bg-black/50 backdrop-blur text-[10px] overflow-hidden">
                        {([[false, 'Weapons at rest'], [true, 'Weapon in use']] as const).map(([inUse, label]) => (
                            <button
                                key={label}
                                type="button"
                                onClick={() => setWeaponsInUse(inUse)}
                                className={`px-3 py-1 ${weaponsInUse === inUse ? 'bg-blue-600 text-accent-ink' : 'text-gray-400 hover:text-gray-200'}`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                )}
                
                {/* 3D Canvas */}
                {visible && (
                    <GraphPreview 
                        graph={previewGraph}
                        allClips={allClips}
                        model={linkedModel || undefined}
                        scale={blueprint.meshScale}
                        textureUrl={textureUrl}
                        attachmentPlacements={attachmentPlacements}
                        pointPick={pointPick}
                        supportGrip={supportGrip}
                    />
                )}
                
                {/* Mesh Selector Overlay */}
                <div className="absolute bottom-4 left-4 right-4 bg-gray-900/95 backdrop-blur p-0 rounded-xl border border-gray-700 shadow-2xl max-w-lg mx-auto overflow-visible">
                    <div className="p-4 border-b border-gray-800 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <Box size={16} className="text-gray-400" />
                            <span className="text-xs font-bold text-gray-200">LINKED MESH</span>
                        </div>
                        {linkedModel && (
                            <button
                                type="button"
                                onClick={() => matchClips(linkedModel, false)}
                                className="flex items-center gap-1.5 text-[10px] font-bold text-gray-300 hover:text-white bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded px-2 py-1 transition-colors"
                                title="Give each animation state the clip of this mesh whose name fits it (Idle, Walk, Run, Jump, Falling, Land, Attack, Death...), where the state has none or one this mesh lacks"
                            >
                                <Wand2 size={12} /> Match Clips
                            </button>
                        )}
                    </div>

                    <div className="p-4">
                        <div className="relative">
                            <button 
                                onClick={() => setIsMeshSelectorOpen(!isMeshSelectorOpen)}
                                className="w-full bg-gray-950 hover:bg-gray-800 border border-gray-700 rounded-lg p-3 text-sm text-white focus:outline-none focus:border-blue-500 flex items-center justify-between transition-colors"
                            >
                                {linkedModel ? (
                                    <div className="flex items-center gap-3">
                                        <div className="w-8 h-8 rounded bg-gray-800 overflow-hidden border border-gray-600">
                                            {linkedModel.thumbnail ? <img src={linkedModel.thumbnail} className="w-full h-full object-cover" /> : <Box size={16} className="m-auto mt-2 opacity-50"/>}
                                        </div>
                                        <div className="text-left">
                                            <div className="font-bold text-xs">{linkedModel.name}</div>
                                            <div className="text-[9px] text-gray-400 uppercase">{linkedModel.category}</div>
                                        </div>
                                    </div>
                                ) : (
                                    <span className="text-gray-500 italic">-- Select a Mesh --</span>
                                )}
                                <ChevronUp size={14} className={`text-gray-500 transition-transform ${isMeshSelectorOpen ? 'rotate-180' : ''}`} />
                            </button>

                            {isMeshSelectorOpen && (
                                <div className="absolute bottom-full left-0 right-0 mb-2 bg-gray-900 border border-gray-700 rounded-lg shadow-xl max-h-80 flex flex-col z-50 overflow-hidden">
                                    <div className="p-2 border-b border-gray-800 bg-gray-950">
                                        <div className="relative">
                                            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
                                            <input 
                                                type="text" 
                                                placeholder="Search models..." 
                                                value={meshSearch}
                                                onChange={(e) => setMeshSearch(e.target.value)}
                                                autoFocus
                                                className="w-full bg-gray-900 border border-gray-700 rounded-full py-1.5 pl-8 pr-4 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
                                            />
                                        </div>
                                    </div>
                                    <div className="flex-1 overflow-y-auto custom-scrollbar">
                                        {filteredModels.length === 0 && (
                                            <div className="p-6 text-center text-gray-500 text-xs">
                                                {models.length === 0 ? "No models imported." : "No matching models found."}
                                            </div>
                                        )}
                                        {filteredModels.map(m => (
                                            <div 
                                                key={m.id}
                                                onClick={() => {
                                                    matchClips(m, true);
                                                    setIsMeshSelectorOpen(false);
                                                }}
                                                className={`flex items-center gap-3 p-2 hover:bg-gray-800 cursor-pointer border-b border-gray-800 last:border-0 ${linkedModel?.id === m.id ? 'bg-blue-900/20' : ''}`}
                                            >
                                                    <div className="w-8 h-8 rounded bg-gray-800 overflow-hidden border border-gray-700 shrink-0 relative">
                                                    {m.thumbnail ? <img src={m.thumbnail} className="w-full h-full object-cover" /> : <Box size={14} className="m-auto mt-2 opacity-30"/>}
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className={`text-xs font-bold truncate ${linkedModel?.id === m.id ? 'text-blue-400' : 'text-gray-300'}`}>{m.name}</div>
                                                    <div className="text-[9px] text-gray-500 uppercase">{m.category}</div>
                                                </div>
                                                {linkedModel?.id === m.id && <Check size={14} className="text-blue-500" />}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>

                        <p className="text-[10px] text-gray-500 mt-3 leading-relaxed">
                            Select the skeletal mesh (FBX) that this blueprint controls. 
                            <br/>Animations will be previewed on this mesh. Linking it gives each state the mesh's clip whose name fits.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};
