import * as THREE from 'three';
import { bindMaterialGraph, materialGraphAnimated, type MaterialTextureLookup } from './graphMaterial';
import type { MaterialGraph } from './materialGraph';

/**
 * NODE PREVIEWS
 *
 * The material editor shows each node's value as a small image. One shader computes every node of
 * the graph (graphMaterial.ts preview mode), and one render target holds a tile per node; a draw per
 * tile fills it, and one read back hands each node its image. The shader is rebuilt only when the
 * graph's shape changes, and compiled without blocking when the GPU can.
 */

/** Pixels across a node preview. */
export const NODE_PREVIEW_SIZE = 96;

/** Images published by the previewer, by node id, for the canvas to paint. */
class NodePreviewImages {
    private images = new Map<string, ImageData>();
    private readonly listeners = new Set<() => void>();

    get(nodeId: string): ImageData | undefined {
        return this.images.get(nodeId);
    }

    publish(images: Map<string, ImageData>): void {
        this.images = images;
        for (const listener of this.listeners) listener();
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

export const nodePreviewImages = new NodePreviewImages();

export class MaterialNodePreviewer {
    private readonly material = new THREE.MeshStandardMaterial();
    private readonly scene = new THREE.Scene();
    private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    private readonly mesh: THREE.Mesh;
    private target: THREE.WebGLRenderTarget | null = null;
    private pixels = new Uint8Array(0);
    private nodeIds: string[] = [];
    private columns = 1;
    private compiledKey = '';
    private compiling: Promise<void> | null = null;
    /** True when a node reads the time, so its preview moves. */
    animated = false;

    constructor() {
        this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
        this.mesh.frustumCulled = false;
        this.scene.add(this.mesh);
        this.camera.position.z = 1;
    }

    /** Previews `nodeIds` of `graph`; the shader is rebuilt only when the graph's shape changes. */
    setGraph(graph: MaterialGraph, nodeIds: readonly string[], textures: MaterialTextureLookup): void {
        this.nodeIds = [...nodeIds];
        this.columns = Math.max(1, Math.ceil(Math.sqrt(this.nodeIds.length)));
        bindMaterialGraph(this.material, graph, textures, { nodeIds: this.nodeIds, tile: NODE_PREVIEW_SIZE, columns: this.columns });
        this.animated = materialGraphAnimated(this.material);
    }

    /**
     * Renders every preview and returns each node's image, or null while the shader is still being
     * compiled (the previous images stay up meanwhile).
     */
    render(renderer: THREE.WebGLRenderer): Map<string, ImageData> | null {
        const count = this.nodeIds.length;
        if (!count) return new Map();
        const size = NODE_PREVIEW_SIZE;
        const columns = this.columns;
        const rows = Math.ceil(count / columns);
        const width = columns * size;
        const height = rows * size;
        if (!this.target || this.target.width !== width || this.target.height !== height) {
            this.target?.dispose();
            this.target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: false });
            this.pixels = new Uint8Array(width * height * 4);
        }
        const target = this.target;
        const previousTarget = renderer.getRenderTarget();

        const key = this.material.customProgramCacheKey();
        if (key !== this.compiledKey) {
            if (!this.compiling) {
                // Compiled for the render target (linear output), as it is drawn.
                renderer.setRenderTarget(target);
                const compiling = renderer.compileAsync(this.scene, this.camera).catch(() => undefined).then(() => {
                    if (this.compiling === compiling) this.compiling = null;
                    this.compiledKey = key;
                });
                this.compiling = compiling;
                renderer.setRenderTarget(previousTarget);
            }
            return null;
        }

        const previousAutoClear = renderer.autoClear;
        renderer.autoClear = false;
        target.scissorTest = true;
        for (let index = 0; index < count; index++) {
            const x = (index % columns) * size;
            const y = Math.floor(index / columns) * size;
            target.viewport.set(x, y, size, size);
            target.scissor.set(x, y, size, size);
            // The viewport is taken when the target is set.
            renderer.setRenderTarget(target);
            renderer.render(this.scene, this.camera);
        }
        renderer.readRenderTargetPixels(target, 0, 0, width, height, this.pixels);
        renderer.setRenderTarget(previousTarget);
        renderer.autoClear = previousAutoClear;

        const images = new Map<string, ImageData>();
        this.nodeIds.forEach((nodeId, index) => {
            const x0 = (index % columns) * size;
            const y0 = Math.floor(index / columns) * size;
            const image = new ImageData(size, size);
            // GL rows run bottom to top.
            for (let row = 0; row < size; row++) {
                const from = ((y0 + size - 1 - row) * width + x0) * 4;
                image.data.set(this.pixels.subarray(from, from + size * 4), row * size * 4);
            }
            images.set(nodeId, image);
        });
        return images;
    }

    dispose(): void {
        this.target?.dispose();
        this.material.dispose();
        this.mesh.geometry.dispose();
    }
}
