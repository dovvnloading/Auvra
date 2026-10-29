import * as THREE from 'three';

/**
 * SPLINES
 *
 * A spline is a smooth curve through control points, in the local space of the object that owns
 * it. Each stretch between two points is a cubic Hermite segment. At an Auto point the curve passes
 * smoothly, with tangents from its neighbours as a centripetal Catmull-Rom spline has them (no
 * loops or cusps however unevenly the points are spaced); at a Linear point it turns a corner and
 * heads straight for each neighbour; at a Custom point it leaves along the point's own tangent.
 *
 * Everything that follows a spline (meshes bent along it, copies placed along it, objects moving
 * on it) works by distance along the curve, not by the segments' own parameter, so speed and
 * spacing are even however the points are spread. A sample also carries a frame: the tangent, an
 * up that stays level with the object's +Y ('world': roads and fences do not bank) or turns as
 * little as possible ('minimal': loops and coasters), each point's roll on top, and the width and
 * height scale between the points.
 */

export type SplineVec3 = [number, number, number];
export type SplinePointMode = 'auto' | 'linear' | 'custom';
export type SplineUpMode = 'world' | 'minimal';

export interface SplinePoint {
    position: SplineVec3;
    mode: SplinePointMode;
    /**
     * Custom points: the curve's velocity through the point, per segment (a Hermite tangent). Its
     * Bezier handles sit a third of it before and after the point. Other modes ignore it.
     */
    tangent: SplineVec3;
    /** Twist around the curve at the point, in degrees. */
    roll: number;
    /** Width and height scale of what is laid along the spline at the point. */
    scale: [number, number];
}

export interface SplineData {
    points: SplinePoint[];
    /** The last point joins back to the first. */
    closed: boolean;
    up: SplineUpMode;
}

export const SPLINE_COMPONENT_TYPE = 'spline';
export const MAX_SPLINE_POINTS = 1000;
/** Farthest a point may be from its object, as level positions are bounded. */
const MAX_COORDINATE = 1e6;
export const MIN_SPLINE_SCALE = 0.001;
export const MAX_SPLINE_SCALE = 1000;

const SPLINE_MODES: readonly SplinePointMode[] = ['auto', 'linear', 'custom'];
const UP_MODES: readonly SplineUpMode[] = ['world', 'minimal'];

export const splinePoint = (position: SplineVec3, patch: Partial<Omit<SplinePoint, 'position'>> = {}): SplinePoint => ({
    position: [...position],
    mode: patch.mode ?? 'auto',
    tangent: patch.tangent ? [...patch.tangent] : [0, 0, 0],
    roll: patch.roll ?? 0,
    scale: patch.scale ? [...patch.scale] : [1, 1],
});

/** A new spline's points: a gentle arc 10 m long from the object's origin along +X. */
export const DEFAULT_SPLINE_POINTS: readonly SplinePoint[] = [
    splinePoint([0, 0, 0]),
    splinePoint([5, 0, -2]),
    splinePoint([10, 0, 0]),
];

const finite = (value: unknown, fallback: number, limit = MAX_COORDINATE): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(limit, Math.max(-limit, value)) : fallback;

const readVec3 = (value: unknown, fallback: SplineVec3): SplineVec3 | null => {
    if (!Array.isArray(value) || value.length !== 3) return null;
    return [finite(value[0], fallback[0]), finite(value[1], fallback[1]), finite(value[2], fallback[2])];
};

const clampScale = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(MAX_SPLINE_SCALE, Math.max(MIN_SPLINE_SCALE, Math.abs(value))) : 1;

/** A stored point to a point, or null when it has no usable position. */
export const readSplinePoint = (value: unknown): SplinePoint | null => {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const position = readVec3(record.position, [0, 0, 0]);
    if (!position) return null;
    const mode = typeof record.mode === 'string' && (SPLINE_MODES as readonly string[]).includes(record.mode) ? record.mode as SplinePointMode : 'auto';
    const scale = Array.isArray(record.scale) && record.scale.length === 2 ? record.scale : [1, 1];
    return {
        position,
        mode,
        tangent: readVec3(record.tangent, [0, 0, 0]) ?? [0, 0, 0],
        roll: finite(record.roll, 0, 36000),
        scale: [clampScale(scale[0]), clampScale(scale[1])],
    };
};

