import * as THREE from 'three';
import { frontendDiagnostics } from '../../../diagnostics/runtime';
import { ownMaps } from '../../../runtime/materials/graphMaterial';
import { materialLibrary, MATERIALS_DOMAIN, materialAssetDocument, type MaterialAsset } from '../../../runtime/materials/materialLibrary';
import { createMaterialGraph } from '../../../runtime/materials/materialGraph';
import { projectService } from '../../../utils/projectService';
import { overrideTextureFlipY, type MaterialOverrides } from '../../../utils/materialOverrides';
import { bakeMeshMaps, rebakeRegion, releaseTileBake, spaceOfBox, type BakeSettings, type PositionSpace, type TileBake } from '../../../texturing/bake/meshBaker';
import { textureGpu, type GpuImage, type TextureGpu } from '../../../texturing/gpu/textureGpu';
import type { GraphEntry, GraphResolver } from '../../../texturing/graph/registry';
import { readStoredGraph } from '../../../texturing/graph/stored';
import { buildHighPoly, buildPartMesh, buildWholeMesh, type PartMesh } from '../../../texturing/mesh/partMesh';
import { averagedNormals, meshCage } from '../../../texturing/bake/bakeSetup';
import type { SurfacePicker } from '../../../texturing/mesh/picker';
import { SurfaceSelector } from '../../../texturing/paint/selection';
import { DEEP_EXPORT, ROLE_LABELS, encodeChannels, rewriteMaterialPictures, tileAtlas, tileAtlasLayout, type ChannelTextureIds, type PictureLayout, type TileLayout } from '../../../texturing/materialOutput';
import { GpuResetError, PaintStack, pictureOwners, type StackHost } from '../../../texturing/paint/paintStack';
import { BUILTIN_GRAPHS } from '../../../texturing/paint/smartLibrary';
import { applyPixelHistory, trimmedHistory, type HistoryEntry } from '../../../texturing/paint/strokes';
import { BAKE_HISTORY_BYTES, bakeStepsToForget, branchBeforeStep, branchesToDrop, historyKind, travelTo, type HistoryBranch, type HistoryKind, type HistoryLines } from '../../../texturing/paint/history';
import { PAINT_CHANNELS, castsFromThreeSides, paintedSetName, readPaintDocument, startingPaintDocument, surfaceGlows, type PaintChannel, type PaintDocument } from '../../../texturing/paint/paintTypes';
import { download, makeZip } from '../../../texturing/zip';
import { fileName, holdsNormalGreen, planPicture, type ChannelSource, type ExportPicture, type ExportSource, type ExportTemplate } from '../../../texturing/paint/exportTemplates';
import { colourChannels, extensionOf, linearChannels, writePicture, type PictureData } from '../../../texturing/paint/pictureFiles';
import { atlasMesh, atlasUvs, markPaintedMaterials, surfaceOfGraph, withPaintedMaterials, writePaintedGlb, type GltfPictures, type GltfSurface, type PaintedMaterial } from '../../../texturing/paint/gltfExport';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { graphPictureLookup } from './graphPictures';
import { paintStackEntry, registerOpenStack } from '../../../texturing/paint/stackNode';

/** A template's picture packed from up to four maps: each channel a component of one (grey maps hold theirs in red), or a value. */
const PACK_PICTURE = /* glsl */ `
uniform vec4 uSlot;
uniform vec4 uComponent;
uniform vec4 uValue;
uniform vec4 uFlip;
uniform vec4 uGray;
uniform int uPadding;
float pick(int c) {
    if (uSlot[c] < 0.0) return uValue[c];
    int slot = int(uSlot[c] + 0.5);
    vec4 t = slot == 0 ? texture(s0, vUv) : slot == 1 ? texture(s1, vUv) : slot == 2 ? texture(s2, vUv) : texture(s3, vUv);
    int k = int(uComponent[c] + 0.5);
    float v = uGray[slot] > 0.5 ? (k == 3 ? 1.0 : t.r) : t[k];
    return uFlip[c] > 0.5 ? 1.0 - v : v;
}
void main() {
    vec4 o = vec4(pick(0), pick(1), pick(2), pick(3));
    // Without padding, black past the islands.
    if (uPadding == 0 && texture(cover, vUv).r < 0.5) o.rgb = vec3(0.0);
    outColor = o;
}`;
import type { PartMaterial } from '../../Tools/Retexture/parts';

/**
 * A texture set open for painting: its mesh, its layer stack on the GPU, undo history, saving its
 * pictures into the project, baking its mesh maps, and giving the model the finished pictures.
 * Its document lives in a material asset (`paint`), which the model's materials are pointed at once
 * the pictures are applied.
 */

export interface PaintTarget {
    modelId: string;
    modelName: string;
    object: THREE.Object3D;
    partName: string;
    materials: PartMaterial[];
    materialNames: string[];
}

export interface PaintSessionHost {
    storeTexture: (blob: Blob, name: string, size: { width: number; height: number }, folder: string) => Promise<string>;
    discardTextures: (ids: readonly string[]) => Promise<void>;
    texture: (id: string) => THREE.Texture | null;
    /** A kept texture's name and content folder, or null. */
    textureEntry: (id: string) => { name: string; folder: string } | null;
    setMaterialOverrides: (modelId: string, overrides: MaterialOverrides) => Promise<void>;
    materialOverrides: (modelId: string) => MaterialOverrides | undefined;
}

export const HISTORY_LIMIT = 80;
/** The channels a comparison keeps: every one a view can show (with the shown layer's mask besides). */
export type ComparedChannel = PaintChannel | 'ambientOcclusion';
export const COMPARED_CHANNELS: readonly ComparedChannel[] = [...PAINT_CHANNELS, 'ambientOcclusion'];
/** A picture a comparison keeps: a channel, or the mask of the layer whose mask is shown. */
export type ComparedPicture = ComparedChannel | 'mask';
/** Branches kept at most (the oldest go first). */
export const MAX_BRANCHES = 12;
/**
 * Pixels the undo history may hold, in bytes (strokes keep the blocks they touched). Past it, the oldest
 * steps go first; the newest step is always kept.
 */
export const HISTORY_BYTES = 256 * 1024 * 1024;
const SAVE_DELAY_MS = 2500;
/** Changes to one thing this close together make one undo step. */
const COALESCE_MS = 1000;

/** Graphs a painted set can use: the project's texture graph materials and the built-in smart graphs. */
export const paintGraphResolver = (): GraphResolver => (id) => {
    // A paint stack (or folder of one) used inside a fill or mask graph.
    const stack = paintStackEntry(id, (assetId) => materialLibrary.get(assetId));
    if (stack) return stack;
    const builtin = BUILTIN_GRAPHS.get(id);
    if (builtin) return builtin;
    const asset = materialLibrary.get(id);
    return asset?.textureGraph ? { id, name: asset.name, graph: readStoredGraph(asset.textureGraph).graph } as GraphEntry : undefined;
};

/** The material asset painting this surface, if one exists. */
export const findPaintAsset = (target: Pick<PaintTarget, 'modelId' | 'materialNames'>): MaterialAsset | undefined =>
    materialLibrary.list().find((asset) => {
        const document = asset.paint ? readPaintDocument(asset.paint) : null;
        return document && document.modelId === target.modelId && document.materialNames.some((name) => target.materialNames.includes(name));
    });

