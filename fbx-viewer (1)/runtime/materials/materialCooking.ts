import type * as THREE from 'three';
import type { MaterialAsset, MaterialBinding } from './materialLibrary';

/**
 * COOKED PICTURES: TEXTURE GRAPHS RUN BY THE GAME
 *
 * A material whose pictures come from a texture graph can draw with pictures the running game makes from the graph
 * itself (on its GPU, through the editor's own evaluator: graphCooker.ts), rather than with the pictures baked into the
 * project. Each use of the material can ask for its own: the graph's parameters it sets and a seed (per placed object,
 * or set during play by blueprints and scripts), and a picture size that follows how large it shows on the screen.
 *
 * Uses asking for the same graph, values, seed and size share one cooked set, found by signature in the game's cache
 * (cookedPictureCache.ts) so a second run loads it. Cooking runs one set at a time, a frame apart, behind what the game
 * draws; until a set is ready, and for good if it fails, the use draws with the baked pictures. A set no use wants any
 * more is let go of. Whether a game cooks at all is its setting: always, when the device can, or never.
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

/** What the planner asks of the material library: textures it may read by id, and drawing an asset's uses again. */
export interface CookedPictureHost {
    addTextureUrl(textureId: string, url: string): void;
    releaseTexture(textureId: string): void;
    rebindAsset(assetId: string): void;
}

interface CookedSet {
    assetId: string;
    ids: Partial<Record<CookedRole, string>>;
    urls: string[];
    users: Set<THREE.Material>;
}

/** The texture id a cooked picture is read by. */
export const cookedTextureId = (key: string, role: CookedRole): string => `cooked:${key}:${role}`;

export class MaterialCookPlanner {
    private readonly sets = new Map<string, CookedSet>();
    private readonly waiting = new Map<string, CookRequest>();
    private readonly failed = new Set<string>();
    private readonly held = new Map<THREE.Material, string>();
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
        } = {},
    ) {}

    /**
     * The pictures a use of `asset` draws with: its cooked set once ready, else undefined (its baked pictures). Asking
     * starts the cook; `material` holds the set until it asks for another or is released.
     */
    pictures(asset: MaterialAsset, binding: Pick<MaterialBinding, 'parameters'>, material: THREE.Material): Record<string, string> | undefined {
        if (!cookable(asset)) {
            this.release(material);
            return undefined;
        }
        const request = cookRequestFor(asset, binding.parameters as Record<string, unknown> | undefined);
        const key = cookSignature(request, this.options.content);
        if (this.held.get(material) !== key) {
            this.release(material);
            this.held.set(material, key);
        }
        const set = this.sets.get(key);
        if (set) {
            set.users.add(material);
            return this.withCooked(asset, set);
        }
        if (!this.failed.has(key) && !this.waiting.has(key)) {
            this.waiting.set(key, request);
            this.schedule();
        }
        return undefined;
    }

    /** A use no longer draws with the asset: the set it held goes once no use holds it. */
    release(material: THREE.Material): void {
        const key = this.held.get(material);
        if (key === undefined) return;
        this.held.delete(material);
        const set = this.sets.get(key);
        if (!set) {
            if (![...this.held.values()].includes(key)) this.waiting.delete(key);
            return;
        }
        set.users.delete(material);
        if (set.users.size) return;
        this.sets.delete(key);
        for (const id of Object.values(set.ids)) if (id) this.host.releaseTexture(id);
        for (const url of set.urls) (this.options.letGo ?? ((value: string) => URL.revokeObjectURL(value)))(url);
    }

    /** How many cooked sets are held now. */
    get heldSets(): number {
        return this.sets.size;
    }

    /** Settles once nothing waits to be cooked (tests). */
    async settled(): Promise<void> {
        while (this.running || this.scheduled || this.waiting.size) await new Promise(resolve => setTimeout(resolve, 0));
    }

    /** The asset's pictures with those the set holds in their place (any it did not cook stay baked). */
    private withCooked(asset: MaterialAsset, set: CookedSet): Record<string, string> {
        const pictures: Record<string, string> = { ...(asset.pictures ?? {}) };
        for (const [role, id] of Object.entries(set.ids)) if (id) pictures[role] = id;
        return pictures;
    }

    private schedule(): void {
        if (this.scheduled || this.running || !this.waiting.size) return;
        this.scheduled = true;
        (this.options.nextFrame ?? ((task: () => void) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => task()) : setTimeout(task, 16))))(() => {
            this.scheduled = false;
            void this.cookNext();
        });
    }

    private async cookNext(): Promise<void> {
        const next = this.waiting.entries().next();
        if (next.done) return;
        const [key, request] = next.value;
        this.waiting.delete(key);
        // Nobody wants it any more (the use moved on while it waited).
        if (![...this.held.values()].includes(key)) {
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
            const users = [...this.held].filter(([, held]) => held === key).map(([material]) => material);
            if (!users.length) return;
            const set: CookedSet = { assetId: request.asset.id, ids: {}, urls: [], users: new Set(users) };
            for (const [role, blob] of Object.entries(pictures) as Array<[CookedRole, Blob]>) {
                const id = cookedTextureId(key, role);
                const url = (this.options.urlOf ?? ((value: Blob) => URL.createObjectURL(value)))(blob);
                this.host.addTextureUrl(id, url);
                set.ids[role] = id;
                set.urls.push(url);
            }
            this.sets.set(key, set);
            this.cooked += 1;
            this.host.rebindAsset(request.asset.id);
        } catch (error) {
            // The baked pictures stay.
            this.failed.add(key);
            this.options.onFailure?.(error);
        } finally {
            this.running = false;
            this.schedule();
        }
    }
}