/** Stored spline props to spline data: invalid points are dropped, a spline left with none gets the defaults. */
export const readSplineData = (props: Record<string, unknown> | undefined): SplineData => {
    const stored = Array.isArray(props?.points) ? props!.points : null;
    const points = stored
        ? stored.slice(0, MAX_SPLINE_POINTS).map(readSplinePoint).filter((point): point is SplinePoint => point !== null)
        : [];
    return {
        points: stored && points.length > 0 ? points : DEFAULT_SPLINE_POINTS.map(point => splinePoint(point.position, point)),
        closed: props?.closed === true,
        up: typeof props?.up === 'string' && (UP_MODES as readonly string[]).includes(props.up) ? props.up as SplineUpMode : 'world',
    };
};

/** A point as it is stored: only what differs from an Auto point without roll or scale. */
export const writeSplinePoint = (point: SplinePoint): Record<string, unknown> => {
    const stored: Record<string, unknown> = { position: point.position.map(round) };
    if (point.mode !== 'auto') stored.mode = point.mode;
    if (point.mode === 'custom') stored.tangent = point.tangent.map(round);
    if (point.roll !== 0) stored.roll = round(point.roll);
    if (point.scale[0] !== 1 || point.scale[1] !== 1) stored.scale = point.scale.map(round);
    return stored;
};

/** Props for a spline component holding `data`. */
export const writeSplineData = (data: SplineData): Record<string, unknown> => ({
    points: data.points.map(writeSplinePoint),
    closed: data.closed,
    up: data.up,
});

// Stored coordinates keep a tenth of a millimetre, which is all an editor drag means.
const round = (value: number): number => Math.round(value * 1e4) / 1e4;

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Centripetal parameterisation (Yuksel et al.): no cusps or self-intersections within a segment. */
const ALPHA = 0.5;
/** How long the steps of the distance table are, at most, and how many a segment gets at least and at most. */
const TABLE_STEP = 0.25;
const MIN_TABLE_STEPS = 12;
const MAX_TABLE_STEPS = 160;
const EPSILON = 1e-9;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const FALLBACK_UP = new THREE.Vector3(0, 0, -1);

// Three-point Gauss-Legendre on [0, 1].
const GAUSS_NODES = [0.5 - Math.sqrt(15) / 10, 0.5, 0.5 + Math.sqrt(15) / 10];
const GAUSS_WEIGHTS = [5 / 18, 8 / 18, 5 / 18];

export interface SplineFrame {
    position: THREE.Vector3;
    /** Unit direction of travel. */
    tangent: THREE.Vector3;
    /** Unit up, square to the tangent, roll applied. */
    up: THREE.Vector3;
    /** Unit right of travel: tangent × up. */
    right: THREE.Vector3;
    /** Width (x) and height (y) scale. */
    scale: THREE.Vector2;
    /** Roll at this distance, radians. */
    roll: number;
    /** Distance along the spline the frame is at (wrapped or clamped). */
    distance: number;
}

export const createSplineFrame = (): SplineFrame => ({
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    right: new THREE.Vector3(0, 0, 1),
    scale: new THREE.Vector2(1, 1),
    roll: 0,
    distance: 0,
});

/**
 * The rotation that turns a model facing +Z with +Y up to face along the frame: +Z to the tangent,
 * +Y to the frame's up (and +X, the model's left, to the left of travel).
 */
export const splineFrameQuaternion = (frame: Pick<SplineFrame, 'tangent' | 'up' | 'right'>, target = new THREE.Quaternion()): THREE.Quaternion => {
    _basis.makeBasis(_left.copy(frame.right).negate(), frame.up, frame.tangent);
    return target.setFromRotationMatrix(_basis);
};

const _basis = new THREE.Matrix4();
const _left = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();

