import * as THREE from 'three';
import { encodePng } from '../png';
import { GlslError } from '../../renderer/gpu/surfaces/glslToWgsl';
import { translatePass, type PassModule } from './glslModule';
import { FrameBudget, ShaderError, type GpuImage, type ImageKind, type ImagePrecision, type InstanceOptions, type PassInput, type PassOptions } from './textureGpu';
import type { TexturingGpu } from './texturingGpu';
import { layoutUniforms, packUniforms, type UniformLayout } from './uniformLayout';

/**
 * TEXTURE GRAPHS ON WEBGPU
 *
 * The texturing GPU (texturingGpu.ts) on a WebGPU device, for games that draw with WebGPU: images are
 * textures from a pool, a pass is a render pass of one full-screen triangle whose WGSL is the pass's
 * GLSL translated (glslModule.ts) or a function graph's own, uniforms one struct in a storage buffer,
 * pixels read back through mapped buffers. Instanced copies use the same placement GLSL translated
 * into WGSL, with hardware depth for higher-wins and blending for max/add. Rows lie in memory as
 * WebGL keeps them (the first row is v = 0). What it cannot do yet (compressed pictures, a pass
 * that does not translate or compile) it refuses with WebGpuUnsupported, saying why,
 * and the caller draws that graph with WebGL2 instead.
 *
 * WebGPU's own types are not needed here: the device is described by the little of it this uses.
 */

/** Something the WebGPU path does not do (yet), in words: the graph is drawn with WebGL2 instead. */
export class WebGpuUnsupported extends Error {}

// The little of WebGPU used here, so the texturing code does not lean on WebGPU's type package.
interface WgpuTexture { createView(descriptor?: object): unknown; destroy(): void }
interface WgpuBuffer { mapAsync(mode: number): Promise<void>; getMappedRange(): ArrayBuffer; unmap(): void; destroy(): void }
interface WgpuRenderPass { setPipeline(pipeline: unknown): void; setBindGroup(index: number, group: unknown): void; setScissorRect(x: number, y: number, width: number, height: number): void; draw(count: number, instanceCount?: number): void; end(): void }
interface WgpuEncoder {
    beginRenderPass(descriptor: object): WgpuRenderPass;
    copyTextureToBuffer(source: object, destination: object, size: object): void;
    finish(): unknown;
}
interface WgpuQueue {
    submit(buffers: unknown[]): void;
    writeBuffer(buffer: WgpuBuffer, offset: number, data: ArrayBuffer | ArrayBufferView): void;
    writeTexture(destination: object, data: ArrayBufferView, layout: object, size: object): void;
    copyExternalImageToTexture(source: object, destination: object, size: object): void;
    onSubmittedWorkDone(): Promise<void>;
}
export interface WgpuDevice {
    readonly limits: { maxTextureDimension2D: number };
    readonly features: { has(name: string): boolean };
    readonly queue: WgpuQueue;
    readonly lost: Promise<unknown>;
    createTexture(descriptor: object): WgpuTexture;
    createSampler(descriptor: object): unknown;
    createBuffer(descriptor: object): WgpuBuffer;
    createShaderModule(descriptor: { code: string }): unknown;
    createBindGroupLayout(descriptor: object): unknown;
    createPipelineLayout(descriptor: object): unknown;
    createRenderPipeline(descriptor: object): unknown;
    createBindGroup(descriptor: object): unknown;
    createCommandEncoder(descriptor?: object): WgpuEncoder;
    pushErrorScope(filter: string): void;
    popErrorScope(): Promise<{ message: string } | null>;
}

// WebGPU's flags, by value (its globals are not there where nothing has WebGPU, such as the tests).
const TEXTURE_USAGE = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
const BUFFER_USAGE = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, STORAGE: 128 };
const MAP_READ = 1;
const FRAGMENT_STAGE = 2;

const FRAME_SAMPLES = 96_000_000;
const POOL_IDLE_BYTES = 512 * 1024 * 1024;

