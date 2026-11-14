/** Editable sewing geometry. Chart coordinates, world placement and target edge length are metres. */
export interface GarmentPoint { id: string; x: number; y: number }
export type PatternVector3 = [number, number, number];
export interface GarmentPanel {
    id: string;
    name: string;
    /** Simple, counterclockwise polygon; the last point connects to the first. */
    boundary: GarmentPoint[];
    /** Unit warp direction in the chart. The normal to its left is the positive weft direction. */
    grain: [number, number];
    placement: { origin: PatternVector3; u: PatternVector3; v: PatternVector3 };
    pins: string[];
}
export interface GarmentSeamSide { panelId: string; from: string; to: string }
export interface GarmentSeam { id: string; a: GarmentSeamSide; b: GarmentSeamSide }
export interface GarmentPattern { version: 1; edgeLength: number; panels: GarmentPanel[]; seams: GarmentSeam[] }
export interface GarmentHinge { a: number; b: number; c: number; d: number }
export interface GarmentStitch { seamId: string; a: number; b: number; weight: number }
export interface GarmentPanelRange { id: string; vertexStart: number; vertexCount: number; indexStart: number; indexCount: number }
export interface CookedGarment {
    positions: Float32Array;
    restUV: Float32Array;
    materialUV: Float32Array;
    indices: Uint32Array;
    seams: GarmentStitch[];
    pins: number[];
    hinges: GarmentHinge[];
    panelRanges: GarmentPanelRange[];
}

export const GARMENT_LIMITS = Object.freeze({
    panels: 32, boundary: 128, sourceVertices: 512, seams: 256, cookedVertices: 8192,
    minEdgeLength: 0.005, maxEdgeLength: 1,
});
const EPSILON_AREA = 1e-12;
const MIN_FEATURE = 1e-5;

type Point = { x: number; y: number };
type RecordValue = Record<string, unknown>;

function check(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error('Garment pattern: ' + message);
}
function object(value: unknown, label: string): RecordValue {
    check(value !== null && typeof value === 'object' && !Array.isArray(value), label + ' must be an object.');
    return value as RecordValue;
}
function list(value: unknown, min: number, max: number, label: string): unknown[] {
    check(Array.isArray(value) && value.length >= min && value.length <= max, label + ' requires ' + min + '–' + max + ' entries.');
    return value;
}
function id(value: unknown, label: string): string {
    check(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(value), label + ' needs a valid stable ID.');
    return value;
}
function numeric(value: unknown, label: string, bound = 100): number {
    check(typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= bound, label + ' must be finite and within ±' + bound + '.');
    return value;
}
function unique(values: string[], label: string): void {
    check(new Set(values).size === values.length, 'Duplicate ' + label + '.');
}
function vector3(value: unknown, label: string): PatternVector3 {
    const v = list(value, 3, 3, label);
    return [numeric(v[0], label), numeric(v[1], label), numeric(v[2], label)];
}
function cross(a: Point, b: Point, c: Point): number {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function onSegment(a: Point, b: Point, p: Point): boolean {
    return Math.abs(cross(a, b, p)) <= EPSILON_AREA &&
        p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) &&
        p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
}
function intersect(a: Point, b: Point, c: Point, d: Point): boolean {
    return (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) ||
        onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}
