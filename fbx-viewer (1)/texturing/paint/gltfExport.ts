import { getMaterialNodeDefinition, materialGraphFeatures, normalizeMaterialGraph, OUTPUT_NODE_TYPE, readParam, type MaterialGraph } from '../../runtime/materials/materialGraph';
import { readUdimTiles, UDIM_ATLAS_NODE_TYPE } from '../../runtime/materials/materialNodes';
import type { TileLayout } from '../materialOutput';
import * as THREE from 'three';
import { readGlb, readGlbBinary, writeGlb } from '../../utils/gltfContainer';
import type { ExportSource } from './exportTemplates';

/**
 * GLTF EXPORT OF A PAINTED SET
 *
 * The painted surface written as a binary glTF: its mesh (model space), one material with the painted
 * maps (base colour with opacity, occlusion-roughness-metallic packed as glTF reads them, normal,
 * emission) and the factors and KHR material extensions its material document uses (coat, sheen,
 * transmission and volume, specular and index of refraction, thin film, anisotropy, emission strength,
 * unlit). The document is only read here.
 */

type Rgb = [number, number, number];

export interface GltfSurface {
    name: string;
    baseColor: Rgb;
    opacity: number;
    metalness: number;
    roughness: number;
    emissive: Rgb;
    alphaMode: 'OPAQUE' | 'MASK' | 'BLEND';
    alphaCutoff: number;
    doubleSided: boolean;
    /** glTF material extensions, by name, with their properties. */
    extensions: Record<string, Record<string, unknown>>;
}

/** What a material document's Material Output gives an input: its constant value, or null when it varies (wired from something not constant). */
const outputReader = (graph: MaterialGraph) => {
    const output = graph.nodes.find((node) => node.type === OUTPUT_NODE_TYPE);
    const definition = getMaterialNodeDefinition(OUTPUT_NODE_TYPE)!;
    const own = (key: string): unknown => {
        const param = definition.params.find((candidate) => candidate.key === key);
        return param ? readParam(param, output?.params[key]) : undefined;
    };
    const value = (key: string): unknown => {
        const link = output ? graph.links.find((candidate) => candidate.toNode === output.id && candidate.toInput === key) : undefined;
        if (!link) return own(key);
        const from = graph.nodes.find((node) => node.id === link.fromNode);
        const fromDefinition = from ? getMaterialNodeDefinition(from.type) : undefined;
        // A Number or Color node (or a vector) wired in is as good as a value set on the output.
        if (from && fromDefinition && fromDefinition.inputs.length === 0 && ['float', 'color', 'vector'].includes(from.type)) {
            const param = fromDefinition.params.find((candidate) => candidate.key === 'value');
            if (param) return readParam(param, from.params.value);
        }
        return null;
    };
    return { own, value };
};

const finite = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const colour = (value: unknown, fallback: Rgb): Rgb => (Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every((each) => typeof each === 'number' && Number.isFinite(each)) ? [value[0], value[1], value[2]] : fallback);
const unit = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * The glTF material of a material document whose `painted` channels come from the painted maps: those
 * take factors of one, the rest the document's values. A physical part wired from something that varies
 * is written at the value set on the output if any, else at full strength.
 */
