/**
 * HOW A PICTURE IS LAID ON
 *
 * Where on a tiling picture a place on the model reads, for each way a fill is laid on: along the UVs,
 * from three sides, flat along one axis, round a ball or round a tube. Places are measured in the set's
 * space (a cube round the model), so every texture set of a model lines up. A mirrored fill folds the model
 * onto one side of its middle first, so both halves read alike. The fill cast shader (paintStack's CAST)
 * works these out the same way, texel by texel; this is the same reckoning for one place.
 */

export type ProjectionMode = 'uv' | 'triplanar' | 'planar' | 'spherical' | 'cylindrical';
export type ProjectionAxis = 'x' | 'y' | 'z';

export const PROJECTION_LABELS: Record<ProjectionMode, string> = {
    uv: 'Along the UVs',
    triplanar: 'From three sides (no seams)',
    planar: 'Flat, along one axis',
    spherical: 'Round a ball',
    cylindrical: 'Round a tube',
};

export const AXIS_INDEX: Record<ProjectionAxis, number> = { x: 0, y: 1, z: 2 };

type Vec3 = readonly [number, number, number];

/** A place (and its facing) folded onto the far side of the middle across `axis`, for a mirrored fill. */
export const folded = (position: Vec3, normal: Vec3, centre: Vec3, axis: number): { position: [number, number, number]; normal: [number, number, number] } => {
    const p: [number, number, number] = [position[0], position[1], position[2]];
    const n: [number, number, number] = [normal[0], normal[1], normal[2]];
    const d = p[axis] - centre[axis];
    if (d < 0) {
        p[axis] = centre[axis] - d;
        n[axis] = -n[axis];
    }
    return { position: p, normal: n };
};

/** The two other axes of an axis, in the order a picture's u and v take them. */
export const acrossOf = (axis: number): [number, number] => (axis === 0 ? [2, 1] : axis === 1 ? [0, 2] : [0, 1]);

/**
 * Where a place reads on the picture, before the picture's turn: flat along `axis` (the place on the
 * plane square to it), round a ball with its poles on `axis` (round and down), or round a tube along
 * `axis` (round and along). `scale` is the repeats: across the model's size for flat, round the whole way
 * round a ball or tube.
 */
export const projectedUv = (mode: Exclude<ProjectionMode, 'uv' | 'triplanar'>, position: Vec3, space: { centre: Vec3; extent: number; offset: number }, axis: number, scale: number): [number, number] => {
    const d = [0, 1, 2].map((k) => position[k] - space.centre[k]);
    const [a, b] = acrossOf(axis);
    if (mode === 'planar') return [(d[a] / space.extent + space.offset) * scale, (d[b] / space.extent + space.offset) * scale];
    const around = Math.atan2(d[b], d[a]) / (2 * Math.PI) + 0.5;
    if (mode === 'cylindrical') return [around * scale, (d[axis] / space.extent + space.offset) * scale];
    const length = Math.hypot(d[0], d[1], d[2]) || 1;
    const down = Math.acos(Math.min(1, Math.max(-1, d[axis] / length))) / Math.PI;
    return [around * scale, down * scale];
};
