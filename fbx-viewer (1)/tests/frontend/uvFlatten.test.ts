import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { flatAngles, flattenChart } from '../../texturing/uv/lscm';
import { buildCharts, buildTopology } from '../../texturing/uv/uvTopology';

/** A geometry's welded surface and its one chart (no seams). */
const chartOf = (geometry: THREE.BufferGeometry) => {
    const positions = geometry.getAttribute('position').array as Float32Array;
    const indices = geometry.index ? Array.from(geometry.index.array) : Array.from({ length: positions.length / 3 }, (_, i) => i);
    const topology = buildTopology(positions, indices);
    const charts = buildCharts(topology, new Set());
    return { topology, chart: charts[0], charts };
};

describe('angle-based flattening', () => {
    it('evens angles out until every inner vertex makes a full turn and every triangle a half turn', () => {
        // A fan of five triangles round a raised middle: its angles round the middle add up to less than a full turn.
        const fan = new THREE.BufferGeometry();
        const rim = Array.from({ length: 5 }, (_, i) => [Math.cos((i / 5) * Math.PI * 2), 0, Math.sin((i / 5) * Math.PI * 2)]);
        fan.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.6, 0, ...rim.flat()], 3));
        fan.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5, 0, 5, 1].map((v, i) => (i % 3 === 0 ? 0 : v)));
        const { topology, chart } = chartOf(fan);
        const p = topology.positions;
        const angles = new Float64Array(chart.faces.length * 3);
        chart.faces.forEach((f, t) => {
            for (let k = 0; k < 3; k++) {
                const [a, b, c] = [0, 1, 2].map((j) => topology.faces[f * 3 + (k + j) % 3] * 3);
                const u = new THREE.Vector3(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
                const v = new THREE.Vector3(p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]);
                angles[t * 3 + k] = u.angleTo(v);
            }
        });
        const inner = new Set<number>();
        const uses = new Map<string, number>();
        for (let t = 0; t < chart.faces.length; t++) for (let k = 0; k < 3; k++) {
            const a = chart.corners[t * 3 + k], b = chart.corners[t * 3 + (k + 1) % 3];
            const key = a < b ? `${a},${b}` : `${b},${a}`;
            uses.set(key, (uses.get(key) ?? 0) + 1);
        }
        const edge = new Set<number>();
        for (const [key, count] of uses) if (count === 1) for (const v of key.split(',')) edge.add(Number(v));
        for (let v = 0; v < chart.vertexWeld.length; v++) if (!edge.has(v)) inner.add(v);
        expect(inner.size).toBeGreaterThan(0);
        const before = [...inner].map((v) => Array.from(chart.corners).reduce((sum, corner, i) => sum + (corner === v ? angles[i] : 0), 0));
        expect(Math.min(...before)).toBeLessThan(2 * Math.PI - 0.1);
        const flat = flatAngles(angles, chart.corners, inner, 200);
        for (const v of inner) {
            const sum = Array.from(chart.corners).reduce((total, corner, i) => total + (corner === v ? flat[i] : 0), 0);
            expect(sum).toBeCloseTo(2 * Math.PI, 2);
        }
        for (let t = 0; t < chart.faces.length; t++) expect(flat[t * 3] + flat[t * 3 + 1] + flat[t * 3 + 2]).toBeCloseTo(Math.PI, 2);
    });

    it('lays a flat sheet out unstretched either way, and a rounded cap without folds', () => {
        const sheet = chartOf(new THREE.PlaneGeometry(2, 2, 4, 4));
        for (const method of ['conformal', 'angleBased'] as const) {
            const result = flattenChart(sheet.topology, sheet.chart, method);
            expect(result.flipped).toBe(0);
            expect(result.worstStretch).toBeLessThan(1.01);
        }
        // A cap of a ball, out to 60 degrees from its pole.
        const cap = chartOf(new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 3));
        expect(cap.charts).toHaveLength(1);
        const conformal = flattenChart(cap.topology, cap.chart, 'conformal');
        const angleBased = flattenChart(cap.topology, cap.chart, 'angleBased');
        expect(angleBased.flipped).toBe(0);
        expect(angleBased.overlapping).toBe(0);
        expect(angleBased.meanStretch).toBeLessThan(1.5);
        // The two differ: the angle-based layout is not the conformal one.
        expect(Array.from(angleBased.uv).some((value, i) => Math.abs(value - conformal.uv[i]) > 1e-4)).toBe(true);
    });
});