function readPanel(value: unknown): GarmentPanel {
    const p = object(value, 'Panel');
    const panelId = id(p.id, 'Panel');
    check(typeof p.name === 'string' && p.name.trim().length > 0 && p.name.length <= 128, panelId + ' needs a name of at most 128 characters.');
    const boundary = list(p.boundary, 3, GARMENT_LIMITS.boundary, panelId + ' boundary').map(v => {
        const vertex = object(v, 'Boundary point');
        return { id: id(vertex.id, 'Boundary point'), x: numeric(vertex.x, panelId + ' x'), y: numeric(vertex.y, panelId + ' y') };
    });
    unique(boundary.map(v => v.id), 'boundary point ID in ' + panelId);
    let area = 0;
    for (let i = 0; i < boundary.length; i++) {
        const a = boundary[i], b = boundary[(i + 1) % boundary.length], prev = boundary[(i + boundary.length - 1) % boundary.length];
        check(Math.hypot(b.x - a.x, b.y - a.y) >= MIN_FEATURE, panelId + ' has a collapsed edge at ' + a.id + '.');
        const returnsAlongSegment = Math.abs(cross(prev, a, b)) <= EPSILON_AREA && (prev.x - a.x) * (b.x - a.x) + (prev.y - a.y) * (b.y - a.y) > 0;
        check(!returnsAlongSegment, panelId + ' doubles back at ' + a.id + '.');
        area += cross(boundary[0], a, b);
        for (let j = i + 2; j < boundary.length; j++) {
            if (i === 0 && j === boundary.length - 1) continue;
            const c = boundary[j], d = boundary[(j + 1) % boundary.length];
            check(!intersect(a, b, c, d), panelId + ' crosses itself at ' + a.id + ' and ' + c.id + '.');
        }
    }
    check(area > EPSILON_AREA, panelId + ' needs a counterclockwise, positive-area boundary.');
    const g = list(p.grain, 2, 2, panelId + ' grain');
    const grain: [number, number] = [numeric(g[0], 'Warp X'), numeric(g[1], 'Warp Y')];
    check(Math.abs(Math.hypot(...grain) - 1) < 1e-5, panelId + ' grain must be a unit vector.');
    const placement = object(p.placement, panelId + ' placement');
    const origin = vector3(placement.origin, 'Placement origin'), u = vector3(placement.u, 'Placement U'), v = vector3(placement.v, 'Placement V');
    check(Math.abs(Math.hypot(...u) - 1) < 1e-5 && Math.abs(Math.hypot(...v) - 1) < 1e-5 &&
        Math.abs(u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) < 1e-5, panelId + ' placement axes must be orthonormal.');
    const pins = list(p.pins, 0, boundary.length, panelId + ' pins').map(pin => id(pin, 'Pin'));
    unique(pins, 'pin in ' + panelId);
    const known = new Set(boundary.map(v => v.id));
    for (const pin of pins) check(known.has(pin), 'Missing pin ' + panelId + '/' + pin + '.');
    return { id: panelId, name: p.name, boundary, grain, placement: { origin, u, v }, pins };
}
function readSide(value: unknown): GarmentSeamSide {
    const s = object(value, 'Seam side');
    return { panelId: id(s.panelId, 'Panel reference'), from: id(s.from, 'Seam start'), to: id(s.to, 'Seam end') };
}
function boundaryDirection(panel: GarmentPanel, side: GarmentSeamSide): number {
    const i = panel.boundary.findIndex(v => v.id === side.from);
    const n = panel.boundary.length;
    if (i >= 0 && panel.boundary[(i + 1) % n].id === side.to) return 1;
    if (i >= 0 && panel.boundary[(i + n - 1) % n].id === side.to) return -1;
    return 0;
}
function sideKey(s: GarmentSeamSide): string {
    return s.panelId + '/' + [s.from, s.to].sort().join('/');
}