const hermite = (p0: THREE.Vector3, m0: THREE.Vector3, p1: THREE.Vector3, m1: THREE.Vector3, t: number, target: THREE.Vector3): THREE.Vector3 => {
    const t2 = t * t;
    const t3 = t2 * t;
    return target.set(0, 0, 0)
        .addScaledVector(p0, 2 * t3 - 3 * t2 + 1)
        .addScaledVector(m0, t3 - 2 * t2 + t)
        .addScaledVector(p1, -2 * t3 + 3 * t2)
        .addScaledVector(m1, t3 - t2);
};

const hermiteDerivative = (p0: THREE.Vector3, m0: THREE.Vector3, p1: THREE.Vector3, m1: THREE.Vector3, t: number, target: THREE.Vector3): THREE.Vector3 => {
    const t2 = t * t;
    return target.set(0, 0, 0)
        .addScaledVector(p0, 6 * t2 - 6 * t)
        .addScaledVector(m0, 3 * t2 - 4 * t + 1)
        .addScaledVector(p1, -6 * t2 + 6 * t)
        .addScaledVector(m1, 3 * t2 - 2 * t);
};

const scalarHermite = (v0: number, m0: number, v1: number, m1: number, t: number): number => {
    const t2 = t * t;
    const t3 = t2 * t;
    return v0 * (2 * t3 - 3 * t2 + 1) + m0 * (t3 - 2 * t2 + t) + v1 * (-2 * t3 + 3 * t2) + m1 * (t3 - t2);
};

/** Turns `vector` about the unit `axis` by `angle` radians. */
const rotateAbout = (vector: THREE.Vector3, axis: THREE.Vector3, angle: number): THREE.Vector3 => {
    if (angle === 0) return vector;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    _d.crossVectors(axis, vector);
    const along = axis.dot(vector) * (1 - cos);
    return vector.multiplyScalar(cos).addScaledVector(_d, sin).addScaledVector(axis, along);
};

/** `up` made square to the unit `tangent`; false when it lies along it. */
const squareTo = (up: THREE.Vector3, tangent: THREE.Vector3): boolean => {
    up.addScaledVector(tangent, -up.dot(tangent));
    const length = up.length();
    if (length < 1e-6) return false;
    up.divideScalar(length);
    return true;
};

export class Spline {
    readonly points: readonly SplinePoint[];
    readonly closed: boolean;
    readonly upMode: SplineUpMode;
    /** Length along the curve, in the spline's own units. */
    readonly length: number;
    readonly segmentCount: number;

    private readonly positions: THREE.Vector3[];
    /** Per segment: the tangent leaving its first point and the one arriving at its second. */
    private readonly leave: THREE.Vector3[] = [];
    private readonly arrive: THREE.Vector3[] = [];
    /** Per point: the slope roll and scale pass through it with (uniform Catmull-Rom). */
    private readonly rollSlopes: number[] = [];
    private readonly scaleSlopes: [number, number][] = [];
    /** Distance table: one row per step, segments in order. */
    private readonly tableDistance: Float64Array;
    private readonly tableSegment: Int32Array;
    private readonly tableT: Float64Array;
    private readonly tablePosition: Float32Array;
    private readonly tableUp: Float32Array;
    /** Row of each segment's first step; the extra last entry is one past the end. */
    private readonly segmentRows: Int32Array;

