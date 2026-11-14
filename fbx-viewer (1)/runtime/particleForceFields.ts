import { MAX_PARTICLE_FORCE_FIELDS, PARTICLE_CURL_DEFAULTS, type ParticleForceField } from './particleEffect';

/** Three vec4s per field, shared by the CPU, WebGL and WebGPU simulations. */
export const PARTICLE_FORCE_FIELD_FLOATS = 12;
const kindCode = { radial: 0, vortex: 1, directional: 2, curl: 3 } as const;

const TAU = 2 * Math.PI;
function curlPhase(seed: number, channel: number, time: number): number {
    // Hash the authored seed on the host, so all three backends receive the same small angles.
    let h = Math.imul(seed + 1, 0x9e3779b1) ^ channel;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    const phase = ((h ^ (h >>> 16)) >>> 0) * (TAU / 0x100000000);
    return (phase + time) % TAU;
}

/** Pack enabled fields in simulation space. Pass the emitter's world matrix for world-space simulations. */
export const prepareParticleForceFields = (
    fields: readonly ParticleForceField[], matrix: ArrayLike<number> | null, out: Float32Array, elapsed = 0,
): number => {
    let count = 0;
    for (const field of fields) {
        if (count === MAX_PARTICLE_FORCE_FIELDS) break;
        if (!field.enabled || field.radius <= 0 || field.strength === 0) continue;
        const [x, y, z] = field.center;
        let [ax, ay, az] = field.axis;
        if (ax === 0 && ay === 0 && az === 0) ay = 1;
        const offset = count * PARTICLE_FORCE_FIELD_FLOATS;
        if (matrix) {
            out[offset] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
            out[offset + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
            out[offset + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
            const tx = matrix[0] * ax + matrix[4] * ay + matrix[8] * az;
            const ty = matrix[1] * ax + matrix[5] * ay + matrix[9] * az;
            az = matrix[2] * ax + matrix[6] * ay + matrix[10] * az;
            ax = tx;
            ay = ty;
        } else {
            out[offset] = x;
            out[offset + 1] = y;
            out[offset + 2] = z;
        }
        const length = Math.hypot(ax, ay, az);
        out[offset + 3] = field.radius;
        out[offset + 4] = length > 0 ? ax / length : 0;
        out[offset + 5] = length > 0 ? ay / length : 1;
        out[offset + 6] = length > 0 ? az / length : 0;
        out[offset + 7] = field.strength;
        out[offset + 8] = kindCode[field.kind];
        out[offset + 9] = field.falloff;
        out[offset + 10] = 0;
        out[offset + 11] = 0;
        if (field.kind === 'curl') {
            const seed = field.seed ?? PARTICLE_CURL_DEFAULTS.seed;
            const time = elapsed * (field.evolution ?? PARTICLE_CURL_DEFAULTS.evolution);
            const scale = field.scale ?? PARTICLE_CURL_DEFAULTS.scale;
            out[offset + 4] = curlPhase(seed, 0, time);
            out[offset + 5] = curlPhase(seed, 1, -0.73 * time);
            out[offset + 6] = curlPhase(seed, 2, 0.47 * time);
            out[offset + 10] = 1 / scale;
            // Bounds both the curl of the carrier and the contribution from the spherical envelope.
            out[offset + 11] = 1 / (3 + 4 * (field.falloff + 2) * scale / field.radius);
        }
        count++;
    }
    return count;
};

/** Apply the stack before damping and integration. Keeping it in its own pass leaves field-free effects' inner loop intact. */
export const applyParticleForceFields = (
    data: Float32Array, fieldCount: number, step: number, count: number,
    positions: Float32Array, velocities: Float32Array, ages: Float32Array, lifetimes: Float32Array,
): void => {
    for (let i = 0; i < fieldCount * PARTICLE_FORCE_FIELD_FLOATS; i += PARTICLE_FORCE_FIELD_FLOATS) {
        const cx = data[i], cy = data[i + 1], cz = data[i + 2];
        const radius = data[i + 3];
        const radiusSquared = radius * radius;
        const axisX = data[i + 4], axisY = data[i + 5], axisZ = data[i + 6];
        const impulse = data[i + 7] * step;
        const kind = data[i + 8], falloff = data[i + 9];
        for (let particle = 0; particle < count; particle++) {
            if (ages[particle] + step >= lifetimes[particle]) continue;
            const v = particle * 3;
            const dx = positions[v] - cx, dy = positions[v + 1] - cy, dz = positions[v + 2] - cz;
            const distanceSquared = dx * dx + dy * dy + dz * dz;
            if (distanceSquared >= radiusSquared) continue;
            if (kind === kindCode.curl) {
                // curl(F A/k) = F curl(A)/k + grad(F) × A/k. Including the second term keeps
                // the bounded field divergence-free even through the falloff and at the sphere's edge.
                const k = data[i + 10], exponent = falloff + 2;
                const h = 1 - distanceSquared / radiusSquared;
                const shape = h ** (exponent - 1);
                const envelope = h * shape;
                const gradient = -2 * exponent * shape / (radiusSquared * k);
                const tx = k * (dy + 0.5 * dz) + axisX;
                const ty = k * (dz + 0.7 * dx) + axisY;
                const tz = k * (dx - 0.6 * dy) + axisZ;
                const sx = Math.sin(tx), sy = Math.sin(ty), sz = Math.sin(tz);
                const cosX = Math.cos(tx), cosY = Math.cos(ty), cosZ = Math.cos(tz);
                const magnitude = impulse * data[i + 11];
                velocities[v] += magnitude * (envelope * (-0.6 * cosZ - cosY) + gradient * (dy * sz - dz * sy));
                velocities[v + 1] += magnitude * (envelope * (0.5 * cosX - cosZ) + gradient * (dz * sx - dx * sz));
                velocities[v + 2] += magnitude * (envelope * (0.7 * cosY - cosX) + gradient * (dx * sy - dy * sx));
                continue;
            }
            const distance = Math.sqrt(distanceSquared);
            const edge = 1 - distance / radius;
            let magnitude = impulse;
            if (falloff === 1) magnitude *= edge;
            else if (falloff === 2) magnitude *= edge * edge;
            else if (falloff !== 0) magnitude *= edge ** falloff;
            let ax = axisX, ay = axisY, az = axisZ;
            if (kind === kindCode.radial) {
                if (distanceSquared <= 1e-12) continue;
                magnitude /= -distance;
                ax = dx; ay = dy; az = dz;
            } else if (kind === kindCode.vortex) {
                ax = axisY * dz - axisZ * dy;
                ay = axisZ * dx - axisX * dz;
                az = axisX * dy - axisY * dx;
                const tangentSquared = ax * ax + ay * ay + az * az;
                if (tangentSquared <= 1e-12) continue;
                magnitude /= Math.sqrt(tangentSquared);
            }
            velocities[v] += ax * magnitude;
            velocities[v + 1] += ay * magnitude;
            velocities[v + 2] += az * magnitude;
        }
    }
};
