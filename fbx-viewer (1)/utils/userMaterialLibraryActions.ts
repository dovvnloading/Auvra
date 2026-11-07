import { materialAssetDocument, withRenamedTextures, type MaterialAsset } from '../runtime/materials/materialLibrary';
import type { TextureSettings } from '../texturing/textureSettings';
import type { TextureData } from '../types';
import {
    libraryMaterial, libraryNodeGraphs, portableSettings, uniqueName, usedNodeGraphs, withRenamedNodeGraphs,
    type LibraryEntry, type LibraryPicture, type UserMaterialLibrary,
} from './userMaterialLibrary';

/**
 * Moving materials between the open project and My library: a project material taken in with its pictures,
 * and a library material brought into the project as its own copy, its pictures added as the project's
 * textures. The project and the renderer are handed in, so this runs (and is tested) without either.
 */

/** Where a project's pictures are read from. */
export interface ProjectPictures {
    /** The pictures the editor has loaded. */
    textures: readonly TextureData[];
    settingsOf(textureId: string): TextureSettings | undefined;
    read(url: string): Promise<Blob>;
    /**
     * Pictures the project keeps that the editor has not loaded (it loads what the open level needs): read from the
     * project itself. Those it does not keep are left out.
     */
    unlisted?(textureIds: readonly string[]): Promise<LibraryPicture[]>;
}

type StoredGraphLike = { graph?: { parameters?: unknown; presets?: unknown; nodes?: unknown }; values?: unknown };
const pictureParameterNames = (asset: MaterialAsset | undefined): string[] => {
    const parameters = (asset?.textureGraph as StoredGraphLike | undefined)?.graph?.parameters;
    return Array.isArray(parameters)
        ? parameters.filter((parameter) => parameter?.kind === 'texture' && typeof parameter.name === 'string').map((parameter) => parameter.name as string)
        : [];
};

/**
 * Every picture materials name: what their documents list (their pictures by name, the pictures their texture graph
 * last made, the surface graph's textures, Bitmap nodes, the record of their picture parameters), and besides, read
 * from their texture graphs, each picture parameter's default, value and presets' values, and the pictures a graph
 * used as a node is given for its picture parameters.
 */
export const materialPictureIds = (assets: readonly MaterialAsset[]): string[] => {
    const ids = new Set(assets.flatMap((asset) => materialAssetDocument(asset).textureIds));
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const add = (value: unknown) => { if (typeof value === 'string' && value) ids.add(value); };
    for (const asset of assets) {
        const stored = asset.textureGraph as StoredGraphLike | undefined;
        if (!stored?.graph) continue;
        const names = pictureParameterNames(asset);
        const parameters = Array.isArray(stored.graph.parameters) ? stored.graph.parameters as Array<Record<string, unknown> | null> : [];
        for (const parameter of parameters) if (parameter?.kind === 'texture') add(parameter.default);
        const values = (stored.values ?? {}) as Record<string, unknown>;
        for (const name of names) add(values[name]);
        for (const preset of Array.isArray(stored.graph.presets) ? stored.graph.presets as Array<{ values?: Record<string, unknown> } | null> : []) {
            for (const name of names) add(preset?.values?.[name]);
        }
        for (const node of Array.isArray(stored.graph.nodes) ? stored.graph.nodes as Array<{ params?: Record<string, unknown> } | null> : []) {
            const used = typeof node?.params?.graph === 'string' ? byId.get(node.params.graph) : undefined;
            if (used) for (const name of pictureParameterNames(used)) add(node?.params?.[name]);
        }
    }
    return [...ids];
};

/** The project's pictures materials draw with, as the library keeps them; a texture the project no longer has is left out. */
export const capturePictures = async (asset: MaterialAsset | readonly MaterialAsset[], project: ProjectPictures): Promise<LibraryPicture[]> => {
    const pictures: LibraryPicture[] = [];
    const named = materialPictureIds(Array.isArray(asset) ? asset as readonly MaterialAsset[] : [asset as MaterialAsset]);
    const unlisted: string[] = [];
    for (const textureId of named) {
        const texture = project.textures.find(candidate => candidate.id === textureId);
        if (!texture) { unlisted.push(textureId); continue; }
        // A deep picture keeps its own file, with its 8-bit preview beside it.
        const file = await project.read(texture.sourceUrl ?? texture.url);
        const preview = texture.sourceUrl ? await project.read(texture.url) : undefined;
        const settings = portableSettings(project.settingsOf(textureId) ?? texture.settings);
        pictures.push({ id: textureId, name: texture.name, file, dimensions: texture.dimensions, ...(settings ? { settings } : {}), ...(preview ? { preview } : {}) });
    }
    // The rest are read from the project (a texture graph's made pictures, say, which no open level needed).
    if (unlisted.length && project.unlisted) {
        const wanted = new Set(unlisted);
        for (const picture of await project.unlisted(unlisted)) if (wanted.has(picture.id)) pictures.push(picture);
    }
    return pictures;
};

/**
 * Every picture id in a material's authoring documents that `ids` renames, wherever it sits (a graph used as a node
 * given a picture for its parameter, a picture parameter's default): what withRenamedTextures does not reach.
 */
const withPictureIdsRenamed = (asset: MaterialAsset, ids: ReadonlyMap<string, string>): MaterialAsset => {
    const renamed = (value: unknown): unknown => {
        if (typeof value === 'string') return ids.get(value) ?? value;
        if (Array.isArray(value)) return value.map(renamed);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, renamed(child)]));
    };
    return {
        ...asset,
        ...(asset.textureGraph ? { textureGraph: renamed(asset.textureGraph) as Record<string, unknown> } : {}),
        ...(asset.paint ? { paint: renamed(asset.paint) as Record<string, unknown> } : {}),
    };
};

