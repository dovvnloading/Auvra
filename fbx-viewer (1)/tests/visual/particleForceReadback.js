import * as THREE from 'three';
import { GpuParticleSystem } from '../../runtime/gpuParticles';
import { ParticleSimulation } from '../../runtime/particleSimulation';
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

async function checkCurl(run) {
    const field = { ...createParticleForceField('curl'), center: [0.5, -0.25, 0.125], radius: 3, falloff: 1.5, strength: 16, scale: 0.85, evolution: 2, seed: 53 };
    const point = [0.8, -0.65, 0.2];
    const cases = [
        { name: 'seeded curl' }, { name: 'repeat seed' }, { name: 'different seed', edit: { seed: 938 } },
        { name: 'animated curl', warmup: 8 },
        { name: 'translated curl', origin: [2, 1, -3], point: [2.8, 0.35, -2.8] },
        { name: 'reversed curl', edit: { strength: -16 } },
        { name: 'rotated local curl', space: 'local', rotate: true, origin: [7, -3, 2] },
        { name: 'outside curl', point: [3.6, -0.25, 0.125] },
        { name: 'curl on boundary', point: [3.5, -0.25, 0.125] },
        { name: 'curl exterior shell', point: [3.50001, -0.25, 0.125] },
        { name: 'microscopic curl', point: [3e-23, 2e-23, -1e-23], edit: { center: [0, 0, 0], radius: 1e-22 } },
        { name: 'large curl volume', point: [2000.125, -1300.75, 720.625], edit: { radius: 10000, scale: 0.05 } },
        { name: 'static curl', edit: { evolution: 0 } },
        { name: 'static curl later', edit: { evolution: 0 }, warmup: 8 },
    ];
    const values = new Map();
    for (const test of cases) {
        const at = test.point ?? point;
        const warmup = test.warmup ?? 0;
        const matrix = new THREE.Matrix4().makeRotationZ(test.rotate ? Math.PI / 2 : 0).setPosition(...(test.origin ?? [0, 0, 0]));
        const effect = sanitizeParticleEffect({
            rate: 0, speed: [0, 0], lifetime: [2, 2], shape: { kind: 'point' }, drag: 0, gravity: 0, turbulence: 0,
            space: test.space ?? 'world', forceFields: [{ ...field, ...test.edit }], render: { blending: 'additive' },
        });
        // GPU bursts spawn on the first submitted step. CPU bursts spawn immediately,
        // so age its empty simulation through that same instant before releasing the particle.
        const cpu = new ParticleSimulation(effect, 1);
        for (let frame = 0; frame <= warmup; frame++) cpu.step(stepSeconds, matrix.elements);
        cpu.emitAt(1, ...at);
        cpu.step(stepSeconds, matrix.elements);
        const expected = cpu.velocities;
        const actual = await run(effect, at, matrix, [0, 0, 0], 'velocity', warmup);
        if (!actual.every((value, i) => Math.abs(value - expected[i]) < 0.0001)) {
            throw new Error(`${test.name} CPU velocity ${expected}, GPU read ${actual}`);
        }
        values.set(test.name, actual);
    }
    const delta = (a, b) => Math.hypot(...values.get(a).map((v, i) => v - values.get(b)[i]));
    if (Math.hypot(...values.get('seeded curl')) < 0.001 || Math.hypot(...values.get('outside curl')) > 0.00001 ||
        ['curl on boundary', 'curl exterior shell'].some(name => Math.hypot(...values.get(name)) > 1e-7) ||
        delta('seeded curl', 'rotated local curl') > 0.0001 ||
        !values.get('reversed curl').every((value, i) => Math.abs(value + values.get('seeded curl')[i]) < 0.00001) ||
        delta('seeded curl', 'repeat seed') > 0.00001 || delta('seeded curl', 'translated curl') > 0.0001 ||
        delta('seeded curl', 'different seed') < 0.001 || delta('seeded curl', 'animated curl') < 0.001 ||
        delta('static curl', 'static curl later') > 0.00001) {
        throw new Error('Curl motion failed its seed, time or locality checks: ' + JSON.stringify(Object.fromEntries(values)));
    }
    return cases.map(test => test.name);
}

// Four .05s steps span one cycle. A linear 0→2 multiplier at 80/s integrates
// to 1, 3, 5 and 7 births. The midpoint burst adds two to the second interval.
async function checkEmissionCounts(run) {
    const cases = [
        { name: 'rate ramp', points: [[0, 0], [1, 2]], expected: [1, 6, 11, 18] },
        { name: 'silent rate with burst', points: [[0, 0], [1, 0]], expected: [0, 2, 2, 2] },
    ];
    for (const { name, points, expected } of cases) {
        const effect = sanitizeParticleEffect({
            duration: 0.2, loop: false, rate: 80, rateOverCycle: { points }, bursts: [{ time: 0.1, count: 2 }],
            lifetime: [2, 2], speed: [0, 0], render: { blending: 'additive' },
        });
        const counts = await run(effect);
        if (!expected.every((count, frame) => counts[frame] === count)) {
            throw new Error(`${name} expected live counts ${expected}, read ${counts}`);
        }
    }
    return cases.map(test => test.name);
}

