import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bundle = await build({
    stdin: { resolveDir: root, contents: `
        export { ParticleSimulation } from './runtime/particleSimulation';
        export { RUNTIME_PARTICLE_LIMIT, sanitizeParticleEffect } from './runtime/particleEffect';
    ` },
    bundle: true, write: false, format: 'esm', platform: 'node',
});
const { ParticleSimulation, RUNTIME_PARTICLE_LIMIT, sanitizeParticleEffect } = await import(
    'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64')
);

const warmup = 120;
const samples = 300;
const step = 1 / 120;
const fields = [
    { kind: 'radial', center: [0, 0, 0], strength: 1, falloff: 1 },
    { kind: 'vortex', center: [-1, 0, 0], strength: 0.8, falloff: 2 },
    { kind: 'directional', center: [0, -1, 0], strength: -0.4, falloff: 0 },
    { kind: 'radial', center: [1, 0, 0], strength: -0.5, falloff: 1.5 },
].map(field => ({ ...field, enabled: true, radius: 16, axis: [0, 1, 0] }));

// Identical initial particles for each case, no births or deaths while timed.
function makeSimulation(forceFields) {
    const effect = sanitizeParticleEffect({
        rate: 0, maxParticles: RUNTIME_PARTICLE_LIMIT, shape: { kind: 'sphere', radius: 2 },
        speed: [0.2, 0.8], lifetime: [60, 60], gravity: 0, turbulence: 0, drag: 0.2,
        forceFields,
    });
    let seed = 1;
    const simulation = new ParticleSimulation(effect, RUNTIME_PARTICLE_LIMIT, () => {
        seed = (seed * 16807) % 2147483647;
        return (seed - 1) / 2147483646;
    });
    simulation.emitAt(RUNTIME_PARTICLE_LIMIT, 0, 0, 0);
    return simulation;
}

const stacks = [
    ['none', []], ['radial', fields.slice(0, 1)], ['mixed', fields],
    ['curl', [{ ...fields[0], kind: 'curl', scale: 4, evolution: 0.55, seed: 19 }]],
];
const cases = stacks.map(([name, stack]) => ({ name, fields: stack.length, simulation: makeSimulation(stack), times: [] }));
for (let frame = 0; frame < warmup + samples; frame++) {
    // Rotate which case runs first to spread scheduler and clock-speed effects across cases.
    for (let i = 0; i < cases.length; i++) {
        const current = cases[(frame + i) % cases.length];
        const start = performance.now();
        current.simulation.step(step, null);
        const elapsed = performance.now() - start;
        if (frame >= warmup) current.times.push(elapsed);
    }
}

const rows = cases.map(({ name, fields, simulation, times }) => {
    if (simulation.count !== RUNTIME_PARTICLE_LIMIT) throw new Error('Particle count changed during measurement');
    times.sort((a, b) => a - b);
    const quantile = p => Number(times[Math.ceil(times.length * p) - 1].toFixed(3));
    return { name, fields, p50Ms: quantile(0.5), p95Ms: quantile(0.95) };
});
console.log(JSON.stringify({
    node: process.version, cpu: cpus()[0].model, particles: RUNTIME_PARTICLE_LIMIT, warmup, samples, step, rows,
}, null, 2));
