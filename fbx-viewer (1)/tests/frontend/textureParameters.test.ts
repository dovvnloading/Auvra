import { describe, expect, it } from 'vitest';
import { createNode, createTextureGraph, formulaScope, normalizeTextureGraph } from '../../texturing/graph/document';
import { INPUT_NODE_TYPE, OUTPUT_NODE_TYPE, SUBGRAPH_NODE_TYPE } from '../../texturing/graph/nodes/io';
import {
    applyPreset,
    conditionError,
    conditionHolds,
    conditionScope,
    formatCondition,
    groupByLabelPrefix,
    hasLabelPrefixes,
    matchesPreset,
    parameterSections,
    parameterSetting,
    parseCondition,
    presetFrom,
    putPreset,
    removePreset,
    renamePreset,
    variationSeeds,
    variationValues,
    visibleParameters,
} from '../../texturing/graph/parameters';
import { textureNodeDefinition } from '../../texturing/graph/registry';
import { withParameterPictures } from '../../texturing/graph/stored';
import type { GraphParameter, TextureGraph } from '../../texturing/graph/types';
import { readSharedPresets, sharedPresetsDocument } from '../../components/Texturing/projectPresets';
import { allCellsSame, pictureFingerprint } from '../../components/Texturing/VariationSheet';

const parameters: GraphParameter[] = [
    { name: 'pattern', label: 'Pattern', kind: 'select', default: 'bricks', options: [{ value: 'tiles', label: 'Tiles' }, { value: 'bricks', label: 'Bricks' }, { value: 'planks', label: 'Planks' }] },
    { name: 'mortar', label: 'Mortar width', kind: 'float', default: 0.1, min: 0, max: 1, softMin: 0.02, softMax: 0.4, step: 0.01, group: 'Mortar', visibleIf: 'pattern != 2' },
    { name: 'dirty', label: 'Dirty', kind: 'bool', default: false, group: 'Wear' },
    { name: 'dirt', label: 'Dirt amount', kind: 'float', default: 0.5, min: 0, max: 1, group: 'Wear', visibleIf: 'dirty', description: 'How much dirt settles in the gaps.' },
    { name: 'tint', label: 'Tint', kind: 'color', default: [0.8, 0.3, 0.2, 1] },
    { name: 'gradient', label: 'Gradient', kind: 'ramp', default: { stops: [{ position: 0, color: [0, 0, 0, 1] }, { position: 1, color: [1, 1, 1, 1] }] } },
    { name: 'stamp', label: 'Stamp', kind: 'texture', default: 'tex-default' },
    { name: 'caption', label: 'Caption', kind: 'string', default: 'Hello' },
    { name: 'typeface', label: 'Font', kind: 'font', default: 'serif' },
];

describe('show and hide conditions', () => {
    it('show a parameter only while its condition of the others holds', () => {
        expect([...visibleParameters(parameters, {})]).toEqual(['pattern', 'mortar', 'dirty', 'tint', 'gradient', 'stamp', 'caption', 'typeface']);
        const planks = visibleParameters(parameters, { pattern: 'planks', dirty: true });
        expect(planks.has('mortar')).toBe(false);
        expect(planks.has('dirt')).toBe(true);
        // A choice reads as its option's place, a switch as 1 or 0.
        expect(conditionScope(parameters, { pattern: 'planks', dirty: true })).toMatchObject({ pattern: 2, dirty: 1 });
        // Pictures, text and fonts are no numbers.
        expect(conditionScope(parameters, {})).not.toHaveProperty('caption');
    });

    it('keep showing what a broken condition would hide, and say what is wrong', () => {
        expect(conditionHolds('nonsense ++', {})).toBe(true);
        expect(conditionHolds('', {})).toBe(true);
        expect(conditionHolds('a > 1', { a: 0.5 })).toBe(false);
        expect(conditionError('pattern == 1', parameters, 'mortar')).toBeNull();
        expect(conditionError('caption == 1', parameters, 'mortar')).toMatch(/caption/);
        expect(conditionError('mortar > 0', parameters, 'mortar')).toMatch(/own value/);
    });

    it('build and read back simple conditions', () => {
        expect(parseCondition('dirt >= 0.5')).toEqual({ name: 'dirt', test: '>=', value: 0.5 });
        expect(parseCondition('dirt > 0.5 && dirty')).toBeNull();
        expect(formatCondition({ name: 'pattern', test: '!=', value: 2 })).toBe('pattern != 2');
    });

    it('hide a node setting and a used graph\'s pins the same way', () => {
        const mortar = parameterSetting(parameters[1], parameters);
        expect(mortar).toMatchObject({ softMin: 0.02, softMax: 0.4, min: 0, max: 1, step: 0.01, group: 'Mortar' });
        expect(mortar.showIf!({ pattern: 'tiles' })).toBe(true);
        expect(mortar.showIf!({ pattern: 'planks' })).toBe(false);
        expect(parameterSetting(parameters[3], parameters).hint).toBe('How much dirt settles in the gaps.');
        // A graph whose mask input shows only while "dirty" is on.
        const inner: TextureGraph = { ...createTextureGraph(), parameters, nodes: [
            createNode(INPUT_NODE_TYPE, 0, 0, { name: 'mask', visibleIf: 'dirty' }),
            createNode(OUTPUT_NODE_TYPE, 300, 0, { channel: 'custom', name: 'Grime', visibleIf: 'dirty == 1' }),
            createNode(OUTPUT_NODE_TYPE, 300, 200, { channel: 'baseColor' }),
        ], links: [] };
        const resolve = (id: string) => (id === 'g' ? { id: 'g', name: 'Bricks', graph: inner } : undefined);
        const off = textureNodeDefinition(createNode(SUBGRAPH_NODE_TYPE, 0, 0, { graph: 'g', dirty: false }), resolve)!;
        expect(off.inputs[0].hidden).toBe(true);
        expect(off.outputs.map((port) => Boolean(port.hidden))).toEqual([true, false]);
        const on = textureNodeDefinition(createNode(SUBGRAPH_NODE_TYPE, 0, 0, { graph: 'g', dirty: true }), resolve)!;
        expect(on.inputs[0].hidden).toBeUndefined();
        expect(on.params.find((param) => param.key === 'dirt')?.showIf?.({ dirty: true })).toBe(true);
    });
});

