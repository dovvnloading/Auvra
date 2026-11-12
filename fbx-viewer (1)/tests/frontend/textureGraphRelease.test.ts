import { describe, expect, it } from 'vitest';
import { createNode, normalizeTextureGraph } from '../../texturing/graph/document';
import { AbortedError, TextureGraphEvaluator } from '../../texturing/graph/evaluator';

// A live image with two references: the evaluator owns one and another user owns the other.
const fakeGpu = (draw: () => void) => {
    const pictures: Array<{ refs: number }> = [];
    const released: Array<{ refs: number }> = [];
    const gpu = {
        maxSize: 4096,
        memory: { live: 0, idle: 0 },
        onRestored: () => () => undefined,
        image: (width: number, height: number, kind: string, precision: number) => {
            const picture = { target: {}, width, height, kind, precision, refs: 2 };
            pictures.push(picture);
            return picture;
        },
        release: (picture: { refs: number }) => { picture.refs--; released.push(picture); },
        retain: (picture: { refs: number }) => { picture.refs++; return picture; },
        constant: () => ({}),
        pass: async () => { draw(); },
        clear: () => undefined,
        readPixelLater: async () => null,
    };
    return { gpu, pictures, released };
};

const graph = normalizeTextureGraph({
    version: 1, size: { w: 4, h: 4 }, seed: 0, parameters: [], links: [],
    nodes: [{ ...createNode('perlinNoise', 0, 0), id: 'noise' }],
});

describe('texture graph GPU intermediate ownership', () => {
    it('releases a shared intermediate only once when a shader throws', async () => {
        const { gpu, pictures, released } = fakeGpu(() => { throw new Error('shader compile failed'); });
        const evaluator = new TextureGraphEvaluator(gpu as never, () => undefined, () => null);
        const states = await evaluator.evaluate({ graph, targets: ['noise'] });
        expect(states.get('noise')?.error).toBe('shader compile failed');
        expect(pictures).toHaveLength(1);
        expect(released).toHaveLength(1);
        expect(pictures[0].refs).toBe(1);
        evaluator.dispose();
        expect(released).toHaveLength(1);
    });

    it('releases a shared intermediate only once on a thrown cancellation', async () => {
        const { gpu, pictures, released } = fakeGpu(() => { throw new AbortedError(); });
        const evaluator = new TextureGraphEvaluator(gpu as never, () => undefined, () => null);
        await expect(evaluator.evaluate({ graph, targets: ['noise'] })).rejects.toBeInstanceOf(AbortedError);
        expect(pictures).toHaveLength(1);
        expect(released).toHaveLength(1);
        expect(pictures[0].refs).toBe(1);
        evaluator.dispose();
        expect(released).toHaveLength(1);
    });

    it('releases completed output once if cancellation arrives during the GPU pass', async () => {
        const controller = new AbortController();
        const { gpu, pictures, released } = fakeGpu(() => controller.abort());
        const evaluator = new TextureGraphEvaluator(gpu as never, () => undefined, () => null);
        await expect(evaluator.evaluate({ graph, targets: ['noise'], signal: controller.signal })).rejects.toBeInstanceOf(AbortedError);
        expect(pictures).toHaveLength(1);
        expect(released).toHaveLength(1);
        expect(pictures[0].refs).toBe(1);
        evaluator.dispose();
        expect(released).toHaveLength(1);
    });

    it('retains successful output until the evaluator is disposed', async () => {
        const { gpu, pictures, released } = fakeGpu(() => undefined);
        const evaluator = new TextureGraphEvaluator(gpu as never, () => undefined, () => null);
        const states = await evaluator.evaluate({ graph, targets: ['noise'] });
        expect(states.get('noise')?.outputs.out).toBe(pictures[0]);
        expect(released).toHaveLength(0);
        evaluator.dispose();
        expect(released).toHaveLength(1);
        expect(pictures[0].refs).toBe(1);
    });
});
