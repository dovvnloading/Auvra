import type { ClothCollider, ClothWind } from '../cloth';
import type { WindVec } from '../wind';
import type { CookedGarment } from './pattern';
import { closestAxisTriangle, type Point } from './contactGeometry';
import { GarmentAvatarContact, type GarmentAvatarSurface, type AvatarContactStats } from './avatarContact';
export type { GarmentAvatarSurface } from './avatarContact';
import { GarmentSelfContact, type SelfContactStats } from './selfContact';

/** SI units. This fixed-budget preview uses independent warp, weft and shear terms. */
export interface GarmentMaterial {
    arealDensity: number; // kg/m²
    warp: number; weft: number; shear: number; // N/m
    bend: number; // N·m
    damping: number; // s⁻¹
    thickness: number; // one-sided contact offset, m
    friction: number;
    seamStiffness: number; // N/m² of sewn length
    sewTime: number; // seconds to reach the closed seam target
    gravity: number; // m/s²
    wind: number; // normal drag coefficient
    selfCollision: boolean; // bounded feature contact within one cooked garment instance
}

export const DEFAULT_GARMENT_MATERIAL: Readonly<GarmentMaterial> = Object.freeze({
    arealDensity: 0.18, warp: 1800, weft: 1200, shear: 180, bend: 4e-5,
    damping: 1.2, thickness: 0.002, friction: 0.35, seamStiffness: 2e6,
    sewTime: 0.45, gravity: 9.81, wind: 1, selfCollision: false,
});

export interface GarmentCapsule extends ClothCollider {
    /** Stable ID when colliders may be added, removed or reordered. Otherwise index is used. */
    id?: string | number;
    /** Optional x radius. Caps retain the y and z radius specified by radius. */
    radiusX?: number;
}

export const GARMENT_STEP = 1 / 120;
const STEP2 = GARMENT_STEP * GARMENT_STEP;
const PASSES = 6;
const MAX_TICKS = 8;
const DOWN: WindVec = { x: 0, y: -1, z: 0 };
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

function place(out: Float32Array, at: number, p: Float32Array, m: ArrayLike<number>): void {
    const x = p[at], y = p[at + 1], z = p[at + 2];
    for (let j = 0; j < 3; j++) out[at + j] = m[j] * x + m[4 + j] * y + m[8 + j] * z + m[12 + j];
}

function validBody(c: GarmentCapsule): boolean {
    return [c.x, c.y, c.z, c.height, c.radius, c.radiusX ?? c.radius].every(Number.isFinite)
        && c.radius > 0 && (c.radiusX ?? c.radius) > 0 && c.height >= 2 * c.radius;
}

function blendBody(a: GarmentCapsule, b: GarmentCapsule, t: number): GarmentCapsule {
    return {
        id: b.id, x: mix(a.x, b.x, t), y: mix(a.y, b.y, t), z: mix(a.z, b.z, t),
        height: mix(a.height, b.height, t), radius: mix(a.radius, b.radius, t),
        radiusX: mix(a.radiusX ?? a.radius, b.radiusX ?? b.radius, t),
    };
}

interface BodyMotion { from: GarmentCapsule; to: GarmentCapsule }
interface BodySample extends BodyMotion { key: string | number }

/** Streaming point/translated-capsule entry in normalized capsule coordinates.
 * The cylinder and both spherical caps overlap; the earliest entry into their union wins.
 * A vector already on/inside the surface at the start is handled by closest-point recovery. */
