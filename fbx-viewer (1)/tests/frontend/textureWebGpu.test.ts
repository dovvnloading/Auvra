import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { translatePass } from '../../texturing/gpu/glslModule';
import { layoutUniforms, packUniforms, shapeOf } from '../../texturing/gpu/uniformLayout';
import { WebGpuTexturing, WebGpuUnsupported, compressedUpload, dataTextureFormat, imageFormat, type WgpuDevice } from '../../texturing/gpu/webgpuTexturing';
import { nodeBindings } from '../../texturing/graph/nodeKit';
import { TEXTURE_NODE_DEFINITIONS } from '../../texturing/graph/registry';
import { defaultNodeParams } from '../../texturing/graph/document';
import type { NodeRunContext, TexNodeDef } from '../../texturing/graph/types';
import { checkWgsl, findingWords } from './wgslChecks';
import { FN_RESULT_TYPE, FN_REROUTE_TYPE, FN_SAMPLE_TYPE, FN_SETTING_TYPE, FUNCTION_NODE_DEFINITIONS, createFunctionNode, type FnLink, type FnNode, type FunctionGraph } from '../../texturing/graph/functionGraph';
import { FLIPBOOK_PACK_GLSL } from '../../texturing/graph/animation';
import { SCATTER_VARYINGS, SCATTER_VERTEX, SHAPE_GLSL } from '../../texturing/graph/scatter';

