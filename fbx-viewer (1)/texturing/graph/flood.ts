/**
 * FLOOD FILL ON THE GPU
 *
 * Finds the separate islands of a mask without reading it back. Every pixel inside starts as its own
 * label (its place); rounds of two steps follow until no label changes: each pixel takes the least
 * label of itself and its four neighbours inside (hooking), then the label its label points at
 * (pointer jumping), which shortens the chains so labels cross a big island in few rounds. Where the
 * image repeats, neighbours across an edge count, so an island over the edge is one island.
 *
 * Then every pixel adds its offset from its island's root into the root (largest each way), which
 * gives each island its bounding box; and each pixel's result says where it lies in the box, a random
 * value for the island and the box's size. The reference here does the same on the CPU, for the tests.
 */

export type Wrap = [boolean, boolean];

/** Labels compare by row, then by place in the row. */
const lessThan = (a: number, b: number, width: number): boolean => Math.floor(a / width) < Math.floor(b / width) || (Math.floor(a / width) === Math.floor(b / width) && a % width < b % width);

/**
 * The GPU labelling done on the CPU: each pixel's island label (the index of its island's root, the
 * first pixel by rows), -1 outside. `rounds` counts the rounds it took.
 */
export const labelReference = (mask: ArrayLike<number>, width: number, height: number, wrap: Wrap = [false, false], threshold = 0.5): { labels: Int32Array; rounds: number } => {
    let labels = new Int32Array(width * height);
    for (let i = 0; i < labels.length; i++) labels[i] = (mask[i] ?? 0) >= threshold ? i : -1;
    const neighbour = (x: number, y: number): number => {
        if (wrap[0]) x = ((x % width) + width) % width; else if (x < 0 || x >= width) return -1;
        if (wrap[1]) y = ((y % height) + height) % height; else if (y < 0 || y >= height) return -1;
        return y * width + x;
    };
    let rounds = 0;
    for (;;) {
        rounds++;
        // Hooking: the least label among itself and its neighbours inside.
        const hooked = new Int32Array(labels);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = y * width + x;
                if (labels[i] < 0) continue;
                let best = labels[i];
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const n = neighbour(x + dx, y + dy);
                    if (n >= 0 && labels[n] >= 0 && lessThan(labels[n], best, width)) best = labels[n];
                }
                hooked[i] = best;
            }
        }
        // Pointer jumping, twice: the label its label points at.
        let jumped = hooked;
        for (let jump = 0; jump < 2; jump++) {
            const next = new Int32Array(jumped);
            for (let i = 0; i < next.length; i++) {
                if (jumped[i] < 0) continue;
                const pointed = jumped[jumped[i]];
                if (pointed >= 0 && lessThan(pointed, jumped[i], width)) next[i] = pointed;
            }
            jumped = next;
        }
        let changed = false;
        for (let i = 0; i < labels.length; i++) if (jumped[i] !== labels[i]) { changed = true; break; }
        labels = jumped;
        if (!changed || rounds > width * height) break;
    }
    return { labels, rounds };
};

/** An offset taken the short way round along the axes that repeat. */
export const shortestOffset = (d: number, size: number, repeats: boolean): number => (repeats ? d - size * Math.round(d / size) : d);

/**
 * Where offsets from an island's root wrap round, as parts of the picture, on an axis that repeats: the
 * shortest way (halfway round) and three more a quarter apart. A box is worked out for each; the
 * narrowest is the island's, since its seam lies in the gap beside the island. So an island more than
 * half the picture across still gets its own box, whenever a quarter of the picture is free of it.
 */
export const FLOOD_SEAMS: readonly number[] = [0.5, 0.75, 1, 0.25];

/** An offset made to lie from `seam` (as a part of the picture) less the picture's size, up to `seam`. */
export const seamOffset = (d: number, size: number, seam: number, repeats: boolean): number => {
    if (!repeats) return d;
    const s = seam * size;
    return d - size * (Math.floor((d - s) / size) + 1);
};

/**
 * Exact CPU oracle for the minimum interval covering a component on a repeating
 * axis. Sort its *occupied* pixel positions, then exclude the largest circular
 * gap. The GPU's four fixed seams do NOT yet compute this exact answer.
 *
 * This oracle is deliberately separate from islandSpan (which reproduces the
 * current GPU approximation). It must not be used as evidence of GPU parity
 * until device-backed tests compare the GPU's resulting boxes against it.
 */
