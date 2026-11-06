import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
    OUTPUT_NODE_TYPE,
    compileMaterialGraph,
    defaultParams,
    materialGraphLook,
    materialGraphShape,
    normalizeMaterialGraph,
    type MaterialGraph,
} from '../../runtime/materials/materialGraph';
import { bindMaterialGraph, graphColourSource } from '../../runtime/materials/graphMaterial';
import { materialLibrary } from '../../runtime/materials/materialLibrary';
import { MATERIAL_BYPASS_KEPT, MATERIAL_LOOKS_KEPT } from '../../components/Materials/materialNodeViews';

const node = (id: string, type: string, params: Record<string, unknown> = {}, look: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, params: { ...defaultParams(type), ...params }, ...look });
const link = (fromNode: string, fromOutput: string, toNode: string, toInput: string) => ({ fromNode, fromOutput, toNode, toInput });

/** A red colour times a noise into the base colour; `look` goes on the multiply. */
const tinted = (look: Record<string, unknown> = {}): MaterialGraph => normalizeMaterialGraph({
    nodes: [node('out', OUTPUT_NODE_TYPE), node('red', 'color', { value: [1, 0, 0] }), node('noise', 'noise'), node('mul', 'multiply', {}, look)],
    links: [link('red', 'out', 'mul', 'a'), link('noise', 'out', 'mul', 'b'), link('mul', 'out', 'out', 'baseColor')],
});

const withLook = (graph: MaterialGraph, id: string, look: Record<string, unknown>): MaterialGraph =>
    ({ ...graph, nodes: graph.nodes.map(candidate => (candidate.id === id ? { ...candidate, ...look } : candidate)) });

afterEach(() => materialLibrary.replaceAll([]));

describe('a shader graph node\'s own name, colour, folding and bypass', () => {
    it('are kept when the graph is read, made safe', () => {
        const [, mul] = normalizeMaterialGraph({
            nodes: [node('out', OUTPUT_NODE_TYPE), node('mul', 'multiply', {}, { name: '  Tint  ', color: '#1E40AF', collapsed: true, bypass: true })],
            links: [],
        }).nodes;
        expect(mul).toMatchObject({ name: 'Tint', color: '#1e40af', collapsed: true, bypass: true });
        const [, odd] = normalizeMaterialGraph({
            nodes: [node('out', OUTPUT_NODE_TYPE), node('mul', 'multiply', {}, { name: '   ', color: 'blue', collapsed: 'yes', bypass: 1 })],
            links: [],
        }).nodes;
        expect(['name', 'color', 'collapsed', 'bypass'].filter(key => key in odd)).toEqual([]);
        const [, long] = normalizeMaterialGraph({ nodes: [node('out', OUTPUT_NODE_TYPE), node('mul', 'multiply', {}, { name: 'x'.repeat(200) })], links: [] }).nodes;
        expect(long.name).toHaveLength(64);
    });

    it('turn the canvas\'s naming, colouring, folding and bypass tools on', () => {
        expect(MATERIAL_LOOKS_KEPT).toBe(true);
        expect(MATERIAL_BYPASS_KEPT).toBe(true);
    });

    it('change nothing a material draws, but for bypass', () => {
        const graph = tinted();
        const shown = withLook(graph, 'mul', { name: 'Tint', color: '#1e40af', collapsed: true });
        expect(materialGraphLook(shown)).toBe(materialGraphLook(graph));
        expect(materialGraphShape(shown)).toBe(materialGraphShape(graph));
        const bypassed = withLook(graph, 'mul', { bypass: true });
        expect(materialGraphLook(bypassed)).not.toBe(materialGraphLook(graph));
        expect(materialGraphShape(bypassed)).not.toBe(materialGraphShape(graph));
    });

    it('rebuild no material when only how a node is shown changes', () => {
        const material = new THREE.MeshStandardMaterial();
        materialLibrary.replaceAll([{ id: 'paint', name: 'Paint', graph: tinted() }]);
        materialLibrary.assign(material, 'paint');
        const key = material.customProgramCacheKey();
        const version = material.version;
        materialLibrary.upsert({ id: 'paint', name: 'Paint', graph: withLook(tinted(), 'mul', { name: 'Tint', color: '#1e40af', collapsed: true }) });
        expect(material.version).toBe(version);
        materialLibrary.upsert({ id: 'paint', name: 'Paint', graph: withLook(tinted(), 'mul', { bypass: true }) });
        expect(material.customProgramCacheKey()).not.toBe(key);
    });
});

describe('a bypassed shader graph node', () => {
    it('passes its main input straight through, and what fed only its other inputs is left out', () => {
        const compiled = compileMaterialGraph(tinted({ bypass: true }));
        const plain = compileMaterialGraph(tinted());
        expect(compiled.key).not.toBe(plain.key);
        expect(compiled.unused).toEqual(['noise']);
        expect(compiled.statements.join('\n')).not.toContain('*');
        // The red colour, as the base colour.
        expect(compiled.statements.some(line => /vec3 mg_mul_out_out_\d+ = mg_red_out_out_\d+;/.test(line))).toBe(true);
    });

    it('converts what it passes to each output\'s type', () => {
        const graph = normalizeMaterialGraph({
            nodes: [node('out', OUTPUT_NODE_TYPE), node('n', 'float', { value: 0.25 }), node('tex', 'texture', { texture: 'bricks' }, { bypass: true })],
            links: [link('n', 'out', 'tex', 'uv'), link('tex', 'rgb', 'out', 'baseColor')],
        });
        const compiled = compileMaterialGraph(graph);
        // A number into the UV (a vector 2) and on to the colour (a vector 3); no picture is sampled.
        expect(compiled.statements.some(line => /vec3 mg_tex_out_rgb_\d+ = vec3\(vec2\(mg_n_out_out_\d+\), 0\.0\);/.test(line))).toBe(true);
        expect(compiled.uniforms.some(uniform => uniform.nodeId === 'tex')).toBe(false);
    });

    it('passes the input its definition names, where that is not the first', () => {
        const graph = normalizeMaterialGraph({
            nodes: [node('out', OUTPUT_NODE_TYPE), node('v', 'float', { value: 0.7 }), node('step', 'step', {}, { bypass: true })],
            links: [link('v', 'out', 'step', 'b'), link('step', 'out', 'out', 'roughness')],
        });
        const compiled = compileMaterialGraph(graph);
        expect(compiled.statements.some(line => /float mg_step_out_out_\d+ = mg_v_out_out_\d+;/.test(line))).toBe(true);
    });

    it('cannot be the Material Output', () => {
        const graph = normalizeMaterialGraph({ nodes: [node('out', OUTPUT_NODE_TYPE, { roughness: 0.3 }, { bypass: true })], links: [] });
        expect(compileMaterialGraph(graph).outputs.roughness).toMatch(/^mg_out_roughness$/);
    });

    it('gives bounced light what its main input carries', () => {
        const material = new THREE.MeshStandardMaterial();
        bindMaterialGraph(material, tinted({ bypass: true }));
        expect(graphColourSource(material)).toEqual({ kind: 'constant', colour: [1, 0, 0] });
    });
});