    constructor(data: SplineData) {
        this.points = data.points;
        this.closed = data.closed && data.points.length > 2;
        this.upMode = data.up;
        this.positions = data.points.map(point => new THREE.Vector3(...point.position));
        const count = this.positions.length;
        this.segmentCount = count < 2 ? 0 : this.closed ? count : count - 1;

        for (let segment = 0; segment < this.segmentCount; segment++) {
            const [leave, arrive] = this.segmentTangents(segment);
            this.leave.push(leave);
            this.arrive.push(arrive);
        }
        for (let i = 0; i < count; i++) {
            const previous = this.neighbour(i, -1);
            const next = this.neighbour(i, 1);
            const span = previous !== null && next !== null ? 2 : 1;
            const from = this.points[previous ?? i];
            const to = this.points[next ?? i];
            this.rollSlopes.push((to.roll - from.roll) / span);
            this.scaleSlopes.push([(to.scale[0] - from.scale[0]) / span, (to.scale[1] - from.scale[1]) / span]);
        }

        // Steps per segment by a length the curve cannot exceed (its Bezier control polygon).
        const steps: number[] = [];
        for (let segment = 0; segment < this.segmentCount; segment++) {
            const [a, b] = this.segmentEnds(segment);
            const bound = this.positions[a].distanceTo(this.positions[b]) + (this.leave[segment].length() + this.arrive[segment].length()) / 3;
            steps.push(Math.min(MAX_TABLE_STEPS, Math.max(MIN_TABLE_STEPS, Math.ceil(bound / TABLE_STEP))));
        }
        const rows = steps.reduce((sum, value) => sum + value, 0) + 1;
        this.tableDistance = new Float64Array(rows);
        this.tableSegment = new Int32Array(rows);
        this.tableT = new Float64Array(rows);
        this.tablePosition = new Float32Array(rows * 3);
        this.tableUp = new Float32Array(rows * 3);
        this.segmentRows = new Int32Array(this.segmentCount + 1);

        let row = 0;
        let distance = 0;
        for (let segment = 0; segment < this.segmentCount; segment++) {
            this.segmentRows[segment] = row;
            for (let step = 0; step < steps[segment]; step++) {
                const t = step / steps[segment];
                this.tableDistance[row] = distance;
                this.tableSegment[row] = segment;
                this.tableT[row] = t;
                distance += this.arcLength(segment, t, (step + 1) / steps[segment]);
                row++;
            }
        }
        this.segmentRows[this.segmentCount] = row;
        // The last row is the end of the last segment.
        this.tableDistance[row] = distance;
        this.tableSegment[row] = Math.max(0, this.segmentCount - 1);
        this.tableT[row] = this.segmentCount > 0 ? 1 : 0;
        this.length = distance;

        for (let i = 0; i < rows; i++) {
            const position = this.positionAtParam(this.tableSegment[i], this.tableT[i], _a);
            this.tablePosition[i * 3] = position.x;
            this.tablePosition[i * 3 + 1] = position.y;
            this.tablePosition[i * 3 + 2] = position.z;
        }
        this.buildUps(rows);
    }

    /** The two points a segment joins. */
    segmentEnds(segment: number): [number, number] {
        return [segment, (segment + 1) % this.positions.length];
    }

    /** Point `i`'s neighbour `step` (-1 or 1) along the spline, or null past an open end. */
    private neighbour(i: number, step: -1 | 1): number | null {
        const count = this.positions.length;
        const j = i + step;
        if (this.closed) return (j + count) % count;
        return j >= 0 && j < count ? j : null;
    }

    private segmentTangents(segment: number): [THREE.Vector3, THREE.Vector3] {
        const [a, b] = this.segmentEnds(segment);
        const p1 = this.positions[a];
        const p2 = this.positions[b];
        const before = this.neighbour(a, -1);
        const after = this.neighbour(b, 1);
        // Past an open end, a point mirrored through the end stands in for the missing neighbour.
        const p0 = before !== null ? this.positions[before] : p1.clone().multiplyScalar(2).sub(p2);
        const p3 = after !== null ? this.positions[after] : p2.clone().multiplyScalar(2).sub(p1);
        const chord = p2.clone().sub(p1);
        const t01 = Math.max(p1.distanceTo(p0) ** ALPHA, EPSILON);
        const t12 = Math.max(p2.distanceTo(p1) ** ALPHA, EPSILON);
        const t23 = Math.max(p3.distanceTo(p2) ** ALPHA, EPSILON);

        const tangentAt = (index: number, auto: () => THREE.Vector3): THREE.Vector3 => {
            const point = this.points[index];
            if (point.mode === 'custom') return new THREE.Vector3(...point.tangent);
            if (point.mode === 'linear') return chord.clone();
            return auto();
        };
        const leave = tangentAt(a, () => new THREE.Vector3()
            .addScaledVector(p1.clone().sub(p0), 1 / t01)
            .addScaledVector(p2.clone().sub(p0), -1 / (t01 + t12))
            .addScaledVector(chord, 1 / t12)
            .multiplyScalar(t12));
        const arrive = tangentAt(b, () => new THREE.Vector3()
            .addScaledVector(chord, 1 / t12)
            .addScaledVector(p3.clone().sub(p1), -1 / (t12 + t23))
            .addScaledVector(p3.clone().sub(p2), 1 / t23)
            .multiplyScalar(t12));
        return [leave, arrive];
    }

