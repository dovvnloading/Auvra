import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unzipSync } from 'three/addons/libs/fflate.module.js';
import { expect, it } from 'vitest';
import { cookComponentGarment, GarmentInstance, readGarmentSettings } from '../../runtime/components/garmentComponent';
import { readFabricOverrides } from '../../runtime/garments/fitting';
import { GARMENT_STEP } from '../../runtime/garments/solver';
import type { CookedGarment, GarmentPanelRange } from '../../runtime/garments/pattern';
import type { LevelObject } from '../../types';

// Vertical ray through each overlay vertex. The support is a single-valued surface in XZ in this fixture.
function clearance(mesh: CookedGarment, positions: Float32Array, base: GarmentPanelRange, overlay: GarmentPanelRange): number[] {
    const samples: number[] = [];
    for (let v = overlay.vertexStart; v < overlay.vertexStart + overlay.vertexCount; v++) {
        const x = positions[3*v], y = positions[3*v+1], z = positions[3*v+2];
        let gap = Infinity;
        for (let i = base.indexStart; i < base.indexStart + base.indexCount; i += 3) {
            const a = 3 * mesh.indices[i], b = 3 * mesh.indices[i + 1], c = 3 * mesh.indices[i + 2];
            const ax = positions[a] - positions[c], az = positions[a+2] - positions[c+2];
            const bx = positions[b] - positions[c], bz = positions[b+2] - positions[c+2];
            const det = ax*bz - bx*az;
            if (Math.abs(det) < 1e-12) continue;
            const u = ((x - positions[c])*bz - (z - positions[c+2])*bx) / det;
            const w = (ax*(z - positions[c+2]) - az*(x - positions[c])) / det;
            if (Math.min(u, w, 1-u-w) < -1e-6) continue;
            gap = Math.min(gap, y - (u * positions[a+1] + w * positions[b+1] + (1-u-w) * positions[c+1]));
        }
        expect(Number.isFinite(gap)).toBe(true);
        samples.push(gap);
    }
    return samples;
}

it('drops both archived swatches onto their moving supports and measures contact against the disabled control', () => {
    const path = resolve(__dirname, '../../../docs/examples/Auvra-Layered-Cloth.auvrapack');
    const file = unzipSync(readFileSync(path), { filter: entry => entry.name === 'Project/objects.json' });
    const objects = JSON.parse(new TextDecoder().decode(file['Project/objects.json'])).documents as LevelObject[];
    const studies = objects.flatMap(obj => (obj.components ?? []).filter(c => c.enabled && c.type === 'garment'));
    expect(studies).toHaveLength(2);
    // General self-contact stays off in both arms, so only the authored rank can support the overlay.
    expect(studies.every(c => c.props.selfCollision === false)).toBe(true);
    const meshes = studies.map(c => cookComponentGarment(c.props.pattern));
    expect(meshes[0].positions).toEqual(meshes[1].positions);
    expect(meshes[0].indices).toEqual(meshes[1].indices);
    expect(meshes[0].pins).toEqual(meshes[1].pins);
    expect(meshes.map(m => m.panelRanges[1].layer ?? 0).sort()).toEqual([0, 1]);
    for (const component of studies) {
        const config = readGarmentSettings(component), mesh = cookComponentGarment(component.props.pattern);
        const [base, upper] = mesh.panelRanges;
        expect(base.layer ?? 0).toBe(0);
        const garment = new GarmentInstance(mesh, config.fabric, config.selfCollision,
            readFabricOverrides(config.fabric, component.props.fabricProperties));
        try {
            const initial = clearance(mesh, garment.simulation.positions, base, upper);
            expect(Math.min(...initial)).toBeCloseTo(.085, 5);
            expect(Math.max(...initial)).toBeCloseTo(.085, 5);
            let contacts = 0, limitedTicks = 0;
            for (let step = 0; step < 240; step++) {
                garment.advance(GARMENT_STEP, config, component.id);
                const stats = garment.simulation.selfContactStats;
                if (stats) {
                    contacts += stats.layerProjections;
                    if (stats.limited) limitedTicks++;
                }
                if (step === 119 && upper.layer === 1) {
                    const atOneSecond = clearance(mesh, garment.simulation.positions, base, upper);
                    expect(Math.min(...atOneSecond)).toBeGreaterThan(.0038);
                    expect(Math.max(...atOneSecond)).toBeLessThan(.0058);
                }
            }
            const settled = clearance(mesh, garment.simulation.positions, base, upper);
            if (upper.layer === 1) {
                expect(contacts).toBeGreaterThan(0);
                expect(limitedTicks).toBe(0);
                expect(Math.min(...settled)).toBeGreaterThan(.0038);
                expect(Math.max(...settled)).toBeLessThan(.0058);
            } else {
                expect(contacts).toBe(0);
                expect(Math.max(...settled)).toBeLessThan(-2);
            }
        } finally { garment.dispose(); }
    }
});