/** Every pass a node draws with its default settings (or those given) and nothing wired in: its fragment (kit declarations included) and inputs. */
const passesOf = async (definition: TexNodeDef, given: Record<string, unknown> = {}): Promise<Array<{ fragment: string; inputs: string[]; wgsl?: { functions: string; result: string } }>> => {
    const params = { ...defaultNodeParams(definition), ...given };
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
        subgraph: async () => ({}), note: () => undefined, curve: () => null, giveCurve: () => undefined,
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
const fakeDevice = (supported: readonly string[] = []) => {
    const calls: Array<{ what: string; descriptor?: unknown }> = [];
    let lastCopy: { width: number; height: number; bytesPerRow: number; bytes: number } | null = null;
    const device: WgpuDevice & { calls: typeof calls } = {
        calls,
        limits: { maxTextureDimension2D: 8192 },
        features: { has: (name) => supported.includes(name) },
        lost: new Promise(() => undefined),
        queue: {
            submit: () => calls.push({ what: 'submit' }),
            writeBuffer: (_buffer, _offset, data) => calls.push({ what: 'writeBuffer', descriptor: data }),
            writeTexture: (destination, data, layout, size) => calls.push({ what: 'writeTexture', descriptor: { destination, length: data.byteLength, layout, size } }),
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
                return { setPipeline: () => undefined, setBindGroup: () => undefined, setScissorRect: (x, y, w, h) => calls.push({ what: 'scissor', descriptor: [x, y, w, h] }), draw: (...args) => calls.push({ what: 'draw', descriptor: args }), end: () => undefined };
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

    it('draws instanced squares with wrapped copies, max blending and cached pipelines', async () => {
        const device = fakeDevice();
        const gpu = new WebGpuTexturing(device);
        const image = gpu.image(16, 8, 'color', 16);
        const options = {
            count: 5, stack: 'max' as const, wrap: [true, false] as [boolean, boolean],
            varyings: ['vec2 vLocal', 'flat int vCopy'],
            vertex: 'void placeCopy(int copy, vec2 corner, vec2 shift) { gl_Position = vec4(corner + shift, 0.0, 1.0); vLocal = corner; vCopy = copy; }',
            fragment: 'void main() { outColor = vec4(vLocal, float(vCopy), 1.0); }',
            clear: [0.1, 0.2, 0.3, 0.4] as [number, number, number, number],
        };
        await gpu.drawInstances(image, options);
        await gpu.drawInstances(image, options);
        expect(device.calls.filter((call) => call.what === 'createRenderPipeline')).toHaveLength(1);
        const pipeline = device.calls.find((call) => call.what === 'createRenderPipeline')!.descriptor as Record<string, any>;
        expect(pipeline.primitive.topology).toBe('triangle-list');
        expect(pipeline.fragment.targets[0].blend.color.operation).toBe('max');
        expect(device.calls.filter((call) => call.what === 'draw').map((call) => call.descriptor)).toEqual([[6, 15], [6, 15]]);
        const pass = device.calls.find((call) => call.what === 'beginRenderPass')!.descriptor as Record<string, any>;
        expect(pass.colorAttachments[0].clearValue).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 0.4 });
        const module = device.calls.find((call) => call.what === 'createShaderModule')!.descriptor as { code: string };
        expect(module.code).toContain('@builtin(instance_index)');
        expect(module.code).toContain('@interpolate(flat) vCopy: i32');
    });

    it('draws single-pixel copies with a depth attachment for higher-wins', async () => {
        const device = fakeDevice();
        const gpu = new WebGpuTexturing(device);
        const image = gpu.image(8, 8, 'color', 32);
        await gpu.drawInstances(image, {
            count: 4, points: true, wrap: [true, true], stack: 'higher',
            varyings: ['vec4 vBox'],
            vertex: 'void placeCopy(int copy, vec2 corner, vec2 shift) { gl_Position = vec4(corner, 0.0, 1.0); vBox = vec4(float(copy)); }',
            fragment: 'void main() { gl_FragDepth = 0.4; outColor = vBox; }',
        });
        const pipeline = device.calls.find((call) => call.what === 'createRenderPipeline')!.descriptor as Record<string, any>;
        expect(pipeline.primitive.topology).toBe('point-list');
        expect(pipeline.depthStencil).toMatchObject({ format: 'depth24plus', depthCompare: 'less', depthWriteEnabled: true });
        const pass = device.calls.find((call) => call.what === 'beginRenderPass')!.descriptor as Record<string, any>;
        expect(pass.depthStencilAttachment.depthClearValue).toBe(1);
        expect(device.calls.find((call) => call.what === 'draw')?.descriptor).toEqual([1, 4]);
        expect(device.calls.some((call) => call.what === 'destroyTexture')).toBe(true);
        const module = device.calls.find((call) => call.what === 'createShaderModule')!.descriptor as { code: string };
        expect(module.code).toContain('@builtin(frag_depth)');
    });

    it('translates the real scatter placement and shape shaders, including all varyings', () => {
        const fragment = `${SHAPE_GLSL}
uniform int uShape;
uniform int uProfile;
uniform float uBevel;
float copyHeight(int pattern, vec2 local) { return builtInShape(uShape, local * 2.0 - 1.0, uProfile, uBevel); }
void main() {
    float h = copyHeight(vPattern, vLocal) * vBright;
    if (h <= 0.0005) discard;
    gl_FragDepth = 1.0 - saturate(h + vLift) * 0.999;
    outColor = vec4(float(vCopy) + 1.0, vLocal, h);
}`;
        const module = translatePass({
            fragment, inputs: ['place0', 'place1', 'place2'],
            instances: { vertex: SCATTER_VERTEX, varyings: SCATTER_VARYINGS, points: false, depth: true },
        });
        expect(module.code).toContain('fn gf_placeCopy(');
        expect(module.code).toContain('fn gf_builtInShape(');
        expect(module.code).toContain('@builtin(frag_depth)');
        expect(module.uniforms.map((uniform) => uniform.name)).toContain('uPlaceWidth');
        expect(checkWgsl(module.code)).toEqual([]);
    });

    it('refuses unsupported GLSL from both instanced and regular passes', async () => {
        const gpu = new WebGpuTexturing(fakeDevice());
        const image = gpu.image(8, 8, 'color', 8);
        await expect(gpu.drawInstances(image, { count: 1, varyings: [], vertex: '', fragment: '', stack: 'max' })).rejects.toBeInstanceOf(WebGpuUnsupported);
        await expect(gpu.pass(image, { fragment: 'struct S { float a; };\nvoid main() { outColor = vec4(1.0); }' })).rejects.toThrow(/does not translate/);
    });


    it('uploads a complete BC7 sRGB mip chain once and samples it with mip filtering', async () => {
        const device = fakeDevice(['texture-compression-bc']);
        const gpu = new WebGpuTexturing(device);
        const picture = new THREE.CompressedTexture([
            { data: new Uint8Array(64), width: 8, height: 8 },
            { data: new Uint8Array(16), width: 4, height: 4 },
        ] as unknown as ImageData[], 8, 8, THREE.RGBA_BPTC_Format);
        picture.colorSpace = THREE.SRGBColorSpace;
        picture.minFilter = THREE.LinearMipmapLinearFilter;
        picture.anisotropy = 8;
        picture.needsUpdate = true;
        const out = gpu.image(8, 8, 'color', 8);
        const fragment = 'void main() { outColor = texture(picture, vUv); }';
        await gpu.pass(out, { fragment, inputs: { picture } });
        await gpu.pass(out, { fragment, inputs: { picture } });
        const uploads = device.calls.filter((call) => call.what === 'writeTexture');
        expect(uploads).toHaveLength(2);
        expect(uploads.map((call) => (call.descriptor as { length: number }).length)).toEqual([64, 16]);
        expect(uploads.map((call) => (call.descriptor as { destination: { mipLevel: number } }).destination.mipLevel)).toEqual([0, 1]);
        expect(uploads.map((call) => (call.descriptor as { layout: { bytesPerRow: number; rowsPerImage: number } }).layout))
            .toEqual([{ bytesPerRow: 32, rowsPerImage: 2 }, { bytesPerRow: 16, rowsPerImage: 1 }]);
        expect(device.calls.find((call) => call.what === 'createTexture' && (call.descriptor as { format?: string }).format === 'bc7-rgba-unorm-srgb')?.descriptor)
            .toMatchObject({ size: [8, 8], mipLevelCount: 2, usage: 6 });
        expect(device.calls.find((call) => call.what === 'createSampler' && (call.descriptor as { maxAnisotropy?: number }).maxAnisotropy === 8)?.descriptor)
            .toMatchObject({ minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear' });
        picture.dispose();
        expect(device.calls.some((call) => call.what === 'destroyTexture')).toBe(true);
    });

    it('supports the same BC4/BC5, ETC2 and ASTC formats as the surface renderer', async () => {
        const choices: Array<{ format: THREE.CompressedPixelFormat; feature: string; expected: string; bytes: number }> = [
            { format: THREE.SIGNED_RED_RGTC1_Format, feature: 'texture-compression-bc', expected: 'bc4-r-snorm', bytes: 8 },
            { format: THREE.RED_GREEN_RGTC2_Format, feature: 'texture-compression-bc', expected: 'bc5-rg-unorm', bytes: 16 },
            { format: THREE.RGB_ETC2_Format, feature: 'texture-compression-etc2', expected: 'etc2-rgb8unorm', bytes: 8 },
            { format: THREE.RGBA_ETC2_EAC_Format, feature: 'texture-compression-etc2', expected: 'etc2-rgba8unorm', bytes: 16 },
            { format: THREE.RGBA_ASTC_4x4_Format, feature: 'texture-compression-astc', expected: 'astc-4x4-unorm', bytes: 16 },
        ];
        for (const choice of choices) {
            const picture = new THREE.CompressedTexture([
                { data: new Uint8Array(choice.bytes), width: 4, height: 4 },
            ] as unknown as ImageData[], 4, 4, choice.format);
            const device = fakeDevice([choice.feature]);
            const gpu = new WebGpuTexturing(device);
            const dest = gpu.image(4, 4, 'color', 8);
            await gpu.pass(dest, { fragment: 'void main() { outColor = texture(source, vUv); }', inputs: { source: picture } });
            expect(device.calls.some((call) => call.what === 'createTexture' && (call.descriptor as { format?: string }).format === choice.expected)).toBe(true);
            expect(device.calls.find((call) => call.what === 'writeTexture')?.descriptor).toMatchObject({ length: choice.bytes, layout: { bytesPerRow: choice.bytes, rowsPerImage: 1 } });
            picture.dispose();
        }
    });

    it('rejects unsupported compression features, missing mip data and wrong block lengths before allocating', async () => {
        const picture = new THREE.CompressedTexture([
            { data: new Uint8Array(16), width: 4, height: 4 },
        ] as unknown as ImageData[], 4, 4, THREE.RGBA_BPTC_Format);
        expect(() => compressedUpload(picture, 8192, () => false)).toThrow(/texture-compression-bc/);
        expect(() => compressedUpload(new THREE.CompressedTexture([], 4, 4, THREE.RGBA_BPTC_Format), 8192, () => true)).toThrow(/no mip levels/);
        const broken = new THREE.CompressedTexture([
            { data: new Uint8Array(3), width: 4, height: 4 },
        ] as unknown as ImageData[], 4, 4, THREE.RGBA_BPTC_Format);
        expect(() => compressedUpload(broken, 8192, () => true)).toThrow(/block length/);
        const device = fakeDevice();
        const gpu = new WebGpuTexturing(device);
        const target = gpu.image(4, 4, 'color', 8);
        await expect(gpu.pass(target, { fragment: 'void main() { outColor = texture(source, vUv); }', inputs: { source: picture } }))
            .rejects.toBeInstanceOf(WebGpuUnsupported);
        expect(device.calls.filter((call) => call.what === 'createTexture')).toHaveLength(1);
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

/** A function graph from nodes (id, type, settings) and wires (from[.output] -> to.input). */
const functionGraphOf = (nodes: Array<[string, string, Record<string, unknown>?]>, wires: string[]): FunctionGraph => {
    const made: FnNode[] = nodes.map(([id, type, params]) => ({ ...createFunctionNode(type, 0, 0, params ?? {}), id }));
    const links: FnLink[] = wires.map((wire) => {
        const [from, to] = wire.split('->').map((part) => part.trim());
        const [fromNode, fromOutput = 'out'] = from.split('.');
        const [toNode, toInput] = to.split('.');
        return { from: fromNode, fromOutput, to: toNode, toInput };
    });
    return { nodes: made, links };
};

describe('WGSL a device takes', () => {
    it('the check finds each fault it looks for, and passes WGSL that is right', () => {
        const rules = (code: string) => checkWgsl(code).map((finding) => finding.rule);
        const wrong = `struct Uniforms { uSegs: i32, uSize: vec2<f32> }
@group(0) @binding(0) var<storage, read> u: Uniforms;
@group(0) @binding(1) var T_a: texture_2d<f32>;
fn gf_f(x: f32, p: ptr<function, f32>, v_in: vec3<f32>) -> f32 {
    x = 2.0;
    x += 1.0;
    (*p) = 1.0;
    let k = vec3<f32>(1.0);
    k.x = 1.0;
    var v = v_in;
    v.xy = vec2<f32>(1.0);
    var i: i32 = 2;
    let b = i * 2.0;
    let c = x % 2.0;
    let d = float(i);
    let e = mod(x, 2.0);
    let g = atan(x, 1.0);
    var w: u32 = 1u;
    let m = w + i;
    let n = f32(textureDimensions(T_a).x) + textureDimensions(T_a).y * 2.5;
    let q = u.uSegs < 1.5;
    let r = mat3(1.0);
    let s = f32[2](1.0, 2.0);
    return x;
}`;
        expect(rules(wrong)).toEqual([
            'parameter assigned', 'parameter assigned', 'let reassigned', 'swizzle assigned', 'number types mixed', 'real remainder',
            // u32 and i32; f32 and u32, then u32 and a real literal; i32 and a real literal.
            'GLSL constructor', 'GLSL built-in', 'GLSL built-in', 'number types mixed', 'number types mixed', 'number types mixed', 'number types mixed', 'GLSL constructor', 'GLSL constructor',
        ]);
        const right = `fn gf_g(x_in: f32, p: ptr<function, f32>) -> f32 {
    var x = x_in;
    x = 2.0;
    (*p) = x;
    var v = vec3<f32>(0.0);
    v.x = 1.0;
    { let held = vec2<f32>(1.0); v.x = held.x; v.y = held.y; }
    var i: i32 = 2;
    i++;
    let b = f32(i) * 2.0 + f32(i + 1) - x / 3.0;
    let c = x - 2.0 * floor(x / 2.0);
    let g = atan2(x, 1.0);
    let h = i % 3 + (i << 1u);
    let k = vec2<i32>(i, 1) * 2;
    for (var j: i32 = 0; j < 4; j++) { if (j >= i) { break; } }
    return select(b, c, g < h);
}`;
        expect(checkWgsl(right)).toEqual([]);
    });

    it('the passes of every node give WGSL with none of the faults translation most often makes', async () => {
        const found: string[] = [];
        for (const definition of TEXTURE_NODE_DEFINITIONS) {
            for (const [index, pass] of (await passesOf(definition)).entries()) {
                let code: string;
                try { code = translatePass(pass).code; } catch { continue; }
                for (const line of findingWords(checkWgsl(code))) found.push(`${definition.type} #${index}: ${line}`);
            }
        }
        expect(found).toEqual([]);
    });

    it('every function graph node gives WGSL with none of those faults, in a Pixel and a Value processor', async () => {
        const skip = new Set([FN_RESULT_TYPE, FN_SETTING_TYPE, FN_SAMPLE_TYPE, FN_REROUTE_TYPE]);
        const processors = ['pixelProcessor', 'valueProcessor'].map((type) => TEXTURE_NODE_DEFINITIONS.find((candidate) => candidate.type === type)!);
        const found: string[] = [];
        let checked = 0;
        for (const definition of FUNCTION_NODE_DEFINITIONS) {
            if (skip.has(definition.type)) continue;
            for (const output of definition.outputs) {
                // Unwired (its own numbers), and with its first number-taking input fed by a worked-out number.
                const graphs: FunctionGraph[] = [functionGraphOf([['n', definition.type], ['r', FN_RESULT_TYPE]], [`n.${output.key} -> r.value`])];
                const fed = definition.inputs.find((input) => input.type === 'auto' || input.type === 'vec2' || input.type === 'float');
                if (fed) {
                    graphs.push(functionGraphOf([['p', 'fnPosition'], ['k', 'fnNumber', { value: 0.37 }], ['m', 'fnMultiply'], ['n', definition.type], ['r', FN_RESULT_TYPE]],
                        ['p -> m.a', 'k -> m.b', `m -> n.${fed.key}`, `n.${output.key} -> r.value`]));
                }
                for (const processor of processors) {
                    for (const graph of graphs) {
                        const [pass] = await passesOf(processor, { mode: 'graph', function: graph });
                        if (!pass?.wgsl) continue;
                        for (const line of findingWords(checkWgsl(translatePass(pass).code))) found.push(`${processor.type} ${definition.type}.${output.key}: ${line}`);
                        checked++;
                    }
                }
            }
        }
        expect(checked).toBeGreaterThan(150);
        expect(found).toEqual([]);
    });

    it('the pass laying out a flipbook gives such WGSL too', () => {
        expect(findingWords(checkWgsl(translatePass({ fragment: FLIPBOOK_PACK_GLSL, inputs: ['source'] }).code))).toEqual([]);
    });

    it('a parameter a function changes is copied into a variable first; an out parameter is written through its pointer', () => {
        const module = translatePass({
            fragment: `float bump(float x, inout float total, out float twice) { x = x * 2.0; x += 1.0; total += x; twice = x; return x; }
vec2 nudge(vec2 p) { p.x += 1.0; p.yx = p.xy; return p; }
float keep(float x_in) { float x = x_in; x++; return x; }
void main() { float t = 0.0; float w; outColor = vec4(bump(1.0, t, w), nudge(vUv), keep(t)); }`,
            inputs: [],
        });
        expect(module.code).toContain('fn gf_bump(x_in: f32, total: ptr<function, f32>, twice: ptr<function, f32>) -> f32 {\nvar x = x_in;');
        expect(module.code).toContain('(*total) = ((*total) + x);');
        expect(module.code).toContain('fn gf_nudge(p_in: vec2f) -> vec2f {\nvar p = p_in;');
        // A parameter only read stays as it is (the name x_in is taken by it, so nothing clashes).
        expect(module.code).toContain('fn gf_keep(x_in: f32) -> f32 {\nvar x: f32 = x_in;');
        expect(findingWords(checkWgsl(module.code))).toEqual([]);
    });
});
