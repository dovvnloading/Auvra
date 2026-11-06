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
import { applyLayout, buildLayout, decodeLayout, encodeLayout, type UvLayoutFile } from '../../../texturing/uv/uvLayout';
import { buildCharts, buildTopology, edgeKey, existingSeams, type Chart, type UvTopology } from '../../../texturing/uv/uvTopology';
import { BEFORE, pictureKey, pictureOwner, pictureOwners, picturePrecision } from '../../../texturing/paint/paintStack';
import { BLEND_FOR, type FillSource, type PaintChannel, type PaintDocument, type PaintLayer } from '../../../texturing/paint/paintTypes';
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

const islandsOf = (charts: Chart[], flat: Array<{ uv: Float64Array }>): Island[] => charts.map((chart, i) => ({ uv: flat[i].uv, triangles: chart.corners, area3d: 0 }));

export class UvSession {
    readonly topology: UvTopology;
    seams: Set<number>;
    proposal: UvProposal | null = null;
    unwrapSettings: UnwrapSettings = { ...DEFAULT_UNWRAP };
    packSettings: PackSettings = { ...DEFAULT_PACK };
    selected = new Set<number>();
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
    readonly current: UvStats;

    constructor(readonly paint: PaintSession, readonly host: UvSessionHost) {
        const part = paint.part;
        this.topology = buildTopology(part.positions, part.indices);
        this.seams = existingSeams(this.topology, part.indices, part.uvs);
        this.packSettings.resolution = paint.stack.size;
        // Packing again keeps the grid of UDIM tiles the surface is laid over now.
        this.packSettings.tilesX = Math.max(...part.tiles.map((tile) => (tile - 1001) % 10)) + 1;
        this.packSettings.tilesY = Math.max(...part.tiles.map((tile) => Math.floor((tile - 1001) / 10))) + 1;
        this.current = this.measure(Float32Array.from({ length: part.indices.length * 2 }, (_, i) => part.uvs[part.indices[i >> 1] * 2 + (i & 1)]), buildCharts(this.topology, this.seams), part.tiles.length).stats;
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

    /**
     * Makes `placements` the proposal and measures it. Moving islands keeps the selection; while they are
     * dragged (`quick`), overlaps are looked for once they settle, so dragging stays smooth.
     */
    private setProposal(charts: Chart[], placements: Placement[], edit: { keepSelection?: boolean; quick?: boolean } = {}): void {
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

    /** Moves selected islands by (du, dv). */
    moveSelected(du: number, dv: number): void {
        if (!this.proposal) return;
        for (const i of this.selected) {
            const uv = this.proposal.placements[i].uv;
            for (let k = 0; k < uv.length; k += 2) { uv[k] += du; uv[k + 1] += dv; }
        }
        this.setProposal(this.proposal.charts, this.proposal.placements, { keepSelection: true, quick: true });
        this.emit();
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
        this.setProposal(this.proposal.charts, this.proposal.placements, { keepSelection: true });
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
            const corner = proposal.cornerUv;
            // The UDIM tiles the new layout uses (one for an ordinary layout): a picture each.
            const newTiles = [...new Set(newTriangleTiles(corner))].sort((a, b) => a - b);
            const spread = newTiles.length > 1;
            // 1. Every picture of the set (painted layers, masks, what it wore before once carried): each tile
            // of the new layout drawn from the current tiles' pictures. Pictures of layers deleted earlier
            // are kept only for undo, which the set reopens without: they are not carried (nor kept again).
            const used = pictureOwners([stack.document]);
            for (const [key, byTile] of [...stack.pictures]) {
                if (!used.has(pictureOwner(key))) continue;
                const moved: Array<[number, GpuImage]> = [];
                for (const tile of newTiles) moved.push([tile, await transferPicture(gpu, part, corner, (from) => byTile.get(from) ?? null, size, key.endsWith(':normal'), tile, picturePrecision(key))]);
                for (const [tile, image] of moved) {
                    gpu.copy(image, stack.picture(key, tile));
                    gpu.release(image);
                    stack.touch(key, tile);
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
                    let image = await transferPicture(gpu, part, corner, texture, size, channel === 'normal', tile, picturePrecision(key));
                    if (read >= 0) {
                        const single = gpu.image(size, size, 'color', 8);
                        gpu.passNow(single, { fragment: `void main() { float v = texelFetch(src, ivec2(gl_FragCoord.xy), 0)[${read}]; outColor = vec4(v, v, v, 1.0); }`, inputs: { src: image } });
                        gpu.release(image);
                        image = single;
                    }
                    gpu.copy(image, stack.picture(key, tile));
                    gpu.release(image);
                    stack.touch(key, tile);
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
            const restore = (list: readonly PaintLayer[]): PaintLayer[] => list.map((layer) => ({
                ...layer,
                ...(layer.fill ? { fill: Object.fromEntries(Object.entries(layer.fill).map(([channel, source]) => [channel, readsOwn(channel as PaintChannel, source) ? { kind: 'current' as const } : source])) } : {}),
                ...(layer.layers ? { layers: restore(layer.layers) } : {}),
            }));
            let layers = restore(stack.document.layers);
            let channels = stack.document.channels;
            // The set goes on the model in place of its own material, glow and all: a glow it carried is drawn by
            // the layer that shows what the surface wore before.
            if (stack.pictures.has(pictureKey(BEFORE, 'emissive')) && !channels.includes('emissive')) {
                const at = layers.findIndex((layer) => Object.values(layer.fill ?? {}).some((source) => source?.kind === 'current'));
                if (at >= 0) {
                    channels = [...channels, 'emissive'];
                    layers = layers.map((layer, index) => (index === at
                        ? { ...layer, fill: { ...layer.fill, emissive: { kind: 'current' as const } }, channels: { ...layer.channels, emissive: { mode: BLEND_FOR.emissive, opacity: 1 } } }
                        : layer));
                }
            }
            let document: PaintDocument = { ...stack.document, layers, channels, bake: null, udim: spread || stack.document.udim };
            // 3. The meshes themselves.
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
            stack.setDocument(document);
            document = await stack.keepPictures();
            // Pictures of tiles the layout no longer uses are let go.
            const keep = <T>(byTile: Record<string, T> | undefined): Record<string, T> => Object.fromEntries(Object.entries(byTile ?? {}).filter(([tile]) => newTiles.includes(Number(tile))));
            const prune = (list: readonly PaintLayer[]): PaintLayer[] => list.map((layer) => ({
                ...layer,
                ...(layer.pictures ? { pictures: Object.fromEntries(Object.entries(layer.pictures).map(([channel, byTile]) => [channel, keep(byTile)])) } : {}),
                ...(layer.mask ? { mask: layer.mask.map((effect) => (effect.kind === 'paint' && effect.pictures ? { ...effect, pictures: keep(effect.pictures) } : effect)) } : {}),
                ...(layer.layers ? { layers: prune(layer.layers) } : {}),
            }));
            const before = document.before;
            document = {
                ...document,
                layers: prune(document.layers),
                ...(before ? { before: Object.fromEntries(Object.entries(before).map(([channel, byTile]) => [channel, keep(byTile)])) } : {}),
            };
            stack.setDocument(document);
            await paint.save();
            this.proposal = null;
            this.putOnWhenOpen = true;
            this.status = `The surface has its new layout${spread ? ` over ${newTiles.length} UDIM tiles` : ''}. Its pictures came with it and it goes on the model as it reopens; bake its mesh maps again for smart masks.`;
        } catch (error) {
            frontendDiagnostics.failure('uv_apply_failed', error);
            this.status = error instanceof Error ? error.message : 'The new layout could not be used.';
        } finally {
            this.busy = null;
            this.emit();
        }
    }
}
