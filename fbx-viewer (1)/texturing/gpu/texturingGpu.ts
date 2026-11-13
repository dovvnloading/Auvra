import type * as THREE from 'three';
import type { GpuImage, ImageKind, ImagePrecision, InstanceOptions, PassInput, PassOptions } from './textureGpu';

/**
 * WHAT A TEXTURE GRAPH NEEDS OF A GPU
 *
 * The texture graph's evaluator and nodes draw through this: images from a pool, fragment passes over
 * them, instanced copies, and reading pixels back. The editor's WebGL2 context (textureGpu.ts) is one;
 * WebGPU (webgpuTexturing.ts) is another, used where a game draws with WebGPU.
 */
export interface TexturingGpu {
    /** The largest side an image can have. */
    readonly maxSize: number;
    /** GPU bytes held by images in use and idle in the pool. */
    readonly memory: { live: number; idle: number };
    image(width: number, height: number, kind: ImageKind, precision?: ImagePrecision): GpuImage;
    retain(image: GpuImage): GpuImage;
    release(image: GpuImage | null | undefined): void;
    /** A 1×1 texture of one value, for inputs nothing is wired to. */
    constant(name: 'white' | 'black' | 'mid' | 'normal' | 'clear'): THREE.DataTexture;
    /** Draws `options.fragment` over `target`; heavy passes are drawn in bands. */
    pass(target: GpuImage, options: PassOptions): Promise<void>;
    /** Draws a pass straight away, in one go. */
    passNow(target: GpuImage, options: PassOptions): void;
    drawInstances(target: GpuImage, options: InstanceOptions): Promise<void>;
    clear(target: GpuImage, value?: [number, number, number, number]): void;
    copy(from: PassInput, to: GpuImage): void;
    /** The image as 8-bit RGBA pixels (bottom row first); grey expands to RGB with opaque alpha. */
    readRgba8Later(image: GpuImage): Promise<Uint8Array | null>;
    /** One pixel's four values as kept (x, y from the bottom left). */
    readPixelLater(source: GpuImage, x: number, y: number): Promise<Float32Array | null>;
    /** The image scaled to `width` x `height` as 16-bit values (one a pixel for grey, four for colour), top row first when `flipRows`. */
    readUint16Async(source: PassInput, width: number, height: number, encode: 'color' | 'gray', flipRows?: boolean): Promise<Uint16Array>;
    /** A PNG of the image (top row first), 8 bits a channel. */
    toPng(source: PassInput, width: number, height: number, encode?: 'color' | 'gray' | 'raw', flipRows?: boolean): Promise<Blob>;
    /** Called when the device comes back after being lost: everything made on it must be made again. */
    onRestored(listener: () => void): () => void;
}
