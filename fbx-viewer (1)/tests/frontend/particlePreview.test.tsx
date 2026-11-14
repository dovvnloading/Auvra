import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ParticlePreviewControls } from '../../components/Environment/ParticlePreviewControls';
import { sanitizeParticleEffect } from '../../runtime/particleEffect';
import { advanceParticlePreviewReplay, particlePreview, PARTICLE_PREVIEW_STEP } from '../../runtime/particlePreview';
import { ParticleSimulation } from '../../runtime/particleSimulation';
import { ComputeEmitter, type EmitterHome } from '../../renderer/gpu/particles/computeEmitter';
import type { GpuFrame } from '../../renderer/gpu/frame';

describe('particle system preview', () => {
    afterEach(() => vi.unstubAllGlobals());
    it('keeps the cued layer stopped past its replay delay while another one-shot layer previews normally', () => {
        const effect = sanitizeParticleEffect({ loop: false, duration: 0.2, rate: 0 });
        const held = new ParticleSimulation(effect, 1);
        const normal = new ParticleSimulation(effect, 1);
        held.stop();
        let heldIdle = 0, normalIdle = 0;
        for (let i = 0; i < 13; i++) {
            held.step(0.1, null);
            normal.step(0.1, null);
            heldIdle = advanceParticlePreviewReplay(held, heldIdle, 0.1, true);
            normalIdle = advanceParticlePreviewReplay(normal, normalIdle, 0.1, false);
        }
        expect(held.isEmitting).toBe(false);
        expect(normal.isEmitting).toBe(true);
        for (let i = 0; i < 12; i++) heldIdle = advanceParticlePreviewReplay(held, heldIdle, 0.1, false);
        expect(held.isEmitting).toBe(true);
    });
    it('pauses, steps and restarts every mounted layer and view of the selected object', () => {
        const restart = vi.fn();
        const layers = Array.from({ length: 4 }, () => particlePreview.attach('torch', restart));
        const other = particlePreview.attach('fountain', vi.fn());
        const ui = render(<ParticlePreviewControls objectId="torch" />);
        const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
        click('Pause');
        expect(layers.every(layer => layer.nextDelta(0.08) === null)).toBe(true);
        expect(other.nextDelta(0.08)).toBe(0.08);
        click('Step 1/60 s');
        click('Step 1/60 s');
        for (const layer of layers) {
            expect(layer.nextDelta(0.1)).toBe(PARTICLE_PREVIEW_STEP);
            expect(layer.nextDelta(0.001)).toBe(PARTICLE_PREVIEW_STEP);
            expect(layer.nextDelta(0.08)).toBeNull();
        }
        click('Play');
        expect(layers.every(layer => layer.nextDelta(0.03) === 0.03)).toBe(true);
        click('Step 1/60 s');
        click('Restart');
        expect(restart).toHaveBeenCalledTimes(4);
        expect(layers.every(layer => layer.nextDelta(0.03) === 0.03)).toBe(true);
        click('Pause');
        ui.unmount();
        const late = particlePreview.attach('torch', vi.fn());
        expect(late.nextDelta(0.1)).toBeNull();
        for (const layer of [...layers, late, other]) layer.release();
        expect(particlePreview.isPlaying('torch')).toBe(true);
    });

    it('starts a clean cycle at the current transform, retaining no old events, velocity or distance emission', () => {
        const simulation = new ParticleSimulation(sanitizeParticleEffect({
            shape: { kind: 'point' }, rate: 0, rateOverDistance: 4, bursts: [{ time: 0, count: 2 }],
            inheritVelocity: 1, speed: [0, 0], gravity: 0,
        }), 50);
        simulation.step(0.1, null);
        const moved = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1];
        simulation.step(0.1, moved);
        expect(simulation.count).toBe(22);
        simulation.events.push({ trigger: 'death', x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });
        simulation.restart();
        expect(simulation.count).toBe(0);
        expect(simulation.events).toEqual([]);
        simulation.step(PARTICLE_PREVIEW_STEP, null);
        expect(simulation.count).toBe(2);
        expect([...simulation.emitterVelocity]).toEqual([0, 0, 0]);
    });

    it('preserves a GPU sub-emitter batch across paused frames, consumes it once, and discards it on restart', () => {
        vi.stubGlobal('GPUBufferUsage', { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4, UNIFORM: 8, INDIRECT: 16 });
        const home = {
            device: {
                limits: { maxStorageBufferBindingSize: 64 * 1024 },
                createBuffer: () => ({ destroy() {} }), createBindGroup: () => ({}),
                queue: { writeBuffer() {} },
            },
            pipelines: { spawnEvents: {} }, stepTick: 1, forget() {},
        };
        const source = new ComputeEmitter(home as unknown as EmitterHome, 8);
        const target = new ComputeEmitter(home as unknown as EmitterHome, 8);
        const effect = sanitizeParticleEffect({ rate: 0 });
        source.setEffect(effect);
        target.setEffect(effect);
        source.setSubEmitters([{ trigger: 'death', target, count: 2, inheritVelocity: 0 }]);
        const frame = { scene: { fog: null }, mainViewOffset: 0 } as unknown as GpuFrame;
        const group = {} as GPUBindGroup;
        const calls = { setBindGroup() {}, setPipeline: vi.fn(), dispatchWorkgroups() {}, dispatchWorkgroupsIndirect() {} };
        const pass = calls as unknown as GPUComputePassEncoder;
        const begin = () => target.beginFrame(frame, false, false, group, () => {});
        source.encodeSimulate(pass, frame, group);
        home.stepTick = 120; // Another object continued simulating.
        expect(begin()).toBe(false); // No step requested for this paused emitter.
        target.step(PARTICLE_PREVIEW_STEP, null);
        expect(begin()).toBe(true);
        target.encodeSpawn(pass, frame, true);
        target.encodeSpawn(pass, frame, true);
        expect(calls.setPipeline.mock.calls.filter(([p]) => p === home.pipelines.spawnEvents)).toHaveLength(1);
        source.encodeSimulate(pass, frame, group);
        target.restart();
        target.step(PARTICLE_PREVIEW_STEP, null);
        expect(begin()).toBe(false);
        source.dispose();
        target.dispose();
    });
});
