import * as THREE from 'three';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { encodePng } from '../png';
import { GLSL_LIBRARY } from './glslLibrary';

/**
 * THE TEXTURING GPU
 *
 * One WebGL2 context shared by everything that makes texture pixels: the texture graph, mesh map
 * baking and painting. Keeping them on one context lets a node's result, a baked map and a paint
 * layer be the very texture a 3D view draws with, with nothing copied back to the CPU.
 *
 * Images are render targets from a pool, sized and typed as asked:
 *   - colour: RGBA, 8 bits a channel by default (values as shown, like a picture) or 16-bit float;
 *   - grey: one channel, 16-bit float by default (heights and masks need the steps).
 * A pass draws one fragment shader over a target. Heavy passes are cut into bands so a frame never
 * holds the GPU long enough for the browser to give up on it; `budget` decides where to wait a frame.
 *
 * Views (a 2D image, a 3D preview) draw into this context's own canvas and are copied onto the
 * view's canvas straight away, so any number of views share the one context.
 */

export type ImageKind = 'color' | 'gray';
export type ImagePrecision = 8 | 16 | 32;

export interface GpuImage {
    readonly target: THREE.WebGLRenderTarget;
    readonly kind: ImageKind;
    readonly precision: ImagePrecision;
    readonly width: number;
    readonly height: number;
    /** Holders; at 0 the target goes back to the pool. */
    refs: number;
}

/** A texture a pass reads: an image, or any texture of this context (a baked map, a 1×1 default). */
export type PassInput = GpuImage | THREE.Texture;

export interface PassOptions {
    /** The body of the fragment shader: functions and a `void main()` writing `outColor`. */
    fragment: string;
    inputs?: Record<string, PassInput | null | undefined>;
    uniforms?: Record<string, unknown>;
    /** Samples each pixel reads, for cutting heavy passes into bands (1 for a plain pass). */
    cost?: number;
    /** Blending the pass's output over what the target holds, else replaced. */
    blend?: 'add' | 'max' | 'alpha' | 'none';
    /** Only this rectangle of the target (pixels, from the bottom left). */
    scissor?: { x: number; y: number; width: number; height: number };
}

/** Pixel samples drawn before the work waits for the next frame. */
const FRAME_SAMPLE_BUDGET = 96_000_000;
/** Bytes of idle pooled targets kept for reuse. */
const POOL_IDLE_BYTES = 512 * 1024 * 1024;

const VERTEX = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const bytesPerPixel = (kind: ImageKind, precision: ImagePrecision): number => (kind === 'color' ? 4 : 1) * (precision / 8);

const poolKey = (width: number, height: number, kind: ImageKind, precision: ImagePrecision): string => `${width}x${height}:${kind}:${precision}`;

const isImage = (value: PassInput): value is GpuImage => (value as GpuImage).target !== undefined;

/**
 * The next frame; while the window is hidden (no frames, and timers held back to one a second) the
 * next turn of the event loop, through a message, which nothing holds back.
 */
const nextTurn = (): Promise<void> => new Promise<void>((resolve) => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && typeof MessageChannel !== 'undefined') {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
        channel.port2.postMessage(0);
        return;
    }
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish);
    setTimeout(finish, 34);
});

/** Pending work, so callers can step it frame by frame. */
export class FrameBudget {
    private spent = 0;
    private frameStart = 0;

    constructor(private readonly samples = FRAME_SAMPLE_BUDGET) {}

    /** Records work; true once the frame's share is spent. */
    spend(samples: number): boolean {
        this.spent += samples;
        return this.spent >= this.samples;
    }

    /** Waits for the next frame when this one is spent (or has taken long on the CPU). */
    async pace(): Promise<void> {
        const now = performance.now();
        if (!this.frameStart) this.frameStart = now;
        if (this.spent < this.samples && now - this.frameStart < 12) return;
        await nextTurn();
        this.spent = 0;
        this.frameStart = performance.now();
    }
}

export class TextureGpu {
    readonly renderer: THREE.WebGLRenderer;
    readonly canvas: HTMLCanvasElement;
    /** Grows with every context restore: what was made before it is gone. */
    generation = 0;
    readonly budget = new FrameBudget();

    private readonly idle = new Map<string, THREE.WebGLRenderTarget[]>();
    private idleBytes = 0;
    private readonly programs = new Map<string, THREE.RawShaderMaterial>();
    private readonly quad: THREE.Mesh;
    private readonly quadScene = new THREE.Scene();
    private readonly quadCamera = new THREE.Camera();
    private readonly defaults = new Map<string, THREE.DataTexture>();
    private readonly lostListeners = new Set<() => void>();
    private liveBytes = 0;
    /** The last shader that failed to compile, as the driver explained it. */
    private shaderError: string | null = null;

