import { createNode, normalizeTextureGraph } from '../graph/document';
import type { GraphEntry } from '../graph/registry';
import type { GraphParameter, TexGraphLink, TexGraphNode, TextureGraph } from '../graph/types';
import { channelsOf, newFillLayer, newFolder, paintId, type MaskEffect, type PaintChannel, type PaintDocument, type PaintLayer } from './paintTypes';

/**
 * SMART MASKS AND SMART MATERIALS
 *
 * Built-in texture graphs that read a painted model's baked maps (curvature, occlusion, world normal,
 * position) and 3D noise, so they follow the shape of whatever they are put on and run across UV seams
 * unbroken; and layer stacks made from them: worn paint over metal, rust, grime, dust. They are plain
 * graphs, editable like any other, and a project's own texture graphs can be used the same way.
 */

export const BUILTIN_PREFIX = 'builtin:';

type Spec = { id: string; type: string; params?: Record<string, unknown> };

/** A graph from nodes laid out left to right and wires written as [from, to, input?, output?]. */
const graphOf = (specs: Spec[], wires: Array<[string, string, string?, string?]>, parameters: GraphParameter[] = []): TextureGraph => {
    const nodes: TexGraphNode[] = specs.map((spec, index) => ({ ...createNode(spec.type, 40 + (index % 5) * 220, 40 + Math.floor(index / 5) * 200, spec.params ?? {}), id: spec.id }));
    const links: TexGraphLink[] = wires.map(([from, to, input = 'in', output = 'out']) => ({ from, fromOutput: output, to, toInput: input }));
    return normalizeTextureGraph({ version: 1, size: { w: 11, h: 11 }, seed: 0, nodes, links, parameters });
};

const amount = (label = 'Amount', value = 0.5): GraphParameter => ({ name: 'amount', label, kind: 'float', default: value, min: 0, max: 1 });
const sharpness = (value = 0.6): GraphParameter => ({ name: 'sharpness', label: 'Sharpness', kind: 'float', default: value, min: 0, max: 1 });
const breakup = (value = 0.5): GraphParameter => ({ name: 'breakup', label: 'Break-up', kind: 'float', default: value, min: 0, max: 1 });
const scale = (value = 12): GraphParameter => ({ name: 'scale', label: 'Noise scale', kind: 'float', default: value, min: 1, max: 60 });

const MASK_OUT = { channel: 'custom', name: 'Mask' };

