import * as THREE from 'three';
import { frontendDiagnostics } from '../../../diagnostics/runtime';
import { ownMaps } from '../../../runtime/materials/graphMaterial';
import { projectService } from '../../../utils/projectService';
import type { GpuImage } from '../../../texturing/gpu/textureGpu';
import { triangleStretch } from '../../../texturing/uv/lscm';
import { overlappingTriangles } from '../../../texturing/uv/overlap';
import { DEFAULT_PACK, packIslands, type Island, type PackSettings, type Placement } from '../../../texturing/uv/pack';
import { newTriangleTiles, transferPicture } from '../../../texturing/uv/transfer';
import { DEFAULT_UNWRAP, unwrap, type UnwrapSettings } from '../../../texturing/uv/unwrap';
import { applyLayout, buildLayout, decodeLayout, encodeLayout, restoreLayout, type UvLayoutFile } from '../../../texturing/uv/uvLayout';
import { buildCharts, buildTopology, chartCoordinates, edgeKey, existingSeams, type Chart, type UvTopology } from '../../../texturing/uv/uvTopology';
import { BEFORE, GpuResetError, pictureKey, pictureOwner, pictureOwners, picturePrecision } from '../../../texturing/paint/paintStack';
import { BLEND_FOR, PAINT_CHANNELS, type FillSource, type PaintChannel, type PaintDocument, type PaintLayer, type TilePictures } from '../../../texturing/paint/paintTypes';
import type { PaintSession } from './paintSession';

/**
 * UV EDITING FOR A TEXTURE SET
 *
 * Works on a proposal beside the surface's current layout: seams (read from the current layout, placed
 * automatically, or clicked edge by edge), flattened charts, and their packing (moved and turned by
 * hand if wanted). Nothing changes on the model until the proposal is used; then the meshes are split
 * along the new seams and given the new coordinates, saved with the project, and everything already
 * drawn on the surface (its own pictures and every painted layer and mask) is carried over so it looks
 * the same.
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

/** Corner numbers 0, 1, 2… for layouts kept two values per corner, in triangle order. */
let inOrder = new Uint32Array(0);
const cornersInOrder = (count: number): Uint32Array => {
    if (inOrder.length < count) inOrder = Uint32Array.from({ length: count }, (_, i) => i);
    return inOrder;
};

export interface UvProposal {
    charts: Chart[];
    placements: Placement[];
    /** Two per corner, triangle order. */
    cornerUv: Float32Array;
    /** Corners sharing a vertex share a key. */
    cornerKey: Uint32Array;
    /** Per triangle: 0 kept shape … 1 badly stretched; negative turned over. */
    triangleStretch: Float32Array;
    stats: UvStats;
}

export interface UvSessionHost {
    saveLayout: (modelId: string, bytes: Uint8Array | null, meshes: number) => Promise<void>;
    layoutReference: () => { assetId: string } | undefined;
}

/** A UV editing state, kept for undo: seams, flattened islands, the proposal and its islands' settings. */
interface UvStep {
    label: string;
    seams: Set<number>;
    flat: Array<{ uv: Float64Array }>;
    proposal: { charts: Chart[]; placements: Placement[] } | null;
    keepsShapes: boolean;
    locked: Set<number>;
    density: Map<number, number>;
    selected: Set<number>;
}

/** UV edits undo can go back over. */
const UV_HISTORY_LIMIT = 60;

