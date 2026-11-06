import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ArrowLeftIcon, GraphIcon, TrashIcon } from '../../UI/Icons';
import { useAssets } from '../../../context/AssetContext';
import { MATERIALS_DOMAIN, materialAssetDocument, materialLibrary, type MaterialAsset } from '../../../runtime/materials/materialLibrary';
import { createMaterialGraph } from '../../../runtime/materials/materialGraph';
import { projectService } from '../../../utils/projectService';
import { hashText } from '../../../texturing/graph/document';
import type { GraphResolver } from '../../../texturing/graph/registry';
import type { TextureGraph } from '../../../texturing/graph/types';
import { MATERIAL_PRESETS, brushMaterialLayer, pictureMaterialLayer, presetLayer } from '../../../texturing/paint/materialPresets';
import { PREVIEW_PIXELS, paintPreviews, type PreviewHost } from '../../../texturing/paint/previews';
import { SMART_MATERIALS, graphMaterialLayer } from '../../../texturing/paint/smartLibrary';
import { instantiateSmartMaterial, readSmartMaterial, smartMaterialGraph, type SmartMaterialStore } from '../../../texturing/paint/smartMaterials';
import { CHANNEL_LABELS, type PaintChannel, type PaintDocument, type PaintLayer } from '../../../texturing/paint/paintTypes';
import { Tooltip } from '../../UI/kit';
import { newTextureGraphStored } from '../TextureGraphWorkspace';
import { requestOpenMaterial } from './openMaterial';

/**
 * Picking a material, with a rendered ball for each: preset materials, smart materials (built in and
 * saved in the project), the project's texture graphs and pictures, and the brush's own values. Used to
 * add a layer covering the surface, or to paint a material on.
 */

export interface MaterialChoice {
    /** Tells its preview apart (changes when what it makes changes). */
    key: string;
    name: string;
    hint?: string;
    make: (document: PaintDocument) => PaintLayer;
    /** A colour to show until (or instead of) the rendered ball. */
    swatch: string;
    /** A picture shown instead of a rendered ball. */
    picture?: string;
    /** Opens it in the texture graph editor (a copy, unless it is a texture graph already). */
    edit?: { label: string; run: () => Promise<string> };
    /** Removes it from the project (saved smart materials). */
    remove?: () => Promise<void>;
}

export interface MaterialSection { title: string; choices: MaterialChoice[] }