function capsuleEntry(x: number, y: number, z: number, dx: number, dy: number, dz: number, span: number): number {
    if (x * x + z * z + (y - clamp(y, 0, span)) ** 2 < 1 - 1e-7) return Infinity;
    let first = Infinity;
    const radial = dx * dx + dz * dz, slope = x * dx + z * dz, constant = x * x + z * z - 1;
    if (radial > 1e-18) {
        const disc = slope * slope - radial * constant;
        if (disc >= 0) {
            const t = (-slope - Math.sqrt(disc)) / radial;
            const h = y + t * dy;
            if (t >= -1e-8 && t <= 1 && h >= 0 && h <= span) first = Math.max(0, t);
        }
    }
    const speed = radial + dy * dy;
    if (speed < 1e-18) return first;
    for (let cap = 0; cap < 2; cap++) {
        const offset = y - cap * span, b = slope + offset * dy;
        const disc = b * b - speed * (constant + offset * offset);
        if (disc < 0) continue;
        const t = (-b - Math.sqrt(disc)) / speed;
        if (t >= -1e-8 && t <= 1 && t < first) first = Math.max(0, t);
    }
    return first;
}

export class GarmentSimulation {
    readonly positions: Float32Array;
    readonly material: Readonly<GarmentMaterial>;
    readonly mass: number;
    time = 0;
    droppedTime = 0;
    private avatarContact: GarmentAvatarContact | null = null;
    get avatarContactStats(): Readonly<AvatarContactStats> | null { return this.avatarContact?.stats ?? null; }
    private readonly selfContact: GarmentSelfContact | null;
    get selfContactStats(): Readonly<SelfContactStats> | null { return this.selfContact?.stats ?? null; }
    private readonly mesh: CookedGarment;
    private readonly previous: Float32Array;
    private readonly start: Float32Array;
    private readonly incomingPins: Float32Array;
    private readonly lastPins: Float32Array;
    private readonly inverseMass: Float64Array;
    // Each triangle occupies 10 slots: warp shape derivatives (3), weft (3), area, and three multipliers.
    private readonly triangle: Float64Array;
    private readonly bendAlpha: Float64Array;
    private readonly bendLambda: Float64Array;
    private readonly seamRest: Float64Array;
    private readonly seamLambda: Float64Array;
    private readonly gradient = new Float64Array(12);
    private readonly flow: WindVec = { x: 0, y: 0, z: 0 };
    private readonly frictionShift: Float32Array;
    private lastTickBodies = new Map<string | number, GarmentCapsule>();
    private lastBodies = new Map<string | number, GarmentCapsule>();
    private carry = 0;
    private placed = false;

    constructor(mesh: CookedGarment, overrides: Partial<GarmentMaterial> = {}) {
        this.mesh = mesh;
        const mat = { ...DEFAULT_GARMENT_MATERIAL, ...overrides };
        if (typeof mat.selfCollision !== 'boolean' || Object.entries(mat).some(([key, v]) =>
            key !== 'selfCollision' && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) || mat.arealDensity <= 0) {
            throw new Error('Garment material requires finite nonnegative coefficients and positive areal density');
        }
        this.material = Object.freeze(mat);
        this.positions = new Float32Array(mesh.positions.length);
        this.previous = new Float32Array(this.positions.length);
        this.start = new Float32Array(this.positions.length);
        this.frictionShift = new Float32Array(this.positions.length);
        this.incomingPins = new Float32Array(this.positions.length);
        this.lastPins = new Float32Array(this.positions.length);
        this.inverseMass = new Float64Array(this.positions.length / 3);
        this.triangle = new Float64Array(mesh.indices.length / 3 * 10);
        let total = 0;
        for (let t = 0; t < mesh.indices.length / 3; t++) {
            const a = mesh.indices[3 * t], b = mesh.indices[3 * t + 1], c = mesh.indices[3 * t + 2];
            const uv = mesh.materialUV;
            const u1 = uv[2 * b] - uv[2 * a], u2 = uv[2 * c] - uv[2 * a];
            const v1 = uv[2 * b + 1] - uv[2 * a + 1], v2 = uv[2 * c + 1] - uv[2 * a + 1];
            const det = u1 * v2 - u2 * v1, area = Math.abs(det) / 2, k = 10 * t;
            if (!(area > 1e-14)) throw new Error('Garment triangle has degenerate material coordinates');
            this.triangle.set([(v1 - v2) / det, v2 / det, -v1 / det, (u2 - u1) / det, -u2 / det, u1 / det, area], k);
            const mass = area * mat.arealDensity;
            total += mass;
            for (const vertex of [a, b, c]) this.inverseMass[vertex] += mass / 3;
        }
        this.mass = total;
        for (let i = 0; i < this.inverseMass.length; i++) {
            if (!(this.inverseMass[i] > 0)) throw new Error('Garment vertex has no incident triangle');
            this.inverseMass[i] = 1 / this.inverseMass[i];
        }
        for (const i of mesh.pins) this.inverseMass[i] = 0;
        this.selfContact = mat.selfCollision ? new GarmentSelfContact(mesh, this.inverseMass) : null;
        this.bendAlpha = new Float64Array(mesh.hinges.length);
        this.bendLambda = new Float64Array(mesh.hinges.length);
        const uv = mesh.materialUV;
        mesh.hinges.forEach(({ a, b, c, d }, i) => {
            const ex = uv[2 * b] - uv[2 * a], ey = uv[2 * b + 1] - uv[2 * a + 1];
            const twiceArea = (v: number) => Math.abs(ex * (uv[2 * v + 1] - uv[2 * a + 1]) - ey * (uv[2 * v] - uv[2 * a]));
            const stiffness = mat.bend * 6 * (ex * ex + ey * ey) / (twiceArea(c) + twiceArea(d));
            this.bendAlpha[i] = stiffness > 0 ? 1 / (stiffness * STEP2) : Infinity;
        });
        this.seamRest = new Float64Array(mesh.seams.length);
        this.seamLambda = new Float64Array(mesh.seams.length);
        this.reset();
        this.placed = false;
    }