const BUILTINS: Array<{ id: string; name: string; graph: TextureGraph }> = [
    {
        id: `${BUILTIN_PREFIX}edgeWear`,
        name: 'Edge wear',
        graph: graphOf([
            { id: 'curv', type: 'meshMap', params: { map: 'curvature' } },
            { id: 'pos', type: 'meshMap', params: { map: 'position' } },
            { id: 'noise', type: 'noise3d', params: { scale: { $bind: 'scale' }, octaves: 6, roughness: 0.6, contrast: 1.4 } },
            { id: 'edges', type: 'levels', params: { inLow: 0.56, inHigh: 0.78 } },
            { id: 'mix', type: 'blend', params: { mode: 'subtract', opacity: { $bind: 'breakup' } } },
            { id: 'scan', type: 'histogramScan', params: { position: { $bind: 'amount' }, contrast: { $bind: 'sharpness' } } },
            { id: 'out', type: 'output', params: MASK_OUT },
        ], [['curv', 'edges'], ['pos', 'noise', 'position'], ['noise', 'mix', 'foreground'], ['edges', 'mix', 'background'], ['mix', 'scan'], ['scan', 'out']],
        [amount('Wear', 0.55), sharpness(0.75), breakup(0.55), scale(14)]),
    },
    {
        id: `${BUILTIN_PREFIX}cavityDirt`,
        name: 'Dirt in crevices',
        graph: graphOf([
            { id: 'ao', type: 'meshMap', params: { map: 'ambientOcclusion' } },
            { id: 'curv', type: 'meshMap', params: { map: 'curvature' } },
            { id: 'pos', type: 'meshMap', params: { map: 'position' } },
            { id: 'aoLevels', type: 'levels', params: { inLow: 0.45, inHigh: 0.98 } },
            { id: 'aoInv', type: 'invert' },
            { id: 'cavity', type: 'levels', params: { inLow: 0.3, inHigh: 0.5 } },
            { id: 'cavityInv', type: 'invert' },
            { id: 'both', type: 'blend', params: { mode: 'lighten' } },
            { id: 'noise', type: 'noise3d', params: { scale: { $bind: 'scale' }, octaves: 5, contrast: 1.3 } },
            { id: 'mix', type: 'blend', params: { mode: 'subtract', opacity: { $bind: 'breakup' } } },
            { id: 'scan', type: 'histogramScan', params: { position: { $bind: 'amount' }, contrast: { $bind: 'sharpness' } } },
            { id: 'out', type: 'output', params: MASK_OUT },
        ], [['ao', 'aoLevels'], ['aoLevels', 'aoInv'], ['curv', 'cavity'], ['cavity', 'cavityInv'], ['aoInv', 'both', 'foreground'], ['cavityInv', 'both', 'background'], ['pos', 'noise', 'position'], ['noise', 'mix', 'foreground'], ['both', 'mix', 'background'], ['mix', 'scan'], ['scan', 'out']],
        [amount('Dirt', 0.55), sharpness(0.45), breakup(0.45), scale(10)]),
    },
    {
        id: `${BUILTIN_PREFIX}dust`,
        name: 'Dust from above',
        graph: graphOf([
            { id: 'up', type: 'directionMask', params: { direction: 'up', spread: 0.55, contrast: 0.4 } },
            { id: 'ao', type: 'meshMap', params: { map: 'ambientOcclusion' } },
            { id: 'pos', type: 'meshMap', params: { map: 'position' } },
            { id: 'noise', type: 'noise3d', params: { scale: { $bind: 'scale' }, octaves: 6, roughness: 0.65 } },
            { id: 'open', type: 'blend', params: { mode: 'multiply', opacity: 0.6 } },
            { id: 'mix', type: 'blend', params: { mode: 'multiply', opacity: { $bind: 'breakup' } } },
            { id: 'scan', type: 'histogramScan', params: { position: { $bind: 'amount' }, contrast: 0.3 } },
            { id: 'out', type: 'output', params: MASK_OUT },
        ], [['ao', 'open', 'foreground'], ['up', 'open', 'background'], ['pos', 'noise', 'position'], ['noise', 'mix', 'foreground'], ['open', 'mix', 'background'], ['mix', 'scan'], ['scan', 'out']],
        [amount('Dust', 0.5), breakup(0.7), scale(18)]),
    },
    {
        id: `${BUILTIN_PREFIX}grimeBelow`,
        name: 'Grime from below',
        graph: graphOf([
            { id: 'grad', type: 'axisGradient', params: { axis: 'y', position: { $bind: 'amount' }, width: 0.45, invert: 'bottom' } },
            { id: 'pos', type: 'meshMap', params: { map: 'position' } },
            { id: 'noise', type: 'noise3d', params: { scale: { $bind: 'scale' }, octaves: 6, style: 'turbulence' } },
            { id: 'mix', type: 'blend', params: { mode: 'multiply', opacity: { $bind: 'breakup' } } },
            { id: 'out', type: 'output', params: MASK_OUT },
        ], [['pos', 'noise', 'position'], ['noise', 'mix', 'foreground'], ['grad', 'mix', 'background'], ['mix', 'out']],
        [amount('Height reached', 0.3), breakup(0.6), scale(8)]),
    },
    {
        id: `${BUILTIN_PREFIX}rustSpots`,
        name: 'Rust patches',
        graph: graphOf([
            { id: 'pos', type: 'meshMap', params: { map: 'position' } },
            { id: 'big', type: 'noise3d', params: { scale: { $bind: 'scale' }, octaves: 5, style: 'fbm', contrast: 1.6 } },
            { id: 'fine', type: 'noise3d', params: { scale: 60, octaves: 4, seed: 3 } },
            { id: 'ao', type: 'meshMap', params: { map: 'ambientOcclusion' } },
            { id: 'aoInv', type: 'invert' },
            { id: 'base', type: 'blend', params: { mode: 'linearLight', opacity: 0.35 } },
            { id: 'grain', type: 'blend', params: { mode: 'overlay', opacity: 0.6 } },
            { id: 'scan', type: 'histogramScan', params: { position: { $bind: 'amount' }, contrast: 0.55 } },
            { id: 'out', type: 'output', params: MASK_OUT },
        ], [['pos', 'big', 'position'], ['pos', 'fine', 'position'], ['ao', 'aoInv'], ['aoInv', 'base', 'foreground'], ['big', 'base', 'background'], ['fine', 'grain', 'foreground'], ['base', 'grain', 'background'], ['grain', 'scan'], ['scan', 'out']],
        [amount('Rust', 0.45), scale(4)]),
    },
    {
        id: `${BUILTIN_PREFIX}scratches`,
        name: 'Scratches',
        graph: graphOf([
            { id: 'lines', type: 'scratches', params: { density: 10, perCell: 4, length: 0.8, width: 0.006, angleRandom: 0.8 } },
            { id: 'tri', type: 'triplanar', params: { scale: { $bind: 'scale' }, sharpness: 6 } },
            { id: 'scan', type: 'histogramScan', params: { position: { $bind: 'amount' }, contrast: 0.7 } },
            { id: 'out', type: 'output', params: MASK_OUT },
        ], [['lines', 'tri', 'pattern'], ['tri', 'scan'], ['scan', 'out']],
        [amount('Scratches', 0.5), scale(3)]),
    },
    {
        id: `${BUILTIN_PREFIX}leatherGrain`,
        name: 'Leather grain',
        graph: graphOf([
            { id: 'cells', type: 'cells', params: { scale: 24, mode: 'f1inv', contrast: 1.4 } },
            { id: 'tri', type: 'triplanar', params: { scale: { $bind: 'scale' }, sharpness: 5 } },
            { id: 'normal', type: 'normalFromHeight', params: { intensity: 2 } },
            { id: 'rough', type: 'levels', params: { outLow: 0.55, outHigh: 0.8 } },
            { id: 'outH', type: 'output', params: { channel: 'height', name: '' } },
            { id: 'outN', type: 'output', params: { channel: 'normal', name: '' } },
            { id: 'outR', type: 'output', params: { channel: 'roughness', name: '' } },
        ], [['cells', 'tri', 'pattern'], ['tri', 'normal'], ['tri', 'rough'], ['tri', 'outH'], ['normal', 'outN'], ['rough', 'outR']],
        [scale(6)]),
    },
];

