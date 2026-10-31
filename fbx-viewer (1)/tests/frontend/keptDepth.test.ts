import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { canDrawFloat, DepthCopy, KeepDepthPass } from '../../runtime/keptDepth';

/*
 * Depth kept through a composer's buffer swaps. What it does for depth of field, light shafts and motion blur
 * is checked in the Temporal Lab.
 */

describe('kept depth', () => {
    it('asks the composer for depth, leaves the picture where it is, and hands out a texture of its own', () => {
        const pass = new KeepDepthPass();
        expect(pass.needsDepthTexture).toBe(true);
        expect(pass.needsSwap).toBe(false);
        const depth = new THREE.DepthTexture(4, 4);
        pass.setDepthTexture(depth);
        expect(pass.copy.texture).not.toBe(depth);
        pass.dispose();
    });

    it('reads as single-channel values without filtering, as depth samplers expect', () => {
        const copy = new DepthCopy();
        expect(copy.texture.format).toBe(THREE.RedFormat);
        expect(copy.texture.type).toBe(THREE.FloatType);
        expect(copy.texture.minFilter).toBe(THREE.NearestFilter);
        expect(copy.texture.magFilter).toBe(THREE.NearestFilter);
        copy.dispose();
    });

    it('keeps the same texture when resized, so what holds it stays right', () => {
        const copy = new DepthCopy();
        const texture = copy.texture;
        copy.setSize(320, 200);
        expect(copy.texture).toBe(texture);
        copy.dispose();
    });

    it('is only used where the device can draw into float targets', () => {
        expect(canDrawFloat({ extensions: { has: () => true } })).toBe(true);
        expect(canDrawFloat({ extensions: { has: () => false } })).toBe(false);
        // Nothing to go on: assume the usual case rather than turn features off.
        expect(canDrawFloat({})).toBe(true);
    });
});
