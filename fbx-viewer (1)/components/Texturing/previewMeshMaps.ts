import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { materialLibrary } from '../../runtime/materials/materialLibrary';
import { projectService } from '../../utils/projectService';
import { DEFAULT_BAKE_SETTINGS, bakeMeshMaps, releaseTileBake } from '../../texturing/bake/meshBaker';
import type { GpuImage, TextureGpu } from '../../texturing/gpu/textureGpu';
import { graphReadsMeshMaps } from '../../texturing/graph/document';
import type { ExternalImage } from '../../texturing/graph/evaluator';
import { MESH_MAPS, meshMapKey, type MeshMapName } from '../../texturing/graph/nodes/io';
import type { GraphResolver } from '../../texturing/graph/registry';
import type { TextureGraph } from '../../texturing/graph/types';
import { buildPartMesh, buildWholeMesh } from '../../texturing/mesh/partMesh';
import { readPaintDocument, type TilePictures } from '../../texturing/paint/paintTypes';
import { pngBitDepth, readPicture, readPng16 } from '../../texturing/png';
import type { TextureGraphSession } from './textureGraphSession';

/**
 * MESH MAPS FOR THE MATERIALS TAB'S 3D VIEW
 *
 * Mesh map nodes (Mesh map, Triplanar, Direction mask, Position gradient, Normal with mesh detail,
 * 3D noise) read maps baked from a model. In the Materials tab the graph is shown on a shape or on a
 * project model, so it gets real maps for what the 3D view shows:
 *   - the built-in shapes have theirs worked out from the shape itself, by the same baker the Paint
 *     tab uses (once per shape, then kept). The rounded cube's faces and the cylinder's ends share one
 *     picture as they come, so while a graph reads mesh maps they are drawn with each face on a part
 *     of the picture of its own;
 *   - a project model uses the bake the Paint tab saved for it (in the paint document of the material
 *     painting it), read and never changed here;
 *   - otherwise stand-ins stay, and the view says how to get real maps.
 */

export type BaseShape = 'sphere' | 'roundedBox' | 'cylinder' | 'plane';
export type PreviewShape = BaseShape | `model:${string}`;

export const BASE_SHAPE_LABELS: Record<BaseShape, string> = { sphere: 'sphere', roundedBox: 'rounded cube', cylinder: 'cylinder', plane: 'flat square' };

/** Shapes whose faces share one picture as they come: given a layout of their own while mesh maps are read. */
const SHARED_FACES: ReadonlySet<BaseShape> = new Set(['roundedBox', 'cylinder']);

/** Room kept round each face's part of the picture, so filtering never pulls in its neighbour. */
const GAP = 0.012;

type Cell = [x: number, y: number, width: number, height: number];

/** Moves the texture coordinates of the corners `vertices` into `cell`. */
const intoCell = (uv: THREE.BufferAttribute, vertices: Iterable<number>, cell: Cell) => {
    const [x, y, width, height] = cell;
    for (const vertex of vertices) uv.setXY(vertex, x + GAP + uv.getX(vertex) * (width - GAP * 2), y + GAP + uv.getY(vertex) * (height - GAP * 2));
    uv.needsUpdate = true;
};

/**
 * A preview shape's geometry. `unique` gives every face its own part of the picture (the rounded cube's
 * six faces in square cells of a 3 × 3 grid, the cylinder's side above its two ends); `detail` is
 * 'view' for drawing (fine enough to push out by height) or 'bake' for working out its maps.
 */
export const previewGeometry = (shape: BaseShape, options: { unique: boolean; detail: 'view' | 'bake' }): THREE.BufferGeometry => {
    const fine = options.detail === 'view';
    switch (shape) {
        case 'roundedBox': {
            const geometry = new RoundedBoxGeometry(1.5, 1.5, 1.5, fine ? 24 : 6, 0.18);
            if (options.unique) {
                // Its corners come six faces in turn (right, left, top, bottom, front, back), as many each.
                const uv = geometry.attributes.uv as THREE.BufferAttribute;
                const perFace = uv.count / 6;
                const third = 1 / 3;
                const cells: Cell[] = [[0, 2 * third, third, third], [third, 2 * third, third, third], [2 * third, 2 * third, third, third], [0, third, third, third], [third, third, third, third], [2 * third, third, third, third]];
                cells.forEach((cell, face) => intoCell(uv, Array.from({ length: perFace }, (_, i) => face * perFace + i), cell));
            }
            return geometry;
        }
        case 'cylinder': {
            const geometry = new THREE.CylinderGeometry(0.8, 0.8, 1.8, fine ? 256 : 96, fine ? 96 : 1);
            if (options.unique) {
                // Groups: the side, then the top and the bottom end.
                const uv = geometry.attributes.uv as THREE.BufferAttribute;
                const index = geometry.index!;
                const third = 1 / 3;
                const cells: Cell[] = [[0, third, 1, 2 * third], [0, 0, third, third], [third, 0, third, third]];
                geometry.groups.forEach((group, at) => {
                    const vertices = new Set<number>();
                    for (let i = group.start; i < group.start + group.count; i++) vertices.add(index.getX(i));
                    if (cells[at]) intoCell(uv, vertices, cells[at]);
                });
            }
            return geometry;
        }
        case 'plane': {
            const geometry = fine ? new THREE.PlaneGeometry(2.2, 2.2, 384, 384) : new THREE.PlaneGeometry(2.2, 2.2, 1, 1);
            geometry.rotateX(-Math.PI / 2);
            return geometry;
        }
        default:
            return fine ? new THREE.SphereGeometry(1, 384, 192) : new THREE.SphereGeometry(1, 96, 48);
    }
};

