import * as THREE from 'three';
import { getMaterialNodeDefinition, normalizeMaterialGraph, textureSlot, withMaterialParameters, type MaterialGraph, type MaterialParameterValues, type TextureSlot } from './materialGraph';
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
}

export const MATERIALS_DOMAIN = 'materials';

/** An asset as stored in the materials domain. */
export interface MaterialAssetDocument {
    id: string;
    name: string;
    graph: MaterialGraph;
    /** The textures the graph samples, so the project can keep them and check them. */
    textureIds: string[];
}

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

export const materialAssetDocument = (asset: MaterialAsset): MaterialAssetDocument => ({
    id: asset.id,
    name: asset.name,
    graph: asset.graph,
    textureIds: [...new Set(graphTextures(asset.graph).map(texture => texture.textureId))],
});

/** A stored asset made safe, or null when it is not one. */
export const readMaterialAsset = (value: unknown): MaterialAsset | null => {
    if (!value || typeof value !== 'object') return null;
    const document = value as Partial<MaterialAssetDocument>;
    if (typeof document.id !== 'string' || !document.id) return null;
    return {
        id: document.id,
        name: typeof document.name === 'string' && document.name.trim() ? document.name.trim().slice(0, 128) : 'Material',
        graph: normalizeMaterialGraph(document.graph),
    };
};

/** Where a texture id's image is, for loading it. */
export type TextureUrlResolver = (textureId: string) => string | undefined;

interface Binding {
    materialId: string;
    /** Texture coordinates with the glTF top-left origin (flipY false), else the FBX/OBJ bottom-left. */
    flipY: boolean;
    /** This material's own values for the asset's parameters. */
    parameters?: MaterialParameterValues;
}

class MaterialLibrary {
    /** Counts changes to the assets, for subscribers that compare snapshots. */
    version = 0;
    private readonly assets = new Map<string, MaterialAsset>();
    private readonly listeners = new Set<() => void>();
    private readonly bound = new Map<THREE.MeshStandardMaterial, Binding>();
    private readonly textures = new Map<string, THREE.Texture | null>();
    private resolveUrl: TextureUrlResolver = () => undefined;
    private loadTexture: (url: string) => Promise<THREE.Texture> = (url) => new THREE.TextureLoader().loadAsync(url);

    /** Where texture images come from (the open project), and how they load (tests). */
    setTextureSource(resolveUrl: TextureUrlResolver, load?: (url: string) => Promise<THREE.Texture>): void {
        this.resolveUrl = resolveUrl;
        if (load) this.loadTexture = load;
    }

    list(): MaterialAsset[] {
        return [...this.assets.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    get(id: string): MaterialAsset | undefined {
        return this.assets.get(id);
    }

    /** Replaces every asset (a project opened). */
    replaceAll(assets: readonly MaterialAsset[]): void {
        this.assets.clear();
        for (const asset of assets) this.assets.set(asset.id, asset);
        this.rebindAll();
        this.emit();
    }

    /** Adds or changes one asset; every material using it follows. */
    upsert(asset: MaterialAsset): void {
        this.assets.set(asset.id, asset);
        for (const [material, binding] of this.bound) if (binding.materialId === asset.id) this.bindNow(material, binding);
        this.emit();
    }

    remove(id: string): void {
        this.assets.delete(id);
        for (const [material, binding] of [...this.bound]) {
            if (binding.materialId !== id) continue;
            this.bound.delete(material);
            unbindMaterialGraph(material);
        }
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
            const graph = withoutGraphTexture(asset.graph, textureId);
            if (graph !== asset.graph) this.upsert({ ...asset, graph });
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
            return false;
        }
        const binding = { materialId, flipY, parameters };
        this.bound.set(material, binding);
        return this.bindNow(material, binding);
    }

    /** The library's textures for graphs bound outside it (the editor's node previews); each loads when first asked for. */
    textureLookup(flipY = true): MaterialTextureLookup {
        return (textureId, slot) => this.texture(textureId, slot ?? 'map', flipY);
    }

    private bindNow(material: THREE.MeshStandardMaterial, binding: Binding): boolean {
        const asset = this.assets.get(binding.materialId);
        if (!asset) {
            unbindMaterialGraph(material);
            return false;
        }
        bindMaterialGraph(material, withMaterialParameters(asset.graph, binding.parameters), (textureId, slot) => this.texture(textureId, slot ?? 'map', binding.flipY));
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
        const url = this.resolveUrl(textureId);
        if (!url) return null;
        this.loadTexture(url).then((texture) => {
            // Only colour is decoded from sRGB; normals and data are read as stored.
            texture.colorSpace = slot === 'map' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.RepeatWrapping;
            // Sharp at grazing angles; three caps it at what the GPU supports.
            texture.anisotropy = 8;
            texture.flipY = flipY;
            texture.needsUpdate = true;
            this.textures.set(key, texture);
            // Every graph sampling it picks it up.
            this.rebindAll();
            this.emit();
        }, () => {
            this.textures.delete(key);
        });
        return null;
    }

    private emit(): void {
        this.version++;
        for (const listener of this.listeners) listener();
    }
}

/** The open project's material library. */
export const materialLibrary = new MaterialLibrary();
