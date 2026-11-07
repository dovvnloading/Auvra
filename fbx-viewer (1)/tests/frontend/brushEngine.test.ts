import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BUILT_IN_ALPHAS, BUILT_IN_BRUSHES, PRESET_KEYS, PRESSURE_CURVES, alphaPixels, applyPreset, presetFrom, readPresets } from '../../texturing/paint/brushLibrary';
import { DEFAULT_BRUSH, MAX_COPIES, copiesOf, curvePressure, lazyFollow, type BrushSettings } from '../../texturing/paint/strokes';

const curve = (id: string) => PRESSURE_CURVES.find((each) => each.id === id)!.curve;

/** Where a copy takes a point. */
const moved = (copy: ReturnType<typeof copiesOf>[number], point: THREE.Vector3): THREE.Vector3 => (copy.matrix ? point.clone().applyMatrix4(new THREE.Matrix4().fromArray(copy.matrix)) : point.clone());

describe('pen pressure', () => {
    it('follows its curve: even keeps it, soft lifts it, firm holds it back', () => {
        for (const p of [0, 0.1, 0.3, 0.5, 0.8, 1]) expect(curvePressure(p, curve('linear'))).toBeCloseTo(p, 3);
        expect(curvePressure(0.3, curve('soft'))).toBeGreaterThan(0.45);
        expect(curvePressure(0.3, curve('firm'))).toBeLessThan(0.15);
        for (const { curve: each } of PRESSURE_CURVES) {
            expect(curvePressure(0, each)).toBeCloseTo(0, 3);
            expect(curvePressure(1, each)).toBeCloseTo(1, 3);
            expect(curvePressure(-1, each)).toBeCloseTo(0, 3);
            // Pressing harder never gives less.
            let last = 0;
            for (let p = 0; p <= 1; p += 0.05) { const value = curvePressure(p, each); expect(value).toBeGreaterThanOrEqual(last - 1e-9); last = value; }
        }
    });
});

describe('lazy mouse', () => {
    it('stays put within the string and is pulled straight after the pointer past it', () => {
        expect(lazyFollow({ x: 10, y: 10 }, { x: 13, y: 14 }, 6)).toEqual({ x: 10, y: 10 });
        const pulled = lazyFollow({ x: 0, y: 0 }, { x: 30, y: 40 }, 10);
        expect(Math.hypot(30 - pulled.x, 40 - pulled.y)).toBeCloseTo(10, 6);
        expect(pulled.x / pulled.y).toBeCloseTo(30 / 40, 6);
        expect(lazyFollow({ x: 0, y: 0 }, { x: 5, y: 5 }, 0)).toEqual({ x: 5, y: 5 });
    });
});

describe('the brush library', () => {
    it('keeps how a brush feels, never what it paints or where', () => {
        const brush: BrushSettings = { ...DEFAULT_BRUSH, size: 77, hardness: 0.3, mode: 'blur', pressureCurve: [0.1, 0.45, 0.35, 0.95] };
        const preset = presetFrom(brush, '  Wide blur  ');
        expect(preset.name).toBe('Wide blur');
        expect(Object.keys(preset.settings).sort()).toEqual([...PRESET_KEYS].sort());
        expect(preset.settings).not.toHaveProperty('values');
        expect(preset.settings).not.toHaveProperty('symmetry');
        const other: BrushSettings = { ...DEFAULT_BRUSH, values: { ...DEFAULT_BRUSH.values, baseColor: [0, 1, 0] }, channels: ['roughness'], symmetry: { x: true, y: false, z: false } };
        const applied = applyPreset(other, preset);
        expect(applied.size).toBe(77);
        expect(applied.mode).toBe('blur');
        expect(applied.pressureCurve).toEqual([0.1, 0.45, 0.35, 0.95]);
        expect(applied.values.baseColor).toEqual([0, 1, 0]);
        expect(applied.channels).toEqual(['roughness']);
        expect(applied.symmetry.x).toBe(true);
        // The preset holds its own copy.
        applied.pressureCurve[0] = 0.9;
        expect(preset.settings.pressureCurve![0]).toBe(0.1);
    });

    it('reads saved presets back safely', () => {
        const kept = JSON.parse(JSON.stringify([presetFrom(DEFAULT_BRUSH, 'Mine', 'brush:1')]));
        expect(readPresets(kept)).toEqual(kept);
        const odd = readPresets([{ id: 'b', name: 'Odd', settings: { size: 'big', hardness: 0.5, values: [1, 2, 3], pressureCurve: [0, 2, 1], mode: 'smudge' } }, { name: 'No id' }, 'junk']);
        expect(odd).toEqual([{ id: 'b', name: 'Odd', settings: { hardness: 0.5, mode: 'smudge' } }]);
        expect(readPresets(null)).toEqual([]);
    });

    it('has built-in brushes and alphas that are all there', () => {
        expect(new Set(BUILT_IN_BRUSHES.map((preset) => preset.id)).size).toBe(BUILT_IN_BRUSHES.length);
        for (const preset of BUILT_IN_BRUSHES) {
            if (preset.settings.alphaTexture) expect(BUILT_IN_ALPHAS.some((alpha) => alpha.id === preset.settings.alphaTexture)).toBe(true);
        }
        for (const alpha of BUILT_IN_ALPHAS) {
            const pixels = alphaPixels(alpha.id, 64)!;
            expect(pixels).toHaveLength(64 * 64);
            expect(Math.min(...pixels)).toBeGreaterThanOrEqual(0);
            expect(Math.max(...pixels)).toBeLessThanOrEqual(1);
            expect(Math.max(...pixels)).toBeGreaterThan(0.5);
            // Nothing in the corners: the brush fades out inside its square.
            expect(pixels[0]).toBe(0);
            expect(pixels[64 * 64 - 1]).toBe(0);
        }
        expect(alphaPixels('nope')).toBeNull();
    });
});

describe('brush copies', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));

    it('mirror across a plane square to an axis, moved by the offset', () => {
        expect(copiesOf(DEFAULT_BRUSH, box)).toHaveLength(1);
        const mirrored = copiesOf({ symmetry: { x: true, y: false, z: false, offset: [0.25, 0, 0] }, radial: { count: 1, axis: 'y' } }, box);
        expect(mirrored).toHaveLength(2);
        // The plane sits a quarter of the size (2) along X: at x = 0.5.
        const p = moved(mirrored[1], new THREE.Vector3(0.9, 0.3, -0.2));
        expect(p.x).toBeCloseTo(0.1, 6);
        expect(p.y).toBeCloseTo(0.3, 6);
        expect(moved(mirrored[1], new THREE.Vector3(0.5, 0, 0)).x).toBeCloseTo(0.5, 6);
    });

    it('turn round an axis, with mirrors, up to the most copies', () => {
        const turned = copiesOf({ symmetry: { x: false, y: false, z: false }, radial: { count: 4, axis: 'y' } }, box);
        expect(turned).toHaveLength(4);
        const points = turned.map((copy) => moved(copy, new THREE.Vector3(1, 0.5, 0)));
        for (const point of points) {
            expect(Math.hypot(point.x, point.z)).toBeCloseTo(1, 6);
            expect(point.y).toBeCloseTo(0.5, 6);
        }
        expect(points[1].z).toBeCloseTo(-1, 6);
        expect(copiesOf({ symmetry: { x: true, y: false, z: false }, radial: { count: 3, axis: 'z' } }, box)).toHaveLength(6);
        expect(copiesOf({ symmetry: { x: true, y: true, z: false }, radial: { count: 16, axis: 'z' } }, box)).toHaveLength(MAX_COPIES);
    });
});