    /** Length of a segment from t0 to t1 (Gauss-Legendre over the speed). */
    private arcLength(segment: number, t0: number, t1: number): number {
        let sum = 0;
        for (let i = 0; i < GAUSS_NODES.length; i++) {
            sum += GAUSS_WEIGHTS[i] * this.derivativeAtParam(segment, t0 + (t1 - t0) * GAUSS_NODES[i], _b).length();
        }
        return sum * (t1 - t0);
    }

    positionAtParam(segment: number, t: number, target = new THREE.Vector3()): THREE.Vector3 {
        if (this.segmentCount === 0) return this.positions.length > 0 ? target.copy(this.positions[0]) : target.set(0, 0, 0);
        const [a, b] = this.segmentEnds(segment);
        return hermite(this.positions[a], this.leave[segment], this.positions[b], this.arrive[segment], t, target);
    }

    derivativeAtParam(segment: number, t: number, target = new THREE.Vector3()): THREE.Vector3 {
        if (this.segmentCount === 0) return target.set(0, 0, 0);
        const [a, b] = this.segmentEnds(segment);
        return hermiteDerivative(this.positions[a], this.leave[segment], this.positions[b], this.arrive[segment], t, target);
    }

    /** Unit direction of travel at a parameter, falling back to the chord where the curve stops (a zero custom tangent). */
    private tangentAtParam(segment: number, t: number, target: THREE.Vector3): THREE.Vector3 {
        this.derivativeAtParam(segment, t, target);
        if (target.lengthSq() > EPSILON) return target.normalize();
        const ahead = this.positionAtParam(segment, Math.min(1, t + 1e-3), _c);
        const behind = this.positionAtParam(segment, Math.max(0, t - 1e-3), _d);
        target.subVectors(ahead, behind);
        if (target.lengthSq() > EPSILON) return target.normalize();
        const [a, b] = this.segmentEnds(segment);
        target.subVectors(this.positions[b], this.positions[a]);
        return target.lengthSq() > EPSILON ? target.normalize() : target.set(1, 0, 0);
    }

    /** The up vector at every row of the distance table, before roll. */
    private buildUps(rows: number): void {
        const tangent = new THREE.Vector3();
        const previousTangent = new THREE.Vector3();
        const up = new THREE.Vector3();
        const previousUp = new THREE.Vector3();
        const position = new THREE.Vector3();
        const previousPosition = new THREE.Vector3();
        const store = (row: number) => {
            this.tableUp[row * 3] = up.x;
            this.tableUp[row * 3 + 1] = up.y;
            this.tableUp[row * 3 + 2] = up.z;
        };
        for (let row = 0; row < rows; row++) {
            this.tangentAtParam(this.tableSegment[row], this.tableT[row], tangent);
            position.fromArray(this.tablePosition, row * 3);
            if (row === 0) {
                up.copy(WORLD_UP);
                if (!squareTo(up, tangent)) {
                    up.copy(FALLBACK_UP);
                    squareTo(up, tangent);
                }
            } else if (this.upMode === 'world') {
                up.copy(WORLD_UP);
                // Straight up or down: keep the previous up, carried square to the new tangent.
                if (!squareTo(up, tangent)) {
                    up.copy(previousUp);
                    if (!squareTo(up, tangent)) up.copy(FALLBACK_UP);
                }
            } else {
                // Rotation minimising frame by double reflection (Wang et al. 2008).
                const v1 = _a.subVectors(position, previousPosition);
                const c1 = v1.dot(v1);
                up.copy(previousUp);
                const t = _b.copy(previousTangent);
                if (c1 > EPSILON) {
                    up.addScaledVector(v1, (-2 / c1) * v1.dot(previousUp));
                    t.addScaledVector(v1, (-2 / c1) * v1.dot(previousTangent));
                }
                const v2 = _c.subVectors(tangent, t);
                const c2 = v2.dot(v2);
                if (c2 > EPSILON) up.addScaledVector(v2, (-2 / c2) * v2.dot(up));
                if (!squareTo(up, tangent)) up.copy(previousUp);
            }
            store(row);
            previousTangent.copy(tangent);
            previousUp.copy(up);
            previousPosition.copy(position);
        }
        // A closed minimal-twist loop ends turned from where it began: spread the difference along it.
        if (this.upMode === 'minimal' && this.closed && rows > 1 && this.length > EPSILON) {
            const startUp = new THREE.Vector3().fromArray(this.tableUp, 0);
            const endTangent = this.tangentAtParam(this.tableSegment[rows - 1], this.tableT[rows - 1], new THREE.Vector3());
            const endUp = new THREE.Vector3().fromArray(this.tableUp, (rows - 1) * 3);
            const twist = Math.atan2(_a.crossVectors(endUp, startUp).dot(endTangent), endUp.dot(startUp));
            for (let row = 1; row < rows; row++) {
                this.tangentAtParam(this.tableSegment[row], this.tableT[row], tangent);
                up.fromArray(this.tableUp, row * 3);
                rotateAbout(up, tangent, twist * (this.tableDistance[row] / this.length));
                squareTo(up, tangent);
                store(row);
            }
        }
    }

