import * as THREE from 'three';
import { renderMaterialBall, BALL_SIZE, type BallPictureSource } from '../../../components/Materials/materialBalls';
import { listModelParts } from '../../../components/Tools/Retexture/parts';
import { createGraphCooker } from '../../../runtime/materials/graphCooker';
import { ownMaps } from '../../../runtime/materials/graphMaterial';
import { cookable, type CookedPictures } from '../../../runtime/materials/materialCooking';
import { createMaterialGraph } from '../../../runtime/materials/materialGraph';
import { materialAssetDocument, readMaterialAsset, type MaterialAsset } from '../../../runtime/materials/materialLibrary';
import { DEFAULT_BAKE_SETTINGS, EXTRA_MAP_LABELS, bakeMeshMaps, releaseTileBake, spaceOfBox, BAKE_VERSION, type BakeSettings, type ExtraBakeMap } from '../../../texturing/bake/meshBaker';
import { textureGpu } from '../../../texturing/gpu/textureGpu';
import { flipbookGrid, readAnimation } from '../../../texturing/graph/animation';
import { MESH_MAP_LABELS, MESH_MAPS, type MeshMapName } from '../../../texturing/graph/nodes/io';
import { graphAnimates, type GraphResolver } from '../../../texturing/graph/registry';
import { bakeSignature, readStoredGraph } from '../../../texturing/graph/stored';
import { ROLE_LABELS, rewriteMaterialPictures, type ChannelPicture, type ChannelTextureIds } from '../../../texturing/materialOutput';
import { buildPartMesh, buildWholeMesh } from '../../../texturing/mesh/partMesh';
import { encodeBakedMap, FINE_MAPS } from '../../../texturing/paint/paintStack';
import { castsFromThreeSides, paintedSetName, readPaintDocument, startingPaintDocument, surfaceGlows, type PaintDocument, type TilePictures } from '../../../texturing/paint/paintTypes';
import type { TextureSettings } from '../../../texturing/textureSettings';
import { applyLayout, decodeLayout } from '../../../texturing/uv/uvLayout';
import { loadModelFile } from '../../../utils/modelLoader';
import { applyModelImportSettings, convertOptionsFor } from '../../../utils/processing/ModelTransforms';
import type { ModelImportSettings } from '../../../types';

/**
 * MATERIAL WORK WITHOUT THE EDITOR
 *
 * The page behind the material command line's cook, ball and bake-mesh-maps (scripts/materials/headless.mjs drives it
 * in a headless browser for Auvra/project/material_commands.py). The editor's own evaluator, ball renderer and baker
 * run here on the browser's GPU, on the project's documents as the command line hands them over; the project's files
 * are read from /project/<asset id>. Each picture is sent to /out/<file name> to be written where the command asked,
 * and the result says what each is and, to keep them in the project, the documents that name them (by the SHA-256 of
 * the picture, the id the project keeps it under). Nothing here writes the project: the command line does, after.
 */

interface TextureRecord { id: string; name?: string; assetId?: string; settings?: TextureSettings; folder?: string }
interface ModelRecord {
    id: string;
    name: string;
    assetId: string;
    category?: string;
    importSettings?: Partial<ModelImportSettings> | null;
    uvLayout?: { assetId?: string } | null;
    sourceImages?: Array<{ assetId: string; name: string }>;
}

export interface MaterialJob {
    command: 'cook' | 'ball' | 'bake-mesh-maps';
    /** The material's (or, for a bake, the model's) id. */
    target: string;
    /** cook and bake: the pictures' size as a power of two; ball: pixels across. */
    size?: number;
    /** bake: rays per texel for occlusion and thickness. */
    samples?: number;
    /** Make the documents that keep the pictures in the project. */
    intoProject?: boolean;
    project: { materials: unknown[]; textures: TextureRecord[]; models: ModelRecord[] };
}

export interface MadeFile {
    /** Its file name in the folder it was written to. */
    name: string;
    /** What it is, in plain words. */
    what: string;
    width: number;
    height: number;
    /** The SHA-256 of its bytes: the id the project keeps it under. */
    assetId: string;
}

export interface MaterialJobResult {
    files: MadeFile[];
    /** Documents to put in the project (whole, by id), and textures the replaced pictures were, to let go once nothing names them. */
    changes: { materials: unknown[]; textures: unknown[]; replacedTextures: string[] };
    notes: string[];
}

const assetUrl = (assetId: string): string => `/project/${encodeURIComponent(assetId)}`;

/** A name safe as a file name on every system. */
const slug = (name: string): string => name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'material';

