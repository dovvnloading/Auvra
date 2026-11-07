import * as THREE from 'three';
import { getMaterialNodeDefinition, materialGraphLook, normalizeMaterialGraph, textureSlot, withMaterialParameters, withMaterialPictures, type MaterialGraph, type MaterialParameterValues, type MaterialPictures, type TextureSlot } from './materialGraph';
import { bindMaterialGraph, canBindMaterialGraph, unbindMaterialGraph, type MaterialTextureLookup } from './graphMaterial';

/**
 * THE MATERIAL LIBRARY
 *
 * The project's material assets (the 'materials' domain) by id, and the textures their graphs
 * sample. Model materials assigned an asset (a material override's materialId) are bound to its
 * graph through here, and follow it: editing an asset re-binds every material using it, and a
 * texture that finishes loading reaches each graph sampling it.
 */

export interface MaterialAsset {
    id: string;
    name: string;
    graph: MaterialGraph;
    /** The image graph the material's pictures are made from (texturing/graph), when it has one. */
    textureGraph?: Record<string, unknown>;
    /** The painted layers its pictures are made from (texturing/paint), when it has them. */
    paint?: Record<string, unknown>;
    /**
     * Its pictures by name (base colour, normal, height...): what its texture graph or painting last made,
     * read by the graph's Material Picture nodes. Making them again changes only these, not the graph.
     */
    pictures?: Record<string, string>;
    /** The model (and its material) owning this painted copy (utils/paintedCopies.ts); absent for shared materials. */
    owner?: { modelId: string; material: string };
}

export const MATERIALS_DOMAIN = 'materials';

/** An asset as stored in the materials domain. */
export interface MaterialAssetDocument {
    id: string;
    name: string;
    graph: MaterialGraph;
    /** The textures the graph samples, so the project can keep them and check them. */
    textureIds: string[];
    textureGraph?: Record<string, unknown>;
    paint?: Record<string, unknown>;
    pictures?: Record<string, string>;
    owner?: { modelId: string; material: string };
}

/**
 * Textures named inside a material's authoring documents (its texture graph or paint layers):
 * strings under `texture` or `textureId`, and the values of a `textures` record. Read generically
 * so the game build need not load the authoring code.
 */
const authoringTextureIds = (value: unknown, into: Set<string>, key = ''): void => {
    if (typeof value === 'string') {
        if ((key === 'texture' || key === 'textureId' || key === '#textures') && value) into.add(value);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) authoringTextureIds(item, into, key === '#textures' ? '' : key);
        return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) authoringTextureIds(child, into, key === 'textures' ? '#textures' : childKey);
};

/** The same authoring document with every texture it names renamed (or cleared, renamed to ''). */
const renamedAuthoringTextures = <T>(value: T, rename: (textureId: string) => string, key = ''): T => {
    if (typeof value === 'string') return ((key === 'texture' || key === 'textureId' || key === '#textures') && value ? rename(value) : value) as T;
    if (Array.isArray(value)) return value.map((item) => renamedAuthoringTextures(item, rename, key === '#textures' ? '' : key)) as T;
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) result[childKey] = renamedAuthoringTextures(child, rename, key === 'textures' ? '#textures' : childKey);
    return result as T;
};

/** The same authoring document with every mention of `textureId` cleared. */
const withoutAuthoringTexture = <T>(value: T, textureId: string): T => renamedAuthoringTextures(value, (id) => (id === textureId ? '' : id));

/**
 * The asset with every texture it names (in its graph, its authoring documents and its pictures) renamed:
 * how a material from another project takes the ids its pictures were given here. A texture renamed to
 * '' is cleared, and a picture renamed to '' is dropped.
 */
export const withRenamedTextures = (asset: MaterialAsset, rename: (textureId: string) => string): MaterialAsset => {
    const pictures = asset.pictures
        ? Object.fromEntries(Object.entries(asset.pictures).map(([name, textureId]) => [name, rename(textureId)]).filter(([, textureId]) => textureId))
        : undefined;
    return {
        ...asset,
        graph: {
            ...asset.graph,
            nodes: asset.graph.nodes.map((node) => (typeof node.params.texture === 'string' && node.params.texture
                ? { ...node, params: { ...node.params, texture: rename(node.params.texture) } }
                : node)),
        },
        ...(asset.textureGraph ? { textureGraph: renamedAuthoringTextures(asset.textureGraph, rename) } : {}),
        ...(asset.paint ? { paint: renamedAuthoringTextures(asset.paint, rename) } : {}),
        ...(pictures ? { pictures } : {}),
    };
};

