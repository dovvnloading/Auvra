import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GarmentInstance, readGarmentSettings } from '../../runtime/components/garmentComponent';
import { bakeFitting, fittingBakeRecipe, type FittingBakeInput } from '../../runtime/garments/bake';
import { decodeGarmentCache, sampleGarmentCache } from '../../runtime/garments/cache';
import { cookGarment, createSleevelessTop } from '../../runtime/garments/pattern';

function fixture(): FittingBakeInput {
    const pattern = createSleevelessTop();
    pattern.edgeLength = .11;
    return { pattern, fabric: 'linen', animateTorso: true, selfCollision: false };
}

describe('fitting clip and live component parity', () => {
    beforeEach(() => vi.stubGlobal('crypto', webcrypto));
    afterEach(() => vi.unstubAllGlobals());

    it.each([undefined, { warp: 680, weft: 1300, thickness: .003 }])('records the same poses and torso as live fitting with material %j', (material) => {
        const input = { ...fixture(), material }, cooked = cookGarment(input.pattern);
        const settings = readGarmentSettings({ id: 'cloth', type: 'garment', enabled: true,
            props: { fabric: input.fabric, animateTorso: input.animateTorso, selfCollision: input.selfCollision, wind: 0 } });
        const progress = vi.fn();
        const cache = decodeGarmentCache(bakeFitting(input, 1, progress), cooked.positions.length / 3);
        const live = new GarmentInstance(cooked, input.fabric, input.selfCollision, material);
        const out = new Float32Array(cooked.positions.length), center: [number, number, number] = [0, 0, 0];
        expect(cache.frameCount).toBe(31);
        expect(cache.fps).toBe(30);
        try {
            for (let frame = 0; frame < cache.frameCount; frame++) {
                if (frame) live.advance(1 / cache.fps, settings, 'fit-form');
                sampleGarmentCache(cache, frame / cache.fps, out, center);
                // Test each axis independently against the encoder's half-step error and f32 roundoff.
                const max = [0, 0, 0];
                for (let i = 0; i < out.length; i++) max[i % 3] = Math.max(max[i % 3], Math.abs(out[i] - live.simulation.positions[i]));
                for (let axis = 0; axis < 3; axis++) {
                    expect(max[axis], 'vertex max error at frame ' + frame + ', axis ' + axis).toBeLessThanOrEqual(cache.quantum[axis] * .5 + 2e-7);
                    expect(center[axis]).toBeCloseTo(live.torso.position.getComponent(axis), 6);
                }
            }
            expect(live.simulation.time).toBeCloseTo(1, 8);
            expect(live.torso.position.x).not.toBeCloseTo(0, 3);
            expect(progress).toHaveBeenLastCalledWith(1);
        } finally { live.dispose(); }
    });

    it('invalidates fabric, motion, collision or pattern edits while visual controls preserve the fitting recipe', async () => {
        const input = fixture();
        const equivalent = { ...input, pattern: JSON.parse(JSON.stringify(input.pattern)), color: '#441111', strainView: 'shear' };
        const signature = await fittingBakeRecipe(input);
        expect(signature).toMatch(/^[0-9a-f]{64}$/);
        expect(await fittingBakeRecipe(equivalent)).toBe(signature);
        expect(await fittingBakeRecipe({ ...input, material: { arealDensity: .22 } })).toBe(signature);
        expect(await fittingBakeRecipe({ ...input, material: { warp: 330 } })).not.toBe(signature);
        expect(await fittingBakeRecipe({ ...input, material: { warp: 330, weft: 820 } })).toBe(
            await fittingBakeRecipe({ ...input, material: { weft: 820, warp: 330 } }));
        const edited = structuredClone(input);
        edited.pattern.panels[0].boundary[0].x -= .015;
        for (const changed of [edited, { ...input, fabric: 'silk' as const },
            { ...input, animateTorso: false }, { ...input, selfCollision: true }])
            expect(await fittingBakeRecipe(changed)).not.toBe(signature);
    });
});
