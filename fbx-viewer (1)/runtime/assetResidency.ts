import * as THREE from 'three';
import type { LevelObject, LoadedModelData } from '../types';
import type { AssetSelection, GameContentLoader } from '../utils/projectHydration';
import type { LevelAssetNeeds } from './levelAssets';

/**
 * ASSETS IN MEMORY
 *
 * Keeps what the levels of a running game need. Starting a level loads what it needs and is not
 * held. What earlier levels used stays, so going back is quick, until holding it would pass the
 * budget: then what was used longest ago goes first. A level always gets what it needs, even past
 * the budget, since it cannot run without it.
 */

/** How much a game holds before it starts letting go of what earlier levels used. */
export const DEFAULT_ASSET_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * What a model takes in memory for each byte of its file, until this game's own have been measured.
 * Models arrive compressed and unpack to several times their size: real ones here took about 4.
 */
const FIRST_GUESS_MODEL_GROWTH = 4;

type HeldKind = keyof LevelAssetNeeds;
const HELD_KINDS: readonly HeldKind[] = ['models', 'textures', 'audio', 'attachments', 'levels'];

interface Held {
    kind: HeldKind;
    id: string;
    bytes: number;
    /** The start this asset was last needed by; the lowest goes first. */
    used: number;
}

type TextureImageSize = { width?: number; height?: number; depth?: number };
const dimension = (value: number | undefined): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** GPU storage per pixel, not the byte width of a decoded JavaScript image. */
const texturePixelBytes = (texture: THREE.Texture): number => {
    // Packed 16-bit RGB(A) and 24+8 depth/stencil occupy one word per pixel.
    if (texture.type === THREE.UnsignedShort4444Type
        || texture.type === THREE.UnsignedShort5551Type) return 2;
    if (texture.type === THREE.UnsignedInt248Type || texture.format === THREE.DepthStencilFormat) return 4;

    const channels = texture.format === THREE.RedFormat || texture.format === THREE.DepthFormat ? 1
        : texture.format === THREE.RGFormat ? 2
            : texture.format === THREE.RGBFormat ? 3 : 4;
    const channelBytes = texture.type === THREE.UnsignedByteType || texture.type === THREE.ByteType ? 1
        : texture.type === THREE.HalfFloatType || texture.type === THREE.ShortType || texture.type === THREE.UnsignedShortType ? 2
            : 4; // Float32, 32-bit integers, and unknown types: conservative fallback.
    return channels * channelBytes;
};

const textureBytes = (texture: THREE.Texture): number => {
    const compressed = texture as THREE.CompressedTexture;
    if (compressed.isCompressedTexture) {
        // These levels are already GPU-ready blocks; do not multiply them by a pixel guess.
        const exact = (compressed.mipmaps ?? []).reduce(
            (sum, level) => sum + ((level.data as ArrayBufferView | undefined)?.byteLength ?? 0), 0,
        );
        if (exact) return exact;
    }
    const faces = Array.isArray(texture.image) ? texture.image as TextureImageSize[] : null;
    const image = faces?.[0] ?? texture.image as TextureImageSize | undefined;
    const width = dimension(image?.width);
    const height = dimension(image?.height);
    const layers = faces ? faces.length : (dimension(image?.depth) || 1);
    if (!width || !height) return 0;
    const pixelBytes = compressed.isCompressedTexture ? 4 : texturePixelBytes(texture);
    const baseBytes = width * height * layers * pixelBytes;

    // Explicit mipmaps describe actual allocated levels (including level zero), even if
    // generateMipmaps is false. Compressed mipmaps were counted by their exact block lengths.
    if (texture.mipmaps.length) {
        const explicit = (texture.mipmaps as TextureImageSize[]).reduce((sum, level) =>
            sum + dimension(level.width) * dimension(level.height) * layers * pixelBytes, 0);
        if (explicit) return Math.max(baseBytes, explicit);
    }
    if (!texture.generateMipmaps) return baseBytes;
    let total = 0;
    let w = width;
    let h = height;
    // Count each generated level through 1x1; 4/3 is inaccurate for small textures.
    while (true) {
        total += w * h * layers * pixelBytes;
        if (w === 1 && h === 1) return total;
        w = Math.max(1, Math.floor(w / 2));
        h = Math.max(1, Math.floor(h / 2));
    }
};

