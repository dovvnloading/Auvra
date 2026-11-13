import { triangleStretch } from './lscm';
import { overlappingTriangles } from './overlap';
import { packIslands, type Island, type PackSettings, type Placement } from './pack';
import { unwrap, type UnwrapSettings } from './unwrap';
import { buildTopology, type Chart, type UvTopology } from './uvTopology';

/**
 * UV WORK OFF THE MAIN THREAD
 *
 * Unwrapping, packing and looking for overlapping triangles can take seconds on a large model; they run
 * in a worker so the editor keeps answering. The worker builds the surface's topology once from its
 * positions and triangles, then takes requests by number and answers each with the same number:
 *   setup    positions and triangles: the topology is built;
 *   unwrap   settings, seams to keep (or the exact seams to cut): seams, charts and flat islands;
 *   pack     islands and settings: each island's placement;
 *   measure  corner coordinates and charts: each triangle's stretch and the layout's figures.
 * Where workers are not available (tests, some hosts) the same handler runs on the main thread, a turn
 * later, so the answers are the same either way.
 */

export interface UvStats {
    islands: number;
    /** Share of the pictures (one per UDIM tile) the islands cover. */
    coverage: number;
    /** UDIM tiles the layout uses, a picture each. */
    tiles: number;
    /** Pixels per model unit at the set's picture size: lowest, mean, highest over islands. */
    density: { low: number; mean: number; high: number };
    stretch: { mean: number; worst: number };
    /** Triangles facing against their island, or lying over other triangles: places that share texels. */
    folded: number;
}

export interface LayoutMeasure { triangleStretch: Float32Array; stats: UvStats }

/** Corner numbers 0, 1, 2… for layouts kept two values per corner, in triangle order. */
let inOrder = new Uint32Array(0);
const cornersInOrder = (count: number): Uint32Array => {
    if (inOrder.length < count) inOrder = Uint32Array.from({ length: count }, (_, i) => i);
    return inOrder;
};

/**
 * Stretch per triangle (0 kept shape … 1 badly stretched; -1 folded or overlapping) and the layout's
 * figures, for corner coordinates (two per corner, triangle order) cut into `chartFaces`. `tiles` is how
 * many UDIM tiles (pictures) it uses and `size` the pictures' size. Without `overlaps`, triangles lying
 * over others are not looked for (the slow part).
 */
export const measureLayout = (topology: UvTopology, cornerUv: Float32Array, chartFaces: ReadonlyArray<ArrayLike<number>>, tiles: number, size: number, overlaps: boolean): LayoutMeasure => {
    const { positions, faces, areas, faceCount } = topology;
    const stretch = new Float32Array(faceCount);
    const local = new Float64Array(6);
    let folded = 0;
    let weighted = 0;
    let worst = 1;
    let surface = 0;
    let flat = 0;
    // An island laid out mirrored as a whole (glTF counts texture rows from the top) is fine: a triangle is
    // folded only when it faces against the rest of its own island.
    const signedArea = (f: number) => ((cornerUv[f * 6 + 2] - cornerUv[f * 6]) * (cornerUv[f * 6 + 5] - cornerUv[f * 6 + 1]) - (cornerUv[f * 6 + 4] - cornerUv[f * 6]) * (cornerUv[f * 6 + 3] - cornerUv[f * 6 + 1])) / 2;
    const orientation = new Float32Array(faceCount).fill(1);
    for (const chart of chartFaces) {
        let sum = 0;
        for (let i = 0; i < chart.length; i++) sum += signedArea(chart[i]);
        const sign = sum < 0 ? -1 : 1;
        for (let i = 0; i < chart.length; i++) {
            const face = chart[i];
            if (typeof face !== 'number' || !Number.isInteger(face) || face < 0 || face >= faceCount) {
                throw new Error('The UV chart contains an invalid face index.');
            }
            orientation[face] = sign;
        }
    }
    for (let f = 0; f < faceCount; f++) {
        local.set(cornerUv.subarray(f * 6, f * 6 + 6));
        const signed = signedArea(f) * orientation[f];
        flat += Math.abs(signed);
        surface += areas[f];
        if (signed < 0) { folded++; stretch[f] = -1; continue; }
        if (orientation[f] < 0) { local[0] = -local[0]; local[2] = -local[2]; local[4] = -local[4]; }
        const s = triangleStretch(positions, faces, f, local, 0, 1, 2);
        stretch[f] = Math.min(1, (s.ratio - 1) / 2);
        worst = Math.max(worst, s.ratio);
        // A sliver squashed to nothing would swamp the mean: count it as badly stretched, no worse.
        weighted += Math.min(s.ratio, 20) * areas[f];
    }
    // An island wrapped round onto itself, or islands laid on each other: those places share texels
    // (overlaps shallower than a quarter of a texel are rounding).
    for (const f of overlaps ? overlappingTriangles(cornerUv, cornersInOrder(faceCount * 3), faceCount, false, 0.25 / size) : []) {
        if (stretch[f] === -1) continue;
        stretch[f] = -1;
        folded++;
    }
    let low = Infinity, high = 0, count = 0;
    for (const chart of chartFaces) {
        let a3 = 0, a2 = 0;
        for (let i = 0; i < chart.length; i++) {
            const f = chart[i];
            a3 += areas[f];
            a2 += Math.abs(signedArea(f));
        }
        const density = a3 > 0 ? Math.sqrt(a2 / a3) * size : 0;
        if (density <= 0) continue;
        low = Math.min(low, density);
        high = Math.max(high, density);
        count++;
    }
    const mean = count ? Math.sqrt(flat / Math.max(surface, 1e-12)) * size : 0;
    return {
        triangleStretch: stretch,
        stats: {
            islands: chartFaces.length,
            coverage: Math.min(1, flat / Math.max(1, tiles)),
            tiles,
            density: { low: count ? low : 0, mean, high },
            stretch: { mean: surface > 0 ? weighted / surface : 1, worst },
            folded,
        },
    };
};