/** The asset with `textureId` gone from its graph and its authoring documents; the same asset when none names it. */
export const withoutAssetTexture = (asset: MaterialAsset, textureId: string): MaterialAsset => {
    const graph = withoutGraphTexture(asset.graph, textureId);
    const named = new Set<string>();
    authoringTextureIds(asset.textureGraph, named);
    authoringTextureIds(asset.paint, named);
    if (graph === asset.graph && !named.has(textureId)) return asset;
    return {
        ...asset,
        graph,
        ...(asset.textureGraph ? { textureGraph: withoutAuthoringTexture(asset.textureGraph, textureId) } : {}),
        ...(asset.paint ? { paint: withoutAuthoringTexture(asset.paint, textureId) } : {}),
    };
};

/** The textures a graph samples, and whether each holds colour, data or normals. */
export const graphTextures = (graph: MaterialGraph): Array<{ textureId: string; slot: TextureSlot }> => {
    const seen = new Set<string>();
    const result: Array<{ textureId: string; slot: TextureSlot }> = [];
    for (const node of graph.nodes) {
        const textureId = node.params.texture;
        // Texture Sample, Normal Map and Triplanar Sample: every node whose 'texture' param picks one.
        const picksTexture = getMaterialNodeDefinition(node.type)?.params.some(param => param.key === 'texture' && param.kind === 'texture');
        if (!picksTexture || typeof textureId !== 'string' || !textureId) continue;
        const slot = textureSlot(node);
        if (seen.has(`${slot}:${textureId}`)) continue;
        seen.add(`${slot}:${textureId}`);
        result.push({ textureId, slot });
    }
    return result;
};

/** The graph with its texture nodes cleared of `textureId`; the same graph when none samples it. */
export const withoutGraphTexture = (graph: MaterialGraph, textureId: string): MaterialGraph => {
    if (!graph.nodes.some(node => node.params.texture === textureId)) return graph;
    return {
        ...graph,
        nodes: graph.nodes.map(node => (node.params.texture === textureId ? { ...node, params: { ...node.params, texture: '' } } : node)),
    };
};

export const materialAssetDocument = (asset: MaterialAsset): MaterialAssetDocument => {
    const textureIds = new Set(graphTextures(asset.graph).map(texture => texture.textureId));
    authoringTextureIds(asset.textureGraph, textureIds);
    authoringTextureIds(asset.paint, textureIds);
    for (const textureId of Object.values(asset.pictures ?? {})) textureIds.add(textureId);
    return {
        id: asset.id,
        name: asset.name,
        graph: asset.graph,
        textureIds: [...textureIds],
        ...(asset.textureGraph ? { textureGraph: asset.textureGraph } : {}),
        ...(asset.paint ? { paint: asset.paint } : {}),
        ...(asset.pictures ? { pictures: asset.pictures } : {}),
        ...(asset.owner ? { owner: asset.owner } : {}),
    };
};

/** A stored asset made safe, or null when it is not one. */
const PICTURE_NAMES = new Set(['baseColor', 'normal', 'orm', 'roughness', 'metallic', 'ambientOcclusion', 'height', 'emissive', 'opacity']);

/** Pictures by name made safe: known names to texture ids. */
export const readMaterialPictures = (value: unknown): Record<string, string> | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const pictures = Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([name, id]) => PICTURE_NAMES.has(name) && typeof id === 'string' && id.length > 0 && id.length <= 128)) as Record<string, string>;
    return Object.keys(pictures).length ? pictures : undefined;
};

const samePictures = (a: MaterialPictures | undefined, b: MaterialPictures | undefined): boolean =>
    JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());

/**
 * The pictures an older asset kept only inside its texture graph or painting (the pictures last made, or
 * put on a model), for a material read before materials kept their pictures by name.
 */
