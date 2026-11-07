import { createNode } from '../graph/document';
import type { GraphParameter, GraphParameterGroup, TexGraphLink, TexGraphNode, TextureGraph } from '../graph/types';

/**
 * PHOTO TO MATERIAL
 *
 * A photo of a surface made into a texture graph material, every step an ordinary node the user can
 * change: the picture (Bitmap), made to tile (Make it tile), its light and shadow taken out (Lighting
 * removal), its colours evened out (Colour equalizer). Height comes from the photo's brightness (turned
 * over when its bright parts are the low ones: Invert height): a smoothed, large-scale height gives the
 * occlusion and shading lighting removal takes out (soft, mostly near white, so dividing by it never
 * blows the colour out), and that height with its fine detail laid over gives the height and, lightly
 * smoothed so the photo's grain from pixel to pixel doesn't make it glitter, the normal.
 * Roughness comes from a curve of height and colour, squeezed to a range; metallic where the colour is
 * near a chosen one (none unless set). A Strength row of the graph's parameters sets how wide the tiling
 * joins may wander, how much lighting is taken out, how deep the height reads, which way it runs and the
 * roughness range; a Metal row picks the metal's colour and how near counts.
 */

const strength = 'Strength';
const metal = 'Metal';

export const PHOTO_PARAMETERS: readonly GraphParameter[] = [
    { name: 'tileWidth', label: 'Tiling width', kind: 'float', default: 0.2, min: 0.05, max: 0.45, step: 0.01, group: strength, description: 'How far into the photo the joins that make it tile may wander: wider finds better joins and replaces more of it.' },
    { name: 'lighting', label: 'Lighting removed', kind: 'float', default: 0.8, min: 0, max: 1, step: 0.01, group: strength, description: 'How much of the light and shadow photographed on the surface is taken out of its colour.' },
    { name: 'depth', label: 'Height depth', kind: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: strength, description: 'How deep the height worked out from the photo reads: its normal, its occlusion and the shading taken out.' },
    { name: 'invertHeight', label: 'Invert height', kind: 'bool', default: false, group: strength, description: 'Bright parts low, dark parts high: for light mortar or grout between darker stones and bricks. Set by a guess from the photo; flip it if the relief reads inside out.' },
    { name: 'roughLow', label: 'Roughness from', kind: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: strength, description: 'The roughness of the smoothest part.' },
    { name: 'roughHigh', label: 'Roughness to', kind: 'float', default: 0.85, min: 0, max: 1, step: 0.01, group: strength, description: 'The roughness of the roughest part.' },
    { name: 'metalColour', label: 'Metal colour', kind: 'color', default: [0.75, 0.75, 0.78, 1], group: metal, description: 'Parts of the photo near this colour are metal.' },
    { name: 'metalRange', label: 'How near counts', kind: 'float', default: 0, min: 0, max: 1, step: 0.01, group: metal, description: '0 makes nothing metal; higher takes in colours further from the metal colour.' },
];

export const PHOTO_GROUPS: readonly GraphParameterGroup[] = [
    { name: strength, description: 'How strongly each step works on the photo.' },
    { name: metal, description: 'Metallic where the photo shows a chosen colour (none unless set).', folded: true },
];

/**
 * A guess at whether a photo's bright parts are its low ones, from its brightness values (0 to 1): when
 * the brightest values are a small share (thin light lines, as mortar between darker bricks, pull the
 * mean above the middle value) they are crevices; when the darkest are (dark grout and cracks), dark is
 * low and brightness reads as height as it is.
 */
export const guessInvertHeight = (brightness: ArrayLike<number>): boolean => {
    if (!brightness.length) return false;
    const sorted = Float32Array.from(brightness).sort();
    const median = sorted[Math.floor(sorted.length / 2)];
    let mean = 0;
    for (let i = 0; i < sorted.length; i++) mean += sorted[i];
    mean /= sorted.length;
    const spread = Math.max(1e-3, sorted[Math.floor(sorted.length * 0.95)] - sorted[Math.floor(sorted.length * 0.05)]);
    return (mean - median) / spread > 0.04;
};

/** A texture graph making a material of the photo `textureId` (a project texture). */
export const photoMaterialGraph = (textureId: string, size = 10, options: { invertHeight?: boolean } = {}): TextureGraph => {
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
    // Height: the photo's brightness, turned over when bright is low.
    const brightness = add('grayscale', 480, 440, { mode: 'luminance' }, 'Brightness');
    wire(tiled, brightness);
    const source = add('levels', 720, 440, { outLow: formula('invertHeight'), outHigh: formula('1 - invertHeight') }, 'Height source');
    wire(brightness, source);
    // Large-scale height, the grain smoothed out: what the occlusion and shading taken out come from.
    const smooth = add('blur', 960, 640, { radius: 0.006 }, 'Large-scale height');
    wire(source, smooth);
    const occlusion = add('aoFromHeight', 1200, 640, { depth: formula('depth * 0.05'), radius: 0.02, intensity: 0.6 }, 'Occlusion');
    wire(smooth, occlusion);
    // The detailed height (fine detail laid over), for the normal and the height.
    const detail = add('highpass', 960, 440, { radius: 0.01 }, 'Fine detail');
    wire(source, detail);
    const height = add('blend', 1200, 440, { mode: 'overlay', opacity: 0.6 }, 'Height');
    wire(detail, height, 'foreground');
    wire(source, height, 'background');
    // Colour: lighting taken out, then evened out.
    const delit = add('lightingRemoval', 1440, 120, { occlusionAmount: formula('lighting * 0.5'), shadingAmount: bind('lighting'), depth: formula('depth * 0.05 + 0.005') }, 'Lighting removed');
    wire(tiled, delit);
    wire(occlusion, delit, 'occlusion');
    wire(smooth, delit, 'height');
    const colour = add('colourEqualizer', 1680, 120, {}, 'Colour evened out');
    wire(delit, colour);
    // The normal reads the detailed height lightly smoothed: brick-sized shapes and some grain, not the
    // photo's noise from pixel to pixel, which would make it glitter. Slopes are per metre of the graph's
    // size in the world, so a strength of a few gives gentle bumps.
    const smoothed = add('blur', 1440, 440, { radius: 0.006 }, 'Smoothed height');
    wire(height, smoothed);
    const normal = add('normalFromHeight', 1680, 440, { intensity: formula('depth * 6') }, 'Normal');
    wire(smoothed, normal);
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
        parameters: PHOTO_PARAMETERS.map((parameter) => (parameter.name === 'invertHeight' && options.invertHeight !== undefined ? { ...parameter, default: options.invertHeight } : structuredClone(parameter) as GraphParameter)),
        groups: PHOTO_GROUPS.map((group) => ({ ...group })),
        tiling: 'both',
    };
};

/** A material's name from a photo's file name: its words, without the extension or separators. */
export const photoMaterialName = (fileName: string): string => {
    const words = fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return (words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Photo').slice(0, 120);
};
