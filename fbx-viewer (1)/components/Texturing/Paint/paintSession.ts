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
import { buildPartMesh, buildWholeMesh, type PartMesh } from '../../../texturing/mesh/partMesh';
import { SurfacePicker } from '../../../texturing/mesh/picker';
import { DEEP_EXPORT, ROLE_LABELS, encodeChannels, materialGraphForTextures, tileAtlas, type ChannelTextureIds, type PictureLayout } from '../../../texturing/materialOutput';
import { PaintStack, type StackHost } from '../../../texturing/paint/paintStack';
import { BUILTIN_GRAPHS } from '../../../texturing/paint/smartLibrary';
import { applyPixelHistory, type HistoryEntry } from '../../../texturing/paint/strokes';
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

    private constructor(readonly target: PaintTarget, readonly host: PaintSessionHost, part: PartMesh, stack: PaintStack, asset: MaterialAsset,
        occluder: PaintSession['occluder'], readonly modelSpace: PositionSpace) {
        this.gpu = stack.host.gpu;
        this.part = part;
        this.picker = new SurfacePicker(part);
        this.occluder = occluder;
        this.stack = stack;
        this.asset = asset;
        stack.subscribe(() => this.emit());
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
        this.dirty();
    }

    /** A step already made (a brush stroke) goes into the history. */
    record(entry: HistoryEntry): void {
        this.past.push(entry);
        if (this.past.length > HISTORY_LIMIT) this.past.shift();
        this.future = [];
        if (entry.pixels) this.dirty();
        this.emit();
    }

    get canUndo(): boolean { return this.past.length > 0; }
    get canRedo(): boolean { return this.future.length > 0; }
    get undoLabel(): string | null { return this.past[this.past.length - 1]?.label ?? null; }

    undo(): void {
        const entry = this.past.pop();
        if (!entry) return;
        this.coalesceKey = null;
        if (entry.pixels) applyPixelHistory(this.stack, entry.pixels, 'undo');
        if (entry.document) this.stack.setDocument(entry.document.before);
        this.future.push(entry);
        this.dirty();
        this.emit();
    }

    redo(): void {
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
        this.saveTimer = setTimeout(() => { void this.save(); }, SAVE_DELAY_MS);
    }

    /** Keeps changed pictures and the document in the project. */
    async save(): Promise<void> {
        if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
        if (this.saving) { await this.saving; }
        this.saving = (async () => {
            try {
                const document = await this.stack.keepPictures();
                const current = materialLibrary.get(this.asset.id) ?? this.asset;
                this.asset = { ...current, paint: document as unknown as Record<string, unknown> };
                materialLibrary.upsert(this.asset);
                await projectService.applyChanges([{ domain: MATERIALS_DOMAIN, operation: 'upsert', id: this.asset.id, value: materialAssetDocument(this.asset) }]);
                this.status = null;
            } catch (error) {
                frontendDiagnostics.failure('paint_save_failed', error);
                this.status = 'The painting could not be saved: is a project open?';
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
        if (this.busy || size === this.stack.document.size) return false;
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

    async bake(settings: BakeSettings, highPoly: THREE.Object3D | null, signal?: AbortSignal): Promise<void> {
        if (this.busy) return;
        this.busy = 'Baking mesh maps';
        this.progress = 0;
        this.emit();
        try {
            const material = this.target.materials[0] as THREE.MeshStandardMaterial | undefined;
            // A set made before spaces were kept moves into the model's own with this bake, unless a fill
            // cast from three sides would shift with it: then the position map keeps to the set's box.
            const adopt = !this.stack.document.space && !castsFromThreeSides(this.stack.document.layers);
            const space = adopt ? this.modelSpace : this.stack.space();
            const result = await bakeMeshMaps(this.gpu, {
                part: this.part,
                space: { centre: space.centre, extent: space.extent },
                occluder: this.occluder,
                highPoly: highPoly ? buildWholeMesh(highPoly) : undefined,
                normalMap: material ? ownMaps(material).normalMap : null,
            }, { ...settings, size: this.stack.document.size }, (fraction, step) => {
                this.progress = fraction;
                this.busy = step;
                this.emit();
            }, signal);
            this.stack.setBake(result);
            this.busy = 'Keeping the maps';
            this.emit();
            const document = await this.stack.keepBake(settings, { centre: space.centre, extent: space.extent }, adopt);
            this.stack.setDocument(document);
            await this.save();
            this.status = 'Mesh maps baked. Smart masks and materials now follow this surface.';
        } catch (error) {
            if ((error as Error)?.name !== 'AbortError') {
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
        if (this.busy) return;
        this.busy = 'Making the pictures';
        this.emit();
        try {
            await this.stack.compose();
            await this.save();
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
                graph: materialGraphForTextures(ids, { opacityMode: images.opacity ? 'masked' : undefined, tiles: atlas ? { columns: atlas.columns, rows: atlas.rows } : undefined }),
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
            frontendDiagnostics.failure('paint_apply_failed', error);
            this.status = error instanceof Error ? error.message : 'The pictures could not be given to the model.';
        } finally {
            this.busy = null;
            this.emit();
        }
    }

    /** A ZIP of every channel of every tile, named as texture sets usually are. */
    async exportPictures(layout: PictureLayout, flipRows: boolean): Promise<void> {
        if (this.busy) return;
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
            download(await makeZip(files), `${base}_${this.stack.size}.zip`);
        } catch (error) {
            this.status = error instanceof Error ? error.message : 'The pictures could not be made.';
        } finally {
            this.busy = null;
            this.emit();
        }
    }

    dispose(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            void this.save().finally(() => this.stack.dispose());
        } else this.stack.dispose();
        this.listeners.clear();
    }
}