const lastMadePictures = (asset: Pick<MaterialAsset, 'textureGraph' | 'paint'>): Record<string, string> | undefined => {
    const baked = (asset.textureGraph as { baked?: { textures?: unknown } } | undefined)?.baked?.textures;
    const applied = (asset.paint as { applied?: { textures?: unknown } } | undefined)?.applied?.textures;
    return readMaterialPictures(baked) ?? readMaterialPictures(applied);
};

export const readMaterialAsset = (value: unknown): MaterialAsset | null => {
    if (!value || typeof value !== 'object') return null;
    const document = value as Partial<MaterialAssetDocument>;
    if (typeof document.id !== 'string' || !document.id) return null;
    const asset: MaterialAsset = {
        id: document.id,
        name: typeof document.name === 'string' && document.name.trim() ? document.name.trim().slice(0, 128) : 'Material',
        graph: normalizeMaterialGraph(document.graph),
    };
    if (document.textureGraph && typeof document.textureGraph === 'object' && !Array.isArray(document.textureGraph)) asset.textureGraph = document.textureGraph;
    if (document.paint && typeof document.paint === 'object' && !Array.isArray(document.paint)) asset.paint = document.paint;
    // Its pictures by name; a material from before keeps the ones its texture graph or painting last made.
    const pictures = readMaterialPictures(document.pictures) ?? lastMadePictures(asset);
    if (pictures) asset.pictures = pictures;
    const owner = (document as { owner?: { modelId?: unknown; material?: unknown } }).owner;
    if (owner && typeof owner.modelId === 'string' && owner.modelId && typeof owner.material === 'string') asset.owner = { modelId: owner.modelId, material: owner.material };
    return asset;
};

/**
 * What an asset is to a model's material:
 * - 'material': it draws (a shader graph, or a texture graph or painting whose pictures have been made);
 * - 'needsPictures': a texture graph not yet drawn into pictures, or a painting not yet put on a model,
 *   whose graph would only shade grey;
 * - 'forOtherGraphs': a texture graph made to be used as a node inside others, never a material.
 * Read generically, as authoringTextureIds is, so the game build need not load the authoring code.
 */
export type MaterialAssetUse = 'material' | 'needsPictures' | 'forOtherGraphs';

const recordOf = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);

const madePictures = (record: Record<string, unknown> | null): boolean => {
    const textures = recordOf(record?.textures);
    return !!textures && Object.values(textures).some((textureId) => typeof textureId === 'string' && textureId.length > 0);
};

export const materialAssetUse = (asset: Pick<MaterialAsset, 'textureGraph' | 'paint'>): MaterialAssetUse => {
    if (asset.textureGraph) {
        if (asset.textureGraph.library === true) return 'forOtherGraphs';
        return madePictures(recordOf(asset.textureGraph.baked)) ? 'material' : 'needsPictures';
    }
    if (asset.paint) return madePictures(recordOf(asset.paint.applied)) ? 'material' : 'needsPictures';
    return 'material';
};

/** Where a texture id's image is, for loading it. */
export type TextureUrlResolver = (textureId: string) => string | undefined;

/** Loads a texture's file for the way a graph reads it. */
export type TextureLoad = (url: string, request: { textureId: string; slot: TextureSlot; flipY: boolean }) => Promise<THREE.Texture>;

/** How a material is shaded by an asset here. */
export interface MaterialBinding {
    materialId: string;
    /** Texture coordinates with the glTF top-left origin (flipY false), else the FBX/OBJ bottom-left. */
    flipY: boolean;
    /** This material's own values for the asset's parameters. */
    parameters?: MaterialParameterValues;
}

/**
 * Where a use of a texture-graph material takes its pictures from, instead of the asset's baked ones: cooked for its
 * values by the running game (materialCooking.ts). Undefined keeps the baked pictures.
 */
export interface PictureSource {
    pictures(asset: MaterialAsset, binding: MaterialBinding, material: THREE.Material): Record<string, string> | undefined;
    release(material: THREE.Material): void;
}

