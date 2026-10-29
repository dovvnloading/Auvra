import * as THREE from 'three';
import type { LevelObject } from '../types';
import { buildSpline, createSplineFrame, readSplineData, splineFrameQuaternion, SPLINE_COMPONENT_TYPE, type Spline, type SplineFrame } from './splines';

/**
 * MESHES ALONG SPLINES
 *
 * Spline Mesh bends a model along a spline: roads, rails, pipes, walls and rivers. The model is
 * laid with its length (its X or Z axis) along the curve, its Y up the spline's up and its width
 * across it, then repeated end to end (tile) or drawn out once over the whole length (stretch).
 * A model only bends where it has vertices, so it is first cut across its length every
 * `smoothness` metres: a road made of one long quad still follows every curve.
 *
 * Spline Scatter places copies of a model along a spline at a spacing: fence posts, lamps, trees
 * along a road, with seeded random turn, size and sideways jitter so a row does not look stamped.
 *
 * Both work in the spline's local space (the owning object's), and give the triangles their
 * collision and the navmesh are built from.
 */

export type SplineMeshAxis = 'x' | 'z';
export type SplineMeshFit = 'tile' | 'stretch';
export type SplineScatterAlign = 'spline' | 'upright' | 'fixed';

export interface SplineMeshSettings {
    modelId: string;
    /** The model's axis laid along the spline. */
    axis: SplineMeshAxis;
    fit: SplineMeshFit;
    /** Metres between tiled copies. */
    gap: number;
    /** Width, height and length multipliers on the model (length sets how long one tile is). */
    scale: [number, number, number];
    /** Metres to the right of travel and up from the spline. */
    offset: [number, number];
    /** Metres of spline left bare at its start and at its end. */
    start: number;
    end: number;
    /** Longest piece of model laid straight, in metres: smaller bends more smoothly. */
    smoothness: number;
    castShadow: boolean;
    receiveShadow: boolean;
    collision: boolean;
}

export interface SplineScatterSettings {
    modelId: string;
    /** Metres between copies. */
    spacing: number;
    start: number;
    end: number;
    /** Metres to the right of travel and up from the spline. */
    offset: [number, number];
    /** A row on each side of the spline, mirrored across it. */
    bothSides: boolean;
    /** 'spline' turns copies with the curve, 'upright' only turns them to face along it, 'fixed' keeps the object's own axes. */
    align: SplineScatterAlign;
    scale: number;
    /** Random turn about up, up to this many degrees either way. */
    yawJitter: number;
    /** Random size change, 0 to 1 (0.2: from 80% to 120%). */
    scaleJitter: number;
    /** Random sideways shift, up to this many metres either way. */
    offsetJitter: number;
    seed: number;
    castShadow: boolean;
    receiveShadow: boolean;
    collision: boolean;
}

export const SPLINE_MESH_COMPONENT_TYPE = 'splineMesh';
export const SPLINE_SCATTER_COMPONENT_TYPE = 'splineScatter';

export const SPLINE_MESH_DEFAULTS: SplineMeshSettings = {
    modelId: '',
    axis: 'z',
    fit: 'tile',
    gap: 0,
    scale: [1, 1, 1],
    offset: [0, 0],
    start: 0,
    end: 0,
    smoothness: 0.5,
    castShadow: true,
    receiveShadow: true,
    collision: true,
};

export const SPLINE_SCATTER_DEFAULTS: SplineScatterSettings = {
    modelId: '',
    spacing: 4,
    start: 0,
    end: 0,
    offset: [0, 0],
    bothSides: false,
    align: 'upright',
    scale: 1,
    yawJitter: 0,
    scaleJitter: 0,
    offsetJitter: 0,
    seed: 1,
    castShadow: true,
    receiveShadow: true,
    collision: false,
};

/** Most copies a Spline Mesh tiles, or a Spline Scatter places. */
export const MAX_SPLINE_COPIES = 4000;
/** Most vertices one Spline Mesh builds; past it the model is cut more coarsely. */
const MAX_SPLINE_MESH_VERTICES = 1_500_000;
const MIN_SMOOTHNESS = 0.05;

