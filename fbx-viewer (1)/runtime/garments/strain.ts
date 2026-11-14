import type { CookedGarment } from './pattern';

export type GarmentStrainView = 'off' | 'warp' | 'weft' | 'shear';
export type ActiveStrainView = Exclude<GarmentStrainView, 'off'>;

/** Stretch is fractional length change. Shear is the change from a right angle, in degrees. */
export const GARMENT_STRAIN_SCALE = { warp: .2, weft: .2, shear: 30 } as const;

/**
 * CPU vertex colors shared by all renderers. Construct only for a requested overlay.
 * Each triangle stores inv(Dm) in warp/weft coordinates and its undeformed area.
 * The per-frame working buffers are reused for the life of the cook.
 */
export class GarmentStrainMap {
    readonly colors: Float32Array;
    /** Raw signed, rest-area-weighted average at each vertex. Invalid samples are NaN. */
    readonly values: Float32Array;
    private readonly indices: Uint32Array;
    private readonly inverseAndArea: Float64Array;
    private readonly sums: Float64Array;
    private readonly weights: Float64Array;

    constructor(cook: CookedGarment) {
        const count = cook.positions.length / 3;
        this.colors = new Float32Array(count * 3);
        this.values = new Float32Array(count);
        this.sums = new Float64Array(count);
        this.weights = new Float64Array(count);
        this.indices = cook.indices;
        this.inverseAndArea = new Float64Array(cook.indices.length / 3 * 5);
        const uv = cook.materialUV;
        for (let i = 0, k = 0; i < this.indices.length; i += 3, k += 5) {
            const a = 2 * this.indices[i], b = 2 * this.indices[i + 1], c = 2 * this.indices[i + 2];
            const u1 = uv[b] - uv[a], v1 = uv[b + 1] - uv[a + 1];
            const u2 = uv[c] - uv[a], v2 = uv[c + 1] - uv[a + 1];
            const det = u1 * v2 - u2 * v1;
            if (!Number.isFinite(det) || Math.abs(det) <= 1e-14) continue;
            this.inverseAndArea[k] = v2 / det;
            this.inverseAndArea[k + 1] = -u2 / det;
            this.inverseAndArea[k + 2] = -v1 / det;
            this.inverseAndArea[k + 3] = u1 / det;
            this.inverseAndArea[k + 4] = Math.abs(det) * .5;
        }
    }

    update(positions: ArrayLike<number>, view: ActiveStrainView): void {
        if (positions.length !== this.colors.length) throw new Error('Strain map positions do not match the garment cook.');
        this.sums.fill(0);
        this.weights.fill(0);
        const rest = this.inverseAndArea, indices = this.indices;
        for (let i = 0, k = 0; i < indices.length; i += 3, k += 5) {
            const area = rest[k + 4];
            if (area === 0) continue;
            const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
            const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
            const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
            let value: number;
            if (view === 'shear') {
                const ux = e1x * rest[k] + e2x * rest[k + 2], uy = e1y * rest[k] + e2y * rest[k + 2], uz = e1z * rest[k] + e2z * rest[k + 2];
                const vx = e1x * rest[k + 1] + e2x * rest[k + 3], vy = e1y * rest[k + 1] + e2y * rest[k + 3], vz = e1z * rest[k + 1] + e2z * rest[k + 3];
                const denom = Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz);
                if (!(denom > 1e-12)) continue;
                const cosine = (ux * vx + uy * vy + uz * vz) / denom;
                value = Math.asin(Math.max(-1, Math.min(1, cosine))) * (180 / Math.PI);
            } else {
                const col = view === 'warp' ? k : k + 1;
                const p = rest[col], q = rest[col + 2];
                value = Math.hypot(e1x * p + e2x * q, e1y * p + e2y * q, e1z * p + e2z * q) - 1;
            }
            if (!Number.isFinite(value)) continue;
            const weighted = value * area;
            for (let j = 0; j < 3; j++) {
                const v = indices[i + j];
                this.sums[v] += weighted;
                this.weights[v] += area;
            }
        }
        const range = GARMENT_STRAIN_SCALE[view];
        for (let v = 0; v < this.values.length; v++) {
            const i = 3 * v;
            const value = this.weights[v] ? this.sums[v] / this.weights[v] : NaN;
            this.values[v] = value;
            if (!Number.isFinite(value)) {
                // Charcoal reserves a distinct color for an undefined local measurement.
                this.colors[i] = this.colors[i + 1] = this.colors[i + 2] = .035;
                continue;
            }
            const t = Math.min(1, Math.abs(value) / range);
            // Interpolate linear RGB from light grey to signed blue or red endpoints.
            this.colors[i] = .8 + t * (value < 0 ? -.785 : .2);
            this.colors[i + 1] = .8 + t * (value < 0 ? -.66 : -.765);
            this.colors[i + 2] = .8 + t * (value < 0 ? .15 : -.79);
        }
    }
}