/** About what an object's meshes and textures hold in memory, each counted once. */
export const objectMemoryBytes = (object: THREE.Object3D): number => {
    const seen = new Set<object>();
    let bytes = 0;
    const addBuffer = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null | undefined) => {
        const array = (attribute as THREE.InterleavedBufferAttribute | undefined)?.data?.array ?? (attribute as THREE.BufferAttribute | undefined)?.array;
        if (!array || seen.has(array)) return;
        seen.add(array);
        bytes += array.byteLength;
    };
    object.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        const geometry = mesh.geometry;
        if (geometry && !seen.has(geometry)) {
            seen.add(geometry);
            Object.values(geometry.attributes).forEach(addBuffer);
            addBuffer(geometry.index);
        }
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            if (!material) continue;
            for (const value of Object.values(material)) {
                const texture = value as THREE.Texture | null;
                if (!texture?.isTexture || seen.has(texture)) continue;
                seen.add(texture);
                bytes += textureBytes(texture);
            }
        }
    });
    return bytes;
};

const terrainBytes = (objects: readonly LevelObject[], levelId: string): number => objects
    .filter(object => object.levelId === levelId && object.terrainData)
    .reduce((sum, object) => sum + ((object.terrainData?.heights?.length ?? 0) + (object.terrainData?.splat?.length ?? 0)) * 8, 0);

export class LevelAssetResidency {
    private readonly held = new Map<string, Held>();
    private starts = 0;
    /** Bumps as each level is asked for. */
    private level = 0;
    /** Cached activation invalidates queued earlier prepares, not ordinary sequential prepares. */
    private cacheGeneration = 0;
    private queue: Promise<unknown> = Promise.resolve();
    /** What the running level needs and what its World Grid is drawing: never freed to make room. */
    private levelNeeds: LevelAssetNeeds | null = null;
    private cellsInUse: ReadonlySet<string> = new Set();
    /** Models a World Grid asked for, for its answer. */
    private readonly cellModelIds = new Set<string>();
    private measuredModelBytes = 0;
    private measuredFileBytes = 0;

    constructor(
        private readonly loader: GameContentLoader,
        private readonly needsOf: (levelId: string) => LevelAssetNeeds,
        /** About what an asset not yet loaded will take, in bytes. */
        private readonly estimate: (kind: HeldKind, id: string) => number,
        private readonly budgetBytes: number = DEFAULT_ASSET_BUDGET_BYTES,
    ) {}

    private static key(kind: HeldKind, id: string): string {
        return `${kind}:${id}`;
    }

    /** Whether `levelId` could start now without loading anything. */
    holds(levelId: string): boolean {
        const needs = this.needsOf(levelId);
        return HELD_KINDS.every(kind => [...needs[kind]].every(id => this.held.has(LevelAssetResidency.key(kind, id))));
    }

    /** What is held now, in bytes. */
    heldBytes(): number {
        let bytes = 0;
        for (const held of this.held.values()) bytes += held.bytes;
        return bytes;
    }

    /**
     * Makes `levelId` ready to start, one level at a time. What goes to make room goes first, so the
     * old and the new are not in memory together. Nothing may be drawing an old level by now.
     */
    prepare(levelId: string): Promise<void> {
        // What the last level's World Grid is still waiting for no longer matters, and must not hold this one up.
        const generation = ++this.level;
        const run = this.queue.then(() => {
            if (generation < this.cacheGeneration) return;
            return this.prepareNow(levelId);
        });
        this.queue = run.catch(() => undefined);
        return run;
    }

    /** Restart a held level immediately, without loading or a loading screen. */
    activateCached(levelId: string): void {
        if (!this.holds(levelId)) throw new Error('level assets are not resident');
        // Invalidate previous-level cell work before a new World Grid can ask for anything.
        ++this.level;
        this.cacheGeneration = this.level;
        const needs = this.needsOf(levelId);
        this.levelNeeds = needs;
        this.cellsInUse = new Set();
        const start = ++this.starts;
        for (const kind of HELD_KINDS) {
            for (const id of needs[kind]) {
                const held = this.held.get(LevelAssetResidency.key(kind, id));
                if (held) held.used = start;
            }
        }
    }

    /** Whether a World Grid's cells in play draw this model. */
    cellInUse(modelId: string): boolean {
        return this.cellsInUse.has(modelId);
    }

