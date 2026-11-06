/**
 * TRIPLANAR NORMAL MAPS
 *
 * A normal map projected onto a surface from the three axes, as the Triplanar Normal Map node draws it:
 * each projection reads the map the right way round seen from outside its face (its u runs to the face's
 * right and its v up, so the frame they make with the face's normal is right-handed and opposite faces are
 * not mirrored), the map's own x turns with its u, and each projection's normal is laid onto the surface's
 * with a whiteout blend before the three are mixed by how squarely the surface faces each axis. The result
 * is a world-space normal: the Material Output takes it with its Normal input set to world space.
 *
 * `triplanarNormal` is the same maths in TypeScript, the reference the GLSL follows (and what the tests
 * check); MG_TRIPLANAR_NORMAL is the GLSL.
 */

export type Vec3 = [number, number, number];

const normalize = ([x, y, z]: Vec3): Vec3 => {
    const length = Math.hypot(x, y, z) || 1;
    return [x / length, y / length, z / length];
};

/** Which way a surface faces along each axis (+1 or -1; 0 counts as +1). */
const facingOf = (normal: Vec3): Vec3 => normal.map(component => (component < 0 ? -1 : 1)) as Vec3;

/** Where each projection reads the map, seen from outside the face it serves. */
export const triplanarUvs = (position: Vec3, normal: Vec3): { x: [number, number]; y: [number, number]; z: [number, number] } => {
    const facing = facingOf(normal);
    return {
        x: [-facing[0] * position[2], position[1]],
        y: [-facing[1] * position[0], position[2]],
        z: [facing[2] * position[0], position[1]],
    };
};

/**
 * The world normal a normal map projected from the three axes gives a surface facing `surface` at
 * `position` (already scaled by the tiling). `sample` reads the map at a UV as a tangent-space normal
 * (-1..1, z out of the surface).
 */
export const triplanarNormal = (surface: Vec3, position: Vec3, sample: (uv: [number, number]) => Vec3, sharpness = 4, strength = 1): Vec3 => {
    const n = normalize(surface);
    const raised = n.map(component => Math.abs(component) ** sharpness) as Vec3;
    const sum = Math.max(raised[0] + raised[1] + raised[2], 1e-5);
    const weights = raised.map(weight => weight / sum) as Vec3;
    const facing = facingOf(n);
    const uvs = triplanarUvs(position, n);
    const read = (uv: [number, number], flip: number): Vec3 => {
        const [x, y, z] = sample(uv);
        return [x * strength * flip, y * strength, z];
    };
    const x = read(uvs.x, -facing[0]);
    const y = read(uvs.y, -facing[1]);
    const z = read(uvs.z, facing[2]);
    // Whiteout blend: each projection's normal laid onto the surface's, in that projection's axes.
    const onX: Vec3 = [x[0] + n[2], x[1] + n[1], Math.abs(x[2]) * n[0]];
    const onY: Vec3 = [y[0] + n[0], y[1] + n[2], Math.abs(y[2]) * n[1]];
    const onZ: Vec3 = [z[0] + n[0], z[1] + n[1], Math.abs(z[2]) * n[2]];
    // Back to world axes: X's projection is (z, y, x), Y's (x, z, y), Z's (x, y, z).
    return normalize([
        onX[2] * weights[0] + onY[0] * weights[1] + onZ[0] * weights[2],
        onX[1] * weights[0] + onY[2] * weights[1] + onZ[1] * weights[2],
        onX[0] * weights[0] + onY[1] * weights[1] + onZ[2] * weights[2],
    ]);
};

/** The same in GLSL: `green` is -1 to flip a DirectX map's green, else 1. */
export const MG_TRIPLANAR_NORMAL = `
vec3 mgTriplanarNormal(sampler2D map, vec3 position, vec3 normal, float sharpness, float strength, float green) {
    vec3 n = normalize(normal);
    vec3 weights = pow(abs(n), vec3(sharpness));
    weights /= max(weights.x + weights.y + weights.z, 1e-5);
    vec3 facing = vec3(n.x < 0.0 ? -1.0 : 1.0, n.y < 0.0 ? -1.0 : 1.0, n.z < 0.0 ? -1.0 : 1.0);
    vec3 x = texture(map, vec2(-facing.x * position.z, position.y)).xyz * 2.0 - 1.0;
    vec3 y = texture(map, vec2(-facing.y * position.x, position.z)).xyz * 2.0 - 1.0;
    vec3 z = texture(map, vec2(facing.z * position.x, position.y)).xyz * 2.0 - 1.0;
    x.y *= green; y.y *= green; z.y *= green;
    x.xy *= strength; y.xy *= strength; z.xy *= strength;
    x.x *= -facing.x; y.x *= -facing.y; z.x *= facing.z;
    x = vec3(x.xy + n.zy, abs(x.z) * n.x);
    y = vec3(y.xy + n.xz, abs(y.z) * n.y);
    z = vec3(z.xy + n.xy, abs(z.z) * n.z);
    return normalize(x.zyx * weights.x + y.xzy * weights.y + z.xyz * weights.z);
}`;