describe('parameters at full depth', () => {
    it('keep groups, words, ranges, conditions and every kind through saving', () => {
        const graph = normalizeTextureGraph({ ...createTextureGraph(), parameters, groups: [{ name: 'Wear', description: 'Dirt and chips.', folded: true }, { name: 'Unused' }] });
        expect(graph.parameters.map((parameter) => parameter.kind)).toEqual(['select', 'float', 'bool', 'float', 'color', 'ramp', 'texture', 'string', 'font']);
        expect(graph.parameters[1]).toMatchObject({ softMin: 0.02, softMax: 0.4, visibleIf: 'pattern != 2', group: 'Mortar' });
        expect(graph.groups).toEqual([{ name: 'Wear', description: 'Dirt and chips.', folded: true }]);
        // Soft ends stay inside the hard limits.
        const squeezed = normalizeTextureGraph({ ...createTextureGraph(), parameters: [{ name: 'a', label: 'A', kind: 'float', default: 0, min: 0, max: 1, softMin: -5, softMax: 9 }] });
        expect(squeezed.parameters[0]).toMatchObject({ softMin: 0, softMax: 1 });
        // Formulas read numbers only.
        const scope = formulaScope(graph, { caption: 'words' }, 1024, 1024);
        expect(scope).toHaveProperty('pattern', 1);
        expect(scope).not.toHaveProperty('caption');
    });

    it('lists the parameters under their groups, those in none first', () => {
        const sections = parameterSections(parameters, [{ name: 'Wear', description: 'Dirt.' }]);
        expect(sections.map((section) => section.group?.name ?? null)).toEqual([null, 'Wear', 'Mortar']);
        expect(sections[1].group?.description).toBe('Dirt.');
        expect(sections[0].parameters.map((parameter) => parameter.name)).toEqual(['pattern', 'tint', 'gradient', 'stamp', 'caption', 'typeface']);
    });

    it('keeps the pictures picture parameters name where the project looks for them', () => {
        const graph: TextureGraph = { ...createTextureGraph(), parameters, presets: [{ id: 'p1', name: 'Rough', values: { stamp: 'tex-preset' } }] };
        const kept = withParameterPictures({ graph, values: { stamp: 'tex-chosen' }, bakeSize: 11, layout: 'engine' });
        expect(Object.values(kept.textures ?? {}).sort()).toEqual(['tex-chosen', 'tex-default', 'tex-preset']);
    });
});

