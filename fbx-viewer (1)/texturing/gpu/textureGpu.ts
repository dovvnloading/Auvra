import * as THREE from 'three';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { encodePng } from '../png';
import { GLSL_LIBRARY } from './glslLibrary';
import type { TexturingGpu } from './texturingGpu';

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

/** How copies drawn by drawInstances combine where they overlap. */
export type StackMode = 'higher' | 'max' | 'add' | 'over';

/** Copies drawn in one instanced pass (a scatter's): each copy a square (or a single pixel), placed by the vertex body. */
export interface InstanceOptions {
    /** How many copies. */
    count: number;
    /** What the vertex body hands the fragment, as 'vec2 vLocal' or 'flat int vCopy'. */
    varyings: readonly string[];
    /**
     * The vertex body: `void placeCopy(int copy, vec2 corner, vec2 shift)` setting gl_Position and the
     * varyings. `corner` runs from -1 to 1 over a copy's square; `shift` is the whole-image shift of a
     * wrapped repeat of it (0 when the image does not repeat that way).
     */
    vertex: string;
    /** The fragment body: a `void main()` writing outColor, and gl_FragDepth (0 nearest) when the higher wins. */
    fragment: string;
    inputs?: Record<string, PassInput | null | undefined>;
    uniforms?: Record<string, unknown>;
    /**
     * Where copies overlap: 'higher' keeps the one whose fragment wrote the smaller depth (the taller), 'max'
     * the largest value of each channel, 'add' adds them up, 'over' keeps the last drawn.
     */
    stack: StackMode;
    /** The axes (x, y) along which the image repeats: each copy is drawn again a whole image away, so copies over an edge come round. */
    wrap?: [boolean, boolean];
    /** One pixel a copy instead of a square. */
    points?: boolean;
    /** What the target holds before the copies are drawn (0 unless said). */
    clear?: [number, number, number, number];
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
    /**
     * The pass in WGSL where it has its own (a function graph's, from its WGSL writer): WebGPU draws this in place
     * of the GLSL's `fn_result` and main. WebGL2 ignores it.
     */
    wgsl?: { functions: string; result: string };
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

export class TextureGpu implements TexturingGpu {
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
    private readonly instancePrograms = new Map<string, THREE.RawShaderMaterial>();
    private readonly instanceScene = new THREE.Scene();
    private instanceMesh: THREE.Mesh | null = null;
    private instancePoints: THREE.Points | null = null;
    /** Targets with a depth buffer, for copies where the higher wins (by size and kind). */
    private readonly depthTargets = new Map<string, THREE.WebGLRenderTarget>();
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
        // Copies kept largest or added up in full-float images (scatters, flood fill boxes) blend in full float.
        gl.getExtension('EXT_float_blend');
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

    // -----------------------------------------------------------------------
    // Instanced copies
    // -----------------------------------------------------------------------

