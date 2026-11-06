import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
    OUTPUT_NODE_TYPE,
    compileMaterialGraph,
    defaultParams,
    materialGraphParameters,
    materialShaderVersions,
    normalizeMaterialGraph,
    withMaterialParameters,
    type MaterialGraph,
} from '../../runtime/materials/materialGraph';
import { boundMaterialGraph } from '../../runtime/materials/graphMaterial';
import { materialLibrary } from '../../runtime/materials/materialLibrary';
import { normalizeMaterialOverride } from '../../utils/materialOverrides';
import {
    applyMaterialInstances,
    assetShaderVersions,
    hasObjectMaterialValues,
    isMaterialInstance,
    mergedParameterValues,
    normalizeObjectMaterialOverrides,
    releaseSessionMaterials,
    setObjectMaterialValue,
    withObjectParameters,
} from '../../utils/materialInstances';
import { materialValueTargets } from '../../hooks/levelBlueprintNodes/world';
import { objectsLeftToTheGrid } from '../../runtime/worldGrid';
import type { LevelObject } from '../../types';

const node = (id: string, type: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, params: { ...defaultParams(type), ...params }, ...extra });
const link = (fromNode: string, fromOutput: string, toNode: string, toInput: string) => ({ fromNode, fromOutput, toNode, toInput });

/** A tint colour, a texture and a "Worn" switch picking between them, each a parameter. */
const paintGraph = (): MaterialGraph => normalizeMaterialGraph({
    nodes: [
        node('out', OUTPUT_NODE_TYPE),
        node('tint', 'color', { value: [1, 0, 0] }, { parameter: 'Tint' }),
        node('tex', 'texture', { texture: 'clean' }, { parameter: 'Picture' }),
        node('mix', 'multiply'),
        node('worn', 'switch', { on: false }, { parameter: 'Worn' }),
        node('rust', 'color', { value: [0.4, 0.2, 0.1] }),
    ],
    links: [
        link('tint', 'out', 'mix', 'a'), link('tex', 'rgb', 'mix', 'b'),
        link('rust', 'out', 'worn', 'whenOn'), link('mix', 'out', 'worn', 'whenOff'),
        link('worn', 'out', 'out', 'baseColor'),
    ],
});

/** A model's copy: one mesh wearing the model's material, bound to the paint asset with the model's own tint. */
const placedCopy = (id: string) => {
    const material = new THREE.MeshStandardMaterial({ name: 'Body' });
    materialLibrary.assign(material, 'paint', true, { Tint: [0, 0, 1] });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    const root = new THREE.Group().add(mesh);
    root.userData.levelObjectId = id;
    return { root, mesh, material };
};

afterEach(() => materialLibrary.replaceAll([]));

describe('a shader graph\'s switches and texture parameters', () => {
    it('are listed with its other parameters', () => {
        expect(materialGraphParameters(paintGraph()).map(parameter => [parameter.name, parameter.param.kind])).toEqual([['Picture', 'texture'], ['Tint', 'color'], ['Worn', 'boolean']]);
    });

    it('build only the side a switch picks, so each choice is a shader version of its own', () => {
        const graph = paintGraph();
        const clean = compileMaterialGraph(graph);
        expect(clean.unused).toEqual(['rust']);
        const worn = compileMaterialGraph(withMaterialParameters(graph, { Worn: true }));
        expect(worn.unused.sort()).toEqual(['mix', 'tex', 'tint']);
        expect(worn.key).not.toBe(clean.key);
        // A texture or a colour is only a value the shader is given.
        expect(compileMaterialGraph(withMaterialParameters(graph, { Picture: 'dirty', Tint: [0, 1, 0] })).key).toBe(clean.key);
        expect(materialShaderVersions(graph, [undefined, { Tint: [0, 1, 0] }, { Picture: 'dirty' }])).toBe(1);
        expect(materialShaderVersions(graph, [undefined, { Worn: true }, { Worn: false }])).toBe(2);
    });

    it('keep texture ids and switch choices in an override, made safe', () => {
        expect(normalizeMaterialOverride({ parameters: [{ name: 'Picture', value: 'dirty' }, { name: 'Worn', value: true }, { name: 'Bad', value: '' }] }))
            .toEqual({ parameters: [{ name: 'Picture', value: 'dirty' }, { name: 'Worn', value: true }] });
    });
});

