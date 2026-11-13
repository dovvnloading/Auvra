import { createNode } from '../graph/document';
import type { GraphParameter, GraphParameterGroup, TexGraphLink, TexGraphNode, TextureGraph } from '../graph/types';
import { PHOTO_PARAMETERS } from './photoMaterial';

/**
 * MULTI-ANGLE CAPTURE TO MATERIAL
 *
 * The maps photometric stereo works out from photos lit from several sides (photometricStereo.ts),
 * made to tile and turned into a texture graph like a photo material's, using them in place of
 * guesses: the colour as it is, evenly lit, the normal as measured and the height integrated from it.
 * Occlusion comes from the height, roughness from a curve of height and colour, metal by colour.
 */

export { captureMaps, type CapturedMaps } from './captureMaps';

/** Words a camera puts in its file names, which say nothing of the surface. */
const CAMERA_WORDS = /^(img|image|dsc|dscn|dcim|pxl|photo|pic|picture|scan|capture)$/i;

/**
 * A capture's name from its photos' file names: the words they all share, in the first one's order
 * ("brick_left.png", "brick_top.png" give "Brick"), or "Captured material" when they share none that say
 * anything (numbers and a camera's words don't).
 */
export const captureName = (fileNames: readonly string[]): string => {
    const wordsOf = (name: string) => name.replace(/\.[^.]+$/, '').split(/[\s_.-]+/).filter((word) => word && !/^\d+$/.test(word) && !CAMERA_WORDS.test(word));
    const [first, ...rest] = fileNames.map(wordsOf);
    const shared = (first ?? []).filter((word) => rest.every((words) => words.some((other) => other.toLowerCase() === word.toLowerCase())));
    const name = shared.join(' ').trim();
    return name ? (name.charAt(0).toUpperCase() + name.slice(1)).slice(0, 120) : 'Captured material';
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