    /** `distance` wrapped round a closed spline or clamped to an open one. */
    wrap(distance: number): number {
        if (!(this.length > EPSILON)) return 0;
        if (this.closed) return ((distance % this.length) + this.length) % this.length;
        return Math.min(this.length, Math.max(0, distance));
    }

    /** The table row at or before `distance` (already wrapped). */
    private rowAt(distance: number): number {
        let low = 0;
        let high = this.tableDistance.length - 1;
        while (high - low > 1) {
            const middle = (low + high) >> 1;
            if (this.tableDistance[middle] <= distance) low = middle;
            else high = middle;
        }
        return low;
    }

    /** Segment and its own parameter at a distance along the spline. */
    paramAt(distance: number): { segment: number; t: number } {
        if (this.segmentCount === 0) return { segment: 0, t: 0 };
        const d = this.wrap(distance);
        const row = Math.min(this.rowAt(d), this.tableDistance.length - 2);
        const segment = this.tableSegment[row];
        const t0 = this.tableT[row];
        const nextRow = row + 1;
        const t1 = this.tableSegment[nextRow] === segment ? this.tableT[nextRow] : 1;
        const d0 = this.tableDistance[row];
        const span = this.tableDistance[nextRow] - d0;
        let t = span > EPSILON ? t0 + (t1 - t0) * ((d - d0) / span) : t0;
        // One Newton step on the remaining error makes the table's straight-line guess exact enough.
        const speed = this.derivativeAtParam(segment, t, _b).length();
        if (speed > EPSILON) {
            const error = this.arcLength(segment, t0, t) - (d - d0);
            t = Math.min(t1, Math.max(t0, t - error / speed));
        }
        return { segment, t };
    }

    /** Distance along the spline at control point `index` (the length for the end of an open spline). */
    distanceAtPoint(index: number): number {
        if (this.segmentCount === 0) return 0;
        if (index >= this.segmentCount) return this.length;
        return this.tableDistance[this.segmentRows[Math.max(0, index)]];
    }

    positionAt(distance: number, target = new THREE.Vector3()): THREE.Vector3 {
        const { segment, t } = this.paramAt(distance);
        return this.positionAtParam(segment, t, target);
    }

    tangentAt(distance: number, target = new THREE.Vector3()): THREE.Vector3 {
        const { segment, t } = this.paramAt(distance);
        return this.tangentAtParam(segment, t, target);
    }

    /** Roll (radians) and scale at a segment's parameter, eased through the points. */
    private profileAtParam(segment: number, t: number, scale: THREE.Vector2): number {
        if (this.segmentCount === 0) {
            const point = this.points[0];
            if (point) scale.set(point.scale[0], point.scale[1]);
            return point ? THREE.MathUtils.degToRad(point.roll) : 0;
        }
        const [a, b] = this.segmentEnds(segment);
        const from = this.points[a];
        const to = this.points[b];
        scale.set(
            Math.max(MIN_SPLINE_SCALE, scalarHermite(from.scale[0], this.scaleSlopes[a][0], to.scale[0], this.scaleSlopes[b][0], t)),
            Math.max(MIN_SPLINE_SCALE, scalarHermite(from.scale[1], this.scaleSlopes[a][1], to.scale[1], this.scaleSlopes[b][1], t)),
        );
        return THREE.MathUtils.degToRad(scalarHermite(from.roll, this.rollSlopes[a], to.roll, this.rollSlopes[b], t));
    }