/** True when a shape is drawn with a layout of its own while the graph reads mesh maps. */
export const sharesFaces = (shape: PreviewShape): boolean => SHARED_FACES.has(shape as BaseShape);

// ---------------------------------------------------------------------------
// Kept maps
// ---------------------------------------------------------------------------

type Maps = Partial<Record<MeshMapName, GpuImage>>;

interface Entry {
    refs: number;
    ready: Promise<Maps>;
    maps: Maps | null;
    /** Everything the entry holds on the GPU, given back when it goes. */
    release: () => void;
    controller: AbortController;
    settled: boolean;
}

/** Maps kept while nothing uses them, for going back to a shape or model just shown. */
const KEEP_IDLE = 2;
const entries = new Map<string, Entry>();
const idle: string[] = [];
const watched = new WeakSet<TextureGpu>();

const watch = (gpu: TextureGpu) => {
    if (watched.has(gpu)) return;
    watched.add(gpu);
    // A context that comes back has lost every picture made on it: forget them without giving them back.
    gpu.onRestored(() => {
        for (const entry of entries.values()) entry.controller.abort();
        entries.clear();
        idle.length = 0;
    });
};

const acquire = (key: string, gpu: TextureGpu, make: (signal: AbortSignal) => Promise<{ maps: Maps; release: () => void }>): Entry => {
    watch(gpu);
    let entry = entries.get(key);
    if (entry) {
        entry.refs++;
        const at = idle.indexOf(key);
        if (at >= 0) idle.splice(at, 1);
        return entry;
    }
    const controller = new AbortController();
    const made: Entry = { refs: 1, ready: Promise.resolve({}), maps: null, release: () => undefined, controller, settled: false };
    made.ready = make(controller.signal).then((result) => {
        made.settled = true;
        made.maps = result.maps;
        made.release = result.release;
        // Let go while it was being made: given back at once.
        if (entries.get(key) !== made) result.release();
        return result.maps;
    }, (error: unknown) => {
        made.settled = true;
        if (entries.get(key) === made) entries.delete(key);
        throw error;
    });
    entries.set(key, made);
    return made;
};

const releaseKey = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    if (!entry.settled) {
        // Nobody wants it any more: stop making it.
        entry.controller.abort();
        entries.delete(key);
        return;
    }
    idle.push(key);
    while (idle.length > KEEP_IDLE) {
        const oldest = idle.shift()!;
        const gone = entries.get(oldest);
        entries.delete(oldest);
        gone?.release();
    }
};

/** Maps worked out for a built-in shape (with or without a layout of its own), by the Paint tab's baker. */
const shapeMaps = (gpu: TextureGpu, shape: BaseShape, unique: boolean) => async (signal: AbortSignal) => {
    const geometry = previewGeometry(shape, { unique, detail: 'bake' });
    const material = new THREE.MeshBasicMaterial();
    try {
        const mesh = new THREE.Mesh(geometry, material);
        const part = buildPartMesh(mesh, null, { udim: false });
        // A shape on its own shades nothing of itself: few rays are needed for its occlusion.
        const bakes = await bakeMeshMaps(gpu, { part, occluder: buildWholeMesh(mesh) }, { ...DEFAULT_BAKE_SETTINGS, size: 10, samples: 32 }, undefined, signal);
        const tile = bakes.get(1001) ?? [...bakes.values()][0];
        for (const other of bakes.values()) if (other !== tile) releaseTileBake(gpu, other);
        if (!tile) throw new Error('The shape gave no maps.');
        // What the baker kept for padding painted pictures is not needed here.
        gpu.release(tile.coverage);
        gpu.release(tile.nearest);
        const maps = tile.maps;
        return { maps, release: () => { for (const image of Object.values(maps)) gpu.release(image); } };
    } finally {
        geometry.dispose();
        material.dispose();
    }
};