export class UvSession {
    readonly topology: UvTopology;
    seams: Set<number>;
    proposal: UvProposal | null = null;
    unwrapSettings: UnwrapSettings = { ...DEFAULT_UNWRAP };
    packSettings: PackSettings = { ...DEFAULT_PACK };
    selected = new Set<number>();
    /** Islands of the proposal (by index) that packing again leaves where they are. */
    locked = new Set<number>();
    /** Islands of the proposal made bigger or smaller by hand: their size against the rest, kept by packing again. */
    density = new Map<number, number>();
    /** Measures a dragged layout again for overlaps once the islands settle. */
    private settleTimer: ReturnType<typeof setTimeout> | null = null;
    busy: string | null = null;
    status: string | null = null;
    /**
     * True once a new layout is used: the model's own pictures no longer fit it, so the set (which carried
     * them over) goes on the model as it reopens.
     */
    putOnWhenOpen = false;
    version = 0;
    private flat: Array<{ uv: Float64Array }> = [];
    private readonly listeners = new Set<() => void>();
    private undoSteps: UvStep[] = [];
    private redoSteps: UvStep[] = [];
    readonly current: UvStats;
    /** The current layout's seams, where its coordinates are cut. */
    private readonly currentSeams: Set<number>;
    /** Stretch per triangle of the current layout (0 kept shape … 1 badly stretched; −1 folded or overlapping). */
    readonly currentStretch: Float32Array;
    /** Whether the proposal is the current islands packed as they are (else an unwrap). */
    proposalKeepsShapes = false;

    constructor(readonly paint: PaintSession, readonly host: UvSessionHost) {
        const part = paint.part;
        this.topology = buildTopology(part.positions, part.indices);
        this.seams = existingSeams(this.topology, part.indices, part.uvs);
        this.currentSeams = new Set(this.seams);
        this.packSettings.resolution = paint.stack.size;
        // Packing again keeps the grid of UDIM tiles the surface is laid over now.
        this.packSettings.tilesX = Math.max(...part.tiles.map((tile) => (tile - 1001) % 10)) + 1;
        this.packSettings.tilesY = Math.max(...part.tiles.map((tile) => Math.floor((tile - 1001) / 10))) + 1;
        const measured = this.measure(Float32Array.from({ length: part.indices.length * 2 }, (_, i) => part.uvs[part.indices[i >> 1] * 2 + (i & 1)]), buildCharts(this.topology, this.seams), part.tiles.length);
        this.current = measured.stats;
        this.currentStretch = measured.triangleStretch;
    }

    // -----------------------------------------------------------------------
    // Undo
    // -----------------------------------------------------------------------

    private snapshot(label: string): UvStep {
        return {
            label,
            seams: new Set(this.seams),
            flat: this.flat,
            proposal: this.proposal ? { charts: this.proposal.charts, placements: this.proposal.placements.map((placement) => ({ uv: Float64Array.from(placement.uv), tile: placement.tile })) } : null,
            keepsShapes: this.proposalKeepsShapes,
            locked: new Set(this.locked),
            density: new Map(this.density),
            selected: new Set(this.selected),
        };
    }

    /** Keeps the state as it is before an edit called `label`, for undo. */
    remember(label: string): void {
        this.keep(this.snapshot(label));
    }

    private keep(step: UvStep): void {
        this.undoSteps.push(step);
        if (this.undoSteps.length > UV_HISTORY_LIMIT) this.undoSteps.shift();
        this.redoSteps = [];
    }

    private restore(step: UvStep): void {
        this.seams = new Set(step.seams);
        this.flat = step.flat;
        this.proposalKeepsShapes = step.keepsShapes;
        this.locked = new Set(step.locked);
        this.density = new Map(step.density);
        if (step.proposal) {
            this.setProposal(step.proposal.charts, step.proposal.placements.map((placement) => ({ uv: Float64Array.from(placement.uv), tile: placement.tile })), { keepSelection: true });
        } else {
            this.proposal = null;
        }
        this.selected = new Set(step.selected);
        this.emit();
    }

    get canUndo(): boolean { return this.undoSteps.length > 0 && !this.busy; }
    get canRedo(): boolean { return this.redoSteps.length > 0 && !this.busy; }
    get undoLabel(): string | null { return this.undoSteps[this.undoSteps.length - 1]?.label ?? null; }
    get redoLabel(): string | null { return this.redoSteps[this.redoSteps.length - 1]?.label ?? null; }

    undo(): void {
        const step = this.undoSteps.pop();
        if (!step || this.busy) { if (step) this.undoSteps.push(step); return; }
        this.redoSteps.push(this.snapshot(step.label));
        this.restore(step);
    }