const number = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

const boolean = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

const choice = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
    typeof value === 'string' && (options as readonly string[]).includes(value) ? value as T : fallback;

const triple = (value: unknown, fallback: [number, number, number], min: number, max: number): [number, number, number] =>
    Array.isArray(value) && value.length === 3
        ? [number(value[0], fallback[0], min, max), number(value[1], fallback[1], min, max), number(value[2], fallback[2], min, max)]
        : [...fallback];

export const readSplineMeshSettings = (props: Record<string, unknown>): SplineMeshSettings => ({
    modelId: typeof props.modelId === 'string' ? props.modelId : '',
    axis: choice(props.axis, ['x', 'z'] as const, SPLINE_MESH_DEFAULTS.axis),
    fit: choice(props.fit, ['tile', 'stretch'] as const, SPLINE_MESH_DEFAULTS.fit),
    gap: number(props.gap, 0, 0, 1000),
    scale: triple(props.scale, SPLINE_MESH_DEFAULTS.scale, 0.001, 1000),
    offset: [number(props.offsetRight, 0, -1000, 1000), number(props.offsetUp, 0, -1000, 1000)],
    start: number(props.start, 0, 0, 1e6),
    end: number(props.end, 0, 0, 1e6),
    smoothness: number(props.smoothness, SPLINE_MESH_DEFAULTS.smoothness, MIN_SMOOTHNESS, 100),
    castShadow: boolean(props.castShadow, true),
    receiveShadow: boolean(props.receiveShadow, true),
    collision: boolean(props.collision, true),
});

export const readSplineScatterSettings = (props: Record<string, unknown>): SplineScatterSettings => ({
    modelId: typeof props.modelId === 'string' ? props.modelId : '',
    spacing: number(props.spacing, SPLINE_SCATTER_DEFAULTS.spacing, 0.05, 1e5),
    start: number(props.start, 0, 0, 1e6),
    end: number(props.end, 0, 0, 1e6),
    offset: [number(props.offsetRight, 0, -1000, 1000), number(props.offsetUp, 0, -1000, 1000)],
    bothSides: boolean(props.bothSides, false),
    align: choice(props.align, ['spline', 'upright', 'fixed'] as const, SPLINE_SCATTER_DEFAULTS.align),
    scale: number(props.scale, 1, 0.001, 1000),
    yawJitter: number(props.yawJitter, 0, 0, 180),
    scaleJitter: number(props.scaleJitter, 0, 0, 0.95),
    offsetJitter: number(props.offsetJitter, 0, 0, 1000),
    seed: Math.floor(number(props.seed, 1, 0, 2 ** 31)),
    castShadow: boolean(props.castShadow, true),
    receiveShadow: boolean(props.receiveShadow, true),
    collision: boolean(props.collision, false),
});

// ---------------------------------------------------------------------------
// Model parts
// ---------------------------------------------------------------------------

/** One material's triangles of a model, unindexed, in the model's own space (its import scale included). */
export interface SplineModelPart {
    geometry: THREE.BufferGeometry;
    material: THREE.Material;
}

/** Vertex data carried through cutting and bending; anything else (skin weights, morphs) is left behind. */
const CARRIED_ATTRIBUTES = ['position', 'normal', 'tangent', 'uv', 'uv1', 'uv2', 'color'] as const;

const partCache = new WeakMap<THREE.Object3D, SplineModelPart[]>();

/**
 * The model's meshes as parts to lay along a spline, one per material: placed as the model is
 * under a level object (its root's own transform included). Skinned meshes are taken in their
 * bind pose. Cached per model.
 */