const sha256 = async (bytes: ArrayBuffer): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** A PNG's size, from its header. */
const pngSize = (bytes: ArrayBuffer): { width: number; height: number } => {
    const view = new DataView(bytes);
    return { width: view.getUint32(16), height: view.getUint32(20) };
};

/** Sends a picture to be written and says what it is. */
const write = async (blob: Blob, name: string, what: string): Promise<MadeFile> => {
    const bytes = await blob.arrayBuffer();
    const response = await fetch(`/out/${encodeURIComponent(name)}`, { method: 'PUT', body: bytes });
    if (!response.ok) throw new Error(`${name} could not be written (${response.status}).`);
    return { name, what, ...pngSize(bytes), assetId: await sha256(bytes) };
};

class Project {
    readonly assets = new Map<string, MaterialAsset>();
    private readonly textures = new Map<string, TextureRecord>();

    constructor(readonly data: MaterialJob['project']) {
        for (const document of data.materials) {
            const asset = readMaterialAsset(document);
            if (asset) this.assets.set(asset.id, asset);
        }
        for (const texture of data.textures) this.textures.set(texture.id, texture);
    }

    material(id: string): MaterialAsset {
        const asset = this.assets.get(id);
        if (!asset) throw new Error(`There is no material ${id} in this project.`);
        return asset;
    }

    textureUrl = (textureId: string): string | undefined => {
        const assetId = this.textures.get(textureId)?.assetId;
        return assetId ? assetUrl(assetId) : undefined;
    };

    textureSettings(textureId: string): TextureSettings | undefined {
        return this.textures.get(textureId)?.settings;
    }

    resolve: GraphResolver = (id) => {
        const asset = this.assets.get(id);
        return asset?.textureGraph ? { id, name: asset.name, graph: readStoredGraph(asset.textureGraph).graph } : undefined;
    };
}

/** A texture document for a picture the project keeps, as the editor's texture store writes one. */
const textureDocument = (file: MadeFile, name: string, folder: string) => {
    const id = crypto.randomUUID();
    return { id, name: name.slice(0, 256), assetId: file.assetId, dimensions: { width: file.width, height: file.height }, folder };
};

/** A texture graph's pictures drawn as Update material draws them, at `size` (a power of two; the material's own when absent). */
const cookPictures = async (project: Project, asset: MaterialAsset, size?: number): Promise<CookedPictures> => {
    if (!cookable(asset)) throw new Error(`"${asset.name}" is not made by a texture graph, so it has no pictures to cook.`);
    const sized: MaterialAsset = size === undefined ? asset : { ...asset, textureGraph: { ...asset.textureGraph, bakeSize: size } };
    const cooker = createGraphCooker({ material: (id) => project.assets.get(id), textureUrl: project.textureUrl });
    return cooker.cook({ asset: sized, values: readStoredGraph(asset.textureGraph).values });
};

const cook = async (job: MaterialJob): Promise<MaterialJobResult> => {
    const project = new Project(job.project);
    const asset = project.material(job.target);
    const stored = readStoredGraph(asset.textureGraph);
    const size = job.size ?? stored.bakeSize;
    const pictures = await cookPictures(project, asset, size);
    const files: MadeFile[] = [];
    const ids: ChannelTextureIds = {};
    const textures: unknown[] = [];
    for (const [role, blob] of Object.entries(pictures) as Array<[ChannelPicture['role'], Blob]>) {
        const file = await write(blob, `${slug(asset.name)}_${role}.png`, ROLE_LABELS[role]);
        files.push(file);
        if (!job.intoProject) continue;
        const texture = textureDocument(file, `${asset.name} ${ROLE_LABELS[role]}`, `Texture graphs/${asset.name}`);
        textures.push(texture);
        ids[role] = texture.id;
    }
    const notes = [`${files.length} picture${files.length === 1 ? '' : 's'} at ${2 ** size} × ${2 ** size}.`];
    if (!job.intoProject) return { files, changes: { materials: [], textures: [], replacedTextures: [] }, notes };
    // As Update material keeps them: only the material's pictures change, so a surface edited by hand keeps its edits.
    const animation = readAnimation(stored.graph.animation);
    const flipbook = animation.play === 'flipbook' && graphAnimates(stored.graph, project.resolve) ? { frames: animation.frames, ...flipbookGrid(animation.frames), loop: animation.loop } : null;
    const next: MaterialAsset = {
        ...asset,
        ...rewriteMaterialPictures(asset, ids, { opacityMode: pictures.opacity ? 'masked' : undefined, flipbook }),
        textureGraph: { ...asset.textureGraph, baked: { textures: ids, signature: bakeSignature(stored, project.resolve), size, at: Date.now() } },
    };
    const replaced = Object.values(stored.baked?.textures ?? {}).filter((id): id is string => typeof id === 'string' && id.length > 0);
    notes.push(`"${asset.name}" now draws with them in the project.`);
    return { files, changes: { materials: [materialAssetDocument(next)], textures, replacedTextures: replaced }, notes };
};

