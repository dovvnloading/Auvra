import * as THREE from 'three';
import { GpuParticleSystem } from '../../runtime/gpuParticles';
import { createParticleForceField, sanitizeParticleEffect } from '../../runtime/particleEffect';
import { ParticleWorld } from '../../renderer/gpu/particles/particleWorld';
import { PARTICLE_BYTES } from '../../renderer/gpu/particles/particleWgsl';
import { VIEW_BYTES } from '../../renderer/gpu/shaders';

const fields = ['radial', 'vortex', 'directional'].map((kind, index) => ({
    ...createParticleForceField(kind), radius: 4, strength: [4, -2, 6][index],
}));
const cases = [
    { name: 'superposition', fields, at: [2, 0, 0], expected: [-0.1, 0.15, 0.05] },
    { name: 'radius boundary', fields, at: [4, 0, 0], expected: [0, 0, 0] },
    { name: 'centre', fields, at: [0, 0, 0], expected: [0, 0.3, 0] },
    { name: 'empty stack', fields: [], at: [2, 0, 0], expected: [0, 0, 0] },
    { name: 'moving emitter', fields, at: [2, 3, 1], origin: [0, 3, 1], expected: [-0.1, 0.15, 0.05] },
];
const stepSeconds = 0.05;

// One stationary particle. The first step spawns it and the second applies the force stack.
async function checkCases(run) {
    for (const test of cases) {
        const effect = sanitizeParticleEffect({
            rate: 0, speed: [0, 0], lifetime: [2, 2], shape: { kind: 'point' }, drag: 0, gravity: 0, turbulence: 0,
            forceFields: test.fields, render: { blending: 'additive' },
        });
        const matrix = new THREE.Matrix4().makeTranslation(...(test.origin ?? [0, 0, 0]));
        const velocity = await run(effect, test.at, matrix);
        if (!test.expected.every((value, axis) => Math.abs(value - velocity[axis]) < 0.0001)) {
            throw new Error(`${test.name} expected velocity ${test.expected}, read ${velocity}`);
        }
    }
    return cases.map(test => test.name);
}

async function checkWebGL() {
    const renderer = new THREE.WebGLRenderer();
    try {
        return await checkCases((effect, at, matrix) => {
            const system = new GpuParticleSystem(1);
            try {
                system.setEffect(effect);
                system.emitAt(1, ...at);
                system.step(renderer, stepSeconds, matrix, null);
                system.step(renderer, stepSeconds, matrix, null);
                // Read velocity/life from the second attachment of the live ping-pong target.
                renderer.setRenderTarget(system.targets[0]);
                const gl = renderer.getContext();
                const result = new Float32Array(4);
                gl.readBuffer(gl.COLOR_ATTACHMENT1);
                gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, result);
                return Array.from(result.subarray(0, 3));
            } finally {
                renderer.setRenderTarget(null);
                system.dispose();
            }
        });
    } finally {
        renderer.dispose();
    }
}

async function checkWebGPU() {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('WebGPU adapter unavailable');
    const device = await adapter.requestDevice();
    const passes = [];
    const world = new ParticleWorld({ core: { device }, addPass: pass => passes.push(pass), removePass: () => {} });
    const cameraLayout = device.createBindGroupLayout({
        entries: [{ binding: 0, visibility: 7, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: VIEW_BYTES } }],
    });
    const camera = device.createBuffer({ size: VIEW_BYTES, usage: GPUBufferUsage.UNIFORM });
    const target = format => ({
        view: device.createTexture({ size: [1, 1], format, usage: GPUTextureUsage.TEXTURE_BINDING }).createView(),
    });
    const frame = {
        camera: new THREE.PerspectiveCamera(), scene: new THREE.Scene(), products: new Map(), mainViewOffset: 0,
        targets: { depth: target('depth32float'), normal: target('rgba16float') },
        cameraLayout, sceneLayout: device.createBindGroupLayout({ entries: [] }),
        cameraBindGroup: device.createBindGroup({ layout: cameraLayout, entries: [{ binding: 0, resource: { buffer: camera } }] }),
    };
    // Production keeps particle records GPU-only. Add copy permission only for this readback.
    const createBuffer = device.createBuffer.bind(device);
    device.createBuffer = descriptor => createBuffer(descriptor.label === 'gpu particles records'
        ? { ...descriptor, usage: descriptor.usage | GPUBufferUsage.COPY_SRC } : descriptor);
    const staging = device.createBuffer({ size: PARTICLE_BYTES, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
        device.pushErrorScope('validation');
        const result = await checkCases(async (effect, at, matrix) => {
            const emitter = world.createEmitter(1);
            try {
                emitter.setEffect(effect);
                emitter.emitAt(1, ...at);
                for (let step = 0; step < 2; step++) {
                    frame.encoder = device.createCommandEncoder();
                    emitter.step(stepSeconds, matrix);
                    passes[0].execute(frame);
                    device.queue.submit([frame.encoder.finish()]);
                }
                const encoder = device.createCommandEncoder();
                encoder.copyBufferToBuffer(emitter.particles, 0, staging, 0, PARTICLE_BYTES);
                device.queue.submit([encoder.finish()]);
                await staging.mapAsync(GPUMapMode.READ);
                const velocity = Array.from(new Float32Array(staging.getMappedRange(), 16, 3));
                staging.unmap();
                return velocity;
            } finally {
                emitter.dispose();
            }
        });
        const error = await device.popErrorScope();
        if (error) throw new Error(error.message);
        return result;
    } finally {
        world.dispose();
        device.destroy();
    }
}

window.checkParticleForces = backend => backend === 'webgpu' ? checkWebGPU() : checkWebGL();
