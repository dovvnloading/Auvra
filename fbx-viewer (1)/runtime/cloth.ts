import type { WindVec } from './wind';

/**
 * CLOTH
 *
 * A sheet of cloth: a grid of points joined by stretch, shear and bend links, solved a few times a
 * step so it holds its size, pinned along an edge or at corners to its object (which may move, and
 * carries it along). Gravity pulls it, the wind pushes on each triangle by how square it faces the
 * wind, the air slows it, and it rests against characters (upright capsules) and the ground.
 * Positions are in the world; the object's matrix places the pins each step. Pure: rendering reads
 * `positions` and `indices`.
 */

export type ClothPin = 'top' | 'left' | 'topCorners' | 'corners' | 'none';

export const CLOTH_PINS: readonly ClothPin[] = ['top', 'left', 'topCorners', 'corners', 'none'];

export interface ClothSettings {
    /** Size of the sheet, m: across (local X) and down (local -Y) from its object's origin at the top middle. */
    width: number;
    height: number;
    /** Points along the longer side (the shorter gets as many as keep the cells square), 4 to MAX_CLOTH_RESOLUTION. */
    resolution: number;
    pin: ClothPin;
    /** 0-1: how firmly it keeps its size, and how much it resists folding. */
    stiffness: number;
    bend: number;
    /** 0-1: how quickly the air settles it. */
    damping: number;
    /** kg per square metre. */
    weight: number;
    /** How hard the wind catches it: 1 for ordinary cloth. */
    wind: number;
    /** How far it keeps from what it rests against, m. */
    thickness: number;
}

export const MAX_CLOTH_RESOLUTION = 40;
export const MIN_CLOTH_RESOLUTION = 4;
/** Seconds per simulation step, and most steps a frame. */
export const CLOTH_STEP = 1 / 90;
const MAX_STEPS = 4;
const ITERATIONS = 8;
const GRAVITY = 9.81;
const AIR_DENSITY = 1.2;

/** An upright capsule (a character): its bottom middle, height and radius. */
export interface ClothCollider {
    x: number; y: number; z: number;
    height: number;
    radius: number;
}

export type ClothWind = (x: number, y: number, z: number, out: WindVec) => WindVec;

/** A column-major 4x4 matrix's elements. */
type Matrix = ArrayLike<number>;