/** Validate imported or edited JSON and return an owned copy. Invalid topology produces a user-facing reason. */
export function readGarmentPattern(value: unknown): GarmentPattern {
    const p = object(value, 'Pattern');
    check(p.version === 1, 'Unsupported pattern version.');
    const edgeLength = numeric(p.edgeLength, 'Mesh edge length');
    check(edgeLength >= GARMENT_LIMITS.minEdgeLength && edgeLength <= GARMENT_LIMITS.maxEdgeLength, 'Mesh edge length must be 0.005–1 m.');
    const panels = list(p.panels, 1, GARMENT_LIMITS.panels, 'Panels').map(readPanel);
    unique(panels.map(panel => panel.id), 'panel ID');
    check(panels.reduce((n, panel) => n + panel.boundary.length, 0) <= GARMENT_LIMITS.sourceVertices, 'Too many source boundary points.');
    const byId = new Map(panels.map(panel => [panel.id, panel]));
    const occupied = new Set<string>();
    const seams = list(p.seams, 0, GARMENT_LIMITS.seams, 'Seams').map(value => {
        const s = object(value, 'Seam');
        const seam = { id: id(s.id, 'Seam'), a: readSide(s.a), b: readSide(s.b) };
        const directions = [seam.a, seam.b].map(side => {
            const panel = byId.get(side.panelId);
            check(panel, 'Missing seam panel ' + side.panelId + '.');
            const direction = boundaryDirection(panel, side);
            check(direction, seam.id + ' must join neighboring points on ' + panel.id + '.');
            const key = sideKey(side);
            check(!occupied.has(key), 'A boundary edge is sewn twice: ' + key + '.');
            occupied.add(key);
            return direction;
        });
        check(directions[0] !== directions[1], seam.id + ' must run in opposite directions around the two boundaries.');
        return seam;
    });
    unique(seams.map(s => s.id), 'seam ID');
    return { version: 1, edgeLength, panels, seams };
}

/** Closed polygon triangulation retaining authored collinear landmarks, including points inserted by Split Edge. */
function triangulate(points: Point[], start: number): number[] {
    const ring = Array.from({ length: points.length }, (_, i) => i);
    const triangles: number[] = [];
    while (ring.length > 3) {
        const n = ring.length;
        let ear = -1;
        let bestShape = -1;
        for (let i = 0; i < n; i++) {
            const ai = ring[(i + n - 1) % n], bi = ring[i], ci = ring[(i + 1) % n];
            const a = points[ai], b = points[bi], c = points[ci];
            const area = cross(a, b, c);
            if (area <= EPSILON_AREA) continue;
            const shape = area / ((a.x - c.x) ** 2 + (a.y - c.y) ** 2 + (b.x - c.x) ** 2 + (b.y - c.y) ** 2 + (a.x - b.x) ** 2 + (a.y - b.y) ** 2);
            if (shape <= bestShape) continue;
            const blocked = ring.some(p => p !== ai && p !== bi && p !== ci && cross(a, b, points[p]) >= -EPSILON_AREA &&
                cross(b, c, points[p]) >= -EPSILON_AREA && cross(c, a, points[p]) >= -EPSILON_AREA);
            if (!blocked) { ear = i; bestShape = shape; }
        }
        check(ear >= 0, 'A panel is too narrow to triangulate reliably.');
        triangles.push(start + ring[(ear + n - 1) % n], start + ring[ear], start + ring[(ear + 1) % n]);
        ring.splice(ear, 1);
    }
    check(cross(points[ring[0]], points[ring[1]], points[ring[2]]) > EPSILON_AREA, 'A panel has a degenerate final triangle.');
    triangles.push(start + ring[0], start + ring[1], start + ring[2]);
    return triangles;
}

function edgeKey(a: number, b: number): number {
    return Math.min(a, b) * GARMENT_LIMITS.cookedVertices + Math.max(a, b);
}

interface CookPanel {
    panel: GarmentPanel;
    source: Map<string, number>;
    vertices: number[];
    indices: number[];
}