export const splineModelParts = (model: THREE.Object3D): SplineModelPart[] => {
    const cached = partCache.get(model);
    if (cached) return cached;
    model.updateWorldMatrix(true, true);
    const toModel = model.parent ? new THREE.Matrix4().copy(model.parent.matrixWorld).invert() : new THREE.Matrix4();
    const relative = new THREE.Matrix4();
    const parts: SplineModelPart[] = [];
    model.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh || (mesh as unknown as THREE.InstancedMesh).isInstancedMesh || !mesh.geometry?.getAttribute('position')) return;
        relative.multiplyMatrices(toModel, mesh.matrixWorld);
        const source = new THREE.BufferGeometry();
        for (const name of CARRIED_ATTRIBUTES) {
            const attribute = mesh.geometry.getAttribute(name);
            if (attribute) source.setAttribute(name, plainAttribute(attribute));
        }
        if (mesh.geometry.index) source.setIndex(mesh.geometry.index);
        for (const group of mesh.geometry.groups) source.addGroup(group.start, group.count, group.materialIndex);
        const flat = source.index ? source.toNonIndexed() : source.clone();
        flat.applyMatrix4(relative);
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const groups = flat.groups.length > 0 ? flat.groups : [{ start: 0, count: flat.getAttribute('position').count, materialIndex: 0 }];
        for (const group of groups) {
            const material = materials[group.materialIndex ?? 0] ?? materials[0];
            if (!material) continue;
            parts.push({ geometry: groups.length === 1 ? flat : extractRange(flat, group.start, group.count), material });
        }
    });
    partCache.set(model, parts);
    return parts;
};

/** Float values of any attribute (interleaved, normalized integers), so cutting and copying read them alike. */
const plainAttribute = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute => {
    const size = attribute.itemSize;
    const array = new Float32Array(attribute.count * size);
    const read = [
        (i: number) => attribute.getX(i),
        (i: number) => attribute.getY(i),
        (i: number) => attribute.getZ(i),
        (i: number) => attribute.getW(i),
    ];
    for (let i = 0; i < attribute.count; i++) {
        for (let c = 0; c < size; c++) array[i * size + c] = read[c](i);
    }
    return new THREE.BufferAttribute(array, size);
};

const extractRange = (geometry: THREE.BufferGeometry, start: number, count: number): THREE.BufferGeometry => {
    const range = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
        const size = attribute.itemSize;
        range.setAttribute(name, new THREE.BufferAttribute((attribute.array as Float32Array).slice(start * size, (start + count) * size), size, attribute.normalized));
    }
    return range;
};

/** Bounds of the parts together, in model space. */
export const splineModelBounds = (parts: readonly SplineModelPart[]): THREE.Box3 => {
    const box = new THREE.Box3();
    for (const part of parts) {
        part.geometry.computeBoundingBox();
        if (part.geometry.boundingBox) box.union(part.geometry.boundingBox);
    }
    return box;
};

// ---------------------------------------------------------------------------
// Cutting across the length
// ---------------------------------------------------------------------------

interface PackedLayout {
    names: string[];
    sizes: number[];
    offsets: number[];
    stride: number;
}

const layoutOf = (geometry: THREE.BufferGeometry): PackedLayout => {
    const names: string[] = [];
    const sizes: number[] = [];
    const offsets: number[] = [];
    let stride = 0;
    for (const name of CARRIED_ATTRIBUTES) {
        const attribute = geometry.getAttribute(name);
        if (!attribute) continue;
        names.push(name);
        sizes.push(attribute.itemSize);
        offsets.push(stride);
        stride += attribute.itemSize;
    }
    return { names, sizes, offsets, stride };
};

/**
 * `geometry` (unindexed) cut by planes square to `axis` at each of `planes` (ascending): every
 * triangle crossing a plane is split along it, its vertex data blended at the cut.
 */
