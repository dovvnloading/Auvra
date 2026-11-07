import * as THREE from 'three';
import { createMaterialGraph, defaultParams, readsMaterialPictures, type MaterialGraph } from '../runtime/materials/materialGraph';
import { FLIPBOOK_FRAMES_NODE_TYPE, MATERIAL_PICTURE_NODE_TYPE, OUTPUT_NODE_TYPE as MATERIAL_OUTPUT, UDIM_ATLAS_NODE_TYPE } from '../runtime/materials/materialNodes';
import type { GpuImage, TextureGpu } from './gpu/textureGpu';
import { encodePng16 } from './png';

/**
 * FROM IMAGES TO AN ENGINE MATERIAL
 *
 * A finished set of channel images (from a texture graph or a painted stack) becomes pictures the
 * project keeps and a material graph that draws with them. In the engine layout occlusion, roughness
 * and metallic share one picture (red, green, blue), as glTF and most engines pack them, so the
 * material samples it once; with one picture per channel the material reads each picture of its own.
 *
 * Height is kept with the material, at 16 bits a channel, and drawn with through a Parallax node: the
 * graph moves every picture's UV with the view and shades the low parts, at a depth each use can change
 * (its Height depth value).
 */

export type MaterialChannel = 'baseColor' | 'normal' | 'roughness' | 'metallic' | 'height' | 'ambientOcclusion' | 'emissive' | 'opacity';

export type ChannelImages = Partial<Record<MaterialChannel, GpuImage>>;

/** A picture to keep, and what it holds. */
export interface ChannelPicture {
    role: 'baseColor' | 'normal' | 'orm' | 'emissive' | 'opacity' | 'height' | 'roughness' | 'metallic' | 'ambientOcclusion';
    blob: Blob;
    width: number;
    height: number;
}

/** The kept pictures' texture ids, by role. */
export type ChannelTextureIds = Partial<Record<ChannelPicture['role'], string>>;

export const ROLE_LABELS: Record<ChannelPicture['role'], string> = {
    baseColor: 'Base colour', normal: 'Normal', orm: 'Occlusion, roughness, metallic', emissive: 'Emissive', opacity: 'Opacity', height: 'Height',
    roughness: 'Roughness', metallic: 'Metallic', ambientOcclusion: 'Ambient occlusion',
};

/** A layout of pictures to write: packed for the engine, or one picture per channel. */
export type PictureLayout = 'engine' | 'separate';

/** What exported pictures keep at 16 bits a channel: height steps and normal banding show at 8. */
export const DEEP_EXPORT: ReadonlyArray<ChannelPicture['role']> = ['height', 'normal'];

/** What is kept at 16 bits a channel whatever the pictures are for: height's steps show at 8. */
const ALWAYS_DEEP: ReadonlyArray<ChannelPicture['role']> = ['height'];

/** Whether a material made by materialGraphForTextures draws with a picture of this role: all do, height through Parallax. */
export const materialReadsPicture = (role: ChannelPicture['role']): boolean => role.length > 0;

/** How deep a height picture looks at first, in texture units; each use can change it (its Height depth value). */
export const DEFAULT_PARALLAX_DEPTH = 0.03;

/**
 * Encodes the channels as PNG pictures, `width` × `height`. `flipRows` puts the top of the image (v = 1)
 * first, as pictures for bottom-left texture coordinates (FBX, OBJ) are stored; glTF-style models want false.
 * Roles in `deep` are written at 16 bits a channel (for files that leave the editor; the engine reads 8),
 * and height always is.
 */
