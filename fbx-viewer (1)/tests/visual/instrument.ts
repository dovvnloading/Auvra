/// <reference types="@webgpu/types" />
/**
 * Loaded before the engine, so all of it sees this: time only moves when a scene steps, chance is seeded, and every
 * GPU allocation is counted. The same scene then draws the same picture however slow the machine is.
 */

const seenClock = performance.now.bind(performance);

/** The machine's own clock, for timing the engine from outside. */
export const realNow = (): number => seenClock();

let virtualMs = 1000;

export const virtualSeconds = (): number => virtualMs / 1000;

export const stepClock = (ms: number): void => {
  virtualMs += ms;
};

/** Sets the clock back to where the first scene starts, for a scene that must not depend on what ran before it. */
export const resetClock = (): void => {
  virtualMs = 1000;
};

performance.now = () => virtualMs;
Date.now = () => 1_700_000_000_000 + virtualMs;

let seed = 0x2f6e2b1;

export const seedChance = (value: number): void => {
  seed = value;
};

Math.random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
};

// --- The GPU's clock would make what is budgeted by it differ from run to run. ---

const proto = WebGL2RenderingContext.prototype;
const getExtension = proto.getExtension;
proto.getExtension = function (this: WebGL2RenderingContext, name: string) {
  return name === 'EXT_disjoint_timer_query_webgl2' ? null : getExtension.call(this, name as 'OCULUS_multiview');
} as typeof proto.getExtension;

// --- WebGPU: work the renderer waits on, which a frame then waits on too; and no GPU clock there either. ---

let waiting = 0;

/** Pipelines compiling, buffers being read back and workers' replies the WebGPU renderer has not had yet. */
export const webGpuWaiting = (): number => waiting;

const tracked = <T>(promise: Promise<T>): Promise<T> => {
  waiting++;
  return promise.finally(() => { waiting--; });
};

const wrapAsync = (target: object | undefined, name: string): void => {
  if (!target) return;
  const holder = target as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = holder[name];
  if (typeof original !== 'function') return;
  holder[name] = function (this: unknown, ...args: unknown[]) { return tracked(original.apply(this, args)); };
};

/** Bytes a texel of each WebGPU format takes; a compressed one, its block's share. */
const GPU_TEXEL_BYTES: Record<string, number> = {
  r8unorm: 1, rg8unorm: 2, rgba8unorm: 4, 'rgba8unorm-srgb': 4, bgra8unorm: 4, 'bgra8unorm-srgb': 4,
  r16float: 2, rg16float: 4, rgba16float: 8, r32float: 4, rg32float: 8, rgba32float: 16, rg11b10ufloat: 4, r32uint: 4, rg32uint: 8, rgba32uint: 16,
  depth16unorm: 2, depth24plus: 4, 'depth24plus-stencil8': 4, depth32float: 4,
};
const gpuTexelBytes = (format: string): number => GPU_TEXEL_BYTES[format] ?? (/^(bc1|bc4|etc2-rgb8)/.test(format) ? 0.5 : /^(bc|etc2|astc)/.test(format) ? 1 : 4);
const gpuHeld = new WeakMap<object, number>();
let gpuBytesHeld = 0;

/** What the page's WebGPU buffers and textures take, for as long as they are not destroyed. */
export const webGpuBytes = (): number => gpuBytesHeld;

const holdGpu = (resource: object, bytes: number): void => {
  gpuHeld.set(resource, bytes);
  gpuBytesHeld += bytes;
};

const letGoGpu = (resource: object): void => {
  gpuBytesHeld -= gpuHeld.get(resource) ?? 0;
  gpuHeld.delete(resource);
};