export const exactIslandSpan = (
    places: readonly number[], root: number, size: number, repeats: boolean,
): { low: number; size: number } => {
    if (!places.length) return { low: 0, size: 0 };
    if (!Number.isInteger(size) || size < 1) throw new Error('An island axis must have a positive integer size.');
    if (!repeats) {
        let min = Infinity, max = -Infinity;
        for (const place of places) { min = Math.min(min, place); max = Math.max(max, place); }
        return { low: min - root, size: max - min + 1 };
    }
    const mod = (n: number) => ((n % size) + size) % size;
    const unique = [...new Set(places.map(mod))].sort((a, b) => a - b);
    const rooted = mod(root);
    let largestGap = -1;
    let rootDistance = Infinity;
    for (let i = 0; i < unique.length; i++) {
        const next = i === unique.length - 1 ? unique[0] + size : unique[i + 1];
        const gap = next - unique[i] - 1;
        const start = mod(next);
        const distance = mod(rooted - start);
        // Equal largest gaps describe equivalent minimum-size boxes. Prefer
        // the one closest to the root so completely filled axes have low=0.
        if (gap > largestGap || (gap === largestGap && distance < rootDistance)) {
            largestGap = gap;
            rootDistance = distance;
        }
    }
    return { low: -rootDistance, size: size - largestGap };
};

/**
 * One axis of an island's box as the shaders work it out: the low end (from the root) and the size, the
 * narrowest over the seams. `places` are the island's pixels along the axis; `root` its root's.
 */
export const islandSpan = (places: readonly number[], root: number, size: number, repeats: boolean): { low: number; size: number } => {
    let best = { low: 0, size: Infinity };
    for (const seam of repeats ? FLOOD_SEAMS : [0.5]) {
        let low = Infinity;
        let high = -Infinity;
        for (const place of places) {
            const d = seamOffset(place - root, size, seam, repeats);
            low = Math.min(low, d);
            high = Math.max(high, d);
        }
        if (high - low + 1 < best.size) best = { low, size: high - low + 1 };
    }
    return best;
};

/**
 * A bounding box's size kept in one float exactly: 12 bits each of its width and height, as parts of the
 * image (so to 1/4095 of the image each way).
 */
export const packBoxSize = (width: number, height: number, imageWidth: number, imageHeight: number): number =>
    Math.round(Math.min(1, width / imageWidth) * 4095) * 4096 + Math.round(Math.min(1, height / imageHeight) * 4095);
export const unpackBoxSize = (packed: number): [number, number] => [Math.floor(packed / 4096) / 4095, (packed % 4096) / 4095];

// ---- the shaders ----

const COMMON = `uniform ivec2 uWrapAxes;
bool labelLess(vec2 a, vec2 b) { return a.y < b.y || (a.y == b.y && a.x < b.x); }
vec4 labelAt(ivec2 p) {
    ivec2 size = ivec2(uSize);
    if (uWrapAxes.x == 1) p.x = (p.x % size.x + size.x) % size.x; else if (p.x < 0 || p.x >= size.x) return vec4(0.0);
    if (uWrapAxes.y == 1) p.y = (p.y % size.y + size.y) % size.y; else if (p.y < 0 || p.y >= size.y) return vec4(0.0);
    return texelFetch(labels, p, 0);
}
vec2 shortestOffset(vec2 d) {
    if (uWrapAxes.x == 1) d.x -= uSize.x * floor(d.x / uSize.x + 0.5);
    if (uWrapAxes.y == 1) d.y -= uSize.y * floor(d.y / uSize.y + 0.5);
    return d;
}`;

/** Each pixel inside the mask its own label (its place); outside, none. */
export const FLOOD_START = `uniform float uThreshold;
uniform int uGray;
void main() {
    vec4 m = texture(mask, vUv);
    float v = uGray == 1 ? m.r : luma(m.rgb);
    vec2 p = floor(gl_FragCoord.xy);
    outColor = v >= uThreshold ? vec4(p, 1.0, 0.0) : vec4(0.0);
}`;

/** Hooking: the least label of the pixel and its four neighbours inside. */
export const FLOOD_HOOK = `${COMMON}
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 self = texelFetch(labels, p, 0);
    if (self.z < 0.5) { outColor = self; return; }
    vec2 best = self.xy;
    vec4 q = labelAt(p + ivec2(1, 0)); if (q.z > 0.5 && labelLess(q.xy, best)) best = q.xy;
    q = labelAt(p + ivec2(-1, 0)); if (q.z > 0.5 && labelLess(q.xy, best)) best = q.xy;
    q = labelAt(p + ivec2(0, 1)); if (q.z > 0.5 && labelLess(q.xy, best)) best = q.xy;
    q = labelAt(p + ivec2(0, -1)); if (q.z > 0.5 && labelLess(q.xy, best)) best = q.xy;
    outColor = vec4(best, 1.0, 0.0);
}`;