export const encodeChannels = async (gpu: TextureGpu, images: ChannelImages, width: number, height: number, layout: PictureLayout, flipRows = true, deep: ReadonlyArray<ChannelPicture['role']> = []): Promise<ChannelPicture[]> => {
    const pictures: ChannelPicture[] = [];
    const deepRoles = new Set([...deep, ...ALWAYS_DEEP]);
    const add = async (role: ChannelPicture['role'], image: GpuImage, encode: 'color' | 'gray') => {
        const blob = deepRoles.has(role)
            ? await encodePng16(gpu.readUint16(image, width, height, encode, flipRows), width, height, encode === 'gray' ? 1 : 4)
            : await gpu.toPng(image, width, height, encode, flipRows);
        pictures.push({ role, blob, width, height });
    };
    if (images.baseColor) await add('baseColor', images.baseColor, 'color');
    if (images.normal) await add('normal', images.normal, 'color');
    if (images.emissive) await add('emissive', images.emissive, 'color');
    if (images.opacity) await add('opacity', images.opacity, 'gray');
    if (images.height) await add('height', images.height, 'gray');
    if (layout === 'separate') {
        if (images.roughness) await add('roughness', images.roughness, 'gray');
        if (images.metallic) await add('metallic', images.metallic, 'gray');
        if (images.ambientOcclusion) await add('ambientOcclusion', images.ambientOcclusion, 'gray');
        return pictures;
    }
    if (images.roughness || images.metallic || images.ambientOcclusion) {
        const packed = gpu.image(width, height, 'color', 8);
        await gpu.pass(packed, {
            fragment: `uniform int hasAo;\nuniform int hasRough;\nuniform int hasMetal;
void main() { outColor = vec4(hasAo == 1 ? texture(ao, vUv).r : 1.0, hasRough == 1 ? texture(rough, vUv).r : 0.5, hasMetal == 1 ? texture(metal, vUv).r : 0.0, 1.0); }`,
            inputs: { ao: images.ambientOcclusion ?? null, rough: images.roughness ?? null, metal: images.metallic ?? null },
            uniforms: { hasAo: images.ambientOcclusion ? 1 : 0, hasRough: images.roughness ? 1 : 0, hasMetal: images.metallic ? 1 : 0 },
        });
        await add('orm', packed, 'color');
        gpu.release(packed);
    }
    return pictures;
};

// ---------------------------------------------------------------------------
// UDIM tile atlas
// ---------------------------------------------------------------------------

/**
 * How a set's UDIM tiles lie on one picture: only the tiles in use, packed into a grid of cells, each
 * tile inside a gutter of its own edge pixels so filtering and the smaller mip levels stay inside it.
 */
export interface TileLayout {
    /** The tiles, in the order of their cells: across, then up, from the bottom left. */
    tiles: readonly number[];
    /** Cells across and up. */
    columns: number;
    rows: number;
    /** Pixels a tile has across inside its cell. */
    cell: number;
    /** Pixels of copied edge round each tile. */
    gutter: number;
    /** The whole picture's size. */
    width: number;
    height: number;
}

/** A set over several UDIM tiles laid out on one picture per channel. */
export interface TileAtlas extends TileLayout {
    images: ChannelImages;
}

/** A gutter is about this share of a tile's side, and at least MIN_GUTTER pixels. */
const GUTTER_SHARE = 1 / 64;
const MIN_GUTTER = 2;
/** The largest picture made, whatever the GPU allows. */
const MAX_ATLAS_SIZE = 16384;

/**
 * Where a set's tiles go on an atlas of tiles `size` pixels across, at most `maxSize` pixels a side. The
 * gutter is a power of two, about a 64th of a tile, and a cell (tile and gutters) a multiple of twice
 * it: every cell's edge then lies on a texel edge of the mip levels down to texels as wide as two
 * gutters, and up to those levels sampling stays inside the tile. A tile keeps its own pixels unless the
 * whole would pass `maxSize`, then each is shrunk to fit.
 */
export const tileAtlasLayout = (tiles: readonly number[], size: number, maxSize: number): TileLayout => {
    const sorted = [...new Set(tiles)].sort((a, b) => a - b);
    const columns = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
    const rows = Math.max(1, Math.ceil(sorted.length / columns));
    const fit = Math.floor(Math.min(maxSize, MAX_ATLAS_SIZE) / Math.max(columns, rows) / (1 + 2 * GUTTER_SHARE));
    let cell = Math.max(1, Math.min(size, fit));
    const gutter = Math.max(MIN_GUTTER, 2 ** Math.floor(Math.log2(Math.max(1, cell * GUTTER_SHARE))));
    if (cell >= 2 * gutter) cell -= cell % (2 * gutter);
    const stride = cell + 2 * gutter;
    return { tiles: sorted, columns, rows, cell, gutter, width: columns * stride, height: rows * stride };
};

/**
 * Where on the atlas a point of a UDIM set is read, as the UDIM Atlas node works it out: the point's tile
 * gives its cell, and the point is kept half a pixel inside that tile's own pixels.
 */
