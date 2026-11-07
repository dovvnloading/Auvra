import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { translatePass } from '../../texturing/gpu/glslModule';
import { layoutUniforms, packUniforms, shapeOf } from '../../texturing/gpu/uniformLayout';
import { WebGpuTexturing, WebGpuUnsupported, dataTextureFormat, imageFormat, type WgpuDevice } from '../../texturing/gpu/webgpuTexturing';
import { nodeBindings } from '../../texturing/graph/nodeKit';
import { TEXTURE_NODE_DEFINITIONS } from '../../texturing/graph/registry';
import { defaultNodeParams } from '../../texturing/graph/document';
import type { NodeRunContext, TexNodeDef } from '../../texturing/graph/types';

/** Every pass a node draws with its default settings and nothing wired in: its fragment (kit declarations included) and inputs. */
const passesOf = async (definition: TexNodeDef): Promise<Array<{ fragment: string; inputs: string[]; wgsl?: { functions: string; result: string } }>> => {
    const params = defaultNodeParams(definition);
    const image = (width = 64, height = 64) => ({ kind: 'color', width, height, precision: 8, refs: 1, target: {} });
    const captured: Array<{ fragment: string; inputs: string[]; wgsl?: { functions: string; result: string } }> = [];
    const keep = (fragment: string, inputs: string[], wgsl?: { functions: string; result: string }) => {
        if (captured.length > 30) throw new Error('enough');
        captured.push({ fragment, inputs, ...(wgsl ? { wgsl } : {}) });
    };
    const gpu = {
        constant: () => ({}), image: (w?: number, h?: number) => image(w, h), release: () => undefined, retain: (x: unknown) => x, clear: () => undefined,
        pass: async (_t: unknown, o: { fragment: string; inputs?: Record<string, unknown> }) => keep(o.fragment, Object.keys(o.inputs ?? {})),
        passNow: (_t: unknown, o: { fragment: string; inputs?: Record<string, unknown> }) => keep(o.fragment, Object.keys(o.inputs ?? {})),
        readRgba8Later: async () => null, readPixelLater: async () => null, drawInstances: async () => undefined, copy: () => undefined, maxSize: 4096, memory: { live: 0, idle: 0 },
    };
    const context = {
        gpu, node: { id: 'n', type: definition.type, x: 0, y: 0, params }, width: 64, height: 64, seed: 1, precision: 8, tiling: [true, true],
        iteration: { index: 0, count: 1 }, world: [1, 1], params, signal: new AbortController().signal, time: { seconds: 0, loop: 4, phase: 0 },
        input: () => null, outputKind: () => 'color', image: (_k: string, w?: number, h?: number) => image(w, h), texture: () => null, external: () => null, material: () => null,
        subgraph: async () => ({}), note: () => undefined,
        pass: async (_t: unknown, fragment: string, extra: { inputs?: Record<string, unknown>; wgsl?: { functions: string; result: string } } = {}) => {
            const bound = nodeBindings(definition, { input: () => null, params, seed: 1, texture: () => null, tiling: [true, true] }, () => ({}) as never);
            keep(`${bound.declarations}\n${fragment}`, [...Object.keys(bound.inputs), ...Object.keys(extra.inputs ?? {})], extra.wgsl);
        },
    };
    try {
        await definition.run(context as unknown as NodeRunContext);
    } catch { /* a node that needs something wired in stops early: its passes so far are kept */ }
    return captured;
};