export class PaintSession {
    readonly gpu: TextureGpu;
    readonly part: PartMesh;
    readonly picker: SurfacePicker;
    readonly occluder: { positions: Float32Array; normals: Float32Array; indices: Uint32Array };
    stack: PaintStack;
    asset: MaterialAsset;
    private past: HistoryEntry[] = [];
    private future: HistoryEntry[] = [];
    /** Steps undone and replaced, kept as branches off the step they came after. */
    private branches: HistoryBranch[] = [];
    /** Older steps have gone (memory): a branch off the start no longer has a start to come off. */
    private startMoved = false;
    /** The history's lines, as the branching helpers work on them (the set's own lists). */
    private get lines(): HistoryLines {
        const session = this;
        return {
            get past() { return session.past; },
            set past(value) { session.past = value; },
            get future() { return session.future; },
            set future(value) { session.future = value; },
            get branches() { return session.branches; },
            set branches(value) { session.branches = value; },
        };
    }
    private readonly listeners = new Set<() => void>();
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private saving: Promise<void> | null = null;
    private coalesceKey: string | null = null;
    private coalesceAt = 0;
    version = 0;
    status: string | null = null;
    busy: string | null = null;
    progress = 0;
    /** True when pictures changed since the model was last given them. */
    changedSinceApply = false;
    /** Called once the GPU context comes back after being lost: the set must be opened again. */
    private readonly restoredListeners = new Set<() => void>();
    private readonly stopListening: () => void;

    private constructor(readonly target: PaintTarget, readonly host: PaintSessionHost, part: PartMesh, stack: PaintStack, asset: MaterialAsset,
        occluder: PaintSession['occluder'], readonly modelSpace: PositionSpace) {
        this.gpu = stack.host.gpu;
        this.part = part;
        this.picker = stack.picker;
        this.occluder = occluder;
        this.stack = stack;
        this.asset = asset;
        stack.subscribe(() => this.emit());
        // A lost GPU context takes every picture with it. Painting and saving stop at once (pictures read back
        // now would be blank), and once the context returns the set is opened again from its kept pictures.
        const onLost = () => this.contextLost();
        this.gpu.canvas.addEventListener('webglcontextlost', onLost);
        const stopRestored = this.gpu.onRestored(() => { void this.contextRestored(); });
        this.stopListening = () => {
            this.gpu.canvas.removeEventListener('webglcontextlost', onLost);
            stopRestored();
        };
    }

    /** False while the GPU context is lost (or after it came back, until the set opens again). */
    get usable(): boolean {
        return this.stack.usable;
    }

    private picks: SurfaceSelector | null = null;

    /** Finds the triangles a polygon pick takes in (its quads and loops worked out the first time). */
    private averaged: Float32Array | null = null;

    /** Normals averaged across hard edges, per vertex (the way bake rays leave), worked out the first time. */
    get averagedNormals(): Float32Array {
        if (!this.averaged) this.averaged = averagedNormals(this.part.positions, this.part.indices);
        return this.averaged;
    }

    get selector(): SurfaceSelector {
        if (!this.picks) this.picks = new SurfaceSelector(this.part);
        return this.picks;
    }

    /** The baked ID map's colour where a triangle is met at `uv`, or null without an ID map. */
    idColourAt(triangle: number, uv: THREE.Vector2): [number, number, number] | null {
        const part = this.part;
        const image = this.stack.meshMaps(part.triangleTile[triangle]).id;
        if (!image || !this.usable) return null;
        const at = new THREE.Vector2(uv.x - part.triangleShift[triangle * 2], uv.y - part.triangleShift[triangle * 2 + 1]);
        const probe = this.gpu.image(1, 1, 'color', 32);
        // The texel itself, never a blend of neighbouring IDs.
        this.gpu.passNow(probe, { fragment: 'uniform vec2 uAt;\nvoid main() { ivec2 size = textureSize(source, 0); outColor = texelFetch(source, clamp(ivec2(fract(uAt) * vec2(size)), ivec2(0), size - 1), 0); }', inputs: { source: image }, uniforms: { uAt: at } });
        const value = this.gpu.readFloat(probe);
        this.gpu.release(probe);
        return [value[0], value[1], value[2]];
    }

    /** Why painting waits (a new UV layout being put on), or null. */
    get locked(): string | null {
        return this.lockReason;
    }

    private lockReason: string | null = null;
    /** Set once the set has handed over to another (a new layout's): it keeps nothing more. */
    private retired = false;