describe('presets', () => {
    it('round trip: saved values come back on applying, through saving the graph', () => {
        const values = { pattern: 'planks', mortar: 0.25, dirty: true, dirt: 0.8, tint: [0.1, 0.2, 0.3, 1], caption: 'Bye', typeface: 'monospace' };
        const preset = presetFrom('Worn planks', parameters, values, 42);
        expect(preset.seed).toBe(42);
        expect(matchesPreset(preset, parameters, values)).toBe(true);
        const saved = normalizeTextureGraph({ ...createTextureGraph(), parameters, presets: [preset] });
        expect(saved.presets).toHaveLength(1);
        const applied = applyPreset(saved.presets![0], saved.parameters, { pattern: 'tiles', mortar: 0.9 });
        expect(applied).toMatchObject(values);
        expect(matchesPreset(saved.presets![0], saved.parameters, applied)).toBe(true);
        expect(matchesPreset(saved.presets![0], saved.parameters, { ...applied, dirt: 0.1 })).toBe(false);
    });

    it('apply only what the graph has, inside its limits; rename, replace and delete', () => {
        const preset = { id: 'x', name: 'Odd', values: { mortar: 7, gone: 3, pattern: 'nonsense' } };
        const applied = applyPreset(preset, parameters, {});
        expect(applied.mortar).toBe(1);
        expect(applied).not.toHaveProperty('gone');
        expect(applied.pattern).toBe('tiles');
        let list = putPreset([], preset);
        list = renamePreset(list, 'x', '  Better  ');
        expect(list[0].name).toBe('Better');
        list = putPreset(list, { ...list[0], values: { mortar: 0.2 } });
        expect(list).toHaveLength(1);
        expect(list[0].values).toEqual({ mortar: 0.2 });
        expect(removePreset(list, 'x')).toEqual([]);
        // Saving keeps only values the graph's parameters can hold.
        expect(normalizeTextureGraph({ ...createTextureGraph(), parameters, presets: [preset] }).presets![0].values).toEqual({ mortar: 7, pattern: 'tiles' });
    });

    it('shared in the project: kept in one metadata document, read back the same', () => {
        const shared = [{ ...presetFrom('Clean', parameters, {}), graphId: 'bricks' }, { ...presetFrom('Moss', parameters, { tint: [0, 1, 0, 1] }), graphId: 'stone' }];
        const document = sharedPresetsDocument(shared);
        expect(document.id).toBe('texture-graph-presets');
        expect(Object.keys(document).sort()).toEqual(['id', 'name', 'settings']);
        const back = readSharedPresets(JSON.parse(JSON.stringify((document.settings as { presets: unknown }).presets)));
        expect(back).toEqual(shared);
        expect(readSharedPresets([{ id: 'a' }, null, { id: 'b', graphId: 'g', name: '', values: 3 }])).toEqual([{ id: 'b', graphId: 'g', name: 'Preset', values: {} }]);
    });
});

describe('variation sheets', () => {
    it('spread a number over its slider, give each option, both switch ways and distinct seeds', () => {
        expect(variationValues(parameters[1], 5)).toEqual([0.02, 0.115, 0.21, 0.305, 0.4]);
        expect(variationValues({ name: 'n', label: 'N', kind: 'int', default: 1, min: 1, max: 3 }, 9)).toEqual([1, 2, 3]);
        expect(variationValues(parameters[0], 9)).toEqual(['tiles', 'bricks', 'planks']);
        expect(variationValues(parameters[2], 9)).toEqual([false, true]);
        expect(variationValues(parameters[6], 9)).toEqual([]);
        const colours = variationValues(parameters[4], 4, [0.8, 0.3, 0.2, 1]) as number[][];
        expect(colours).toHaveLength(4);
        expect(colours[0].map((part) => Number(part.toFixed(3)))).toEqual([0.8, 0.3, 0.2, 1]);
        expect(new Set(colours.map((colour) => colour.slice(0, 3).map((part) => part.toFixed(2)).join())).size).toBe(4);
        const seeds = variationSeeds(5, 16);
        expect(seeds[0]).toBe(5);
        expect(new Set(seeds).size).toBe(16);
        expect(seeds.every((seed) => seed >= 0 && seed < 1000)).toBe(true);
    });
});

describe('long labels and sheets with no effect', () => {
    it('puts "Layer: name" parameters under a group named after the layer', () => {
        const made: GraphParameter[] = [
            { name: 'a', label: 'Polished edges: Sharpness', kind: 'float', default: 1 },
            { name: 'b', label: 'Iron: Noise scale', kind: 'float', default: 1 },
            { name: 'c', label: 'Ratio 2:1', kind: 'float', default: 1 },
            { name: 'd', label: 'Kept: as is', kind: 'float', default: 1, group: 'Mine' },
        ];
        expect(hasLabelPrefixes(made)).toBe(true);
        const grouped = groupByLabelPrefix(made);
        expect(grouped.map((parameter) => [parameter.group, parameter.label])).toEqual([
            ['Polished edges', 'Sharpness'], ['Iron', 'Noise scale'], [undefined, 'Ratio 2:1'], ['Mine', 'Kept: as is'],
        ]);
        expect(hasLabelPrefixes(grouped)).toBe(false);
    });

    it('notices when every cell of a variation sheet came out the same', () => {
        const flat = pictureFingerprint(new Uint8Array([1, 2, 3, 4]));
        expect(allCellsSame([flat, flat, flat])).toBe(true);
        expect(allCellsSame([flat, pictureFingerprint(new Uint8Array([1, 2, 3, 5])), flat])).toBe(false);
        // Not until every cell is drawn, and never for one cell.
        expect(allCellsSame([flat, undefined])).toBe(false);
        expect(allCellsSame([flat])).toBe(false);
    });
});
