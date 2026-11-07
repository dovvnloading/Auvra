import React, { useMemo, useState, useSyncExternalStore } from 'react';
import { CrossIcon, WarningIcon } from '../UI/Icons';
import { IconButton, Section } from '../UI/kit';
import { Select } from '../UI/Select';
import { useScene } from '../../context/SceneContext';
import { useNativeProjectDocument } from '../../utils/useNativeProjectDocument';
import { DEFAULT_GAME_SETTINGS, GAME_SETTINGS_DOCUMENT_ID, normalizeGameSettings, type GameSettings } from '../../runtime/types';
import { graphTextures, materialAssetDocument, materialLibrary } from '../../runtime/materials/materialLibrary';
import { isSmartMaterialAsset } from '../../texturing/paint/smartMaterials';
import { compressionSupport } from '../../texturing/materialTextureLoader';
import { subscribeTextureSettings, textureSettingsOf, textureSettingsVersion, FORMAT_WORDS } from '../../texturing/textureSettings';
import { budgetWarnings, levelTextureCost, materialTextureCost, memoryWords, type TextureCost } from '../../texturing/textureBudget';

/**
 * TEXTURE MEMORY
 *
 * What textures cost on the GPU, as the project keeps them: per level (against the game's asset memory),
 * per material asset, and the largest textures, with plain warnings where it is a lot. Opened from the
 * Materials tab.
 */

const createDefault = () => ({ id: GAME_SETTINGS_DOCUMENT_ID, settings: normalizeGameSettings(DEFAULT_GAME_SETTINGS) });

const TextureRows: React.FC<{ textures: readonly TextureCost[]; limit?: number }> = ({ textures, limit = 6 }) => (
    <ul className="space-y-0.5">
        {textures.slice(0, limit).map(texture => (
            <li key={texture.id} className="flex items-center justify-between gap-2 text-2xs">
                <span className="min-w-0 truncate text-ink-2" title={`${texture.name}: ${texture.width}×${texture.height}, ${FORMAT_WORDS[texture.format]}`}>{texture.name}</span>
                <span className="shrink-0 text-ink-3">{texture.width}×{texture.height} · {memoryWords(texture.bytes)}</span>
            </li>
        ))}
        {textures.length > limit && (
            <li className="text-2xs text-ink-3">
                and {textures.length - limit} more, {memoryWords(textures.slice(limit).reduce((sum, texture) => sum + texture.bytes, 0))}
            </li>
        )}
    </ul>
);

export const TextureMemoryDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const { levels, currentLevelId, levelObjects, models, textures } = useScene();
    const { document } = useNativeProjectDocument<{ id: string; settings: GameSettings }>('metadata', GAME_SETTINGS_DOCUMENT_ID, createDefault);
    const budgetMb = normalizeGameSettings(document.settings).quality.assetMemoryMb;
    const libraryVersion = useSyncExternalStore((listener) => materialLibrary.subscribe(listener), () => materialLibrary.version);
    const settingsVersion = useSyncExternalStore(subscribeTextureSettings, textureSettingsVersion);
    const [levelId, setLevelId] = useState(currentLevelId ?? levels[0]?.id ?? '');
    const support = useMemo(() => compressionSupport(), []);

    const { materials, byMaterial, textureInfo } = useMemo(() => {
        const info = new Map(textures.map(texture => [texture.id, { ...texture, settings: textureSettingsOf(texture.id) ?? texture.settings }]));
        const assets = (libraryVersion >= 0 && settingsVersion >= 0 ? materialLibrary.list() : []).filter(asset => !isSmartMaterialAsset(asset));
        const list = assets.map(asset => ({
            id: asset.id,
            name: asset.name,
            textureIds: materialAssetDocument(asset).textureIds,
            slots: new Map(graphTextures(asset.graph).map(texture => [texture.textureId, texture.slot === 'normal' ? 'normal' as const : texture.slot === 'data' ? 'data' as const : 'map' as const])),
        }));
        return {
            materials: new Map(list.map(material => [material.id, material])),
            byMaterial: list.map(material => ({ material, cost: materialTextureCost(material, info, support) })).filter(entry => entry.cost.bytes > 0).sort((a, b) => b.cost.bytes - a.cost.bytes),
            textureInfo: info,
        };
    }, [textures, libraryVersion, settingsVersion, support]);

    const objects = useMemo(() => levelObjects.filter(object => object.levelId === levelId), [levelObjects, levelId]);
    const level = useMemo(() => levelTextureCost(objects, models, materials, textureInfo, support), [objects, models, materials, textureInfo, support]);
    const warnings = budgetWarnings(level, budgetMb);
    const share = Math.min(1, level.bytes / (budgetMb * 1024 ** 2));

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Texture memory"
            onKeyDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <div className="flex max-h-full w-[480px] max-w-full flex-col overflow-hidden rounded-lg border border-line bg-ground shadow-[0_8px_32px_rgb(0_0_0/0.6)]">
                <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-3 py-2">
                    <div>
                        <h2 className="text-xs font-semibold text-ink">Texture memory</h2>
                        <p className="text-2xs text-ink-3">What textures take on the graphics card, as they are kept.</p>
                    </div>
                    <IconButton label="Close" onClick={onClose}><CrossIcon size={14} /></IconButton>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                    <Section title="Level" actions={levels.length > 1 ? (
                        <div className="w-44"><Select value={levelId} placeholder="Level" options={levels.map(entry => ({ value: entry.id, label: entry.name }))} onChange={(value: string) => setLevelId(value)} className="w-full" /></div>
                    ) : undefined}>
                        <div className="flex items-center justify-between text-2xs">
                            <span className="text-ink-2">{memoryWords(level.bytes)} of the game's {budgetMb} MB of asset memory</span>
                            <span className="text-ink-3">{level.textures.length} textures</span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded bg-well" aria-hidden>
                            <div className={`h-full ${share >= 1 ? 'bg-red-500' : share > 0.75 ? 'bg-amber-500' : 'bg-accent'}`} style={{ width: `${Math.max(2, share * 100)}%` }} />
                        </div>
                        {warnings.length > 0 && (
                            <ul className="mt-2 space-y-1">
                                {warnings.map(warning => (
                                    <li key={warning} className="flex gap-1.5 text-2xs leading-snug text-amber-300"><WarningIcon size={12} className="mt-px shrink-0" />{warning}</li>
                                ))}
                            </ul>
                        )}
                        {level.textures.length > 0 && <div className="mt-2"><TextureRows textures={level.textures} /></div>}
                        {level.textures.length === 0 && <p className="mt-1 text-2xs text-ink-3">This level's objects use no project textures.</p>}
                    </Section>
                    <Section title="Materials">
                        {byMaterial.length === 0 && <p className="text-2xs text-ink-3">No material asset draws with project textures yet.</p>}
                        <ul className="space-y-2">
                            {byMaterial.map(({ material, cost }) => (
                                <li key={material.id}>
                                    <div className="flex items-center justify-between text-2xs">
                                        <span className="font-medium text-ink-2">{material.name}</span>
                                        <span className="text-ink-3">{memoryWords(cost.bytes)}</span>
                                    </div>
                                    <TextureRows textures={cost.textures} limit={3} />
                                </li>
                            ))}
                        </ul>
                    </Section>
                </div>
            </div>
        </div>
    );
};
