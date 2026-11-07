import type * as THREE from 'three';
import type { MaterialAsset, MaterialBinding } from './materialLibrary';
import type { TextureSettings } from '../../texturing/textureSettings';

/**
 * COOKED PICTURES: TEXTURE GRAPHS RUN BY THE GAME
 *
 * A material whose pictures come from a texture graph can draw with pictures the running game makes from the graph
 * itself (on its GPU, through the editor's own evaluator: graphCooker.ts), rather than with the pictures baked into the
 * project. Each use of the material can ask for its own: the graph's parameters it sets and a seed (per placed object,
 * or set during play by blueprints and scripts), and a picture size that follows how large it shows on the screen.
 *
 * Uses asking for the same graph, values, seed and size share one cooked set, found by signature in the game's cache
 * (materialCookingSetup.ts) so a second run loads it. The cook never depends on the size a use shows at: every size
 * reads the same pictures (the editor's), each at a size of its own. Cooking runs one set at a time, a frame apart,
 * behind what the game draws. A use whose values change keeps showing what it showed until the new set's textures are
 * loaded, so it is never drawn bare; with nothing cooked yet (or if cooking fails) it draws with the baked pictures.
 * Sets no use wears are kept a while, so values set again (a blueprint going round) show at once. Whether a game cooks at all is its setting: always, when the device can, or never.
 */

/** The parameter a use sets to give its texture graph a seed of its own. */
export const GRAPH_SEED = 'Graph seed';
/** The parameter the level of detail sets: the cooked pictures' size, as a power of two. */
export const PICTURE_SIZE = 'Picture size (power of two)';

export type CookMode = 'always' | 'capable' | 'never';
export type CookedRole = 'baseColor' | 'normal' | 'orm' | 'emissive' | 'opacity' | 'height' | 'roughness' | 'metallic' | 'ambientOcclusion';
export type CookedPictures = Partial<Record<CookedRole, Blob>>;

/** What to cook: the material, its graph's values for this use, its seed and size (log2; the graph's own when absent). */
export interface CookRequest {
    asset: MaterialAsset;
    values: Readonly<Record<string, unknown>>;
    seed?: number;
    sizeLog2?: number;
}

export interface Cooker {
    cook(request: CookRequest): Promise<CookedPictures>;
}

export interface CookCache {
    get(key: string): Promise<CookedPictures | null>;
    put(key: string, pictures: CookedPictures): Promise<void>;
}

interface StoredGraphLike {
    graph?: { parameters?: Array<{ name?: unknown }>; [key: string]: unknown };
    values?: Record<string, unknown>;
    library?: unknown;
    bakeSize?: unknown;
}

const storedOf = (asset: MaterialAsset): StoredGraphLike | null => (asset.textureGraph && typeof asset.textureGraph === 'object' ? asset.textureGraph as StoredGraphLike : null);

/** Whether a material's pictures can be cooked: it has a texture graph made to be a material (not one for other graphs). */
export const cookable = (asset: MaterialAsset): boolean => {
    const stored = storedOf(asset);
    return !!stored?.graph && stored.library !== true;
};

/** The names of a material's texture-graph parameters, which a use may set. */
export const graphParameterNames = (asset: MaterialAsset): string[] =>
    (storedOf(asset)?.graph?.parameters ?? []).map(parameter => parameter.name).filter((name): name is string => typeof name === 'string' && name.length > 0);

/** The baked pictures' size (log2), which cooking takes unless the level of detail asks for another. */
export const bakedSizeLog2 = (asset: MaterialAsset): number => {
    const size = storedOf(asset)?.bakeSize;
    return typeof size === 'number' && Number.isInteger(size) && size >= 4 && size <= 13 ? size : 10;
};

/** What a use asks to have cooked, from its parameter values (a binding's): its graph values, seed and size. */
export const cookRequestFor = (asset: MaterialAsset, parameters: Readonly<Record<string, unknown>> | undefined): CookRequest => {
    const names = new Set(graphParameterNames(asset));
    const values: Record<string, unknown> = { ...(storedOf(asset)?.values ?? {}) };
    for (const [name, value] of Object.entries(parameters ?? {})) if (names.has(name)) values[name] = value;
    const seed = parameters?.[GRAPH_SEED];
    const size = parameters?.[PICTURE_SIZE];
    return {
        asset,
        values,
        ...(typeof seed === 'number' && Number.isFinite(seed) ? { seed: Math.round(seed) } : {}),
        ...(typeof size === 'number' && Number.isInteger(size) ? { sizeLog2: Math.max(4, Math.min(bakedSizeLog2(asset), size)) } : {}),
    };
};

