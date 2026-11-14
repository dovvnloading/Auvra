import { describe, expect, it } from 'vitest';
import { calibrateSwatches, readSwatchMeasurements, SWATCH_HEADER } from '../../runtime/garments/swatchCalibration';
import { GarmentSimulation, GARMENT_STEP } from '../../runtime/garments/solver';
import { cookGarment, type GarmentPattern } from '../../runtime/garments/pattern';

const csv = (...rows: string[]) => [SWATCH_HEADER, ...rows].join('\n');
const tensile = (e: number, width: number, k: number) => width * k * (1 + e) * (((1 + e) ** 2 - 1) / 2);

describe('calibration from tared swatch measurements', () => {
    it('recovers independent constants, weighing, and signed shear including finite-strain weft coupling', () => {
        const rows = ['mass,50,100,,,1.25', 'mass,100,100,,,2.5'];
        for (const e of [.012, .04, .21]) {
            rows.push('warp,50,100,' + 100 * e + ',' + tensile(e, .05, 1450) + ',');
            rows.push('weft,100,100,' + 100 * e + ',' + tensile(e, .1, 2400) + ',');
        }
        // Independent finite difference of the solver's shear + Green weft energy per rest area.
        const energy = (g: number) => .5 * 225 * g * g + .5 * 2400 * (g * g / 2) ** 2;
        for (const g of [-.35, -.12, .14, .31]) {
            const load = .05 * (energy(g + 1e-6) - energy(g - 1e-6)) / 2e-6;
            rows.push('shear,50,80,' + 80 * g + ',' + load + ',');
        }
        const fit = calibrateSwatches(csv(...rows.reverse()), 0);
        expect(fit.properties.arealDensity).toBeCloseTo(.25, 12);
        expect(fit.properties.warp).toBeCloseTo(1450, 8);
        expect(fit.properties.weft).toBeCloseTo(2400, 8);
        expect(fit.properties.shear).toBeCloseTo(225, 6);
        expect(fit.shearWeftSource).toBe('measured');
        for (const row of fit.fits) expect(row.maximum).toBeLessThan(1e-7);
        expect(fit.fits.map(row => row.count)).toEqual([2, 3, 3, 4]);
    });

    it('reports noisy residuals in observed units and accepts a signed transverse displacement', () => {
        const read = csv('warp,50,100,10,12,', 'warp,50,100,10,14,', 'shear,40,100,-10,-.5,');
        const fit = calibrateSwatches(read.replaceAll(',', '\t'), 1000);
        expect(fit.fits[0].rms).toBeCloseTo(1, 12);
        expect(fit.fits[0].residualUnit).toBe('N');
        expect(fit.properties.shear).toBeCloseTo(120, 9);
        expect(fit.shearWeftSource).toBe('current');
        expect(fit.properties.weft).toBeUndefined();
    });

    it('rejects misleading or unidentifiable inputs before returning any patch', () => {
        const bad = ['warp,50,100,0,4,', 'weft,50,0,10,4,', 'warp,50,100,2,-7,',
            'mass,20,20,0,,1', 'mass,20,20,,,Infinity', 'warp,20,20,0x10,1,', 'shear,30,30,10,.00001,'];
        for (const row of bad) expect(() => calibrateSwatches(csv('mass,20,20,,,.1', row), 5000)).toThrow();
        expect(() => readSwatchMeasurements(csv(...Array<string>(513).fill('mass,20,20,,,.1')))).toThrow(/512/);
        expect(() => readSwatchMeasurements('z'.repeat(65537))).toThrow(/64/);
        expect(() => readSwatchMeasurements('test,width,gauge\n')).toThrow(/header/);
    });

    it('carries the calibrated warp into a live loaded strip, predicting deformation under its own weight', () => {
        const data = csv('mass,50,100,,,1.25', 'warp,50,100,2,' + tensile(.02, .05, 100) + ',');
        const fit = calibrateSwatches(data, 100);
        const pattern: GarmentPattern = { version: 1, edgeLength: .15, seams: [], panels: [{
            id: 'strip', name: 'Strip', grain: [0, 1], pins: ['c', 'd'],
            placement: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0] },
            boundary: [{ id:'a', x:0, y:0 }, { id:'b', x:.05, y:0 },
                { id:'c', x:.05, y:.10 }, { id:'d', x:0, y:.10 }],
        }] };
        const mesh = cookGarment(pattern);
        const sim = new GarmentSimulation(mesh, { ...fit.properties, damping: 18, shear: 100, weft: 100 });
        for (let i = 0; i < 480; i++) sim.step(GARMENT_STEP);
        let y = 0, count = 0;
        for (let i = 0; i < mesh.positions.length; i += 3) {
            if (mesh.positions[i+1] === 0) { y += sim.positions[i+1]; count++; }
        }
        // Small-strain extension integrated under distributed gravity: rho*g*L²/(2*K).
        const predicted = .25 * 9.81 * .1 ** 2 / (2 * 100);
        expect(count).toBeGreaterThan(0);
        expect(-y / count).toBeGreaterThan(.65 * predicted);
        expect(-y / count).toBeLessThan(1.35 * predicted);
    });
});