/** Renders a material's ball from the pictures it is kept with (materialBalls.ts in the editor). */
export type BallRenderer = (asset: MaterialAsset, pictures: readonly LibraryPicture[]) => Promise<Blob | null>;

/** Whether a material can go into the library: shared materials only (not painted copies or painting presets). */
export const canAddToLibrary = (asset: MaterialAsset, isPreset: (asset: MaterialAsset) => boolean): boolean => !asset.owner && !isPreset(asset);

/**
 * Adds a project material to the library, or updates the entry it was added as before (keeping that entry's
 * name, folder, tags and uses). Its ball is rendered from the pictures kept.
 */
export const addToLibrary = async (
    library: UserMaterialLibrary,
    asset: MaterialAsset,
    project: ProjectPictures & { projectId: string; materialOf?: (id: string) => MaterialAsset | undefined },
    renderBall: BallRenderer,
): Promise<{ entry: LibraryEntry; updated: boolean }> => {
    await library.load();
    // The graphs it uses as nodes come with it, with their pictures.
    const nodeGraphs = project.materialOf ? usedNodeGraphs(asset, project.materialOf) : [];
    const pictures = await capturePictures([asset, ...nodeGraphs], project);
    const thumbnail = await renderBall(asset, pictures).catch(() => null) ?? undefined;
    const before = library.addedFrom(project.projectId, asset.id);
    if (before) return { entry: await library.replaceMaterial(before.id, { asset, pictures, nodeGraphs, thumbnail }), updated: true };
    return { entry: await library.add({ asset, pictures, nodeGraphs, thumbnail, source: { projectId: project.projectId, materialId: asset.id } }), updated: false };
};

/** Where a library material's pictures go in the project, and how the material is kept there. */
export interface ProjectTarget {
    projectId: string;
    projectName: string;
    /** Names of the project's materials, so the new one takes a free name. */
    materialNames: readonly string[];
    /** Adds a picture as a project texture in `folder`; returns its id there. */
    addPicture(picture: LibraryPicture, folder: string): Promise<string>;
    /** Keeps the material in the project. */
    saveMaterial(asset: MaterialAsset): Promise<void>;
    newId(): string;
    /** Whether the project has a material by this id (a node graph brought back where it came from is used as it is). */
    hasMaterial?(id: string): boolean;
}

/** A material with what comes with it: the graphs it uses as nodes and the pictures they all draw with. */
export interface MaterialWithParts {
    name: string;
    material: MaterialAsset;
    nodeGraphs: readonly MaterialAsset[];
    pictures: readonly LibraryPicture[];
}

/**
 * Brings a material (from the library, or a material package) into the project as its own copy: its pictures as
 * the project's textures, the graphs it uses as nodes as the project's own, and a free name.
 */
export const bringMaterialIn = async (source: MaterialWithParts, project: ProjectTarget): Promise<MaterialAsset> => {
    const folder = `Materials/${source.name}`;
    const textureIds = new Map<string, string>();
    for (const picture of source.pictures) textureIds.set(picture.id, await project.addPicture(picture, folder));
    // The graphs it uses as nodes come first, each the project's own (unless the project has it already), and the
    // material, and they, name them by their ids here.
    const names = [...project.materialNames];
    const graphIds = new Map<string, string>();
    const broughtGraphs: MaterialAsset[] = [];
    for (const graph of source.nodeGraphs) {
        if (project.hasMaterial?.(graph.id)) continue;
        const id = project.newId();
        graphIds.set(graph.id, id);
        const name = uniqueName(graph.name, names);
        names.push(name);
        broughtGraphs.push({ ...withPictureIdsRenamed(withRenamedTextures(graph, (textureId) => textureIds.get(textureId) ?? ''), textureIds), id, name });
    }
    for (const graph of broughtGraphs) await project.saveMaterial(withRenamedNodeGraphs(graph, graphIds));
    const { owner: _owner, ...shared } = source.material;
    const made: MaterialAsset = { ...withPictureIdsRenamed(withRenamedTextures(shared, (textureId) => textureIds.get(textureId) ?? ''), textureIds), id: project.newId(), name: uniqueName(source.name, names) };
    const asset = withRenamedNodeGraphs(made, graphIds);
    await project.saveMaterial(asset);
    return asset;
};

/** Brings a library material into the project as its own copy, its pictures as the project's textures, and remembers the use. */
export const bringIntoProject = async (library: UserMaterialLibrary, entryId: string, project: ProjectTarget): Promise<MaterialAsset> => {
    const entry = library.get(entryId);
    if (!entry) throw new Error('That material is no longer in your library.');
    const material = libraryMaterial(entry);
    if (!material) throw new Error('This material could not be read.');
    const pictures = await library.pictures(entryId);
    const asset = await bringMaterialIn({ name: entry.name, material, nodeGraphs: libraryNodeGraphs(entry), pictures }, project);
    await library.recordUse(entryId, { projectId: project.projectId, projectName: project.projectName, materialId: asset.id });
    return asset;
};

/** Where an entry was used, in plain words for its page: each project, this one first. */
export const usesInWords = (entry: LibraryEntry, projectId: string | null, hasMaterial: (materialId: string) => boolean): string[] =>
    [...entry.uses].sort((a, b) => Number(b.projectId === projectId) - Number(a.projectId === projectId) || b.at - a.at).map((use) => {
        if (use.projectId !== projectId) return use.projectName || 'Another project';
        return hasMaterial(use.materialId) ? 'This project' : 'This project (since deleted there)';
    });
