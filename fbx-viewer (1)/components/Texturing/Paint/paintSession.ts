import * as THREE from 'three';
import { frontendDiagnostics } from '../../../diagnostics/runtime';
import { ownMaps } from '../../../runtime/materials/graphMaterial';
import { materialLibrary, MATERIALS_DOMAIN, materialAssetDocument, type MaterialAsset } from '../../../runtime/materials/materialLibrary';
import { createMaterialGraph } from '../../../runtime/materials/materialGraph';
import { projectService } from '../../../utils/projectService';
import { overrideTextureFlipY, type MaterialOverrides } from '../../../utils/materialOverrides';
import { bakeMeshMaps, spaceOfBox, type BakeSettings, type PositionSpace } from '../../../texturing/bake/meshBaker';
import { textureGpu, type TextureGpu } from '../../../texturing/gpu/textureGpu';
import type { GraphEntry, GraphResolver } from '../../../texturing/graph/registry';
import { readStoredGraph } from '../../../texturing/graph/stored';
import { buildHighPoly, buildPartMesh, buildWholeMesh, type PartMesh } from '../../../texturing/mesh/partMesh';
import { meshCage } from '../../../texturing/bake/bakeSetup';
import type { SurfacePicker } from '../../../texturing/mesh/picker';
import { SurfaceSelector } from '../../../texturing/paint/selection';
import { DEEP_EXPORT, ROLE_LABELS, encodeChannels, materialGraphForTextures, tileAtlas, type ChannelTextureIds, type PictureLayout } from '../../../texturing/materialOutput';
import { GpuResetError, PaintStack, pictureOwners, type StackHost } from '../../../texturing/paint/paintStack';
import { BUILTIN_GRAPHS } from '../../../texturing/paint/smartLibrary';
import { applyPixelHistory, trimmedHistory, type HistoryEntry } from '../../../texturing/paint/strokes';
import { castsFromThreeSides, createPaintDocument, newFillLayer, paintId, readPaintDocument, type PaintChannel, type PaintDocument } from '../../../texturing/paint/paintTypes';
import { download, makeZip } from '../../../texturing/zip';
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

const HISTORY_LIMIT = 80;
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
        if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
        this.emit();
    }

    unlock(): void {
        this.lockReason = null;
        this.emit();
    }

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
            document = createPaintDocument(target.modelId, target.materialNames, 11);
            document.udim = part.udim;
            document.space = modelSpace;
            // Painting starts from what the surface wears now, never from nothing: its glow too, as the set
            // goes on the model in place of its material.
            const glows = Boolean(material?.emissiveMap) || Boolean(material?.emissive && material.emissive.getHex() !== 0 && material.emissiveIntensity > 0);
            if (glows) document.channels = [...document.channels, 'emissive'];
            const wears: PaintChannel[] = ['baseColor', 'roughness', 'metallic', 'normal', ...(glows ? ['emissive' as const] : [])];
            document.layers = [{ ...newFillLayer(document, 'What it wears now', Object.fromEntries(wears.map((channel) => [channel, { kind: 'current' as const }]))), id: paintId('l') }];
            asset = { id: crypto.randomUUID(), name: `${target.modelName.replace(/\.[^.]+$/, '')} ${target.partName} (painted)`.slice(0, 128), graph: createMaterialGraph(), paint: document as unknown as Record<string, unknown> };
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
        const stackHost: StackHost = {
            gpu: textureGpu(),
            resolveGraph: paintGraphResolver(),
            texture: host.texture,
            current,
            fetchPicture: async (assetId) => {
                const response = await projectService.fetchAsset(assetId);
                if (!response.ok) throw new Error('A painted picture could not be read.');
                return response.blob();
            },
            storePicture: (blob) => projectService.uploadAsset(new File([blob], 'painted.png', { type: 'image/png' })),
        };
        const stack = await PaintStack.open(stackHost, part, document);
        return new PaintSession(target, host, part, stack, asset, occluder, modelSpace);
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
        this.past.push(entry);
        this.future = [];
        this.trimHistory();
        this.dropUnusedPictures();
        if (entry.pixels) this.dirty();
        this.emit();
    }

    /** Keeps the history within its step count and its memory (oldest first, never the newest step). */
    private trimHistory(): void {
        this.past = trimmedHistory(this.past, this.future, HISTORY_LIMIT, HISTORY_BYTES);
    }

    /**
     * Lets go of the pictures of layers and mask effects that neither the set as it is nor any step of
     * its history uses (deleted, and out of reach of undo).
     */
    private dropUnusedPictures(): void {
        const documents: PaintDocument[] = [this.stack.document];
        for (const entry of [...this.past, ...this.future]) if (entry.document) documents.push(entry.document.before, entry.document.after);
        this.stack.dropPicturesExcept(pictureOwners(documents));
    }

    get canUndo(): boolean { return this.past.length > 0 && this.usable && !this.lockReason; }
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
            const result = await bakeMeshMaps(this.gpu, {
                part: this.part,
                space: { centre: space.centre, extent: space.extent },
                occluder: this.occluder,
                highPoly: highPoly ? buildHighPoly(highPoly) : undefined,
                normalMap: material ? ownMaps(material).normalMap : null,
                cage,
            }, settings, (fraction, step) => {
                this.progress = fraction;
                this.busy = step;
                this.emit();
            }, signal, this.stack.document.size);
            // Maps baked across a GPU reset are blank: they are neither used nor kept.
            if (!this.usable) throw new GpuResetError();
            this.stack.setBake(result);
            this.busy = 'Keeping the maps';
            this.emit();
            const document = await this.stack.keepBake(settings, { centre: space.centre, extent: space.extent }, adopt);
            this.stack.setDocument(document);
            await this.save();
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
                graph: materialGraphForTextures(ids, { opacityMode: images.opacity ? 'masked' : undefined, tiles: atlas ?? undefined }),
                paint: document as unknown as Record<string, unknown>,
            };
            materialLibrary.upsert(this.asset);
            await projectService.applyChanges([{ domain: MATERIALS_DOMAIN, operation: 'upsert', id: this.asset.id, value: materialAssetDocument(this.asset) }]);
            // The surface's materials draw with the painted material from now on.
            const overrides: MaterialOverrides = { ...(this.host.materialOverrides(this.target.modelId) ?? {}) };
            for (const name of this.target.materialNames) overrides[name] = { ...(overrides[name] ?? {}), materialId: this.asset.id };
            await this.host.setMaterialOverrides(this.target.modelId, overrides);
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

    dispose(): void {
        this.stopListening();
        this.restoredListeners.clear();
        // Saved on closing (save itself refuses to keep anything from a lost GPU context).
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            void this.save().finally(() => this.stack.dispose());
        } else this.stack.dispose();
        this.listeners.clear();
    }
}
