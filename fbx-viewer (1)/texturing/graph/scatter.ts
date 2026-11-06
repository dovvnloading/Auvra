/**
 * SCATTERING
 *
 * A scatter node first places its copies: one entry per copy (where it sits, how big, turned and tilted,
 * mirrored, which pattern, a random value, how bright) written into float textures, three texels of
 * data a copy. Then one instanced pass draws every copy where it lands, so the cost follows the number
 * of copies rather than a search round every pixel. Where copies overlap, the higher wins (or the
 * brightest, or they add up, or the last drawn lies on top); a second look at the winners gives each
 * pixel its copy's ID, random value and local UV, for mapper nodes after it.
 *
 * Placement is worked out on the GPU (a grid with maps, the Tile sampler) or here (Poisson disc, by a
 * density map, where a picture is white). The GPU's integer hash is repeated here exactly, so a
 * copy's place can be worked out without the GPU (for handles in the 2D view).
 */

export type Point2 = [number, number];
export type StackChoice = 'higher' | 'max' | 'add' | 'over';

// ---- the shaders' hash, here too ----

/** The shaders' hashU (glslLibrary.ts), on 32-bit whole numbers. */
export const hashU = (value: number): number => {
    let x = value >>> 0;
    x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
    x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
    x ^= x >>> 16;
    return x >>> 0;
};
const hashU3 = (x: number, y: number, z: number): number => hashU((x ^ hashU((y ^ hashU((z + 0x85ebca6b) >>> 0)) >>> 0)) >>> 0);
const bits = new DataView(new ArrayBuffer(4));
/** A float's 32 bits, as the shaders' floatBitsToUint gives them. */
export const floatBits = (value: number): number => { bits.setFloat32(0, value); return bits.getUint32(0); };
/** The shaders' hash1(ivec2 p, float seed): 0 to 1. */
export const hash1 = (x: number, y: number, seed: number): number => Math.fround(hashU3(x >>> 0, y >>> 0, floatBits(Math.fround(seed)))) / 4294967295;
/** The shaders' hash2(ivec2 p, float seed). */
export const hash2 = (x: number, y: number, seed: number): Point2 => {
    const s = Math.fround(seed);
    return [hash1(x, y, s), hash1(x, y, Math.fround(s + Math.fround(17.137)))];
};

/** A run of random numbers from 0 to 1, the same for a seed every time. */
export const randomSource = (seed: number): (() => number) => {
    let state = hashU((Math.round(seed) ^ 0x9e3779b9) >>> 0);
    return () => {
        state = hashU((state + 0x6d2b79f5) >>> 0);
        return state / 4294967296;
    };
};

// ---- placements ----

const wrapped = (value: number) => ((value % 1) + 1) % 1;
/** How far apart two points are, round the edges too when the square wraps. */
export const spacingOf = (a: Point2, b: Point2, wrap: boolean): number => {
    let dx = Math.abs(a[0] - b[0]);
    let dy = Math.abs(a[1] - b[1]);
    if (wrap) { dx = Math.min(dx, 1 - dx); dy = Math.min(dy, 1 - dy); }
    return Math.hypot(dx, dy);
};

/** A grid that finds points near a place quickly, at most one point a cell (cells no wider than spacing / sqrt 2). */
class SpacingGrid {
    readonly cells: Int32Array;
    readonly size: number;
    readonly reach: number;
    constructor(readonly spacing: number, readonly wrap: boolean, readonly points: Point2[]) {
        this.size = Math.max(1, Math.ceil(Math.SQRT2 / Math.max(spacing, 1e-4)));
        this.cells = new Int32Array(this.size * this.size).fill(-1);
        this.reach = Math.ceil(spacing * this.size) + 1;
    }
    private cell(point: Point2): [number, number] { return [Math.min(this.size - 1, Math.floor(point[0] * this.size)), Math.min(this.size - 1, Math.floor(point[1] * this.size))]; }
    fits(point: Point2): boolean {
        const [cx, cy] = this.cell(point);
        for (let dy = -this.reach; dy <= this.reach; dy++) {
            for (let dx = -this.reach; dx <= this.reach; dx++) {
                let x = cx + dx;
                let y = cy + dy;
                if (this.wrap) { x = ((x % this.size) + this.size) % this.size; y = ((y % this.size) + this.size) % this.size; }
                else if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
                const index = this.cells[y * this.size + x];
                if (index >= 0 && spacingOf(point, this.points[index], this.wrap) < this.spacing) return false;
            }
        }
        return true;
    }
    add(point: Point2): number {
        const index = this.points.push(point) - 1;
        const [cx, cy] = this.cell(point);
        this.cells[cy * this.size + cx] = index;
        return index;
    }
}

/**
 * Points filling the unit square no closer than `spacing` (wrapping round both ways when `wrap`):
 * Bridson's Poisson-disc way, darts thrown round the points already placed until none fits.
 */