    constructor() {
        this.canvas = document.createElement('canvas');
        this.canvas.width = 16;
        this.canvas.height = 16;
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, alpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
        this.renderer.autoClear = false;
        this.renderer.debug.onShaderError = (gl, _program, vertex, fragment) => {
            const log = (gl.getShaderInfoLog(fragment) || gl.getShaderInfoLog(vertex) || 'The shader did not compile.').trim();
            this.shaderError = log.split('\n').slice(0, 6).join('\n');
        };
        // Only lit 3D views use these; image passes are raw shaders that write values as they are.
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        const gl = this.renderer.getContext();
        if (!gl.getExtension('EXT_color_buffer_float')) frontendDiagnostics.failure('texturing_float_targets_missing', new Error('EXT_color_buffer_float is not available'));
        gl.getExtension('OES_texture_float_linear');
        const geometry = new THREE.BufferGeometry();
        // One triangle over the whole target: no seam down the middle.
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
        this.quad = new THREE.Mesh(geometry);
        this.quad.frustumCulled = false;
        this.quadScene.add(this.quad);
        this.canvas.addEventListener('webglcontextlost', (event) => {
            event.preventDefault();
            frontendDiagnostics.failure('texturing_context_lost', new Error('The texturing GPU context was lost'));
        });
        this.canvas.addEventListener('webglcontextrestored', () => {
            this.generation++;
            this.idle.clear();
            this.idleBytes = 0;
            this.liveBytes = 0;
            for (const listener of this.lostListeners) listener();
        });
    }

    /** Called when the context comes back from being lost: everything made on it must be made again. */
    onRestored(listener: () => void): () => void {
        this.lostListeners.add(listener);
        return () => this.lostListeners.delete(listener);
    }

    get maxSize(): number {
        return this.renderer.capabilities.maxTextureSize;
    }

    /** GPU bytes held by images in use and idle in the pool. */
    get memory(): { live: number; idle: number } {
        return { live: this.liveBytes, idle: this.idleBytes };
    }

    // -----------------------------------------------------------------------
    // Images
    // -----------------------------------------------------------------------

    image(width: number, height: number, kind: ImageKind, precision: ImagePrecision = kind === 'color' ? 8 : 16): GpuImage {
        width = Math.max(1, Math.min(this.maxSize, Math.round(width)));
        height = Math.max(1, Math.min(this.maxSize, Math.round(height)));
        const key = poolKey(width, height, kind, precision);
        const list = this.idle.get(key);
        let target = list?.pop();
        const bytes = width * height * bytesPerPixel(kind, precision);
        if (target) {
            this.idleBytes -= bytes;
        } else {
            target = new THREE.WebGLRenderTarget(width, height, {
                type: precision === 8 ? THREE.UnsignedByteType : precision === 16 ? THREE.HalfFloatType : THREE.FloatType,
                format: kind === 'color' ? THREE.RGBAFormat : THREE.RedFormat,
                minFilter: THREE.LinearFilter,
                magFilter: THREE.LinearFilter,
                wrapS: THREE.RepeatWrapping,
                wrapT: THREE.RepeatWrapping,
                depthBuffer: false,
                stencilBuffer: false,
                generateMipmaps: false,
                colorSpace: THREE.NoColorSpace,
            });
            target.texture.name = `texturing:${key}`;
        }
        this.liveBytes += bytes;
        return { target, kind, precision, width, height, refs: 1 };
    }

    retain(image: GpuImage): GpuImage {
        image.refs++;
        return image;
    }

    release(image: GpuImage | null | undefined): void {
        if (!image || image.refs <= 0) return;
        image.refs--;
        if (image.refs > 0) return;
        const bytes = image.width * image.height * bytesPerPixel(image.kind, image.precision);
        this.liveBytes -= bytes;
        const key = poolKey(image.width, image.height, image.kind, image.precision);
        let list = this.idle.get(key);
        if (!list) this.idle.set(key, list = []);
        list.push(image.target);
        this.idleBytes += bytes;
        this.trimPool();
    }

    /** Frees idle targets past the pool's limit, largest first. */
    trimPool(limit = POOL_IDLE_BYTES): void {
        if (this.idleBytes <= limit) return;
        const keys = [...this.idle.keys()].sort((a, b) => sizeOfKey(b) - sizeOfKey(a));
        for (const key of keys) {
            const list = this.idle.get(key)!;
            while (list.length && this.idleBytes > limit) {
                const target = list.pop()!;
                this.idleBytes -= sizeOfKey(key);
                target.dispose();
            }
            if (!list.length) this.idle.delete(key);
            if (this.idleBytes <= limit) return;
        }
    }