// The first frame spawns a single particle and the second advances it.
async function checkCases(run) {
    for (const test of cases) {
        const effect = sanitizeParticleEffect({
            rate: 0, speed: [0, 0], lifetime: [2, 2], shape: { kind: 'point' }, drag: 0, gravity: 0, turbulence: 0,
            forceFields: test.fields, render: { blending: 'additive' },
        });
        const matrix = new THREE.Matrix4().makeTranslation(...(test.origin ?? [0, 0, 0]));
        const velocity = await run(effect, test.at, matrix, [0, 0, 0], 'velocity');
        if (!test.expected.every((value, axis) => Math.abs(value - velocity[axis]) < 0.0001)) {
            throw new Error(`${test.name} expected velocity ${test.expected}, read ${velocity}`);
        }
    }
    // One step reaches 0.25 of the lifetime. The smooth curve through (0,0), (.5,1),
    // (1,0) has value .75 there; linear gives .5 and the held value is zero.
    const modes = [['linear', 0.025], ['smooth', 0.0375], ['step', 0]];
    for (const [interpolation, expected] of modes) {
        const effect = sanitizeParticleEffect({
            rate: 0, speed: [0, 0], shape: { kind: 'point' }, lifetime: [0.2, 0.2], gravity: 0, turbulence: 0, drag: 0,
            speedOverLife: { points: [[0, 0], [0.5, 1], [1, 0]], interpolation }, render: { blending: 'additive' },
        });
        const position = await run(effect, [0, 0, 0], new THREE.Matrix4(), [1, 0, 0], 'position');
        // Each renderer samples its 64-texel lifetime table; WebGL samples the nearest texel.
        if (!(Math.abs(position[0] - expected) < 0.001)) {
            throw new Error(`${interpolation} lifetime expected x≈${expected}, read ${position[0]}`);
        }
    }
    return [...cases.map(test => test.name), ...modes.map(([mode]) => `${mode} lifetime`), ...await checkCurl(run)];
}

async function checkWebGL() {
    const renderer = new THREE.WebGLRenderer();
    try {
        const forces = await checkCases((effect, at, matrix, velocity, attribute, warmup = 0) => {
            const system = new GpuParticleSystem(1);
            try {
                system.setEffect(effect);
                for (let i = 0; i < warmup; i++) system.step(renderer, stepSeconds, matrix, null);
                system.emitAt(1, ...at, ...velocity);
                system.step(renderer, stepSeconds, matrix, null);
                system.step(renderer, stepSeconds, matrix, null);
                renderer.setRenderTarget(system.targets[0]);
                const gl = renderer.getContext();
                const result = new Float32Array(4);
                gl.readBuffer(attribute === 'position' ? gl.COLOR_ATTACHMENT0 : gl.COLOR_ATTACHMENT1);
                gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, result);
                return Array.from(result.subarray(0, 3));
            } finally {
                renderer.setRenderTarget(null);
                system.dispose();
            }
        });
        const counts = await checkEmissionCounts(effect => {
            const system = new GpuParticleSystem(32);
            const gl = renderer.getContext();
            const cells = new Float32Array(system.width * system.height * 4);
            const matrix = new THREE.Matrix4();
            try {
                system.setEffect(effect);
                system.play();
                return Array.from({ length: 4 }, () => {
                    system.step(renderer, stepSeconds, matrix, null);
                    renderer.setRenderTarget(system.targets[0]);
                    gl.readBuffer(gl.COLOR_ATTACHMENT1);
                    gl.readPixels(0, 0, system.width, system.height, gl.RGBA, gl.FLOAT, cells);
                    renderer.setRenderTarget(null);
                    // The lifetime channel is positive only for spawned slots. No particle dies during this cycle.
                    let alive = 0;
                    for (let i = 3; i < cells.length; i += 4) if (cells[i] > 0) alive++;
                    return alive;
                });
            } finally {
                renderer.setRenderTarget(null);
                system.dispose();
            }
        });
        return [...forces, ...counts];
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
    function step(emitter, matrix) {
        frame.encoder = device.createCommandEncoder();
        emitter.step(stepSeconds, matrix);
        passes[0].execute(frame);
        device.queue.submit([frame.encoder.finish()]);
    }
    async function copyForReadback(source, size) {
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(source, 0, staging, 0, size);
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
    }
    try {
        device.pushErrorScope('validation');
        const result = await checkCases(async (effect, at, matrix, velocity, attribute, warmup = 0) => {
            const emitter = world.createEmitter(1);
            try {
                emitter.setEffect(effect);
                for (let i = 0; i < warmup; i++) step(emitter, matrix);
                emitter.emitAt(1, ...at, ...velocity);
                step(emitter, matrix);
                step(emitter, matrix);
                await copyForReadback(emitter.particles, PARTICLE_BYTES);
                const values = Array.from(new Float32Array(staging.getMappedRange(), attribute === 'position' ? 0 : 16, 3));
                staging.unmap();
                return values;
            } finally {
                emitter.dispose();
            }
        });
        const counts = await checkEmissionCounts(async effect => {
            const emitter = world.createEmitter(32);
            try {
                emitter.setEffect(effect);
                emitter.play();
                const counts = [];
                for (let frameNumber = 0; frameNumber < 4; frameNumber++) {
                    step(emitter, null);
                    await copyForReadback(emitter.counters, 4);
                    counts.push(new Uint32Array(staging.getMappedRange())[0]);
                    staging.unmap();
                }
                return counts;
            } finally {
                emitter.dispose();
            }
        });
        const error = await device.popErrorScope();
        if (error) throw new Error(error.message);
        return [...result, ...counts];
    } finally {
        world.dispose();
        device.destroy();
    }
}

window.checkParticleForces = backend => backend === 'webgpu' ? checkWebGPU() : checkWebGL();
