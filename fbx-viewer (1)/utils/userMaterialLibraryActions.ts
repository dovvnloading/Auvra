import { materialAssetDocument, type MaterialAsset } from '../runtime/materials/materialLibrary';
import type { TextureSettings } from '../texturing/textureSettings';
import type { TextureData } from '../types';
import { materialFromLibrary, portableSettings, type LibraryEntry, type LibraryPicture, type UserMaterialLibrary } from './userMaterialLibrary';

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

/** The project's pictures a material draws with, as the library keeps them; a texture the project no longer has is left out. */
export const capturePictures = async (asset: MaterialAsset, project: ProjectPictures): Promise<LibraryPicture[]> => {
    const pictures: LibraryPicture[] = [];
    for (const textureId of materialAssetDocument(asset).textureIds) {
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
    project: ProjectPictures & { projectId: string },
    renderBall: BallRenderer,
): Promise<{ entry: LibraryEntry; updated: boolean }> => {
    await library.load();
    const pictures = await capturePictures(asset, project);
    const thumbnail = await renderBall(asset, pictures).catch(() => null) ?? undefined;
    const before = library.addedFrom(project.projectId, asset.id);
    if (before) return { entry: await library.replaceMaterial(before.id, { asset, pictures, thumbnail }), updated: true };
    return { entry: await library.add({ asset, pictures, thumbnail, source: { projectId: project.projectId, materialId: asset.id } }), updated: false };
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
}

/** Brings a library material into the project as its own copy, its pictures as the project's textures, and remembers the use. */
export const bringIntoProject = async (library: UserMaterialLibrary, entryId: string, project: ProjectTarget): Promise<MaterialAsset> => {
    const entry = library.get(entryId);
    if (!entry) throw new Error('That material is no longer in your library.');
    const pictures = await library.pictures(entryId);
    const folder = `Materials/${entry.name}`;
    const textureIds = new Map<string, string>();
    for (const picture of pictures) textureIds.set(picture.id, await project.addPicture(picture, folder));
    const asset = materialFromLibrary(entry, textureIds, project.newId(), project.materialNames);
    if (!asset) throw new Error('This material could not be read.');
    await project.saveMaterial(asset);
    await library.recordUse(entryId, { projectId: project.projectId, projectName: project.projectName, materialId: asset.id });
    return asset;
};

/** Where an entry was used, in plain words for its page: each project, this one first. */
export const usesInWords = (entry: LibraryEntry, projectId: string | null, hasMaterial: (materialId: string) => boolean): string[] =>
    [...entry.uses].sort((a, b) => Number(b.projectId === projectId) - Number(a.projectId === projectId) || b.at - a.at).map((use) => {
        if (use.projectId !== projectId) return use.projectName || 'Another project';
        return hasMaterial(use.materialId) ? 'This project' : 'This project (since deleted there)';
    });
