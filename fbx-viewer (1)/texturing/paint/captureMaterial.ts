import { createNode } from '../graph/document';
import { seamMasks, seamTile, softenMask, type Picture } from '../graph/seamCut';
import type { GraphParameter, GraphParameterGroup, TexGraphLink, TexGraphNode, TextureGraph } from '../graph/types';
import { heightFromNormals, photometricStereo, type CapturePhoto, type Vec3 } from './photometricStereo';
import { PHOTO_PARAMETERS } from './photoMaterial';

/**
 * MULTI-ANGLE CAPTURE TO MATERIAL
 *
 * The maps photometric stereo works out from photos lit from several sides (photometricStereo.ts),
 * made to tile and turned into a texture graph like a photo material's, using them in place of
 * guesses: the colour as it is, evenly lit, the normal as measured and the height integrated from it.
 * Occlusion comes from the height, roughness from a curve of height and colour, metal by colour.
 */

export interface CapturedMaps {
    width: number;
    height: number;
    /** sRGB colour, red green blue a pixel. */
    albedo: Float32Array;
    /** Unit normals, x y z a pixel (green up). */
    normal: Float32Array;
    /** Height, 0 (lowest) to 1, a value a pixel. */
    heightMap: Float32Array;
}

/** A picture of rows (top first) as the seam cutter takes them: it reads with wrapping, either way up. */
const asPicture = (data: Float32Array, width: number, height: number, channels: number): Picture => ({ data, width, height, channels });

/**
 * The capture's maps, from photos and their lights: solved, then made to tile with one set of joins
 * for colour and normal (found on the colour, `band` of the picture wide, as Make it tile does), and
 * the height integrated from the tiling normal, so it tiles too and agrees with it. Sides must be
 * powers of two.
 */
export const captureMaps = (photos: readonly CapturePhoto[], lights: readonly Vec3[], width: number, height: number, band = 0.2): CapturedMaps => {
    const solved = photometricStereo(photos, lights, width, height);
    const colour = asPicture(solved.albedo, width, height, 3);
    const masks = seamMasks(colour, (band * Math.min(width, height)) / 2);
    const soft = { upright: softenMask(masks.upright, width, height, 2), level: softenMask(masks.level, width, height, 2) };
    const albedo = seamTile(colour, soft).data;
    const normal = seamTile(asPicture(solved.normal, width, height, 3), soft).data;
    // Joins blend normals a little: unit length again.
    for (let i = 0; i < width * height; i++) {
        const length = Math.hypot(normal[i * 3], normal[i * 3 + 1], normal[i * 3 + 2]) || 1;
        for (let c = 0; c < 3; c++) normal[i * 3 + c] /= length;
    }
    const raw = heightFromNormals(normal, width, height, true, DRIFT_WAVES);
    return { width, height, albedo, normal, heightMap: stretched(raw) };
};

/**
 * Changes in the height slower than this many waves across the picture are taken out: the broad drift
 * integrating a measured normal gathers (a bright middle, a dark corner). A brick wall's courses and
 * bricks, at five or more across, stay.
 */
const DRIFT_WAVES = 2.5;

/** Heights stretched to 0 to 1 between their half-percent lowest and highest (a stray few don't squash the rest). */
const stretched = (values: Float32Array): Float32Array => {
    const sorted = Float32Array.from(values).sort();
    const low = sorted[Math.floor(sorted.length * 0.005)];
    const high = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.995))];
    const range = Math.max(high - low, 1e-6);
    return values.map((value) => Math.min(1, Math.max(0, (value - low) / range)));
};

const strength = 'Strength';

export const CAPTURE_PARAMETERS: readonly GraphParameter[] = [
    { name: 'normalStrength', label: 'Normal strength', kind: 'float', default: 1, min: 0, max: 3, step: 0.01, group: strength, description: 'How strongly the measured normal reads: 1 is as the photos showed it.' },
    { name: 'depth', label: 'Height depth', kind: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: strength, description: 'How deep the measured height reads in the occlusion worked out from it.' },
    ...PHOTO_PARAMETERS.filter((parameter) => ['roughLow', 'roughHigh', 'metalColour', 'metalRange'].includes(parameter.name)),
];

