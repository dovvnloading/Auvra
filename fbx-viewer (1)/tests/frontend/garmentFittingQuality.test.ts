import { describe, expect, it } from 'vitest';
import { BufferAttribute, Ray, Triangle, Vector3 } from 'three';
import { cookComponentGarment, GarmentInstance, readGarmentSettings } from '../../runtime/components/garmentComponent';
import { createComponent } from '../../runtime/components/registry';
import type { GarmentStitch } from '../../runtime/garments/pattern';
import { GARMENT_STEP } from '../../runtime/garments/solver';

/** An independent distance query using Three's public geometry primitives. The unit-radius
 * capsule occupies a line segment swept by a sphere. A triangle can cross the axis, meet
 * it closest at either cap, or attain its closest point along a triangle edge. */
class CapsuleAudit {
    private readonly lower: Vector3;
    private readonly upper: Vector3;
    private readonly axis: Ray;
    private readonly closest = new Vector3();
    private readonly tri = new Triangle();

    constructor(halfSpan: number) {
        this.lower = new Vector3(0, -halfSpan, 0);
        this.upper = new Vector3(0, halfSpan, 0);
        this.axis = new Ray(this.lower, new Vector3(0, 1, 0));
    }

    squaredDistance(a: Vector3, b: Vector3, c: Vector3): number {
        this.tri.set(a, b, c);
        if (this.axis.intersectTriangle(a, b, c, false, this.closest) && this.closest.y <= this.upper.y) return 0;
        let result = this.tri.closestPointToPoint(this.lower, this.closest).distanceToSquared(this.lower);
        result = Math.min(result, this.tri.closestPointToPoint(this.upper, this.closest).distanceToSquared(this.upper));
        for (const [u, v] of [[a, b], [b, c], [c, a]]) {
            const distance = this.axis.distanceSqToSegment(u, v, this.closest);
            // The cap-to-triangle tests cover a closest point beyond the end of this finite axis.
            if (this.closest.y <= this.upper.y) result = Math.min(result, distance);
        }
        return Math.max(0, result);
    }
}

function stitchGaps(positions: BufferAttribute, seams: readonly GarmentStitch[]) {
    const a = new Vector3(), b = new Vector3();
    const gaps = seams.map(stitch => a.fromBufferAttribute(positions, stitch.a)
        .distanceTo(b.fromBufferAttribute(positions, stitch.b))).sort((x, y) => x - y);
    return { p95: gaps[Math.ceil(gaps.length * 0.95) - 1], max: gaps[gaps.length - 1] };
}

describe('default garment fitting quality', () => {
    it('keeps the presented triangles outside the moving torso and closes the four seams', () => {
        const component = createComponent('garment');
        const settings = { ...readGarmentSettings(component), wind: 0 };
        const cooked = cookComponentGarment(component.props.pattern);
        const garment = new GarmentInstance(cooked, settings.fabric, settings.selfCollision);
        try {
            const geometry = garment.mesh.geometry;
            const positions = geometry.getAttribute('position') as BufferAttribute;
            const triangles = geometry.getIndex()!;
            const proxy = garment.torso.geometry;
            proxy.computeBoundingBox();
            const radius = proxy.parameters.radius;
            // Read the dimensions and scale of the visible body. In the normalized frame it
            // has unit radius; the actor's animated translation is removed afresh each tick.
            const halfSpan = (proxy.boundingBox!.max.y - radius) / radius;
            const radii = garment.torso.scale.clone().multiplyScalar(radius);
            const audit = new CapsuleAudit(halfSpan);
            const vertices = Array.from({ length: positions.count }, () => new Vector3());

            expect(settings.animateTorso).toBe(true);
            expect(settings.selfCollision).toBe(false);
            expect(new Set(cooked.seams.map(stitch => stitch.seamId)).size).toBe(4);
            expect(triangles.count / 3).toBe(842);
            const end = Math.round(2 / GARMENT_STEP);
            let minGap = Infinity, worstTick = -1, worstFace = -1;
            for (let tick = 0; tick <= end; tick++) {
                if (tick) garment.advance(GARMENT_STEP, settings, 'fitting-regression');
                for (let i = 0; i < vertices.length; i++) {
                    vertices[i].fromBufferAttribute(positions, i).sub(garment.torso.position).divide(radii);
                }
                for (let i = 0; i < triangles.count; i += 3) {
                    const d2 = audit.squaredDistance(vertices[triangles.getX(i)],
                        vertices[triangles.getX(i + 1)], vertices[triangles.getX(i + 2)]);
                    if (!Number.isFinite(d2)) throw new Error(`Invalid distance at tick ${tick}, face ${i / 3}`);
                    // This is a normalized radial gap expressed in z-radius metres, not a world-space distance.
                    const gap = (Math.sqrt(d2) - 1) * radii.z;
                    if (gap < minGap) { minGap = gap; worstTick = tick; worstFace = i / 3; }
                }
                if (tick === Math.round(0.5 / GARMENT_STEP) || tick === end) {
                    const { p95, max } = stitchGaps(positions, cooked.seams);
                    expect(p95, `95th percentile stitch gap at tick ${tick} (m)`).toBeLessThan(0.001);
                    expect(max, `maximum stitch gap at tick ${tick} (m)`).toBeLessThan(0.002);
                }
            }
            // Allow one micron of roundoff. The original point-only contact path missed face
            // interiors by more than a millimetre, even when every vertex cleared the torso.
            expect(minGap, `minimum radial clearance at tick ${worstTick}, face ${worstFace} (m)`)
                .toBeGreaterThanOrEqual(-0.000001);
            expect(garment.simulation.time).toBeCloseTo(2, 8);
            expect(Math.abs(garment.torso.position.x)).toBeGreaterThan(0.01);
        } finally {
            garment.dispose();
        }
    }, 15000);
});
