import React, { useCallback, useMemo, useRef } from 'react';
import { Brush, ImageOff, Layers, Plus, X } from 'lucide-react';
import { LevelObject, TerrainData } from '../../../types';
import { useScene } from '../../../context/SceneContext';
import { editorSession } from '../../../utils/editorSession';
import { ScrubbableInput } from '../../UI/Properties/ScrubbableInput';
import { TerrainBrushSettings } from './TerrainSculptor';
import {
    DEFAULT_TERRAIN_LAYER_TILING,
    hasTerrainSplat,
    isTerrainSplatPending,
    MAX_TERRAIN_LAYER_TILING,
    MAX_TERRAIN_LAYERS,
    normalizeTerrainLayers,
    withoutTerrainSplatChannel,
    type TerrainPaintState,
    type TerrainTextureLayerSettings,
} from './terrainSplatCodec';

interface TerrainLayerPanelProps {
    terrain: LevelObject;
    sculptSettings: TerrainBrushSettings;
    onSculptSettingsChange: (settings: TerrainBrushSettings) => void;
}

const SECTION_TITLE = 'flex items-center gap-2 text-2xs font-bold text-gray-500 border-b border-gray-800 pb-1';
// Splat channel N weights layer N.
const CHANNEL_COLORS = ['bg-red-500', 'bg-green-500', 'bg-blue-500', 'bg-gray-300'];

/**
 * Texture layers of a terrain: up to four textures with their tiling, blended
 * by the splat map the sculpt panel's Paint tool edits. Layer 1 covers the
 * terrain until other layers are painted over it.
 */