    /** A 1×1 texture of one value, for inputs nothing is wired to. */
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

    // -----------------------------------------------------------------------
    // Passes
    // -----------------------------------------------------------------------

    private program(fragment: string, inputNames: readonly string[], blend: PassOptions['blend']): THREE.RawShaderMaterial {
        const key = `${blend ?? 'none'}\n${inputNames.join(',')}\n${fragment}`;
        let material = this.programs.get(key);
        if (material) return material;
        // Samplers a shader declares itself are left as it wrote them.
        const declarations = inputNames
            .filter((name) => !new RegExp(`uniform\\s+(?:\\w+\\s+)?sampler2D\\s+${name}\\b`).test(fragment))
            .map((name) => `uniform highp sampler2D ${name};`)
            .join('\n');
        material = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: `precision highp float;\n${VERTEX}`,
            fragmentShader: `precision highp float;\nprecision highp int;\nin vec2 vUv;\nout vec4 outColor;\nuniform vec2 uSize;\n${declarations}\n${GLSL_LIBRARY}\n${fragment}`,
            uniforms: {},
            depthTest: false,
            depthWrite: false,
        });
        if (blend === 'add') {
            material.blending = THREE.CustomBlending;
            material.blendEquation = THREE.AddEquation;
            material.blendSrc = THREE.OneFactor;
            material.blendDst = THREE.OneFactor;
        } else if (blend === 'max') {
            material.blending = THREE.CustomBlending;
            material.blendEquation = THREE.MaxEquation;
            material.blendSrc = THREE.OneFactor;
            material.blendDst = THREE.OneFactor;
        } else if (blend === 'alpha') {
            material.blending = THREE.CustomBlending;
            material.blendEquation = THREE.AddEquation;
            material.blendSrc = THREE.OneFactor;
            material.blendDst = THREE.OneMinusSrcAlphaFactor;
        } else {
            material.blending = THREE.NoBlending;
        }
        this.programs.set(key, material);
        if (this.programs.size > 600) {
            // A graph being edited makes new programs as its shape changes; the oldest go first.
            const oldest = this.programs.keys().next().value as string;
            this.programs.get(oldest)?.dispose();
            this.programs.delete(oldest);
        }
        return material;
    }

    /** A function that draws the pass with its own uniforms, however many passes run between its calls. */
    private prepare(options: PassOptions, width: number, height: number): () => void {
        const names = Object.keys(options.inputs ?? {});
        const material = this.program(options.fragment, names, options.blend);
        const uniforms: Record<string, THREE.IUniform> = { uSize: { value: new THREE.Vector2(width, height) } };
        for (const name of names) {
            const input = options.inputs![name];
            uniforms[name] = { value: input ? (isImage(input) ? input.target.texture : input) : this.constant('black') };
        }
        for (const [name, value] of Object.entries(options.uniforms ?? {})) uniforms[name] = { value };
        return () => {
            // three keeps the uniforms object a program was first drawn with: change its values, never the object.
            const kept = material.uniforms;
            for (const [name, uniform] of Object.entries(uniforms)) {
                if (kept[name]) kept[name].value = uniform.value;
                else kept[name] = { value: uniform.value };
            }
            material.uniformsNeedUpdate = true;
            this.quad.material = material;
            this.shaderError = null;
            this.renderer.render(this.quadScene, this.quadCamera);
            if (this.shaderError) {
                const message = this.shaderError;
                this.shaderError = null;
                // The program stays broken: forget it so a corrected one is compiled afresh.
                for (const [key, cached] of this.programs) if (cached === material) this.programs.delete(key);
                material.dispose();
                throw new ShaderError(message);
            }
        };
    }

    /** Draws `options.fragment` over `target`. Heavy passes are drawn in bands across frames. */
    async pass(target: GpuImage | THREE.WebGLRenderTarget, options: PassOptions): Promise<void> {
        const renderTarget = isImage(target as PassInput) ? (target as GpuImage).target : target as THREE.WebGLRenderTarget;
        const width = renderTarget.width;
        const height = renderTarget.height;
        const draw = this.prepare(options, width, height);
        const area = options.scissor ?? { x: 0, y: 0, width, height };
        const samples = area.width * area.height * Math.max(1, options.cost ?? 1);
        const bands = Math.max(1, Math.min(area.height, Math.ceil(samples / (FRAME_SAMPLE_BUDGET / 2))));
        const renderer = this.renderer;
        for (let band = 0; band < bands; band++) {
            const y0 = area.y + Math.floor((area.height * band) / bands);
            const y1 = area.y + Math.floor((area.height * (band + 1)) / bands);
            const previous = renderer.getRenderTarget();
            renderer.setRenderTarget(renderTarget);
            renderTarget.scissor.set(area.x, y0, area.width, y1 - y0);
            renderTarget.scissorTest = true;
            renderTarget.viewport.set(0, 0, width, height);
            renderer.setRenderTarget(renderTarget);
            draw();
            renderTarget.scissorTest = false;
            renderer.setRenderTarget(previous);
            this.budget.spend((samples * (y1 - y0)) / area.height);
            await this.budget.pace();
        }
    }

    /** Draws a pass straight away, in one go: for small targets (thumbnails, brush dabs). */
    passNow(target: GpuImage | THREE.WebGLRenderTarget, options: PassOptions): void {
        const renderTarget = isImage(target as PassInput) ? (target as GpuImage).target : target as THREE.WebGLRenderTarget;
        const draw = this.prepare(options, renderTarget.width, renderTarget.height);
        const previous = this.renderer.getRenderTarget();
        if (options.scissor) {
            renderTarget.scissor.set(options.scissor.x, options.scissor.y, options.scissor.width, options.scissor.height);
            renderTarget.scissorTest = true;
        }
        renderTarget.viewport.set(0, 0, renderTarget.width, renderTarget.height);
        this.renderer.setRenderTarget(renderTarget);
        draw();
        renderTarget.scissorTest = false;
        this.renderer.setRenderTarget(previous);
    }

    /** Fills a target with one value. */
    clear(target: GpuImage | THREE.WebGLRenderTarget, value: [number, number, number, number] = [0, 0, 0, 0]): void {
        const renderTarget = isImage(target as PassInput) ? (target as GpuImage).target : target as THREE.WebGLRenderTarget;
        // three multiplies a clear colour by its alpha: values that must survive see-through are written by a pass.
        if (value[3] < 1 && (value[0] !== 0 || value[1] !== 0 || value[2] !== 0)) {
            this.passNow(renderTarget, { fragment: 'uniform vec4 uValue;\nvoid main() { outColor = uValue; }', uniforms: { uValue: new THREE.Vector4(...value) } });
            return;
        }
        const renderer = this.renderer;
        const previous = renderer.getRenderTarget();
        const color = renderer.getClearColor(new THREE.Color());
        const alpha = renderer.getClearAlpha();
        renderer.setRenderTarget(renderTarget);
        renderer.setClearColor(new THREE.Color(value[0], value[1], value[2]), value[3]);
        renderer.clear(true, false, false);
        renderer.setClearColor(color, alpha);
        renderer.setRenderTarget(previous);
    }

    /** Copies one image into another of the same size and kind. */
    copy(from: PassInput, to: GpuImage | THREE.WebGLRenderTarget): void {
        this.passNow(to, { fragment: 'void main() { outColor = texture(source, vUv); }', inputs: { source: from } });
    }

    // -----------------------------------------------------------------------
    // Reading back and showing
    // -----------------------------------------------------------------------

    /** The image as 8-bit RGBA rows, top row first (as a picture is stored). `encode` turns the value into a colour. */
    readRgba8(source: PassInput, width: number, height: number, encode: 'color' | 'gray' | 'raw' = 'raw', flipRows = true): Uint8ClampedArray {
        const out = this.image(width, height, 'color', 8);
        const kind = isImage(source) ? source.kind : 'color';
        const fragment = encode === 'gray' || kind === 'gray'
            ? 'void main() { float g = texture(source, vUv).r; outColor = vec4(g, g, g, 1.0); }'
            : 'void main() { outColor = texture(source, vUv); }';
        this.passNow(out, { fragment, inputs: { source } });
        const pixels = new Uint8ClampedArray(width * height * 4);
        this.renderer.readRenderTargetPixels(out.target, 0, 0, width, height, pixels);
        this.release(out);
        if (!flipRows) return pixels;
        const row = width * 4;
        const flipped = new Uint8ClampedArray(pixels.length);
        for (let y = 0; y < height; y++) flipped.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
        return flipped;
    }

    /** Reads a float image's first `channels` values per pixel, bottom row first. */
    readFloat(source: GpuImage): Float32Array {
        const temp = this.image(source.width, source.height, 'color', 32);
        this.passNow(temp, { fragment: 'void main() { outColor = texture(source, vUv); }', inputs: { source } });
        const pixels = new Float32Array(source.width * source.height * 4);
        this.renderer.readRenderTargetPixels(temp.target, 0, 0, source.width, source.height, pixels);
        this.release(temp);
        return pixels;
    }

    /** Uploads pixels (bottom row first) into an image. */
    write(target: GpuImage, data: Float32Array | Uint8Array, region?: { x: number; y: number; width: number; height: number }): void {
        const area = region ?? { x: 0, y: 0, width: target.width, height: target.height };
        const float = data instanceof Float32Array;
        const channels = data.length / (area.width * area.height);
        const format = channels === 1 ? THREE.RedFormat : channels === 2 ? THREE.RGFormat : THREE.RGBAFormat;
        const texture = new THREE.DataTexture(data, area.width, area.height, format, float ? THREE.FloatType : THREE.UnsignedByteType);
        texture.minFilter = texture.magFilter = THREE.NearestFilter;
        texture.needsUpdate = true;
        const scale = new THREE.Vector4(area.width / target.width, area.height / target.height, area.x / target.width, area.y / target.height);
        this.passNow(target, {
            fragment: `uniform vec4 uArea;
void main() {
    vec2 local = (vUv - uArea.zw) / uArea.xy;
    vec4 value = texture(source, local);
    outColor = ${channels === 1 ? 'vec4(value.r, value.r, value.r, 1.0)' : channels === 2 ? 'vec4(value.rg, 0.0, 1.0)' : 'value'};
}`,
            inputs: { source: texture },
            uniforms: { uArea: scale },
            scissor: area,
        });
        texture.dispose();
    }

    /** Sizes this context's canvas to hold a view of `width` × `height`. */
    ensureCanvas(width: number, height: number): void {
        const pixelWidth = Math.max(this.canvas.width, Math.ceil(width));
        const pixelHeight = Math.max(this.canvas.height, Math.ceil(height));
        if (pixelWidth !== this.canvas.width || pixelHeight !== this.canvas.height) this.renderer.setSize(pixelWidth, pixelHeight, false);
    }

    /**
     * Draws a scene into the top-left corner of this context's canvas and copies it onto `view`.
     * Must run in one go: the drawing buffer is not kept past the task.
     */
    present(view: HTMLCanvasElement, draw: (width: number, height: number) => void): void {
        const width = view.width;
        const height = view.height;
        if (!width || !height) return;
        this.ensureCanvas(width, height);
        const renderer = this.renderer;
        renderer.setRenderTarget(null);
        const canvasHeight = this.canvas.height;
        renderer.setViewport(0, 0, this.canvas.width, canvasHeight);
        renderer.setScissorTest(false);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, false);
        // The view sits at the top left, where a 2D canvas starts.
        renderer.setViewport(0, canvasHeight - height, width, height);
        renderer.setScissor(0, canvasHeight - height, width, height);
        renderer.setScissorTest(true);
        draw(width, height);
        renderer.setScissorTest(false);
        const context = view.getContext('2d');
        if (!context) return;
        context.clearRect(0, 0, width, height);
        context.drawImage(this.canvas, 0, 0, width, height, 0, 0, width, height);
    }

    /** Draws a quad pass straight to the current viewport (for 2D views). */
    drawToScreen(options: PassOptions): void {
        const size = this.renderer.getCurrentViewport(new THREE.Vector4());
        this.prepare(options, size.z, size.w)();
    }

    /** A PNG of the image (top row first), 8 bits a channel. */
    async toPng(source: PassInput, width: number, height: number, encode: 'color' | 'gray' | 'raw' = 'raw', flipRows = true): Promise<Blob> {
        // Written byte for byte: a canvas would multiply colour by alpha and lose it where alpha is low.
        const pixels = this.readRgba8(source, width, height, encode, flipRows);
        if (encode !== 'gray') return encodePng(pixels, width, height);
        // Grey maps keep one value per pixel: a third or so of the file.
        const grey = new Uint8Array(width * height);
        for (let i = 0; i < grey.length; i++) grey[i] = pixels[i * 4];
        return encodePng(grey, width, height, 1);
    }
}

/** A pass whose shader did not compile. */
export class ShaderError extends Error {}

const sizeOfKey = (key: string): number => {
    const [size, kind, precision] = key.split(':');
    const [width, height] = size.split('x').map(Number);
    return width * height * bytesPerPixel(kind as ImageKind, Number(precision) as ImagePrecision);
};

let shared: TextureGpu | null = null;

/** The editor's one texturing context, made when first needed. */
export const textureGpu = (): TextureGpu => {
    if (!shared) shared = new TextureGpu();
    return shared;
};
