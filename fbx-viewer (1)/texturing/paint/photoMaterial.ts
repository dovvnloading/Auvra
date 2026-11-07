import { createNode } from '../graph/document';
import type { GraphParameter, GraphParameterGroup, TexGraphLink, TexGraphNode, TextureGraph } from '../graph/types';

/**
 * PHOTO TO MATERIAL
 *
 * A photo of a surface made into a texture graph material, every step an ordinary node the user can
 * change: the picture (Bitmap), made to tile (Make it tile), its light and shadow taken out (Lighting
 * removal, from the height and occlusion worked out here), its colours evened out (Colour equalizer);
 * height from the photo's brightness with its fine detail laid over; normal and occlusion from the
 * height; roughness from a curve of height and colour, squeezed to a range; metallic where the colour
 * is near a chosen one (none unless set). A Strength row of the graph's parameters sets how wide the
 * tiling joins may wander, how much lighting is taken out, how deep the height reads and the roughness
 * range; a Metal row picks the metal's colour and how near counts.
 */

const strength = 'Strength';
const metal = 'Metal';

export const PHOTO_PARAMETERS: readonly GraphParameter[] = [
    { name: 'tileWidth', label: 'Tiling width', kind: 'float', default: 0.2, min: 0.05, max: 0.45, step: 0.01, group: strength, description: 'How far into the photo the joins that make it tile may wander: wider finds better joins and replaces more of it.' },
    { name: 'lighting', label: 'Lighting removed', kind: 'float', default: 0.8, min: 0, max: 1, step: 0.01, group: strength, description: 'How much of the light and shadow photographed on the surface is taken out of its colour.' },
    { name: 'depth', label: 'Height depth', kind: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: strength, description: 'How deep the height worked out from the photo reads: its normal, its occlusion and the shading taken out.' },
    { name: 'roughLow', label: 'Roughness from', kind: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: strength, description: 'The roughness of the smoothest part.' },
    { name: 'roughHigh', label: 'Roughness to', kind: 'float', default: 0.85, min: 0, max: 1, step: 0.01, group: strength, description: 'The roughness of the roughest part.' },
    { name: 'metalColour', label: 'Metal colour', kind: 'color', default: [0.75, 0.75, 0.78, 1], group: metal, description: 'Parts of the photo near this colour are metal.' },
    { name: 'metalRange', label: 'How near counts', kind: 'float', default: 0, min: 0, max: 1, step: 0.01, group: metal, description: '0 makes nothing metal; higher takes in colours further from the metal colour.' },
];

export const PHOTO_GROUPS: readonly GraphParameterGroup[] = [
    { name: strength, description: 'How strongly each step works on the photo.' },
    { name: metal, description: 'Metallic where the photo shows a chosen colour (none unless set).', folded: true },
];

/** A texture graph making a material of the photo `textureId` (a project texture). */
export const photoMaterialGraph = (textureId: string, size = 10): TextureGraph => {
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
    const formula = (text: string) => ({ $expr: text });

    const photo = add('bitmap', 0, 200, { texture: textureId, fit: 'fill' }, 'Photo');
    const tiled = add('makeTile', 240, 200, { width: bind('tileWidth') }, 'Made to tile');
    wire(photo, tiled);
    // Height: the photo's brightness, its fine detail laid over.
    const brightness = add('grayscale', 480, 440, { mode: 'luminance' }, 'Brightness');
    wire(tiled, brightness);
    const detail = add('highpass', 720, 520, { radius: 0.01 }, 'Fine detail');
    wire(brightness, detail);
    const height = add('blend', 960, 440, { mode: 'overlay', opacity: 0.6 }, 'Height');
    wire(detail, height, 'foreground');
    wire(brightness, height, 'background');
    const occlusion = add('aoFromHeight', 1200, 600, { depth: formula('depth * 0.25'), radius: 0.03 }, 'Occlusion');
    wire(height, occlusion);
    // Colour: lighting taken out, then evened out.
    const delit = add('lightingRemoval', 1440, 120, { occlusionAmount: bind('lighting'), shadingAmount: bind('lighting'), depth: formula('depth * 0.1 + 0.005') }, 'Lighting removed');
    wire(tiled, delit);
    wire(occlusion, delit, 'occlusion');
    wire(height, delit, 'height');
    const colour = add('colourEqualizer', 1680, 120, {}, 'Colour evened out');
    wire(delit, colour);
    const normal = add('normalFromHeight', 1440, 440, { intensity: formula('depth * 16') }, 'Normal');
    wire(height, normal);
    // Roughness: a curve of the height and the colour's brightness, squeezed to its range.
    const tone = add('grayscale', 1920, 300, { mode: 'luminance' }, 'Colour brightness');
    wire(colour, tone);
    const mixed = add('blend', 2160, 300, { mode: 'multiply', opacity: 0.5 }, 'Height and colour');
    wire(height, mixed, 'foreground');
    wire(tone, mixed, 'background');
    const curve = add('curves', 2400, 300, {}, 'Roughness curve');
    wire(mixed, curve);
    const roughness = add('levels', 2640, 300, { outLow: bind('roughLow'), outHigh: bind('roughHigh') }, 'Roughness range');
    wire(curve, roughness);
    // Metallic: where the colour is near the metal colour.
    const metallic = add('colorToMask', 1920, 560, { color: bind('metalColour'), range: bind('metalRange'), softness: 0.05 }, 'Metal by colour');
    wire(colour, metallic);
    const output = (channel: string, from: TexGraphNode, y: number) => wire(from, add('output', 2900, y, { channel }));
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
        parameters: PHOTO_PARAMETERS.map((parameter) => structuredClone(parameter) as GraphParameter),
        groups: PHOTO_GROUPS.map((group) => ({ ...group })),
        tiling: 'both',
    };
};

/** A material's name from a photo's file name: its words, without the extension or separators. */
export const photoMaterialName = (fileName: string): string => {
    const words = fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return (words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Photo').slice(0, 120);
};