export const BUILTIN_GRAPHS: ReadonlyMap<string, GraphEntry> = new Map(BUILTINS.map((entry) => [entry.id, entry]));

/** Built-in smart masks: generators to put on a layer's mask. */
export const SMART_MASKS: ReadonlyArray<{ id: string; name: string; description: string }> = [
    { id: `${BUILTIN_PREFIX}edgeWear`, name: 'Edge wear', description: 'Raised edges and corners, broken up with noise: where paint rubs off.' },
    { id: `${BUILTIN_PREFIX}cavityDirt`, name: 'Dirt in crevices', description: 'Creases, corners and hollows, where dirt gathers.' },
    { id: `${BUILTIN_PREFIX}dust`, name: 'Dust from above', description: 'Surfaces facing up and open to the sky.' },
    { id: `${BUILTIN_PREFIX}grimeBelow`, name: 'Grime from below', description: 'Rising from the bottom of the model, patchy.' },
    { id: `${BUILTIN_PREFIX}rustSpots`, name: 'Rust patches', description: 'Patches that favour sheltered places.' },
    { id: `${BUILTIN_PREFIX}scratches`, name: 'Scratches', description: 'Fine scratches in every direction, laid on without seams.' },
];

export const generatorEffect = (graphId: string, values: Record<string, unknown> = {}, invert = false): MaskEffect[] => {
    const effects: MaskEffect[] = [{ id: paintId('m'), kind: 'generator', enabled: true, blend: 'replace', opacity: 1, graphId, output: 'custom', values }];
    if (invert) effects.push({ id: paintId('m'), kind: 'invert', enabled: true, blend: 'replace', opacity: 1 });
    return effects;
};

const fill = (document: PaintDocument, name: string, values: Partial<Record<PaintChannel, [number, number, number]>>, mask?: MaskEffect[]): PaintLayer => {
    const layer = newFillLayer(document, name, Object.fromEntries(Object.entries(values).map(([channel, value]) => [channel, { kind: 'value', value }])));
    return mask ? { ...layer, mask } : layer;
};

const gray = (v: number): [number, number, number] => [v, v, v];

