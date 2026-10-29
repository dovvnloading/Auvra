import {
    BAKE_SAMPLES,
    bakeCurve,
    bakeGradient,
    linearColor,
    type ParticleEffect,
    type SubEmitterTrigger,
} from './particleEffect';

/**
 * PARTICLE SIMULATION
 *
 * One emitter's particles, simulated on the CPU in flat typed arrays (live particles packed at the
 * front, so they upload to the GPU as they are). Emission follows the effect's cycle: a delay, a
 * continuous rate, bursts timed within each cycle, and a rate per metre the emitter moves (trails,
 * laid along the path it moved). Particles start from the effect's shape, are moved by gravity,
 * drag, wind, turbulence and a vortex, may bounce off or die on the world (through a ray query the
 * caller supplies), and raise events where they die or hit, for sub-emitters. After each step the
 * render arrays hold every live particle's colour, size, rotation and flipbook frame.
 */

/** Longest step taken in one go, so resuming from a pause or a stalled tab does not jump. */
export const MAX_PARTICLE_STEP = 0.1;
/** Ray queries a world-colliding emitter makes per step at most; the rest wait for the next step. */
export const COLLISION_CHECKS_PER_STEP = 384;

/** Where a particle's move from one point to another hits the world. */
export interface ParticleHit {
    x: number; y: number; z: number;
    /** Surface normal. */
    nx: number; ny: number; nz: number;
}

/** A ray query: the first hit moving from (fx, fy, fz) to (tx, ty, tz), or null. */
export type ParticleRaycast = (fx: number, fy: number, fz: number, tx: number, ty: number, tz: number) => ParticleHit | null;

/** A particle that died or hit something, for sub-emitters. World space. */
export interface ParticleEvent {
    trigger: SubEmitterTrigger;
    x: number; y: number; z: number;
    vx: number; vy: number; vz: number;
}

/** Points on a mesh's surface, in the emitter's own space: the 'mesh' shape. */
export interface MeshSurface {
    /** xyz triples. */
    positions: Float32Array;
    indices: Uint32Array;
}

interface MeshSampler {
    surface: MeshSurface;
    /** Cumulative triangle areas, normalized to end at 1. */
    cdf: Float32Array;
}

const buildMeshSampler = (surface: MeshSurface): MeshSampler | null => {
    const triangles = Math.floor(surface.indices.length / 3);
    if (triangles === 0) return null;
    const cdf = new Float32Array(triangles);
    const p = surface.positions;
    let total = 0;
    for (let t = 0; t < triangles; t++) {
        const a = surface.indices[t * 3] * 3, b = surface.indices[t * 3 + 1] * 3, c = surface.indices[t * 3 + 2] * 3;
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
        const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
        const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
        total += Math.hypot(cx, cy, cz) / 2;
        cdf[t] = total;
    }
    if (!(total > 0)) return null;
    for (let t = 0; t < triangles; t++) cdf[t] /= total;
    return { surface, cdf };
};

const clampStep = (dt: number) => (Number.isFinite(dt) ? Math.min(MAX_PARTICLE_STEP, Math.max(0, dt)) : 0);
const between = (min: number, max: number, r: number) => min + (max - min) * r;