const ball = async (job: MaterialJob): Promise<MaterialJobResult> => {
    const project = new Project(job.project);
    const asset = project.material(job.target);
    const notes: string[] = [];
    let drawn = asset;
    const cooked = new Map<string, string>();
    if (cookable(asset)) {
        // A texture graph whose pictures were never made, or were made before it changed, is drawn with them made now.
        const stored = readStoredGraph(asset.textureGraph);
        const current = stored.baked?.signature === bakeSignature(stored, project.resolve) && Object.keys(asset.pictures ?? {}).length > 0;
        if (!current) {
            const pictures = await cookPictures(project, asset);
            const roles: Record<string, string> = {};
            for (const [role, blob] of Object.entries(pictures)) {
                const id = `cooked:${role}`;
                cooked.set(id, URL.createObjectURL(blob as Blob));
                roles[role] = id;
            }
            drawn = { ...asset, pictures: roles };
            notes.push('Its texture graph\'s pictures were not up to date, so the ball shows them made from the graph as it is now.');
        }
    }
    const source: BallPictureSource = (textureId) => {
        const url = cooked.get(textureId) ?? project.textureUrl(textureId);
        return url ? { url, settings: project.textureSettings(textureId) } : null;
    };
    const size = job.size ?? BALL_SIZE;
    try {
        const blob = await renderMaterialBall(drawn, source, size);
        if (!blob) throw new Error('The ball could not be drawn: the browser has no graphics to draw it with.');
        const file = await write(blob, `${slug(asset.name)}_ball.png`, 'Ball');
        if (!job.intoProject) return { files: [file], changes: { materials: [], textures: [], replacedTextures: [] }, notes };
        const name = `${asset.name} ball`;
        const replaced = job.project.textures.filter((texture) => texture.folder === 'Material balls' && texture.name === name.slice(0, 256)).map((texture) => texture.id);
        notes.push(`Kept in the project's textures, in Material balls, as "${name}".`);
        return { files: [file], changes: { materials: [], textures: [textureDocument(file, name, 'Material balls')], replacedTextures: replaced }, notes };
    } finally {
        for (const url of cooked.values()) URL.revokeObjectURL(url);
    }
};

const fetchFile = async (assetId: string, name: string): Promise<File> => {
    const response = await fetch(assetUrl(assetId));
    if (!response.ok) throw new Error(`The project's file for ${name} could not be read.`);
    return new File([await response.arrayBuffer()], name);
};