    redo(): void {
        const step = this.redoSteps.pop();
        if (!step || this.busy) { if (step) this.redoSteps.push(step); return; }
        this.undoSteps.push(this.snapshot(step.label));
        this.restore(step);
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getVersion = (): number => this.version;

    emit(): void {
        this.version++;
        for (const listener of this.listeners) listener();
    }

    /** Toggles a seam on the edge of `triangle` nearest `point` (model space). */
    toggleSeam(triangle: number, point: THREE.Vector3, remove: boolean): void {
        const { faces, positions, vertexCount } = this.topology;
        let best = -1;
        let bestDistance = Infinity;
        for (let k = 0; k < 3; k++) {
            const a = faces[triangle * 3 + k];
            const b = faces[triangle * 3 + ((k + 1) % 3)];
            const pa = new THREE.Vector3(positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]);
            const pb = new THREE.Vector3(positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]);
            const distance = new THREE.Line3(pa, pb).closestPointToPoint(point, true, new THREE.Vector3()).distanceTo(point);
            if (distance < bestDistance) { bestDistance = distance; best = edgeKey(a, b, vertexCount); }
        }
        if (best < 0) return;
        if (remove && !this.seams.has(best)) return;
        this.remember(remove || this.seams.has(best) ? 'Clear seam' : 'Mark seam');
        if (remove) this.seams.delete(best);
        else if (this.seams.has(best)) this.seams.delete(best);
        else this.seams.add(best);
        this.emit();
    }

    /** Line segments (model space) along every seam, for drawing. */
    seamLines(): Float32Array {
        const { positions, vertexCount } = this.topology;
        const out = new Float32Array(this.seams.size * 6);
        let at = 0;
        for (const key of this.seams) {
            const a = Math.floor(key / vertexCount);
            const b = key % vertexCount;
            out.set([positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2], positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]], at);
            at += 6;
        }
        return out;
    }

    /** Places seams automatically (keeping the ones marked by hand when asked) and flattens and packs. */
    unwrapAuto(keepSeams: boolean): void {
        this.run('Unwrapping', () => {
            const result = unwrap(this.topology, this.unwrapSettings, keepSeams ? this.seams : new Set());
            this.seams = result.seams;
            this.flat = result.flat;
            this.startIslands(false);
            this.layOut(result.charts);
        }, keepSeams ? 'Unwrap, keeping seams' : 'Unwrap afresh');
    }

    /** Flattens along exactly the seams there are now, and packs. */
    unwrapWithSeams(): void {
        this.run('Unwrapping', () => {
            const result = unwrap(this.topology, this.unwrapSettings, new Set(), this.seams);
            this.seams = result.seams;
            this.flat = result.flat;
            this.startIslands(false);
            this.layOut(result.charts);
        }, 'Unwrap these seams');
    }

    /**
     * Packs the proposal again with the pack settings (islands kept in place stay, islands made bigger or
     * smaller keep their size against the rest), or, without one, the current layout's islands as they are.
     */
    repack(): void {
        if (!this.proposal) {
            this.packCurrent();
            return;
        }
        this.run('Packing', () => this.layOut(this.proposal!.charts), 'Pack again');
    }

    /**
     * Packs the current layout's islands as they are: each keeps its shape, its seams and its size against
     * the others, and is only moved and turned (no island is flattened again, and no seam is added).
     */
    packCurrent(): void {
        this.run('Packing', () => {
            const charts = buildCharts(this.topology, this.currentSeams);
            this.seams = new Set(this.currentSeams);
            this.flat = chartCoordinates(charts, this.paint.part.indices, this.paint.part.uvs).map((uv) => ({ uv }));
            this.startIslands(true);
            this.layOut(charts);
        }, 'Pack the current islands');
    }

    /** New islands: none kept in place or resized yet. */
    private startIslands(keepsShapes: boolean): void {
        this.locked = new Set();
        this.density = new Map();
        this.proposalKeepsShapes = keepsShapes;
    }

    private run(label: string, work: () => void, step?: string): void {
        this.busy = label;
        this.emit();
        // Let the panel show what is happening before the work holds the page.
        setTimeout(() => {
            // Kept for undo only once the work has changed something.
            const before = step ? this.snapshot(step) : null;
            try {
                work();
                if (before) this.keep(before);
                this.status = null;
            } catch (error) {
                frontendDiagnostics.failure('uv_unwrap_failed', error);
                this.status = error instanceof Error ? error.message : 'The surface could not be unwrapped.';
                // Whatever the work changed before it failed is put back.
                if (before) this.restore(before);
            } finally {
                this.busy = null;
                this.emit();
            }
        }, 30);
    }

    /**
     * Packs `charts` into a new proposal. Packing the same islands again keeps those kept in place where
     * they are, and gives islands made bigger or smaller their size against the rest.
     */
    private layOut(charts: Chart[]): void {
        const kept = this.proposal?.charts === charts ? this.proposal.placements : null;
        const islands: Island[] = charts.map((chart, i) => ({
            uv: this.flat[i].uv,
            triangles: chart.corners,
            area3d: 0,
            densityScale: this.density.get(i) ?? 1,
            ...(kept && this.locked.has(i) ? { keepAt: kept[i].uv } : {}),
        }));
        const placements = packIslands(islands, this.packSettings);
        this.setProposal(charts, placements, { keepSelection: Boolean(kept) });
    }

    /**
     * Makes `placements` the proposal and measures it. Moving islands keeps the selection; while they are
     * dragged (`quick`), overlaps are looked for once they settle, so dragging stays smooth.
     */
    private setProposal(charts: Chart[], placements: Placement[], edit: { keepSelection?: boolean; quick?: boolean } = {}): void {
        const count = this.paint.part.indices.length;
        const cornerUv = new Float32Array(count * 2);
        const cornerKey = new Uint32Array(count);
        // Charts' corners never share a vertex across charts: each chart's corners get keys of their own.
        let firstKey = 0;
        charts.forEach((chart, c) => {
            chart.faces.forEach((face, i) => {
                for (let k = 0; k < 3; k++) {
                    const corner = chart.corners[i * 3 + k];
                    cornerUv[(face * 3 + k) * 2] = placements[c].uv[corner * 2];
                    cornerUv[(face * 3 + k) * 2 + 1] = placements[c].uv[corner * 2 + 1];
                    cornerKey[face * 3 + k] = firstKey + corner;
                }
            });
            firstKey += chart.vertexWeld.length;
        });
        const measured = this.measure(cornerUv, charts, new Set(newTriangleTiles(cornerUv)).size, !edit.quick);
        this.proposal = { charts, placements, cornerUv, cornerKey, triangleStretch: measured.triangleStretch, stats: measured.stats };
        if (!edit.keepSelection) this.selected.clear();
        if (this.settleTimer) clearTimeout(this.settleTimer);
        this.settleTimer = edit.quick ? setTimeout(() => {
            this.settleTimer = null;
            const proposal = this.proposal;
            if (!proposal) return;
            const settled = this.measure(proposal.cornerUv, proposal.charts, proposal.stats.tiles, true);
            this.proposal = { ...proposal, triangleStretch: settled.triangleStretch, stats: settled.stats };
            this.emit();
        }, 200) : null;
    }

    /**
     * Stretch per triangle and the layout's figures; `tiles` is how many UDIM tiles (pictures) it uses.
     * Without `overlaps`, triangles lying over others are not looked for (while islands are dragged).
     */
    private measure(cornerUv: Float32Array, charts: Chart[], tiles: number, overlaps = true): { triangleStretch: Float32Array; stats: UvStats } {
        const { positions, faces, areas, faceCount } = this.topology;
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
        for (const chart of charts) {
            let sum = 0;
            for (const f of chart.faces) sum += signedArea(f);
            const sign = sum < 0 ? -1 : 1;
            for (const f of chart.faces) orientation[f] = sign;
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
        for (const f of overlaps ? overlappingTriangles(cornerUv, cornersInOrder(faceCount * 3), faceCount, false, 0.25 / this.paint.stack.size) : []) {
            if (stretch[f] === -1) continue;
            stretch[f] = -1;
            folded++;
        }
        const size = this.paint.stack.size;
        const densities = charts.map((chart) => {
            let a3 = 0, a2 = 0;
            for (const f of chart.faces) {
                a3 += areas[f];
                a2 += Math.abs(((cornerUv[f * 6 + 2] - cornerUv[f * 6]) * (cornerUv[f * 6 + 5] - cornerUv[f * 6 + 1]) - (cornerUv[f * 6 + 4] - cornerUv[f * 6]) * (cornerUv[f * 6 + 3] - cornerUv[f * 6 + 1])) / 2);
            }
            return a3 > 0 ? Math.sqrt(a2 / a3) * size : 0;
        }).filter((value) => value > 0);
        const mean = densities.length ? Math.sqrt(flat / Math.max(surface, 1e-12)) * size : 0;
        return {
            triangleStretch: stretch,
            stats: {
                islands: charts.length,
                coverage: Math.min(1, flat / Math.max(1, tiles)),
                tiles,
                density: { low: densities.length ? Math.min(...densities) : 0, mean, high: densities.length ? Math.max(...densities) : 0 },
                stretch: { mean: surface > 0 ? weighted / surface : 1, worst },
                folded,
            },
        };
    }

    /** Moves selected islands by (du, dv). A drag remembers the layout once, as it starts (see remember). */
    moveSelected(du: number, dv: number): void {
        if (!this.proposal) return;
        for (const i of this.selected) {
            const uv = this.proposal.placements[i].uv;
            for (let k = 0; k < uv.length; k += 2) { uv[k] += du; uv[k + 1] += dv; }
        }
        this.setProposal(this.proposal.charts, this.proposal.placements, { keepSelection: true, quick: true });
        this.emit();
    }

    /**
     * Turns or scales selected islands about their own middles. A scale is kept as the island's size
     * against the rest, so packing again keeps it.
     */
    transformSelected(angle: number, scale: number): void {
        if (!this.proposal || !this.selected.size) return;
        this.remember(scale !== 1 ? (scale > 1 ? 'Make islands bigger' : 'Make islands smaller') : 'Turn islands');
        for (const i of this.selected) {
            if (scale !== 1) this.density.set(i, (this.density.get(i) ?? 1) * scale);
            const uv = this.proposal.placements[i].uv;
            let cx = 0, cy = 0;
            for (let k = 0; k < uv.length; k += 2) { cx += uv[k]; cy += uv[k + 1]; }
            cx /= uv.length / 2; cy /= uv.length / 2;
            const c = Math.cos(angle) * scale, s = Math.sin(angle) * scale;
            for (let k = 0; k < uv.length; k += 2) {
                const x = uv[k] - cx, y = uv[k + 1] - cy;
                uv[k] = cx + x * c - y * s;
                uv[k + 1] = cy + x * s + y * c;
            }
        }
        this.setProposal(this.proposal.charts, this.proposal.placements, { keepSelection: true });
        this.emit();
    }

    /** Whether every selected island is kept in place. */
    get selectionLocked(): boolean {
        return this.selected.size > 0 && [...this.selected].every((i) => this.locked.has(i));
    }

    /** Keeps the selected islands in place when packing again, or lets packing move them again. */
    toggleLockSelected(): void {
        if (!this.proposal || !this.selected.size) return;
        const lock = !this.selectionLocked;
        this.remember(lock ? 'Keep islands in place' : 'Let islands move');
        for (const i of this.selected) {
            if (lock) this.locked.add(i);
            else this.locked.delete(i);
        }
        this.emit();
    }

    /** The island under a texture coordinate, if any. */
    islandAt(u: number, v: number): number {
        if (!this.proposal) return -1;
        const { charts, placements } = this.proposal;
        for (let c = 0; c < charts.length; c++) {
            const uv = placements[c].uv;
            const corners = charts[c].corners;
            for (let t = 0; t < corners.length; t += 3) {
                const ax = uv[corners[t] * 2], ay = uv[corners[t] * 2 + 1];
                const bx = uv[corners[t + 1] * 2], by = uv[corners[t + 1] * 2 + 1];
                const cx = uv[corners[t + 2] * 2], cy = uv[corners[t + 2] * 2 + 1];
                const d1 = (u - bx) * (ay - by) - (ax - bx) * (v - by);
                const d2 = (u - cx) * (by - cy) - (bx - cx) * (v - cy);
                const d3 = (u - ax) * (cy - ay) - (cx - ax) * (v - ay);
                const negative = d1 < 0 || d2 < 0 || d3 < 0;
                const positive = d1 > 0 || d2 > 0 || d3 > 0;
                if (!(negative && positive)) return c;
            }
        }
        return -1;
    }

    discard(): void {
        if (!this.proposal) return;
        this.remember('Discard the new layout');
        this.proposal = null;
        this.selected.clear();
        this.emit();
    }

    /**
     * Uses the proposal, all or nothing: every picture drawn on the surface is carried over to it as new
     * pictures kept apart from the set's own, then the meshes are split and the layout saved with the model,
     * then the set's document naming the new pictures is saved. Until that last step the set's own pictures
     * and document are untouched (and nothing is saved from them), so a failure anywhere puts the model's
     * meshes and saved layout back and leaves the set as it was. Painting reopens on the new layout.
     */
    async apply(): Promise<void> {
        const proposal = this.proposal;
        if (!proposal || this.busy) return;
        const paint = this.paint;
        if (!paint.usable) {
            this.status = new GpuResetError().message;
            this.emit();
            return;
        }
        const gpu = paint.gpu;
        const stack = paint.stack;
        const part = paint.part;
        const object = paint.target.object;
        const size = stack.size;
        this.busy = 'Saving the painting first';
        this.emit();
        // What the set holds is kept first; nothing more is painted or saved until the switch is done or undone.
        await paint.save();
        paint.lock('The new UV layout is being put on: painting waits until it is done.');
        let laidOut: { previous: UvLayoutFile | null; layout: UvLayoutFile; saved: boolean } | null = null;
        try {
            this.busy = 'Carrying the pictures over';
            this.emit();
            const corner = proposal.cornerUv;
            // The UDIM tiles the new layout uses (one for an ordinary layout): a picture each.
            const newTiles = [...new Set(newTriangleTiles(corner))].sort((a, b) => a - b);
            const spread = newTiles.length > 1;
            /** The new layout's pictures, kept as assets: by picture key, then tile. */
            const carried = new Map<string, TilePictures>();
            const keep = async (key: string, tile: number, image: GpuImage) => {
                const assetId = await stack.storeImage(image);
                carried.set(key, { ...(carried.get(key) ?? {}), [String(tile)]: { assetId } });
            };
            // 1. Every picture of the set (painted layers, masks, what it wore before once carried): each tile of
            // the new layout drawn from whole copies of the current tiles' pictures. Pictures of layers deleted
            // earlier are kept only for undo, which the set reopens without: they are not carried.
            const used = pictureOwners([stack.document]);
            for (const [key, byTile] of [...stack.pictures]) {
                if (!used.has(pictureOwner(key))) continue;
                const wholes = new Map<number, GpuImage>();
                try {
                    for (const tile of byTile.keys()) {
                        const whole = stack.denseCopy(key, tile);
                        if (whole) wholes.set(tile, whole);
                    }
                    for (const tile of newTiles) {
                        const image = await transferPicture(gpu, part, corner, (from) => wholes.get(from) ?? null, size, { normalMap: key.endsWith(':normal'), tile, precision: picturePrecision(key), coverage: true });
                        try {
                            await keep(key, tile, image);
                        } finally {
                            gpu.release(image);
                        }
                    }
                } finally {
                    for (const whole of wholes.values()) gpu.release(whole);
                }
            }
            // 2. The model's own pictures, which "what it wore before" fills read, fit only the layout it came
            // with: the first new layout carries them into the set, a picture per tile, and later ones carry
            // those along with the rest (above).
            const material = paint.target.materials[0] as THREE.MeshStandardMaterial | undefined;
            const own = material ? ownMaps(material) : { map: null, normalMap: null };
            // A layout made here before sets carried these put the pictures it carried on the model in place of
            // its own: those are the model's pictures that fit the layout it wears now.
            const overrides = paint.host.materialOverrides(paint.target.modelId) ?? {};
            const ownIds: Partial<Record<PaintChannel, Set<string>>> = { baseColor: new Set(), normal: new Set(), roughness: new Set(), metallic: new Set() };
            for (const name of paint.target.materialNames) {
                const entry = overrides[name];
                if (entry?.mapTextureId) ownIds.baseColor!.add(entry.mapTextureId);
                if (entry?.normalTextureId) ownIds.normal!.add(entry.normalTextureId);
                if (entry?.roughnessTextureId) ownIds.roughness!.add(entry.roughnessTextureId);
                if (entry?.metalnessTextureId) ownIds.metallic!.add(entry.metalnessTextureId);
            }
            const laidOutHere = Boolean(this.host.layoutReference());
            // Roughness and metallic share a picture (green, blue): each keeps its own value.
            const sources: Array<[PaintChannel, THREE.Texture | null, number]> = [
                ['baseColor', own.map, -1],
                ['normal', own.normalMap, -1],
                ['roughness', material?.roughnessMap ?? null, 1],
                ['metallic', material?.metalnessMap ?? null, 2],
                ['emissive', material?.emissiveMap ?? null, -1],
            ];
            for (const [channel, texture, read] of sources) {
                const key = pictureKey(BEFORE, channel);
                if (!texture || stack.pictures.has(key)) continue;
                // A picture of the model's own that an earlier layout here left in place no longer fits.
                if (laidOutHere && !ownIds[channel]?.size) continue;
                for (const tile of newTiles) {
                    let image = await transferPicture(gpu, part, corner, texture, size, { normalMap: channel === 'normal', tile, precision: picturePrecision(key) });
                    if (read >= 0) {
                        const single = gpu.image(size, size, 'color', 8);
                        gpu.passNow(single, { fragment: `void main() { float v = texelFetch(src, ivec2(gl_FragCoord.xy), 0)[${read}]; outColor = vec4(v, v, v, 1.0); }`, inputs: { src: image } });
                        gpu.release(image);
                        image = single;
                    }
                    try {
                        await keep(key, tile, image);
                    } finally {
                        gpu.release(image);
                    }
                }
            }
            // Such a layout also kept those pictures as textures of the set's own (named "<part> <channel> (relaid)"
            // in the model's Painted folder), read by fills along the UVs: those fills read what it wore before
            // again, now carried with the set.
            const keptFolder = `Painted/${paint.target.modelName.replace(/\.[^.]+$/, '')}`;
            const keptBefore = (channel: PaintChannel, id: string): boolean => {
                const entry = paint.host.textureEntry(id);
                return Boolean(entry && entry.folder === keptFolder && entry.name === `${paint.target.partName} ${channel} (relaid)`);
            };
            const readsOwn = (channel: PaintChannel, source: FillSource | undefined): boolean => source?.kind === 'texture'
                && source.projection === 'uv' && source.scale === 1 && source.rotation === 0 && Boolean(ownIds[channel]?.has(source.textureId) || keptBefore(channel, source.textureId));
            // 3. The set's document on the new layout: its layers name the new pictures (and only those).
            const pictured = (list: readonly PaintLayer[]): PaintLayer[] => list.map((layer) => ({
                ...layer,
                ...(layer.fill ? { fill: Object.fromEntries(Object.entries(layer.fill).map(([channel, source]) => [channel, readsOwn(channel as PaintChannel, source) ? { kind: 'current' as const } : source])) } : {}),
                ...(layer.kind === 'paint' ? { pictures: Object.fromEntries(PAINT_CHANNELS.flatMap((channel) => { const tiles = carried.get(pictureKey(layer.id, channel)); return tiles ? [[channel, tiles] as const] : []; })) } : {}),
                ...(layer.mask ? { mask: layer.mask.map((effect) => (effect.kind === 'paint' ? { ...effect, pictures: carried.get(pictureKey(effect.id)) ?? {} } : effect)) } : {}),
                ...(layer.layers ? { layers: pictured(layer.layers) } : {}),
            }));
            let layers = pictured(stack.document.layers);
            let channels = stack.document.channels;
            // The set goes on the model in place of its own material, glow and all: a glow it carried is drawn by
            // the layer that shows what the surface wore before.
            if (carried.has(pictureKey(BEFORE, 'emissive')) && !channels.includes('emissive')) {
                const at = layers.findIndex((layer) => Object.values(layer.fill ?? {}).some((source) => source?.kind === 'current'));
                if (at >= 0) {
                    channels = [...channels, 'emissive'];
                    layers = layers.map((layer, index) => (index === at
                        ? { ...layer, fill: { ...layer.fill, emissive: { kind: 'current' as const } }, channels: { ...layer.channels, emissive: { mode: BLEND_FOR.emissive, opacity: 1 } } }
                        : layer));
                }
            }
            const before = Object.fromEntries(PAINT_CHANNELS.flatMap((channel) => { const tiles = carried.get(pictureKey(BEFORE, channel)); return tiles ? [[channel, tiles] as const] : []; }));
            const document: PaintDocument = { ...stack.document, layers, channels, bake: null, udim: spread || stack.document.udim, ...(Object.keys(before).length ? { before } : {}) };
            // 4. The meshes themselves, split and saved with the model.
            this.busy = 'Saving the layout';
            this.emit();
            let previous: UvLayoutFile | null = null;
            const reference = this.host.layoutReference();
            if (reference) {
                try {
                    const response = await projectService.fetchAsset(reference.assetId);
                    if (response.ok) previous = decodeLayout(await response.arrayBuffer());
                } catch {
                    previous = null;
                }
            }
            // Pictures carried across a GPU reset are blank: the model keeps its layout, and nothing is kept.
            if (!paint.usable) throw new GpuResetError();
            const layout = buildLayout(object, part, corner, proposal.cornerKey, previous);
            applyLayout(object, layout);
            laidOut = { previous, layout, saved: false };
            await this.host.saveLayout(paint.target.modelId, encodeLayout(layout), layout.meshes.length);
            laidOut.saved = true;
            // 5. The set's document naming the new pictures: once it is kept, the switch is done.
            await paint.keepDocumentAs(document);
            paint.retire();
            this.proposal = null;
            this.putOnWhenOpen = true;
            this.status = `The surface has its new layout${spread ? ` over ${newTiles.length} UDIM tiles` : ''}. Its pictures came with it and it goes on the model as it reopens; bake its mesh maps again for smart masks.`;
        } catch (error) {
            frontendDiagnostics.failure('uv_apply_failed', error);
            // Undone: the meshes and the saved layout go back; the set still has its own pictures and document.
            let undone = true;
            if (laidOut) {
                restoreLayout(object, laidOut.previous, laidOut.layout);
                if (laidOut.saved) {
                    try {
                        await this.host.saveLayout(paint.target.modelId, laidOut.previous ? encodeLayout(laidOut.previous) : null, laidOut.previous?.meshes.length ?? 0);
                    } catch (rollback) {
                        frontendDiagnostics.failure('uv_apply_rollback_failed', rollback);
                        undone = false;
                    }
                }
            }
            paint.unlock();
            const reason = error instanceof Error ? error.message : 'The new layout could not be used.';
            this.status = undone
                ? `${reason} Nothing was changed: the model and the painting keep their layout.`
                : `${reason} The model's saved layout could not be put back: open the project again before painting this set.`;
        } finally {
            this.busy = null;
            this.emit();
        }
    }
}
