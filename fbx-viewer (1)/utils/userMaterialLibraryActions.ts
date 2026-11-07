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
    textures: readonly TextureData[];
    settingsOf(textureId: string): TextureSettings | undefined;
    read(url: string): Promise<Blob>;
}

/** The project's pictures materials draw with, as the library keeps them; a texture the project no longer has is left out. */
export const capturePictures = async (asset: MaterialAsset | readonly MaterialAsset[], project: ProjectPictures): Promise<LibraryPicture[]> => {
    const pictures: LibraryPicture[] = [];
    const named = new Set((Array.isArray(asset) ? asset : [asset]).flatMap((each: MaterialAsset) => materialAssetDocument(each).textureIds));
    for (const textureId of named) {
        const texture = project.textures.find(candidate => candidate.id === textureId);
        if (!texture) continue;
        // A deep picture keeps its own file, with its 8-bit preview beside it.
        const file = await project.read(texture.sourceUrl ?? texture.url);
        const preview = texture.sourceUrl ? await project.read(texture.url) : undefined;
        const settings = portableSettings(project.settingsOf(textureId) ?? texture.settings);
        pictures.push({ id: textureId, name: texture.name, file, dimensions: texture.dimensions, ...(settings ? { settings } : {}), ...(preview ? { preview } : {}) });
    }
    return pictures;
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
        broughtGraphs.push({ ...withRenamedTextures(graph, (textureId) => textureIds.get(textureId) ?? ''), id, name });
    }
    for (const graph of broughtGraphs) await project.saveMaterial(withRenamedNodeGraphs(graph, graphIds));
    const { owner: _owner, ...shared } = source.material;
    const made: MaterialAsset = { ...withRenamedTextures(shared, (textureId) => textureIds.get(textureId) ?? ''), id: project.newId(), name: uniqueName(source.name, names) };
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
