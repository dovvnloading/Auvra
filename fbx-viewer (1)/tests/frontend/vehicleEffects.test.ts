import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createSkidTrail, extendSkidTrail, markIntensity, SKID_SPACING, SkidMarkBuffer } from '../../runtime/skidMarks';
import { SURFACES } from '../../runtime/surfaces';
import { buildVehicleLights, disposeVehicleLights, lampKind, setVehicleLights } from '../../runtime/components/vehicleLights';
import { createTyreEffects, stepTyreEffects } from '../../runtime/components/tyreEffects';
import { engineSoundValues, roadSoundValues } from '../../runtime/components/vehicleAudio';
import { planVehicleLayout, vehicleFrame, type VehicleTelemetry, type WheelTelemetry } from '../../runtime/vehicles';
import { nextVehicleView, vehicleShake, VEHICLE_VIEWS } from '../../runtime/VehicleCamera';
import type { SurfaceKind } from '../../runtime/surfaces';

const wheel = (overrides: Partial<WheelTelemetry> = {}): WheelTelemetry => ({
  front: false, left: true, contact: true, surface: 'asphalt', load: 3000, slipRatio: 0, slipAngle: 0, omega: 0, compression: 0.08,
  contactPoint: new THREE.Vector3(), contactNormal: new THREE.Vector3(0, 1, 0), groundSpeed: 10, ...overrides,
});

const telemetry = (wheels: WheelTelemetry[], speed = 10): VehicleTelemetry => ({
  speed, rpm: 3000, idleRpm: 850, redlineRpm: 6800, gear: 2, shifting: 0, throttle: 0.5, brake: 0, handbrake: false, steer: 0,
  absActive: false, tractionActive: false, stabilityActive: false, impact: 0, wheels,
});

describe('tyre marks', () => {
  it('marks a road only where a tyre slides or spins, and loose ground wherever it rolls', () => {
    expect(markIntensity(wheel(), SURFACES.asphalt)).toBe(0);
    expect(markIntensity(wheel({ slipAngle: 0.5 }), SURFACES.asphalt)).toBeGreaterThan(0.5);
    expect(markIntensity(wheel({ slipRatio: 1 }), SURFACES.asphalt)).toBe(1);
    expect(markIntensity(wheel(), SURFACES.dirt)).toBeGreaterThan(0);
    expect(markIntensity(wheel({ contact: false, slipRatio: 1 }), SURFACES.asphalt)).toBe(0);
    // Water leaves no marks.
    expect(markIntensity(wheel({ slipRatio: 1 }), SURFACES.water)).toBe(0);
  });

  it('lays a quad each spacing along a trail, ends it when the tyre grips again, and overwrites the oldest', () => {
    const buffer = new SkidMarkBuffer(4);
    const trail = createSkidTrail();
    const up = new THREE.Vector3(0, 1, 0);
    const at = (z: number) => new THREE.Vector3(0, 0, z);
    expect(extendSkidTrail(buffer, trail, at(0), up, 0.1, 1, 'asphalt')).toBe(false);
    expect(extendSkidTrail(buffer, trail, at(SKID_SPACING / 2), up, 0.1, 1, 'asphalt')).toBe(false);
    expect(extendSkidTrail(buffer, trail, at(SKID_SPACING * 1.5), up, 0.1, 1, 'asphalt')).toBe(true);
    expect(buffer.count).toBe(1);
    // The quad is the tyre's width, lifted off the ground.
    const xs = [0, 1, 2, 3].map(i => buffer.positions[i * 3]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.2, 6);
    expect(buffer.positions[1]).toBeGreaterThan(0);
    // Gripping again ends the trail; the next mark starts a new one rather than bridging the gap.
    extendSkidTrail(buffer, trail, at(1), up, 0.1, 0, 'asphalt');
    expect(trail.active).toBe(false);
    expect(extendSkidTrail(buffer, trail, at(3), up, 0.1, 1, 'asphalt')).toBe(false);
    for (let z = 3.5; z < 6; z += 0.5) extendSkidTrail(buffer, trail, at(z), up, 0.1, 1, 'asphalt');
    expect(buffer.count).toBe(4);
    // Six quads in a ring of four: the next to write is the third.
    expect(buffer.next).toBe(2);
  });
});