/** An image's texture format, and its bytes a pixel. */
export const imageFormat = (kind: ImageKind, precision: ImagePrecision): { format: string; bytes: number } => {
    if (kind === 'color') return precision === 8 ? { format: 'rgba8unorm', bytes: 4 } : precision === 16 ? { format: 'rgba16float', bytes: 8 } : { format: 'rgba32float', bytes: 16 };
    return precision === 8 ? { format: 'r8unorm', bytes: 1 } : precision === 16 ? { format: 'r16float', bytes: 2 } : { format: 'r32float', bytes: 4 };
};

/** A data texture's WebGPU format and bytes a texel, from three's format and type; null when there is none. */
export const dataTextureFormat = (format: number, type: number, srgb: boolean): { format: string; bytes: number } | null => {
    const channels = format === THREE.RGBAFormat ? 4 : format === THREE.RGFormat ? 2 : format === THREE.RedFormat ? 1 : 0;
    if (!channels) return null;
    const names = ['r', 'rg', '', 'rgba'];
    const base = names[channels - 1];
    if (type === THREE.UnsignedByteType) return { format: `${base}8unorm${srgb && channels === 4 ? '-srgb' : ''}`, bytes: channels };
    if (type === THREE.FloatType) return { format: `${base}32float`, bytes: channels * 4 };
    if (type === THREE.HalfFloatType) return { format: `${base}16float`, bytes: channels * 2 };
    return null;
};

const isFloat32 = (format: string): boolean => format.endsWith('32float');

interface Handle { texture: WgpuTexture; view: unknown; format: string; key: string; bytes: number }

const handleOf = (image: GpuImage): Handle => image.target as unknown as Handle;
const isImage = (value: PassInput): value is GpuImage => (value as GpuImage).target !== undefined && (value as GpuImage).refs !== undefined;

interface Pipeline { pipeline: unknown; layout: unknown; module: PassModule; uniforms: UniformLayout; sampleTypes: string[]; broken: Promise<string | null> }

/** Bytes a row of a texture copy takes, rounded up as WebGPU asks. */
const paddedRow = (width: number, bytes: number): number => Math.ceil((width * bytes) / 256) * 256;

export class WebGpuTexturing implements TexturingGpu {
    readonly budget = new FrameBudget();
    /** Passes that would not compile on the device, said after the fact (a pass drawn at once cannot wait to hear). */
    readonly problems: string[] = [];
    private readonly idle = new Map<string, Handle[]>();
    private idleBytes = 0;
    private liveBytes = 0;
    private readonly pipelines = new Map<string, Pipeline>();
    private readonly samplers = new Map<string, unknown>();
    private readonly uploads = new WeakMap<THREE.Texture, { handle: Handle; version: number }>();
    private readonly defaults = new Map<string, THREE.DataTexture>();
    private readonly float32Filterable: boolean;

    constructor(private readonly device: WgpuDevice) {
        this.float32Filterable = device.features.has('float32-filterable');
    }

    get maxSize(): number {
        return this.device.limits.maxTextureDimension2D;
    }

    get memory(): { live: number; idle: number } {
        return { live: this.liveBytes, idle: this.idleBytes };
    }

    /** The problems heard since last asked, cleared. */
    takeProblems(): string[] {
        return this.problems.splice(0, this.problems.length);
    }

    onRestored(): () => void {
        // A lost WebGPU device does not come back: the game asks for a new one, and a new texturing GPU with it.
        return () => undefined;
    }

    // ---- images ----

    image(width: number, height: number, kind: ImageKind, precision: ImagePrecision = kind === 'color' ? 8 : 16): GpuImage {
        width = Math.max(1, Math.min(this.maxSize, Math.round(width)));
        height = Math.max(1, Math.min(this.maxSize, Math.round(height)));
        const { format, bytes } = imageFormat(kind, precision);
        const key = `${width}x${height}:${format}`;
        let handle = this.idle.get(key)?.pop();
        if (handle) this.idleBytes -= width * height * bytes;
        else {
            const texture = this.device.createTexture({
                size: [width, height], format,
                usage: TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_SRC | TEXTURE_USAGE.COPY_DST,
            });
            handle = { texture, view: texture.createView(), format, key, bytes: width * height * bytes };
        }
        this.liveBytes += width * height * bytes;
        return { target: handle as unknown as THREE.WebGLRenderTarget, kind, precision, width, height, refs: 1 };
    }