    reset(matrix: ArrayLike<number> = IDENTITY): void {
        for (let i = 0; i < this.positions.length; i += 3) place(this.positions, i, this.mesh.positions, matrix);
        this.previous.set(this.positions);
        this.lastPins.set(this.positions);
        if (this.selfContact) this.selfContact.reset();
        this.avatarContact = null;
        this.mesh.seams.forEach(({ a, b }, i) => {
            const p = this.positions, u = 3 * a, v = 3 * b;
            this.seamRest[i] = Math.hypot(p[u] - p[v], p[u + 1] - p[v + 1], p[u + 2] - p[v + 2]);
        });
        this.lastBodies.clear();
        this.lastTickBodies.clear();
        this.carry = this.time = this.droppedTime = 0;
        this.placed = true;
    }

    /** Returns the number of accepted fixed ticks. Buffers and collider inputs share one coordinate frame.
     * A changing capsule radius/height gets endpoint contact. Exact point sweeps cover translating,
     * fixed-size analytic capsules. The first observation of each ID supplies its initial pose. */
    step(dt: number, matrix: ArrayLike<number> = IDENTITY, wind: ClothWind | null = null,
        colliders: readonly GarmentCapsule[] = [], ground: number | null = null, down: WindVec = DOWN,
        avatar: GarmentAvatarSurface | null = null): number {
        if (!Number.isFinite(dt) || dt <= 0) return 0;
        if (!this.placed) this.reset(matrix);
        for (const i of this.mesh.pins) place(this.incomingPins, i * 3, this.mesh.positions, matrix);
        const cap = GARMENT_STEP * MAX_TICKS;
        const available = Math.min(dt, cap);
        this.droppedTime += dt - available;
        const carryBefore = this.carry;
        this.carry += available;
        const steps = Math.min(MAX_TICKS, Math.floor((this.carry + 1e-12) / GARMENT_STEP));
        if (!avatar) this.avatarContact = null;
        const spans: BodySample[] = [];
        const nextBodies = new Map<string | number, GarmentCapsule>();
        for (let i = 0; i < colliders.length; i++) {
            const b = colliders[i];
            if (!validBody(b)) continue;
            const key = b.id === undefined ? 'index:' + i : typeof b.id + ':' + b.id;
            const from = this.lastBodies.get(key) ?? b;
            spans.push({ key, from, to: b });
            nextBodies.set(key, { ...b });
        }
        for (let tick = 0; tick < steps; tick++) {
            const end = clamp(((tick + 1) * GARMENT_STEP - carryBefore) / available, 0, 1);
            const motion = spans.map(s => {
                const to = blendBody(s.from, s.to, end);
                const from = this.lastTickBodies.get(s.key) ?? s.from;
                this.lastTickBodies.set(s.key, to);
                return { from, to };
            });
            if (avatar) {
                this.avatarContact ??= new GarmentAvatarContact(this.inverseMass);
                const begin = clamp((tick * GARMENT_STEP - carryBefore) / available, 0, 1);
                this.avatarContact.prepare(avatar, begin, end, true);
            }
            this.substep(wind, motion, ground, down, end);
            this.carry -= GARMENT_STEP;
            this.time += GARMENT_STEP;
        }
        this.carry = Math.max(0, this.carry);
        this.lastPins.set(this.incomingPins);
        if (steps === 0) {
            for (const { key, from } of spans) if (!this.lastTickBodies.has(key)) this.lastTickBodies.set(key, from);
        }
        this.lastBodies = nextBodies;
        for (const key of this.lastTickBodies.keys()) {
            if (!nextBodies.has(key)) this.lastTickBodies.delete(key);
        }
        return steps;
    }