/** Splits marked triangle edges conformingly with shared midpoints, preserving all boundary points. */
function refine(indices: number[], splits: Map<number, number>, points: Point[]): number[] {
    const out: number[] = [];
    for (let i = 0; i < indices.length; i += 3) {
        const tri = [indices[i], indices[i + 1], indices[i + 2]];
        const mid = tri.map((a, k) => splits.get(edgeKey(a, tri[(k + 1) % 3])));
        const count = mid.filter(m => m !== undefined).length;
        if (count === 0) { out.push(...tri); continue; }
        if (count === 3) {
            const [ab, bc, ca] = mid as number[];
            out.push(tri[0], ab, ca, ab, tri[1], bc, ca, bc, tri[2], ab, bc, ca);
            continue;
        }
        const k = count === 1 ? mid.findIndex(m => m !== undefined) : (mid.findIndex(m => m === undefined) + 1) % 3;
        const a = tri[k], b = tri[(k + 1) % 3], c = tri[(k + 2) % 3], ab = mid[k]!;
        if (count === 1) { out.push(a, ab, c, ab, b, c); continue; }
        const bc = mid[(k + 1) % 3]!;
        out.push(ab, b, bc);
        const dist2 = (x: number, y: number) => (points[x].x - points[y].x) ** 2 + (points[x].y - points[y].y) ** 2;
        if (dist2(a, bc) < dist2(ab, c)) out.push(a, ab, bc, a, bc, c);
        else out.push(a, ab, c, ab, bc, c);
    }
    return out;
}

interface CookSeam { seamId: string; a: number[]; b: number[] }
function refineSeam(chain: number[], splits: Map<number, number>): number[] {
    const result = [chain[0]];
    for (let i = 1; i < chain.length; i++) {
        const m = splits.get(edgeKey(chain[i - 1], chain[i]));
        if (m !== undefined) result.push(m);
        result.push(chain[i]);
    }
    return result;
}

function buildHinges(indices: number[]): GarmentHinge[] {
    const halfEdges = new Map<number, { a: number; b: number; c: number }>();
    const hinges: GarmentHinge[] = [];
    for (let i = 0; i < indices.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            const a = indices[i + k], b = indices[i + (k + 1) % 3], c = indices[i + (k + 2) % 3];
            const key = edgeKey(a, b), prev = halfEdges.get(key);
            if (prev) {
                check(prev.a === b && prev.b === a, 'Inconsistent triangle orientation.');
                hinges.push({ ...prev, d: c });
                halfEdges.delete(key);
            } else halfEdges.set(key, { a, b, c });
        }
    }
    return hinges;
}