/** Built-in smart materials: folders of fill layers masked by smart masks. */
export const SMART_MATERIALS: ReadonlyArray<{ id: string; name: string; description: string; swatch: string; build: (document: PaintDocument) => PaintLayer }> = [
    {
        id: 'paintedMetal',
        name: 'Worn painted metal',
        description: 'Painted steel with the paint worn off its edges and dirt in its creases.',
        swatch: '#5b6b4c',
        build: (document) => newFolder('Worn painted metal', [
            fill(document, 'Bare steel', { baseColor: [0.56, 0.57, 0.58], roughness: gray(0.32), metallic: gray(1) }),
            fill(document, 'Paint', { baseColor: [0.29, 0.36, 0.22], roughness: gray(0.55), metallic: gray(0) }, generatorEffect(`${BUILTIN_PREFIX}edgeWear`, {}, true)),
            fill(document, 'Grime', { baseColor: [0.12, 0.1, 0.08], roughness: gray(0.85) }, generatorEffect(`${BUILTIN_PREFIX}cavityDirt`, { amount: 0.45 })),
        ]),
    },
    {
        id: 'rustyIron',
        name: 'Rusty iron',
        description: 'Dark iron with rust spreading through sheltered places and bright worn edges.',
        swatch: '#7a3f1d',
        build: (document) => newFolder('Rusty iron', [
            fill(document, 'Iron', { baseColor: [0.32, 0.31, 0.3], roughness: gray(0.5), metallic: gray(1) }),
            fill(document, 'Rust', { baseColor: [0.42, 0.19, 0.08], roughness: gray(0.9), metallic: gray(0), height: gray(0.56) }, generatorEffect(`${BUILTIN_PREFIX}rustSpots`)),
            fill(document, 'Polished edges', { baseColor: [0.62, 0.62, 0.62], roughness: gray(0.25), metallic: gray(1) }, generatorEffect(`${BUILTIN_PREFIX}edgeWear`, { amount: 0.25, sharpness: 0.85 })),
        ]),
    },
    {
        id: 'wornPlastic',
        name: 'Scuffed plastic',
        description: 'Matte plastic, scuffed lighter on its edges, dusty on top.',
        swatch: '#26282b',
        build: (document) => newFolder('Scuffed plastic', [
            fill(document, 'Plastic', { baseColor: [0.11, 0.115, 0.12], roughness: gray(0.62), metallic: gray(0) }),
            fill(document, 'Scuffs', { baseColor: [0.24, 0.24, 0.25], roughness: gray(0.78) }, generatorEffect(`${BUILTIN_PREFIX}edgeWear`, { amount: 0.35, breakup: 0.8 })),
            fill(document, 'Scratches', { baseColor: [0.32, 0.32, 0.33], roughness: gray(0.45) }, generatorEffect(`${BUILTIN_PREFIX}scratches`, { amount: 0.6 })),
            fill(document, 'Dust', { baseColor: [0.45, 0.42, 0.38], roughness: gray(0.95) }, generatorEffect(`${BUILTIN_PREFIX}dust`, { amount: 0.55 })),
        ]),
    },
    {
        id: 'leather',
        name: 'Aged leather',
        description: 'Brown leather with a pebbled grain, darker in creases and rubbed paler on edges.',
        swatch: '#5a3420',
        build: (document) => {
            const grain = newFillLayer(document, 'Leather', {
                baseColor: { kind: 'value', value: [0.3, 0.17, 0.1] },
                roughness: { kind: 'graph', graphId: `${BUILTIN_PREFIX}leatherGrain`, output: 'roughness', values: {} },
                height: { kind: 'graph', graphId: `${BUILTIN_PREFIX}leatherGrain`, output: 'height', values: {} },
                metallic: { kind: 'value', value: [0, 0, 0] },
            });
            return newFolder('Aged leather', [
                grain,
                fill(document, 'Creases', { baseColor: [0.14, 0.08, 0.05] }, generatorEffect(`${BUILTIN_PREFIX}cavityDirt`, { amount: 0.55 })),
                fill(document, 'Rubbed edges', { baseColor: [0.45, 0.3, 0.2], roughness: gray(0.45) }, generatorEffect(`${BUILTIN_PREFIX}edgeWear`, { amount: 0.3 })),
            ]);
        },
    },
    {
        id: 'grimeOnly',
        name: 'Grime and dust',
        description: 'Dirt in the crevices, grime rising from below and dust on top, over whatever is beneath.',
        swatch: '#4a4237',
        build: (document) => newFolder('Grime and dust', [
            fill(document, 'Crevice dirt', { baseColor: [0.1, 0.085, 0.07], roughness: gray(0.9) }, generatorEffect(`${BUILTIN_PREFIX}cavityDirt`)),
            fill(document, 'Grime', { baseColor: [0.16, 0.13, 0.1], roughness: gray(0.85) }, generatorEffect(`${BUILTIN_PREFIX}grimeBelow`)),
            fill(document, 'Dust', { baseColor: [0.5, 0.47, 0.42], roughness: gray(0.95) }, generatorEffect(`${BUILTIN_PREFIX}dust`)),
        ]),
    },
];

/** A layer drawing every channel output of a texture graph material, with this surface's mesh maps. */
export const graphMaterialLayer = (document: PaintDocument, graphId: string, name: string, graph: TextureGraph): PaintLayer => {
    const fills: PaintLayer['fill'] = {};
    for (const node of graph.nodes) {
        if (node.type !== 'output') continue;
        const channel = node.params.channel as string;
        const target = channel === 'baseColor' || channel === 'roughness' || channel === 'metallic' || channel === 'height' || channel === 'normal' || channel === 'emissive' || channel === 'opacity' ? channel as PaintChannel : null;
        if (target && document.channels.includes(target) && !fills[target]) fills[target] = { kind: 'graph', graphId, output: channel, values: {} };
    }
    return { id: paintId('l'), name, kind: 'fill', visible: true, channels: channelsOf(document, Object.keys(fills) as PaintChannel[]), fill: fills, from: name };
};