    private substep(wind: ClothWind | null, motion: BodyMotion[], ground: number | null, down: WindVec, pinFraction: number): void {
        const p = this.positions;
        this.start.set(p);
        for (const i of this.mesh.pins) {
            for (let j = 3 * i; j < 3 * i + 3; j++) p[j] = mix(this.lastPins[j], this.incomingPins[j], pinFraction);
        }
        this.frictionShift.fill(0);
        const keep = Math.exp(-this.material.damping * GARMENT_STEP);
        for (let i = 0; i < this.inverseMass.length; i++) {
            if (this.inverseMass[i] === 0) continue;
            const a = 3 * i;
            for (let j = 0; j < 3; j++) p[a + j] += keep * (p[a + j] - this.previous[a + j]);
            const gravity = this.material.gravity * STEP2;
            p[a] += gravity * down.x; p[a + 1] += gravity * down.y; p[a + 2] += gravity * down.z;
        }
        if (wind && this.material.wind > 0) this.applyWind(wind);
        for (let k = 7; k < this.triangle.length; k += 10) this.triangle.fill(0, k, k + 3);
        this.bendLambda.fill(0);
        this.seamLambda.fill(0);
        const remaining = this.material.sewTime > 0 ? Math.max(0, 1 - (this.time + GARMENT_STEP) / this.material.sewTime) : 0;
        for (let pass = 0; pass < PASSES; pass++) {
            this.membrane(pass % 2 === 1);
            if (this.material.bend > 0) this.bend();
            if (this.material.seamStiffness > 0) this.sew(remaining);
            this.contact(motion, ground);
            if (pass >= PASSES - 2) this.faceContact(motion);
            if (pass === PASSES - 2) this.applyAvatarContact();
        }
        if (this.selfContact) {
            this.selfContact.solve(this.start, p, 2 * this.material.thickness);
            this.contact(motion, ground);
            this.faceContact(motion);
        }
        this.applyAvatarContact();
        for (let j = 0; j < p.length; j++) this.previous[j] = this.start[j] + this.frictionShift[j];
    }

    private applyAvatarContact(): void {
        this.avatarContact?.solve(this.start, this.positions, this.material.thickness, (...args) => this.friction(...args));
    }