describe('texture graph passes in WGSL', () => {
    it('every node\'s passes translate (with their default settings)', async () => {
        const failures: string[] = [];
        let passes = 0;
        for (const definition of TEXTURE_NODE_DEFINITIONS) {
            for (const [index, pass] of (await passesOf(definition)).entries()) {
                passes++;
                try { translatePass(pass); } catch (error) { failures.push(`${definition.type} #${index}: ${(error as Error).message}`); }
            }
        }
        expect(passes).toBeGreaterThan(200);
        expect(failures).toEqual([]);
    });

    it('writes a module: uniforms in one struct, each sampler a texture and a sampler, defines and overloads resolved', async () => {
        const definition = TEXTURE_NODE_DEFINITIONS.find((candidate) => candidate.type === 'perlinNoise')!;
        const [pass] = await passesOf(definition);
        const module = translatePass(pass);
        expect(module.uniforms[0]).toEqual({ name: 'uSize', type: 'vec2' });
        expect(module.uniforms.map((field) => field.name)).toEqual(expect.arrayContaining(['uSeed', 'uTiles', 'p_scale']));
        expect(module.code).toContain('var<storage, read> u: Uniforms;');
        expect(module.code).toContain('@fragment fn fs_main(');
        expect(module.code).toContain('gf_glsl_main();');
        // #define TAU and friends are numbers by now; overloads have names of their own.
        expect(module.code).not.toMatch(/\bTAU\b/);
        expect(module.code).toMatch(/fn gf_hashU_1\(/);
        const sampled = translatePass({ fragment: 'void main() { outColor = texture(source, vUv) + texelFetch(other, ivec2(0), 0); }', inputs: ['source', 'other'] });
        expect(sampled.textures).toEqual(['source', 'other']);
        expect(sampled.code).toContain('@group(0) @binding(1) var T_source: texture_2d<f32>;');
        expect(sampled.code).toContain('@group(0) @binding(4) var S_other: sampler;');
        expect(sampled.code).toContain('textureLoad(T_other');
    });

    it('takes a function graph\'s own WGSL in place of its GLSL', async () => {
        const definition = TEXTURE_NODE_DEFINITIONS.find((candidate) => candidate.type === 'pixelProcessor')!;
        const [pass] = await passesOf(definition);
        expect(pass.wgsl?.functions).toContain('fn fn_result(');
        const module = translatePass(pass);
        expect(module.code).toContain('fn fn_result(uv: vec2<f32>, pixel: vec2<f32>)');
        expect(module.code).toContain('outColor_ = fn_result(vUv_, fragCoord_.xy);');
        expect(module.code).toContain('fn c_a(at: vec2f) -> vec4f { return gf_c_a(at); }');
        expect(module.code).toContain('fn fn_hash1(');
        expect(module.code).not.toContain('gf_glsl_main');
    });

    it('refuses plainly what it does not translate', () => {
        expect(() => translatePass({ fragment: 'struct Hit { float d; };\nvoid main() { outColor = vec4(0.0); }', inputs: [] })).toThrow(/struct/);
        expect(() => translatePass({ fragment: '#ifdef FOO\nvoid main() { outColor = vec4(1.0); }\n#endif', inputs: [] })).toThrow(/preprocessor/);
    });
});

describe('uniforms in a storage buffer', () => {
    it('lays fields out by WGSL\'s rules for shared buffers', () => {
        expect(shapeOf('float')).toEqual({ align: 4, size: 4 });
        expect(shapeOf('vec3')).toEqual({ align: 16, size: 12 });
        expect(shapeOf('float[16]')).toEqual({ align: 4, size: 64 });
        expect(shapeOf('vec3[2]')).toEqual({ align: 16, size: 32 });
        expect(shapeOf('mat3')).toEqual({ align: 16, size: 48 });
        const layout = layoutUniforms([{ name: 'a', type: 'float' }, { name: 'b', type: 'vec3' }, { name: 'c', type: 'vec2' }, { name: 'd', type: 'int' }, { name: 'e', type: 'vec4[2]' }]);
        expect(layout.offsets).toEqual([0, 16, 32, 40, 48]);
        expect(layout.size).toBe(80);
    });

    it('writes numbers, vectors, three\'s vectors, whole numbers and arrays where they belong', () => {
        const layout = layoutUniforms([{ name: 'size', type: 'vec2' }, { name: 'tiles', type: 'ivec2' }, { name: 'colors', type: 'vec4[2]' }, { name: 'positions', type: 'float[3]' }, { name: 'flag', type: 'int' }]);
        const bytes = packUniforms(layout, { size: new THREE.Vector2(512, 256), tiles: [1, 0], colors: [new THREE.Vector4(1, 2, 3, 4), new THREE.Vector4(5, 6, 7, 8)], positions: [0.25, 0.5, 0.75], flag: true });
        const f = new Float32Array(bytes);
        const i = new Int32Array(bytes);
        expect([f[0], f[1]]).toEqual([512, 256]);
        expect([i[2], i[3]]).toEqual([1, 0]);
        expect(Array.from(f.slice(4, 12))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(Array.from(f.slice(12, 15))).toEqual([0.25, 0.5, 0.75]);
        expect(i[15]).toBe(1);
    });
});

/** A WebGPU device that keeps what it is asked, and reads back rows numbered by their place. */
const fakeDevice = () => {
    const calls: Array<{ what: string; descriptor?: unknown }> = [];
    let lastCopy: { width: number; height: number; bytesPerRow: number; bytes: number } | null = null;
    const device: WgpuDevice & { calls: typeof calls } = {
        calls,
        limits: { maxTextureDimension2D: 8192 },
        features: { has: () => false },
        lost: new Promise(() => undefined),
        queue: {
            submit: () => calls.push({ what: 'submit' }),
            writeBuffer: (_buffer, _offset, data) => calls.push({ what: 'writeBuffer', descriptor: data }),
            writeTexture: (destination, data) => calls.push({ what: 'writeTexture', descriptor: { destination, length: data.byteLength } }),
            copyExternalImageToTexture: () => calls.push({ what: 'copyExternal' }),
            onSubmittedWorkDone: async () => undefined,
        },
        createTexture: (descriptor) => { calls.push({ what: 'createTexture', descriptor }); return { format: (descriptor as { format: string }).format, createView: () => ({ view: true }), destroy: () => calls.push({ what: 'destroyTexture' }) }; },
        createSampler: (descriptor) => { calls.push({ what: 'createSampler', descriptor }); return {}; },
        createBuffer: (descriptor) => {
            calls.push({ what: 'createBuffer', descriptor });
            const size = (descriptor as { size: number }).size;
            return {
                mapAsync: async () => undefined,
                getMappedRange: () => {
                    const buffer = new ArrayBuffer(size);
                    if (lastCopy) {
                        // Each row holds its row number (in the copy's own format), padding after it.
                        for (let y = 0; y < lastCopy.height; y++) {
                            if (lastCopy.bytes === 16) new Float32Array(buffer, y * lastCopy.bytesPerRow, lastCopy.width * 4).fill(y / Math.max(1, lastCopy.height - 1));
                            else new Uint8Array(buffer, y * lastCopy.bytesPerRow, lastCopy.width * 4).fill(y);
                        }
                    }
                    return buffer;
                },
                unmap: () => undefined,
                destroy: () => calls.push({ what: 'destroyBuffer' }),
            };
        },
        createShaderModule: (descriptor) => { calls.push({ what: 'createShaderModule', descriptor }); return {}; },
        createBindGroupLayout: (descriptor) => { calls.push({ what: 'createBindGroupLayout', descriptor }); return {}; },
        createPipelineLayout: () => ({}),
        createRenderPipeline: (descriptor) => { calls.push({ what: 'createRenderPipeline', descriptor }); return {}; },
        createBindGroup: (descriptor) => { calls.push({ what: 'createBindGroup', descriptor }); return {}; },
        createCommandEncoder: () => ({
            beginRenderPass: (descriptor) => {
                calls.push({ what: 'beginRenderPass', descriptor });
                return { setPipeline: () => undefined, setBindGroup: () => undefined, setScissorRect: (x, y, w, h) => calls.push({ what: 'scissor', descriptor: [x, y, w, h] }), draw: () => calls.push({ what: 'draw' }), end: () => undefined };
            },
            copyTextureToBuffer: (source, destination, size) => {
                const [width, height] = size as number[];
                const bytesPerRow = (destination as { bytesPerRow: number }).bytesPerRow;
                lastCopy = { width, height, bytesPerRow, bytes: (source as { texture: { format: string } }).texture.format === 'rgba32float' ? 16 : 4 };
                calls.push({ what: 'copyTextureToBuffer', descriptor: { source, destination, size } });
            },
            finish: () => ({}),
        }),
        pushErrorScope: () => undefined,
        popErrorScope: async () => null,
    };
    return device;
};

describe('the WebGPU texturing GPU', () => {
    it('keeps images in a pool by size and format, and passes in pipelines made once', async () => {
        const device = fakeDevice();
        const gpu = new WebGpuTexturing(device);
        const a = gpu.image(64, 32, 'gray', 16);
        expect(device.calls.find((call) => call.what === 'createTexture')?.descriptor).toMatchObject({ size: [64, 32], format: 'r16float' });
        gpu.release(a);
        const b = gpu.image(64, 32, 'gray', 16);
        expect(b.target).toBe(a.target);
        expect(device.calls.filter((call) => call.what === 'createTexture').length).toBe(1);
        const fragment = 'uniform float uLevel;\nvoid main() { outColor = vec4(uLevel); }';
        await gpu.pass(b, { fragment, uniforms: { uLevel: 0.5 } });
        await gpu.pass(b, { fragment, uniforms: { uLevel: 0.75 } });
        expect(device.calls.filter((call) => call.what === 'createRenderPipeline').length).toBe(1);
        expect(device.calls.filter((call) => call.what === 'draw').length).toBe(2);
        // Each pass's uniforms are written (uSize, then uLevel) and let go once drawn.
        const written = device.calls.filter((call) => call.what === 'writeBuffer').map((call) => new Float32Array(call.descriptor as ArrayBuffer));
        expect([written[1][0], written[1][1], written[1][2]]).toEqual([64, 32, 0.75]);
        expect(device.calls.filter((call) => call.what === 'destroyBuffer').length).toBe(2);
    });

    it('refuses instanced copies and passes that do not translate, saying why', async () => {
        const gpu = new WebGpuTexturing(fakeDevice());
        const image = gpu.image(8, 8, 'color', 8);
        await expect(gpu.drawInstances(image, { count: 1, varyings: [], vertex: '', fragment: '', stack: 'max' })).rejects.toBeInstanceOf(WebGpuUnsupported);
        await expect(gpu.pass(image, { fragment: 'struct S { float a; };\nvoid main() { outColor = vec4(1.0); }' })).rejects.toThrow(/does not translate/);
    });

    it('reads pixels back the way WebGL does: padding stripped, rows flipped when asked', async () => {
        const gpu = new WebGpuTexturing(fakeDevice());
        const image = gpu.image(3, 2, 'color', 8);
        const pixels = await gpu.readRgba8Later(image);
        // Rows of 3 pixels (12 bytes) come from rows padded to 256: row 0 then row 1.
        expect(Array.from(pixels!.slice(0, 12))).toEqual(Array(12).fill(0));
        expect(Array.from(pixels!.slice(12, 24))).toEqual(Array(12).fill(1));
        const grey = gpu.image(2, 3, 'gray', 16);
        const flipped = await gpu.readUint16Async(grey, 2, 3, 'gray', true);
        // The bottom row (0) comes last when flipped; the top row (value 1) first.
        expect(Array.from(flipped)).toEqual([65535, 65535, 32768, 32768, 0, 0]);
    });

    it('maps formats as WebGL keeps them', () => {
        expect(imageFormat('color', 8).format).toBe('rgba8unorm');
        expect(imageFormat('gray', 32).format).toBe('r32float');
        expect(dataTextureFormat(THREE.RGBAFormat, THREE.UnsignedByteType, true)?.format).toBe('rgba8unorm-srgb');
        expect(dataTextureFormat(THREE.RGFormat, THREE.FloatType, false)).toEqual({ format: 'rg32float', bytes: 8 });
        expect(dataTextureFormat(THREE.RedFormat, THREE.HalfFloatType, false)).toEqual({ format: 'r16float', bytes: 2 });
    });
});