describe('vehicle lights', () => {
  it('reads lamps from node names', () => {
    expect(lampKind('HeadLight_L')).toBe('head');
    expect(lampKind('headlamp.001')).toBe('head');
    expect(lampKind('Tail_Light_R')).toBe('tail');
    expect(lampKind('BrakeLight')).toBe('brake');
    expect(lampKind('reverse light')).toBe('reverse');
    expect(lampKind('Body')).toBeNull();
  });

  it("lights the model's own lamps (copies of their materials) and the beams, and gives the materials back", () => {
    const host = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({ name: 'Paint' });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1, 4).translate(0, 0.8, 0), paint);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.05).translate(0.6, 0.7, 2), paint);
    head.name = 'HeadLight_L';
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.05).translate(0.6, 0.8, -2), paint);
    tail.name = 'TailLight_L';
    host.add(body, head, tail);
    host.updateMatrixWorld(true);
    const layout = planVehicleLayout(host);
    const lights = buildVehicleLights(host, layout, vehicleFrame(host, layout.facing), () => false, true);
    expect(lights.lamps.map(lamp => lamp.kind).sort()).toEqual(['head', 'tail']);
    expect(lights.beams).toHaveLength(2);
    // Lamps got their own materials: the body's paint is untouched.
    expect(head.material).not.toBe(paint);
    setVehicleLights(lights, { head: true, brake: false, reverse: false });
    expect((head.material as THREE.MeshStandardMaterial).emissiveIntensity).toBeGreaterThan(0);
    expect(lights.beams.every(beam => beam.intensity > 0)).toBe(true);
    const dim = (tail.material as THREE.MeshStandardMaterial).emissiveIntensity;
    setVehicleLights(lights, { head: true, brake: true, reverse: false });
    expect((tail.material as THREE.MeshStandardMaterial).emissiveIntensity).toBeGreaterThan(dim);
    expect(paint.emissiveIntensity).toBe(1);
    expect(paint.emissive.getHex()).toBe(0);
    setVehicleLights(lights, { head: false, brake: false, reverse: false });
    expect(lights.beams.every(beam => beam.intensity === 0)).toBe(true);
    disposeVehicleLights(lights);
    expect(head.material).toBe(paint);
    expect(host.children.some(child => child.name === 'VehicleLights')).toBe(false);
  });
});

describe('tyre smoke and dust', () => {
  it('smokes a sliding tyre on a road, throws dust from one rolling on dirt, and neither from one rolling on a road', () => {
    const effects = createTyreEffects();
    const velocity = new THREE.Vector3(0, 0, 10);
    const run = (surface: SurfaceKind, overrides: Partial<WheelTelemetry>) => {
      effects.smoke.pool.count = 0;
      effects.dust.pool.count = 0;
      for (let i = 0; i < 30; i++) stepTyreEffects(effects, telemetry([wheel({ surface, ...overrides })]), [0.1], velocity, 1 / 60, 800);
      return { smoke: effects.smoke.pool.count, dust: effects.dust.pool.count };
    };
    expect(run('asphalt', {})).toEqual({ smoke: 0, dust: 0 });
    const sliding = run('asphalt', { slipAngle: 0.6 });
    expect(sliding.smoke).toBeGreaterThan(10);
    expect(sliding.dust).toBe(0);
    const dirt = run('dirt', {});
    expect(dirt.dust).toBeGreaterThan(5);
    expect(dirt.smoke).toBe(0);
    // The dust takes the ground's colour.
    expect(effects.dust.look.colorStart).toBe(SURFACES.dirt.kickColor);
    effects.dispose();
  });
});

describe('vehicle sound', () => {
  it('pitches the engine with its revs, opens it up with load, and cuts it through a gear change', () => {
    const out = new Float64Array(5);
    engineSoundValues(out, 3000, 0.4, 1, false, true, 1);
    const [firing, , , tone, level] = out;
    expect(firing).toBe(100);
    engineSoundValues(out, 3000, 0.4, 0, false, true, 1);
    expect(out[3]).toBeLessThan(tone);
    expect(out[4]).toBeLessThan(level);
    engineSoundValues(out, 3000, 0.4, 1, true, true, 1);
    expect(out[4]).toBeLessThan(level);
    expect(engineSoundValues(out, 3000, 0.4, 1, false, false, 1)[4]).toBe(0);
  });

  it('squeals sliding on a road, rumbles on loose ground, and roars with wind at speed', () => {
    const out = new Float64Array(5);
    roadSoundValues(out, telemetry([wheel()], 10), 1);
    const quietSqueal = out[1];
    const roadRumble = out[3];
    roadSoundValues(out, telemetry([wheel({ slipAngle: 0.6 })], 10), 1);
    expect(out[1]).toBeGreaterThan(quietSqueal);
    roadSoundValues(out, telemetry([wheel({ surface: 'gravel' })], 10), 1);
    expect(out[1]).toBe(0);
    expect(out[3]).toBeGreaterThan(roadRumble);
    const slowWind = roadSoundValues(out, telemetry([wheel()], 5), 1)[4];
    expect(roadSoundValues(out, telemetry([wheel()], 40), 1)[4]).toBeGreaterThan(slowWind);
  });
});

describe('vehicle camera', () => {
  it('cycles chase, far, bonnet and bumper views', () => {
    expect(VEHICLE_VIEWS.map(view => nextVehicleView(view))).toEqual(['far', 'hood', 'bumper', 'chase']);
  });

  it('shakes more at speed, more on loose ground, and hard after a knock', () => {
    const shake = (wheels: WheelTelemetry[], speed: number, impact = 0) => vehicleShake({ telemetry: () => ({ ...telemetry(wheels, speed), impact }) });
    expect(shake([wheel()], 0)).toBe(0);
    expect(shake([wheel()], 40)).toBeGreaterThan(shake([wheel()], 10));
    expect(shake([wheel({ surface: 'gravel' })], 10)).toBeGreaterThan(shake([wheel()], 10));
    expect(shake([wheel()], 10, 0.8)).toBeGreaterThan(0.8);
    expect(vehicleShake({ telemetry: () => null })).toBe(0);
  });
});