export const surfaceOfGraph = (value: unknown, name: string, painted: ReadonlySet<ExportSource>): GltfSurface => {
    const graph = normalizeMaterialGraph(value);
    const { own, value: read } = outputReader(graph);
    const number = (key: string, varying: number) => { const got = read(key); return got === null ? finite(own(key), varying) : finite(got, varying); };
    const vector = (key: string, varying: Rgb) => { const got = read(key); return got === null ? varying : colour(got, varying); };
    const blend = own('blendMode');
    const extensions: GltfSurface['extensions'] = {};
    const features = new Set(materialGraphFeatures(graph));
    if (features.has('coat')) {
        extensions.KHR_materials_clearcoat = { clearcoatFactor: unit(number('coat', 1)), clearcoatRoughnessFactor: unit(number('coatRoughness', 0.03)) };
    }
    if (features.has('sheen')) {
        extensions.KHR_materials_sheen = { sheenColorFactor: vector('sheenColor', [1, 1, 1]).map(unit), sheenRoughnessFactor: unit(number('sheenRoughness', 0.5)) };
    }
    if (features.has('transmission')) {
        extensions.KHR_materials_transmission = { transmissionFactor: unit(number('transmission', 1)) };
        const thickness = Math.max(0, number('thickness', 0));
        if (thickness > 0) {
            extensions.KHR_materials_volume = { thicknessFactor: thickness, attenuationColor: vector('attenuationColor', [1, 1, 1]).map(unit), attenuationDistance: Math.max(0.001, number('attenuationDistance', 1)) };
        }
    }
    if (features.has('specular')) {
        extensions.KHR_materials_specular = { specularFactor: unit(number('specularWeight', 1)), specularColorFactor: vector('specularColor', [1, 1, 1]).map((each) => Math.max(0, each)) };
        const ior = number('ior', 1.5);
        if (Math.abs(ior - 1.5) > 1e-4) extensions.KHR_materials_ior = { ior: Math.max(1, ior) };
    }
    if (features.has('thinFilm')) {
        // Without a thickness picture glTF takes the largest thickness.
        extensions.KHR_materials_iridescence = { iridescenceFactor: unit(number('thinFilm', 1)), iridescenceThicknessMaximum: Math.max(0, number('thinFilmThickness', 400)) };
    }
    if (features.has('anisotropy')) {
        extensions.KHR_materials_anisotropy = { anisotropyStrength: unit(number('anisotropy', 1)), anisotropyRotation: (number('anisotropyRotation', 0) * Math.PI) / 180 };
    }
    const strength = number('emissiveStrength', 1);
    if (strength > 1) extensions.KHR_materials_emissive_strength = { emissiveStrength: strength };
    if (own('shading') === 'unlit') extensions.KHR_materials_unlit = {};
    return {
        name,
        baseColor: painted.has('baseColor') ? [1, 1, 1] : vector('baseColor', [1, 1, 1]).map(unit) as Rgb,
        opacity: painted.has('opacity') ? 1 : unit(number('opacity', 1)),
        metalness: painted.has('metallic') ? 1 : unit(number('metalness', 0)),
        roughness: painted.has('roughness') ? 1 : unit(number('roughness', 0.6)),
        emissive: painted.has('emissive') ? [1, 1, 1] : vector('emissive', [0, 0, 0]).map(unit) as Rgb,
        alphaMode: blend === 'masked' || (painted.has('opacity') && blend === 'opaque') ? 'MASK' : blend === 'translucent' || blend === 'additive' ? 'BLEND' : 'OPAQUE',
        alphaCutoff: unit(finite(own('alphaClip'), 0.5)),
        doubleSided: own('twoSided') === true,
        extensions,
    };
};

/** A mesh as glTF takes it: corners with a position, normal, UV and maybe a tangent, and triangles. */
export interface GltfMesh {
    positions: Float32Array;
    normals: Float32Array | null;
    uvs: Float32Array;
    tangents: Float32Array | null;
    indices: Uint32Array;
}

/** Layout of the uploaded pictures. Older painted sets recorded it on the generated material node. */
export const appliedAtlasLayout = (saved: TileLayout | null | undefined, graph: MaterialGraph): TileLayout | null => {
    if (saved === null) return null; // Applied as a single tile, even if the shader still has an older atlas node.
    const node = graph.nodes.find(node => node.type === UDIM_ATLAS_NODE_TYPE && node.id === 'udimTiles');
    if (!saved && !node) return null;
    const tiles = saved ? saved.tiles : readUdimTiles(node!.params.tiles);
    const columns = saved ? saved.columns : Number(node!.params.columns);
    const cell = saved ? saved.cell : Number(node!.params.tileSize);
    const gutter = saved ? saved.gutter : Number(node!.params.gutter);
    if (!Array.isArray(tiles) || !tiles.length || tiles.some(tile => !Number.isSafeInteger(tile) || tile < 1001)
        || new Set(tiles).size !== tiles.length || !Number.isSafeInteger(columns) || columns < 1
        || !Number.isSafeInteger(cell) || cell < 1 || !Number.isSafeInteger(gutter) || gutter < 0) {
        throw new Error('The saved UDIM atlas layout is invalid. Apply the painted set again before exporting.');
    }
    const rows = Math.ceil(tiles.length / columns), stride = cell + 2 * gutter;
    return { tiles, columns, rows, cell, gutter, width: columns * stride, height: rows * stride };
};

