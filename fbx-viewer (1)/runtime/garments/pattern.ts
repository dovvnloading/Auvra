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
    /** Increasing ranks lie outward, along the panel normal. The base layer is zero. */
    layer?: number;
    placement: { origin: PatternVector3; u: PatternVector3; v: PatternVector3 };
    pins: string[];
}
export interface GarmentSeamSide { panelId: string; from: string; to: string }
export interface GarmentSeam { id: string; a: GarmentSeamSide; b: GarmentSeamSide }
export interface GarmentPattern { version: 1; edgeLength: number; panels: GarmentPanel[]; seams: GarmentSeam[] }
export interface GarmentHinge { a: number; b: number; c: number; d: number }
export interface GarmentStitch { seamId: string; a: number; b: number; weight: number }
export interface GarmentPanelRange { id: string; layer?: number; vertexStart: number; vertexCount: number; indexStart: number; indexCount: number }
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
    minEdgeLength: 0.005, maxEdgeLength: 1, maxLayer: 15,
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
    const layer = p.layer === undefined ? 0 : p.layer;
    check(typeof layer === 'number' && Number.isInteger(layer) && layer >= 0 && layer <= GARMENT_LIMITS.maxLayer,
        panelId + ' layer must be an integer from 0 to ' + GARMENT_LIMITS.maxLayer + '.');
    return { id: panelId, name: p.name, boundary, grain, placement: { origin, u, v }, pins, ...(layer ? { layer } : {}) };
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

