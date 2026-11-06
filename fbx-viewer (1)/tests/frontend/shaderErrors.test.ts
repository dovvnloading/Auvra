import { describe, expect, it } from 'vitest';
import { OUTPUT_NODE_TYPE, compileMaterialGraph, defaultParams, normalizeMaterialGraph } from '../../runtime/materials/materialGraph';
import { nodeAtLine, nodeShaderErrors, plainShaderMessage } from '../../runtime/materials/shaderErrors';

const node = (id: string, type: string, params: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, params: { ...defaultParams(type), ...params } });
const link = (fromNode: string, fromOutput: string, toNode: string, toInput: string) => ({ fromNode, fromOutput, toNode, toInput });

/** A Custom GLSL node with a mistake in it, fed by a noise and feeding the base colour. */
const broken = () => normalizeMaterialGraph({
    nodes: [node('out', OUTPUT_NODE_TYPE), node('noise:1', 'noise'), node('my code', 'customGlsl', { code: 'return a * wobble;' })],
    links: [link('noise:1', 'out', 'my code', 'a'), link('my code', 'out', 'out', 'baseColor')],
});

/** A shader laid out as three lays it out: its own lines, the graph's functions, then main with the graph's code. */
const shaderOf = (graph = broken()) => {
    const compiled = compileMaterialGraph(graph);
    return ['#version 300 es', 'precision highp float;', ...compiled.globals, 'void main() {', '    vec4 diffuseColor = vec4(1.0);', ...compiled.statements, '}'].join('\n');
};

const lineOf = (source: string, text: string) => source.split('\n').findIndex(line => line.includes(text)) + 1;

describe('a shader compile error', () => {
    it('is traced back to the node whose code the line is', () => {
        const source = shaderOf();
        const line = lineOf(source, 'wobble');
        expect(line).toBeGreaterThan(0);
        const errors = nodeShaderErrors(source, `ERROR: 0:${line}: 'wobble' : undeclared identifier\nERROR: 0:${line}: '' : compilation terminated`);
        expect([...errors]).toEqual([['my code', 'Uses “wobble”, which is not defined here.']]);
    });

    it('names a node whatever its id holds', () => {
        const source = shaderOf();
        const lines = source.split('\n');
        const noise = lines.findIndex(text => text.includes('mg_noise_1_out_out'));
        expect(nodeAtLine(lines, noise)).toBe('noise:1');
    });

    it('blames no node for three\'s own lines', () => {
        const source = shaderOf();
        expect(nodeShaderErrors(source, `ERROR: 0:${lineOf(source, 'vec4 diffuseColor')}: 'x' : syntax error`).size).toBe(0);
        // After a node's code ends, the lines are no longer its.
        const lines = source.split('\n');
        expect(nodeAtLine(lines, lines.length - 1)).toBeNull();
    });

    it('is said in plain words', () => {
        expect(plainShaderMessage("'wobble' : undeclared identifier")).toBe('Uses “wobble”, which is not defined here.');
        expect(plainShaderMessage("'}' : syntax error")).toBe('Its code has a mistake near “}”.');
        expect(plainShaderMessage("'=' : cannot convert from 'highp vec3' to 'highp float'")).toBe('A vec3 is used where a float is needed.');
        expect(plainShaderMessage("'mix' : no matching overloaded function found")).toBe('“mix” is given values of the wrong kinds.');
        expect(plainShaderMessage('something else')).toBe('Its code does not compile: something else');
    });
});