export const udimAtlasPoint = (layout: TileLayout, u: number, v: number): [number, number] => {
    const tile = 1001 + Math.min(9, Math.max(0, Math.floor(u))) + 10 * Math.max(0, Math.floor(v));
    const index = Math.max(0, layout.tiles.indexOf(tile));
    const stride = layout.cell + 2 * layout.gutter;
    const inside = (value: number) => Math.min(Math.max((value - Math.floor(value)) * layout.cell, 0.5), Math.max(layout.cell - 0.5, 0.5));
    const x = (index % layout.columns) * stride + layout.gutter + inside(u);
    const y = Math.floor(index / layout.columns) * stride + layout.gutter + inside(v);
    return [x / (layout.columns * stride), y / (Math.ceil(layout.tiles.length / layout.columns) * stride)];
};

/**
 * One tile drawn into its cell of an atlas, and its edge pixels copied out across the gutter round it;
 * a shrunk tile averages every pixel of its own that each of its new pixels covers.
 */
// uSize is the pass's own (the atlas's size), declared by its prelude.
const ATLAS_CELL = `uniform vec2 uOrigin;
uniform float uCell;
uniform float uSource;
uniform int uTaps;
vec4 tileAt(vec2 at) {
    vec2 edge = vec2(0.5 / uSource);
    return texture(source, clamp(at, edge, 1.0 - edge));
}
void main() {
    vec2 at = (vUv * uSize - uOrigin) / uCell;
    if (uTaps <= 1) { outColor = tileAt(at); return; }
    vec2 pitch = vec2(1.0 / (uCell * float(uTaps)));
    vec2 first = at - vec2(0.5 / uCell) + 0.5 * pitch;
    vec4 sum = vec4(0.0);
    for (int y = 0; y < uTaps; y++) for (int x = 0; x < uTaps; x++) sum += tileAt(first + vec2(float(x), float(y)) * pitch);
    outColor = sum / float(uTaps * uTaps);
}`;

/**
 * The channels of a set spread over several UDIM tiles, laid on one picture per channel by
 * tileAtlasLayout. A material reads it through a UDIM Atlas node (materialGraphForTextures with the
 * atlas as `tiles`). Pictures are 8 bits a channel, as they are written, but height is 16. The images
 * are the caller's to release.
 */
export const tileAtlas = (gpu: TextureGpu, tiles: readonly number[], channelImages: (tile: number) => ChannelImages, size: number, maxSize = gpu.maxSize): TileAtlas => {
    const layout = tileAtlasLayout(tiles, size, maxSize);
    const { columns, cell, gutter, width, height } = layout;
    const stride = cell + 2 * gutter;
    const perTile = new Map(layout.tiles.map((tile) => [tile, channelImages(tile)]));
    const taps = Math.ceil(size / cell);
    const channels = new Set<MaterialChannel>();
    for (const images of perTile.values()) for (const channel of Object.keys(images)) channels.add(channel as MaterialChannel);
    const images: ChannelImages = {};
    for (const channel of channels) {
        const sample = [...perTile.values()].find((set) => set[channel])![channel]!;
        const atlas = gpu.image(width, height, sample.kind, channel === 'height' ? 16 : 8);
        // Cells with no tile are never read: flat normal, else black.
        gpu.clear(atlas, channel === 'normal' ? [0.5, 0.5, 1, 1] : [0, 0, 0, 1]);
        layout.tiles.forEach((tile, index) => {
            const image = perTile.get(tile)?.[channel];
            if (!image) return;
            const x = (index % columns) * stride;
            const y = Math.floor(index / columns) * stride;
            gpu.passNow(atlas, {
                fragment: ATLAS_CELL,
                inputs: { source: image },
                uniforms: { uOrigin: new THREE.Vector2(x + gutter, y + gutter), uSize: new THREE.Vector2(width, height), uCell: cell, uSource: image.width, uTaps: taps },
                scissor: { x, y, width: stride, height: stride },
            });
        });
        images[channel] = atlas;
    }
    return { ...layout, images };
};

// ---------------------------------------------------------------------------
// The material graph
// ---------------------------------------------------------------------------

const isTileLayout = (value: TileLayout | { columns: number; rows: number }): value is TileLayout => Array.isArray((value as TileLayout).tiles);

/** A texture graph's flipbook: how many frames, the grid they fill from the top left, and the seconds they loop over. */
export interface FlipbookLayout { frames: number; columns: number; rows: number; loop: number }

const flipbookParams = (flipbook: FlipbookLayout) => ({ frames: flipbook.frames, columns: flipbook.columns, rows: flipbook.rows, loop: flipbook.loop });