describe('a placed object\'s own material values', () => {
    it('are kept per material, made safe, and say whether the object has any', () => {
        const stored = normalizeObjectMaterialOverrides({ Body: { parameters: [{ name: 'Tint', value: [0, 1, 0] }], color: '#ff0000' }, Glass: {}, '': { parameters: [{ name: 'Tint', value: 1 }] } });
        expect(stored).toEqual({ Body: { parameters: [{ name: 'Tint', value: [0, 1, 0] }] } });
        expect(hasObjectMaterialValues({ materialOverrides: stored })).toBe(true);
        expect(hasObjectMaterialValues({})).toBe(false);
        expect(withObjectParameters(stored, 'Body', undefined)).toBeUndefined();
        expect(withObjectParameters(undefined, 'Body', [{ name: 'Worn', value: true }])).toEqual({ Body: { parameters: [{ name: 'Worn', value: true }] } });
    });

    it('sit on the model\'s, which they leave unchanged', () => {
        expect(mergedParameterValues({ Tint: [0, 0, 1], Worn: false }, [{ name: 'Worn', value: true }])).toEqual({ Tint: [0, 0, 1], Worn: true });
        expect(mergedParameterValues({ Tint: [0, 0, 1] }, undefined)).toEqual({ Tint: [0, 0, 1] });
    });

    it('dress the object\'s copy in an instance, shared by copies asking the same, and give the model\'s material back', () => {
        materialLibrary.replaceAll([{ id: 'paint', name: 'Paint', graph: paintGraph() }]);
        const first = placedCopy('a');
        const second = placedCopy('b');
        second.mesh.material = first.material;
        const values = { Body: { parameters: [{ name: 'Tint', value: [0, 1, 0] }] } };
        const undoFirst = applyMaterialInstances(first.root, values);
        const undoSecond = applyMaterialInstances(second.root, values);
        const instance = first.mesh.material as THREE.Material;
        expect(isMaterialInstance(instance)).toBe(true);
        expect(second.mesh.material).toBe(instance);
        // The instance carries the model's values with the object's on top; the model's material keeps its own.
        const graph = boundMaterialGraph(instance)!;
        expect(graph.nodes.find(candidate => candidate.id === 'tint')!.params.value).toEqual([0, 1, 0]);
        expect(boundMaterialGraph(first.material)!.nodes.find(candidate => candidate.id === 'tint')!.params.value).toEqual([0, 0, 1]);
        undoFirst();
        expect(first.mesh.material).toBe(first.material);
        expect(boundMaterialGraph(instance)).not.toBeNull();
        undoSecond();
        // The last user's release frees it.
        expect(boundMaterialGraph(instance)).toBeNull();
    });

    it('leave materials no asset shades as they are', () => {
        const plain = new THREE.MeshStandardMaterial({ name: 'Body' });
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(), plain);
        const undo = applyMaterialInstances(new THREE.Group().add(mesh), { Body: { parameters: [{ name: 'Tint', value: 1 }] } });
        expect(mesh.material).toBe(plain);
        undo();
    });

    it('count the shader versions the asset builds across the model and its copies', () => {
        materialLibrary.replaceAll([{ id: 'paint', name: 'Paint', graph: paintGraph() }]);
        const model = { id: 'crate', materialOverrides: { Body: { materialId: 'paint' } } };
        const copies = [
            { modelId: 'crate', materialOverrides: { Body: { parameters: [{ name: 'Tint', value: [0, 1, 0] }] } } },
            { modelId: 'crate', materialOverrides: { Body: { parameters: [{ name: 'Worn', value: true }] } } },
            { modelId: 'barrel', materialOverrides: { Body: { parameters: [{ name: 'Worn', value: true }] } } },
        ];
        expect(assetShaderVersions('paint', [model], copies.slice(0, 1))).toBe(1);
        expect(assetShaderVersions('paint', [model], copies)).toBe(2);
    });

    it('draw the object on its own, out of the World Grid', () => {
        const grid: LevelObject = { id: 'grid', levelId: 'l', modelId: '', name: 'Grid', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], type: 'prop', components: [{ id: 'g', type: 'worldGrid', enabled: true, props: {} }] };
        const prop = (id: string, extra: Partial<LevelObject> = {}): LevelObject => ({ id, levelId: 'l', modelId: 'crate', name: id, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], type: 'prop', ...extra });
        const plain = prop('plain');
        const painted = prop('painted', { materialOverrides: { Body: { parameters: [{ name: 'Tint', value: 1 }] } } });
        const left = objectsLeftToTheGrid([grid, plain, painted], new Set());
        expect(left.has(painted)).toBe(false);
        if (left.size) expect(left.has(plain)).toBe(true);
    });
});

describe('material values set while a game plays', () => {
    it('change one object alone, on copies of its own the session frees', () => {
        materialLibrary.replaceAll([{ id: 'paint', name: 'Paint', graph: paintGraph() }]);
        const first = placedCopy('a');
        const second = placedCopy('b');
        second.mesh.material = first.material;
        const made: THREE.Material[] = [];
        expect(setObjectMaterialValue(first.root, 'Tint', [1, 1, 0], made)).toBe(1);
        expect(made).toHaveLength(1);
        expect(second.mesh.material).toBe(first.material);
        const own = first.mesh.material as THREE.Material;
        expect(boundMaterialGraph(own)!.nodes.find(candidate => candidate.id === 'tint')!.params.value).toEqual([1, 1, 0]);
        // Set again: the same copy takes it; a switch takes any number but 0 as on; unknown names change nothing.
        expect(setObjectMaterialValue(first.root, 'Worn', 1, made)).toBe(1);
        expect(made).toHaveLength(1);
        expect(boundMaterialGraph(own)!.nodes.find(candidate => candidate.id === 'worn')!.params.on).toBe(true);
        expect(setObjectMaterialValue(first.root, 'Nothing', 1, made)).toBe(0);
        releaseSessionMaterials(made);
        expect(made).toHaveLength(0);
        expect(boundMaterialGraph(own)).toBeNull();
    });

    it('draw the objects the blueprint names on their own', () => {
        expect([...materialValueTargets([
            { type: 'SetMaterialNumber', data: { default_Actor: 'crate-1' } },
            { type: 'SetMaterialColour', data: { default_Actor: { id: 'crate-2' } } },
            { type: 'SetMorphTarget', data: { default_Actor: 'face' } },
            { type: 'SetMaterialNumber', data: { default_Actor: '' } },
        ])]).toEqual(['crate-1', 'crate-2']);
    });
});