if (typeof GPUDevice !== 'undefined') {
  const createBuffer = GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer = function (this: GPUDevice, descriptor: GPUBufferDescriptor) {
    const buffer = createBuffer.call(this, descriptor);
    holdGpu(buffer, descriptor.size);
    return buffer;
  };
  const createTexture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function (this: GPUDevice, descriptor: GPUTextureDescriptor) {
    const texture = createTexture.call(this, descriptor);
    let bytes = 0;
    for (let level = 0; level < (descriptor.mipLevelCount ?? 1); level++) {
      bytes += Math.max(1, texture.width >> level) * Math.max(1, texture.height >> level) * texture.depthOrArrayLayers * gpuTexelBytes(texture.format) * texture.sampleCount;
    }
    holdGpu(texture, bytes);
    return texture;
  };
  for (const proto of [GPUBuffer.prototype, GPUTexture.prototype]) {
    const destroy = proto.destroy;
    proto.destroy = function (this: GPUBuffer & GPUTexture) {
      letGoGpu(this);
      return destroy.call(this);
    };
  }
  wrapAsync(GPUDevice.prototype, 'createRenderPipelineAsync');
  wrapAsync(GPUDevice.prototype, 'createComputePipelineAsync');
  wrapAsync(GPUBuffer.prototype, 'mapAsync');
  wrapAsync(GPUQueue.prototype, 'onSubmittedWorkDone');
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = function (this: GPUAdapter, descriptor?: GPUDeviceDescriptor) {
    const requiredFeatures = [...(descriptor?.requiredFeatures ?? [])].filter((feature) => feature !== 'timestamp-query');
    return requestDevice.call(this, { ...descriptor, requiredFeatures });
  };
}

// A worker's reply arrives when it is done, which is when the machine says.
const unanswered = new WeakMap<Worker, number>();
const postMessage = Worker.prototype.postMessage as (this: Worker, ...args: unknown[]) => void;
Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
  if (!unanswered.has(this)) {
    this.addEventListener('message', () => {
      const count = unanswered.get(this) ?? 0;
      if (count <= 0) return;
      unanswered.set(this, count - 1);
      waiting--;
    });
  }
  unanswered.set(this, (unanswered.get(this) ?? 0) + 1);
  waiting++;
  postMessage.apply(this, args);
} as typeof Worker.prototype.postMessage;

// --- GPU memory, as the bytes each buffer, texture and renderbuffer was given. ---

const BYTES_PER_TEXEL: Record<number, number> = {
  0x8229: 1, 0x822b: 2, 0x8051: 3, 0x8058: 4, 0x8c43: 4, 0x1908: 4, 0x1907: 3, 0x1903: 1, 0x8227: 2, // R8, RG8, RGB8, RGBA8, SRGB8_A8, RGBA, RGB, RED, RG
  0x822d: 2, 0x822f: 4, 0x881b: 6, 0x881a: 8, 0x822e: 4, 0x8230: 8, 0x8815: 12, 0x8814: 16, 0x8c3a: 4, 0x8c3d: 4, // R16F, RG16F, RGB16F, RGBA16F, R32F, RG32F, RGB32F, RGBA32F, R11G11B10F, RGB9E5
  0x81a5: 2, 0x81a6: 4, 0x8cac: 4, 0x88f0: 4, 0x8cad: 8, 0x8d48: 1, // DEPTH16, DEPTH24, DEPTH32F, D24S8, D32FS8, S8
  0x8056: 2, 0x8057: 2, 0x8d62: 2, 0x8059: 4, 0x8d9f: 4, // RGBA4, RGB5_A1, RGB565, RGB10_A2, RGB10_A2UI... small targets
};

const held = new WeakMap<object, number>();
// Each scene has a context of its own, and what the last one lets go of later must not count against this one.
const bytesHeld = new WeakMap<WebGL2RenderingContext, number>();

const hold = (gl: WebGL2RenderingContext, resource: object | null, bytes: number): void => {
  if (!resource) return;
  bytesHeld.set(gl, (bytesHeld.get(gl) ?? 0) + bytes - (held.get(resource) ?? 0));
  held.set(resource, bytes);
};

const letGo = (gl: WebGL2RenderingContext, resource: object | null): void => {
  if (!resource) return;
  bytesHeld.set(gl, (bytesHeld.get(gl) ?? 0) - (held.get(resource) ?? 0));
  held.delete(resource);
};

export const gpuBytes = (gl: WebGL2RenderingContext): number => bytesHeld.get(gl) ?? 0;

const texelBytes = (format: number): number => BYTES_PER_TEXEL[format] ?? 4;