/** The pixel origin of a triangle's tile. Reject UVs that a single atlas cell cannot represent. */
const atlasCell = (layout: TileLayout, tileU: number, tileV: number): { index: number; left: number; bottom: number } => {
    if (!Number.isSafeInteger(tileU) || !Number.isSafeInteger(tileV) || tileU < 0 || tileU > 9 || tileV < 0) {
        throw new Error('A painted triangle is outside the supported UDIM grid.');
    }
    const tile = 1001 + tileU + 10 * tileV;
    const index = layout.tiles.indexOf(tile);
    if (index < 0) throw new Error(`The painted model uses UDIM tile ${tile}, but that tile is not in this painted set.`);
    const stride = layout.cell + 2 * layout.gutter;
    return { index, left: (index % layout.columns) * stride + layout.gutter, bottom: Math.floor(index / layout.columns) * stride + layout.gutter };
};

const atlasLocal = (coordinate: number, shift: number, tile: number): number => {
    const local = coordinate - shift;
    const epsilon = 1e-5;
    if (!Number.isFinite(local) || local < -epsilon || local > 1 + epsilon) {
        throw new Error(`A triangle spans multiple UDIM tiles near tile ${tile}; split its UVs along the tile border before exporting.`);
    }
    return Math.min(1, Math.max(0, local));
};

/**
 * A set over several UDIM tiles laid on one atlas (tileAtlasLayout): each corner's UV moved into its
 * triangle's cell, corners split where triangles of different tiles share them.
 */
export const atlasMesh = (part: GltfMesh & { triangleTile: Uint16Array; triangleShift: Int16Array }, layout: TileLayout): GltfMesh => {
    const vertexCount = part.positions.length / 3;
    const made = new Map<number, number>();
    const corners: number[] = [];
    const uvs: number[] = [];
    const indices = new Uint32Array(part.indices.length);
    for (let triangle = 0; triangle < part.indices.length / 3; triangle++) {
        const tileU = part.triangleShift[triangle * 2], tileV = part.triangleShift[triangle * 2 + 1];
        const { index: cell, left, bottom } = atlasCell(layout, tileU, tileV);
        for (let k = 0; k < 3; k++) {
            const vertex = part.indices[triangle * 3 + k];
            const key = cell * vertexCount + vertex;
            let at = made.get(key);
            if (at === undefined) {
                at = corners.length;
                made.set(key, at);
                corners.push(vertex);
                const u = atlasLocal(part.uvs[vertex * 2], tileU, layout.tiles[cell]);
                const v = atlasLocal(part.uvs[vertex * 2 + 1], tileV, layout.tiles[cell]);
                uvs.push((left + u * layout.cell) / layout.width, (bottom + v * layout.cell) / layout.height);
            }
            indices[triangle * 3 + k] = at;
        }
    }
    const pick = (source: Float32Array | null, size: number): Float32Array | null => {
        if (!source) return null;
        const out = new Float32Array(corners.length * size);
        corners.forEach((vertex, i) => out.set(source.subarray(vertex * size, vertex * size + size), i * size));
        return out;
    };
    return { positions: pick(part.positions, 3)!, normals: pick(part.normals, 3), uvs: Float32Array.from(uvs), tangents: pick(part.tangents, 4), indices };
};

/** The painted maps as PNG files. The ORM picture holds occlusion in red, roughness in green and metallic in blue. */
export interface GltfPictures {
    baseColor?: Uint8Array;
    orm?: { png: Uint8Array; occlusion: boolean; metallicRoughness: boolean };
    normal?: Uint8Array;
    emissive?: Uint8Array;
}

const align4 = (length: number): number => length + ((4 - (length % 4)) % 4);
const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/** Unit-length normals (glTF asks for them). */
const unitNormals = (normals: Float32Array): Float32Array => {
    const out = new Float32Array(normals.length);
    for (let i = 0; i < normals.length; i += 3) {
        const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
        if (length > 1e-8) { out[i] = normals[i] / length; out[i + 1] = normals[i + 1] / length; out[i + 2] = normals[i + 2] / length; } else out[i + 2] = 1;
    }
    return out;
};

/**
 * A painted surface's glTF material: its factors, its pictures (each handed to `addTexture`, which gives
 * back the texture's index) and its extensions.
 */