const fnv = (text: string, seed: number): string => {
    let hash = seed >>> 0;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
};

/** Values in a fixed order, so the same values give the same signature however they were set. */
const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])]));
};

/**
 * The signature a cooked set is kept under: the graph (and every graph it uses as a node, by `content`), the values,
 * the seed and the size. Anything that changes the pictures changes it.
 */
export const cookSignature = (request: CookRequest, content: (asset: MaterialAsset) => string = (asset) => JSON.stringify(sorted(storedOf(asset)?.graph ?? null))): string => {
    const text = JSON.stringify([content(request.asset), sorted(request.values), request.seed ?? null, request.sizeLog2 ?? bakedSizeLog2(request.asset)]);
    return `cook1-${fnv(text, 0x811c9dc5)}${fnv(text, 0x01000193)}`;
};

/**
 * The picture size (log2) a cooked material steps to for how large it shows: one step up as soon as it shows at twice
 * the pictures' size, down only once it shows at a quarter, so a size near a boundary does not flicker between two.
 */
export const steppedPictureSize = (currentLog2: number | undefined, shownPixels: number, smallestLog2: number, largestLog2: number): number => {
    const wanted = Math.max(smallestLog2, Math.min(largestLog2, Math.ceil(Math.log2(Math.max(1, shownPixels)))));
    if (currentLog2 === undefined) return wanted;
    if (wanted > currentLog2) return Math.min(largestLog2, wanted);
    if (wanted <= currentLog2 - 2) return Math.max(smallestLog2, wanted + 1);
    return currentLog2;
};

/** What the planner asks of the material library: textures it may read by id, having them loaded, and drawing an asset's uses again. */
export interface CookedPictureHost {
    addTextureUrl(textureId: string, url: string): void;
    releaseTexture(textureId: string): void;
    rebindAsset(assetId: string): void;
    /** Settles once the texture is loaded (or could not be), read in this slot and this way up. */
    preloadTexture?(textureId: string, slot: 'map' | 'normal' | 'data', flipY: boolean): Promise<void>;
}

/** How a cooked picture of a role is read: colour, a normal map, or data. */
const ROLE_SLOTS: Record<CookedRole, 'map' | 'normal' | 'data'> = {
    baseColor: 'map', emissive: 'map', normal: 'normal', orm: 'data', opacity: 'data', height: 'data', roughness: 'data', metallic: 'data', ambientOcclusion: 'data',
};

/** The settings a cooked picture is read with: its role, kept whole (it is made at the size it shows at), no larger than `sizeLog2`. */
export const cookedPictureSettings = (role: CookedRole, sizeLog2: number | undefined): TextureSettings => ({
    ...(ROLE_SLOTS[role] === 'normal' ? { normalMap: true } : { colorSpace: ROLE_SLOTS[role] === 'map' ? 'colour' as const : 'data' as const }),
    compression: 'none',
    ...(sizeLog2 !== undefined ? { maxSize: 2 ** Math.max(8, sizeLog2) } : {}),
});

/** The texture id a cooked picture is read by, at a size (the whole cook's when undefined). */
export const cookedTextureId = (key: string, role: CookedRole, sizeLog2?: number): string => `cooked:${key}@${sizeLog2 ?? 'full'}:${role}`;

/** A cooked set's pictures (its files), one for each look of its values and seed. */
interface CookedSet {
    assetId: string;
    urls: Partial<Record<CookedRole, string>>;
    /** Its sizes in use or kept. */
    variants: Set<string>;
}

/** A set read at one size: its own texture ids, ready once they are loaded. */
interface Variant {
    key: string;
    sizeLog2: number | undefined;
    ids: Partial<Record<CookedRole, string>>;
    ready: boolean;
    users: Set<THREE.Material>;
}

/** Sets no use wears kept loaded for a while, so a value set again (a blueprint going round) shows at once. */
const SPARE_VARIANTS = 24;

