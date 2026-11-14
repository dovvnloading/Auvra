import { MAX_PARTICLE_FORCE_FIELDS, type ParticleForceField } from './particleEffect';

/** Three vec4s per field, shared by the CPU, WebGL and WebGPU simulations. */
export const PARTICLE_FORCE_FIELD_FLOATS = 12;
const kindCode = { radial: 0, vortex: 1, directional: 2 } as const;

/** Pack enabled fields in simulation space. Pass the emitter's world matrix for world-space simulations. */
export const prepareParticleForceFields = (
    fields: readonly ParticleForceField[], matrix: ArrayLike<number> | null, out: Float32Array,
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
