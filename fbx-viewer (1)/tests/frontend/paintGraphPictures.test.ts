import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

const deep = new THREE.DataTexture(new Float32Array(16), 2, 2, THREE.RGBAFormat, THREE.FloatType);
deep.userData.auvraDepth = 32;
vi.mock('../../components/Texturing/deepPictures', () => ({
    deepPictures: { lookup: (base: (id: string) => THREE.Texture | null) => (id: string) => (id === 'height' ? deep : base(id)) },
}));

const { graphPictureLookup } = await import('../../components/Texturing/Paint/graphPictures');

describe('pictures read by fill graphs', () => {
    it('come at their own depth, laid as the model lays its textures', () => {
        const plain = new THREE.Texture();
        plain.flipY = true;
        const bottomFirst = graphPictureLookup(() => plain, true);
        // 8-bit pictures are the project's own textures.
        expect(bottomFirst.lookup('colour')).toBe(plain);
        // A deep picture on a model laid bottom row first: a copy laid the same way, made once.
        const turned = bottomFirst.lookup('height')!;
        expect(turned).not.toBe(deep);
        expect(turned.flipY).toBe(true);
        expect(turned.userData.auvraDepth).toBe(32);
        expect(bottomFirst.lookup('height')).toBe(turned);
        expect(deep.flipY).toBe(false);
        bottomFirst.dispose();
        // On a model laid top row first it is used as it is.
        expect(graphPictureLookup(() => plain, false).lookup('height')).toBe(deep);
    });
});