type PictureGraphOptions = { opacityMode?: 'masked' | 'translucent'; tiles?: TileLayout | { columns: number; rows: number }; flipbook?: FlipbookLayout | null };

/**
 * A material graph drawing with kept pictures, each wired into the input it is for: occlusion, roughness
 * and metallic from the packed picture, or from one picture each. With `tiles`, the pictures are a tile
 * atlas (tileAtlas), read through a UDIM Atlas node. With `flipbook`, each picture holds an animated
 * texture graph's frames, read through a Flipbook Frames node that plays them round the graph's loop.
 * A height picture drives a Parallax node that moves every other picture's UV and shades the
 * material's low parts, its depth a value each use can change.
 */
export const materialGraphForTextures = (
    textures: ChannelTextureIds,
    options: PictureGraphOptions = {},
): MaterialGraph => {
    const graph = createMaterialGraph();
    const output = graph.nodes.find((node) => node.type === MATERIAL_OUTPUT)!;
    output.x = 520;
    const tiles = options.tiles;
    let atlas: TileLayout | null = null;
    if (tiles && (isTileLayout(tiles) ? tiles.tiles.length > 1 : tiles.columns > 1 || tiles.rows > 1)) {
        // A grid size alone no longer says where each tile is: the cells hold only the tiles in use.
        if (!isTileLayout(tiles)) throw new Error('The places of the UDIM tiles on the picture are missing, so the material cannot read them.');
        atlas = tiles;
    }
    if (atlas) {
        graph.nodes.push({
            id: 'udimTiles', type: UDIM_ATLAS_NODE_TYPE, x: -200, y: 0,
            params: { ...defaultParams(UDIM_ATLAS_NODE_TYPE), tiles: atlas.tiles.join(' '), columns: atlas.columns, tileSize: atlas.cell, gutter: atlas.gutter },
        });
    }
    // A flipbook's frames (never with UDIM tiles, which lay pictures out a way of their own).
    const flipbook = !atlas && options.flipbook ? options.flipbook : null;
    if (flipbook) graph.nodes.push({ id: 'flipbook', type: FLIPBOOK_FRAMES_NODE_TYPE, x: -420, y: 40, params: { ...defaultParams(FLIPBOOK_FRAMES_NODE_TYPE), ...flipbookParams(flipbook) } });
    const wire = (fromNode: string, fromOutput: string, toInput: string) => graph.links.push({ fromNode, fromOutput, toNode: output.id, toInput });
    // Height moves what every other picture shows with the view, at a depth each use of the material can set.
    const parallax = Boolean(textures.height);
    if (parallax) {
        graph.nodes.push({ id: 'heightDepth', type: 'float', x: -420, y: 380, params: { ...defaultParams('float'), value: DEFAULT_PARALLAX_DEPTH }, parameter: 'Height depth' });
        graph.nodes.push({ id: 'parallax', type: 'parallax', x: -180, y: 300, params: { ...defaultParams('parallax'), texture: textures.height } });
        if (atlas) graph.links.push({ fromNode: 'udimTiles', fromOutput: 'out', toNode: 'parallax', toInput: 'uv' });
        else if (flipbook) graph.links.push({ fromNode: 'flipbook', fromOutput: 'out', toNode: 'parallax', toInput: 'uv' });
        graph.links.push({ fromNode: 'heightDepth', fromOutput: 'out', toNode: 'parallax', toInput: 'depth' });
        wire('parallax', 'shadow', 'selfShadow');
    }
    let row = 0;
    const add = (id: string, type: string, params: Record<string, unknown>) => {
        graph.nodes.push({ id, type, x: 80, y: -60 + row++ * 230, params: { ...defaultParams(type), ...params } });
        if (parallax) graph.links.push({ fromNode: 'parallax', fromOutput: 'uv', toNode: id, toInput: 'uv' });
        else if (atlas) graph.links.push({ fromNode: 'udimTiles', fromOutput: 'out', toNode: id, toInput: 'uv' });
        else if (flipbook) graph.links.push({ fromNode: 'flipbook', fromOutput: 'out', toNode: id, toInput: 'uv' });
    };
    if (textures.baseColor) {
        add('baseColor', 'texture', { texture: textures.baseColor, space: 'color' });
        wire('baseColor', 'rgb', 'baseColor');
    }
    if (textures.normal) {
        add('normal', 'normalMap', { texture: textures.normal });
        wire('normal', 'out', 'normal');
    }
    if (textures.orm) {
        add('orm', 'texture', { texture: textures.orm, space: 'data' });
        wire('orm', 'r', 'occlusion');
        wire('orm', 'g', 'roughness');
        wire('orm', 'b', 'metalness');
    } else {
        // One picture per channel: each grey picture into its own input.
        const single = (role: 'roughness' | 'metallic' | 'ambientOcclusion', input: string) => {
            const textureId = textures[role];
            if (!textureId) return;
            add(role, 'texture', { texture: textureId, space: 'data' });
            wire(role, 'r', input);
        };
        single('ambientOcclusion', 'occlusion');
        single('roughness', 'roughness');
        single('metallic', 'metalness');
    }
    if (textures.emissive) {
        add('emissive', 'texture', { texture: textures.emissive, space: 'color' });
        wire('emissive', 'rgb', 'emissive');
    }
    if (textures.opacity) {
        add('opacity', 'texture', { texture: textures.opacity, space: 'data' });
        wire('opacity', 'r', 'opacity');
        if (options.opacityMode) output.params = { ...output.params, blendMode: options.opacityMode };
    }
    return graph;
};

