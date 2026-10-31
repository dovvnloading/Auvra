import { describe, expect, it } from 'vitest';
import {
    ATLAS_COLUMNS,
    ATLAS_HEIGHT,
    ATLAS_IRRADIANCE_WIDTH,
    ATLAS_ROWS,
    ATLAS_WIDTH,
    GI_CASCADES,
    GI_QUALITY,
    GRID_LIFT,
    IRRADIANCE_CELL,
    MAX_PROBES_PER_FRAME,
    MAX_RAYS_PER_PROBE,
    PROBES_PER_CASCADE,
    PROBES_X,
    PROBES_Y,
    PROBES_Z,
    ProbeCascade,
    VISIBILITY_CELL,
    cellIndex,
    cellPlace,
    irradianceOrigin,
    offsetTexel,
    resolveDynamicGiSettings,
    sphericalFibonacci,
    visibilityOrigin,
    type ScheduledProbe,
} from '../../runtime/lighting/dynamicGi/probeGrid';

const last = () => GI_CASCADES - 1;

describe('a probe\'s place in the atlas', () => {
    it('gives every cell of a cascade its own place', () => {
        const seen = new Set<string>();
        for (let cell = 0; cell < PROBES_PER_CASCADE; cell++) {
            const { column, row } = cellPlace(cell);
            expect(column).toBeLessThan(ATLAS_COLUMNS);
            expect(row).toBeLessThan(ATLAS_ROWS);
            seen.add(`${column},${row}`);
        }
        expect(seen.size).toBe(PROBES_PER_CASCADE);
    });

    it('wraps world positions below zero as it does those above', () => {
        expect(cellIndex(-1, -1, -1)).toBe(cellIndex(PROBES_X - 1, PROBES_Y - 1, PROBES_Z - 1));
        expect(cellIndex(PROBES_X, PROBES_Y, PROBES_Z)).toBe(cellIndex(0, 0, 0));
        expect(cellIndex(-PROBES_X - 3, 2, 5)).toBe(cellIndex(PROBES_X - 3, 2, 5));
    });

    it('keeps every cascade\'s maps inside the atlas, apart from one another', () => {
        const last = GI_CASCADES - 1;
        const [irradianceX, irradianceY] = irradianceOrigin(last, ATLAS_COLUMNS - 1, ATLAS_ROWS - 1);
        expect(irradianceX + IRRADIANCE_CELL).toBeLessThanOrEqual(ATLAS_IRRADIANCE_WIDTH);
        expect(irradianceY + IRRADIANCE_CELL).toBeLessThanOrEqual(ATLAS_HEIGHT);
        const [visibilityX, visibilityY] = visibilityOrigin(last, ATLAS_COLUMNS - 1, ATLAS_ROWS - 1);
        expect(visibilityX + VISIBILITY_CELL).toBeLessThanOrEqual(ATLAS_WIDTH);
        expect(visibilityY + VISIBILITY_CELL).toBeLessThanOrEqual(ATLAS_HEIGHT);
        expect(visibilityOrigin(0, 0, 0)[0]).toBe(ATLAS_IRRADIANCE_WIDTH);
    });

    it('keeps each probe\'s moved position in a texel of its own, below the irradiance maps', () => {
        const [firstX, firstY] = offsetTexel(0, 0, 0);
        expect(firstX).toBe(0);
        expect(firstY).toBeGreaterThanOrEqual(irradianceOrigin(last(), 0, ATLAS_ROWS - 1)[1] + IRRADIANCE_CELL);
        const [lastX, lastY] = offsetTexel(last(), ATLAS_COLUMNS - 1, ATLAS_ROWS - 1);
        expect(lastX).toBeLessThan(ATLAS_IRRADIANCE_WIDTH);
        expect(lastY).toBeLessThan(ATLAS_HEIGHT);
        const seen = new Set<string>();
        for (let cascade = 0; cascade < GI_CASCADES; cascade++) {
            for (let cell = 0; cell < PROBES_PER_CASCADE; cell++) {
                const { column, row } = cellPlace(cell);
                seen.add(offsetTexel(cascade, column, row).join());
            }
        }
        expect(seen.size).toBe(GI_CASCADES * PROBES_PER_CASCADE);
    });
});