export const poissonDisc = (spacing: number, seed: number, wrap = true, limit = 20000): Point2[] => {
    const gap = Math.max(spacing, 0.002);
    const random = randomSource(seed);
    const points: Point2[] = [];
    const grid = new SpacingGrid(gap, wrap, points);
    const active = [grid.add([random(), random()])];
    while (active.length && points.length < limit) {
        const pick = Math.floor(random() * active.length);
        const [px, py] = points[active[pick]];
        let placed = false;
        for (let attempt = 0; attempt < 30; attempt++) {
            const angle = random() * Math.PI * 2;
            const distance = gap * (1 + random());
            let x = px + Math.cos(angle) * distance;
            let y = py + Math.sin(angle) * distance;
            if (wrap) { x = wrapped(x); y = wrapped(y); } else if (x < 0 || y < 0 || x >= 1 || y >= 1) continue;
            if (!grid.fits([x, y])) continue;
            active.push(grid.add([x, y]));
            placed = true;
            break;
        }
        if (!placed) { active[pick] = active[active.length - 1]; active.pop(); }
    }
    return points;
};

/**
 * Up to `count` points where a density map is bright, as likely as it is bright (`values` from 0 to 1,
 * `width` × `height`, the bottom row first as the GPU reads it); no closer than `spacing` when given.
 */
export const densityPoints = (values: ArrayLike<number>, width: number, height: number, count: number, seed: number, spacing = 0, wrap = true): Point2[] => {
    const random = randomSource(seed);
    const points: Point2[] = [];
    const grid = spacing > 0 ? new SpacingGrid(spacing, wrap, points) : null;
    const tries = Math.max(1, count) * 40;
    for (let attempt = 0; attempt < tries && points.length < count; attempt++) {
        const point: Point2 = [random(), random()];
        const value = values[Math.min(height - 1, Math.floor(point[1] * height)) * width + Math.min(width - 1, Math.floor(point[0] * width))] ?? 0;
        if (random() >= value) continue;
        if (grid) { if (grid.fits(point)) grid.add(point); } else points.push(point);
    }
    return points;
};

/** One point at the middle of every pixel of a (small) placement picture brighter than `threshold`. */
export const picturePoints = (values: ArrayLike<number>, width: number, height: number, threshold = 0.5): Point2[] => {
    const points: Point2[] = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if ((values[y * width + x] ?? 0) > threshold) points.push([(x + 0.5) / width, (y + 0.5) / height]);
    return points;
};

// ---- copies ----

/** Everything about one copy (sizes are half the copy's width and height, as parts of the image). */
export interface ScatterCopy {
    x: number;
    y: number;
    halfWidth: number;
    halfHeight: number;
    /** Turn round its middle (radians, anticlockwise). */
    turn: number;
    pattern: number;
    random: number;
    mirrorX: boolean;
    mirrorY: boolean;
    /** Tilt round its own x and y (radians): its 3D turn. */
    tiltX: number;
    tiltY: number;
    brightness: number;
    /** Height added under it. */
    lift: number;
}

/** Copies a placement texture row holds (rows as many as needed). */
export const PLACE_WIDTH = 1024;

/**
 * Copies as the three float textures the drawing pass reads (RGBA, `width` × `height`): where and how
 * big; turn, pattern, random value and mirror flags (1 across, 2 down); tilt, brightness and lift.
 */
export const packCopies = (copies: readonly ScatterCopy[]): { data: [Float32Array, Float32Array, Float32Array]; width: number; height: number } => {
    const width = Math.max(1, Math.min(PLACE_WIDTH, copies.length));
    const height = Math.max(1, Math.ceil(copies.length / width));
    const data: [Float32Array, Float32Array, Float32Array] = [new Float32Array(width * height * 4), new Float32Array(width * height * 4), new Float32Array(width * height * 4)];
    copies.forEach((copy, index) => {
        const at = index * 4;
        data[0].set([copy.x, copy.y, copy.halfWidth, copy.halfHeight], at);
        data[1].set([copy.turn, copy.pattern, copy.random, (copy.mirrorX ? 1 : 0) + (copy.mirrorY ? 2 : 0)], at);
        data[2].set([copy.tiltX, copy.tiltY, copy.brightness, copy.lift], at);
    });
    return { data, width, height };
};

// ---- stacking ----

/** The depth a fragment of height `height` (0 to 1) writes when the higher wins: the taller, the nearer. */
export const depthOf = (height: number): number => 1 - Math.min(1, Math.max(0, height)) * 0.999;

/**
 * What one pixel ends up with when copies overlap, drawn in the order given: the higher wins (as the
 * GPU's depth test sorts it: ties keep the first drawn), the brightest, all added up, or the last drawn
 * on top. Empty fragments (0) never win.
 */