/** A chart as it travels between threads: plain typed arrays. */
export interface ChartData { faces: Uint32Array; vertexWeld: Uint32Array; corners: Uint32Array }

export const chartToData = (chart: Chart): ChartData => ({ faces: Uint32Array.from(chart.faces), vertexWeld: Uint32Array.from(chart.vertexWeld), corners: chart.corners });

export const chartFromData = (data: ChartData): Chart => ({ faces: Array.from(data.faces), vertexWeld: Array.from(data.vertexWeld), corners: data.corners });

/** An island as it travels between threads. */
export interface IslandData { uv: Float64Array; triangles: Uint32Array; densityScale: number; keepAt: Float64Array | null }

export type UvRequest =
    | { id: number; kind: 'setup'; positions: Float32Array; indices: Uint32Array }
    /** Seam keys are whole numbers past 2³² on large models: they travel as doubles. */
    | { id: number; kind: 'unwrap'; settings: UnwrapSettings; keep: Float64Array; seams: Float64Array | null }
    | { id: number; kind: 'pack'; islands: IslandData[]; settings: PackSettings }
    | { id: number; kind: 'measure'; cornerUv: Float32Array; chartFaces: Uint32Array[]; tiles: number; size: number };

export type UvResponse =
    | { id: number; ok: true; kind: 'setup' }
    | { id: number; ok: true; kind: 'unwrap'; seams: Float64Array; charts: ChartData[]; flat: Float64Array[] }
    | { id: number; ok: true; kind: 'pack'; placements: Array<{ uv: Float64Array; tile: number }> }
    | { id: number; ok: true; kind: 'measure'; triangleStretch: Float32Array; stats: UvStats }
    | { id: number; ok: false; error: string };

/** What the worker keeps between requests: the surface's topology. */
export interface UvWorkState { topology: UvTopology | null }

/** Answers one request (in the worker, or on the main thread), with the buffers it may hand over. */
export const handleUvRequest = (state: UvWorkState, request: UvRequest): { response: UvResponse; transfer: ArrayBuffer[] } => {
    try {
        if (request.kind === 'setup') {
            state.topology = buildTopology(request.positions, request.indices);
            return { response: { id: request.id, ok: true, kind: 'setup' }, transfer: [] };
        }
        const topology = state.topology;
        if (!topology) throw new Error('The surface was not given to the UV worker.');
        if (request.kind === 'unwrap') {
            const result = unwrap(topology, request.settings, new Set(request.keep), request.seams ? new Set(request.seams) : undefined);
            const charts = result.charts.map(chartToData);
            const flat = result.flat.map((piece) => piece.uv);
            const seams = Float64Array.from(result.seams);
            return {
                response: { id: request.id, ok: true, kind: 'unwrap', seams, charts, flat },
                transfer: [seams.buffer, ...charts.flatMap((chart) => [chart.faces.buffer, chart.vertexWeld.buffer]), ...flat.map((uv) => uv.buffer as ArrayBuffer)],
            };
        }
        if (request.kind === 'pack') {
            const islands: Island[] = request.islands.map((island) => ({
                uv: island.uv,
                triangles: island.triangles,
                area3d: 0,
                densityScale: island.densityScale,
                ...(island.keepAt ? { keepAt: island.keepAt } : {}),
            }));
            const placements = packIslands(islands, request.settings).map((placement) => ({ uv: placement.uv, tile: placement.tile }));
            return { response: { id: request.id, ok: true, kind: 'pack', placements }, transfer: placements.map((placement) => placement.uv.buffer as ArrayBuffer) };
        }
        const measured = measureLayout(topology, request.cornerUv, request.chartFaces, request.tiles, request.size, true);
        return { response: { id: request.id, ok: true, kind: 'measure', ...measured }, transfer: [measured.triangleStretch.buffer] };
    } catch (error) {
        return { response: { id: request.id, ok: false, error: error instanceof Error ? error.message : 'The UV work failed.' }, transfer: [] };
    }
};