export const paintedMaterial = (surface: GltfSurface, pictures: GltfPictures, name: string, addTexture: (png: Uint8Array, name: string) => number): Record<string, unknown> => {
    const pbr: Record<string, unknown> = {
        baseColorFactor: [...surface.baseColor, surface.opacity].map(round),
        metallicFactor: round(surface.metalness),
        roughnessFactor: round(surface.roughness),
    };
    const material: Record<string, unknown> = { name: surface.name, pbrMetallicRoughness: pbr };
    if (pictures.baseColor) pbr.baseColorTexture = { index: addTexture(pictures.baseColor, `${name}_baseColor`) };
    if (pictures.orm) {
        const index = addTexture(pictures.orm.png, `${name}_occlusionRoughnessMetallic`);
        if (pictures.orm.metallicRoughness) pbr.metallicRoughnessTexture = { index };
        if (pictures.orm.occlusion) material.occlusionTexture = { index };
    }
    if (pictures.normal) material.normalTexture = { index: addTexture(pictures.normal, `${name}_normal`) };
    if (pictures.emissive) material.emissiveTexture = { index: addTexture(pictures.emissive, `${name}_emissive`) };
    const emissive = surface.emissive.map(round);
    if (emissive.some((value) => value > 0)) material.emissiveFactor = emissive;
    if (surface.alphaMode !== 'OPAQUE') material.alphaMode = surface.alphaMode;
    if (surface.alphaMode === 'MASK') material.alphaCutoff = round(surface.alphaCutoff);
    if (surface.doubleSided) material.doubleSided = true;
    if (Object.keys(surface.extensions).length) material.extensions = surface.extensions;
    return material;
};

/** The painted set as a GLB: one node, one mesh, one material, every picture inside the file. */
export const writePaintedGlb = (input: { name: string; mesh: GltfMesh; surface: GltfSurface; pictures: GltfPictures }): ArrayBuffer => {
    const { mesh, surface, pictures } = input;
    const parts: Uint8Array[] = [];
    let length = 0;
    const bufferViews: Array<Record<string, unknown>> = [];
    const view = (bytes: Uint8Array, target?: number): number => {
        const offset = length;
        parts.push(bytes);
        length = align4(offset + bytes.byteLength);
        if (length > offset + bytes.byteLength) parts.push(new Uint8Array(length - offset - bytes.byteLength));
        bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
        return bufferViews.length - 1;
    };
    const accessors: Array<Record<string, unknown>> = [];
    const floats = (data: Float32Array, size: number, type: string, bounds = false): number => {
        const count = data.length / size;
        const accessor: Record<string, unknown> = { bufferView: view(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), 34962), componentType: 5126, count, type };
        if (bounds) {
            const min = Array.from({ length: size }, () => Infinity);
            const max = Array.from({ length: size }, () => -Infinity);
            for (let i = 0; i < count; i++) for (let c = 0; c < size; c++) { const value = data[i * size + c]; if (value < min[c]) min[c] = value; if (value > max[c]) max[c] = value; }
            accessor.min = min.map((value) => (Number.isFinite(value) ? value : 0));
            accessor.max = max.map((value) => (Number.isFinite(value) ? value : 0));
        }
        accessors.push(accessor);
        return accessors.length - 1;
    };
    const attributes: Record<string, number> = { POSITION: floats(mesh.positions, 3, 'VEC3', true) };
    if (mesh.normals) attributes.NORMAL = floats(unitNormals(mesh.normals), 3, 'VEC3');
    attributes.TEXCOORD_0 = floats(mesh.uvs, 2, 'VEC2');
    if (mesh.tangents && mesh.normals) attributes.TANGENT = floats(mesh.tangents, 4, 'VEC4');
    accessors.push({ bufferView: view(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength), 34963), componentType: 5125, count: mesh.indices.length, type: 'SCALAR' });
    const indices = accessors.length - 1;

    const images: Array<Record<string, unknown>> = [];
    const textures: Array<Record<string, unknown>> = [];
    const texture = (png: Uint8Array, name: string): number => {
        images.push({ bufferView: view(png), mimeType: 'image/png', name });
        textures.push({ source: images.length - 1, sampler: 0, name });
        return textures.length - 1;
    };
    const material = paintedMaterial(surface, pictures, input.name, texture);
    const used = Object.keys(surface.extensions);

    const binary = new Uint8Array(length);
    let at = 0;
    for (const part of parts) { binary.set(part, at); at += part.byteLength; }
    const json = {
        asset: { version: '2.0', generator: 'Auvra' },
        ...(used.length ? { extensionsUsed: used } : {}),
        scene: 0,
        scenes: [{ name: input.name, nodes: [0] }],
        nodes: [{ name: input.name, mesh: 0 }],
        meshes: [{ name: input.name, primitives: [{ attributes, indices, material: 0, mode: 4 }] }],
        materials: [material],
        ...(textures.length ? { textures, images, samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }] } : {}),
        accessors,
        bufferViews,
        buffers: [{ byteLength: length }],
    };
    return writeGlb(json, binary);
};

