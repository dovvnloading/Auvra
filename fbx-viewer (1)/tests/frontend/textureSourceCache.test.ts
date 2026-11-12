import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createNode, graphContentKey, normalizeTextureGraph } from '../../texturing/graph/document';
import { TextureGraphEvaluator } from '../../texturing/graph/evaluator';
import { sourceTextureKey } from '../../texturing/graph/sourceTextureKey';
import { graphStampContentKey } from '../../texturing/paint/graphStamps';
import type { TextureGraph } from '../../texturing/graph/types';

const bitmap = { ...createNode('bitmap', 0, 0, { texture: 'picture' }), id: 'picture-node' };
const graph = normalizeTextureGraph({
    version: 1, size: { w: 6, h: 6 }, seed: 1, parameters: [],
    nodes: [
        bitmap,
        { ...createNode('output', 240, 0), id: 'result' },
        { ...createNode('perlinNoise', 0, 240), id: 'independent' },
    ],
    links: [{ from: 'picture-node', fromOutput: 'out', to: 'result', toInput: 'in' }],
});

const preparedSignatures = (evaluator: TextureGraphEvaluator, pictureGraph: TextureGraph): Map<string, string> => {
    // Observe the actual signature used by the evaluator's cache without requiring a WebGL context.
    const prepared = (evaluator as unknown as {
        prepare(request: object): { info: Map<string, { signature: string }> };
    }).prepare({ graph: pictureGraph, targets: pictureGraph.nodes.map(node => node.id) });
    return new Map([...prepared.info].map(([id, details]) => [id, details.signature]));
};

describe('texture source revision cache keys', () => {
    it('invalidates changed Bitmap nodes and downstream outputs, but not unrelated nodes', () => {
        let picture = new THREE.Texture();
        const evaluator = new TextureGraphEvaluator(
            { maxSize: 4096, onRestored: () => () => undefined } as never,
            () => undefined, id => id === 'picture' ? picture : null,
        );
        const initial = preparedSignatures(evaluator, graph);
        expect(preparedSignatures(evaluator, graph)).toEqual(initial);

        // Re-imported under the same logical ID and bit depth.
        picture = new THREE.Texture();
        const replaced = preparedSignatures(evaluator, graph);
        expect(replaced.get('picture-node')).not.toBe(initial.get('picture-node'));
        expect(replaced.get('result')).not.toBe(initial.get('result'));
        expect(replaced.get('independent')).toBe(initial.get('independent'));
        expect(preparedSignatures(evaluator, graph)).toEqual(replaced);

        // Same Three texture, but its decoded pixels were refreshed.
        picture.needsUpdate = true;
        const updated = preparedSignatures(evaluator, graph);
        expect(updated.get('picture-node')).not.toBe(replaced.get('picture-node'));
        expect(updated.get('result')).not.toBe(replaced.get('result'));
        expect(updated.get('independent')).toBe(replaced.get('independent'));
        expect(preparedSignatures(evaluator, graph)).toEqual(updated);
        evaluator.dispose();
    });

    it('tracks nested graphs and paint stamp pictures through their actual source revisions', () => {
        const inner = normalizeTextureGraph({
            version: 1, size: { w: 6, h: 6 }, seed: 1, parameters: [],
            nodes: [bitmap], links: [],
        });
        const outer = normalizeTextureGraph({
            version: 1, size: { w: 6, h: 6 }, seed: 1, parameters: [],
            nodes: [{ ...createNode('subgraph', 0, 0, { graph: 'inner' }), id: 'nested' }],
            links: [],
        });
        const resolve = (id: string) => id === 'inner' ? { graph: inner } : undefined;
        let picture = new THREE.Texture();
        const source = (id: string) => id === 'picture' ? sourceTextureKey(picture) : null;
        const key = () => graphContentKey(outer, resolve, source);
        const original = key();
        expect(key()).toBe(original);
        picture = new THREE.Texture();
        const replaced = key();
        expect(replaced).not.toBe(original);
        picture.needsUpdate = true;
        expect(key()).not.toBe(replaced);

        // Boolean loaded callbacks are still supported for older content-key consumers.
        expect(graphContentKey(inner, resolve, () => true)).toBe(graphContentKey(inner, resolve, () => true));
        expect(graphContentKey(inner, resolve, () => false)).not.toBe(graphContentKey(inner, resolve, () => true));
    });

    it('distinguishes source changes and keeps the depth part of a stable texture token', () => {
        const first = new THREE.Texture();
        const baseline = sourceTextureKey(first);
        expect(baseline).toBe(sourceTextureKey(first));
        expect(sourceTextureKey(null)).toBeNull();
        expect(sourceTextureKey(new THREE.Texture())).not.toBe(baseline);
        first.userData.auvraDepth = 16;
        const deep = sourceTextureKey(first);
        expect(deep).not.toBe(baseline);
        first.needsUpdate = true;
        expect(sourceTextureKey(first)).not.toBe(deep);
        const refreshed = sourceTextureKey(first);
        first.source.needsUpdate = true;
        expect(sourceTextureKey(first)).not.toBe(refreshed);
    });

    it('revises brush stamp keys for replaced defaults and bound picture overrides', () => {
        const brushGraph = normalizeTextureGraph({
            version: 1, size: { w: 6, h: 6 }, seed: 1,
            parameters: [{ name: 'paintPhoto', label: 'Paint photo', kind: 'texture', default: 'default' }],
            nodes: [{ ...bitmap, params: { ...bitmap.params, texture: { $bind: 'paintPhoto' } } }],
            links: [],
        });
        let normal = new THREE.Texture();
        let override = new THREE.Texture();
        const texture = (id: string) => id === 'default' ? normal : id === 'override' ? override : null;
        const stamp = { graphId: 'brush', output: '', values: { paintPhoto: 'override' } };
        const key = () => graphStampContentKey(stamp, brushGraph, () => undefined, texture);
        const initial = key();
        expect(key()).toBe(initial);
        override = new THREE.Texture();
        const replaced = key();
        expect(replaced).not.toBe(initial);
        override.needsUpdate = true;
        expect(key()).not.toBe(replaced);

        const unmodifiedStamp = { ...stamp, values: {} };
        const defaultKey = () => graphStampContentKey(unmodifiedStamp, brushGraph, () => undefined, texture);
        const initialDefault = defaultKey();
        normal = new THREE.Texture();
        expect(defaultKey()).not.toBe(initialDefault);
    });

});