export const CAPTURE_GROUPS: readonly GraphParameterGroup[] = [
    { name: strength, description: 'How strongly each measured map reads.' },
    { name: 'Metal', description: 'Metallic where the photos show a chosen colour (none unless set).', folded: true },
];

/** The project textures of a capture's maps. */
export interface CaptureTextures { colour: string; normal: string; height: string }

/** A texture graph material from a capture's maps (project textures). */
export const captureMaterialGraph = (textures: CaptureTextures, size = 10): TextureGraph => {
    const nodes: TexGraphNode[] = [];
    const links: TexGraphLink[] = [];
    const add = (type: string, x: number, y: number, params: Record<string, unknown> = {}, name?: string): TexGraphNode => {
        const node = createNode(type, x, y, params);
        if (name) node.name = name;
        nodes.push(node);
        return node;
    };
    const wire = (from: TexGraphNode, to: TexGraphNode, toInput = 'in', fromOutput = 'out') => links.push({ from: from.id, fromOutput, to: to.id, toInput });
    const bind = (name: string) => ({ $bind: name });

    const colourMap = add('bitmap', 0, 0, { texture: textures.colour, fit: 'fill' }, 'Captured colour');
    const colour = add('colourEqualizer', 240, 0, {}, 'Colour evened out');
    wire(colourMap, colour);
    const normalMap = add('bitmap', 0, 220, { texture: textures.normal, fit: 'fill' }, 'Captured normal');
    const normal = add('normalAdjust', 240, 220, { strength: bind('normalStrength') }, 'Normal');
    wire(normalMap, normal);
    const heightMap = add('bitmap', 0, 440, { texture: textures.height, fit: 'fill' }, 'Captured height');
    const height = add('grayscale', 240, 440, { mode: 'luminance' }, 'Height');
    wire(heightMap, height);
    const smooth = add('blur', 480, 560, { radius: 0.006 }, 'Large-scale height');
    wire(height, smooth);
    const occlusion = add('aoFromHeight', 720, 560, { depth: { $expr: 'depth * 0.05' }, radius: 0.02, intensity: 0.6 }, 'Occlusion');
    wire(smooth, occlusion);
    // Roughness: a curve of the height and the colour's brightness, squeezed to its range.
    const tone = add('grayscale', 480, 120, { mode: 'luminance' }, 'Colour brightness');
    wire(colour, tone);
    const mixed = add('blend', 720, 300, { mode: 'multiply', opacity: 0.5 }, 'Height and colour');
    wire(height, mixed, 'foreground');
    wire(tone, mixed, 'background');
    const curve = add('curves', 960, 300, {}, 'Roughness curve');
    wire(mixed, curve);
    const roughness = add('levels', 1200, 300, { outLow: bind('roughLow'), outHigh: bind('roughHigh') }, 'Roughness range');
    wire(curve, roughness);
    const metallic = add('colorToMask', 720, 0, { color: bind('metalColour'), range: bind('metalRange'), softness: 0.05 }, 'Metal by colour');
    wire(colour, metallic);
    const output = (channel: string, from: TexGraphNode, y: number) => wire(from, add('output', 1460, y, { channel }));
    output('baseColor', colour, 0);
    output('normal', normal, 140);
    output('roughness', roughness, 280);
    output('metallic', metallic, 420);
    output('height', height, 560);
    output('ambientOcclusion', occlusion, 700);
    return {
        version: 1,
        size: { w: size, h: size },
        seed: 1,
        nodes,
        links,
        parameters: CAPTURE_PARAMETERS.map((parameter) => structuredClone(parameter) as GraphParameter),
        groups: CAPTURE_GROUPS.map((group) => ({ ...group })),
        tiling: 'both',
    };
};
