import * as THREE from 'three';
import { frontendDiagnostics } from '../../../diagnostics/runtime';
import { ownMaps } from '../../../runtime/materials/graphMaterial';
import { projectService } from '../../../utils/projectService';
import { overrideTextureFlipY, type MaterialOverrides } from '../../../utils/materialOverrides';
import type { GpuImage } from '../../../texturing/gpu/textureGpu';
import { triangleStretch } from '../../../texturing/uv/lscm';
import { DEFAULT_PACK, packIslands, type Island, type PackSettings, type Placement } from '../../../texturing/uv/pack';
import { transferPicture } from '../../../texturing/uv/transfer';
import { DEFAULT_UNWRAP, unwrap, type UnwrapSettings } from '../../../texturing/uv/unwrap';
import { applyLayout, buildLayout, decodeLayout, encodeLayout, type UvLayoutFile } from '../../../texturing/uv/uvLayout';
import { buildCharts, buildTopology, edgeKey, existingSeams, type Chart, type UvTopology } from '../../../texturing/uv/uvTopology';
import type { PaintChannel, PaintDocument, PaintLayer } from '../../../texturing/paint/paintTypes';
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
    /** Share of the square the islands cover. */
    coverage: number;
    /** Pixels per model unit at the set's picture size: lowest, mean, highest over islands. */
    density: { low: number; mean: number; high: number };
    stretch: { mean: number; worst: number };
    flipped: number;
}

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
    setMaterialOverrides: (modelId: string, overrides: MaterialOverrides) => Promise<void>;
    materialOverrides: () => MaterialOverrides | undefined;
}

const islandsOf = (charts: Chart[], flat: Array<{ uv: Float64Array }>): Island[] => charts.map((chart, i) => ({ uv: flat[i].uv, triangles: chart.corners, area3d: 0 }));

export class UvSession {
    readonly topology: UvTopology;
    seams: Set<number>;
    proposal: UvProposal | null = null;
    unwrapSettings: UnwrapSettings = { ...DEFAULT_UNWRAP };
    packSettings: PackSettings = { ...DEFAULT_PACK };
    selected = new Set<number>();
    busy: string | null = null;
    status: string | null = null;
    version = 0;
    private flat: Array<{ uv: Float64Array }> = [];
    private readonly listeners = new Set<() => void>();
    readonly current: UvStats;