/** The part of a worker the client uses (a real one, or a stand-in in tests). */
export interface WorkerLike {
    postMessage(message: unknown, transfer?: Transferable[]): void;
    onmessage: ((event: MessageEvent) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    terminate(): void;
}

const makeWorker = (): WorkerLike | null => {
    if (typeof Worker !== 'function') return null;
    try {
        return new Worker(new URL('./uvWork.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
    } catch {
        return null;
    }
};

/** A request without its number (the client numbers them). */
type Unnumbered<T> = T extends { id: number } ? Omit<T, 'id'> : never;

/**
 * Asks for UV work on one surface. Requests run one after another; answers come back to the promise
 * that asked. Without a worker, the same work runs on the main thread a turn later.
 */
export class UvWorkClient {
    private worker: WorkerLike | null;
    private readonly local: UvWorkState = { topology: null };
    private readonly pending = new Map<number, { resolve: (response: UvResponse) => void; reject: (error: Error) => void }>();
    private next = 1;
    private ready: Promise<UvResponse>;

    constructor(private readonly positions: Float32Array, private readonly indices: Uint32Array, create: () => WorkerLike | null = makeWorker) {
        this.worker = create();
        if (this.worker) {
            this.worker.onmessage = (event) => this.answer(event.data as UvResponse);
            // A worker that fails gives up every request waiting on it; later work runs on the main thread.
            this.worker.onerror = (event) => {
                const error = new Error(event.message || 'The UV worker stopped.');
                for (const waiting of this.pending.values()) waiting.reject(error);
                this.pending.clear();
                this.worker?.terminate();
                this.worker = null;
                this.ready = this.setup();
            };
        }
        this.ready = this.setup();
    }

    /** The surface handed to whoever does the work (copies: the surface's own arrays stay with the main thread). */
    private setup(): Promise<UvResponse> {
        const ready = this.send({ kind: 'setup', positions: Float32Array.from(this.positions), indices: Uint32Array.from(this.indices) }, true);
        // Waited on by every request; a failure shows there.
        ready.catch(() => undefined);
        return ready;
    }

    /** Whether the work runs in a worker (else on the main thread). */
    get offThread(): boolean {
        return Boolean(this.worker);
    }

    private answer(response: UvResponse): void {
        const waiting = this.pending.get(response.id);
        if (!waiting) return;
        this.pending.delete(response.id);
        if (response.ok) waiting.resolve(response);
        else waiting.reject(new Error(response.error));
    }

    private send(request: Unnumbered<UvRequest>, handOver = false): Promise<UvResponse> {
        const id = this.next++;
        const numbered = { ...request, id } as UvRequest;
        return new Promise<UvResponse>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            if (this.worker) {
                const transfer = handOver && numbered.kind === 'setup' ? [numbered.positions.buffer, numbered.indices.buffer] : [];
                this.worker.postMessage(numbered, transfer as Transferable[]);
                return;
            }
            // A turn later, so whatever asked can show it is busy first.
            setTimeout(() => this.answer(handleUvRequest(this.local, numbered).response), 0);
        });
    }

    async unwrap(settings: UnwrapSettings, keep: ReadonlySet<number>, seams?: ReadonlySet<number>): Promise<{ seams: Set<number>; charts: Chart[]; flat: Array<{ uv: Float64Array }> }> {
        await this.ready;
        const response = await this.send({ kind: 'unwrap', settings, keep: Float64Array.from(keep), seams: seams ? Float64Array.from(seams) : null });
        if (response.ok && response.kind === 'unwrap') return { seams: new Set(response.seams), charts: response.charts.map(chartFromData), flat: response.flat.map((uv) => ({ uv })) };
        throw new Error('The UV worker gave the wrong answer.');
    }

    async pack(islands: readonly Island[], settings: PackSettings): Promise<Placement[]> {
        await this.ready;
        const data: IslandData[] = islands.map((island) => ({ uv: island.uv, triangles: Uint32Array.from(island.triangles), densityScale: island.densityScale ?? 1, keepAt: island.keepAt ?? null }));
        const response = await this.send({ kind: 'pack', islands: data, settings });
        if (response.ok && response.kind === 'pack') return response.placements;
        throw new Error('The UV worker gave the wrong answer.');
    }

    async measure(cornerUv: Float32Array, charts: readonly Chart[], tiles: number, size: number): Promise<LayoutMeasure> {
        await this.ready;
        const response = await this.send({ kind: 'measure', cornerUv: Float32Array.from(cornerUv), chartFaces: charts.map((chart) => Uint32Array.from(chart.faces)), tiles, size });
        if (response.ok && response.kind === 'measure') return { triangleStretch: response.triangleStretch, stats: response.stats };
        throw new Error('The UV worker gave the wrong answer.');
    }

    dispose(): void {
        this.worker?.terminate();
        const error = new Error('The UV work was stopped.');
        for (const waiting of this.pending.values()) waiting.reject(error);
        this.pending.clear();
    }
}
