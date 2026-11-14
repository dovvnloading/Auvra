import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bakeFitting, fittingBakeRecipe } from '../../runtime/garments/bake';
import { decodeGarmentCache, sampleGarmentCache } from '../../runtime/garments/cache';
import { cookGarment, type GarmentPanel, type GarmentPattern } from '../../runtime/garments/pattern';

const panel = (id: string, height: number): GarmentPanel => ({
    id, name: id, grain: [1, 0], pins: [],
    placement: { origin: [0.5, height, 0], u: [1, 0, 0], v: [0, 0, -1] },
    boundary: [{ id: 'p0', x: -.10, y: -.10 }, { id: 'p1', x: .10, y: -.10 },
        { id: 'p2', x: .10, y: .10 }, { id: 'p3', x: -.10, y: .10 }],
});

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

it('preserves the authored layer order in an actual fitting clip with same-layer contact off', async () => {
    const inner = panel('support', 1), outer = panel('cloth', 1.025);
    inner.pins = inner.boundary.map(p => p.id);
    outer.layer = 1;
    const pattern: GarmentPattern = { version: 1, edgeLength: .3, panels: [inner, outer], seams: [] };
    const options = { pattern, fabric: 'cotton' as const, selfCollision: false, animateTorso: false };
    const reference = await fittingBakeRecipe(options);
    const cooked = cookGarment(pattern);
    const cache = decodeGarmentCache(bakeFitting(options, 1, () => {}), cooked.positions.length / 3);
    const out = new Float32Array(cooked.positions.length);
    sampleGarmentCache(cache, 1, out, [0, 0, 0]);
    for (let i = cooked.panelRanges[1].vertexStart; i < out.length / 3; i++)
        expect(out[3*i + 1]).toBeGreaterThan(1.002);
    const unranked = structuredClone(pattern);
    delete unranked.panels[1].layer;
    expect(await fittingBakeRecipe({ ...options, pattern: unranked })).not.toBe(reference);
    const free = decodeGarmentCache(bakeFitting({ ...options, pattern: unranked }, 1, () => {}), out.length / 3);
    sampleGarmentCache(free, 1, out, [0, 0, 0]);
    for (let i = cooked.panelRanges[1].vertexStart; i < out.length / 3; i++) expect(out[3*i+1]).toBeLessThan(0);
});