/** What a material of a whole model's export is to become: a painted surface and its pictures. */
export interface PaintedMaterial { name: string; surface: GltfSurface; pictures: GltfPictures; atlas?: TileLayout | null }

/** The extras key a material carries through a glTF export to be given its painted material afterwards. */
export const PAINTED_KEY = 'auvraPainted';

/**
 * Marks the materials of a model (a copy of it) that painted materials are to take the place of: each
 * becomes a plain material carrying its key (`keyOf` gives the key, or null to leave it as it is), so a
 * glTF export keeps its place and `withPaintedMaterials` can fill it in.
 */
export const markPaintedMaterials = (
    root: THREE.Object3D,
    keyOf: (material: THREE.Material) => string | null,
    atlasFor?: (material: THREE.Material) => TileLayout | null,
): Set<string> => {
    const keys = new Set<string>();
    const swapped = new Map<THREE.Material, THREE.Material>();
    const swap = (material: THREE.Material): THREE.Material => {
        const key = keyOf(material);
        if (!key) return material;
        keys.add(key);
        let plain = swapped.get(material);
        if (!plain) {
            plain = new THREE.MeshStandardMaterial({ name: material.name });
            plain.userData = { [PAINTED_KEY]: key };
            swapped.set(material, plain);
        }
        return plain;
    };
    root.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        const materials = mesh.material;
        if (atlasFor) mesh.geometry = atlasMaterialUvCorners(mesh.geometry, index => {
            const material = Array.isArray(materials) ? materials[index] : materials;
            return material ? atlasFor(material) : null;
        });
        mesh.material = Array.isArray(materials) ? materials.map(swap) : swap(materials);
    });
    return keys;
};

/**
 * A GLB (from a glTF export of a marked model) with each marked material given its painted material:
 * factors, extensions and pictures, the pictures added to the file's binary chunk.
 */
export const withPaintedMaterials = (glb: ArrayBuffer, painted: ReadonlyMap<string, PaintedMaterial>): ArrayBuffer => {
    const { json: document, jsonEnd } = readGlb(glb);
    const json = document as Record<string, unknown> & {
        materials?: Array<Record<string, unknown> & { extras?: Record<string, unknown> }>;
        images?: Array<Record<string, unknown>>;
        textures?: Array<Record<string, unknown>>;
        samplers?: Array<Record<string, unknown>>;
        bufferViews?: Array<Record<string, unknown>>;
        buffers?: Array<{ byteLength: number }>;
        extensionsUsed?: string[];
    };
    const binary = readGlbBinary(glb, jsonEnd) ?? new Uint8Array(0);
    const added: Uint8Array[] = [];
    let length = align4(binary.byteLength);
    json.bufferViews ??= [];
    json.images ??= [];
    json.textures ??= [];
    json.samplers ??= [];
    const sampler = json.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }) - 1;
    const addTexture = (png: Uint8Array, name: string): number => {
        const offset = length;
        added.push(png);
        length = align4(offset + png.byteLength);
        if (length > offset + png.byteLength) added.push(new Uint8Array(length - offset - png.byteLength));
        const view = json.bufferViews!.push({ buffer: 0, byteOffset: offset, byteLength: png.byteLength }) - 1;
        const image = json.images!.push({ bufferView: view, mimeType: 'image/png', name }) - 1;
        return json.textures!.push({ source: image, sampler, name }) - 1;
    };
    const used = new Set(json.extensionsUsed ?? []);
    json.materials = (json.materials ?? []).map((material) => {
        const key = material.extras?.[PAINTED_KEY];
        const paint = typeof key === 'string' ? painted.get(key) : undefined;
        if (!paint) return material;
        for (const name of Object.keys(paint.surface.extensions)) used.add(name);
        return paintedMaterial({ ...paint.surface, name: typeof material.name === 'string' ? material.name : paint.surface.name }, paint.pictures, paint.name, addTexture);
    });
    if (!json.images.length) { delete json.images; delete json.textures; }
    if (json.samplers.length === 1 && !json.textures) delete json.samplers;
    if (used.size) json.extensionsUsed = [...used];
    const out = new Uint8Array(length);
    out.set(binary, 0);
    let at = align4(binary.byteLength);
    for (const part of added) { out.set(part, at); at += part.byteLength; }
    json.buffers = [{ byteLength: length }];
    return writeGlb(json, out);
};