/**
 * The surface graph for a material's pictures read by name: as materialGraphForTextures wires them, but each
 * picture read by a Material Picture node (and Parallax set to the material's height picture), so making the
 * pictures again changes only the material's pictures, never this graph.
 */
export const surfaceGraphForPictures = (
    pictures: ChannelTextureIds,
    options: PictureGraphOptions = {},
): MaterialGraph => {
    const graph = materialGraphForTextures(pictures, options);
    const roles = new Set(Object.keys(pictures));
    const nodes = graph.nodes.map((node) => {
        if (node.type === 'parallax') return { ...node, params: { ...node.params, heightFrom: 'height', texture: '' } };
        if ((node.type !== 'texture' && node.type !== 'normalMap') || !roles.has(node.id)) return node;
        // The generated nodes are named after the picture they read.
        return { ...node, type: MATERIAL_PICTURE_NODE_TYPE, params: { ...defaultParams(MATERIAL_PICTURE_NODE_TYPE), output: node.id } };
    });
    // A normal map's normal comes out of its Material Picture's Normal.
    const links = graph.links.map(link => (link.fromNode === 'normal' && link.fromOutput === 'out' && roles.has('normal') ? { ...link, fromOutput: 'normal' } : link));
    return { ...graph, nodes, links };
};

/**
 * What making a material's pictures again changes: its pictures by name, and the surface graph only where
 * it does not read them already (an older material, or one whose set of pictures changed). A surface graph
 * edited by hand keeps its edits; its UDIM tiles follow the new layout.
 */
export const rewriteMaterialPictures = (
    asset: { graph: MaterialGraph; pictures?: Readonly<Record<string, string>> },
    pictures: ChannelTextureIds,
    options: PictureGraphOptions = {},
): { graph: MaterialGraph; pictures: Record<string, string> } => {
    const kept = Object.fromEntries(Object.entries(pictures).filter(([, id]) => typeof id === 'string' && id)) as Record<string, string>;
    const sameRoles = JSON.stringify(Object.keys(asset.pictures ?? {}).sort()) === JSON.stringify(Object.keys(kept).sort());
    // Pictures becoming a flipbook (or no longer one) change how they are read: the graph is made again.
    const flipbook = options.flipbook ?? null;
    const playsFlipbook = asset.graph.nodes.some(node => node.type === FLIPBOOK_FRAMES_NODE_TYPE);
    if (!readsMaterialPictures(asset.graph) || !sameRoles || Boolean(flipbook) !== playsFlipbook) return { graph: surfaceGraphForPictures(kept, options), pictures: kept };
    const tiles = options.tiles && isTileLayout(options.tiles) ? options.tiles : null;
    const graph = tiles || flipbook ? {
        ...asset.graph,
        nodes: asset.graph.nodes.map(node => (tiles && node.type === UDIM_ATLAS_NODE_TYPE
            ? { ...node, params: { ...node.params, tiles: tiles.tiles.join(' '), columns: tiles.columns, tileSize: tiles.cell, gutter: tiles.gutter } }
            : flipbook && node.type === FLIPBOOK_FRAMES_NODE_TYPE ? { ...node, params: { ...node.params, ...flipbookParams(flipbook) } } : node)),
    } : asset.graph;
    return { graph, pictures: kept };
};