/** Improve interior diagonals in bounded disjoint sweeps. Boundaries and the size field remain fixed. */
function improveAngles(indices: number[], points: Point[], maxEdge: number): void {
    const dist2 = (a: number, b: number) => (points[a].x - points[b].x) ** 2 + (points[a].y - points[b].y) ** 2;
    const quality = (a: number, b: number, c: number, area: number) => area / (dist2(a, b) + dist2(b, c) + dist2(c, a));
    const longest = (maxEdge * (1 + 1e-10)) ** 2;
    for (let sweep = 0; sweep < 8; sweep++) {
        const seen = new Map<number, { triangle: number; opposite: number }>();
        const changed = new Set<number>();
        for (let i = 0; i < indices.length; i += 3) {
            for (let k = 0; k < 3; k++) {
                const a = indices[i + k], b = indices[i + (k + 1) % 3], d = indices[i + (k + 2) % 3];
                const key = edgeKey(a, b), prev = seen.get(key);
                if (!prev) { seen.set(key, { triangle: i, opposite: d }); continue; }
                if (changed.has(prev.triangle)) continue;
                const c = prev.opposite;
                if (dist2(c, d) > longest) continue;
                const area1 = cross(points[c], points[d], points[a]), area2 = cross(points[c], points[b], points[d]);
                if (area1 <= EPSILON_AREA || area2 <= EPSILON_AREA) continue;
                const old = Math.min(quality(b, a, c, cross(points[b], points[a], points[c])), quality(a, b, d, cross(points[a], points[b], points[d])));
                const next = Math.min(quality(c, d, a, area1), quality(c, b, d, area2));
                if (next <= old + 1e-9) continue;
                indices[prev.triangle] = c;
                indices[prev.triangle + 1] = d;
                indices[prev.triangle + 2] = a;
                indices[i] = c;
                indices[i + 1] = b;
                indices[i + 2] = d;
                changed.add(prev.triangle);
                changed.add(i);
                break;
            }
        }
        if (!changed.size) break;
    }
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

/** Check the Float32 triangles consumed by the solver and renderer after placement and grain rotation. */
function checkCookedFaces(panel: GarmentPanel, indices: number[], start: number, chart: Float32Array,
    material: Float32Array, positions: Float32Array): void {
    const normal = cross3(panel.placement.u, panel.placement.v);
    const minTwiceArea = 2e-14; // Solver requires a rest area above 1e-14 m².
    const charts = [chart, material];
    const restError = panel.id + ' has a triangle below simulation precision. Enlarge the narrow feature or reduce its chart offset.';
    const placementError = panel.id + ' has a placed triangle below simulation precision. Enlarge the narrow feature or reduce the placement offset.';
    for (let i = start; i < indices.length; i += 3) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        for (const uv of charts) {
            const area = (uv[2 * b] - uv[2 * a]) * (uv[2 * c + 1] - uv[2 * a + 1])
                - (uv[2 * c] - uv[2 * a]) * (uv[2 * b + 1] - uv[2 * a + 1]);
            check(area > minTwiceArea, restError);
        }
        const p = positions, aa = 3 * a, bb = 3 * b, cc = 3 * c;
        const bx = p[bb] - p[aa], by = p[bb + 1] - p[aa + 1], bz = p[bb + 2] - p[aa + 2];
        const cx = p[cc] - p[aa], cy = p[cc + 1] - p[aa + 1], cz = p[cc + 2] - p[aa + 2];
        const area = normal[0] * (by * cz - bz * cy) + normal[1] * (bz * cx - bx * cz) + normal[2] * (bx * cy - by * cx);
        check(area > minTwiceArea, placementError);
    }
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
        improveAngles(g.indices, points, pattern.edgeLength);
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
        checkCookedFaces(p, indices, indexStart, restUV, materialUV, positions);
        for (const pin of p.pins) pins.push(remap[g.source.get(pin)!]);
        panelRanges.push({ id: p.id, vertexStart, vertexCount: cursor - vertexStart, indexStart, indexCount: indices.length - indexStart,
            ...(p.layer ? { layer: p.layer } : {}) });
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

/** Place a copy on the next outward layer in 8 mm steps. Pins move with it; sewn spans stay on the source. */
export function duplicateGarmentPanel(pattern: GarmentPattern, panelId: string): GarmentPattern {
    const source = pattern.panels.find(p => p.id === panelId);
    check(source, 'Missing panel ' + panelId + '.');
    const panel = readPanel(source);
    panel.id = nextId(pattern.panels.map(p => p.id), panel.id);
    const suffix = ' (' + panel.id.slice(panel.id.lastIndexOf('-') + 1) + ')';
    panel.name = panel.name.slice(0, 128 - suffix.length) + suffix;
    const { origin, u, v } = panel.placement;
    const normal = unit3(cross3(u, v));
    let nextLayer = (panel.layer ?? 0) + 1;
    // Repeatedly duplicating the original should not put multiple copies exactly in the same place.
    for (let step = 1; step <= pattern.panels.length + 1; step++) {
        const candidate = mix3(origin, 1, normal, .008 * step);
        const occupied = pattern.panels.find(p => Math.hypot(p.placement.origin[0] - candidate[0],
            p.placement.origin[1] - candidate[1], p.placement.origin[2] - candidate[2]) < .004);
        if (!occupied) { panel.placement.origin = candidate; break; }
        nextLayer = Math.max(nextLayer, (occupied.layer ?? 0) + 1);
    }
    panel.layer = Math.min(nextLayer, GARMENT_LIMITS.maxLayer);
    return readGarmentPattern({ ...pattern, panels: [...pattern.panels, panel] });
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

/** Remove the panel and each incident seam as one edit. A garment retains at least one panel. */
export function removeGarmentPanel(pattern: GarmentPattern, panelId: string): GarmentPattern {
    const copy = readGarmentPattern(pattern);
    check(copy.panels.some(p => p.id === panelId), 'Missing panel ' + panelId + '.');
    check(copy.panels.length > 1, 'A garment needs at least one panel.');
    copy.panels = copy.panels.filter(p => p.id !== panelId);
    copy.seams = copy.seams.filter(s => s.a.panelId !== panelId && s.b.panelId !== panelId);
    return copy;
}

/** Replace the two incident edges by a new, open edge, clearing their stitches and any pin on the point. */
export function removeGarmentPoint(pattern: GarmentPattern, panelId: string, pointId: string): GarmentPattern {
    const copy = readGarmentPattern(pattern);
    const panel = copy.panels.find(p => p.id === panelId);
    check(panel && panel.boundary.some(p => p.id === pointId), 'Missing point ' + panelId + '/' + pointId + '.');
    check(panel.boundary.length > 3, 'A panel needs at least three boundary points.');
    panel.boundary = panel.boundary.filter(p => p.id !== pointId);
    panel.pins = panel.pins.filter(id => id !== pointId);
    const touches = (s: GarmentSeamSide) => s.panelId === panelId && (s.from === pointId || s.to === pointId);
    copy.seams = copy.seams.filter(s => !touches(s.a) && !touches(s.b));
    return readGarmentPattern(copy);
}

export type GarmentRotationAxis = 'u' | 'v' | 'normal';
function cross3(a: PatternVector3, b: PatternVector3): PatternVector3 {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function unit3(v: PatternVector3): PatternVector3 {
    const length = Math.hypot(...v);
    return [v[0] / length, v[1] / length, v[2] / length];
}
function mix3(a: PatternVector3, aScale: number, b: PatternVector3, bScale: number): PatternVector3 {
    return [a[0] * aScale + b[0] * bScale, a[1] * aScale + b[1] * bScale, a[2] * aScale + b[2] * bScale];
}

/** Rotate about the selected panel's local chart origin, retaining a right-handed orthonormal placement frame. */
export function rotateGarmentPanel(pattern: GarmentPattern, panelId: string, axis: GarmentRotationAxis, degrees: number): GarmentPattern {
    const copy = readGarmentPattern(pattern);
    const panel = copy.panels.find(p => p.id === panelId);
    check(panel, 'Missing panel ' + panelId + '.');
    check(axis === 'u' || axis === 'v' || axis === 'normal', 'Select a panel-local rotation axis.');
    check(Number.isFinite(degrees) && Math.abs(degrees) <= 360, 'Rotation must be between −360 and 360 degrees.');
    const u = unit3(panel.placement.u), normal = unit3(cross3(u, panel.placement.v)), v = cross3(normal, u);
    const radians = degrees * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
    let newU = u, newV = v;
    if (axis === 'u') newV = mix3(v, cosine, normal, sine);
    else if (axis === 'v') newU = mix3(u, cosine, normal, -sine);
    else {
        newU = mix3(u, cosine, v, sine);
        newV = mix3(v, cosine, u, -sine);
    }
    panel.placement.u = unit3(newU);
    panel.placement.v = unit3(cross3(unit3(cross3(newU, newV)), panel.placement.u));
    return copy;
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