/** Deterministic, budgeted meshing in material space. Unequal sewn edges share normalized arc samples. */
export function cookGarment(value: GarmentPattern): CookedGarment {
    const pattern = readGarmentPattern(value);
    const points: Point[] = [];
    const owner: CookPanel[] = [];
    const panels = pattern.panels.map(panel => {
        const start = points.length;
        const group: CookPanel = { panel, vertices: [], indices: triangulate(panel.boundary, start), source: new Map() };
        for (const p of panel.boundary) {
            group.source.set(p.id, points.length);
            group.vertices.push(points.length);
            points.push({ x: p.x, y: p.y });
            owner.push(group);
        }
        return group;
    });
    const byId = new Map(panels.map(g => [g.panel.id, g]));
    const length = (a: number, b: number) => Math.hypot(points[a].x - points[b].x, points[a].y - points[b].y);
    function side(ref: GarmentSeamSide): number[] {
        const group = byId.get(ref.panelId)!;
        return [group.source.get(ref.from)!, group.source.get(ref.to)!];
    }
    const seams: CookSeam[] = pattern.seams.map(s => {
        const a = side(s.a), b = side(s.b);
        return { seamId: s.id, a, b };
    });
    const restArea = panels.reduce((total, g) => total + g.indices.reduce((sum, index, i, tri) =>
        i % 3 === 0 ? sum + cross(points[index], points[tri[i + 1]], points[tri[i + 2]]) / 2 : sum, 0), 0);
    // Every triangle of maximum edge h has area <= sqrt(3)/4 * h². Every simple disk has T < 2V.
    check(restArea <= 2 * GARMENT_LIMITS.cookedVertices * Math.sqrt(3) / 4 * pattern.edgeLength ** 2, 'Mesh vertex budget exceeded. Increase the mesh edge length.');
    for (let round = 0; ; round++) {
        const splits = new Map<number, number>();
        function split(a: number, b: number): void {
            const key = edgeKey(a, b);
            if (splits.has(key)) return;
            check(points.length < GARMENT_LIMITS.cookedVertices, 'Mesh vertex budget exceeded. Increase the mesh edge length.');
            splits.set(key, points.length);
            owner[a].vertices.push(points.length);
            points.push({ x: (points[a].x + points[b].x) * .5, y: (points[a].y + points[b].y) * .5 });
            owner.push(owner[a]);
        }
        const maxEdge = pattern.edgeLength * (1 + 1e-10);
        for (const g of panels) {
            for (let i = 0; i < g.indices.length; i += 3) {
                for (let k = 0; k < 3; k++) {
                    const a = g.indices[i + k], b = g.indices[i + (k + 1) % 3];
                    if (length(a, b) > maxEdge) split(a, b);
                }
            }
        }
        if (!splits.size) break;
        check(round < 32, 'Mesh refinement failed to converge. Check panel scale and feature size.');
        for (const s of seams) {
            for (let i = 1; i < s.a.length; i++) {
                const a0 = s.a[i - 1], a1 = s.a[i], b0 = s.b[i - 1], b1 = s.b[i];
                if (splits.has(edgeKey(a0, a1)) || splits.has(edgeKey(b0, b1))) { split(a0, a1); split(b0, b1); }
            }
            s.a = refineSeam(s.a, splits);
            s.b = refineSeam(s.b, splits);
        }
        for (const g of panels) g.indices = refine(g.indices, splits, points);
    }

    const positions = new Float32Array(points.length * 3), restUV = new Float32Array(points.length * 2), materialUV = new Float32Array(points.length * 2);
    const remap = new Uint32Array(points.length), indices: number[] = [], pins: number[] = [], panelRanges: GarmentPanelRange[] = [];
    let cursor = 0;
    for (const g of panels) {
        const p = g.panel, vertexStart = cursor, indexStart = indices.length;
        const { origin, u, v } = p.placement;
        for (const old of g.vertices) {
            remap[old] = cursor;
            const { x, y } = points[old];
            restUV.set([x, y], cursor * 2);
            materialUV.set([x * p.grain[0] + y * p.grain[1], -x * p.grain[1] + y * p.grain[0]], cursor * 2);
            for (let k = 0; k < 3; k++) positions[cursor * 3 + k] = origin[k] + x * u[k] + y * v[k];
            cursor++;
        }
        for (const i of g.indices) indices.push(remap[i]);
        for (const pin of p.pins) pins.push(remap[g.source.get(pin)!]);
        panelRanges.push({ id: p.id, vertexStart, vertexCount: cursor - vertexStart, indexStart, indexCount: indices.length - indexStart });
    }
    const stitches: GarmentStitch[] = [];
    for (const s of seams) {
        for (let i = 0; i < s.a.length; i++) {
            // Trapezoidal line quadrature, measured in mean rest arc length across both sides.
            let weight = 0;
            for (const j of [i - 1, i + 1]) {
                if (j >= 0 && j < s.a.length) weight += (length(s.a[i], s.a[j]) + length(s.b[i], s.b[j])) * .25;
            }
            stitches.push({ seamId: s.seamId, a: remap[s.a[i]], b: remap[s.b[i]], weight });
        }
    }
    return { positions, restUV, materialUV, indices: new Uint32Array(indices), seams: stitches, pins, hinges: buildHinges(indices), panelRanges };
}

function nextId(existing: Iterable<string>, base: string): string {
    const occupied = new Set(existing);
    const prefix = base.slice(0, 86);
    let suffix = 1;
    while (occupied.has(prefix + '-' + suffix)) suffix++;
    return prefix + '-' + suffix;
}