class MaterialLibrary {
    /** Counts changes to the assets, for subscribers that compare snapshots. */
    version = 0;
    /** Counts projects opened (replaceAll), for what is kept per project for the session. */
    generation = 0;
    /** Counts textures that finished loading, for what draws with them without being bound here (node previews). */
    texturesLoaded = 0;
    private readonly assets = new Map<string, MaterialAsset>();
    private readonly listeners = new Set<() => void>();
    private readonly bound = new Map<THREE.MeshStandardMaterial, MaterialBinding>();
    private readonly textures = new Map<string, THREE.Texture | null>();
    private resolveUrl: TextureUrlResolver = () => undefined;
    private readonly addedUrls = new Map<string, string>();
    private loadTexture: TextureLoad = (url) => new THREE.TextureLoader().loadAsync(url);
    private pictureSource: PictureSource | null = null;
    /** Textures being loaded, by key, settling when they have (or have failed). */
    private readonly loading = new Map<string, Promise<void>>();

    /** Where texture-graph materials' uses take their pictures from (null: always the baked ones). Every use draws again. */
    setPictureSource(source: PictureSource | null): void {
        if (this.pictureSource) for (const material of this.bound.keys()) this.pictureSource.release(material);
        this.pictureSource = source;
        this.rebindAll();
        this.emit();
    }

    /** Settles once a texture is loaded in this slot and this way up (or could not be); starts loading it if need be. */
    preloadTexture(textureId: string, slot: TextureSlot, flipY: boolean): Promise<void> {
        const key = `${slot}:${flipY ? 1 : 0}:${textureId}`;
        if (this.textures.get(key)) return Promise.resolve();
        if (!this.textures.has(key)) this.texture(textureId, slot, flipY);
        return this.loading.get(key) ?? Promise.resolve();
    }

    /** Draws every use of an asset again (its cooked pictures arrived). */
    rebindAsset(id: string): void {
        for (const [material, binding] of this.bound) if (binding.materialId === id) this.bindNow(material, binding);
        this.emit();
    }

    /** Where texture images come from (the open project), and how they load (texturing/materialTextureLoader.ts; tests). */
    setTextureSource(resolveUrl: TextureUrlResolver, load?: TextureLoad): void {
        this.resolveUrl = resolveUrl;
        this.addedUrls.clear();
        if (load) this.loadTexture = load;
    }

    /** Where a texture's picture is read from (one added since the project opened, else the project's). */
    textureUrl(textureId: string): string | undefined {
        return this.addedUrls.get(textureId) ?? this.resolveUrl(textureId);
    }

    /** Where a texture added since the project opened comes from. */
    addTextureUrl(textureId: string, url: string): void {
        this.addedUrls.set(textureId, url);
    }