const transform = (m: Matrix, x: number, y: number, z: number, out: Float32Array, at: number) => {
    out[at] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[at + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[at + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
};

const _wind: WindVec = { x: 0, y: 0, z: 0 };

export class ClothSimulation {
    readonly columns: number;
    readonly rows: number;
    readonly count: number;
    /** World xyz per point. */
    readonly positions: Float32Array;
    /** Two triangles per cell. */
    readonly indices: Uint32Array;
    /** uv per point, the sheet's top left at (0, 1). */
    readonly uvs: Float32Array;
    private readonly previous: Float32Array;
    private readonly rest: Float32Array;
    private readonly pinned: Uint8Array;
    private readonly forces: Float32Array;
    /** Point pairs, their rest lengths and how stiff each link is. */
    private readonly links: Uint32Array;
    private readonly lengths: Float32Array;
    private readonly stiff: Float32Array;
    private readonly settings: ClothSettings;
    private readonly pointMass: number;
    private carry = 0;
    private placed = false;

    constructor(settings: ClothSettings) {
        this.settings = { ...settings };
        const width = Math.max(0.05, settings.width);
        const height = Math.max(0.05, settings.height);
        const along = Math.round(Math.min(MAX_CLOTH_RESOLUTION, Math.max(MIN_CLOTH_RESOLUTION, settings.resolution)));
        const longest = Math.max(width, height);
        this.columns = Math.max(2, Math.round((along * width) / longest));
        this.rows = Math.max(2, Math.round((along * height) / longest));
        this.count = this.columns * this.rows;
        const n = this.count;
        this.positions = new Float32Array(n * 3);
        this.previous = new Float32Array(n * 3);
        this.rest = new Float32Array(n * 3);
        this.forces = new Float32Array(n * 3);
        this.uvs = new Float32Array(n * 2);
        this.pinned = new Uint8Array(n);
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.columns; c++) {
                const i = r * this.columns + c;
                const u = c / (this.columns - 1), v = r / (this.rows - 1);
                // A ripple of a millimetre or so: a perfectly flat sheet cannot start to fold or drape.
                const ripple = Math.sin(r * 2.3 + c * 1.7) * Math.cos(c * 0.9 - r * 0.6) * 0.002 * Math.max(width, height);
                this.rest.set([(u - 0.5) * width, -v * height, ripple], i * 3);
                this.uvs.set([u, 1 - v], i * 2);
                this.pinned[i] = pinnedAt(settings.pin, r, c, this.rows, this.columns) ? 1 : 0;
            }
        }
        this.pointMass = Math.max(1e-4, (Math.max(0.01, settings.weight) * width * height) / n);

        const indices: number[] = [];
        for (let r = 0; r < this.rows - 1; r++) {
            for (let c = 0; c < this.columns - 1; c++) {
                const a = r * this.columns + c, b = a + 1, d = a + this.columns, e = d + 1;
                indices.push(a, d, b, b, d, e);
            }
        }
        this.indices = Uint32Array.from(indices);

        const links: number[] = [];
        const stiff: number[] = [];
        const stretch = Math.min(1, Math.max(0.05, settings.stiffness));
        const fold = Math.min(1, Math.max(0, settings.bend)) * 0.5;
        const link = (a: number, b: number, k: number) => {
            if (k <= 0) return;
            links.push(a, b);
            stiff.push(k);
        };
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.columns; c++) {
                const i = r * this.columns + c;
                if (c + 1 < this.columns) link(i, i + 1, stretch);
                if (r + 1 < this.rows) link(i, i + this.columns, stretch);
                if (c + 1 < this.columns && r + 1 < this.rows) {
                    // Cloth gives easily on the bias.
                    link(i, i + this.columns + 1, stretch * 0.35);
                    link(i + 1, i + this.columns, stretch * 0.35);
                }
                if (c + 2 < this.columns) link(i, i + 2, fold);
                if (r + 2 < this.rows) link(i, i + 2 * this.columns, fold);
            }
        }
        this.links = Uint32Array.from(links);
        this.stiff = Float32Array.from(stiff);
        this.lengths = new Float32Array(stiff.length);
        for (let k = 0; k < this.lengths.length; k++) {
            const a = this.links[k * 2] * 3, b = this.links[k * 2 + 1] * 3;
            this.lengths[k] = Math.hypot(this.rest[a] - this.rest[b], this.rest[a + 1] - this.rest[b + 1], this.rest[a + 2] - this.rest[b + 2]);
        }
    }

    /** Whether point `index` is pinned to the object. */
    isPinned(index: number): boolean {
        return this.pinned[index] === 1;
    }

    /** Lays the sheet out flat where its object is, at rest. */
    reset(matrix: Matrix): void {
        for (let i = 0; i < this.count; i++) transform(matrix, this.rest[i * 3], this.rest[i * 3 + 1], this.rest[i * 3 + 2], this.positions, i * 3);
        this.previous.set(this.positions);
        this.carry = 0;
        this.placed = true;
    }

    /**
     * Moves the cloth on by `dt` seconds in fixed steps: its pins to where `matrix` puts them, the
     * wind from `wind`, resting against `colliders` and above `ground` (null: no ground).
     */
    step(dt: number, matrix: Matrix, wind: ClothWind | null, colliders: readonly ClothCollider[], ground: number | null): void {
        if (!this.placed) this.reset(matrix);
        if (!(dt > 0) || !Number.isFinite(dt)) return;
        this.carry = Math.min(this.carry + dt, CLOTH_STEP * MAX_STEPS);
        while (this.carry >= CLOTH_STEP) {
            this.carry -= CLOTH_STEP;
            this.substep(CLOTH_STEP, matrix, wind, colliders, ground);
        }
    }

    private substep(h: number, matrix: Matrix, wind: ClothWind | null, colliders: readonly ClothCollider[], ground: number | null): void {
        const p = this.positions, q = this.previous, f = this.forces;
        const n = this.count;
        f.fill(0);
        // The wind on each triangle: as much as it faces the wind relative to the cloth's own motion.
        // The wind itself is read once, at the sheet's middle: it barely changes across a sheet.
        if (wind && this.settings.wind > 0) {
            const coefficient = 0.5 * AIR_DENSITY * this.settings.wind;
            let cx = 0, cy = 0, cz = 0;
            for (let i = 0; i < n * 3; i += 3) { cx += p[i]; cy += p[i + 1]; cz += p[i + 2]; }
            wind(cx / n, cy / n, cz / n, _wind);
            const windX = _wind.x, windY = _wind.y, windZ = _wind.z;
            for (let t = 0; t < this.indices.length; t += 3) {
                const a = this.indices[t] * 3, b = this.indices[t + 1] * 3, c = this.indices[t + 2] * 3;
                const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
                const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
                let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
                const doubleArea = Math.sqrt(nx * nx + ny * ny + nz * nz);
                if (doubleArea < 1e-9) continue;
                nx /= doubleArea; ny /= doubleArea; nz /= doubleArea;
                // The triangle's own velocity.
                const sx = (p[a] - q[a] + p[b] - q[b] + p[c] - q[c]) / (3 * h);
                const sy = (p[a + 1] - q[a + 1] + p[b + 1] - q[b + 1] + p[c + 1] - q[c + 1]) / (3 * h);
                const sz = (p[a + 2] - q[a + 2] + p[b + 2] - q[b + 2] + p[c + 2] - q[c + 2]) / (3 * h);
                const rx = windX - sx, ry = windY - sy, rz = windZ - sz;
                const into = rx * nx + ry * ny + rz * nz;
                const push = (coefficient * (doubleArea / 2) * into * Math.abs(into)) / 3;
                const fx = nx * push, fy = ny * push, fz = nz * push;
                f[a] += fx; f[a + 1] += fy; f[a + 2] += fz;
                f[b] += fx; f[b + 1] += fy; f[b + 2] += fz;
                f[c] += fx; f[c + 1] += fy; f[c + 2] += fz;
            }
        }
        // Verlet: on with the motion it had, slowed by the air, pulled down and pushed by the wind.
        const keep = Math.max(0, 1 - Math.min(1, Math.max(0, this.settings.damping)) * 4 * h);
        const scale = (h * h) / this.pointMass;
        for (let i = 0; i < n; i++) {
            const v = i * 3;
            if (this.pinned[i]) {
                transform(matrix, this.rest[v], this.rest[v + 1], this.rest[v + 2], p, v);
                q[v] = p[v]; q[v + 1] = p[v + 1]; q[v + 2] = p[v + 2];
                continue;
            }
            const x = p[v], y = p[v + 1], z = p[v + 2];
            p[v] = x + (x - q[v]) * keep + f[v] * scale;
            p[v + 1] = y + (y - q[v + 1]) * keep + (f[v + 1] / this.pointMass - GRAVITY) * h * h;
            p[v + 2] = z + (z - q[v + 2]) * keep + f[v + 2] * scale;
            q[v] = x; q[v + 1] = y; q[v + 2] = z;
        }
        // Links, several times over: each pulls its two points back toward its rest length.
        for (let iteration = 0; iteration < ITERATIONS; iteration++) {
            for (let k = 0; k < this.lengths.length; k++) {
                const i = this.links[k * 2], j = this.links[k * 2 + 1];
                const wi = this.pinned[i] ? 0 : 1, wj = this.pinned[j] ? 0 : 1;
                const w = wi + wj;
                if (w === 0) continue;
                const a = i * 3, b = j * 3;
                const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
                const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (d < 1e-9) continue;
                const correction = ((d - this.lengths[k]) / d) * this.stiff[k] / w;
                p[a] += dx * correction * wi; p[a + 1] += dy * correction * wi; p[a + 2] += dz * correction * wi;
                p[b] -= dx * correction * wj; p[b + 1] -= dy * correction * wj; p[b + 2] -= dz * correction * wj;
            }
            // Contacts every other pass (and on the last): enough to keep it outside, at half the cost.
            if (iteration % 2 === 1 || iteration === ITERATIONS - 1) this.collide(colliders, ground);
        }
    }

    /** Points inside a character or below the ground go out to its surface, rubbing as they slide. */
    private collide(colliders: readonly ClothCollider[], ground: number | null): void {
        const p = this.positions, q = this.previous;
        const thickness = Math.max(0, this.settings.thickness);
        for (let i = 0; i < this.count; i++) {
            if (this.pinned[i]) continue;
            const v = i * 3;
            if (ground !== null && p[v + 1] < ground + thickness) {
                p[v + 1] = ground + thickness;
                // Friction: it drags rather than skates.
                q[v] = p[v] - (p[v] - q[v]) * 0.5;
                q[v + 2] = p[v + 2] - (p[v + 2] - q[v + 2]) * 0.5;
            }
            for (const capsule of colliders) {
                const radius = capsule.radius + thickness;
                const low = capsule.y + capsule.radius, high = capsule.y + Math.max(capsule.radius, capsule.height - capsule.radius);
                const cy = Math.min(high, Math.max(low, p[v + 1]));
                const dx = p[v] - capsule.x, dy = p[v + 1] - cy, dz = p[v + 2] - capsule.z;
                const squared = dx * dx + dy * dy + dz * dz;
                if (squared >= radius * radius || squared < 1e-18) continue;
                const d = Math.sqrt(squared);
                const out = radius / d;
                p[v] = capsule.x + dx * out;
                p[v + 1] = cy + dy * out;
                p[v + 2] = capsule.z + dz * out;
            }
        }
    }
}

/** Whether the point at row `r`, column `c` is pinned. */
export const pinnedAt = (pin: ClothPin, r: number, c: number, rows: number, columns: number): boolean => {
    const top = r === 0;
    const corner = (c === 0 || c === columns - 1);
    switch (pin) {
        case 'top': return top;
        case 'left': return c === 0;
        case 'topCorners': return top && corner;
        case 'corners': return (top || r === rows - 1) && corner;
        default: return false;
    }
};