    /** The World Grid's models tell it which are drawing; those are safe until it says otherwise. */
    setCellsInUse(modelIds: ReadonlySet<string>): void {
        this.cellsInUse = modelIds;
    }

    /**
     * Loads models a World Grid asks for while the game runs, after what came before, freeing what was used
     * longest ago to stay in budget. Resolves with every model loaded this way that is still held. Ask for one
     * model at a time: a level ending or the camera moving on can only cut in between requests.
     */
    requestCellModels(needs: LevelAssetNeeds, stillWanted: () => boolean = () => true): Promise<LoadedModelData[]> {
        const level = this.level;
        const run = this.queue.then(async () => {
            // Asked for a while ago: skipped if the level has ended, or the camera has moved on.
            if (level === this.level && stillWanted()) {
                needs.models.forEach(id => this.cellModelIds.add(id));
                await this.loadWithinBudget(needs, ++this.starts);
            }
            return this.loader.content().models.filter(model => this.cellModelIds.has(model.id));
        });
        this.queue = run.catch(() => undefined);
        return run;
    }

    private async prepareNow(levelId: string): Promise<void> {
        const needs = this.needsOf(levelId);
        this.levelNeeds = needs;
        this.cellsInUse = new Set();
        await this.loadWithinBudget(needs, ++this.starts);
    }

    /** About what an asset will take once loaded: files alone say too little, and freeing too little runs the game out of memory. */
    private incomingBytes(kind: HeldKind, id: string): number {
        const file = this.estimate(kind, id);
        if (kind !== 'models' && kind !== 'attachments') return file;
        return file * (this.measuredFileBytes > 0 ? Math.max(1, this.measuredModelBytes / this.measuredFileBytes) : FIRST_GUESS_MODEL_GROWTH);
    }

    private async loadWithinBudget(needs: LevelAssetNeeds, start: number): Promise<void> {
        let incoming = 0;
        for (const kind of HELD_KINDS) {
            for (const id of needs[kind]) {
                const held = this.held.get(LevelAssetResidency.key(kind, id));
                if (held) held.used = start;
                else incoming += this.incomingBytes(kind, id);
            }
        }
        this.makeRoom(incoming, start);
        try {
            await this.loader.load(needs);
        } finally {
            // Whatever did load is held, even if something else failed.
            this.measure(needs, start);
        }
    }

    private makeRoom(incoming: number, start: number): void {
        let bytes = this.heldBytes() + incoming;
        if (bytes <= this.budgetBytes) return;
        const inUse = (held: Held): boolean => Boolean(this.levelNeeds?.[held.kind].has(held.id)) || (held.kind === 'models' && this.cellsInUse.has(held.id));
        const candidates = [...this.held.values()].filter(held => held.used !== start && !inUse(held)).sort((a, b) => a.used - b.used);
        const selection: Record<HeldKind, Set<string>> = { models: new Set(), textures: new Set(), audio: new Set(), attachments: new Set(), levels: new Set() };
        for (const held of candidates) {
            if (bytes <= this.budgetBytes) break;
            selection[held.kind].add(held.id);
            if (held.kind === 'models') this.cellModelIds.delete(held.id);
            this.held.delete(LevelAssetResidency.key(held.kind, held.id));
            bytes -= held.bytes;
        }
        this.loader.release(selection as AssetSelection);
    }

    private measure(needs: LevelAssetNeeds, start: number): void {
        const content = this.loader.content();
        const objects = this.loader.objects();
        const note = (kind: HeldKind, id: string, bytes: number) => {
            const key = LevelAssetResidency.key(kind, id);
            if (this.held.has(key) || !needs[kind].has(id)) return;
            this.held.set(key, { kind, id, bytes, used: start });
            if (kind === 'models' || kind === 'attachments') {
                this.measuredModelBytes += bytes;
                this.measuredFileBytes += this.estimate(kind, id);
            }
        };
        for (const model of content.models) note('models', model.id, objectMemoryBytes(model.object));
        for (const attachment of content.attachments) note('attachments', attachment.id, objectMemoryBytes(attachment.object));
        for (const texture of content.textures) note('textures', texture.id, this.estimate('textures', texture.id));
        for (const audio of content.audioAssets) note('audio', audio.id, this.estimate('audio', audio.id));
        for (const levelId of needs.levels) note('levels', levelId, terrainBytes(objects, levelId));
    }
}