export const TerrainLayerPanel: React.FC<TerrainLayerPanelProps> = ({ terrain, sculptSettings, onSculptSettingsChange }) => {
    const { textures, updateLevelObject, snapshotHistory } = useScene();
    const terrainData = terrain.terrainData;
    const paintState: TerrainPaintState | undefined = terrainData;
    const layers = useMemo(() => normalizeTerrainLayers(paintState?.textureLayers), [paintState?.textureLayers]);
    const splatPending = isTerrainSplatPending(paintState);
    const paintLayer = Math.max(0, Math.floor(sculptSettings.paintLayer ?? 0));
    const painting = sculptSettings.tool === 'paint';

    const textureOptions = useMemo(
        () => [...textures].sort((a, b) => a.name.localeCompare(b.name)),
        [textures],
    );
    const textureById = useMemo(() => new Map(textures.map(texture => [texture.id, texture])), [textures]);

    // One undo snapshot per discrete edit, and one per tiling scrub or typing gesture.
    const armedRef = useRef(true);
    const arm = useCallback(() => { armedRef.current = true; }, []);
    const canEdit = () => Boolean(terrainData) && editorSession.captureReady() !== null;

    const writeTerrain = (changes: Partial<TerrainPaintState>) => {
        if (!terrainData) return;
        updateLevelObject(terrain.id, { terrainData: { ...terrainData, ...changes } as TerrainData });
    };

    const commitLayers = (next: TerrainTextureLayerSettings[], extra: Partial<TerrainPaintState> = {}) => {
        if (!canEdit()) return;
        snapshotHistory();
        armedRef.current = false;
        writeTerrain({ textureLayers: next, ...extra });
    };

    const scrubLayers = (next: TerrainTextureLayerSettings[]) => {
        if (!canEdit()) return;
        if (armedRef.current) {
            snapshotHistory();
            armedRef.current = false;
        }
        writeTerrain({ textureLayers: next });
    };

    const replaceLayer = (index: number, layer: TerrainTextureLayerSettings) => layers.map((current, i) => (i === index ? layer : current));

    const addLayer = () => {
        if (layers.length >= MAX_TERRAIN_LAYERS) return;
        commitLayers([...layers, { tiling: DEFAULT_TERRAIN_LAYER_TILING }]);
    };

    // Only the last layer can be removed, so channel N keeps weighting layer N.
    // Its painted weight returns to layer 1.
    const removeLastLayer = () => {
        const index = layers.length - 1;
        if (index < 0 || splatPending) return;
        const next = layers.slice(0, index);
        const extra = paintState && hasTerrainSplat(paintState) && paintState.splat
            ? { splat: withoutTerrainSplatChannel(paintState.splat, index) }
            : {};
        commitLayers(next, extra);
        if (paintLayer >= next.length) {
            onSculptSettingsChange({ ...sculptSettings, paintLayer: Math.max(0, next.length - 1) });
        }
    };

    const selectPaintLayer = (index: number) => {
        onSculptSettingsChange({ ...sculptSettings, tool: 'paint', paintLayer: index });
    };

    return (
        <div className="space-y-3" onPointerDownCapture={arm} onFocusCapture={arm}>
            <div className={SECTION_TITLE}>
                <Layers size={12} /> Texture Layers
                <span className="ml-auto font-mono normal-case text-gray-600">{layers.length}/{MAX_TERRAIN_LAYERS}</span>
            </div>

            {layers.length === 0 && (
                <p className="text-2xs text-gray-500 leading-relaxed">
                    No layers: the terrain uses its flat material. Add a layer to texture it, then add more and paint them on.
                </p>
            )}

            {splatPending && layers.length > 0 && (
                <p className="text-2xs text-amber-400/90 leading-relaxed">
                    Painted layer weights are loading; painting is unavailable until they arrive.
                </p>
            )}

            <div className="space-y-2">
                {layers.map((layer, index) => {
                    const texture = layer.textureId ? textureById.get(layer.textureId) : undefined;
                    const active = painting && paintLayer === index;
                    const isLast = index === layers.length - 1;
                    return (
                        <div
                            key={index}
                            className={`rounded border p-2 space-y-2 transition-colors ${active ? 'border-purple-500 bg-purple-600/10' : 'border-gray-700 bg-gray-800/60'}`}
                        >
                            <div className="flex items-center gap-2">
                                <div className="relative w-8 h-8 rounded overflow-hidden bg-gray-700 shrink-0 flex items-center justify-center">
                                    {texture
                                        ? <img src={texture.url} alt="" className="w-full h-full object-cover" draggable={false} />
                                        : <ImageOff size={14} className="text-gray-500" />}
                                    <span className={`absolute bottom-0 right-0 w-2 h-2 rounded-tl ${CHANNEL_COLORS[index]}`} />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="text-xs font-bold text-gray-200">
                                        Layer {index + 1}{index === 0 && <span className="ml-1 font-normal text-gray-500">(base)</span>}
                                    </div>
                                    <div className="text-2xs text-gray-500 truncate">{texture ? texture.name : 'No texture'}</div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => selectPaintLayer(index)}
                                    disabled={splatPending}
                                    title={splatPending ? 'Layer weights are still loading' : `Paint layer ${index + 1}`}
                                    aria-pressed={active}
                                    className={`p-1.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${active ? 'border-purple-500 text-purple-300 bg-purple-600/20' : 'border-gray-700 text-gray-400 hover:bg-gray-700'}`}
                                >
                                    <Brush size={12} />
                                </button>
                                {isLast && (
                                    <button
                                        type="button"
                                        onClick={removeLastLayer}
                                        disabled={splatPending}
                                        title={index === 0 ? 'Remove layer (back to the flat material)' : 'Remove layer (its paint returns to layer 1)'}
                                        className="p-1.5 rounded border border-gray-700 text-gray-400 hover:text-red-400 hover:border-red-500/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        <X size={12} />
                                    </button>
                                )}
                            </div>

                            <label className="flex items-center justify-between gap-2">
                                <span className="text-2xs text-gray-400">Texture</span>
                                <select
                                    value={layer.textureId ?? ''}
                                    onChange={(event) => {
                                        const textureId = event.target.value;
                                        commitLayers(replaceLayer(index, textureId ? { textureId, tiling: layer.tiling } : { tiling: layer.tiling }));
                                    }}
                                    className="w-36 bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-2xs text-gray-200 focus:outline-none focus:border-amber-500"
                                >
                                    <option value="">None</option>
                                    {textureOptions.map(option => (
                                        <option key={option.id} value={option.id}>{option.name}</option>
                                    ))}
                                </select>
                            </label>

                            <div className="flex items-center justify-between gap-2">
                                <span className="text-2xs text-gray-400">Tiling</span>
                                <div className="w-24">
                                    <ScrubbableInput
                                        label="x"
                                        value={layer.tiling}
                                        onChange={(value) => scrubLayers(replaceLayer(index, {
                                            ...layer,
                                            tiling: Math.min(MAX_TERRAIN_LAYER_TILING, Math.max(0.1, value)),
                                        }))}
                                        step={0.5}
                                        labelWidth="w-6"
                                    />
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            <button
                type="button"
                onClick={addLayer}
                disabled={layers.length >= MAX_TERRAIN_LAYERS || !terrainData}
                className="w-full py-1.5 rounded border border-dashed border-gray-700 text-2xs font-bold text-gray-400 hover:text-white hover:border-gray-500 transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
                <Plus size={12} /> Add Layer
            </button>
        </div>
    );
};