    /** Position, frame, roll and scale at a distance along the spline. */
    frameAt(distance: number, target: SplineFrame = createSplineFrame()): SplineFrame {
        const d = this.wrap(distance);
        target.distance = d;
        if (this.segmentCount === 0) {
            this.positionAtParam(0, 0, target.position);
            target.tangent.set(1, 0, 0);
            target.up.copy(WORLD_UP);
            target.right.crossVectors(target.tangent, target.up);
            target.roll = this.profileAtParam(0, 0, target.scale);
            return target;
        }
        const { segment, t } = this.paramAt(d);
        this.positionAtParam(segment, t, target.position);
        this.tangentAtParam(segment, t, target.tangent);
        // The up between the table rows either side, made square to the exact tangent.
        const row = Math.min(this.rowAt(d), this.tableDistance.length - 2);
        const span = this.tableDistance[row + 1] - this.tableDistance[row];
        const blend = span > EPSILON ? (d - this.tableDistance[row]) / span : 0;
        target.up.fromArray(this.tableUp, row * 3).lerp(_a.fromArray(this.tableUp, (row + 1) * 3), blend);
        if (!squareTo(target.up, target.tangent)) {
            target.up.fromArray(this.tableUp, row * 3);
            if (!squareTo(target.up, target.tangent)) {
                target.up.copy(FALLBACK_UP);
                squareTo(target.up, target.tangent);
            }
        }
        target.roll = this.profileAtParam(segment, t, target.scale);
        rotateAbout(target.up, target.tangent, target.roll);
        target.right.crossVectors(target.tangent, target.up).normalize();
        return target;
    }

    /** Distance along the spline of the curve point nearest to `point`. */
    closestDistance(point: THREE.Vector3): number {
        const rows = this.tableDistance.length;
        if (this.segmentCount === 0 || rows < 2) return 0;
        let best = 0;
        let bestSq = Infinity;
        for (let row = 0; row < rows; row++) {
            const dx = this.tablePosition[row * 3] - point.x;
            const dy = this.tablePosition[row * 3 + 1] - point.y;
            const dz = this.tablePosition[row * 3 + 2] - point.z;
            const sq = dx * dx + dy * dy + dz * dz;
            if (sq < bestSq) {
                bestSq = sq;
                best = row;
            }
        }
        // Golden-section search over the steps either side of the nearest table row.
        let low = this.tableDistance[Math.max(0, best - 1)];
        let high = this.tableDistance[Math.min(rows - 1, best + 1)];
        const distanceSq = (d: number) => this.positionAt(d, _c).distanceToSquared(point);
        const ratio = (Math.sqrt(5) - 1) / 2;
        let x1 = high - ratio * (high - low);
        let x2 = low + ratio * (high - low);
        let f1 = distanceSq(x1);
        let f2 = distanceSq(x2);
        for (let i = 0; i < 40 && high - low > 1e-6; i++) {
            if (f1 < f2) {
                high = x2;
                x2 = x1;
                f2 = f1;
                x1 = high - ratio * (high - low);
                f1 = distanceSq(x1);
            } else {
                low = x1;
                x1 = x2;
                f1 = f2;
                x2 = low + ratio * (high - low);
                f2 = distanceSq(x2);
            }
        }
        return this.wrap((low + high) / 2);
    }

    /**
     * Points along the curve for drawing it, each step at most `maxStep` long and closer where it
     * bends; a closed spline repeats its first point at the end.
     */
    polyline(maxStep = 0.5): THREE.Vector3[] {
        if (this.segmentCount === 0) return this.positions.map(position => position.clone());
        const count = Math.max(2, Math.min(20000, Math.ceil(this.length / Math.max(maxStep, 1e-3)) + this.segmentCount * 8));
        const points: THREE.Vector3[] = [];
        for (let i = 0; i <= count; i++) points.push(this.positionAt((this.length * i) / count));
        return points;
    }