export const sliceGeometry = (geometry: THREE.BufferGeometry, axis: 0 | 1 | 2, planes: readonly number[]): THREE.BufferGeometry => {
    const layout = layoutOf(geometry);
    const { stride } = layout;
    const vertexCount = geometry.getAttribute('position').count;
    const packed = new Float32Array(vertexCount * stride);
    layout.names.forEach((name, k) => {
        const attribute = geometry.getAttribute(name);
        const size = layout.sizes[k];
        for (let i = 0; i < vertexCount; i++) {
            for (let c = 0; c < size; c++) packed[i * stride + layout.offsets[k] + c] = attribute.getComponent(i, c);
        }
    });
    const axisOffset = layout.offsets[layout.names.indexOf('position')] + axis;
    const out: number[] = [];
    const emit = (vertex: ArrayLike<number>) => {
        for (let c = 0; c < stride; c++) out.push(vertex[c]);
    };
    const slabOf = (value: number): number => {
        let low = 0;
        let high = planes.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (planes[middle] <= value) low = middle + 1;
            else high = middle;
        }
        return low;
    };
    const lerp = (a: Float32Array, b: Float32Array, t: number): Float32Array => {
        const vertex = new Float32Array(stride);
        for (let c = 0; c < stride; c++) vertex[c] = a[c] + (b[c] - a[c]) * t;
        return vertex;
    };
    // Keeps the part of a convex polygon on one side of the plane value along the axis.
    const clip = (polygon: Float32Array[], value: number, keepAbove: boolean): Float32Array[] => {
        const result: Float32Array[] = [];
        for (let i = 0; i < polygon.length; i++) {
            const current = polygon[i];
            const next = polygon[(i + 1) % polygon.length];
            const a = current[axisOffset] - value;
            const b = next[axisOffset] - value;
            const currentIn = keepAbove ? a >= 0 : a <= 0;
            const nextIn = keepAbove ? b >= 0 : b <= 0;
            if (currentIn) result.push(current);
            if (currentIn !== nextIn && a !== b) result.push(lerp(current, next, a / (a - b)));
        }
        return result;
    };

    for (let triangle = 0; triangle < vertexCount; triangle += 3) {
        if (triangle + 2 >= vertexCount) break;
        const corners = [0, 1, 2].map(k => packed.subarray((triangle + k) * stride, (triangle + k + 1) * stride));
        const values = corners.map(corner => corner[axisOffset]);
        const first = slabOf(Math.min(...values));
        const last = slabOf(Math.max(...values));
        if (first === last) {
            corners.forEach(emit);
            continue;
        }
        for (let slab = first; slab <= last; slab++) {
            let polygon: Float32Array[] = corners.map(corner => Float32Array.from(corner));
            if (slab > 0) polygon = clip(polygon, planes[slab - 1], true);
            if (slab < planes.length && polygon.length >= 3) polygon = clip(polygon, planes[slab], false);
            for (let k = 1; k + 1 < polygon.length; k++) {
                emit(polygon[0]);
                emit(polygon[k]);
                emit(polygon[k + 1]);
            }
        }
    }

    const sliced = new THREE.BufferGeometry();
    const count = out.length / stride;
    layout.names.forEach((name, k) => {
        const size = layout.sizes[k];
        const array = new Float32Array(count * size);
        for (let i = 0; i < count; i++) {
            for (let c = 0; c < size; c++) array[i * size + c] = out[i * stride + layout.offsets[k] + c];
        }
        sliced.setAttribute(name, new THREE.BufferAttribute(array, size));
    });
    return sliced;
};

// ---------------------------------------------------------------------------
// Spline Mesh
// ---------------------------------------------------------------------------

export interface SplineMeshPart {
    geometry: THREE.BufferGeometry;
    material: THREE.Material;
}

export interface SplineMeshBuild {
    parts: SplineMeshPart[];
    /** Copies laid end to end. */
    copies: number;
}

const EMPTY_BUILD: SplineMeshBuild = { parts: [], copies: 0 };