const textureBinding = (gl: WebGL2RenderingContext, target: number): WebGLTexture | null => {
  if (target === gl.TEXTURE_3D) return gl.getParameter(gl.TEXTURE_BINDING_3D);
  if (target === gl.TEXTURE_2D_ARRAY) return gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY);
  if (target === gl.TEXTURE_2D) return gl.getParameter(gl.TEXTURE_BINDING_2D);
  return gl.getParameter(gl.TEXTURE_BINDING_CUBE_MAP);
};

const bufferBinding = (gl: WebGL2RenderingContext, target: number): WebGLBuffer | null =>
  gl.getParameter(target === gl.ELEMENT_ARRAY_BUFFER ? gl.ELEMENT_ARRAY_BUFFER_BINDING : target === gl.UNIFORM_BUFFER ? gl.UNIFORM_BUFFER_BINDING : gl.ARRAY_BUFFER_BINDING);

const mipBytes = (width: number, height: number, depth: number, levels: number, perTexel: number): number => {
  let total = 0;
  for (let level = 0; level < levels; level++) {
    total += Math.max(1, width >> level) * Math.max(1, height >> level) * Math.max(1, depth >> level) * perTexel;
  }
  return total;
};

const after = <K extends keyof WebGL2RenderingContext>(name: K, count: (gl: WebGL2RenderingContext, args: unknown[]) => void): void => {
  const original = proto[name] as unknown as (...args: unknown[]) => unknown;
  (proto as unknown as Record<string, unknown>)[name] = function (this: WebGL2RenderingContext, ...args: unknown[]) {
    const result = original.apply(this, args);
    count(this, args);
    return result;
  };
};

after('bufferData', (gl, [target, data]) => {
  const bytes = typeof data === 'number' ? data : (data as ArrayBufferView | null)?.byteLength ?? 0;
  hold(gl, bufferBinding(gl, target as number), bytes);
});
after('texStorage2D', (gl, [target, levels, format, width, height]) => {
  const faces = target === gl.TEXTURE_CUBE_MAP ? 6 : 1;
  hold(gl, textureBinding(gl, target as number), faces * mipBytes(width as number, height as number, 1, levels as number, texelBytes(format as number)));
});
after('texStorage3D', (gl, [target, levels, format, width, height, depth]) => {
  hold(gl, textureBinding(gl, target as number), mipBytes(width as number, height as number, depth as number, levels as number, texelBytes(format as number)));
});
after('texImage2D', (gl, args) => {
  const [target, level, format] = args as number[];
  if (level !== 0) return;
  // Pixels from an image say how big they are themselves.
  const source = args.length < 9 ? args[5] as { width?: number; height?: number; videoWidth?: number; videoHeight?: number } : null;
  const width = source ? source.width ?? source.videoWidth ?? 0 : args[3] as number;
  const height = source ? source.height ?? source.videoHeight ?? 0 : args[4] as number;
  const faces = target >= gl.TEXTURE_CUBE_MAP_POSITIVE_X && target <= gl.TEXTURE_CUBE_MAP_NEGATIVE_Z ? 6 : 1;
  hold(gl, textureBinding(gl, target), faces * width * height * texelBytes(format));
});
after('texImage3D', (gl, args) => {
  const [target, level, format, width, height, depth] = args as number[];
  if (level === 0) hold(gl, textureBinding(gl, target), width * height * depth * texelBytes(format));
});
after('renderbufferStorage', (gl, [, format, width, height]) => {
  hold(gl, gl.getParameter(gl.RENDERBUFFER_BINDING), (width as number) * (height as number) * texelBytes(format as number));
});
after('renderbufferStorageMultisample', (gl, [, samples, format, width, height]) => {
  hold(gl, gl.getParameter(gl.RENDERBUFFER_BINDING), Math.max(1, samples as number) * (width as number) * (height as number) * texelBytes(format as number));
});
after('deleteBuffer', (gl, [buffer]) => letGo(gl, buffer as object | null));
after('deleteTexture', (gl, [texture]) => letGo(gl, texture as object | null));
after('deleteRenderbuffer', (gl, [renderbuffer]) => letGo(gl, renderbuffer as object | null));
