import * as THREE from 'three';
import { EffectPass, LuminancePass, Pass } from 'postprocessing';
import { describe, expect, it, vi } from 'vitest';
import { installPassDispose } from '../../runtime/passDispose';

const watch = (material: THREE.Material) => {
    const freed = vi.fn();
    material.addEventListener('dispose', freed);
    return freed;
};

describe('freeing a pass', () => {
    it('frees the material on its screen', () => {
        const pass = new LuminancePass();
        const freed = watch(pass.fullscreenMaterial);
        pass.dispose();
        expect(freed).toHaveBeenCalledTimes(1);
    });

    it('frees the merged shader of a pass of effects', () => {
        const pass = new EffectPass(new THREE.PerspectiveCamera());
        const freed = watch(pass.fullscreenMaterial);
        pass.dispose();
        expect(freed).toHaveBeenCalledTimes(1);
    });

    it('still frees what the pass holds directly', () => {
        const pass = new Pass() as Pass & { held?: THREE.WebGLRenderTarget };
        pass.held = new THREE.WebGLRenderTarget(1, 1);
        const freed = vi.fn();
        pass.held.addEventListener('dispose', freed);
        pass.dispose();
        expect(freed).toHaveBeenCalledTimes(1);
    });

    it('leaves a pass with no screen alone', () => {
        expect(() => new Pass().dispose()).not.toThrow();
    });

    it('patches once, however many times it is installed', () => {
        const patched = Pass.prototype.dispose;
        installPassDispose();
        expect(Pass.prototype.dispose).toBe(patched);
    });
});