/** Pointer jumping: the label the pixel's label points at, when less. */
export const FLOOD_JUMP = `void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 self = texelFetch(labels, p, 0);
    if (self.z < 0.5) { outColor = self; return; }
    vec4 pointed = texelFetch(labels, ivec2(self.xy), 0);
    bool less = pointed.y < self.y || (pointed.y == self.y && pointed.x < self.x);
    outColor = pointed.z > 0.5 && less ? vec4(pointed.xy, 1.0, 0.0) : self;
}`;

/** Where two label images differ (1), for telling when the labels have settled. */
export const FLOOD_CHANGED = `void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    outColor = vec4(texelFetch(before, p, 0).xy == texelFetch(labels, p, 0).xy ? 0.0 : 1.0);
}`;

/** A halving of a 0/1 image, keeping a 1 if any of the four pixels has one. */
export const FLOOD_ANY = `void main() {
    ivec2 p = ivec2(gl_FragCoord.xy) * 2;
    ivec2 last = textureSize(source, 0) - 1;
    float v = max(max(texelFetch(source, min(p, last), 0).r, texelFetch(source, min(p + ivec2(1, 0), last), 0).r), max(texelFetch(source, min(p + ivec2(0, 1), last), 0).r, texelFetch(source, min(p + ivec2(1, 1), last), 0).r));
    outColor = vec4(v);
}`;

/** A point a pixel, drawn at its island's root, carrying its offset from the root both ways (kept largest). */
const SEAM_OFFSET = `vec2 seamOffset(vec2 d, vec2 seam) {
    if (uWrapAxes.x == 1) d.x -= uSize.x * (floor((d.x - seam.x * uSize.x) / uSize.x) + 1.0);
    if (uWrapAxes.y == 1) d.y -= uSize.y * (floor((d.y - seam.y * uSize.y) / uSize.y) + 1.0);
    return d;
}`;

/** Each pixel adds its offset from its root (wrapping at the seam uSeam) into the root, largest each way. */
export const FLOOD_BOX_VERTEX = `${COMMON}
${SEAM_OFFSET}
uniform int uWidth;
uniform vec2 uSeam;
void placeCopy(int copy, vec2 corner, vec2 shift) {
    ivec2 p = ivec2(copy % uWidth, copy / uWidth);
    vec4 l = texelFetch(labels, p, 0);
    if (l.z < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec2 d = seamOffset(vec2(p) - l.xy, uSeam);
    gl_Position = vec4((l.xy + 0.5) / uSize * 2.0 - 1.0, 0.0, 1.0);
    vBox = vec4(-d, d);
}`;

/** Each pixel: where it lies in its island's box, the island's random value, and the box's size (packed). */
export const FLOOD_RESULT = `${COMMON}
${SEAM_OFFSET}
uniform int uSeamCount;
uniform vec4 uSeamsX;
uniform vec4 uSeamsY;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 l = texelFetch(labels, p, 0);
    if (l.z < 0.5) { outColor = vec4(0.0, 0.0, -1.0, 0.0); return; }
    ivec2 r = ivec2(l.xy);
    vec4 b[4];
    b[0] = texelFetch(boxes0, r, 0);
    b[1] = texelFetch(boxes1, r, 0);
    b[2] = texelFetch(boxes2, r, 0);
    b[3] = texelFetch(boxes3, r, 0);
    // Each way, the seam giving the narrowest box lies in the gap beside the island: that box is its own.
    int bx = 0;
    int by = 0;
    for (int i = 1; i < 4; i++) {
        if (i >= uSeamCount) break;
        if (b[i].z + b[i].x < b[bx].z + b[bx].x) bx = i;
        if (b[i].w + b[i].y < b[by].w + b[by].y) by = i;
    }
    vec2 low = -vec2(b[bx].x, b[by].y);
    vec2 size = vec2(b[bx].z, b[by].w) - low + 1.0;
    vec2 d = seamOffset(vec2(p) - l.xy, vec2(uSeamsX[bx], uSeamsY[by]));
    vec2 local = (d - low + 0.5) / size;
    vec2 corner = mod(l.xy + low, uSize);
    // A random value from the island's place and size, so it stays the same as the mask changes
    // elsewhere; 24 bits, which a full float holds exactly.
    uint key = hashU(uvec3(uvec2(corner), uint(size.x) * 16384u + uint(size.y)));
    float random = float(key >> 8u) / 16777216.0;
    float packed = floor(min(1.0, size.x / uSize.x) * 4095.0 + 0.5) * 4096.0 + floor(min(1.0, size.y / uSize.y) * 4095.0 + 0.5);
    outColor = vec4(local, random, packed);
}`;