const bake = async (job: MaterialJob): Promise<MaterialJobResult> => {
    const project = new Project(job.project);
    const model = job.project.models.find((candidate) => candidate.id === job.target);
    if (!model) throw new Error(`There is no model ${job.target} in this project.`);
    // Loaded as the editor loads the project's models, so its surfaces and its space are the ones Paint bakes.
    const images = await Promise.all((model.sourceImages ?? []).map((image) => fetchFile(image.assetId, image.name).catch(() => null)));
    const loaded = await loadModelFile(await fetchFile(model.assetId, model.name), {
        normalize: model.category !== 'Animation',
        convert: convertOptionsFor(model.importSettings ?? undefined),
        manualId: model.id,
        compressTextures: false,
        images: images.filter((image): image is File => image !== null),
    });
    loaded.category = (model.category as typeof loaded.category | undefined) ?? 'Prop';
    if (model.uvLayout?.assetId) applyLayout(loaded.object, decodeLayout(await (await fetchFile(model.uvLayout.assetId, 'layout')).arrayBuffer()));
    applyModelImportSettings(loaded, model.importSettings);
    loaded.object.updateMatrixWorld(true);

    const gpu = textureGpu();
    const occluder = buildWholeMesh(loaded.object);
    const modelSpace = spaceOfBox(new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(occluder.positions, 3)));
    const files: MadeFile[] = [];
    const materials: unknown[] = [];
    const notes: string[] = [];
    const parts = listModelParts(loaded.object);
    if (!parts.length) throw new Error(`"${model.name}" has no surfaces to bake.`);
    for (const part of parts) {
        const names = part.materialNames.length ? part.materialNames : [part.rawName || part.name];
        const owner = [...project.assets.values()].find((asset) => {
            const document = asset.paint ? readPaintDocument(asset.paint) : null;
            return document?.modelId === model.id && document.materialNames.some((name) => names.includes(name));
        });
        const kept = owner?.paint ? readPaintDocument(owner.paint) : null;
        const partMesh = buildPartMesh(loaded.object, new Set(part.materials), { udim: kept ? kept.udim : 'auto' });
        // Into the project, a set that exists keeps its size (its painting is at that size), and a new one is a size a set can be.
        const wanted = job.size ?? kept?.size ?? 11;
        const size = !job.intoProject ? wanted : kept ? kept.size : Math.min(12, Math.max(8, wanted));
        if (size !== wanted) notes.push(kept ? `${part.name} was baked at its set's own size, ${2 ** size} × ${2 ** size}.` : `${part.name} was baked at ${2 ** size} × ${2 ** size}: a painted set is 256 to 4096 pixels across.`);
        const document: PaintDocument = kept ?? startingPaintDocument(model.id, names, { size, udim: partMesh.udim, space: modelSpace, glows: surfaceGlows(part.materials[0]) });
        // A set made before spaces were kept moves into the model's own, unless a fill cast from three sides would shift with it.
        const adopt = !document.space && !castsFromThreeSides(document.layers);
        const space = adopt ? modelSpace : document.space ?? spaceOfBox(partMesh.bounds);
        const settings: BakeSettings = { ...DEFAULT_BAKE_SETTINGS, ...(document.bake?.settings ?? {}), size, ...(job.samples !== undefined ? { samples: job.samples } : {}) };
        const material = part.materials[0] as THREE.MeshStandardMaterial | undefined;
        const result = await bakeMeshMaps(gpu, { part: partMesh, space, occluder, normalMap: material ? ownMaps(material).normalMap : null }, settings, undefined, undefined, size);
        const maps: Partial<Record<MeshMapName, TilePictures>> = {};
        const extras: NonNullable<NonNullable<PaintDocument['bake']>['extras']> = {};
        try {
            const many = result.size > 1;
            for (const [tile, bake] of result) {
                const name = (map: string) => `${slug(model.name)}_${slug(part.name)}_${map}${many ? `_${tile}` : ''}.png`;
                for (const map of MESH_MAPS) {
                    const image = bake.maps[map];
                    if (!image) continue;
                    const file = await write(await encodeBakedMap(gpu, image, FINE_MAPS.has(map), 2 ** size, 2 ** size), name(map), `${part.name}: ${MESH_MAP_LABELS[map]}`);
                    files.push(file);
                    maps[map] = { ...(maps[map] ?? {}), [String(tile)]: { assetId: file.assetId } };
                }
                for (const [map, image] of Object.entries(bake.extras ?? {})) {
                    if (!image) continue;
                    const file = await write(await encodeBakedMap(gpu, image, image.precision !== 8), name(map), `${part.name}: ${EXTRA_MAP_LABELS[map as ExtraBakeMap] ?? map}`);
                    files.push(file);
                    extras[map as keyof typeof extras] = { ...(extras[map as keyof typeof extras] ?? {}), [String(tile)]: { assetId: file.assetId } };
                }
            }
        } finally {
            for (const bake of result.values()) releaseTileBake(gpu, bake);
        }
        if (!job.intoProject) continue;
        const baked: PaintDocument = { ...document, ...(adopt ? { space } : {}), bake: { settings, maps, ...(Object.keys(extras).length ? { extras } : {}), at: Date.now(), version: BAKE_VERSION, space } };
        const asset: MaterialAsset = owner
            ? { ...owner, paint: baked as unknown as Record<string, unknown> }
            : { id: crypto.randomUUID(), name: paintedSetName(model.name, part.name), graph: createMaterialGraph(), paint: baked as unknown as Record<string, unknown> };
        materials.push(materialAssetDocument(asset));
        notes.push(owner ? `${part.name}: the bake of "${owner.name}" was replaced.` : `${part.name}: kept in a new painted set, "${asset.name}", for the Paint tab.`);
    }
    return { files, changes: { materials, textures: [], replacedTextures: [] }, notes };
};

const run = async (job: MaterialJob): Promise<MaterialJobResult> => {
    if (job.command === 'cook') return cook(job);
    if (job.command === 'ball') return ball(job);
    if (job.command === 'bake-mesh-maps') return bake(job);
    throw new Error(`No command called ${String(job.command)}.`);
};

(window as unknown as { auvraMaterials: unknown }).auvraMaterials = { run };