/** Where the copies of a tiled or stretched model go along the spline: start of the first, distance between starts, length of each. */
export const planSplineMeshCopies = (splineLength: number, modelLength: number, settings: Pick<SplineMeshSettings, 'fit' | 'gap' | 'scale' | 'start' | 'end'>): { copies: number; first: number; pitch: number; length: number } => {
    const available = splineLength - settings.start - settings.end;
    if (!(available > 1e-4)) return { copies: 0, first: 0, pitch: 0, length: 0 };
    if (settings.fit === 'stretch') return { copies: 1, first: settings.start, pitch: available, length: available };
    const natural = Math.max(modelLength * settings.scale[2], 1e-3);
    const copies = Math.min(MAX_SPLINE_COPIES, Math.max(1, Math.round((available + settings.gap) / (natural + settings.gap))));
    const pitch = (available + settings.gap) / copies;
    return { copies, first: settings.start, pitch, length: Math.max(1e-4, pitch - settings.gap) };
};

/** The model's parts bent along `spline` as `settings` lay them. */
export const buildSplineMesh = (parts: readonly SplineModelPart[], spline: Spline, settings: SplineMeshSettings): SplineMeshBuild => {
    if (parts.length === 0 || !(spline.length > 1e-4)) return EMPTY_BUILD;
    const axis = settings.axis === 'x' ? 0 : 2;
    const side = settings.axis === 'x' ? 2 : 0;
    const bounds = splineModelBounds(parts);
    if (bounds.isEmpty()) return EMPTY_BUILD;
    const minimum = bounds.min.getComponent(axis);
    const modelLength = bounds.max.getComponent(axis) - minimum;
    const plan = planSplineMeshCopies(spline.length, modelLength, settings);
    if (plan.copies === 0) return EMPTY_BUILD;
    const flat = modelLength < 1e-5;

    // Cut finely enough to bend smoothly, but coarser when that would build too many vertices.
    const sourceVertices = parts.reduce((sum, part) => sum + part.geometry.getAttribute('position').count, 0);
    let step = flat ? Infinity : settings.smoothness * (modelLength / plan.length);
    if (!flat) {
        const budget = MAX_SPLINE_MESH_VERTICES / plan.copies;
        // Each cut adds roughly as many vertices as a cross-section has; estimate it from the source.
        const perCut = Math.max(6, Math.sqrt(sourceVertices) * 2);
        const cuts = Math.min(modelLength / step, Math.max(0, (budget - sourceVertices) / perCut));
        step = modelLength / Math.max(1, cuts);
    }
    const planes: number[] = [];
    if (Number.isFinite(step)) {
        for (let value = minimum + step; value < minimum + modelLength - step * 1e-3; value += step) planes.push(value);
    }

    // Model space (side, up, along) to frame space; both mappings are rotations, so faces keep their winding.
    const sideSign = settings.axis === 'x' ? 1 : -1;
    const stretch = flat ? 1 : plan.length / modelLength;
    const [widthScale, heightScale] = settings.scale;
    const [offsetRight, offsetUp] = settings.offset;
    const frame: SplineFrame = createSplineFrame();
    const cache = new Map<number, Float64Array>();
    const sideVector = new THREE.Vector3();
    const vector = new THREE.Vector3();

    const built: SplineMeshPart[] = [];
    for (const part of parts) {
        const sliced = planes.length > 0 ? sliceGeometry(part.geometry, axis, planes) : part.geometry;
        const position = sliced.getAttribute('position');
        const normal = sliced.getAttribute('normal');
        const tangent = sliced.getAttribute('tangent');
        const count = position.count;
        const outPosition = new Float32Array(count * plan.copies * 3);
        const outNormal = normal ? new Float32Array(count * plan.copies * 3) : null;
        const outTangent = tangent ? new Float32Array(count * plan.copies * 4) : null;
        const copied = (['uv', 'uv1', 'uv2', 'color'] as const)
            .map(name => sliced.getAttribute(name))
            .map((attribute, k) => (attribute ? { name: (['uv', 'uv1', 'uv2', 'color'] as const)[k], attribute, array: new Float32Array(count * plan.copies * attribute.itemSize) } : null))
            .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

        for (let copy = 0; copy < plan.copies; copy++) {
            cache.clear();
            const copyStart = plan.first + copy * plan.pitch;
            for (let i = 0; i < count; i++) {
                const along = position.getComponent(i, axis);
                const fraction = flat ? 0.5 : Math.min(1, Math.max(0, (along - minimum) / modelLength));
                const key = Math.round(fraction * 1e6);
                let f = cache.get(key);
                if (!f) {
                    spline.frameAt(copyStart + fraction * plan.length, frame);
                    f = Float64Array.of(
                        frame.position.x, frame.position.y, frame.position.z,
                        frame.tangent.x, frame.tangent.y, frame.tangent.z,
                        frame.up.x, frame.up.y, frame.up.z,
                        frame.right.x, frame.right.y, frame.right.z,
                        frame.scale.x, frame.scale.y,
                    );
                    cache.set(key, f);
                }
                const width = widthScale * f[12];
                const height = heightScale * f[13];
                sideVector.set(f[9] * sideSign, f[10] * sideSign, f[11] * sideSign);
                const s = position.getComponent(i, side) * width;
                const h = position.getY(i) * height + offsetUp;
                const at = (copy * count + i) * 3;
                outPosition[at] = f[0] + sideVector.x * s + f[9] * offsetRight + f[6] * h;
                outPosition[at + 1] = f[1] + sideVector.y * s + f[10] * offsetRight + f[7] * h;
                outPosition[at + 2] = f[2] + sideVector.z * s + f[11] * offsetRight + f[8] * h;
                if (outNormal && normal) {
                    // Normals take the inverse of the stretch, so a widened road's sides stay square to it.
                    const ns = normal.getComponent(i, side) / width;
                    const nh = normal.getY(i) / height;
                    const na = normal.getComponent(i, axis) / stretch;
                    vector.set(
                        sideVector.x * ns + f[6] * nh + f[3] * na,
                        sideVector.y * ns + f[7] * nh + f[4] * na,
                        sideVector.z * ns + f[8] * nh + f[5] * na,
                    ).normalize();
                    outNormal[at] = vector.x;
                    outNormal[at + 1] = vector.y;
                    outNormal[at + 2] = vector.z;
                }
                if (outTangent && tangent) {
                    const ts = tangent.getComponent(i, side) * width;
                    const th = tangent.getY(i) * height;
                    const ta = tangent.getComponent(i, axis) * stretch;
                    vector.set(
                        sideVector.x * ts + f[6] * th + f[3] * ta,
                        sideVector.y * ts + f[7] * th + f[4] * ta,
                        sideVector.z * ts + f[8] * th + f[5] * ta,
                    ).normalize();
                    const t4 = (copy * count + i) * 4;
                    outTangent[t4] = vector.x;
                    outTangent[t4 + 1] = vector.y;
                    outTangent[t4 + 2] = vector.z;
                    outTangent[t4 + 3] = tangent.getW(i) < 0 ? -1 : 1;
                }
            }
            for (const entry of copied) {
                const size = entry.attribute.itemSize;
                entry.array.set((entry.attribute.array as Float32Array).subarray(0, count * size), copy * count * size);
            }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(outPosition, 3));
        if (outNormal) geometry.setAttribute('normal', new THREE.BufferAttribute(outNormal, 3));
        else geometry.computeVertexNormals();
        if (outTangent) geometry.setAttribute('tangent', new THREE.BufferAttribute(outTangent, 4));
        for (const entry of copied) geometry.setAttribute(entry.name, new THREE.BufferAttribute(entry.array, entry.attribute.itemSize));
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        if (sliced !== part.geometry) sliced.dispose();
        built.push({ geometry, material: part.material });
    }
    return { parts: built, copies: plan.copies };
};

