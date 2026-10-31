import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { rebuildNormalZ } from '../../utils/textureCompression/compressTextures';

const compiled = (material: THREE.Material): string => {
    const shader = { fragmentShader: '#include <normal_fragment_maps>', vertexShader: '', uniforms: {} };
    material.onBeforeCompile(shader as never, null as never);
    return shader.fragmentShader;
};

describe('a material reading a two-channel normal map', () => {
    it('rebuilds the third component', () => {
        const material = new THREE.MeshStandardMaterial();
        rebuildNormalZ(material);
        expect(compiled(material)).toContain('mapN.z = sqrt');
        expect(material.customProgramCacheKey()).toContain('normal-rg');
    });

    it('still does when copied, and when a copy is copied, as hair, faded characters and probe-lit surfaces are', () => {
        const material = new THREE.MeshStandardMaterial();
        rebuildNormalZ(material);
        const copy = material.clone();
        const copyOfCopy = copy.clone();
        for (const each of [copy, copyOfCopy]) {
            expect(compiled(each)).toContain('mapN.z = sqrt');
            expect(each.customProgramCacheKey()).toContain('normal-rg');
        }
    });

    it('applies once, however often it is asked', () => {
        const material = new THREE.MeshStandardMaterial();
        rebuildNormalZ(material);
        const hook = material.onBeforeCompile;
        rebuildNormalZ(material);
        expect(material.onBeforeCompile).toBe(hook);
    });
});
