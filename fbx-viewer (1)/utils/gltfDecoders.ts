import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader, type KTX2LoaderWorkerConfig } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'meshoptimizer';
import { gpuExtensions } from './textureCompression/compressTextures';

/**
 * DECODERS FOR COMPRESSED glTF
 *
 * KHR_texture_basisu: KTX2 (Basis Universal) textures are transcoded in workers to a format this
 * GPU samples as it is (BC7 or BC1/BC3 on desktops, ASTC or ETC on phones), so they stay small in
 * GPU memory as well as on disk. EXT_meshopt_compression: meshoptimizer-compressed geometry and
 * animation is decoded as it loads. KHR_draco_mesh_compression: Draco-compressed geometry is
 * decoded in workers.
 *
 * three's loaders for Basis and Draco build their workers from blob: URLs, which the editor's CSP
 * refuses; these run the same work in module workers served with the app.
 */

/** The decoders' WebAssembly, served with the app. */
const BASIS_TRANSCODER = new URL('../node_modules/three/examples/jsm/libs/basis/basis_transcoder.wasm', import.meta.url);
const DRACO_DECODER = new URL('../node_modules/three/examples/jsm/libs/draco/gltf/draco_decoder.wasm', import.meta.url);

const fetchBinary = async (url: URL, what: string): Promise<ArrayBuffer> => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`The ${what} could not be loaded (${response.status}).`);
    return response.arrayBuffer();
};

/** Which GPU formats Basis textures transcode to, given the WebGL extensions the device offers. */
export const basisTranscodeTargets = (has: (extension: string) => boolean): KTX2LoaderWorkerConfig => {
    const bc = has('WEBGL_compressed_texture_s3tc') || has('EXT_texture_compression_bptc');
    return {
        astcSupported: has('WEBGL_compressed_texture_astc'),
        astcHDRSupported: false,
        // Desktop GPUs have no ETC hardware: a driver that offers ETC unpacks it to full size, so BC is used where there is BC.
        etc1Supported: !bc && has('WEBGL_compressed_texture_etc1'),
        etc2Supported: !bc && has('WEBGL_compressed_texture_etc'),
        // Colour textures are sRGB, so BC1/BC3 need the sRGB formats too (BC7 always has them).
        dxtSupported: has('WEBGL_compressed_texture_s3tc') && has('WEBGL_compressed_texture_s3tc_srgb'),
        bptcSupported: has('EXT_texture_compression_bptc'),
        pvrtcSupported: has('WEBGL_compressed_texture_pvrtc') || has('WEBKIT_WEBGL_compressed_texture_pvrtc'),
    };
};

/**
 * Runs three's own transcoding worker code (so it speaks this three's protocol) in a module worker,
 * and reads the GPU's formats from the device rather than a renderer.
 */
class AppKtx2Loader extends KTX2Loader {
    private ensureTargets(): void {
        if (this.workerConfig === null) {
            const offered = gpuExtensions();
            this.workerConfig = basisTranscodeTargets(extension => offered.has(extension));
        }
    }

    load(...args: Parameters<KTX2Loader['load']>): void {
        this.ensureTargets();
        super.load(...args);
    }

    parse(...args: Parameters<KTX2Loader['parse']>): void {
        this.ensureTargets();
        super.parse(...args);
    }

    init(): Promise<void> {
        if (!this.transcoderPending) {
            this.transcoderPending = fetchBinary(BASIS_TRANSCODER, 'Basis texture transcoder').then((binary) => {
                this.workerPool.setWorkerCreator(() => {
                    const worker = new Worker(new URL('../workers/basisTranscode.worker.ts', import.meta.url), { type: 'module' });
                    const transcoderBinary = binary.slice(0);
                    worker.postMessage({ type: 'init', config: this.workerConfig, transcoderBinary }, [transcoderBinary]);
                    return worker;
                });
            });
        }
        return this.transcoderPending;
    }
}

type DracoWorker = Worker & {
    _callbacks: Record<number, { resolve: (message: unknown) => void; reject: (message: unknown) => void }>;
    _taskCosts: Record<number, number>;
    _taskLoad: number;
};
/** What DRACOLoader keeps about its decoder and workers. */
interface DracoLoaderState {
    decoderConfig: { wasmBinary?: ArrayBuffer };
    decoderPending: Promise<void> | null;
    workerLimit: number;
    workerPool: DracoWorker[];
}

/** Decodes in workers/dracoDecode.worker.ts, which speaks DRACOLoader's protocol; the rest is three's. */
class AppDracoLoader extends DRACOLoader {
    private get state(): DracoLoaderState {
        return this as unknown as DracoLoaderState;
    }

    _initDecoder(): Promise<void> {
        const state = this.state;
        state.decoderPending ??= fetchBinary(DRACO_DECODER, 'Draco decoder').then((binary) => { state.decoderConfig.wasmBinary = binary; });
        return state.decoderPending;
    }

    /** DRACOLoader's own worker choice (each task to a new worker up to the limit, then to the least loaded), with module workers. */
    _getWorker(taskID: number, taskCost: number): Promise<DracoWorker> {
        const state = this.state;
        return this._initDecoder().then(() => {
            if (state.workerPool.length < state.workerLimit) {
                const worker = new Worker(new URL('../workers/dracoDecode.worker.ts', import.meta.url), { type: 'module' }) as DracoWorker;
                worker._callbacks = {};
                worker._taskCosts = {};
                worker._taskLoad = 0;
                worker.postMessage({ type: 'init', decoderConfig: state.decoderConfig });
                worker.onmessage = (event: MessageEvent<{ type: string; id: number }>) => {
                    const callback = worker._callbacks[event.data.id];
                    if (event.data.type === 'decode') callback?.resolve(event.data);
                    else if (event.data.type === 'error') callback?.reject(event.data);
                };
                state.workerPool.push(worker);
            } else {
                state.workerPool.sort((a, b) => (a._taskLoad > b._taskLoad ? -1 : 1));
            }
            const worker = state.workerPool[state.workerPool.length - 1];
            worker._taskCosts[taskID] = taskCost;
            worker._taskLoad += taskCost;
            return worker;
        });
    }
}

/** One of each loader for every model, so their workers and decoders are shared. */
let ktx2Loader: AppKtx2Loader | null = null;
let dracoLoader: AppDracoLoader | null = null;

/** Gives `loader` the decoders for Basis textures, meshopt and Draco compression. */
export const withGltfDecoders = (loader: GLTFLoader): GLTFLoader => {
    ktx2Loader ??= new AppKtx2Loader();
    dracoLoader ??= new AppDracoLoader();
    return loader.setKTX2Loader(ktx2Loader).setMeshoptDecoder(MeshoptDecoder).setDRACOLoader(dracoLoader);
};