/** One baked picture of a texture set read whole (16-bit ones too) into an image of its own. */
const readMap = async (gpu: TextureGpu, name: MeshMapName, assetId: string, signal: AbortSignal): Promise<GpuImage> => {
    const response = await projectService.fetchAsset(assetId, { signal });
    if (!response.ok) throw new Error('A baked map could not be read.');
    const blob = await response.blob();
    const gray = name === 'ambientOcclusion' || name === 'curvature' || name === 'thickness' || name === 'height';
    const precision = gray || name === 'position' ? 16 : 8;
    // Kept bottom row first, as the Paint tab drew them: read as they are, not turned over.
    if (await pngBitDepth(blob) === 16) {
        const fine = await readPng16(blob);
        const texture = new THREE.DataTexture(fine.data, fine.width, fine.height, THREE.RGBAFormat, THREE.FloatType);
        texture.colorSpace = THREE.NoColorSpace;
        texture.minFilter = texture.magFilter = THREE.NearestFilter;
        texture.needsUpdate = true;
        const image = gpu.image(fine.width, fine.height, gray ? 'gray' : 'color', precision);
        gpu.passNow(image, { fragment: 'void main() { outColor = texture(source, vUv); }', inputs: { source: texture } });
        texture.dispose();
        return image;
    }
    const bitmap = await readPicture(blob);
    const texture = new THREE.Texture(bitmap);
    texture.flipY = false;
    texture.premultiplyAlpha = false;
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    const image = gpu.image(bitmap.width, bitmap.height, gray ? 'gray' : 'color', precision);
    gpu.passNow(image, { fragment: 'void main() { outColor = texture(source, vUv); }', inputs: { source: texture } });
    texture.dispose();
    bitmap.close();
    return image;
};