const css = ([r, g, b]: readonly number[]): string => `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;

/** Keeps a material asset in the project, taking it back out of the library when the project will not have it. */
export const persistMaterialAsset = async (asset: MaterialAsset): Promise<void> => {
    materialLibrary.upsert(asset);
    try {
        await projectService.applyChanges([{ domain: MATERIALS_DOMAIN, operation: 'upsert', id: asset.id, value: materialAssetDocument(asset) }]);
    } catch (error) {
        materialLibrary.remove(asset.id);
        throw error;
    }
};

/** Where saved smart materials go: the material library and the project. */
export const smartMaterialStore: SmartMaterialStore = {
    upsert: (asset) => materialLibrary.upsert(asset),
    remove: (id) => materialLibrary.remove(id),
    persist: async (asset) => { await projectService.applyChanges([{ domain: MATERIALS_DOMAIN, operation: 'upsert', id: asset.id, value: materialAssetDocument(asset) }]); },
};

/** Puts `graph` in the project as a texture graph called `name` and asks for it to be opened; returns its id and what to tell the user. */
export const openGraphCopy = async (name: string, graph: TextureGraph): Promise<{ id: string; message: string }> => {
    const asset: MaterialAsset = { id: crypto.randomUUID(), name: name.slice(0, 128), graph: createMaterialGraph(), textureGraph: newTextureGraphStored(graph) };
    await persistMaterialAsset(asset);
    requestOpenMaterial(asset.id);
    return { id: asset.id, message: `"${asset.name}" is now a texture graph in the Materials tab, ready to change.` };
};

/** A texture set with every channel, for making copies of materials outside any set. */
const ALL_CHANNELS: Pick<PaintDocument, 'channels'> = { channels: ['baseColor', 'roughness', 'metallic', 'height', 'normal', 'emissive', 'opacity'] };

/** The materials to pick from, in sections. */
export const useMaterialSections = (options: {
    resolve: GraphResolver;
    graphs: ReadonlyArray<{ id: string; name: string }>;
    textures: ReadonlyArray<{ id: string; name: string; url?: string }>;
    /** The brush, offered as a material of its own when painting. */
    brush?: { channels: readonly PaintChannel[]; values: Record<PaintChannel, [number, number, number]> };
}): MaterialSection[] => {
    const { removeMaterialAsset } = useAssets();
    const library = useSyncExternalStore((listener) => materialLibrary.subscribe(listener), () => materialLibrary.version);
    const { resolve, graphs, textures, brush } = options;
    return useMemo(() => {
        const sections: MaterialSection[] = [];
        if (brush?.channels.length) {
            const values = brush.channels.map((channel) => [channel, brush.values[channel]]);
            sections.push({
                title: 'The brush',
                choices: [{
                    key: `brush:${hashText(JSON.stringify(values))}`,
                    name: 'Its values',
                    hint: `What the brush paints now: ${brush.channels.map((channel) => CHANNEL_LABELS[channel].toLowerCase()).join(', ')}.`,
                    make: (document) => brushMaterialLayer(document, brush),
                    swatch: css(brush.values.baseColor),
                }],
            });
        }
        sections.push({
            title: 'Materials',
            choices: MATERIAL_PRESETS.map((preset) => ({
                key: `preset:${preset.id}`,
                name: preset.name,
                hint: preset.group === 'Metals' ? 'Metal' : undefined,
                make: (document) => presetLayer(document, preset),
                swatch: css(preset.baseColor),
            })),
        });
        const saved = materialLibrary.list().flatMap((asset) => {
            const smart = readSmartMaterial(asset.paint);
            return smart ? [{ asset, smart }] : [];
        });
        sections.push({
            title: 'Smart materials',
            choices: [
                ...SMART_MATERIALS.map((material): MaterialChoice => ({
                    key: `smart:${material.id}`,
                    name: material.name,
                    hint: material.description,
                    make: (document) => ({ ...material.build(document), from: material.name }),
                    swatch: material.swatch,
                    edit: { label: 'Edit a copy as a texture graph', run: async () => (await openGraphCopy(`${material.name} (graph)`, smartMaterialGraph(material.build({ ...ALL_CHANNELS } as PaintDocument), resolve))).message },
                })),
                ...saved.map(({ asset, smart }): MaterialChoice => ({
                    key: `saved:${asset.id}:${hashText(JSON.stringify(smart.layer))}`,
                    name: asset.name,
                    hint: 'Saved in this project',
                    make: (document) => instantiateSmartMaterial(smart.layer, document, asset.name),
                    swatch: '#3f3f46',
                    edit: { label: 'Edit a copy as a texture graph', run: async () => (await openGraphCopy(`${asset.name} (graph)`, smartMaterialGraph(instantiateSmartMaterial(smart.layer, ALL_CHANNELS, asset.name), resolve))).message },
                    remove: () => removeMaterialAsset(asset.id),
                })),
            ],
        });
        if (graphs.length) {
            sections.push({
                title: 'Texture graphs in this project',
                choices: graphs.flatMap((graph): MaterialChoice[] => {
                    const entry = resolve(graph.id);
                    if (!entry) return [];
                    return [{
                        key: `graph:${graph.id}:${hashText(JSON.stringify(entry.graph))}`,
                        name: graph.name,
                        make: (document) => graphMaterialLayer(document, graph.id, graph.name, entry.graph),
                        swatch: '#52525b',
                        edit: { label: 'Open in the texture graph editor', run: async () => { requestOpenMaterial(graph.id); return `"${graph.name}" is open in the Materials tab.`; } },
                    }];
                }),
            });
        }
        if (textures.length) {
            sections.push({
                title: 'Pictures',
                choices: textures.map((texture) => ({
                    key: `picture:${texture.id}`,
                    name: texture.name,
                    hint: 'Its colours, laid on from three sides',
                    make: (document) => pictureMaterialLayer(document, texture.id, texture.name),
                    swatch: '#52525b',
                    picture: texture.url,
                })),
            });
        }
        return sections;
    }, [brush, graphs, library, removeMaterialAsset, resolve, textures]); // eslint-disable-line react-hooks/exhaustive-deps
};

/** A choice's rendered ball (asked for while it is shown), or its picture. */
const Thumb: React.FC<{ choice: MaterialChoice; host: PreviewHost }> = ({ choice, host }) => {
    useSyncExternalStore(paintPreviews.subscribe, paintPreviews.getVersion);
    const { key, make, picture } = choice;
    useEffect(() => { if (!picture) paintPreviews.request(key, { make, host }); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
    const url = picture ?? paintPreviews.picture(key);
    const size = PREVIEW_PIXELS / 2;
    return url
        ? <img src={url} alt="" width={size} height={size} draggable={false} className={picture ? 'rounded object-cover' : ''} style={{ width: size, height: size }} />
        : <span className="block rounded-full opacity-70" style={{ width: size - 8, height: size - 8, margin: 4, background: `radial-gradient(circle at 35% 30%, rgba(255,255,255,0.35), transparent 55%), ${choice.swatch}` }} />;
};

/** Material choices laid out in sections of tiles. */
export const MaterialSections: React.FC<{
    sections: readonly MaterialSection[];
    host: PreviewHost;
    onPick: (choice: MaterialChoice) => void;
    onMessage?: (message: string) => void;
}> = ({ sections, host, onPick, onMessage }) => {
    const [armed, setArmed] = useState<string | null>(null);
    const run = (work: () => Promise<string | void>) => {
        void work().then((message) => { if (message) onMessage?.(message); }, (error: unknown) => onMessage?.(error instanceof Error ? error.message : 'That could not be done: is a project open?'));
    };
    return (
        <div className="space-y-2">
            {sections.map((section) => (
                <div key={section.title}>
                    <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{section.title}</div>
                    <div className="grid grid-cols-4 gap-1">
                        {section.choices.map((choice) => (
                            <div key={choice.key} className="group relative">
                                <Tooltip text={choice.hint ? `${choice.name}: ${choice.hint}` : choice.name}>
                                    <button onClick={() => onPick(choice)} className="flex w-full flex-col items-center gap-0.5 rounded border border-transparent p-1 text-2xs text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800">
                                        <Thumb choice={choice} host={host} />
                                        <span className="w-full truncate text-center leading-tight">{choice.name}</span>
                                    </button>
                                </Tooltip>
                                <div className="absolute right-0.5 top-0.5 hidden gap-0.5 group-hover:flex">
                                    {choice.edit && (
                                        <button aria-label={choice.edit.label} title={choice.edit.label} onClick={() => run(choice.edit!.run)}
                                            className="rounded bg-zinc-900/90 p-0.5 text-zinc-400 hover:text-white"><GraphIcon size={11} /></button>
                                    )}
                                    {choice.remove && (
                                        <button aria-label={armed === choice.key ? `Click again to remove ${choice.name}` : `Remove ${choice.name}`} title={armed === choice.key ? 'Click again to remove it from the project' : 'Remove from the project'}
                                            onClick={() => { if (armed !== choice.key) { setArmed(choice.key); return; } setArmed(null); run(async () => { await choice.remove!(); return `"${choice.name}" was removed from the project.`; }); }}
                                            onMouseLeave={() => setArmed((current) => (current === choice.key ? null : current))}
                                            className={`rounded bg-zinc-900/90 p-0.5 ${armed === choice.key ? 'text-red-400' : 'text-zinc-400 hover:text-white'}`}><TrashIcon size={11} /></button>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
};

/** Picking a material to paint on, with a way back to where it was opened from. */
export const MaterialPicker: React.FC<{
    sections: readonly MaterialSection[];
    host: PreviewHost;
    onPick: (choice: MaterialChoice) => void;
    onBack?: () => void;
    onMessage?: (message: string) => void;
}> = ({ sections, host, onPick, onBack, onMessage }) => (
    <div className="max-h-[480px] space-y-2 overflow-y-auto p-2">
        <div className="flex items-center gap-1.5">
            {onBack && <button aria-label="Back" onClick={onBack} className="rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"><ArrowLeftIcon size={13} /></button>}
            <span className="text-xs font-semibold text-zinc-200">Paint with a material</span>
        </div>
        <p className="px-1 text-2xs leading-snug text-zinc-500">Pick one, then paint: strokes lay it on in every channel it has. It goes on as a fill layer under a black mask, which your strokes paint white.</p>
        <MaterialSections sections={sections} host={host} onPick={onPick} onMessage={onMessage} />
    </div>
);