/** Split a boundary edge, preserving normalized stitch correspondence on both sides of a sewn span. */
export function splitGarmentEdge(pattern: GarmentPattern, panelId: string, from: string, to: string, fraction = .5): GarmentPattern {
    const copy = readGarmentPattern(pattern);
    check(Number.isFinite(fraction) && fraction > 0 && fraction < 1, 'Split fraction must be between zero and one.');
    const selected: GarmentSeamSide = { panelId, from, to };
    const panelOf = (s: GarmentSeamSide) => {
        const p = copy.panels.find(p => p.id === s.panelId);
        check(p && boundaryDirection(p, s), 'Select one complete boundary edge to split.');
        return p;
    };
    panelOf(selected);
    function split(s: GarmentSeamSide, t: number): string {
        const p = panelOf(s);
        const a = p.boundary.find(v => v.id === s.from)!, b = p.boundary.find(v => v.id === s.to)!;
        const point = { id: nextId(p.boundary.map(v => v.id), 'point'), x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
        const leading = boundaryDirection(p, s) === 1 ? a : b;
        p.boundary.splice(p.boundary.indexOf(leading) + 1, 0, point);
        return point.id;
    }
    const key = sideKey(selected);
    const seam = copy.seams.find(s => sideKey(s.a) === key || sideKey(s.b) === key);
    if (!seam) split(selected, fraction);
    else {
        const matching = sideKey(seam.a) === key ? seam.a : seam.b;
        const t = matching.from === from ? fraction : 1 - fraction;
        const aMid = split(seam.a, t), bMid = split(seam.b, t);
        const tail = { id: nextId(copy.seams.map(s => s.id), seam.id), a: { ...seam.a, from: aMid }, b: { ...seam.b, from: bMid } };
        seam.a.to = aMid;
        seam.b.to = bMid;
        copy.seams.splice(copy.seams.indexOf(seam) + 1, 0, tail);
    }
    return readGarmentPattern(copy);
}

/** Original two-panel sleeveless top, outward-facing in actor space around a metre-scale torso. */
export function createSleevelessTop(): GarmentPattern {
    const outline: Array<[string, number, number]> = [
        ['hem_left', -.215, 0], ['hem_right', .215, 0], ['right_underarm', .215, .36],
        ['right_arm_lower', .175, .395], ['right_arm_upper', .163, .455], ['right_shoulder_outer', .175, .52],
        ['right_neck', .08, .55], ['right_neck_curve', .046, .496], ['neck_center', 0, .48],
        ['left_neck_curve', -.046, .496], ['left_neck', -.08, .55], ['left_shoulder_outer', -.175, .52],
        ['left_arm_upper', -.163, .455], ['left_arm_lower', -.175, .395], ['left_underarm', -.215, .36],
    ];
    const panels = ['front', 'back'].map((panelId): GarmentPanel => {
        const front = panelId === 'front', facing = front ? 1 : -1;
        const boundary = outline.map(([label, x, y]) => {
            const id = front ? label : label.replace(/left|right/g, s => s === 'left' ? 'right' : 'left');
            if (!front && id.endsWith('neck_curve')) y = .533;
            if (!front && id === 'neck_center') y = .525;
            return { id, x, y };
        });
        return { id: panelId, name: front ? 'Front' : 'Back', boundary, grain: [0, 1],
            placement: { origin: [0, 1.04, facing * .115], u: [facing, 0, 0], v: [0, 1, 0] },
            pins: front ? ['left_shoulder_outer', 'right_shoulder_outer'] : [] };
    });
    const seams = [
        ['left_shoulder', 'left_neck', 'left_shoulder_outer'],
        ['right_shoulder', 'right_shoulder_outer', 'right_neck'],
        ['left_side', 'left_underarm', 'hem_left'],
        ['right_side', 'hem_right', 'right_underarm'],
    ].map(([seamId, from, to]) => ({ id: seamId, a: { panelId: 'front', from, to }, b: { panelId: 'back', from, to } }));
    return { version: 1, edgeLength: .055, panels, seams };
}
