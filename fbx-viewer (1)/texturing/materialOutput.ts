import * as THREE from 'three';
import { createMaterialGraph, defaultParams, type MaterialGraph } from '../runtime/materials/materialGraph';
import { OUTPUT_NODE_TYPE as MATERIAL_OUTPUT } from '../runtime/materials/materialNodes';
import type { GpuImage, TextureGpu } from './gpu/textureGpu';
import { encodePng16 } from './png';

/**
 * FROM IMAGES TO AN ENGINE MATERIAL
 *
 * A finished set of channel images (from a texture graph or a painted stack) becomes pictures the
 * project keeps and a material graph that draws with them. Occlusion, roughness and metallic share
 * one picture (red, green, blue), as glTF and most engines pack them, so the material samples it once.
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

/**
 * Encodes the channels as PNG pictures, `width` × `height`. `flipRows` puts the top of the image (v = 1)
 * first, as pictures for bottom-left texture coordinates (FBX, OBJ) are stored; glTF-style models want false.
 * Roles in `deep` are written at 16 bits a channel (for files that leave the editor; the engine reads 8).
 */
export const encodeChannels = async (gpu: TextureGpu, images: ChannelImages, width: number, height: number, layout: PictureLayout, flipRows = true, deep: ReadonlyArray<ChannelPicture['role']> = []): Promise<ChannelPicture[]> => {
    const pictures: ChannelPicture[] = [];
    const add = async (role: ChannelPicture['role'], image: GpuImage, encode: 'color' | 'gray') => {
        const blob = deep.includes(role)
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

/** Where UDIM tile `tile` lies on the UV grid: across, then up (1001 is the first, 1011 the one above it). */
const cellOf = (tile: number): [number, number] => [(tile - 1001) % 10, Math.floor((tile - 1001) / 10)];

/** One tile drawn into its cell of an atlas: as it is, or averaged over each new pixel when shrunk. */
const ATLAS_CELL = `uniform vec2 uGrid;
uniform float uCell;
uniform int uTaps;
void main() {
    vec2 at = fract(vUv * uGrid);
    if (uTaps <= 1) { outColor = texture(source, at); return; }
    vec2 stride = vec2(1.0 / (uCell * float(uTaps)));
    vec2 first = at - vec2(0.5 / uCell) + 0.5 * stride;
    vec4 sum = vec4(0.0);
    for (int y = 0; y < uTaps; y++) for (int x = 0; x < uTaps; x++) sum += texture(source, first + vec2(float(x), float(y)) * stride);
    outColor = sum / float(uTaps * uTaps);
}`;

/** A set over several UDIM tiles laid out on one picture per channel. */
export interface TileAtlas {
    images: ChannelImages;
    columns: number;
    rows: number;
    /** Pixels a tile has on the picture. */
    cell: number;
    width: number;
    height: number;
}

/**
 * The channels of a set spread over several UDIM tiles, each laid on one picture with every tile where it
 * lies on the UV grid (1001 at the bottom left), so a material reads it with the coordinates scaled down by
 * the grid. A tile keeps its own pixels unless the whole would pass what the GPU holds, then each is shrunk
 * to fit. The images are the caller's to release.
 */
export const tileAtlas = (gpu: TextureGpu, tiles: readonly number[], channelImages: (tile: number) => ChannelImages, size: number, maxSize = gpu.maxSize): TileAtlas => {
    const columns = Math.max(...tiles.map((tile) => cellOf(tile)[0])) + 1;
    const rows = Math.max(...tiles.map((tile) => cellOf(tile)[1])) + 1;
    const cell = Math.min(size, Math.floor(Math.min(maxSize, 16384) / Math.max(columns, rows)));
    const width = columns * cell;
    const height = rows * cell;
    const perTile = new Map(tiles.map((tile) => [tile, channelImages(tile)]));
    // A shrunk tile averages every pixel of its own that each of its new pixels covers.
    const taps = Math.ceil(size / cell);
    const channels = new Set<MaterialChannel>();
    for (const images of perTile.values()) for (const channel of Object.keys(images)) channels.add(channel as MaterialChannel);
    const images: ChannelImages = {};
    for (const channel of channels) {
        const sample = [...perTile.values()].find((set) => set[channel])![channel]!;
        // Kept as the 8-bit pictures it is written to, so a large grid holds a quarter of the memory.
        const atlas = gpu.image(width, height, sample.kind, 8);
        // Cells with no tile are never read: flat normal, else black.
        gpu.clear(atlas, channel === 'normal' ? [0.5, 0.5, 1, 1] : [0, 0, 0, 1]);
        for (const [tile, set] of perTile) {
            const image = set[channel];
            if (!image) continue;
            const [x, y] = cellOf(tile);
            gpu.passNow(atlas, {
                fragment: ATLAS_CELL,
                inputs: { source: image },
                uniforms: { uGrid: new THREE.Vector2(columns, rows), uCell: cell, uTaps: taps },
                scissor: { x: x * cell, y: y * cell, width: cell, height: cell },
            });
        }
        images[channel] = atlas;
    }
    return { images, columns, rows, cell, width, height };
};

/**
 * A material graph drawing with kept pictures, each wired into the input it is for. With `tiles`, the
 * pictures are a tile atlas: they are read with the coordinates scaled down by its grid.
 */
export const materialGraphForTextures = (textures: ChannelTextureIds, options: { opacityMode?: 'masked' | 'translucent'; tiles?: { columns: number; rows: number } } = {}): MaterialGraph => {
    const graph = createMaterialGraph();
    const output = graph.nodes.find((node) => node.type === MATERIAL_OUTPUT)!;
    output.x = 520;
    const grid = options.tiles && (options.tiles.columns > 1 || options.tiles.rows > 1) ? options.tiles : null;
    if (grid) graph.nodes.push({ id: 'udimTiles', type: 'tilingOffset', x: -200, y: 0, params: { ...defaultParams('tilingOffset'), tiling: [1 / grid.columns, 1 / grid.rows], offset: [0, 0] } });
    let row = 0;
    const add = (id: string, type: string, params: Record<string, unknown>) => {
        graph.nodes.push({ id, type, x: 80, y: -60 + row++ * 230, params: { ...defaultParams(type), ...params } });
        if (grid) graph.links.push({ fromNode: 'udimTiles', fromOutput: 'out', toNode: id, toInput: 'uv' });
    };
    const wire = (fromNode: string, fromOutput: string, toInput: string) => graph.links.push({ fromNode, fromOutput, toNode: output.id, toInput });
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
