import { createMaterialGraph, defaultParams, type MaterialGraph } from '../runtime/materials/materialGraph';
import { OUTPUT_NODE_TYPE as MATERIAL_OUTPUT } from '../runtime/materials/materialNodes';
import type { GpuImage, TextureGpu } from './gpu/textureGpu';

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

/**
 * Encodes the channels as PNG pictures, `width` × `height`. `flipRows` puts the top of the image (v = 1)
 * first, as pictures for bottom-left texture coordinates (FBX, OBJ) are stored; glTF-style models want false.
 */
export const encodeChannels = async (gpu: TextureGpu, images: ChannelImages, width: number, height: number, layout: PictureLayout, flipRows = true): Promise<ChannelPicture[]> => {
    const pictures: ChannelPicture[] = [];
    const add = async (role: ChannelPicture['role'], image: GpuImage, encode: 'color' | 'gray') => {
        pictures.push({ role, blob: await gpu.toPng(image, width, height, encode, flipRows), width, height });
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

/** A material graph drawing with kept pictures, each wired into the input it is for. */
export const materialGraphForTextures = (textures: ChannelTextureIds, options: { opacityMode?: 'masked' | 'translucent' } = {}): MaterialGraph => {
    const graph = createMaterialGraph();
    const output = graph.nodes.find((node) => node.type === MATERIAL_OUTPUT)!;
    output.x = 520;
    let row = 0;
    const add = (id: string, type: string, params: Record<string, unknown>) => {
        graph.nodes.push({ id, type, x: 80, y: -60 + row++ * 230, params: { ...defaultParams(type), ...params } });
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
