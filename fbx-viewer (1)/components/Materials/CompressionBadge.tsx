import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChipIcon, WarningIcon } from '../UI/Icons';
import { Button, Popover, Spinner } from '../UI/kit';
import { useAssets } from '../../context/AssetContext';
import { withMaterialPictures } from '../../runtime/materials/materialGraph';
import { graphTextures, materialLibrary, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import { compressionAdvice, FIX_WORDS, type CompressionAdvice, type CompressionFix } from '../../texturing/compressionAdvice';
import { compressionSupport } from '../../texturing/materialTextureLoader';
import { limitPictureSize, pictureToRgba8 } from '../../texturing/textureDecode';
import { decodePictureOffPage } from '../../texturing/texturePipeline';
import { FORMAT_WORDS, MAX_SIZE_CHOICES, keptFormat, limitedSize, setTextureSettings, textureRole, textureSettingsOf, type KeptFormat, type TextureSettings } from '../../texturing/textureSettings';
import { textureMemoryBytes } from '../../utils/textureCompression/materialTextureEncoder';
import type { TextureData } from '../../types';

/**
 * WHAT A MATERIAL'S TEXTURES COST AS THE GAME KEEPS THEM
 *
 * The badge beside a material's preview: its textures' memory on the graphics card as the game keeps them (compressed by
 * role, at their size limits, with their mips; the preview draws them so too), and whether compression hurts any of
 * them (texturing/compressionAdvice.ts). Its list names each texture's format, size and cost, what is lost, and a fix:
 * keep it uncompressed, or raise its size limit.
 */

interface TextureCost {
    texture: TextureData;
    role: ReturnType<typeof textureRole>;
    format: KeptFormat;
    drawn: { width: number; height: number };
    bytes: number;
    settings: TextureSettings | undefined;
}

const megabytes = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const compressed = (format: KeptFormat): format is Exclude<KeptFormat, 'rgba8' | 'half'> => format !== 'rgba8' && format !== 'half';

/** The material's textures as the game keeps them. */
const costsOf = (asset: MaterialAsset, textures: readonly TextureData[]): TextureCost[] => {
    const seen = new Set<string>();
    return graphTextures(withMaterialPictures(asset.graph, asset.pictures)).flatMap(({ textureId, slot }) => {
        const texture = textures.find(candidate => candidate.id === textureId);
        if (!texture || seen.has(textureId)) return [];
        seen.add(textureId);
        const settings = textureSettingsOf(textureId) ?? texture.settings;
        const role = textureRole(slot, settings);
        const drawn = limitedSize(texture.dimensions.width || 1, texture.dimensions.height || 1, settings?.maxSize);
        const source = settings?.source;
        const format = keptFormat(role, settings, compressionSupport(), { channels: source?.channels ?? 4, depth: source?.depth ?? 8, hdr: source?.hdr === true, ...drawn });
        return [{ texture, role, format, drawn, settings, bytes: textureMemoryBytes(drawn.width, drawn.height, format, settings?.mips !== false) }];
    });
};

/** What compressing a texture loses, read from its file as the game reads it. */
const adviseOn = async (cost: TextureCost): Promise<CompressionAdvice | null> => {
    if (!compressed(cost.format)) return null;
    const bytes = new Uint8Array(await (await fetch(cost.texture.sourceUrl ?? cost.texture.url)).arrayBuffer());
    const picture = limitPictureSize(await decodePictureOffPage(bytes, cost.texture.name), cost.settings?.maxSize);
    const limited = picture.width < (cost.texture.dimensions.width || picture.width);
    return compressionAdvice(pictureToRgba8(picture, picture.depth === 32 && cost.role === 'colour'), picture.width, picture.height, cost.role, cost.format, limited);
};

/** The settings with a fix applied: compression off, or the size limit one step up (or none). */
const fixedSettings = (settings: TextureSettings | undefined, fix: CompressionFix): TextureSettings => {
    if (fix === 'uncompressed') return { ...(settings ?? {}), compression: 'none' };
    const larger = MAX_SIZE_CHOICES.find(choice => choice > (settings?.maxSize ?? Infinity));
    const { maxSize: _limit, ...rest } = settings ?? {};
    return larger ? { ...rest, maxSize: larger } : rest;
};

export const CompressionBadge: React.FC<{ asset: MaterialAsset }> = ({ asset }) => {
    const { textures } = useAssets();
    const costs = useMemo(() => costsOf(asset, textures), [asset, textures]);
    const [advice, setAdvice] = useState<Record<string, CompressionAdvice | null>>({});
    const [checking, setChecking] = useState(false);
    const [open, setOpen] = useState(false);
    const anchor = useRef<HTMLButtonElement>(null);
    const signature = costs.map(cost => `${cost.texture.id}:${cost.format}:${cost.drawn.width}`).join('|');
    // Checked once the list opens, and again when what is kept changes.
    useEffect(() => {
        if (!open) return;
        let current = true;
        setChecking(true);
        void (async () => {
            const found: Record<string, CompressionAdvice | null> = {};
            for (const cost of costs) found[cost.texture.id] = await adviseOn(cost).catch(() => null);
            if (current) { setAdvice(found); setChecking(false); }
        })();
        return () => { current = false; };
    }, [open, signature]); // eslint-disable-line react-hooks/exhaustive-deps
    if (!costs.length) return null;
    const total = costs.reduce((sum, cost) => sum + cost.bytes, 0);
    const problems = costs.filter(cost => advice[cost.texture.id]?.problem).length;
    const fix = async (cost: TextureCost, how: CompressionFix) => {
        const next = fixedSettings(cost.settings, how);
        const { dbOperations } = await import('../../utils/db');
        await dbOperations.updateTextureSettings(cost.texture.id, next);
        setTextureSettings(cost.texture.id, next);
        materialLibrary.reloadTexture(cost.texture.id);
    };
    return (
        <>
            <button ref={anchor} type="button" onClick={() => setOpen(value => !value)} aria-expanded={open}
                title="What this material's textures take on the graphics card as the game keeps them, and where compression hurts"
                className="flex w-full items-center gap-1.5 rounded border border-gray-800 bg-gray-900/60 px-2 py-1 text-left text-2xs text-gray-300 hover:bg-gray-800">
                <ChipIcon size={12} className="shrink-0 text-gray-500" />
                <span className="min-w-0 flex-1 truncate">{megabytes(total)} on the graphics card, as the game keeps it</span>
                {problems > 0 && <span className="flex shrink-0 items-center gap-1 text-amber-400"><WarningIcon size={11} /> {problems}</span>}
            </button>
            <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={340} label="Textures as the game keeps them">
                <div className="max-h-96 space-y-2 overflow-y-auto p-2">
                    {checking && <div className="flex items-center gap-2 text-2xs text-ink-3"><Spinner /> Comparing each texture with itself compressed…</div>}
                    {costs.map((cost) => {
                        const found = advice[cost.texture.id];
                        const shrunk = cost.drawn.width < (cost.texture.dimensions.width || cost.drawn.width);
                        return (
                            <div key={cost.texture.id} className="space-y-0.5 border-b border-line pb-2 last:border-b-0">
                                <div className="truncate text-xs text-ink" title={cost.texture.name}>{cost.texture.name}</div>
                                <div className="text-2xs text-ink-3">
                                    {FORMAT_WORDS[cost.format]} · {cost.drawn.width}×{cost.drawn.height}{shrunk ? ` of ${cost.texture.dimensions.width}×${cost.texture.dimensions.height}` : ''} · {megabytes(cost.bytes)}
                                </div>
                                {found?.problem && (
                                    <div className="flex items-start gap-2 pt-0.5">
                                        <p className="min-w-0 flex-1 text-2xs leading-snug text-amber-300">{found.problem}</p>
                                        {found.fix && <Button size="sm" onClick={() => void fix(cost, found.fix!)}>{FIX_WORDS[found.fix]}</Button>}
                                    </div>
                                )}
                                {!found?.problem && !checking && compressed(cost.format) && found && <p className="text-2xs text-ink-3">Compresses well.</p>}
                            </div>
                        );
                    })}
                    <p className="text-2xs leading-snug text-ink-3">The preview draws them as the game keeps them: compressed by role, at their size limits, with their mips.</p>
                </div>
            </Popover>
        </>
    );
};
