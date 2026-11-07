import * as THREE from "three";
import type { ParticleEffect } from "../../../runtime/particleEffect";
import type { ParticleWorld } from "./particleWorld";

/**
 * EFFECTS THAT BURST ON DEMAND
 *
 * Hits, explosions and tyre smoke hold a simulation and something to draw it, and only ever burst particles at points.
 * On the WebGPU renderer both are one compute emitter behind the same few methods, so that those effects read the same
 * on either renderer.
 */

export interface BurstSimulation {
  readonly count: number;
  readonly events: unknown[];
  emitAt(count: number, x: number, y: number, z: number, vx?: number, vy?: number, vz?: number): void;
  step(dt: number, matrix: ArrayLike<number> | null, raycast?: unknown): void;
  setEffect(effect: ParticleEffect): void;
  stop(clear?: boolean): void;
}

export interface BurstRenderer {
  readonly object: THREE.Object3D;
  update(simulation: unknown, emitter: THREE.Matrix4, camera: THREE.Camera): void;
  dispose(): void;
}

export const computeBurstParts = (
  world: ParticleWorld,
  effect: ParticleEffect,
  capacity: number,
  texture: THREE.Texture,
  grid: [number, number],
): { simulation: BurstSimulation; renderer: BurstRenderer } => {
  const emitter = world.createEmitter(capacity);
  emitter.setEffect(effect);
  emitter.setLook(effect, texture, grid);
  emitter.stop();
  return {
    simulation: {
      get count() { return emitter.count; },
      events: [],
      emitAt: (count, x, y, z, vx = 0, vy = 0, vz = 0) => emitter.emitAt(count, x, y, z, vx, vy, vz),
      step: (dt) => emitter.step(dt, null, null),
      setEffect: (next) => emitter.setEffect(next),
      stop: (clear) => emitter.stop(clear),
    },
    renderer: {
      object: new THREE.Group(),
      update: () => undefined,
      dispose: () => emitter.dispose(),
    },
  };
};