describe('a cascade following the camera', () => {
    it('centres itself on the camera', () => {
        const cascade = new ProbeCascade(0, 2);
        cascade.recentre(101, 7, -33);
        const [x, y, z] = cascade.corner();
        expect(101).toBeGreaterThan(x);
        expect(101).toBeLessThan(x + (PROBES_X - 1) * 2);
        expect(7).toBeGreaterThan(y);
        expect(7).toBeLessThan(y + (PROBES_Y - 1) * 2);
        expect(-33).toBeGreaterThan(z);
        expect(-33).toBeLessThan(z + (PROBES_Z - 1) * 2);
    });

    it('has every probe to fill at first, and clears every cell', () => {
        const cascade = new ProbeCascade(0, 1);
        expect(cascade.recentre(0, 0, 0)).toHaveLength(PROBES_PER_CASCADE);
        expect(cascade.pending).toBe(PROBES_PER_CASCADE);
    });

    it('touches nothing while the camera stays within a cell', () => {
        const cascade = new ProbeCascade(0, 2);
        cascade.recentre(1, 1, 1);
        expect(cascade.recentre(1.5, 1.5, 1.5)).toHaveLength(0);
        expect(cascade.recentre(1, 1, 1)).toHaveLength(0);
    });

    it('only touches the slab that came into range', () => {
        const cascade = new ProbeCascade(0, 2);
        cascade.recentre(0, 0, 0);
        expect(cascade.recentre(2, 0, 0)).toHaveLength(PROBES_Y * PROBES_Z);
        expect(cascade.recentre(2, 0, 2)).toHaveLength(PROBES_X * PROBES_Y);
        expect(cascade.recentre(2, 2, 2)).toHaveLength(PROBES_X * PROBES_Z);
    });

    it('starts over when the camera jumps past the whole grid', () => {
        const cascade = new ProbeCascade(0, 1);
        cascade.recentre(0, 0, 0);
        expect(cascade.recentre(1000, 0, 0)).toHaveLength(PROBES_PER_CASCADE);
    });

    it('places each scheduled probe inside the grid, at the world position its cell stands for', () => {
        const cascade = new ProbeCascade(1, 3);
        cascade.recentre(-50, 12, 77);
        cascade.recentre(-44, 12, 80);
        const probes: ScheduledProbe[] = [];
        cascade.take(PROBES_PER_CASCADE, probes);
        const [x, y, z] = cascade.corner();
        const places = new Set<number>();
        for (const probe of probes) {
            expect(probe.x).toBeGreaterThanOrEqual(x);
            expect(probe.x).toBeLessThanOrEqual(x + (PROBES_X - 1) * 3);
            expect(probe.y).toBeGreaterThanOrEqual(y);
            expect(probe.y).toBeLessThanOrEqual(y + (PROBES_Y - 1) * 3);
            expect(probe.z).toBeGreaterThanOrEqual(z);
            expect(probe.z).toBeLessThanOrEqual(z + (PROBES_Z - 1) * 3);
            expect(cellIndex(Math.round(probe.x / 3), Math.round(probe.y / 3 - GRID_LIFT), Math.round(probe.z / 3))).toBe(probe.cell);
            places.add(probe.cell);
        }
        expect(places.size).toBe(PROBES_PER_CASCADE);
    });

    it('fills probes nearest the camera first', () => {
        const cascade = new ProbeCascade(0, 1);
        cascade.recentre(0, 0, 0);
        const probes: ScheduledProbe[] = [];
        cascade.take(32, probes);
        for (const probe of probes) expect(Math.abs(probe.x) + Math.abs(probe.y) + Math.abs(probe.z)).toBeLessThanOrEqual(7);
    });

    it('sweeps over every probe in time, once none wait', () => {
        const cascade = new ProbeCascade(0, 1);
        cascade.recentre(0, 0, 0);
        const first: ScheduledProbe[] = [];
        cascade.take(PROBES_PER_CASCADE, first);
        expect(cascade.pending).toBe(0);
        const swept: ScheduledProbe[] = [];
        for (let frame = 0; frame < PROBES_PER_CASCADE / 64; frame++) cascade.take(64, swept);
        expect(new Set(swept.map(probe => probe.cell)).size).toBe(PROBES_PER_CASCADE);
    });

    it('serves probes that just came into range before the sweep', () => {
        const cascade = new ProbeCascade(0, 1);
        cascade.recentre(0, 0, 0);
        cascade.take(PROBES_PER_CASCADE, []);
        const entered = cascade.recentre(1, 0, 0);
        const next: ScheduledProbe[] = [];
        cascade.take(entered.length, next);
        expect(new Set(next.map(probe => probe.cell))).toEqual(new Set(entered));
    });
});

describe('the rays and the plans', () => {
    it('spreads rays evenly over the sphere', () => {
        const directions = sphericalFibonacci(64);
        let x = 0, y = 0, z = 0;
        for (let index = 0; index < 64; index++) {
            const at = index * 3;
            expect(Math.hypot(directions[at], directions[at + 1], directions[at + 2])).toBeCloseTo(1);
            x += directions[at];
            y += directions[at + 1];
            z += directions[at + 2];
        }
        expect(Math.hypot(x, y, z) / 64).toBeLessThan(0.05);
    });

    it('never plans more than the passes have room for', () => {
        for (const plan of Object.values(GI_QUALITY)) {
            expect(plan.rays).toBeLessThanOrEqual(MAX_RAYS_PER_PROBE);
            expect(plan.probes.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(MAX_PROBES_PER_FRAME);
            expect(plan.probes).toHaveLength(GI_CASCADES);
        }
    });
});

describe('settings', () => {
    it('fills in what is missing and keeps values in range', () => {
        expect(resolveDynamicGiSettings(null).quality).toBe('medium');
        expect(resolveDynamicGiSettings({ quality: 'ultra' }).quality).toBe('medium');
        expect(resolveDynamicGiSettings({ quality: 'high' }).quality).toBe('high');
        expect(resolveDynamicGiSettings({ spacing: 0 }).spacing).toBe(0.5);
        expect(resolveDynamicGiSettings({ spacing: 100 }).spacing).toBe(8);
        expect(resolveDynamicGiSettings({ intensity: NaN }).intensity).toBe(1);
        expect(resolveDynamicGiSettings({ bounce: 5 }).bounce).toBe(1);
        expect(resolveDynamicGiSettings({ view: 'nonsense' }).view).toBe('lit');
        expect(resolveDynamicGiSettings({ view: 'rays' }).view).toBe('rays');
        expect(resolveDynamicGiSettings(null).reflections).toBe(true);
        expect(resolveDynamicGiSettings({ reflections: false }).reflections).toBe(false);
        expect(resolveDynamicGiSettings({ reflections: 'yes' }).reflections).toBe(true);
    });
});