    list(): MaterialAsset[] {
        return [...this.assets.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    get(id: string): MaterialAsset | undefined {
        return this.assets.get(id);
    }

    /** Replaces every asset (a project opened). */
    replaceAll(assets: readonly MaterialAsset[]): void {
        this.generation++;
        this.assets.clear();
        for (const asset of assets) this.assets.set(asset.id, asset);
        this.rebindAll();
        this.emit();
    }

    /**
     * Adds or changes one asset; every material using it follows. Moving nodes or comments changes
     * nothing a material draws, so it touches no material; a change of values updates the materials'
     * uniforms as they are (graphMaterial.ts), and only a change of shape compiles anything.
     */
    upsert(asset: MaterialAsset): void {
        const previous = this.assets.get(asset.id);
        this.assets.set(asset.id, asset);
        const drawsTheSame = previous !== undefined && samePictures(previous.pictures, asset.pictures)
            && (previous.graph === asset.graph || materialGraphLook(previous.graph) === materialGraphLook(asset.graph));
        if (!drawsTheSame) for (const [material, binding] of this.bound) if (binding.materialId === asset.id) this.bindNow(material, binding);
        this.emit();
    }

    remove(id: string): void {
        this.assets.delete(id);
        for (const [material, binding] of [...this.bound]) {
            if (binding.materialId !== id) continue;
            this.bound.delete(material);
            this.pictureSource?.release(material);
            unbindMaterialGraph(material);
        }
        this.emit();
    }

    /** Lets go of a texture that has left memory, or just arrived after graphs asked for it in vain. Graphs keep naming it. */
    releaseTexture(textureId: string): void {
        for (const [key, texture] of [...this.textures]) {
            if (!key.endsWith(`:${textureId}`)) continue;
            texture?.dispose();
            this.textures.delete(key);
        }
    }

    /** Loads a texture again (its settings changed): every graph sampling it draws the new one once it is ready. */
    reloadTexture(textureId: string): void {
        this.releaseTexture(textureId);
        this.rebindAll();
        this.emit();
    }

    /** Clears a deleted texture from every graph sampling it (the project has already). */
    forgetTexture(textureId: string): void {
        for (const [key, texture] of [...this.textures]) {
            if (!key.endsWith(`:${textureId}`)) continue;
            texture?.dispose();
            this.textures.delete(key);
        }
        for (const asset of [...this.assets.values()]) {
            const next = withoutAssetTexture(asset, textureId);
            if (next !== asset) this.upsert(next);
        }
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * Shades `material` by asset `materialId` from now on (null gives it back its own shading).
     * False when there is no such asset (yet) or the material cannot take a graph.
     */
    assign(material: THREE.Material, materialId: string | null, flipY = true, parameters?: MaterialParameterValues): boolean {
        if (!canBindMaterialGraph(material)) return false;
        if (!materialId) {
            if (this.bound.delete(material)) unbindMaterialGraph(material);
            this.pictureSource?.release(material);
            return false;
        }
        const binding = { materialId, flipY, parameters };
        this.bound.set(material, binding);
        return this.bindNow(material, binding);
    }

    /** How a material is shaded by an asset here (its asset, UV origin and own values); undefined when it is not. */
    bindingOf(material: THREE.Material): Readonly<MaterialBinding> | undefined {
        return this.bound.get(material as THREE.MeshStandardMaterial);
    }

    /** The library's textures for graphs bound outside it (the editor's node previews); each loads when first asked for. */
    textureLookup(flipY = true): MaterialTextureLookup {
        return (textureId, slot) => this.texture(textureId, slot ?? 'map', flipY);
    }

    private bindNow(material: THREE.MeshStandardMaterial, binding: MaterialBinding): boolean {
        const asset = this.assets.get(binding.materialId);
        if (!asset) {
            unbindMaterialGraph(material);
            return false;
        }
        // A texture-graph material may draw with pictures cooked for this use (materialCooking.ts).
        const pictures = this.pictureSource?.pictures(asset, binding, material) ?? asset.pictures;
        bindMaterialGraph(material, withMaterialParameters(withMaterialPictures(asset.graph, pictures), binding.parameters), (textureId, slot) => this.texture(textureId, slot ?? 'map', binding.flipY));
        return true;
    }

    private rebindAll(): void {
        for (const [material, binding] of this.bound) this.bindNow(material, binding);
    }

    /** The texture, loading it the first time it is asked for; null until it has loaded. */
    private texture(textureId: string, slot: TextureSlot, flipY: boolean): THREE.Texture | null {
        const key = `${slot}:${flipY ? 1 : 0}:${textureId}`;
        if (this.textures.has(key)) return this.textures.get(key) ?? null;
        this.textures.set(key, null);
        const url = this.addedUrls.get(textureId) ?? this.resolveUrl(textureId);
        if (!url) return null;
        const loading = this.loadTexture(url, { textureId, slot, flipY }).then((texture) => {
            // A texture its loader set up from its settings (and laid the right way up) is left as it is.
            if (texture.userData?.auvraTextureSettings !== true) {
                // Only colour is decoded from sRGB; normals and data are read as stored.
                texture.colorSpace = slot === 'map' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
                texture.wrapS = THREE.RepeatWrapping;
                texture.wrapT = THREE.RepeatWrapping;
                // Sharp at grazing angles; three caps it at what the GPU supports.
                texture.anisotropy = 8;
                texture.flipY = flipY;
                texture.needsUpdate = true;
            }
            this.textures.set(key, texture);
            this.texturesLoaded++;
            // Every graph sampling it picks it up.
            this.rebindAll();
            this.emit();
        }, () => {
            this.textures.delete(key);
        }).finally(() => { this.loading.delete(key); });
        this.loading.set(key, loading);
        return null;
    }

    private emit(): void {
        this.version++;
        for (const listener of this.listeners) listener();
    }
}

/** The open project's material library. */
export const materialLibrary = new MaterialLibrary();