const IDENTITY = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export class ParticleSimulation {
    readonly capacity: number;
    count = 0;
    readonly positions: Float32Array;
    readonly velocities: Float32Array;
    readonly ages: Float32Array;
    readonly lifetimes: Float32Array;
    readonly startSizes: Float32Array;
    readonly rotations: Float32Array;
    readonly spins: Float32Array;
    readonly startColors: Float32Array;
    readonly seeds: Float32Array;
    /** Render values for the live particles, filled each step: linear RGBA, size, rotation (radians), frame. */
    readonly colors: Float32Array;
    readonly sizes: Float32Array;
    readonly frames: Float32Array;
    /** Deaths and hits since the caller last drained them (only kept while a sub-emitter wants them). */
    events: ParticleEvent[] = [];

    private effect!: ParticleEffect;
    private colorTable!: Float32Array;
    private sizeTable!: Float32Array;
    private speedTable!: Float32Array;
    private startA = new Float32Array(3);
    private startB = new Float32Array(3);
    private wants = { death: false, collision: false };
    private mesh: MeshSampler | null = null;
    private readonly random: () => number;
    /** Seconds since it last started playing (delay included), and into the current cycle. */
    private clock = 0;
    private cycleTime = 0;
    private burstsDone = 0;
    private emitting = true;
    private finished = false;
    private carry = 0;
    private distanceCarry = 0;
    private collisionCursor = 0;
    private last: Float64Array | null = null;
    /** The emitter's velocity over the last step, m/s, world. */
    readonly emitterVelocity = new Float64Array(3);
    /** Collision queries per step at most; raise it when the ray query is cheap (a height lookup). */
    collisionBudget = COLLISION_CHECKS_PER_STEP;

    constructor(effect: ParticleEffect, capacity: number, random: () => number = Math.random) {
        this.capacity = Math.max(1, Math.floor(capacity));
        const n = this.capacity;
        this.positions = new Float32Array(n * 3);
        this.velocities = new Float32Array(n * 3);
        this.ages = new Float32Array(n);
        this.lifetimes = new Float32Array(n);
        this.startSizes = new Float32Array(n);
        this.rotations = new Float32Array(n);
        this.spins = new Float32Array(n);
        this.startColors = new Float32Array(n * 3);
        this.seeds = new Float32Array(n);
        this.colors = new Float32Array(n * 4);
        this.sizes = new Float32Array(n);
        this.frames = new Float32Array(n);
        this.random = random;
        this.setEffect(effect);
    }

    /** Takes a changed effect; live particles carry on under it. */
    setEffect(effect: ParticleEffect): void {
        this.effect = effect;
        this.colorTable = bakeGradient(effect.colorOverLife);
        this.sizeTable = bakeCurve(effect.sizeOverLife);
        this.speedTable = bakeCurve(effect.speedOverLife);
        linearColor(effect.startColor[0], this.startA);
        linearColor(effect.startColor[1], this.startB);
        this.wants = {
            death: effect.subEmitters.some(sub => sub.trigger === 'death'),
            collision: effect.subEmitters.some(sub => sub.trigger === 'collision'),
        };
    }

    /** The surface the 'mesh' shape emits from, in the emitter's own space. */
    setMeshSurface(surface: MeshSurface | null): void {
        this.mesh = surface ? buildMeshSampler(surface) : null;
    }

    get isEmitting(): boolean {
        return this.emitting && !this.finished;
    }

    /** Done: it emits no more and every particle has died. */
    get isDone(): boolean {
        return (this.finished || !this.emitting) && this.count === 0;
    }

    /** Starts emitting from the top of its delay and cycle. */
    play(): void {
        this.emitting = true;
        this.finished = false;
        this.clock = 0;
        this.cycleTime = 0;
        this.burstsDone = 0;
        this.carry = 0;
        this.distanceCarry = 0;
    }

    /** Stops emitting; `clear` also removes every live particle. */
    stop(clear = false): void {
        this.emitting = false;
        if (clear) this.count = 0;
    }

    /** Runs one looping cycle at once, as if it had been going a while. */
    prewarm(matrix: ArrayLike<number> | null, steps = 30): void {
        const dt = this.effect.duration / steps;
        for (let i = 0; i < steps; i++) this.step(dt, matrix);
        this.events.length = 0;
    }

    /**
     * Spawns `count` particles from the shape placed at a world point (a sub-emitter's or a
     * script's burst), starting with `velocity` (world, m/s) on top of their own launch.
     */
    emitAt(count: number, x: number, y: number, z: number, vx = 0, vy = 0, vz = 0): void {
        const matrix = IDENTITY.slice();
        matrix[12] = x;
        matrix[13] = y;
        matrix[14] = z;
        const local = this.effect.space === 'local';
        for (let i = 0; i < count; i++) this.spawn(local ? null : matrix, 0, vx, vy, vz, local ? [x, y, z] : null);
    }

    /**
     * Advances by `dt` seconds (clamped to MAX_PARTICLE_STEP). `matrix` is the emitter's world
     * matrix (column-major); `raycast` makes the world collision queries.
     */
    step(dt: number, matrix: ArrayLike<number> | null, raycast?: ParticleRaycast | null): void {
        const step = clampStep(dt);
        const world = matrix ?? IDENTITY;
        // The emitter's motion this step, for inherited velocity and trails.
        const previous = this.last;
        const moved = previous ? Math.hypot(world[12] - previous[12], world[13] - previous[13], world[14] - previous[14]) : 0;
        if (previous && step > 0) {
            this.emitterVelocity[0] = (world[12] - previous[12]) / step;
            this.emitterVelocity[1] = (world[13] - previous[13]) / step;
            this.emitterVelocity[2] = (world[14] - previous[14]) / step;
        }
        this.simulate(step, world, raycast ?? null);
        this.emit(step, world, previous, moved);
        this.last = (this.last ?? new Float64Array(16));
        for (let i = 0; i < 16; i++) this.last[i] = world[i];
        this.fillRender();
    }

    // -----------------------------------------------------------------------

    private simulate(step: number, world: ArrayLike<number>, raycast: ParticleRaycast | null): void {
        const effect = this.effect;
        const local = effect.space === 'local';
        const damping = effect.drag > 0 ? Math.exp(-effect.drag * step) : 1;
        // Gravity and wind act along world axes; a local-space emitter feels them turned into its frame.
        let gx = effect.wind[0], gy = effect.wind[1] - effect.gravity, gz = effect.wind[2];
        if (local) {
            const ax = gx, ay = gy, az = gz;
            gx = world[0] * ax + world[1] * ay + world[2] * az;
            gy = world[4] * ax + world[5] * ay + world[6] * az;
            gz = world[8] * ax + world[9] * ay + world[10] * az;
        }
        const turbulence = effect.turbulence;
        const frequency = 1 / effect.turbulenceScale;
        const time = this.clock * 0.6;
        const orbit = effect.orbit;
        const cx = local ? 0 : world[12], cz = local ? 0 : world[14];
        const collide = raycast && effect.collision.mode === 'world' && !local;
        let checks = 0;
        const checkFrom = this.collisionCursor;
        let i = 0;
        while (i < this.count) {
            const age = this.ages[i] + step;
            if (age >= this.lifetimes[i]) {
                if (this.wants.death) this.pushEvent('death', i);
                this.remove(i);
                continue;
            }
            const v = i * 3;
            const p = this.positions;
            const vel = this.velocities;
            let vx = vel[v], vy = vel[v + 1], vz = vel[v + 2];
            vx += gx * step;
            vy += gy * step;
            vz += gz * step;
            if (turbulence > 0) {
                const x = p[v] * frequency, y = p[v + 1] * frequency, z = p[v + 2] * frequency;
                vx += (Math.sin(y * 1.3 + time) + Math.cos(z * 0.7 - time * 0.8)) * turbulence * 0.5 * step;
                vy += (Math.sin(z * 1.1 + time * 1.2) + Math.cos(x * 0.9 + time * 0.5)) * turbulence * 0.5 * step;
                vz += (Math.sin(x * 1.2 - time * 0.9) + Math.cos(y * 1.5 + time * 1.1)) * turbulence * 0.5 * step;
            }
            vx *= damping;
            vy *= damping;
            vz *= damping;
            const life = age / this.lifetimes[i];
            const pace = this.speedTable[Math.round(life * (BAKE_SAMPLES - 1))];
            let nx = p[v] + vx * pace * step;
            let ny = p[v + 1] + vy * pace * step;
            let nz = p[v + 2] + vz * pace * step;
            if (orbit !== 0) {
                // Circling the emitter's vertical axis.
                const rx = nx - cx, rz = nz - cz;
                const angle = orbit * step;
                const cos = Math.cos(angle), sin = Math.sin(angle);
                nx = cx + rx * cos + rz * sin;
                nz = cz - rx * sin + rz * cos;
            }
            if (collide && checks < this.collisionBudget && (i + this.count - checkFrom) % this.count < this.collisionBudget) {
                checks++;
                const hit = raycast!(p[v], p[v + 1], p[v + 2], nx, ny, nz);
                if (hit) {
                    if (this.wants.collision) {
                        p[v] = hit.x; p[v + 1] = hit.y; p[v + 2] = hit.z;
                        vel[v] = vx; vel[v + 1] = vy; vel[v + 2] = vz;
                        this.pushEvent('collision', i);
                    }
                    if (effect.collision.kill) {
                        if (this.wants.death) {
                            p[v] = hit.x; p[v + 1] = hit.y; p[v + 2] = hit.z;
                            this.pushEvent('death', i);
                        }
                        this.remove(i);
                        continue;
                    }
                    // Bounce: the speed into the surface reversed and cut, the speed along it slowed.
                    const into = vx * hit.nx + vy * hit.ny + vz * hit.nz;
                    const tx = vx - into * hit.nx, ty = vy - into * hit.ny, tz = vz - into * hit.nz;
                    const keep = 1 - effect.collision.friction;
                    const bounce = into < 0 ? -into * effect.collision.bounce : into;
                    vx = tx * keep + hit.nx * bounce;
                    vy = ty * keep + hit.ny * bounce;
                    vz = tz * keep + hit.nz * bounce;
                    nx = hit.x + hit.nx * 0.01;
                    ny = hit.y + hit.ny * 0.01;
                    nz = hit.z + hit.nz * 0.01;
                }
            }
            p[v] = nx; p[v + 1] = ny; p[v + 2] = nz;
            vel[v] = vx; vel[v + 1] = vy; vel[v + 2] = vz;
            this.ages[i] = age;
            this.rotations[i] += this.spins[i] * step;
            i++;
        }
        if (this.count > 0) this.collisionCursor = (checkFrom + checks) % this.count;
    }

    private emit(step: number, world: ArrayLike<number>, previous: Float64Array | null, moved: number): void {
        const effect = this.effect;
        if (!this.emitting || this.finished) return;
        this.clock += step;
        let left = step;
        // The start delay.
        if (this.clock - step < effect.delay) {
            const waited = Math.min(left, effect.delay - (this.clock - step));
            left -= waited;
            if (left <= 0) return;
        }
        // Rate over distance: laid along the path the emitter moved, oldest first.
        if (effect.rateOverDistance > 0 && previous && moved > 0) {
            this.distanceCarry += moved * effect.rateOverDistance;
            const due = Math.floor(this.distanceCarry + 1e-6);
            this.distanceCarry -= due;
            for (let k = 0; k < due; k++) {
                const s = (k + 1) / due;
                const along = previous.slice();
                for (let m = 12; m < 15; m++) along[m] = previous[m] + (world[m] - previous[m]) * s;
                this.spawn(this.effect.space === 'local' ? null : along, step * (1 - s));
            }
        }
        // The cycle: bursts at their times, the continuous rate spread evenly.
        const duration = Math.max(0.05, effect.duration);
        const local = this.effect.space === 'local';
        while (left > 0 && !this.finished) {
            const active = Math.min(left, duration - this.cycleTime);
            const end = this.cycleTime + active;
            const bursts = effect.bursts;
            while (this.burstsDone < bursts.length && bursts[this.burstsDone].time <= end + 1e-9) {
                const burst = bursts[this.burstsDone];
                const age = Math.max(0, end - burst.time);
                for (let k = 0; k < burst.count; k++) this.spawn(local ? null : world, age);
                this.burstsDone++;
            }
            this.carry += effect.rate * active;
            // A hair over, so whole numbers summed from fractions of a step are not lost to rounding.
            const due = Math.floor(this.carry + 1e-6);
            this.carry -= due;
            for (let k = 0; k < due; k++) this.spawn(local ? null : world, (left - active) + active * (1 - (k + 0.5) / due));
            this.cycleTime = end;
            left -= active;
            if (this.cycleTime >= duration - 1e-9) {
                this.cycleTime = 0;
                this.burstsDone = 0;
                if (!effect.loop) {
                    this.finished = true;
                    this.carry = 0;
                }
            }
        }
    }

    /**
     * One particle from the shape, `age` seconds old. `matrix` places a world-space spawn (null for
     * local space, or when `offset` places it); `vx..vz` add a starting velocity.
     */
    private spawn(matrix: ArrayLike<number> | null, age: number, vx = 0, vy = 0, vz = 0, offset: number[] | null = null): void {
        if (this.count >= this.capacity) return;
        const effect = this.effect;
        const r = this.random;
        const lifetime = between(effect.lifetime[0], effect.lifetime[1], r());
        if (age >= lifetime) return;
        const shape = effect.shape;
        // The launch axis and two directions across it.
        let ax = shape.axis[0], ay = shape.axis[1], az = shape.axis[2];
        const axisLength = Math.hypot(ax, ay, az) || 1;
        ax /= axisLength; ay /= axisLength; az /= axisLength;
        let ux = 1, uy = 0, uz = 0;
        if (Math.abs(ax) > 0.9) { ux = 0; uy = 1; }
        // w = a × u, then u = w × a.
        let wx = ay * uz - az * uy, wy = az * ux - ax * uz, wz = ax * uy - ay * ux;
        const wl = Math.hypot(wx, wy, wz) || 1;
        wx /= wl; wy /= wl; wz /= wl;
        ux = wy * az - wz * ay; uy = wz * ax - wx * az; uz = wx * ay - wy * ax;

        const cone = (angleDeg: number, out: number[]) => {
            const cosMax = Math.cos(angleDeg * Math.PI / 180);
            const cosT = 1 - r() * (1 - cosMax);
            const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
            const phi = 2 * Math.PI * r();
            const cu = sinT * Math.cos(phi), cw = sinT * Math.sin(phi);
            out[0] = ax * cosT + ux * cu + wx * cw;
            out[1] = ay * cosT + uy * cu + wy * cw;
            out[2] = az * cosT + uz * cu + wz * cw;
        };
        const randomUnit = (out: number[]) => {
            const z = 2 * r() - 1;
            const t = 2 * Math.PI * r();
            const s = Math.sqrt(1 - z * z);
            out[0] = s * Math.cos(t); out[1] = s * Math.sin(t); out[2] = z;
        };
        const depth = () => 1 - shape.volume + shape.volume * r();
        const pos = [0, 0, 0];
        const dir = [0, 1, 0];
        switch (shape.kind) {
            case 'point':
                cone(shape.angle, dir);
                break;
            case 'sphere':
            case 'hemisphere': {
                randomUnit(dir);
                if (shape.kind === 'hemisphere') {
                    const along = dir[0] * ax + dir[1] * ay + dir[2] * az;
                    if (along < 0) for (let k = 0; k < 3; k++) dir[k] -= 2 * along * shape.axis[k] / axisLength;
                }
                const radius = shape.radius * Math.cbrt(depth());
                for (let k = 0; k < 3; k++) pos[k] = dir[k] * radius;
                break;
            }
            case 'cone':
            case 'circle': {
                const phi = 2 * Math.PI * r();
                const fraction = Math.sqrt(depth());
                const cu = Math.cos(phi) * fraction, cw = Math.sin(phi) * fraction;
                pos[0] = (ux * cu + wx * cw) * shape.radius;
                pos[1] = (uy * cu + wy * cw) * shape.radius;
                pos[2] = (uz * cu + wz * cw) * shape.radius;
                if (shape.kind === 'cone') {
                    // Opens outwards: the further from the middle, the more it leans out.
                    const lean = shape.angle * Math.PI / 180 * fraction;
                    const rl = Math.hypot(cu, cw) || 1;
                    const ox = (ux * cu + wx * cw) / rl, oy = (uy * cu + wy * cw) / rl, oz = (uz * cu + wz * cw) / rl;
                    dir[0] = ax * Math.cos(lean) + ox * Math.sin(lean);
                    dir[1] = ay * Math.cos(lean) + oy * Math.sin(lean);
                    dir[2] = az * Math.cos(lean) + oz * Math.sin(lean);
                } else cone(shape.angle, dir);
                break;
            }
            case 'box': {
                const [sx, sy, sz] = shape.size;
                if (shape.volume >= 1 || r() < shape.volume) {
                    pos[0] = (r() - 0.5) * sx; pos[1] = (r() - 0.5) * sy; pos[2] = (r() - 0.5) * sz;
                } else {
                    // A face, picked by its area.
                    const areas = [sy * sz, sx * sz, sx * sy];
                    const pick = r() * (areas[0] + areas[1] + areas[2]);
                    const axis = pick < areas[0] ? 0 : pick < areas[0] + areas[1] ? 1 : 2;
                    pos[0] = (r() - 0.5) * sx; pos[1] = (r() - 0.5) * sy; pos[2] = (r() - 0.5) * sz;
                    pos[axis] = (r() < 0.5 ? -0.5 : 0.5) * shape.size[axis];
                }
                cone(shape.angle, dir);
                break;
            }
            case 'edge':
                pos[0] = (r() - 0.5) * shape.size[0];
                cone(shape.angle, dir);
                break;
            case 'mesh': {
                const sampler = this.mesh;
                if (!sampler) { cone(shape.angle, dir); break; }
                const pick = r();
                let lo = 0, hi = sampler.cdf.length - 1;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (sampler.cdf[mid] < pick) lo = mid + 1; else hi = mid;
                }
                const { positions: mp, indices } = sampler.surface;
                const a = indices[lo * 3] * 3, b = indices[lo * 3 + 1] * 3, c = indices[lo * 3 + 2] * 3;
                let s = r(), t = r();
                if (s + t > 1) { s = 1 - s; t = 1 - t; }
                for (let k = 0; k < 3; k++) pos[k] = mp[a + k] + (mp[b + k] - mp[a + k]) * s + (mp[c + k] - mp[a + k]) * t;
                const e1 = [mp[b] - mp[a], mp[b + 1] - mp[a + 1], mp[b + 2] - mp[a + 2]];
                const e2 = [mp[c] - mp[a], mp[c + 1] - mp[a + 1], mp[c + 2] - mp[a + 2]];
                const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
                const nl = Math.hypot(n[0], n[1], n[2]) || 1;
                for (let k = 0; k < 3; k++) dir[k] = n[k] / nl;
                break;
            }
        }
        if (shape.randomDirection > 0) {
            const random = [0, 0, 0];
            randomUnit(random);
            for (let k = 0; k < 3; k++) dir[k] += (random[k] - dir[k]) * shape.randomDirection;
            const length = Math.hypot(dir[0], dir[1], dir[2]) || 1;
            for (let k = 0; k < 3; k++) dir[k] /= length;
        }
        let px = pos[0], py = pos[1], pz = pos[2];
        let dx = dir[0], dy = dir[1], dz = dir[2];
        if (matrix) {
            const m = matrix;
            px = m[0] * pos[0] + m[4] * pos[1] + m[8] * pos[2] + m[12];
            py = m[1] * pos[0] + m[5] * pos[1] + m[9] * pos[2] + m[13];
            pz = m[2] * pos[0] + m[6] * pos[1] + m[10] * pos[2] + m[14];
            const tx = m[0] * dir[0] + m[4] * dir[1] + m[8] * dir[2];
            const ty = m[1] * dir[0] + m[5] * dir[1] + m[9] * dir[2];
            const tz = m[2] * dir[0] + m[6] * dir[1] + m[10] * dir[2];
            const length = Math.hypot(tx, ty, tz) || 1;
            dx = tx / length; dy = ty / length; dz = tz / length;
        } else if (offset) {
            px += offset[0]; py += offset[1]; pz += offset[2];
        }
        const speed = between(effect.speed[0], effect.speed[1], r());
        const inherit = effect.inheritVelocity;
        const i = this.count;
        const v = i * 3;
        const fx = dx * speed + vx + this.emitterVelocity[0] * inherit;
        const fy = dy * speed + vy + this.emitterVelocity[1] * inherit;
        const fz = dz * speed + vz + this.emitterVelocity[2] * inherit;
        this.velocities[v] = fx; this.velocities[v + 1] = fy; this.velocities[v + 2] = fz;
        // Placed where it would be after `age` seconds of flight, so emission within a step is smooth.
        this.positions[v] = px + fx * age;
        this.positions[v + 1] = py + (fy - 0.5 * effect.gravity * age) * age;
        this.positions[v + 2] = pz + fz * age;
        this.ages[i] = age;
        this.lifetimes[i] = lifetime;
        this.startSizes[i] = between(effect.size[0], effect.size[1], r());
        this.rotations[i] = between(effect.rotation[0], effect.rotation[1], r()) * Math.PI / 180;
        this.spins[i] = between(effect.spin[0], effect.spin[1], r()) * Math.PI / 180;
        const mix = r();
        for (let k = 0; k < 3; k++) this.startColors[v + k] = this.startA[k] + (this.startB[k] - this.startA[k]) * mix;
        this.seeds[i] = r();
        this.count = i + 1;
    }

    private pushEvent(trigger: SubEmitterTrigger, i: number): void {
        if (this.events.length >= 256) return;
        const v = i * 3;
        let x = this.positions[v], y = this.positions[v + 1], z = this.positions[v + 2];
        if (this.effect.space === 'local' && this.last) {
            const m = this.last;
            const lx = x, ly = y, lz = z;
            x = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
            y = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
            z = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
        }
        this.events.push({ trigger, x, y, z, vx: this.velocities[v], vy: this.velocities[v + 1], vz: this.velocities[v + 2] });
    }

    private remove(index: number): void {
        const last = this.count - 1;
        if (index !== last) {
            const a = index * 3, b = last * 3;
            for (let k = 0; k < 3; k++) {
                this.positions[a + k] = this.positions[b + k];
                this.velocities[a + k] = this.velocities[b + k];
                this.startColors[a + k] = this.startColors[b + k];
            }
            this.ages[index] = this.ages[last];
            this.lifetimes[index] = this.lifetimes[last];
            this.startSizes[index] = this.startSizes[last];
            this.rotations[index] = this.rotations[last];
            this.spins[index] = this.spins[last];
            this.seeds[index] = this.seeds[last];
        }
        this.count = last;
    }

    private fillRender(): void {
        const render = this.effect.render;
        const frames = render.columns * render.rows;
        for (let i = 0; i < this.count; i++) {
            const life = this.ages[i] / this.lifetimes[i];
            const sample = Math.round(Math.min(1, Math.max(0, life)) * (BAKE_SAMPLES - 1));
            const c = i * 4, v = i * 3, g = sample * 4;
            this.colors[c] = this.startColors[v] * this.colorTable[g];
            this.colors[c + 1] = this.startColors[v + 1] * this.colorTable[g + 1];
            this.colors[c + 2] = this.startColors[v + 2] * this.colorTable[g + 2];
            this.colors[c + 3] = this.colorTable[g + 3];
            this.sizes[i] = this.startSizes[i] * this.sizeTable[sample];
            this.frames[i] = frames <= 1 ? 0
                : render.frameMode === 'life' ? Math.min(frames - 1, Math.floor(life * frames))
                    : render.frameMode === 'fps' ? Math.floor(this.seeds[i] * frames + this.ages[i] * render.fps) % frames
                        : Math.floor(this.seeds[i] * frames);
        }
    }
}