// ---------------------------------------------------------------------------
// Spline Scatter
// ---------------------------------------------------------------------------

/** A small seeded generator (mulberry32), so a scatter looks the same every time it is built. */
export const seededRandom = (seed: number): (() => number) => {
    let state = (seed >>> 0) || 1;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const UP = new THREE.Vector3(0, 1, 0);

/** The distances along the spline copies go at: inclusive of both ends of an open spline, evenly round a closed one. */
export const scatterDistances = (spline: Spline, settings: Pick<SplineScatterSettings, 'spacing' | 'start' | 'end'>): number[] => {
    const available = spline.length - settings.start - settings.end;
    if (spline.segmentCount === 0 || available < -1e-6) return [];
    const loop = spline.closed && settings.start === 0 && settings.end === 0;
    const count = loop
        ? Math.max(1, Math.round(available / settings.spacing))
        : Math.floor(Math.max(0, available) / settings.spacing + 1e-6) + 1;
    const pitch = loop ? available / count : settings.spacing;
    const distances: number[] = [];
    for (let i = 0; i < Math.min(count, MAX_SPLINE_COPIES); i++) distances.push(settings.start + i * pitch);
    return distances;
};

/** Each copy's transform in the spline's space. */
export const scatterAlongSpline = (spline: Spline, settings: SplineScatterSettings): THREE.Matrix4[] => {
    const random = seededRandom(settings.seed);
    const frame = createSplineFrame();
    const matrices: THREE.Matrix4[] = [];
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const turn = new THREE.Quaternion();
    const size = new THREE.Vector3();
    const flatTangent = new THREE.Vector3();
    for (const distance of scatterDistances(spline, settings)) {
        spline.frameAt(distance, frame);
        for (const sideSign of settings.bothSides ? [1, -1] : [1]) {
            if (matrices.length >= MAX_SPLINE_COPIES) return matrices;
            const lateral = settings.offset[0] * sideSign + (random() * 2 - 1) * settings.offsetJitter;
            const up = settings.align === 'spline' ? frame.up : UP;
            position.copy(frame.position).addScaledVector(frame.right, lateral).addScaledVector(up, settings.offset[1]);
            if (settings.align === 'spline') {
                splineFrameQuaternion(frame, rotation);
            } else if (settings.align === 'upright') {
                flatTangent.set(frame.tangent.x, 0, frame.tangent.z);
                rotation.setFromAxisAngle(UP, flatTangent.lengthSq() > 1e-8 ? Math.atan2(flatTangent.x, flatTangent.z) : 0);
            } else {
                rotation.identity();
            }
            const yaw = THREE.MathUtils.degToRad((random() * 2 - 1) * settings.yawJitter);
            if (yaw !== 0) rotation.multiply(turn.setFromAxisAngle(UP, yaw));
            const scale = settings.scale * (1 + (random() * 2 - 1) * settings.scaleJitter);
            matrices.push(new THREE.Matrix4().compose(position, rotation, size.setScalar(scale)));
        }
    }
    return matrices;
};

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

export interface SplineTriangles {
    positions: Float32Array;
    indices: Uint32Array;
}

/** Bent parts as one welded triangle mesh, so collision has no seams between triangles. */
export const splineMeshTriangles = (parts: readonly SplineMeshPart[]): SplineTriangles | null => {
    const weld = new Map<string, number>();
    const positions: number[] = [];
    const indices: number[] = [];
    for (const part of parts) {
        const position = part.geometry.getAttribute('position');
        for (let i = 0; i < position.count; i++) {
            const x = position.getX(i);
            const y = position.getY(i);
            const z = position.getZ(i);
            const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
            let index = weld.get(key);
            if (index === undefined) {
                index = positions.length / 3;
                weld.set(key, index);
                positions.push(x, y, z);
            }
            indices.push(index);
        }
    }
    // Triangles welded down to a line or a point carry no surface.
    const kept: number[] = [];
    for (let i = 0; i + 2 < indices.length; i += 3) {
        const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
        if (a !== b && b !== c && a !== c) kept.push(a, b, c);
    }
    if (kept.length === 0) return null;
    return { positions: new Float32Array(positions), indices: new Uint32Array(kept) };
};

/** Each scattered copy's model bounds as a box, transformed: the copies' collision and navmesh shape. */
export const scatterBoxes = (bounds: THREE.Box3, matrices: readonly THREE.Matrix4[]): SplineTriangles | null => {
    if (bounds.isEmpty() || matrices.length === 0) return null;
    const corners: THREE.Vector3[] = [];
    for (let i = 0; i < 8; i++) {
        corners.push(new THREE.Vector3(i & 1 ? bounds.max.x : bounds.min.x, i & 2 ? bounds.max.y : bounds.min.y, i & 4 ? bounds.max.z : bounds.min.z));
    }
    // Outward-facing quads of the box, by corner bits (x 1, y 2, z 4).
    const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    const positions = new Float32Array(matrices.length * 24);
    const indices = new Uint32Array(matrices.length * 36);
    const corner = new THREE.Vector3();
    matrices.forEach((matrix, copy) => {
        corners.forEach((point, k) => {
            corner.copy(point).applyMatrix4(matrix).toArray(positions, (copy * 8 + k) * 3);
        });
        faces.forEach(([a, b, c, d], face) => {
            const at = copy * 36 + face * 6;
            const base = copy * 8;
            indices.set([base + a, base + b, base + c, base + a, base + c, base + d], at);
        });
    });
    return { positions, indices };
};

const enabled = (object: Pick<LevelObject, 'components'>, type: string) =>
    (object.components ?? []).filter(component => component.type === type && component.enabled !== false);

/** True when the object lays something solid along its spline: a Spline Mesh or Spline Scatter with collision on. */
export const hasSplineCollision = (object: Pick<LevelObject, 'components'>): boolean =>
    enabled(object, SPLINE_COMPONENT_TYPE).length > 0
    && (enabled(object, SPLINE_MESH_COMPONENT_TYPE).some(component => readSplineMeshSettings(component.props).collision)
        || enabled(object, SPLINE_SCATTER_COMPONENT_TYPE).some(component => readSplineScatterSettings(component.props).collision));

/**
 * The solid triangles an object's spline components lay down, in the object's space: bent Spline
 * Meshes and the boxes of scattered copies, where their collision is on and their model is known.
 * The navmesh bakes from them as physics collides with them.
 */
export const splineObjectTriangles = (object: Pick<LevelObject, 'components'>, findModel: (modelId: string) => THREE.Object3D | null): SplineTriangles | null => {
    const component = enabled(object, SPLINE_COMPONENT_TYPE)[0];
    if (!component) return null;
    const spline = buildSpline(readSplineData(component.props));
    const pieces: SplineTriangles[] = [];
    for (const mesh of enabled(object, SPLINE_MESH_COMPONENT_TYPE)) {
        const settings = readSplineMeshSettings(mesh.props);
        const model = settings.collision && settings.modelId ? findModel(settings.modelId) : null;
        if (!model) continue;
        const build = buildSplineMesh(splineModelParts(model), spline, settings);
        const triangles = splineMeshTriangles(build.parts);
        build.parts.forEach(part => part.geometry.dispose());
        if (triangles) pieces.push(triangles);
    }
    for (const scatter of enabled(object, SPLINE_SCATTER_COMPONENT_TYPE)) {
        const settings = readSplineScatterSettings(scatter.props);
        const model = settings.collision && settings.modelId ? findModel(settings.modelId) : null;
        if (!model) continue;
        const boxes = scatterBoxes(splineModelBounds(splineModelParts(model)), scatterAlongSpline(spline, settings));
        if (boxes) pieces.push(boxes);
    }
    if (pieces.length === 0) return null;
    if (pieces.length === 1) return pieces[0];
    const positions = new Float32Array(pieces.reduce((sum, piece) => sum + piece.positions.length, 0));
    const indices = new Uint32Array(pieces.reduce((sum, piece) => sum + piece.indices.length, 0));
    let vertexOffset = 0;
    let positionOffset = 0;
    let indexOffset = 0;
    for (const piece of pieces) {
        positions.set(piece.positions, positionOffset);
        for (let i = 0; i < piece.indices.length; i++) indices[indexOffset + i] = piece.indices[i] + vertexOffset;
        positionOffset += piece.positions.length;
        indexOffset += piece.indices.length;
        vertexOffset += piece.positions.length / 3;
    }
    return { positions, indices };
};