    private applyWind(wind: ClothWind): void {
        const x = this.start, q = this.previous, p = this.positions, idx = this.mesh.indices;
        for (let t = 0; t < idx.length; t += 3) {
            const a = 3 * idx[t], b = 3 * idx[t + 1], c = 3 * idx[t + 2];
            const ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2];
            const vx = x[c] - x[a], vy = x[c + 1] - x[a + 1], vz = x[c + 2] - x[a + 2];
            let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const twiceArea = Math.hypot(nx, ny, nz);
            if (twiceArea < 1e-14) continue;
            nx /= twiceArea; ny /= twiceArea; nz /= twiceArea;
            const air = wind((x[a] + x[b] + x[c]) / 3, (x[a + 1] + x[b + 1] + x[c + 1]) / 3, (x[a + 2] + x[b + 2] + x[c + 2]) / 3, this.flow);
            const relative = (j: number) => (x[a + j] - q[a + j] + x[b + j] - q[b + j] + x[c + j] - q[c + j]) / (3 * GARMENT_STEP);
            const speed = clamp((air.x - relative(0)) * nx + (air.y - relative(1)) * ny + (air.z - relative(2)) * nz, -100, 100);
            if (!Number.isFinite(speed)) continue;
            const force = 0.25 * 1.2 * this.material.wind * twiceArea * speed * Math.abs(speed) / 3;
            for (let k = t; k < t + 3; k++) {
                const at = 3 * idx[k], scale = force * STEP2 * this.inverseMass[idx[k]];
                p[at] += scale * nx; p[at + 1] += scale * ny; p[at + 2] += scale * nz;
            }
        }
    }

    private membrane(reverse: boolean): void {
        const p = this.positions, ids = this.mesh.indices, s = this.triangle, g = this.gradient;
        const count = ids.length / 3;
        for (let ord = 0; ord < count; ord++) {
            const t = reverse ? count - 1 - ord : ord, k = 10 * t;
            for (let mode = 0; mode < 3; mode++) {
                const stiffness = mode === 0 ? this.material.warp : mode === 1 ? this.material.weft : this.material.shear;
                if (stiffness === 0) continue;
                let C = mode === 2 ? 0 : -0.5;
                for (let j = 0; j < 3; j++) {
                    const pa = p[3 * ids[3 * t] + j], pb = p[3 * ids[3 * t + 1] + j], pc = p[3 * ids[3 * t + 2] + j];
                    const u = (pb - pa) * s[k + 1] + (pc - pa) * s[k + 2], v = (pb - pa) * s[k + 4] + (pc - pa) * s[k + 5];
                    C += mode === 2 ? u * v : 0.5 * (mode === 0 ? u * u : v * v);
                    for (let h = 0; h < 3; h++) {
                        g[3 * h + j] = mode === 0 ? s[k + h] * u : mode === 1 ? s[k + 3 + h] * v : s[k + h] * v + s[k + 3 + h] * u;
                    }
                }
                const alpha = 1 / (STEP2 * s[k + 6] * stiffness);
                let denom = alpha;
                for (let h = 0; h < 3; h++) {
                    const q = 3 * h;
                    denom += this.inverseMass[ids[3 * t + h]] * (g[q] * g[q] + g[q + 1] * g[q + 1] + g[q + 2] * g[q + 2]);
                }
                const delta = (-C - alpha * s[k + 7 + mode]) / denom;
                s[k + 7 + mode] += delta;
                for (let h = 0; h < 3; h++) {
                    const vertex = ids[3 * t + h], scale = this.inverseMass[vertex] * delta;
                    for (let j = 0; j < 3; j++) p[3 * vertex + j] += scale * g[3 * h + j];
                }
            }
        }
    }

    private bend(): void {
        const p = this.positions, g = this.gradient;
        const hinges = this.mesh.hinges;
        for (let i = 0; i < hinges.length; i++) {
            const { a, b, c, d } = hinges[i], u = 3 * a, v = 3 * b, w = 3 * c, z = 3 * d;
            const ex = p[v] - p[u], ey = p[v + 1] - p[u + 1], ez = p[v + 2] - p[u + 2];
            const cx = p[w] - p[u], cy = p[w + 1] - p[u + 1], cz = p[w + 2] - p[u + 2];
            const dx = p[z] - p[u], dy = p[z + 1] - p[u + 1], dz = p[z + 2] - p[u + 2];
            const nx = ey * cz - ez * cy, ny = ez * cx - ex * cz, nz = ex * cy - ey * cx;
            const mx = dy * ez - dz * ey, my = dz * ex - dx * ez, mz = dx * ey - dy * ex;
            const edge2 = ex * ex + ey * ey + ez * ez, n2 = nx * nx + ny * ny + nz * nz, m2 = mx * mx + my * my + mz * mz;
            if (Math.min(n2, m2, edge2) < 1e-18) continue;
            const length = Math.sqrt(edge2);
            const sine = (ex * (ny * mz - nz * my) + ey * (nz * mx - nx * mz) + ez * (nx * my - ny * mx)) / length;
            const angle = Math.atan2(sine, nx * mx + ny * my + nz * mz);
            const sc = -length / n2, sd = -length / m2;
            g[6] = sc * nx; g[7] = sc * ny; g[8] = sc * nz; g[9] = sd * mx; g[10] = sd * my; g[11] = sd * mz;
            const tc = (cx * ex + cy * ey + cz * ez) / edge2, td = (dx * ex + dy * ey + dz * ez) / edge2;
            let denom = this.bendAlpha[i];
            for (let j = 0; j < 3; j++) {
                g[3 + j] = -tc * g[6 + j] - td * g[9 + j];
                g[j] = -g[3 + j] - g[6 + j] - g[9 + j];
                denom += this.inverseMass[a] * g[j] ** 2 + this.inverseMass[b] * g[3 + j] ** 2
                    + this.inverseMass[c] * g[6 + j] ** 2 + this.inverseMass[d] * g[9 + j] ** 2;
            }
            const delta = (-angle - this.bendAlpha[i] * this.bendLambda[i]) / denom;
            this.bendLambda[i] += delta;
            for (let j = 0; j < 3; j++) {
                p[u + j] += this.inverseMass[a] * delta * g[j]; p[v + j] += this.inverseMass[b] * delta * g[3 + j];
                p[w + j] += this.inverseMass[c] * delta * g[6 + j]; p[z + j] += this.inverseMass[d] * delta * g[9 + j];
            }
        }
    }

    private sew(remaining: number): void {
        const p = this.positions;
        for (let i = 0; i < this.mesh.seams.length; i++) {
            const { a, b, weight } = this.mesh.seams[i], u = 3 * a, v = 3 * b;
            const x = p[u] - p[v], y = p[u + 1] - p[v + 1], z = p[u + 2] - p[v + 2], length = Math.hypot(x, y, z);
            if (length < 1e-12 || weight <= 0) continue;
            const alpha = 1 / (weight * this.material.seamStiffness * STEP2);
            const target = this.seamRest[i] * remaining;
            const delta = (target - length - alpha * this.seamLambda[i]) / (this.inverseMass[a] + this.inverseMass[b] + alpha);
            this.seamLambda[i] += delta;
            const sa = this.inverseMass[a] * delta / length, sb = this.inverseMass[b] * delta / length;
            p[u] += sa * x; p[u + 1] += sa * y; p[u + 2] += sa * z;
            p[v] -= sb * x; p[v + 1] -= sb * y; p[v + 2] -= sb * z;
        }
    }

    private contact(motion: BodyMotion[], ground: number | null): void {
        const p = this.positions, q = this.start, thickness = this.material.thickness;
        for (let i = 0; i < this.inverseMass.length; i++) {
            if (this.inverseMass[i] === 0) continue;
            const j = 3 * i;
            for (const { from, to } of motion) {
                const rx = (to.radiusX ?? to.radius) + thickness, r = to.radius + thickness;
                const bottom = to.y + to.radius, span = (to.height - 2 * to.radius) / r;
                // Broad rejection in body-relative coordinates includes the full relative sweep.
                const x = (p[j] - to.x) / rx, y = (p[j + 1] - bottom) / r, z = (p[j + 2] - to.z) / r;
                const x0 = (q[j] - from.x) / rx, y0 = (q[j + 1] - from.y - from.radius) / r, z0 = (q[j + 2] - from.z) / r;
                if (Math.min(x0, x) > 1 || Math.max(x0, x) < -1 || Math.min(z0, z) > 1 || Math.max(z0, z) < -1 ||
                    Math.min(y0, y) > span + 1 || Math.max(y0, y) < -1) continue;
                const dx = x - x0, dy = y - y0, dz = z - z0;
                const fixed = from.height === to.height && from.radius === to.radius && from.radiusX === to.radiusX;
                const hit = fixed ? capsuleEntry(x0, y0, z0, dx, dy, dz, span) : Infinity;
                const h = Number.isFinite(hit) ? hit : 1;
                const hx = x0 + h * dx, hy = y0 + h * dy, hz = z0 + h * dz, axis = clamp(hy, 0, span);
                const distance = Math.hypot(hx, hy - axis, hz);
                if (h === 1 && distance >= 1) continue;
                let nx = 1, ny = 0, nz = 0;
                if (distance > 1e-12) { nx = hx / distance; ny = (hy - axis) / distance; nz = hz / distance; }
                else if (Math.hypot(dx, dz) > 1e-12) { const l = Math.hypot(dx, dz); nx = -dx / l; nz = -dz / l; }
                const boundaryX = to.x + rx * nx, boundaryY = bottom + r * (axis + ny), boundaryZ = to.z + r * nz;
                // Ellipsoid surface normal is the inverse transpose of the radius scale.
                const norm = Math.hypot(nx / rx, ny / r, nz / r);
                nx = nx / rx / norm; ny = ny / r / norm; nz = nz / r / norm;
                const correction = (boundaryX - p[j]) * nx + (boundaryY - p[j + 1]) * ny + (boundaryZ - p[j + 2]) * nz;
                if (correction <= 0) continue;
                p[j] += correction * nx; p[j + 1] += correction * ny; p[j + 2] += correction * nz;
                this.friction(j, nx, ny, nz, correction, to.x - from.x, to.y - from.y, to.z - from.z);
            }
            if (ground !== null && p[j + 1] < ground + thickness) {
                const correction = ground + thickness - p[j + 1];
                p[j + 1] = ground + thickness;
                this.friction(j, 0, 1, 0, correction, 0, 0, 0);
            }
        }
    }

    /** Endpoint face/analytic-body projection. AABB and tangent-plane rejection keep convex exterior faces cheap. */
    private faceContact(motion: BodyMotion[]): void {
        const p = this.positions, indices = this.mesh.indices, thickness = this.material.thickness;
        for (const { from, to } of motion) {
            const rx = (to.radiusX ?? to.radius) + thickness, r = to.radius + thickness;
            const bottom = to.y + to.radius, span = (to.height - 2 * to.radius) / r;
            for (let t = 0; t < indices.length; t += 3) {
                const ia = indices[t], ib = indices[t + 1], ic = indices[t + 2];
                const a = 3 * ia, b = 3 * ib, c = 3 * ic;
                if (Math.min(p[a], p[b], p[c]) > to.x + rx || Math.max(p[a], p[b], p[c]) < to.x - rx ||
                    Math.min(p[a + 2], p[b + 2], p[c + 2]) > to.z + r || Math.max(p[a + 2], p[b + 2], p[c + 2]) < to.z - r ||
                    Math.min(p[a + 1], p[b + 1], p[c + 1]) > to.y + to.height + thickness ||
                    Math.max(p[a + 1], p[b + 1], p[c + 1]) < to.y - thickness) continue;
                const v: Point = [(p[a] - to.x) / rx, (p[a + 1] - bottom) / r, (p[a + 2] - to.z) / r];
                const w: Point = [(p[b] - to.x) / rx, (p[b + 1] - bottom) / r, (p[b + 2] - to.z) / r];
                const u: Point = [(p[c] - to.x) / rx, (p[c + 1] - bottom) / r, (p[c + 2] - to.z) / r];
                // Separating support plane at the axis point nearest a. Test all three vertices.
                const ay = v[1] - clamp(v[1], 0, span), nl = Math.hypot(v[0], ay, v[2]);
                if (nl > 1) {
                    const support = nl + Math.max(0, ay * span);
                    if (w[0] * v[0] + w[1] * ay + w[2] * v[2] >= support &&
                        u[0] * v[0] + u[1] * ay + u[2] * v[2] >= support) continue;
                }
                const weights = closestAxisTriangle(v, w, u, span);
                if (!weights) continue;
                const [wa, wb, wc] = weights;
                const x = wa * v[0] + wb * w[0] + wc * u[0], y = wa * v[1] + wb * w[1] + wc * u[1], z = wa * v[2] + wb * w[2] + wc * u[2];
                const cy = y - clamp(y, 0, span), distance = Math.hypot(x, cy, z);
                let nx = x / rx, ny = cy / r, nz = z / r;
                if (distance < 1e-8) {
                    // The axis intersects the face. Pick its last-pose side in capsule space.
                    const last = this.start;
                    nx = (wa * last[a] + wb * last[b] + wc * last[c] - from.x) / (rx * rx);
                    const sy = wa * last[a + 1] + wb * last[b + 1] + wc * last[c + 1] - from.y - from.radius;
                    ny = (sy - clamp(sy, 0, from.height - 2 * from.radius)) / (r * r);
                    nz = (wa * last[a + 2] + wb * last[b + 2] + wc * last[c + 2] - from.z) / (r * r);
                    if (Math.hypot(nx, ny, nz) < 1e-8) {
                        const ex = p[b] - p[a], ey = p[b + 1] - p[a + 1], ez = p[b + 2] - p[a + 2];
                        const ux = p[c] - p[a], uy = p[c + 1] - p[a + 1], uz = p[c + 2] - p[a + 2];
                        nx = ey * uz - ez * uy; ny = ez * ux - ex * uz; nz = ex * uy - ey * ux;
                    }
                }
                const normal = Math.hypot(nx, ny, nz);
                if (normal < 1e-14) continue;
                nx /= normal; ny /= normal; nz /= normal;
                const support = Math.hypot(rx * nx, r * ny, r * nz) + Math.max(0, span * r * ny);
                const correction = support - (x * rx * nx + y * r * ny + z * r * nz);
                const denom = wa * wa * this.inverseMass[ia] + wb * wb * this.inverseMass[ib] + wc * wc * this.inverseMass[ic];
                if (correction <= 0 || denom <= 1e-12) continue;
                for (let k = 0; k < 3; k++) {
                    const i = indices[t + k], delta = correction * weights[k] * this.inverseMass[i] / denom;
                    p[3 * i] += delta * nx; p[3 * i + 1] += delta * ny; p[3 * i + 2] += delta * nz;
                }
            }
        }
    }

    private friction(j: number, nx: number, ny: number, nz: number, correction: number, bx: number, by: number, bz: number): void {
        const p = this.positions, q = this.start, shift = this.frictionShift;
        const x = p[j] - q[j] - shift[j] - bx, y = p[j + 1] - q[j + 1] - shift[j + 1] - by, z = p[j + 2] - q[j + 2] - shift[j + 2] - bz;
        const normal = x * nx + y * ny + z * nz;
        const tx = x - normal * nx, ty = y - normal * ny, tz = z - normal * nz;
        const tangent = Math.hypot(tx, ty, tz);
        if (tangent > 1e-12) {
            const ratio = Math.min(1, this.material.friction * correction / tangent);
            shift[j] += tx * ratio; shift[j + 1] += ty * ratio; shift[j + 2] += tz * ratio;
        }
    }
}