    /** Stops painting, undo and saving (with the reason to show) until unlocked. */
    lock(reason: string): void {
        this.lockReason = reason;
        if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; this.saveWaiting = true; }
        this.emit();
    }

    unlock(): void {
        this.lockReason = null;
        // A save the lock held back goes ahead now.
        if (this.saveWaiting) { this.saveWaiting = false; this.dirty(); }
        this.emit();
    }

    /** A save was due when the set was locked. */
    private saveWaiting = false;

    /** The set has been replaced (its document now names another layout's pictures): it never saves again. */
    retire(): void {
        this.retired = true;
        if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    }

    /**
     * Keeps `document` as the set's in the project, without keeping any picture or changing what is open:
     * the material library goes back to what it held when the project would not take it.
     */
    async keepDocumentAs(document: PaintDocument): Promise<void> {
        const current = materialLibrary.get(this.asset.id) ?? this.asset;
        const next = { ...current, paint: document as unknown as Record<string, unknown> };
        materialLibrary.upsert(next);
        try {
            await projectService.applyChanges([{ domain: MATERIALS_DOMAIN, operation: 'upsert', id: next.id, value: materialAssetDocument(next) }]);
        } catch (error) {
            materialLibrary.upsert(current);
            throw error;
        }
        this.asset = next;
    }

    /** Calls `listener` when the set must be opened again after the GPU context came back. */
    whenRestored(listener: () => void): () => void {
        this.restoredListeners.add(listener);
        return () => this.restoredListeners.delete(listener);
    }

    private contextLost(): void {
        if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
        frontendDiagnostics.failure('paint_context_lost', new Error('The texturing GPU context was lost while a set was open'));
        this.status = 'The graphics card stopped responding, so painting is paused. Nothing is saved until it is back; the set then opens again from its saved pictures.';
        this.emit();
    }

    /**
     * The context is back, but every picture made on the old one is blank: the set lets go of them, keeps
     * its layers (never its pictures), and asks to be opened again from the pictures it kept.
     */
    private async contextRestored(): Promise<void> {
        if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
        if (this.saving) await this.saving.catch(() => undefined);
        this.stack.abandon();
        this.past = [];
        this.future = [];
        this.branches = [];
        try {
            if (!this.retired) await this.keepDocument();
        } catch (error) {
            frontendDiagnostics.failure('paint_save_failed', error);
        }
        this.status = 'The graphics card was reset. The set was opened again from its saved pictures: strokes made in the last few seconds before the reset may be missing.';
        this.emit();
        for (const listener of [...this.restoredListeners]) listener();
    }

    static async open(target: PaintTarget, host: PaintSessionHost): Promise<PaintSession> {
        let asset = findPaintAsset(target);
        let document = asset ? readPaintDocument(asset.paint) : null;
        const part = buildPartMesh(target.object, new Set(target.materials), { udim: document ? document.udim : 'auto' });
        const material = target.materials[0] as THREE.MeshStandardMaterial;
        // The whole model: what casts occlusion, and the cube every texture set of it measures 3D placement in.
        const occluder = buildWholeMesh(target.object);
        const modelSpace = spaceOfBox(new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(occluder.positions, 3)));
        if (!asset || !document) {
            document = startingPaintDocument(target.modelId, target.materialNames, { size: 11, udim: part.udim, space: modelSpace, glows: surfaceGlows(material) });
            asset = { id: crypto.randomUUID(), name: paintedSetName(target.modelName, target.partName), graph: createMaterialGraph(), paint: document as unknown as Record<string, unknown> };
            materialLibrary.upsert(asset);
            await projectService.applyChanges([{ domain: MATERIALS_DOMAIN, operation: 'upsert', id: asset.id, value: materialAssetDocument(asset) }]);
        }
        const own = material ? ownMaps(material) : { map: null, normalMap: null };
        const color = (value: THREE.Color | undefined): [number, number, number] => {
            const c = value ? value.clone().convertLinearToSRGB() : new THREE.Color(0.5, 0.5, 0.5);
            return [c.r, c.g, c.b];
        };
        const current: StackHost['current'] = {
            baseColor: own.map ?? color(material?.color),
            normal: own.normalMap ?? [0.5, 0.5, 1],
            roughness: material?.roughnessMap ?? [material?.roughness ?? 0.6, material?.roughness ?? 0.6, material?.roughness ?? 0.6],
            metallic: material?.metalnessMap ?? [material?.metalness ?? 0, material?.metalness ?? 0, material?.metalness ?? 0],
            emissive: material?.emissiveMap ?? color(material?.emissive),
        };
        // Fill graphs read 16-bit and float pictures at their depth, laid as the model's textures are.
        const graphPictures = graphPictureLookup(host.texture, overrideTextureFlipY(target.object));
        const stackHost: StackHost = {
            gpu: textureGpu(),
            resolveGraph: paintGraphResolver(),
            texture: host.texture,
            graphTexture: graphPictures.lookup,
            current,
            fetchPicture: async (assetId) => {
                const response = await projectService.fetchAsset(assetId);
                if (!response.ok) throw new Error('A painted picture could not be read.');
                return response.blob();
            },
            storePicture: (blob) => projectService.uploadAsset(new File([blob], 'painted.png', { type: 'image/png' })),
        };
        let stack: PaintStack;
        try {
            stack = await PaintStack.open(stackHost, part, document);
        } catch (error) {
            graphPictures.dispose();
            throw error;
        }
        const session = new PaintSession(target, host, part, stack, asset, occluder, modelSpace);
        session.releasePictures = graphPictures.dispose;
        // Graphs using this set's stack draw from it while it is open.
        session.closeStack = registerOpenStack(asset.id, stack);
        return session;
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

    get document(): PaintDocument {
        return this.stack.document;
    }

    // -----------------------------------------------------------------------
    // Edits and history
    // -----------------------------------------------------------------------

    /**
     * Changes the document (an undoable step), puts the set together again and saves soon. Quick changes
     * with the same `coalesce` key (a slider or a colour being dragged, a name being typed) make one step.
     */
    change(next: PaintDocument, label: string, coalesce?: string): void {
        const before = this.stack.document;
        if (next === before) return;
        const now = performance.now();
        const last = this.past[this.past.length - 1];
        if (coalesce && coalesce === this.coalesceKey && now - this.coalesceAt < COALESCE_MS && last?.document && !last.pixels) {
            last.document = { before: last.document.before, after: next };
            last.at = Date.now();
            this.future = [];
            this.emit();
        } else this.record({ label, document: { before, after: next } });
        this.coalesceKey = coalesce ?? null;
        this.coalesceAt = now;
        this.stack.setDocument(next);
        this.dropUnusedPictures();
        this.dirty();
    }

    /** A step already made (a brush stroke) goes into the history. */
    record(entry: HistoryEntry): void {
        // The undone steps it replaces stay, as a branch the History panel can go back to.
        branchBeforeStep(this.lines);
        entry.at ??= Date.now();
        this.past.push(entry);
        this.future = [];
        if (entry.bakeMaps) this.forgetOldBakes();
        const kept = new Set(this.past);
        this.trimHistory();
        for (const dropped of kept) if (!this.past.includes(dropped)) this.letGoOfBake(dropped.bakeMaps?.before ?? null);
        this.dropUnusedPictures();
        if (entry.pixels) this.dirty();
        this.emit();
    }

    /**
     * Keeps the bakes held for undo within their GPU budget: past it, the oldest bake steps let go of their
     * maps and keep their place in the list, putting nothing back.
     */
    private forgetOldBakes(): void {
        for (const older of bakeStepsToForget(this.past, [...this.future, ...this.branches.flatMap((branch) => branch.steps)], this.stack.bake, BAKE_HISTORY_BYTES)) {
            this.letGoOfBake(older.bakeMaps?.before ?? null);
            delete older.bakeMaps;
            delete older.document;
        }
    }

    /** Lets go of maps a bake step held for undo (never the ones in use). */
    private letGoOfBake(maps: Map<number, TileBake> | null): void {
        if (!maps || maps === this.stack.bake) return;
        for (const result of maps.values()) releaseTileBake(this.gpu, result);
    }

    /** Keeps the history within its step count and its memory (oldest first, never the newest step). */
    private trimHistory(): void {
        const oldest = this.past[0];
        this.past = trimmedHistory(this.past, this.future, HISTORY_LIMIT, HISTORY_BYTES);
        if (oldest && this.past[0] !== oldest) this.startMoved = true;
        // Branches count against the same memory and go first, oldest first; those nothing reaches go too.
        for (const branch of branchesToDrop(this.lines, HISTORY_BYTES, MAX_BRANCHES, this.startMoved)) this.forgetBranch(branch);
    }

    /** Lets go of a branch and the bake maps only its steps held. */
    private forgetBranch(branch: HistoryBranch): void {
        this.branches = this.branches.filter((other) => other !== branch);
        for (const step of branch.steps) this.letGoOfBake(step.bakeMaps?.after ?? null);
    }

    /** The branches off the history, each with its steps as the panel lists them. */
    get branchSteps(): Array<{ branch: HistoryBranch; from: HistoryEntry | null; steps: Array<{ entry: HistoryEntry; label: string; kind: HistoryKind; at: number | null; putsBack: boolean }> }> {
        return this.branches.map((branch) => ({
            branch,
            from: branch.from,
            steps: branch.steps.map((entry) => ({ entry, label: entry.label, kind: historyKind(entry), at: entry.at ?? null, putsBack: Boolean(entry.pixels || entry.document || entry.bakeMaps) })),
        }));
    }

    /**
     * Lets go of the pictures of layers and mask effects that neither the set as it is nor any step of
     * its history uses (deleted, and out of reach of undo).
     */
    private dropUnusedPictures(): void {
        const documents: PaintDocument[] = [this.stack.document];
        for (const entry of [...this.past, ...this.future, ...this.branches.flatMap((branch) => branch.steps)]) if (entry.document) documents.push(entry.document.before, entry.document.after);
        this.stack.dropPicturesExcept(pictureOwners(documents));
    }

    /**
     * The history as a list, oldest first: each step's name, kind and time, whether it is done (the set is
     * at or past it) and whether going back over it puts anything back.
     */
    get steps(): Array<{ entry: HistoryEntry; label: string; kind: HistoryKind; at: number | null; done: boolean; putsBack: boolean }> {
        const item = (entry: HistoryEntry, done: boolean) => ({ entry, label: entry.label, kind: historyKind(entry), at: entry.at ?? null, done, putsBack: Boolean(entry.pixels || entry.document || entry.bakeMaps) });
        return [...this.past.map((entry) => item(entry, true)), ...[...this.future].reverse().map((entry) => item(entry, false))];
    }

    /**
     * Goes back (or forward) to just after `target`, or to before every kept step when it is null, undoing
     * or redoing the steps between; the later steps stay until a new change.
     */
    goTo(target: HistoryEntry | null): void {
        if (!this.usable || this.lockReason) return;
        const held = (entry: HistoryEntry | null) => entry === null || this.past.includes(entry) || this.future.includes(entry) || this.branches.some((branch) => branch.steps.includes(entry));
        travelTo(this.lines, target, (direction) => {
            // A step let go of to keep memory on the way cannot be reached any more.
            if (!held(target)) return false;
            const before = this.past[this.past.length - 1];
            if (direction === 'undo') this.undo();
            else this.redo();
            return this.past[this.past.length - 1] !== before;
        });
        this.emit();
    }

    /**
     * A step to compare with: the set's pictures as they stood just after it (null: at the start), drawn
     * once, and where the view's wipe between it and the set as it is now stands (0 left to 1 right).
     */
    comparison: { entry: HistoryEntry | null; label: string; images: Map<number, Partial<Record<ComparedPicture, GpuImage>>>; wipe: number } | null = null;

    /** Draws the set as it stood just after `target` and keeps it to compare with, coming back to where it is. */
    async compareWith(target: HistoryEntry | null): Promise<void> {
        if (this.busy || !this.usable || this.lockReason) return;
        this.stopComparing();
        const back = this.past[this.past.length - 1] ?? null;
        this.busy = 'Drawing the step to compare';
        this.emit();
        try {
            this.goTo(target);
            await this.stack.compose();
            const images = new Map<number, Partial<Record<ComparedPicture, GpuImage>>>();
            const watched = this.stack.watchedLayer;
            for (const tile of this.stack.tiles) {
                const outputs = this.stack.outputs.get(tile) ?? {};
                const kept: Partial<Record<ComparedPicture, GpuImage>> = {};
                const keep = (name: ComparedPicture, image: GpuImage | null | undefined) => {
                    if (!image) return;
                    const copy = this.gpu.image(image.width, image.height, image.kind, image.precision);
                    this.gpu.copy(image, copy);
                    kept[name] = copy;
                };
                for (const name of COMPARED_CHANNELS) keep(name, outputs[name]);
                // The mask view shows the watched layer's mask: kept as it stood then too.
                if (watched) keep('mask', this.stack.cachedMask(watched, tile));
                images.set(tile, kept);
            }
            this.comparison = { entry: target, label: target?.label ?? 'Before these steps', images, wipe: 0.5 };
        } finally {
            this.goTo(back);
            await this.stack.compose().catch(() => undefined);
            this.busy = null;
            this.emit();
        }
    }

    /** Ends a comparison, letting go of the pictures it kept. */
    stopComparing(): void {
        if (!this.comparison) return;
        for (const images of this.comparison.images.values()) for (const image of Object.values(images)) this.gpu.release(image);
        this.comparison = null;
        this.emit();
    }

    /** Moves the comparison's wipe (0 left to 1 right). */
    setCompareWipe(wipe: number): void {
        if (!this.comparison) return;
        this.comparison.wipe = Math.min(1, Math.max(0, wipe));
        this.emit();
    }

    get canUndo(): boolean { return this.past.length > 0 && this.usable && !this.lockReason; }
    /** The step undo would take back now, or null. */
    get latest(): HistoryEntry | null { return this.past[this.past.length - 1] ?? null; }
    get canRedo(): boolean { return this.future.length > 0 && this.usable && !this.lockReason; }
    get undoLabel(): string | null { return this.past[this.past.length - 1]?.label ?? null; }
    get redoLabel(): string | null { return this.future[this.future.length - 1]?.label ?? null; }

    undo(): void {
        if (!this.usable || this.lockReason) return;
        const entry = this.past.pop();
        if (!entry) return;
        this.coalesceKey = null;
        if (entry.pixels) applyPixelHistory(this.stack, entry.pixels, 'undo');
        if (entry.document) this.stack.setDocument(entry.document.before);
        if (entry.bakeMaps) this.stack.takeBake(entry.bakeMaps.before);
        this.future.push(entry);
        // Undoing a stroke keeps the pixels it undid, for redo: the history may now hold too much.
        if (entry.pixels) {
            this.trimHistory();
            this.dropUnusedPictures();
        }
        this.dirty();
        this.emit();
    }

    redo(): void {
        if (!this.usable || this.lockReason) return;
        const entry = this.future.pop();
        if (!entry) return;
        this.coalesceKey = null;
        if (entry.pixels) applyPixelHistory(this.stack, entry.pixels, 'redo');
        if (entry.document) this.stack.setDocument(entry.document.after);
        if (entry.bakeMaps) this.stack.takeBake(entry.bakeMaps.after);
        this.past.push(entry);
        this.dirty();
        this.emit();
    }

    // -----------------------------------------------------------------------
    // Saving
    // -----------------------------------------------------------------------

    private dirty(): void {
        this.changedSinceApply = true;
        if (this.saveTimer) clearTimeout(this.saveTimer);
        // Never saved from a lost GPU context (what it reads back is blank), while locked, or once replaced.
        if (!this.usable || this.lockReason || this.retired) { this.saveTimer = null; return; }
        this.saveTimer = setTimeout(() => { void this.save(); }, SAVE_DELAY_MS);
    }

    /** Keeps the document (its layers and the pictures it names) in the project, without keeping any picture. */
    private async keepDocument(): Promise<void> {
        const current = materialLibrary.get(this.asset.id) ?? this.asset;
        this.asset = { ...current, paint: this.stack.document as unknown as Record<string, unknown> };
        materialLibrary.upsert(this.asset);
        await projectService.applyChanges([{ domain: MATERIALS_DOMAIN, operation: 'upsert', id: this.asset.id, value: materialAssetDocument(this.asset) }]);
    }

    /** Keeps changed pictures and the document in the project (never from a lost GPU context). */
    async save(): Promise<void> {
        if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
        if (this.saving) { await this.saving; }
        if (!this.usable || this.lockReason || this.retired) return;
        this.saving = (async () => {
            try {
                await this.stack.keepPictures();
                await this.keepDocument();
                this.status = null;
            } catch (error) {
                if (error instanceof GpuResetError) {
                    this.status = error.message;
                } else {
                    frontendDiagnostics.failure('paint_save_failed', error);
                    this.status = 'The painting could not be saved: is a project open?';
                }
            } finally {
                this.saving = null;
                this.emit();
            }
        })();
        await this.saving;
    }

    /**
     * Changes the set's picture size (a power of two). The work is kept first; the set must then be
     * opened again, which scales painted pictures and baked maps to the new size.
     */
    async resize(size: number): Promise<boolean> {
        if (this.busy || size === this.stack.document.size || !this.usable) return false;
        this.busy = 'Changing the picture size';
        this.emit();
        try {
            await this.save();
            this.stack.document = { ...this.stack.document, size };
            await this.save();
            // Undo steps hold pixels at the old size.
            this.past = [];
            this.future = [];
            this.branches = [];
            this.changedSinceApply = true;
            return true;
        } finally {
            this.busy = null;
            this.emit();
        }
    }

    // -----------------------------------------------------------------------
    // Baking
    // -----------------------------------------------------------------------

    /**
     * Bakes the mesh maps at the bake's own size (supersampled as it says), kept at the set's size. A cage
     * model, for a cage from a mesh, must be the low-poly model pushed out: the same vertices in the same order.
     */
    /** Puts a new bake in place, keeps it in the project, and records it as a step that undo can take back. */
    private async keepNewBake(result: Map<number, TileBake>, label: string, keep: () => Promise<PaintDocument>): Promise<void> {
        const documentBefore = this.stack.document;
        const before = this.stack.takeBake(result);
        this.busy = 'Keeping the maps';
        this.emit();
        const document = await keep();
        this.stack.setDocument(document);
        this.record({ label, document: { before: documentBefore, after: document }, bakeMaps: { before, after: result } });
        await this.save();
    }

    /**
     * Bakes the detail maps again only where skew or cage fixes were painted since the last bake (it needs
     * the high-poly model); occlusion, curvature and the rest stay as they were.
     */
    async rebakeRegion(settings: BakeSettings, highPoly: THREE.Object3D | null, signal?: AbortSignal): Promise<void> {
        if (this.busy || !this.usable) return;
        const current = this.stack.bake;
        if (!current || !this.stack.bakeFixChanged.size) return;
        if (!highPoly) { this.status = 'Rebaking a region carries detail over from the high-poly model: pick it under "Detail from".'; this.emit(); return; }
        this.busy = 'Baking the changed region again';
        this.progress = 0;
        this.emit();
        const fixes = { skew: this.stack.bakeFixImages('skew'), cage: this.stack.bakeFixImages('cage') };
        try {
            const space = this.stack.space();
            const result = await rebakeRegion(this.gpu, {
                part: this.part,
                space: { centre: space.centre, extent: space.extent },
                occluder: this.occluder,
                highPoly: buildHighPoly(highPoly),
                fixes,
            }, settings, current, new Map(this.stack.bakeFixChanged), this.stack.document.size, (fraction, step) => {
                this.progress = fraction;
                this.busy = step;
                this.emit();
            }, signal);
            if (!this.usable) throw new GpuResetError();
            await this.keepNewBake(result, 'Bake the changed region again', () => this.stack.keepBake(settings, { centre: space.centre, extent: space.extent }));
            this.stack.bakeFixChanged.clear();
            this.status = 'The changed region was baked again.';
        } catch (error) {
            if (error instanceof GpuResetError) this.status = error.message;
            else if ((error as Error)?.name !== 'AbortError') {
                frontendDiagnostics.failure('paint_bake_failed', error);
                this.status = error instanceof Error ? error.message : 'The region could not be baked again.';
            }
        } finally {
            for (const image of [...fixes.skew.values(), ...fixes.cage.values()]) this.gpu.release(image);
            this.busy = null;
            this.progress = 0;
            this.emit();
        }
    }

    async bake(settings: BakeSettings, highPoly: THREE.Object3D | null, signal?: AbortSignal, cageModel: THREE.Object3D | null = null): Promise<void> {
        if (this.busy || !this.usable) return;
        this.busy = 'Baking mesh maps';
        this.progress = 0;
        this.emit();
        try {
            const material = this.target.materials[0] as THREE.MeshStandardMaterial | undefined;
            // A set made before spaces were kept moves into the model's own with this bake, unless a fill
            // cast from three sides would shift with it: then the position map keeps to the set's box.
            const adopt = !this.stack.document.space && !castsFromThreeSides(this.stack.document.layers);
            const space = adopt ? this.modelSpace : this.stack.space();
            let cage: Float32Array | null = null;
            if (settings.cage === 'mesh') {
                if (!cageModel) throw new Error('Pick the cage model: the low-poly model pushed out past the high-poly one.');
                const names = new Set(this.target.materialNames);
                const cageMaterials = new Set<THREE.Material>();
                cageModel.traverse((child) => {
                    const mesh = child as THREE.Mesh;
                    if (!mesh.isMesh) return;
                    for (const each of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (names.has(each.name) || !names.size) cageMaterials.add(each);
                });
                const cagePart = buildPartMesh(cageModel, cageMaterials.size ? cageMaterials : null, { udim: this.part.udim });
                cage = meshCage(this.part.positions, cagePart.positions);
                if (!cage) throw new Error('The cage model must be this model pushed out, with the same vertices: it has a different number of them.');
            }
            // Fixes painted onto the model are read by the bake.
            const fixes = { skew: this.stack.bakeFixImages('skew'), cage: this.stack.bakeFixImages('cage') };
            let result: Map<number, TileBake>;
            try {
                result = await bakeMeshMaps(this.gpu, {
                    part: this.part,
                    space: { centre: space.centre, extent: space.extent },
                    occluder: this.occluder,
                    highPoly: highPoly ? buildHighPoly(highPoly) : undefined,
                    normalMap: material ? ownMaps(material).normalMap : null,
                    cage,
                    fixes,
                }, settings, (fraction, step) => {
                    this.progress = fraction;
                    this.busy = step;
                    this.emit();
                }, signal, this.stack.document.size);
            } finally {
                for (const image of [...fixes.skew.values(), ...fixes.cage.values()]) this.gpu.release(image);
            }
            // Maps baked across a GPU reset are blank: they are neither used nor kept.
            if (!this.usable) throw new GpuResetError();
            await this.keepNewBake(result, 'Bake mesh maps', () => this.stack.keepBake(settings, { centre: space.centre, extent: space.extent }, adopt));
            this.stack.bakeFixChanged.clear();
            this.status = 'Mesh maps baked. Smart masks and materials now follow this surface.';
        } catch (error) {
            if (error instanceof GpuResetError) this.status = error.message;
            else if ((error as Error)?.name !== 'AbortError') {
                frontendDiagnostics.failure('paint_bake_failed', error);
                this.status = error instanceof Error ? error.message : 'The maps could not be baked.';
            }
        } finally {
            this.busy = null;
            this.progress = 0;
            this.emit();
        }
    }

    // -----------------------------------------------------------------------
    // Giving the model the pictures, and exporting them
    // -----------------------------------------------------------------------

    /** Makes the finished pictures, keeps them, and points the surface's materials at a material drawing with them. */
    async apply(): Promise<void> {
        if (this.busy || !this.usable) return;
        this.busy = 'Making the pictures';
        this.emit();
        try {
            await this.stack.compose();
            await this.save();
            if (!this.usable) throw new GpuResetError();
            const tiles = this.stack.tiles;
            const size = this.stack.size;
            const flipRows = overrideTextureFlipY(this.target.object);
            // A set over several UDIM tiles goes on as one picture per channel with every tile in its place,
            // read by the material with the coordinates scaled to the grid; one tile goes on as it is.
            const idleBefore = this.gpu.memory.idle;
            const atlas = tiles.length > 1 ? tileAtlas(this.gpu, tiles, (tile) => this.stack.channelImages(tile), size) : null;
            const images = atlas ? atlas.images : this.stack.channelImages(tiles[0]);
            const width = atlas ? atlas.width : size;
            const height = atlas ? atlas.height : size;
            let pictures: Awaited<ReturnType<typeof encodeChannels>>;
            try {
                pictures = await encodeChannels(this.gpu, images, width, height, 'engine', flipRows);
            } finally {
                if (atlas) {
                    for (const image of Object.values(atlas.images)) this.gpu.release(image);
                    // Pictures the size of the whole grid serve nothing else: they are let go at once
                    // (the largest idle pictures go first).
                    this.gpu.trimPool(idleBefore);
                }
            }
            // Pictures read back across a GPU reset are blank: the model keeps what it wears.
            if (!this.usable) throw new GpuResetError();
            const ids: ChannelTextureIds = {};
            const folder = `Painted/${this.target.modelName.replace(/\.[^.]+$/, '')}`;
            for (const picture of pictures) {
                this.busy = `Keeping ${ROLE_LABELS[picture.role].toLowerCase()}`;
                this.emit();
                ids[picture.role] = await this.host.storeTexture(picture.blob, `${this.target.partName} ${ROLE_LABELS[picture.role]}`, { width, height }, folder);
            }
            const previous = Object.values(this.stack.document.applied?.textures ?? {}).filter((id): id is string => Boolean(id));
            const document: PaintDocument = { ...this.stack.document, applied: { textures: ids, at: Date.now() } };
            this.stack.setDocument(document);
            this.asset = {
                ...(materialLibrary.get(this.asset.id) ?? this.asset),
                // Only the material's pictures change; a surface graph edited by hand keeps its edits.
                ...rewriteMaterialPictures(materialLibrary.get(this.asset.id) ?? this.asset, ids, { opacityMode: images.opacity ? 'masked' : undefined, tiles: atlas ?? undefined }),
                paint: document as unknown as Record<string, unknown>,
            };
            materialLibrary.upsert(this.asset);
            await projectService.applyChanges([{ domain: MATERIALS_DOMAIN, operation: 'upsert', id: this.asset.id, value: materialAssetDocument(this.asset) }]);
            // The surface's materials draw with the painted material from now on.
            const overrides: MaterialOverrides = { ...(this.host.materialOverrides(this.target.modelId) ?? {}) };
            for (const name of this.target.materialNames) overrides[name] = { ...(overrides[name] ?? {}), materialId: this.asset.id };
            await this.host.setMaterialOverrides(this.target.modelId, overrides);
            // The old pictures go only once no save still in flight names them (an autosave begun before they changed).
            if (this.saving) await this.saving.catch(() => undefined);
            void this.host.discardTextures(previous);
            this.changedSinceApply = false;
            this.status = !atlas
                ? 'The model now wears this painting.'
                : atlas.cell < size
                    ? `The model now wears all ${tiles.length} UDIM tiles of this set, each at ${atlas.cell} × ${atlas.cell} so they fit one picture this machine can hold.`
                    : `The model now wears all ${tiles.length} UDIM tiles of this set.`;
        } catch (error) {
            if (!(error instanceof GpuResetError)) frontendDiagnostics.failure('paint_apply_failed', error);
            this.status = error instanceof Error ? error.message : 'The pictures could not be given to the model.';
        } finally {
            this.busy = null;
            this.emit();
        }
    }

    /**
     * One picture packed on the GPU from the maps it reads (missing maps at their usual blank values), read
     * back as rows from the top of the UV square unless `flipRows`; past the islands black unless `padding`.
     */
    private packPicture(picture: ExportPicture, images: Partial<Record<ExportSource, GpuImage>>, coverage: GpuImage | null, width: number, height: number, options: { directX: boolean; padding: boolean; flipRows: boolean }): PictureData {
        const fallback: Record<ExportSource, 'white' | 'black' | 'mid' | 'normal'> = { baseColor: 'mid', normal: 'normal', roughness: 'mid', metallic: 'black', height: 'mid', emissive: 'black', opacity: 'white', ambientOcclusion: 'white' };
        const plan = planPicture(picture);
        const slotOf = (c: number) => { const channel = plan.channels[c]; return channel && 'slot' in channel ? channel.slot : -1; };
        const packed = this.gpu.image(width, height, 'color', 32);
        this.gpu.passNow(packed, {
            fragment: PACK_PICTURE,
            inputs: {
                ...Object.fromEntries([0, 1, 2, 3].map((slot) => {
                    const source = plan.sources[slot];
                    return [`s${slot}`, source ? images[source] ?? this.gpu.constant(fallback[source]) : this.gpu.constant('black')];
                })),
                cover: coverage ?? this.gpu.constant('white'),
            },
            uniforms: {
                uSlot: new THREE.Vector4(slotOf(0), slotOf(1), slotOf(2), slotOf(3)),
                uComponent: new THREE.Vector4(...[0, 1, 2, 3].map((c) => { const channel = plan.channels[c]; return channel && 'component' in channel ? channel.component : 0; })),
                uValue: new THREE.Vector4(...[0, 1, 2, 3].map((c) => { const channel = plan.channels[c]; return channel && 'value' in channel ? channel.value : c === 3 ? 1 : 0; })),
                uFlip: new THREE.Vector4(...[0, 1, 2, 3].map((c) => (options.directX && picture.channels[c] && holdsNormalGreen(picture.channels[c]) ? 1 : 0))),
                uGray: new THREE.Vector4(...[0, 1, 2, 3].map((slot) => { const source = plan.sources[slot]; return source && images[source]?.kind === 'gray' ? 1 : 0; })),
                uPadding: options.padding || !coverage ? 1 : 0,
            },
        });
        const floats = this.gpu.readFloat(packed);
        this.gpu.release(packed);
        if (!this.usable) throw new GpuResetError();
        const channels = picture.channels.length as 1 | 3 | 4;
        const data = new Float32Array(width * height * channels);
        for (let y = 0; y < height; y++) {
            // Read bottom row first: the file's first row is the top of the UV square unless flipped.
            const row = options.flipRows ? height - 1 - y : y;
            for (let x = 0; x < width; x++) for (let c = 0; c < channels; c++) data[(y * width + x) * channels + c] = floats[(row * width + x) * 4 + c];
        }
        return { width, height, channels, data };
    }

    /**
     * This set's glTF material: the painted maps packed as glTF reads them (base colour and opacity,
     * occlusion-roughness-metallic, normal, emission) and the factors and extensions its material document
     * uses. A set over several UDIM tiles is laid on one atlas, given back with it.
     */
    private async setGltfParts(name: string): Promise<{ surface: GltfSurface; pictures: GltfPictures; atlas: TileLayout | null }> {
        await this.stack.compose();
        if (!this.usable) throw new GpuResetError();
        const set = this.target.partName;
        const tiles = this.stack.tiles;
        const size = this.stack.size;
        const idleBefore = this.gpu.memory.idle;
        const atlas = tiles.length > 1 ? tileAtlas(this.gpu, tiles, (tile) => this.stack.channelImages(tile), size) : null;
        const pictures: GltfPictures = {};
        let surface: GltfSurface;
        try {
            const images = (atlas ? atlas.images : this.stack.channelImages(tiles[0])) as Partial<Record<ExportSource, GpuImage>>;
            const coverage = atlas ? null : this.stack.coverage(tiles[0]);
            const width = atlas ? atlas.width : size;
            const height = atlas ? atlas.height : size;
            const painted = new Set(Object.keys(images) as ExportSource[]);
            surface = surfaceOfGraph((materialLibrary.get(this.asset.id) ?? this.asset).graph, `${set} (painted)`, painted);
            // glTF reads the first row of a picture at the top of the UV square: rows as they are.
            const png = async (picture: ExportPicture) => new Uint8Array(await (await writePicture(this.packPicture(picture, images, coverage, width, height, { directX: false, padding: true, flipRows: false }), 'png8')).arrayBuffer());
            const map = (from: ExportSource, component: 0 | 1 | 2 | 3 = 0): ChannelSource => ({ from, component });
            const colour = painted.has('baseColor');
            if (colour || painted.has('opacity')) {
                pictures.baseColor = await png({ name, channels: [colour ? map('baseColor', 0) : { value: 1 }, colour ? map('baseColor', 1) : { value: 1 }, colour ? map('baseColor', 2) : { value: 1 }, ...(painted.has('opacity') ? [map('opacity')] : [])] });
            }
            const metallicRoughness = painted.has('roughness') || painted.has('metallic');
            if (metallicRoughness || painted.has('ambientOcclusion')) {
                // A map the set does not paint takes the material's own value (its factor then stays at one).
                pictures.orm = {
                    png: await png({ name, channels: [painted.has('ambientOcclusion') ? map('ambientOcclusion') : { value: 1 }, painted.has('roughness') ? map('roughness') : { value: surface.roughness }, painted.has('metallic') ? map('metallic') : { value: surface.metalness }] }),
                    occlusion: painted.has('ambientOcclusion'),
                    metallicRoughness,
                };
                if (metallicRoughness) surface = { ...surface, roughness: 1, metalness: 1 };
            }
            if (painted.has('normal')) pictures.normal = await png({ name, channels: [map('normal', 0), map('normal', 1), map('normal', 2)] });
            if (painted.has('emissive')) pictures.emissive = await png({ name, channels: [map('emissive', 0), map('emissive', 1), map('emissive', 2)] });
        } finally {
            if (atlas) {
                for (const image of Object.values(atlas.images)) this.gpu.release(image);
                this.gpu.trimPool(idleBefore);
            }
        }
        if (!this.usable) throw new GpuResetError();
        return { surface, pictures, atlas };
    }

    /**
     * The painted pictures another texture set of the model wears (those its painting was last put on
     * with), as a glTF material; null when it has none or they have not loaded yet.
     */
    private async keptGltfParts(asset: MaterialAsset): Promise<{ surface: GltfSurface; pictures: GltfPictures } | null> {
        const document = asset.paint ? readPaintDocument(asset.paint) : null;
        const ids = document?.applied?.textures;
        if (!ids) return null;
        const textureOf = (role: keyof typeof ids) => (ids[role] ? this.host.texture(ids[role]!) : null);
        const loaded = (texture: THREE.Texture | null): texture is THREE.Texture => Boolean((texture?.image as { width?: number } | undefined)?.width);
        const base = textureOf('baseColor'), opacity = textureOf('opacity'), orm = textureOf('orm'), normal = textureOf('normal'), emissive = textureOf('emissive');
        const painted = new Set<ExportSource>();
        if (loaded(base)) painted.add('baseColor');
        if (loaded(opacity)) painted.add('opacity');
        if (loaded(orm)) { painted.add('roughness'); painted.add('metallic'); painted.add('ambientOcclusion'); }
        if (loaded(normal)) painted.add('normal');
        if (loaded(emissive)) painted.add('emissive');
        if (!painted.size) return null;
        let surface = surfaceOfGraph(asset.graph, asset.name, painted);
        // Each picture drawn as it is laid (its rows read as the model reads them) and written for glTF.
        const write = async (inputs: { a: THREE.Texture; b?: THREE.Texture | null }, channels: 3 | 4): Promise<Uint8Array> => {
            const image = inputs.a.image as { width: number; height: number };
            const out = this.gpu.image(image.width, image.height, 'color', 32);
            this.gpu.passNow(out, {
                fragment: 'uniform int uHasB;\nvoid main() { vec4 c = texture(a, vUv); outColor = vec4(c.rgb, uHasB == 1 ? texture(b, vUv).r : 1.0); }',
                inputs: { a: inputs.a, b: inputs.b ?? this.gpu.constant('white') },
                uniforms: { uHasB: inputs.b ? 1 : 0 },
            });
            const floats = this.gpu.readFloat(out);
            this.gpu.release(out);
            const data = new Float32Array(image.width * image.height * channels);
            for (let i = 0; i < image.width * image.height; i++) for (let c = 0; c < channels; c++) data[i * channels + c] = floats[i * 4 + c];
            return new Uint8Array(await (await writePicture({ width: image.width, height: image.height, channels, data }, 'png8')).arrayBuffer());
        };
        const pictures: GltfPictures = {};
        if (loaded(base)) pictures.baseColor = await write({ a: base, b: loaded(opacity) ? opacity : null }, loaded(opacity) ? 4 : 3);
        if (loaded(orm)) { pictures.orm = { png: await write({ a: orm }, 3), occlusion: true, metallicRoughness: true }; surface = { ...surface, roughness: 1, metalness: 1 }; }
        if (loaded(normal)) pictures.normal = await write({ a: normal }, 3);
        if (loaded(emissive)) pictures.emissive = await write({ a: emissive }, 3);
        return { surface, pictures };
    }

    /**
     * The painted set as a binary glTF with its material: the painted maps (base colour and opacity,
     * occlusion-roughness-metallic, normal, emission) inside the file, and the factors and KHR extensions
     * the material document uses. A set over several UDIM tiles goes on one atlas, its UVs moved to match.
     */
    async exportGltf(): Promise<void> {
        if (this.busy || !this.usable) return;
        this.busy = 'Making the glTF model';
        this.emit();
        try {
            const model = this.target.modelName.replace(/\.[^.]+$/, '');
            const name = fileName('$model_$set', { set: this.target.partName, model, tile: 1001, size: 0 });
            const { surface, pictures, atlas } = await this.setGltfParts(name);
            const mesh = atlas ? atlasMesh(this.part, atlas) : this.part;
            const glb = writePaintedGlb({ name, mesh, surface, pictures });
            download(new Blob([glb], { type: 'model/gltf-binary' }), `${name}.glb`);
            this.status = `Downloaded ${name}.glb${atlas ? ` (its ${this.stack.tiles.length} UDIM tiles on one picture)` : ''}.`;
        } catch (error) {
            if (!(error instanceof GpuResetError)) frontendDiagnostics.failure('paint_gltf_export_failed', error);
            this.status = error instanceof Error ? error.message : 'The glTF model could not be made.';
        } finally {
            this.busy = null;
            this.emit();
        }
    }

    /**
     * The whole model as a binary glTF: every mesh, its skin and its clips, every material; this set with
     * its painting as it is now, the model's other painted sets with the pictures their painting was last
     * put on with, the rest as the model has them. A painted set over several UDIM tiles is laid on one
     * atlas, its meshes' texture coordinates moved to match (vertex by vertex).
     */
    async exportModelGltf(): Promise<void> {
        if (this.busy || !this.usable) return;
        this.busy = 'Making the glTF model';
        this.emit();
        try {
            const model = this.target.modelName.replace(/\.[^.]+$/, '');
            const source = this.target.object;
            const copy = cloneSkinned(source);
            copy.animations = source.animations ?? [];
            // Which painted material each of the model's materials becomes: this set's, or another set's kept one.
            const mine = new Set(this.target.materialNames);
            const others = new Map<string, MaterialAsset>();
            const keyOf = (material: THREE.Material): string | null => {
                if (mine.has(material.name)) return 'open';
                const asset = findPaintAsset({ modelId: this.target.modelId, materialNames: [material.name] });
                if (!asset || asset.id === this.asset.id || !readPaintDocument(asset.paint)?.applied) return null;
                others.set(`asset:${asset.id}`, asset);
                return `asset:${asset.id}`;
            };
            // Meshes of this set over several tiles read the atlas.
            const tiles = this.stack.tiles;
            const atlasLayout = tiles.length > 1 ? tileAtlasLayout(tiles, this.stack.size, this.gpu.maxSize) : null;
            if (atlasLayout) {
                copy.traverse((node) => {
                    const mesh = node as THREE.Mesh;
                    if (!mesh.isMesh) return;
                    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                    if (!materials.some((material) => mine.has(material.name))) return;
                    const uv = mesh.geometry.getAttribute('uv');
                    if (!uv) return;
                    mesh.geometry = mesh.geometry.clone();
                    mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(atlasUvs(uv.array, atlasLayout), 2));
                });
            }
            const keys = markPaintedMaterials(copy, keyOf);
            const painted = new Map<string, PaintedMaterial>();
            const name = fileName('$model_$set', { set: this.target.partName, model, tile: 1001, size: 0 });
            if (keys.has('open')) {
                const parts = await this.setGltfParts(name);
                painted.set('open', { name, ...parts });
            }
            const waiting: string[] = [];
            for (const [key, asset] of others) {
                if (!keys.has(key)) continue;
                const parts = await this.keptGltfParts(asset);
                if (parts) painted.set(key, { name: fileName(asset.name, { set: '', model, tile: 1001, size: 0 }), ...parts });
                else waiting.push(asset.name);
            }
            const exported = await new GLTFExporter().parseAsync(copy, { binary: true, animations: copy.animations, onlyVisible: false }) as ArrayBuffer;
            const glb = withPaintedMaterials(exported, painted);
            const file = `${fileName('$model', { set: '', model, tile: 1001, size: 0 })}.glb`;
            download(new Blob([glb], { type: 'model/gltf-binary' }), file);
            this.status = `Downloaded ${file}: ${painted.size} painted set${painted.size === 1 ? '' : 's'}${copy.animations.length ? `, ${copy.animations.length} clip${copy.animations.length === 1 ? '' : 's'}` : ''}${waiting.length ? `; ${waiting.join(', ')} went with ${waiting.length === 1 ? 'its' : 'their'} own material, as ${waiting.length === 1 ? 'its' : 'their'} painted pictures had not loaded` : ''}.`;
        } catch (error) {
            if (!(error instanceof GpuResetError)) frontendDiagnostics.failure('paint_gltf_export_failed', error);
            this.status = error instanceof Error ? error.message : 'The glTF model could not be made.';
        } finally {
            this.busy = null;
            this.emit();
        }
    }

    /**
     * A ZIP of the set's pictures as an export template lays them out: each picture packed on the GPU from
     * the maps it reads, at each size the template asks for, for every tile, written as the template's file
     * kind. Rows run from the top of the UV square unless `flipRows` (bottom-left UV origins).
     */
    async exportWithTemplate(template: ExportTemplate, flipRows: boolean): Promise<void> {
        if (this.busy || !this.usable) return;
        this.busy = 'Making the pictures';
        this.emit();
        try {
            await this.stack.compose();
            const model = this.target.modelName.replace(/\.[^.]+$/, '');
            const set = this.target.partName;
            const sizes = template.sizes.length ? template.sizes : [this.stack.document.size];
            const tiles = this.stack.tiles;
            const files: Array<{ name: string; data: Blob }> = [];
            for (const power of sizes) {
                const size = 2 ** power;
                for (const tile of tiles) {
                    const images = this.stack.channelImages(tile) as Partial<Record<ExportSource, GpuImage>>;
                    const coverage = this.stack.coverage(tile);
                    for (const picture of template.pictures) {
                        const packed = this.packPicture(picture, images, coverage, size, size, { directX: template.normal === 'directX', padding: template.padding, flipRows });
                        let name = fileName(picture.name, { set, model, tile, size });
                        if (tiles.length > 1 && !picture.name.includes('$tile')) name += `.${tile}`;
                        files.push({ name: `${sizes.length > 1 ? `${size}/` : ''}${name}.${extensionOf(template.format)}`, data: await writePicture(linearChannels(packed, colourChannels(picture, template.format)), template.format) });
                    }
                }
            }
            download(await makeZip(files), `${fileName('$model_$set', { set, model, tile: tiles[0], size: 2 ** sizes[0] })}_${fileName(template.name, { set, model, tile: tiles[0], size: 0 })}.zip`);
        } catch (error) {
            this.status = error instanceof Error ? error.message : 'The pictures could not be made.';
        } finally {
            this.busy = null;
            this.emit();
        }
    }

    /** A ZIP of every channel of every tile, named as texture sets usually are. */
    async exportPictures(layout: PictureLayout, flipRows: boolean): Promise<void> {
        if (this.busy || !this.usable) return;
        this.busy = 'Making the pictures';
        this.emit();
        try {
            await this.stack.compose();
            const base = `${this.target.modelName.replace(/\.[^.]+$/, '')}_${this.target.partName}`.replace(/[^\w-]+/g, '_');
            const files: Array<{ name: string; data: Blob }> = [];
            for (const tile of this.stack.tiles) {
                const pictures = await encodeChannels(this.gpu, this.stack.channelImages(tile), this.stack.size, this.stack.size, layout, flipRows, DEEP_EXPORT);
                const suffix = this.stack.tiles.length > 1 ? `.${tile}` : '';
                for (const picture of pictures) files.push({ name: `${base}_${picture.role}${suffix}.png`, data: picture.blob });
            }
            if (!this.usable) throw new GpuResetError();
            download(await makeZip(files), `${base}_${this.stack.size}.zip`);
        } catch (error) {
            this.status = error instanceof Error ? error.message : 'The pictures could not be made.';
        } finally {
            this.busy = null;
            this.emit();
        }
    }

    /** Lets go of the copies of pictures the fill graphs read. */
    private releasePictures: () => void = () => undefined;
    /** Says the set's stack is no longer open to graphs. */
    private closeStack: () => void = () => undefined;

    dispose(): void {
        this.stopComparing();
        this.closeStack();
        this.stopListening();
        this.releasePictures();
        // Maps bake steps held for undo go with the set.
        for (const entry of [...this.past, ...this.future, ...this.branches.flatMap((branch) => branch.steps)]) { this.letGoOfBake(entry.bakeMaps?.before ?? null); this.letGoOfBake(entry.bakeMaps?.after ?? null); }
        this.restoredListeners.clear();
        // Saved on closing (save itself refuses to keep anything from a lost GPU context).
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            void this.save().finally(() => this.stack.dispose());
        } else this.stack.dispose();
        this.listeners.clear();
    }
}