export class MaterialCookPlanner {
    private readonly sets = new Map<string, CookedSet>();
    private readonly variants = new Map<string, Variant>();
    private readonly waiting = new Map<string, CookRequest>();
    private readonly failed = new Set<string>();
    /** The look each use asks for, the one it shows (until the asked one is ready), and which way up it reads pictures. */
    private readonly wanted = new Map<THREE.Material, string>();
    private readonly shown = new Map<THREE.Material, string>();
    private readonly flips = new Map<THREE.Material, boolean>();
    /** Variants nobody wears, oldest first. */
    private spare: string[] = [];
    /** Variants whose textures are loading. */
    private readonly preparing = new Set<string>();
    private running = false;
    private scheduled = false;
    /** Cooked sets made (counted for tests and the editor's notes). */
    cooked = 0;

    constructor(
        private readonly host: CookedPictureHost,
        private readonly cooker: Cooker,
        private readonly cache: CookCache | null,
        private readonly options: {
            /** Runs a task on a later frame (one cook a frame). */
            nextFrame?: (task: () => void) => void;
            urlOf?: (blob: Blob) => string;
            letGo?: (url: string) => void;
            content?: (asset: MaterialAsset) => string;
            onFailure?: (error: unknown) => void;
            /** Records how a texture id is read (texturing/textureSettings.ts in the game). */
            setSettings?: (textureId: string, settings: TextureSettings) => void;
        } = {},
    ) {}

    /**
     * The pictures a use of `asset` draws with: the cooked set for its values at its size once ready. Until then it
     * keeps what it showed before (so changing a value never draws it bare), or its baked pictures. Asking starts the
     * cook; `material` holds what it shows until it shows another or is released.
     */
    pictures(asset: MaterialAsset, binding: Pick<MaterialBinding, 'parameters'> & { flipY?: boolean }, material: THREE.Material): Record<string, string> | undefined {
        if (!cookable(asset)) {
            this.release(material);
            return undefined;
        }
        const request = cookRequestFor(asset, binding.parameters as Record<string, unknown> | undefined);
        // The cook itself never depends on the size it is shown at: every size reads the same pictures, as the editor's.
        const key = cookSignature({ ...request, sizeLog2: undefined }, this.options.content);
        const variantKey = `${key}@${request.sizeLog2 ?? 'full'}`;
        this.wanted.set(material, variantKey);
        this.flips.set(material, binding.flipY !== false);
        const variant = this.variants.get(variantKey);
        if (variant?.ready) {
            this.show(material, variantKey);
            return this.withCooked(asset, variant);
        }
        if (this.sets.has(key)) this.prepare(variantKey, key, request.sizeLog2);
        else if (!this.failed.has(key) && !this.waiting.has(key)) {
            this.waiting.set(key, { ...request, sizeLog2: undefined });
            this.schedule();
        }
        // What it showed until now stays until the new look is ready.
        const before = this.shown.get(material);
        const showing = before ? this.variants.get(before) : undefined;
        return showing?.ready && this.sets.get(showing.key)?.assetId === asset.id ? this.withCooked(asset, showing) : undefined;
    }

    /** A use no longer draws with the asset: what it showed is kept a while, then let go of. */
    release(material: THREE.Material): void {
        this.wanted.delete(material);
        this.flips.delete(material);
        const shown = this.shown.get(material);
        this.shown.delete(material);
        if (shown) this.leave(shown, material);
    }

    /** How many cooked sets are held now (worn or kept). */
    get heldSets(): number {
        return this.sets.size;
    }