export const stackPixel = (fragments: ReadonlyArray<{ copy: number; value: number }>, stack: StackChoice): { copy: number; value: number } | null => {
    const shown = fragments.filter((fragment) => fragment.value > 0.0005);
    if (!shown.length) return null;
    if (stack === 'add') return { copy: shown[shown.length - 1].copy, value: shown.reduce((sum, fragment) => sum + fragment.value, 0) };
    if (stack === 'over') return shown[shown.length - 1];
    if (stack === 'max') {
        let best = shown[0];
        for (const fragment of shown) if (fragment.value > best.value) best = fragment;
        return best;
    }
    let best = shown[0];
    for (const fragment of shown) if (depthOf(fragment.value) < depthOf(best.value)) best = fragment;
    return best;
};

// ---- shaders shared by the scatter nodes ----

/** What the drawing pass hands from each copy's corners to its pixels. */
export const SCATTER_VARYINGS = ['vec2 vLocal', 'flat int vCopy', 'flat int vPattern', 'float vLift', 'flat float vBright', 'flat vec2 vCentre'] as const;

/**
 * The drawing pass's vertex body: reads a copy's three texels, and places its square (mirrored, tilted
 * in 3D, turned) where it lands; a copy of size 0 is left out, and so is a wrapped repeat that would
 * fall outside the image.
 */
export const SCATTER_VERTEX = `uniform int uPlaceWidth;
mat3 tiltX(float a) { float c = cos(a); float s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 tiltY(float a) { float c = cos(a); float s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
void placeCopy(int copy, vec2 corner, vec2 shift) {
    ivec2 at = ivec2(copy % uPlaceWidth, copy / uPlaceWidth);
    vec4 a = texelFetch(place0, at, 0);
    vec4 b = texelFetch(place1, at, 0);
    vec4 c = texelFetch(place2, at, 0);
    float reach = length(a.zw) * 1.5;
    vec2 middle = a.xy + shift;
    bool outside = middle.x + reach < 0.0 || middle.x - reach > 1.0 || middle.y + reach < 0.0 || middle.y - reach > 1.0;
    if (a.z <= 0.0 || a.w <= 0.0 || outside) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    int flags = int(b.w + 0.5);
    vec2 mirror = vec2((flags & 1) != 0 ? -1.0 : 1.0, (flags & 2) != 0 ? -1.0 : 1.0);
    vec3 p = tiltY(c.y) * (tiltX(c.x) * vec3(corner * a.zw, 0.0));
    vec2 xy = rotate2(b.x) * p.xy;
    gl_Position = vec4((middle + xy) * 2.0 - 1.0, 0.0, 1.0);
    vLocal = (corner * mirror) * 0.5 + 0.5;
    vCopy = copy;
    vPattern = int(b.y + 0.5);
    vBright = c.z;
    vCentre = a.xy;
    // A tilted copy stands higher on one side: as far as its corner rose, as a part of its size.
    vLift = c.w + p.z / max(max(a.z, a.w), 1e-5) * 0.5;
}`;

/** A built-in shape's height at `p` (-1 to 1 over the copy's square), for shape choices by number. */
export const SHAPE_GLSL = `float builtInShape(int shape, vec2 p, int profile, float bevel) {
    float r = length(p);
    float box = max(abs(p.x), abs(p.y));
    float inside;
    if (shape == 1) inside = 1.0 - box;
    else if (shape == 2) { float a = atan(p.x, p.y) + PI; float sector = TAU / 6.0; inside = 1.0 - cos(floor(0.5 + a / sector) * sector - a) * r / cos(sector * 0.5); }
    else if (shape == 3) { float a = atan(p.y, p.x); float sector = TAU / 5.0; float t = abs(mod(a + sector * 0.5, sector) - sector * 0.5) / (sector * 0.5); inside = 1.0 - r / mix(1.0, 0.45, t); }
    else inside = 1.0 - r;
    if (inside <= 0.0) return 0.0;
    if (profile == 1) return smoothstep(0.0, 0.02, inside);
    if (profile == 2) return saturate(inside / max(bevel, 1e-3));
    // Each shape's own rounded height.
    if (shape == 0) return sqrt(saturate(1.0 - r * r));
    if (shape == 4) return exp(-r * r * 4.0);
    return inside;
}`;

/** The shapes a scatter node can draw without a picture, by number (as SHAPE_GLSL reads them). */
export const SCATTER_SHAPES: ReadonlyArray<[string, string]> = [['disc', 'Disc'], ['square', 'Square'], ['hexagon', 'Hexagon'], ['star', 'Star'], ['bell', 'Soft bump']];
export const SCATTER_PROFILES: ReadonlyArray<[string, string]> = [['natural', 'Its own height'], ['flat', 'Flat'], ['extruded', 'Raised, with a bevel']];
export const STACK_CHOICES: ReadonlyArray<[StackChoice, string]> = [['higher', 'Higher wins'], ['max', 'Brightest wins'], ['add', 'Add up'], ['over', 'Each on top']];