/**
 * Whole-model GLB export: atlas coordinates for EACH TRIANGLE'S CORNERS.
 *
 * A UV at an integer tile edge can belong to a triangle in either adjacent
 * tile. Changing a shared indexed vertex in place picks one tile for both
 * triangles and gives the other triangle the wrong texture. Splitting into
 * non-indexed triangles keeps every other attribute (skin indices/weights,
 * normals, tangents, morph targets) and preserves material group ranges.
 *
 * Only corners of selected painted material groups are remapped; other
 * materials' UVs remain in their original space. Works on a cloned geometry:
 * the model and its source asset are never edited by export.
 */
export const atlasGeometryUvCorners = (
    geometry: THREE.BufferGeometry,
    layout: TileLayout,
    isPaintedMaterial: (materialIndex: number) => boolean,
): THREE.BufferGeometry => atlasMaterialUvCorners(geometry, index => isPaintedMaterial(index) ? layout : null);

/** Apply each material group's own atlas in one geometry copy, keeping untouched groups in source UV space. */
export const atlasMaterialUvCorners = (
    geometry: THREE.BufferGeometry,
    layoutFor: (materialIndex: number) => TileLayout | null,
): THREE.BufferGeometry => {
    const sourceUvs = geometry.getAttribute('uv');
    if (!sourceUvs) return geometry;
    const corners = geometry.index?.count ?? sourceUvs.count;
    const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count: corners, materialIndex: 0 }];
    const selected = groups.flatMap(group => {
        const layout = layoutFor(group.materialIndex ?? 0);
        return layout ? [{ layout, start: group.start, end: Math.min(corners, group.start + group.count) }] : [];
    });
    if (!selected.length) return geometry;
    const atlas = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    try {
        const uvs = atlas.getAttribute('uv');
        for (const { layout, start, end } of selected) {
            for (let at = start; at + 2 < end; at += 3) {
                const averageU = (uvs.getX(at) + uvs.getX(at + 1) + uvs.getX(at + 2)) / 3;
                const averageV = (uvs.getY(at) + uvs.getY(at + 1) + uvs.getY(at + 2)) / 3;
                const tileU = Math.floor(averageU);
                const tileV = Math.floor(averageV);
                const { index: cell, left, bottom } = atlasCell(layout, tileU, tileV);
                for (let corner = 0; corner < 3; corner++) {
                    const index = at + corner;
                    const localU = atlasLocal(uvs.getX(index), tileU, layout.tiles[cell]);
                    const localV = atlasLocal(uvs.getY(index), tileV, layout.tiles[cell]);
                    uvs.setXY(index, (left + localU * layout.cell) / layout.width, (bottom + localV * layout.cell) / layout.height);
                }
            }
        }
        uvs.needsUpdate = true;
        return atlas;
    } catch (error) {
        // A failed export must not retain a temporary, expanded geometry.
        atlas.dispose();
        throw error;
    }
};

/**
 * Texture coordinates of a set over several UDIM tiles moved onto their atlas (tileAtlasLayout), vertex by
 * vertex: each vertex goes into the cell of the tile its own coordinates fall in.
 */
export const atlasUvs = (uvs: ArrayLike<number>, layout: TileLayout): Float32Array => {
    const stride = layout.cell + 2 * layout.gutter;
    const width = layout.columns * stride;
    const height = layout.rows * stride;
    const out = new Float32Array(uvs.length);
    for (let i = 0; i < uvs.length; i += 2) {
        const u = uvs[i], v = uvs[i + 1];
        const tile = 1001 + Math.min(9, Math.max(0, Math.floor(u))) + 10 * Math.max(0, Math.floor(v));
        const cell = Math.max(0, layout.tiles.indexOf(tile));
        const left = (cell % layout.columns) * stride + layout.gutter;
        const bottom = Math.floor(cell / layout.columns) * stride + layout.gutter;
        out[i] = (left + (u - Math.floor(u)) * layout.cell) / width;
        out[i + 1] = (bottom + (v - Math.floor(v)) * layout.cell) / height;
    }
    return out;
};