    retain(image: GpuImage): GpuImage {
        image.refs++;
        return image;
    }

    release(image: GpuImage | null | undefined): void {
        if (!image || image.refs <= 0) return;
        image.refs--;
        if (image.refs > 0) return;
        const handle = handleOf(image);
        const bytes = image.width * image.height * imageFormat(image.kind, image.precision).bytes;
        this.liveBytes -= bytes;
        let list = this.idle.get(handle.key);
        if (!list) this.idle.set(handle.key, list = []);
        list.push(handle);
        this.idleBytes += bytes;
        this.trimPool();
    }

    trimPool(limit = POOL_IDLE_BYTES): void {
        for (const list of this.idle.values()) {
            while (list.length && this.idleBytes > limit) {
                const handle = list.pop()!;
                handle.texture.destroy();
                this.idleBytes -= handle.bytes;
            }
            if (this.idleBytes <= limit) return;
        }
    }

    constant(name: 'white' | 'black' | 'mid' | 'normal' | 'clear'): THREE.DataTexture {
        let texture = this.defaults.get(name);
        if (texture) return texture;
        const values: Record<typeof name, number[]> = { white: [255, 255, 255, 255], black: [0, 0, 0, 255], mid: [128, 128, 128, 255], normal: [128, 128, 255, 255], clear: [0, 0, 0, 0] };
        texture = new THREE.DataTexture(new Uint8Array(values[name]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.needsUpdate = true;
        this.defaults.set(name, texture);
        return texture;
    }

    /** A three texture on the device: uploaded once, again when it changes, let go of with it. */
    private textureHandle(texture: THREE.Texture): Handle {
        const kept = this.uploads.get(texture);
        if (kept && kept.version === texture.version) return kept.handle;
        kept?.handle.texture.destroy();
        const srgb = texture.colorSpace === THREE.SRGBColorSpace;
        const data = texture as THREE.DataTexture;
        let handle: Handle;
        if ((texture as THREE.CompressedTexture).isCompressedTexture) throw new WebGpuUnsupported('a compressed picture is read, which the WebGPU path does not read yet');
        if (data.isDataTexture) {
            const image = data.image as { data: ArrayBufferView; width: number; height: number };
            const shape = dataTextureFormat(texture.format, texture.type, srgb);
            if (!shape) throw new WebGpuUnsupported(`a picture of format ${texture.format} and type ${texture.type} is read, which the WebGPU path does not read yet`);
            const gpuTexture = this.device.createTexture({ size: [image.width, image.height], format: shape.format, usage: TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST });
            this.device.queue.writeTexture({ texture: gpuTexture }, image.data, { bytesPerRow: image.width * shape.bytes, rowsPerImage: image.height }, [image.width, image.height]);
            handle = { texture: gpuTexture, view: gpuTexture.createView(), format: shape.format, key: '', bytes: 0 };
        } else {
            const source = texture.image as { width: number; height: number } | null;
            if (!source || !source.width) throw new WebGpuUnsupported('a picture that has not loaded is read');
            const format = srgb ? 'rgba8unorm-srgb' : 'rgba8unorm';
            const gpuTexture = this.device.createTexture({ size: [source.width, source.height], format, usage: TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST | TEXTURE_USAGE.RENDER_ATTACHMENT });
            this.device.queue.copyExternalImageToTexture({ source, flipY: texture.flipY }, { texture: gpuTexture }, [source.width, source.height]);
            handle = { texture: gpuTexture, view: gpuTexture.createView(), format, key: '', bytes: 0 };
        }
        if (!kept) texture.addEventListener('dispose', () => { this.uploads.get(texture)?.handle.texture.destroy(); this.uploads.delete(texture); });
        this.uploads.set(texture, { handle, version: texture.version });
        return handle;
    }

    private inputHandle(input: PassInput | null | undefined): Handle {
        if (!input) return this.textureHandle(this.constant('black'));
        return isImage(input) ? handleOf(input) : this.textureHandle(input);
    }

    /** How a three texture (or an image) is sampled: repeating unless it clamps, smooth unless it is sharp or cannot be. */
    private sampler(input: PassInput | null | undefined, filterable: boolean): unknown {
        const texture = input && !isImage(input) ? input : null;
        const address = (wrap: number) => (wrap === THREE.ClampToEdgeWrapping ? 'clamp-to-edge' : wrap === THREE.MirroredRepeatWrapping ? 'mirror-repeat' : 'repeat');
        const nearest = !filterable || (texture ? texture.magFilter === THREE.NearestFilter : false);
        const u = texture ? address(texture.wrapS) : 'repeat';
        const v = texture ? address(texture.wrapT) : 'repeat';
        const key = `${u}:${v}:${nearest ? 'nearest' : 'linear'}`;
        let made = this.samplers.get(key);
        if (!made) {
            made = this.device.createSampler({ addressModeU: u, addressModeV: v, magFilter: nearest ? 'nearest' : 'linear', minFilter: nearest ? 'nearest' : 'linear' });
            this.samplers.set(key, made);
        }
        return made;
    }

    // ---- passes ----

    private pipelineFor(options: PassOptions, names: readonly string[], formats: readonly string[], target: string, instances?: InstanceOptions): Pipeline {
        const sampleTypes = formats.map((format) => (isFloat32(format) && !this.float32Filterable ? 'unfilterable-float' : 'float'));
        const key = `${instances ? `instances:${instances.stack}:${instances.points ? 'points' : 'quads'}:${instances.varyings.join(';')}:${instances.vertex}|` : ''}${target}|${options.blend ?? 'none'}|${names.join(',')}|${sampleTypes.join(',')}|${options.wgsl ? `${options.wgsl.functions}|${options.wgsl.result}` : ''}\n${options.fragment}`;
        const cached = this.pipelines.get(key);
        if (cached) return cached;
        let module: PassModule;
        try {
            module = translatePass({ fragment: options.fragment, inputs: names, ...(options.wgsl ? { wgsl: options.wgsl } : {}), ...(instances ? { instances: { vertex: instances.vertex, varyings: instances.varyings, points: Boolean(instances.points), depth: instances.stack === 'higher' } } : {}) });
        } catch (error) {
            if (error instanceof GlslError) throw new WebGpuUnsupported(`a pass does not translate to WGSL: ${error.message}`);
            throw error;
        }
        const types = module.textures.map((name) => sampleTypes[names.indexOf(name)] ?? 'float');
        const layout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: FRAGMENT_STAGE, buffer: { type: 'read-only-storage' } },
                ...module.textures.flatMap((_name, index) => [
                    { binding: 1 + index * 2, visibility: FRAGMENT_STAGE, texture: { sampleType: types[index] } },
                    { binding: 2 + index * 2, visibility: FRAGMENT_STAGE, sampler: { type: types[index] === 'float' ? 'filtering' : 'non-filtering' } },
                ]),
            ],
        });
        const blend = options.blend === 'add' ? { color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one' } }
            : options.blend === 'max' ? { color: { operation: 'max', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'max', srcFactor: 'one', dstFactor: 'one' } }
                : options.blend === 'alpha' ? { color: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } }
                    : undefined;
        this.device.pushErrorScope('validation');
        const shader = this.device.createShaderModule({ code: module.code });
        const pipeline = this.device.createRenderPipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
            vertex: { module: shader, entryPoint: 'vs_main' },
            fragment: { module: shader, entryPoint: 'fs_main', targets: [{ format: target, ...(blend ? { blend } : {}) }] },
            primitive: { topology: instances?.points ? 'point-list' : 'triangle-list' },
            ...(instances?.stack === 'higher' ? { depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' } } : {}),
        });
        const broken = this.device.popErrorScope().then((error) => (error ? error.message : null)).catch(() => null);
        const made: Pipeline = { pipeline, layout, module, uniforms: layoutUniforms(module.uniforms), sampleTypes: types, broken };
        void broken.then((message) => {
            if (!message) return;
            this.problems.push(`a pass did not compile on the device: ${message.split('\n')[0]}`);
            this.pipelines.delete(key);
        });
        this.pipelines.set(key, made);
        if (this.pipelines.size > 400) this.pipelines.delete(this.pipelines.keys().next().value as string);
        return made;
    }

    /** The pass's pipeline, a function drawing (part of) it into `target`, and one letting its uniforms go once drawn. */
    private prepare(target: GpuImage, options: PassOptions): { pipeline: Pipeline; draw: (rows?: [number, number]) => void; done: () => void } {
        const names = Object.keys(options.inputs ?? {});
        const handles = names.map((name) => this.inputHandle(options.inputs![name]));
        const pipeline = this.pipelineFor(options, names, handles.map((handle) => handle.format), handleOf(target).format);
        const values: Record<string, unknown> = { uSize: [target.width, target.height], ...(options.uniforms ?? {}) };
        const bytes = packUniforms(pipeline.uniforms, values);
        const buffer = this.device.createBuffer({ size: bytes.byteLength, usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST });
        this.device.queue.writeBuffer(buffer, 0, bytes);
        const entries: object[] = [{ binding: 0, resource: { buffer } }];
        pipeline.module.textures.forEach((name, index) => {
            const at = names.indexOf(name);
            const input = at >= 0 ? options.inputs![name] : null;
            const handle = at >= 0 ? handles[at] : this.inputHandle(null);
            entries.push({ binding: 1 + index * 2, resource: handle.view }, { binding: 2 + index * 2, resource: this.sampler(input, pipeline.sampleTypes[index] === 'float') });
        });
        const group = this.device.createBindGroup({ layout: pipeline.layout, entries });
        const area = options.scissor ?? { x: 0, y: 0, width: target.width, height: target.height };
        const draw = (rows?: [number, number]) => {
            const encoder = this.device.createCommandEncoder();
            const pass = encoder.beginRenderPass({ colorAttachments: [{ view: handleOf(target).view, loadOp: 'load', storeOp: 'store' }] });
            pass.setPipeline(pipeline.pipeline);
            pass.setBindGroup(0, group);
            const y0 = rows ? rows[0] : area.y;
            const y1 = rows ? rows[1] : area.y + area.height;
            pass.setScissorRect(area.x, y0, area.width, Math.max(0, y1 - y0));
            pass.draw(3);
            pass.end();
            this.device.queue.submit([encoder.finish()]);
        };
        // Destroying the buffer after the last draw is queued is allowed: the queued work still reads it.
        return { pipeline, draw, done: () => buffer.destroy() };
    }

    async pass(target: GpuImage, options: PassOptions): Promise<void> {
        const { pipeline, draw, done } = this.prepare(target, options);
        // A pass waits to hear its shader compiled: one that did not fails here, so the graph goes to WebGL2.
        const broken = await pipeline.broken;
        if (broken) { done(); throw new ShaderError(`On WebGPU: ${broken.split('\n').slice(0, 4).join('\n')}`); }
        try {
            await this.drawBands(target, options, draw);
        } finally {
            done();
        }
    }

    private async drawBands(target: GpuImage, options: PassOptions, draw: (rows?: [number, number]) => void): Promise<void> {
        const area = options.scissor ?? { x: 0, y: 0, width: target.width, height: target.height };
        const samples = area.width * area.height * Math.max(1, options.cost ?? 1);
        const bands = Math.max(1, Math.min(area.height, Math.ceil(samples / (FRAME_SAMPLES / 2))));
        for (let band = 0; band < bands; band++) {
            const y0 = area.y + Math.floor((area.height * band) / bands);
            const y1 = area.y + Math.floor((area.height * (band + 1)) / bands);
            draw([y0, y1]);
            this.budget.spend((samples * (y1 - y0)) / area.height);
            // A heavy pass in bands lets the device finish each before the next is queued.
            if (bands > 1) await this.device.queue.onSubmittedWorkDone();
            await this.budget.pace();
        }
    }

    passNow(target: GpuImage, options: PassOptions): void {
        const { draw, done } = this.prepare(target, options);
        draw();
        done();
    }

    /** Places all square/point copies in one draw, using the same copy index, wrap and overlap rules as WebGL2. */
    async drawInstances(target: GpuImage, options: InstanceOptions): Promise<void> {
        const wrap = options.points ? [false, false] : options.wrap ?? [false, false];
        const copies = Math.max(0, Math.floor(options.count)) * (wrap[0] ? 3 : 1) * (wrap[1] ? 3 : 1);
        if (!copies) { this.clear(target, options.clear); return; }

        const names = Object.keys(options.inputs ?? {});
        const handles = names.map((name) => this.inputHandle(options.inputs![name]));
        const blend = options.stack === 'max' || options.stack === 'add' ? options.stack : 'none';
        const pipeline = this.pipelineFor({ fragment: options.fragment, blend }, names, handles.map((handle) => handle.format), handleOf(target).format, options);
        const broken = await pipeline.broken;
        if (broken) throw new ShaderError(`On WebGPU: ${broken.split('\n').slice(0, 4).join('\n')}`);

        const values = {
            uSize: [target.width, target.height],
            uWrap: [wrap[0] ? 1 : 0, wrap[1] ? 1 : 0],
            ...(options.uniforms ?? {}),
        };
        const bytes = packUniforms(pipeline.uniforms, values);
        const buffer = this.device.createBuffer({ size: bytes.byteLength, usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST });
        let depth: WgpuTexture | null = null;
        try {
            this.device.queue.writeBuffer(buffer, 0, bytes);
            const entries: object[] = [{ binding: 0, resource: { buffer } }];
            pipeline.module.textures.forEach((name, index) => {
                const at = names.indexOf(name);
                const input = at >= 0 ? options.inputs![name] : null;
                const handle = at >= 0 ? handles[at] : this.inputHandle(null);
                entries.push({ binding: 1 + index * 2, resource: handle.view }, {
                    binding: 2 + index * 2,
                    resource: this.sampler(input, pipeline.sampleTypes[index] === 'float'),
                });
            });
            const group = this.device.createBindGroup({ layout: pipeline.layout, entries });
            const start = options.clear ?? [0, 0, 0, 0];
            const attachments: Record<string, unknown> = {
                colorAttachments: [{
                    view: handleOf(target).view, loadOp: 'clear', storeOp: 'store',
                    clearValue: { r: start[0], g: start[1], b: start[2], a: start[3] },
                }],
            };
            if (options.stack === 'higher') {
                depth = this.device.createTexture({
                    size: [target.width, target.height], format: 'depth24plus', usage: TEXTURE_USAGE.RENDER_ATTACHMENT,
                });
                attachments.depthStencilAttachment = {
                    view: depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 1,
                };
            }
            const encoder = this.device.createCommandEncoder();
            const pass = encoder.beginRenderPass(attachments);
            pass.setPipeline(pipeline.pipeline);
            pass.setBindGroup(0, group);
            pass.draw(options.points ? 1 : 6, copies);
            pass.end();
            this.device.queue.submit([encoder.finish()]);
            this.budget.spend(copies * 256 + target.width * target.height);
            await this.budget.pace();
        } finally {
            buffer.destroy();
            depth?.destroy();
        }
    }

    clear(target: GpuImage, value: [number, number, number, number] = [0, 0, 0, 0]): void {
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: handleOf(target).view, loadOp: 'clear', storeOp: 'store', clearValue: { r: value[0], g: value[1], b: value[2], a: value[3] } }] });
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    copy(from: PassInput, to: GpuImage): void {
        this.passNow(to, { fragment: 'void main() { outColor = texture(source, vUv); }', inputs: { source: from } });
    }

    // ---- reading back ----

    /** A texture's rows copied into a buffer and read once the device is done. */
    private async readTexture(image: GpuImage, bytesPerPixel: number): Promise<{ data: ArrayBuffer; row: number }> {
        const row = paddedRow(image.width, bytesPerPixel);
        const buffer = this.device.createBuffer({ size: row * image.height, usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST });
        const encoder = this.device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: handleOf(image).texture }, { buffer, bytesPerRow: row, rowsPerImage: image.height }, [image.width, image.height]);
        this.device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(MAP_READ);
        const data = buffer.getMappedRange().slice(0);
        buffer.unmap();
        buffer.destroy();
        return { data, row };
    }

    async readRgba8Later(image: GpuImage): Promise<Uint8Array | null> {
        const plain = handleOf(image).format === 'rgba8unorm';
        const source = plain ? image : this.image(image.width, image.height, 'color', 8);
        if (!plain) this.passNow(source, { fragment: 'uniform int uGray;\nvoid main() { vec4 c = texture(image, vUv); outColor = uGray == 1 ? vec4(c.rrr, 1.0) : c; }', inputs: { image }, uniforms: { uGray: image.kind === 'gray' ? 1 : 0 } });
        try {
            const { data, row } = await this.readTexture(source, 4);
            const out = new Uint8Array(image.width * image.height * 4);
            const bytes = new Uint8Array(data);
            for (let y = 0; y < image.height; y++) out.set(bytes.subarray(y * row, y * row + image.width * 4), y * image.width * 4);
            return out;
        } catch {
            return null;
        } finally {
            if (!plain) this.release(source);
        }
    }

    async readPixelLater(source: GpuImage, x: number, y: number): Promise<Float32Array | null> {
        const probe = this.image(1, 1, 'color', 32);
        this.passNow(probe, {
            fragment: 'uniform vec2 uAt;\nvoid main() { outColor = texelFetch(source, ivec2(uAt), 0); }',
            inputs: { source },
            uniforms: { uAt: [Math.max(0, Math.min(source.width - 1, Math.floor(x))), Math.max(0, Math.min(source.height - 1, Math.floor(y)))] },
        });
        try {
            const { data } = await this.readTexture(probe, 16);
            return new Float32Array(data.slice(0, 16));
        } catch {
            return null;
        } finally {
            this.release(probe);
        }
    }

    /** The source drawn at `width` x `height` into a full-float image and read back (bottom row first). */
    private async readScaled(source: PassInput, width: number, height: number, gray: boolean): Promise<Float32Array> {
        const scaled = this.image(width, height, 'color', 32);
        this.passNow(scaled, { fragment: `void main() { vec4 c = texture(source, vUv); outColor = ${gray ? 'vec4(c.rrr, 1.0)' : 'c'}; }`, inputs: { source } });
        try {
            const { data, row } = await this.readTexture(scaled, 16);
            const out = new Float32Array(width * height * 4);
            const floats = new Float32Array(data);
            for (let y = 0; y < height; y++) out.set(floats.subarray((y * row) / 4, (y * row) / 4 + width * 4), y * width * 4);
            return out;
        } finally {
            this.release(scaled);
        }
    }

    async readUint16Async(source: PassInput, width: number, height: number, encode: 'color' | 'gray', flipRows = true): Promise<Uint16Array> {
        const channels = encode === 'gray' ? 1 : 4;
        const gray = encode === 'gray' || (isImage(source) && source.kind === 'gray');
        const pixels = await this.readScaled(source, width, height, gray);
        const out = new Uint16Array(width * height * channels);
        for (let y = 0; y < height; y++) {
            const row = flipRows ? height - 1 - y : y;
            for (let x = 0; x < width; x++) {
                for (let c = 0; c < channels; c++) out[(row * width + x) * channels + c] = Math.round(Math.min(1, Math.max(0, pixels[(y * width + x) * 4 + c])) * 65535);
            }
        }
        return out;
    }

    async toPng(source: PassInput, width: number, height: number, encode: 'color' | 'gray' | 'raw' = 'raw', flipRows = true): Promise<Blob> {
        const gray = encode === 'gray' || (isImage(source) && source.kind === 'gray');
        const pixels = await this.readScaled(source, width, height, gray);
        const rgba = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
            const row = flipRows ? height - 1 - y : y;
            for (let x = 0; x < width * 4; x++) rgba[row * width * 4 + x] = Math.round(Math.min(1, Math.max(0, pixels[y * width * 4 + x])) * 255);
        }
        if (encode !== 'gray') return encodePng(rgba, width, height);
        const grey = new Uint8Array(width * height);
        for (let i = 0; i < grey.length; i++) grey[i] = rgba[i * 4];
        return encodePng(grey, width, height, 1);
    }
}

const made = new WeakMap<object, WebGpuTexturing>();

/** The texturing GPU on a WebGPU device (one for each device). */
export const webgpuTexturing = (device: WgpuDevice): WebGpuTexturing => {
    let gpu = made.get(device);
    if (!gpu) made.set(device, gpu = new WebGpuTexturing(device));
    return gpu;
};