/** A texture set's baked maps for one tile, read from the project. */
const bakedMaps = (gpu: TextureGpu, maps: Partial<Record<MeshMapName, TilePictures>>, tile: number) => async (signal: AbortSignal) => {
    const read: Maps = {};
    const release = () => { for (const image of Object.values(read)) gpu.release(image); };
    try {
        for (const name of MESH_MAPS) {
            const assetId = maps[name]?.[String(tile)]?.assetId;
            if (!assetId) continue;
            if (signal.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
            read[name] = await readMap(gpu, name, assetId, signal);
        }
        return { maps: read, release };
    } catch (error) {
        release();
        throw error;
    }
};

// ---------------------------------------------------------------------------
// Baked surfaces of a model
// ---------------------------------------------------------------------------

/** A texture set of a model with mesh maps baked in the Paint tab. */
export interface BakedSurface {
    /** The material asset painting the set. */
    id: string;
    name: string;
    /** The model's materials the set paints. */
    materialNames: string[];
    /** UDIM tiles its maps cover, in order (1001 is the usual one). */
    tiles: number[];
    at: number;
    maps: Partial<Record<MeshMapName, TilePictures>>;
}

/** The texture sets of `modelId` that the Paint tab baked mesh maps for. */
export const bakedSurfaces = (modelId: string): BakedSurface[] => materialLibrary.list().flatMap((asset) => {
    const document = asset.paint ? readPaintDocument(asset.paint) : null;
    const bake = document?.modelId === modelId ? document.bake : null;
    if (!document || !bake?.maps || !Object.keys(bake.maps).length) return [];
    const tiles = [...new Set(Object.values(bake.maps).flatMap((pictures) => Object.keys(pictures ?? {}).map(Number)))].filter(Number.isFinite).sort((a, b) => a - b);
    if (!tiles.length) return [];
    const name = asset.name.replace(/\s*\(painted\)$/, '') || document.materialNames.join(', ');
    return [{ id: asset.id, name, materialNames: document.materialNames, tiles, at: Number(bake.at) || 0, maps: bake.maps }];
});

// ---------------------------------------------------------------------------
// The hook the workspace uses
// ---------------------------------------------------------------------------

export interface PreviewMeshMaps {
    /** Whether the graph reads mesh maps at all (when not, nothing here applies). */
    reads: boolean;
    /** What the 3D view says about the maps it uses, in plain words; null when there is nothing to say. */
    note: string | null;
    tone: 'info' | 'warning';
    /** Real maps are in use: the view shows the picture once, not repeated, since the maps follow the surface. */
    real: boolean;
    /** The shape is drawn with each face on a part of the picture of its own. */
    uniqueLayout: boolean;
    /** The model's baked surfaces to choose from (when there are several). */
    surfaces: BakedSurface[];
    /** The surface whose maps are used, if any: only its materials wear the graph in the view. */
    surface: BakedSurface | null;
}

/**
 * Gives the session mesh maps for what the 3D view shows, and says what they are. `surfaceId` picks
 * among a model's baked surfaces (the first when unset); `libraryVersion` changes when materials do (a
 * new bake saved in the Paint tab).
 */
export const usePreviewMeshMaps = (session: TextureGraphSession, graph: TextureGraph, resolve: GraphResolver, shape: PreviewShape, surfaceId: string | null, libraryVersion: number): PreviewMeshMaps => {
    const reads = useMemo(() => graphReadsMeshMaps(graph, resolve), [graph, resolve]);
    const modelId = shape.startsWith('model:') ? shape.slice('model:'.length) : null;
    // Read again when the project's materials change (a bake saved in the Paint tab).
    const surfaces = useMemo(() => (modelId && reads ? bakedSurfaces(modelId) : []), [modelId, reads, libraryVersion]);
    const surface = surfaces.find((candidate) => candidate.id === surfaceId) ?? surfaces[0] ?? null;
    const unique = !modelId && reads && sharesFaces(shape);
    const [state, setState] = useState<{ key: string; status: 'working' | 'ready' | 'failed' } | null>(null);
    const latest = useRef(session);
    latest.current = session;

    const tile = surface?.tiles[0] ?? 1001;
    const key = !reads ? null
        : modelId ? (surface ? `${session.gpu.generation}:bake:${surface.id}:${surface.at}:${tile}` : null)
            : `${session.gpu.generation}:shape:${shape}:${unique ? 'own' : 'as-is'}`;

    useEffect(() => {
        if (!key) {
            session.setExternal({}, '');
            setState(null);
            return undefined;
        }
        const gpu = session.gpu;
        const entry = acquire(key, gpu, modelId ? bakedMaps(gpu, surface!.maps, tile) : shapeMaps(gpu, shape as BaseShape, unique));
        let current = true;
        setState({ key, status: entry.maps ? 'ready' : 'working' });
        const give = (maps: Maps) => {
            const external: Record<string, ExternalImage | null> = {};
            for (const name of MESH_MAPS) external[meshMapKey(name)] = maps[name] ?? null;
            latest.current.setExternal(external, key);
        };
        if (entry.maps) give(entry.maps);
        else {
            // Stand-ins until the maps are ready.
            session.setExternal({}, '');
            entry.ready.then((maps) => {
                if (!current) return;
                give(maps);
                setState({ key, status: 'ready' });
            }, (error: unknown) => {
                if (!current || (error as Error)?.name === 'AbortError') return;
                frontendDiagnostics.failure(modelId ? 'texture_graph_baked_maps_failed' : 'texture_graph_shape_maps_failed', error);
                setState({ key, status: 'failed' });
            });
        }
        return () => {
            current = false;
            releaseKey(key);
        };
    // The key names everything the maps come from.
    }, [key, session]);

    const status = state?.key === key ? state.status : 'working';
    let note: string | null = null;
    let tone: PreviewMeshMaps['tone'] = 'info';
    if (reads) {
        if (modelId && !surface) {
            note = 'This model has no mesh maps baked yet, so the graph shows stand-ins for them. To see its real maps here, open the model in the Paint tab and press Bake mesh maps.';
            tone = 'warning';
        } else if (status === 'failed') {
            note = modelId ? 'The mesh maps baked for this model could not be read, so stand-ins show. Baking them again in the Paint tab should bring them back.' : 'The shape\'s mesh maps could not be worked out, so stand-ins show.';
            tone = 'warning';
        } else if (status === 'working') {
            note = modelId ? 'Reading the mesh maps baked for this model…' : `Working out the ${BASE_SHAPE_LABELS[shape as BaseShape]}'s mesh maps…`;
        } else if (modelId && surface) {
            note = `Mesh maps: the bake saved for "${surface.name}" in the Paint tab.${surface.tiles.length > 1 ? ` It covers ${surface.tiles.length} UDIM tiles; this view uses the first.` : ''}`;
        } else {
            note = `Mesh maps: worked out for the ${BASE_SHAPE_LABELS[shape as BaseShape]}${unique ? ', with each face on a part of the picture of its own' : ''}.`;
        }
    }
    return {
        reads,
        note,
        tone,
        real: reads && status === 'ready' && Boolean(key),
        uniqueLayout: unique,
        surfaces,
        surface,
    };
};