    /** Settles once nothing waits to be cooked or loaded (tests). */
    async settled(): Promise<void> {
        for (let round = 0; round < 3; round++) {
            while (this.running || this.scheduled || this.waiting.size || this.preparing.size) await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    /** The asset's pictures with those the variant holds in their place (any it did not cook stay baked). */
    private withCooked(asset: MaterialAsset, variant: Variant): Record<string, string> {
        const pictures: Record<string, string> = { ...(asset.pictures ?? {}) };
        for (const [role, id] of Object.entries(variant.ids)) if (id) pictures[role] = id;
        return pictures;
    }

    private show(material: THREE.Material, variantKey: string): void {
        const before = this.shown.get(material);
        this.variants.get(variantKey)!.users.add(material);
        this.spare = this.spare.filter(key => key !== variantKey);
        if (before === variantKey) return;
        this.shown.set(material, variantKey);
        if (before) this.leave(before, material);
    }

    /** A use stops showing a variant: with nobody left it is kept spare, the oldest spare ones let go of. */
    private leave(variantKey: string, material: THREE.Material): void {
        const variant = this.variants.get(variantKey);
        if (!variant) return;
        variant.users.delete(material);
        if (!variant.users.size) this.keepSpare(variantKey);
    }

    private keepSpare(variantKey: string): void {
        this.spare = [...this.spare.filter(key => key !== variantKey), variantKey];
        while (this.spare.length > SPARE_VARIANTS) this.drop(this.spare.shift()!);
    }

    private drop(variantKey: string): void {
        const variant = this.variants.get(variantKey);
        if (!variant || variant.users.size) return;
        this.variants.delete(variantKey);
        for (const id of Object.values(variant.ids)) if (id) this.host.releaseTexture(id);
        const set = this.sets.get(variant.key);
        if (!set) return;
        set.variants.delete(variantKey);
        if (set.variants.size) return;
        this.sets.delete(variant.key);
        for (const url of Object.values(set.urls)) if (url) (this.options.letGo ?? ((value: string) => URL.revokeObjectURL(value)))(url);
    }

    /** A cooked set read at a size: its texture ids, loaded before anything draws with them. */
    private prepare(variantKey: string, key: string, sizeLog2: number | undefined): void {
        if (this.variants.has(variantKey) || this.preparing.has(variantKey)) return;
        const set = this.sets.get(key);
        if (!set) return;
        const variant: Variant = { key, sizeLog2, ids: {}, ready: false, users: new Set() };
        this.variants.set(variantKey, variant);
        set.variants.add(variantKey);
        this.preparing.add(variantKey);
        const loads: Array<Promise<void>> = [];
        const flips = new Set([...this.wanted].filter(([, wanted]) => wanted === variantKey).map(([material]) => this.flips.get(material) ?? true));
        for (const [role, url] of Object.entries(set.urls) as Array<[CookedRole, string]>) {
            const id = cookedTextureId(key, role, sizeLog2);
            this.options.setSettings?.(id, cookedPictureSettings(role, sizeLog2));
            this.host.addTextureUrl(id, url);
            variant.ids[role] = id;
            for (const flipY of flips.size ? flips : [true]) if (this.host.preloadTexture) loads.push(this.host.preloadTexture(id, ROLE_SLOTS[role], flipY));
        }
        void Promise.all(loads).then(() => {
            this.preparing.delete(variantKey);
            if (this.variants.get(variantKey) !== variant) return;
            variant.ready = true;
            // Nobody asks for it any more: kept spare.
            if (![...this.wanted.values()].includes(variantKey) && !variant.users.size) this.keepSpare(variantKey);
            this.host.rebindAsset(set.assetId);
        });
    }

    private schedule(): void {
        if (this.scheduled || this.running || !this.waiting.size) return;
        this.scheduled = true;
        (this.options.nextFrame ?? ((task: () => void) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => task()) : setTimeout(task, 16))))(() => {
            this.scheduled = false;
            void this.cookNext();
        });
    }

    /** The keys uses ask for now. */
    private wantedKeys(): Set<string> {
        return new Set([...this.wanted.values()].map(variantKey => variantKey.slice(0, variantKey.lastIndexOf('@'))));
    }

    private async cookNext(): Promise<void> {
        const next = this.waiting.entries().next();
        if (next.done) return;
        const [key, request] = next.value;
        this.waiting.delete(key);
        // Nobody wants it any more (the use moved on while it waited).
        if (!this.wantedKeys().has(key)) {
            this.schedule();
            return;
        }
        this.running = true;
        try {
            let pictures = await this.cache?.get(key).catch(() => null) ?? null;
            if (!pictures) {
                pictures = await this.cooker.cook(request);
                void this.cache?.put(key, pictures).catch(() => undefined);
            }
            const set: CookedSet = { assetId: request.asset.id, urls: {}, variants: new Set() };
            for (const [role, blob] of Object.entries(pictures) as Array<[CookedRole, Blob]>) set.urls[role] = (this.options.urlOf ?? ((value: Blob) => URL.createObjectURL(value)))(blob);
            this.sets.set(key, set);
            this.cooked += 1;
            // Every size asked for is read from it.
            for (const variantKey of new Set(this.wanted.values())) {
                if (variantKey.startsWith(`${key}@`)) {
                    const size = variantKey.slice(key.length + 1);
                    this.prepare(variantKey, key, size === 'full' ? undefined : Number(size));
                }
            }
        } catch (error) {
            // What it showed, or the baked pictures, stays.
            this.failed.add(key);
            this.options.onFailure?.(error);
        } finally {
            this.running = false;
            this.schedule();
        }
    }
}