    constructor(readonly paint: PaintSession, readonly host: UvSessionHost) {
        const part = paint.part;
        this.topology = buildTopology(part.positions, part.indices);
        this.seams = existingSeams(this.topology, part.indices, part.uvs);
        this.packSettings.resolution = paint.stack.size;
        this.current = this.measure(Float32Array.from({ length: part.indices.length * 2 }, (_, i) => part.uvs[part.indices[i >> 1] * 2 + (i & 1)]), buildCharts(this.topology, this.seams)).stats;
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
            this.layOut(result.charts);
        });
    }

    /** Flattens along exactly the seams there are now, and packs. */
    unwrapWithSeams(): void {
        this.run('Unwrapping', () => {
            const result = unwrap(this.topology, this.unwrapSettings, new Set(), this.seams);
            this.seams = result.seams;
            this.flat = result.flat;
            this.layOut(result.charts);
        });
    }

    /** Packs the proposal (or the current layout's islands) again with the pack settings. */
    repack(): void {
        if (!this.proposal) {
            this.unwrapWithSeams();
            return;
        }
        this.run('Packing', () => this.layOut(this.proposal!.charts));
    }

    private run(label: string, work: () => void): void {
        this.busy = label;
        this.emit();
        // Let the panel show what is happening before the work holds the page.
        setTimeout(() => {
            try {
                work();
                this.status = null;
            } catch (error) {
                frontendDiagnostics.failure('uv_unwrap_failed', error);
                this.status = error instanceof Error ? error.message : 'The surface could not be unwrapped.';
            } finally {
                this.busy = null;
                this.emit();
            }
        }, 30);
    }

    private layOut(charts: Chart[]): void {
        const placements = packIslands(islandsOf(charts, this.flat), this.packSettings);
        this.setProposal(charts, placements);
    }

    private setProposal(charts: Chart[], placements: Placement[]): void {
        const count = this.paint.part.indices.length;
        const cornerUv = new Float32Array(count * 2);
        const cornerKey = new Uint32Array(count);
        charts.forEach((chart, c) => chart.faces.forEach((face, i) => {
            for (let k = 0; k < 3; k++) {
                const corner = chart.corners[i * 3 + k];
                cornerUv[(face * 3 + k) * 2] = placements[c].uv[corner * 2];
                cornerUv[(face * 3 + k) * 2 + 1] = placements[c].uv[corner * 2 + 1];
                // Charts' corners never share a vertex across charts: key by chart and corner.
                cornerKey[face * 3 + k] = (c * 65536 + corner) >>> 0;
            }
        }));
        const measured = this.measure(cornerUv, charts);
        this.proposal = { charts, placements, cornerUv, cornerKey, triangleStretch: measured.triangleStretch, stats: measured.stats };
        this.selected.clear();
    }

    /** Stretch per triangle and the layout's figures. */
    private measure(cornerUv: Float32Array, charts: Chart[]): { triangleStretch: Float32Array; stats: UvStats } {
        const { positions, faces, areas, faceCount } = this.topology;
        const stretch = new Float32Array(faceCount);
        const local = new Float64Array(6);
        let flipped = 0;
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
            if (signed < 0) { flipped++; stretch[f] = -1; continue; }
            if (orientation[f] < 0) { local[0] = -local[0]; local[2] = -local[2]; local[4] = -local[4]; }
            const s = triangleStretch(positions, faces, f, local, 0, 1, 2);
            stretch[f] = Math.min(1, (s.ratio - 1) / 2);
            worst = Math.max(worst, s.ratio);
            // A sliver squashed to nothing would swamp the mean: count it as badly stretched, no worse.
            weighted += Math.min(s.ratio, 20) * areas[f];
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
                coverage: Math.min(1, flat / (this.packSettings.tilesX * this.packSettings.tilesY)),
                density: { low: densities.length ? Math.min(...densities) : 0, mean, high: densities.length ? Math.max(...densities) : 0 },
                stretch: { mean: surface > 0 ? weighted / surface : 1, worst },
                flipped,
            },
        };
    }

    /** Moves selected islands by (du, dv). */
    moveSelected(du: number, dv: number): void {
        if (!this.proposal) return;
        for (const i of this.selected) {
            const uv = this.proposal.placements[i].uv;
            for (let k = 0; k < uv.length; k += 2) { uv[k] += du; uv[k + 1] += dv; }
        }
        this.setProposal(this.proposal.charts, this.proposal.placements);
    }

    /** Turns or scales selected islands about their own middles. */
    transformSelected(angle: number, scale: number): void {
        if (!this.proposal) return;
        for (const i of this.selected) {
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
        this.setProposal(this.proposal.charts, this.proposal.placements);
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
        this.proposal = null;
        this.selected.clear();
        this.emit();
    }

    /**
     * Uses the proposal: carries every picture drawn on the surface over to it, splits the meshes, saves
     * the layout with the model, and reopens painting on the new layout.
     */
    async apply(): Promise<void> {
        const proposal = this.proposal;
        if (!proposal || this.busy) return;
        const paint = this.paint;
        const gpu = paint.gpu;
        const stack = paint.stack;
        const part = paint.part;
        const object = paint.target.object;
        const size = stack.size;
        this.busy = 'Carrying the pictures over';
        this.emit();
        try {
            // Corners that must stay within the one picture (a single-tile set): wrap into 0..1 per triangle.
            const corner = proposal.cornerUv;
            // 1. Painted layers and masks.
            for (const [key, byTile] of stack.pictures) {
                const image = byTile.get(stack.tiles[0]);
                if (!image) continue;
                const moved = await transferPicture(gpu, part, corner, image, size, key.endsWith(':normal'));
                const target = stack.picture(key, stack.tiles[0]);
                gpu.copy(moved, target);
                gpu.release(moved);
                stack.touch(key, stack.tiles[0]);
            }
            // 2. The surface's own pictures, which the "what it wears now" fills read: kept as new library pictures.
            const material = paint.target.materials[0] as THREE.MeshStandardMaterial | undefined;
            const own = material ? ownMaps(material) : { map: null, normalMap: null };
            const sources: Partial<Record<PaintChannel, { texture: THREE.Texture; normal: boolean; channel: number }>> = {};
            if (own.map) sources.baseColor = { texture: own.map, normal: false, channel: -1 };
            if (own.normalMap) sources.normal = { texture: own.normalMap, normal: true, channel: -1 };
            if (material?.roughnessMap) sources.roughness = { texture: material.roughnessMap, normal: false, channel: 1 };
            if (material?.metalnessMap) sources.metallic = { texture: material.metalnessMap, normal: false, channel: 2 };
            const flipRows = overrideTextureFlipY(object);
            const moved: Partial<Record<PaintChannel, string>> = {};
            for (const [channel, source] of Object.entries(sources) as Array<[PaintChannel, { texture: THREE.Texture; normal: boolean; channel: number }]>) {
                let image: GpuImage = await transferPicture(gpu, part, corner, source.texture, size, source.normal);
                if (source.channel >= 0) {
                    const single = gpu.image(size, size, 'color', 8);
                    gpu.passNow(single, { fragment: `void main() { float v = texelFetch(src, ivec2(gl_FragCoord.xy), 0)[${source.channel}]; outColor = vec4(v, v, v, 1.0); }`, inputs: { src: image } });
                    gpu.release(image);
                    image = single;
                }
                const blob = await gpu.toPng(image, size, size, 'raw', flipRows);
                gpu.release(image);
                moved[channel] = await paint.host.storeTexture(blob, `${paint.target.partName} ${channel} (relaid)`, { width: size, height: size }, `Painted/${paint.target.modelName.replace(/\.[^.]+$/, '')}`);
            }
            // The fills that showed what it wore now show the carried-over pictures.
            const swap = (layers: readonly PaintLayer[]): PaintLayer[] => layers.map((layer) => {
                const fill = layer.fill ? Object.fromEntries(Object.entries(layer.fill).map(([channel, source]) => [channel, source?.kind === 'current' && moved[channel as PaintChannel]
                    ? { kind: 'texture' as const, textureId: moved[channel as PaintChannel]!, projection: 'uv' as const, scale: 1, rotation: 0, sharpness: 4 }
                    : source])) : undefined;
                return { ...layer, ...(fill ? { fill } : {}), ...(layer.layers ? { layers: swap(layer.layers) } : {}) };
            });
            let document: PaintDocument = { ...stack.document, layers: swap(stack.document.layers), bake: null };
            // 3. The engine draws the surface with the carried-over pictures until the painting is put on it again.
            const overrides: MaterialOverrides = { ...(this.host.materialOverrides() ?? {}) };
            for (const name of paint.target.materialNames) {
                const entry = { ...(overrides[name] ?? {}) };
                if (moved.baseColor) entry.mapTextureId = moved.baseColor;
                if (moved.normal) entry.normalTextureId = moved.normal;
                if (moved.roughness) entry.roughnessTextureId = moved.roughness;
                if (moved.metallic) entry.metalnessTextureId = moved.metallic;
                overrides[name] = entry;
            }
            // 4. The meshes themselves.
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
            const layout = buildLayout(object, part, corner, proposal.cornerKey, previous);
            applyLayout(object, layout);
            await this.host.saveLayout(paint.target.modelId, encodeLayout(layout), layout.meshes.length);
            await this.host.setMaterialOverrides(paint.target.modelId, overrides);
            stack.setDocument(document);
            document = await stack.keepPictures();
            stack.setDocument(document);
            await paint.save();
            this.proposal = null;
            this.status = 'The surface has its new layout. Its pictures came with it; bake its mesh maps again for smart masks.';
        } catch (error) {
            frontendDiagnostics.failure('uv_apply_failed', error);
            this.status = error instanceof Error ? error.message : 'The new layout could not be used.';
        } finally {
            this.busy = null;
            this.emit();
        }
    }
}