    /** The tangent the curve has through point `index` (its leaving tangent; the arriving one at an open end). */
    pointTangent(index: number, target = new THREE.Vector3()): THREE.Vector3 {
        if (this.segmentCount === 0) return target.set(0, 0, 0);
        if (index < this.segmentCount) return target.copy(this.leave[index]);
        return target.copy(this.arrive[this.segmentCount - 1]);
    }
}

export const buildSpline = (data: SplineData): Spline => new Spline(data);

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

const copyPoint = (point: SplinePoint): SplinePoint => splinePoint(point.position, point);

const withPoints = (data: SplineData, points: SplinePoint[]): SplineData => ({ ...data, points });

/** Adds a point on the curve at `distance`, between the points either side, with the roll and scale it has there. */
export const insertSplinePointAt = (data: SplineData, distance: number): { data: SplineData; index: number } => {
    const spline = new Spline(data);
    if (spline.segmentCount === 0 || data.points.length >= MAX_SPLINE_POINTS) return { data, index: -1 };
    const frame = spline.frameAt(distance);
    const { segment } = spline.paramAt(distance);
    const index = segment + 1;
    const point = splinePoint(frame.position.toArray() as SplineVec3, {
        roll: Math.round(THREE.MathUtils.radToDeg(frame.roll) * 100) / 100,
        scale: [frame.scale.x, frame.scale.y],
    });
    const points = data.points.map(copyPoint);
    points.splice(index, 0, point);
    return { data: withPoints(data, points), index };
};

/**
 * A copy of point `index` placed just after it (or before it, at the start of an open spline), to
 * drag away: what Alt-dragging a point does.
 */
export const duplicateSplinePoint = (data: SplineData, index: number): { data: SplineData; index: number } => {
    if (index < 0 || index >= data.points.length || data.points.length >= MAX_SPLINE_POINTS) return { data, index };
    const points = data.points.map(copyPoint);
    const at = !data.closed && index === 0 && points.length > 1 ? 0 : index + 1;
    points.splice(at, 0, copyPoint(points[index]));
    return { data: withPoints(data, points), index: at };
};

/** A new point past the end, continuing the curve by its last segment's length (or 5 m). */
export const appendSplinePoint = (data: SplineData): { data: SplineData; index: number } => {
    const points = data.points.map(copyPoint);
    if (points.length >= MAX_SPLINE_POINTS) return { data, index: -1 };
    if (points.length === 0) return { data: withPoints(data, [splinePoint([0, 0, 0])]), index: 0 };
    const last = points[points.length - 1];
    const spline = new Spline({ ...data, closed: false });
    const direction = spline.segmentCount > 0 ? spline.tangentAt(spline.length) : new THREE.Vector3(1, 0, 0);
    const step = points.length > 1 ? Math.max(1, spline.length - spline.distanceAtPoint(points.length - 2)) : 5;
    const position = new THREE.Vector3(...last.position).addScaledVector(direction, step);
    points.push(splinePoint(position.toArray() as SplineVec3, { roll: last.roll, scale: last.scale }));
    return { data: withPoints(data, points), index: points.length - 1 };
};

/** Removes point `index`; a spline keeps at least two points. */
export const removeSplinePoint = (data: SplineData, index: number): SplineData => {
    if (data.points.length <= 2 || index < 0 || index >= data.points.length) return data;
    return withPoints(data, data.points.filter((_, i) => i !== index).map(copyPoint));
};

/** Runs the spline the other way: the points in reverse order, custom tangents turned round. */
export const reverseSpline = (data: SplineData): SplineData => withPoints(data, data.points.slice().reverse().map(point => ({
    ...copyPoint(point),
    tangent: point.tangent.map(value => -value) as SplineVec3,
})));

/** Point `index` with `patch` applied. */
export const updateSplinePoint = (data: SplineData, index: number, patch: Partial<SplinePoint>): SplineData =>
    withPoints(data, data.points.map((point, i) => (i === index ? { ...copyPoint(point), ...patch } : copyPoint(point))));