    private instanceProgram(options: InstanceOptions, inputNames: readonly string[]): THREE.RawShaderMaterial {
        const key = `${options.stack}|${options.points ? 'points' : 'squares'}|${inputNames.join(',')}|${options.varyings.join(';')}\n${options.vertex}\n${options.fragment}`;
        let material = this.instancePrograms.get(key);
        if (material) return material;
        const samplers = inputNames.map((name) => `uniform highp sampler2D ${name};`).join('\n');
        const varying = (direction: 'in' | 'out') => options.varyings
            .map((entry) => (entry.startsWith('flat ') ? `flat ${direction} ${entry.slice(5)};` : `${direction} ${entry};`))
            .join('\n');
        material = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: `precision highp float;
precision highp int;
in vec3 position;
uniform vec2 uSize;
uniform ivec2 uWrap;
${samplers}
${varying('out')}
${GLSL_LIBRARY}
${options.vertex}
void main() {
    int across = uWrap.x == 1 ? 3 : 1;
    int wraps = across * (uWrap.y == 1 ? 3 : 1);
    int copy = gl_InstanceID / wraps;
    int w = gl_InstanceID - copy * wraps;
    vec2 shift = vec2(uWrap.x == 1 ? float(w % across) - 1.0 : 0.0, uWrap.y == 1 ? float(w / across) - 1.0 : 0.0);
    gl_PointSize = 1.0;
    placeCopy(copy, position.xy, shift);
}`,
            fragmentShader: `precision highp float;\nprecision highp int;\nout vec4 outColor;\nuniform vec2 uSize;\n${samplers}\n${varying('in')}\n${GLSL_LIBRARY}\n${options.fragment}`,
            uniforms: {},
            depthTest: options.stack === 'higher',
            depthWrite: options.stack === 'higher',
            depthFunc: THREE.LessDepth,
        });
        if (options.stack === 'max' || options.stack === 'add') {
            material.blending = THREE.CustomBlending;
            material.blendEquation = options.stack === 'max' ? THREE.MaxEquation : THREE.AddEquation;
            material.blendSrc = THREE.OneFactor;
            material.blendDst = THREE.OneFactor;
        } else {
            material.blending = THREE.NoBlending;
        }
        this.instancePrograms.set(key, material);
        if (this.instancePrograms.size > 120) {
            const oldest = this.instancePrograms.keys().next().value as string;
            this.instancePrograms.get(oldest)?.dispose();
            this.instancePrograms.delete(oldest);
        }
        return material;
    }

    private instanceObject(points: boolean): THREE.Mesh | THREE.Points {
        if (points) {
            if (!this.instancePoints) {
                const geometry = new THREE.InstancedBufferGeometry();
                geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3));
                this.instancePoints = new THREE.Points(geometry);
                this.instancePoints.frustumCulled = false;
            }
            return this.instancePoints;
        }
        if (!this.instanceMesh) {
            const geometry = new THREE.InstancedBufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
            geometry.setIndex([0, 1, 2, 0, 2, 3]);
            this.instanceMesh = new THREE.Mesh(geometry);
            this.instanceMesh.frustumCulled = false;
        }
        return this.instanceMesh;
    }

    /** A target with a depth buffer of an image's size and kind, kept for the next copies drawn so. */
    private depthTarget(image: GpuImage): THREE.WebGLRenderTarget {
        const key = poolKey(image.width, image.height, image.kind, image.precision);
        let target = this.depthTargets.get(key);
        if (target) return target;
        for (const [other, kept] of this.depthTargets) if (this.depthTargets.size >= 2) { kept.dispose(); this.depthTargets.delete(other); }
        target = new THREE.WebGLRenderTarget(image.width, image.height, {
            type: image.precision === 8 ? THREE.UnsignedByteType : image.precision === 16 ? THREE.HalfFloatType : THREE.FloatType,
            format: image.kind === 'color' ? THREE.RGBAFormat : THREE.RedFormat,
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            depthBuffer: true,
            stencilBuffer: false,
            generateMipmaps: false,
            colorSpace: THREE.NoColorSpace,
        });
        this.depthTargets.set(key, target);
        return target;
    }

    /**
     * Draws `count` copies over `target` in one instanced pass, combined as `stack` says: the cost follows
     * the number of copies, not the image's size times a search round each pixel.
     */
    async drawInstances(target: GpuImage, options: InstanceOptions): Promise<void> {
        const names = Object.keys(options.inputs ?? {});
        const material = this.instanceProgram(options, names);
        const wrap = options.points ? [false, false] : options.wrap ?? [false, false];
        const uniforms: Record<string, unknown> = { uSize: new THREE.Vector2(target.width, target.height), uWrap: [wrap[0] ? 1 : 0, wrap[1] ? 1 : 0] };
        for (const name of names) {
            const input = options.inputs![name];
            uniforms[name] = input ? (isImage(input) ? input.target.texture : input) : this.constant('black');
        }
        Object.assign(uniforms, options.uniforms ?? {});
        const kept = material.uniforms;
        for (const [name, value] of Object.entries(uniforms)) {
            if (kept[name]) kept[name].value = value;
            else kept[name] = { value };
        }
        material.uniformsNeedUpdate = true;
        const object = this.instanceObject(Boolean(options.points));
        object.material = material;
        const copies = Math.max(0, Math.floor(options.count)) * (wrap[0] ? 3 : 1) * (wrap[1] ? 3 : 1);
        (object.geometry as THREE.InstancedBufferGeometry).instanceCount = copies;
        this.instanceScene.clear();
        this.instanceScene.add(object);
        const destination = options.stack === 'higher' ? this.depthTarget(target) : target.target;
        const renderer = this.renderer;
        const previous = renderer.getRenderTarget();
        // The start value by clear (a pass where three's clear would spoil it), and the depth emptied.
        this.clear(destination, options.clear ?? [0, 0, 0, 0]);
        destination.viewport.set(0, 0, target.width, target.height);
        renderer.setRenderTarget(destination);
        if (options.stack === 'higher') renderer.clear(false, true, false);
        this.shaderError = null;
        if (copies > 0) renderer.render(this.instanceScene, this.quadCamera);
        renderer.setRenderTarget(previous);
        if (this.shaderError) {
            const message = this.shaderError;
            this.shaderError = null;
            for (const [key, cached] of this.instancePrograms) if (cached === material) this.instancePrograms.delete(key);
            material.dispose();
            throw new ShaderError(message);
        }
        // The higher-wins copies were drawn where a depth buffer could sort them: into the image now.
        if (options.stack === 'higher') this.passNow(target, { fragment: 'void main() { outColor = texelFetch(source, ivec2(gl_FragCoord.xy), 0); }', inputs: { source: destination.texture } });
        this.budget.spend(copies * 256 + target.width * target.height);
        await this.budget.pace();
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

    /**
     * Reads the image's pixels as 8-bit RGBA (bottom row first) without holding up the GPU: the read is queued behind
     * its drawing and collected once a fence says it is done, so live edits keep flowing. The image may be
     * released (and reused) as soon as this returns. Resolves null if the context is lost meanwhile.
     */
    readRgba8Later(image: GpuImage): Promise<Uint8Array | null> {
        if (image.kind === 'color' && image.precision === 8) return this.readRgba8TargetLater(image);
        // RGBA/UNSIGNED_BYTE is portable for RGBA8 attachments. Float attachments require a
        // different read type, and a scalar picture must appear in all three colour channels.
        const rgba = this.image(image.width, image.height, 'color', 8);
        try {
            if (image.kind === 'gray') {
                this.passNow(rgba, {
                    fragment: 'void main() { float g = texture(source, vUv).r; outColor = vec4(g, g, g, 1.0); }',
                    inputs: { source: image },
                });
            } else {
                this.copy(image, rgba);
            }
            return this.readRgba8TargetLater(rgba);
        } finally {
            // The GPU read has already been queued into its own pixel pack buffer.
            this.release(rgba);
        }
    }

    private readRgba8TargetLater(image: GpuImage): Promise<Uint8Array | null> {
        const gl = this.renderer.getContext() as WebGL2RenderingContext;
        const { width, height } = image;
        const previous = this.renderer.getRenderTarget();
        this.renderer.setRenderTarget(image.target);
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, width * height * 4, gl.STREAM_READ);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        // three never binds a pack buffer itself: leave none bound for its own reads.
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        this.renderer.setRenderTarget(previous);
        const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        return new Promise((resolve) => {
            const finish = (pixels: Uint8Array | null) => {
                if (fence) gl.deleteSync(fence);
                gl.deleteBuffer(buffer);
                resolve(pixels);
            };
            let waited = 0;
            const poll = () => {
                if (gl.isContextLost() || !fence) { finish(null); return; }
                const status = gl.clientWaitSync(fence, 0, 0);
                if (status === gl.WAIT_FAILED || waited > 10000) { finish(null); return; }
                if (status === gl.TIMEOUT_EXPIRED) { waited += 4; setTimeout(poll, 4); return; }
                const pixels = new Uint8Array(width * height * 4);
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
                gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels);
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
                finish(pixels);
            };
            setTimeout(poll, 0);
        });
    }

    /**
     * One pixel of an image (x and y from the bottom left) as it is kept, four floats, read without holding
     * up the GPU: the value is copied out behind the image's drawing and collected once a fence says it is
     * done. Resolves null if the context is lost meanwhile.
     */
    readPixelLater(source: GpuImage, x: number, y: number, timeoutMs = 2000): Promise<Float32Array | null> {
        const probe = this.image(1, 1, 'color', 32);
        this.passNow(probe, {
            fragment: 'uniform vec2 uAt;\nvoid main() { outColor = texelFetch(source, ivec2(uAt), 0); }',
            inputs: { source },
            uniforms: { uAt: new THREE.Vector2(Math.max(0, Math.min(source.width - 1, Math.floor(x))), Math.max(0, Math.min(source.height - 1, Math.floor(y)))) },
        });
        const gl = this.renderer.getContext() as WebGL2RenderingContext;
        const previous = this.renderer.getRenderTarget();
        this.renderer.setRenderTarget(probe.target);
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, 16, gl.STREAM_READ);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        this.renderer.setRenderTarget(previous);
        // The read is queued before anything else can draw into the probe: it may go back to the pool now.
        this.release(probe);
        const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        return new Promise((resolve) => {
            const finish = (value: Float32Array | null) => {
                if (fence) gl.deleteSync(fence);
                gl.deleteBuffer(buffer);
                resolve(value);
            };
            let waited = 0;
            const poll = () => {
                if (gl.isContextLost() || !fence) { finish(null); return; }
                const status = gl.clientWaitSync(fence, 0, 0);
                if (status === gl.WAIT_FAILED || waited > timeoutMs) { finish(null); return; }
                if (status === gl.TIMEOUT_EXPIRED) { waited += 4; setTimeout(poll, 4); return; }
                const value = new Float32Array(4);
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
                gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, value);
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
                finish(value);
            };
            setTimeout(poll, 0);
        });
    }

    /**
     * Reads `source` scaled to `width` × `height` as 16-bit values (one per pixel for 'gray', four for
     * 'color'), top row first when `flipRows`. Read a strip at a time, so even an 8K picture needs little memory.
     */
    readUint16(source: PassInput, width: number, height: number, encode: 'color' | 'gray', flipRows = true): Uint16Array {
        const channels = encode === 'gray' ? 1 : 4;
        const out = new Uint16Array(width * height * channels);
        const stripRows = Math.max(1, Math.min(height, Math.floor((16 * 1024 * 1024) / (width * 16))));
        const strip = this.image(width, stripRows, 'color', 32);
        const pixels = new Float32Array(width * stripRows * 4);
        const gray = encode === 'gray' || (isImage(source) && source.kind === 'gray');
        try {
            for (let y0 = 0; y0 < height; y0 += stripRows) {
                const rows = Math.min(stripRows, height - y0);
                // Rows y0 on of the whole picture, drawn into the strip.
                this.passNow(strip, {
                    fragment: `uniform float uY0;\nuniform float uHeight;\nuniform float uStrip;\nvoid main() { vec4 c = texture(source, vec2(vUv.x, (uY0 + vUv.y * uStrip) / uHeight)); outColor = ${gray ? 'vec4(c.rrr, 1.0)' : 'c'}; }`,
                    inputs: { source },
                    uniforms: { uY0: y0, uHeight: height, uStrip: stripRows },
                });
                this.renderer.readRenderTargetPixels(strip.target, 0, 0, width, rows, pixels);
                for (let r = 0; r < rows; r++) {
                    const row = flipRows ? height - 1 - (y0 + r) : y0 + r;
                    for (let x = 0; x < width; x++) {
                        const from = (r * width + x) * 4;
                        const to = (row * width + x) * channels;
                        for (let c = 0; c < channels; c++) out[to + c] = Math.round(Math.min(1, Math.max(0, pixels[from + c])) * 65535);
                    }
                }
            }
        } finally {
            this.release(strip);
        }
        return out;
    }

    /** readUint16, for callers that work with any texturing GPU (WebGPU reads only asynchronously). */
    async readUint16Async(source: PassInput, width: number, height: number, encode: 'color' | 'gray', flipRows = true): Promise<Uint16Array> {
        return this.readUint16(source, width, height, encode, flipRows);
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
