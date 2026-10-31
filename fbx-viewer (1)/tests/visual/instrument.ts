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
