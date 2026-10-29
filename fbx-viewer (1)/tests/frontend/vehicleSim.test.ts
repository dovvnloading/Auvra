import { describe, expect, it } from 'vitest';
import {
  absBrake,
  ABS_SLIP,
  createTransmission,
  driveTorque,
  engineTorque,
  LATERAL_CURVE,
  LONGITUDINAL_CURVE,
  magicFormula,
  overallRatio,
  PEAK_SLIP_ANGLE,
  PEAK_SLIP_RATIO,
  planEngine,
  planGearbox,
  planSuspension,
  slipAngle,
  slipRatio,
  splitAxleTorque,
  stabilityCorrection,
  stepTransmission,
  stepWheel,
  suspensionForce,
  torqueShare,
  createTractionControl,
  stepTractionControl,
  tyreForce,
  tyreGrip,
  wheelInertia,
  type WheelContact,
  type WheelDynamics,
} from '../../runtime/vehicleSim';

const G = 9.81;

describe('tyres', () => {
  it('peak near 12% slip and 10 degrees, holding about two thirds of the grip once locked', () => {
    expect(PEAK_SLIP_RATIO).toBeGreaterThan(0.08);
    expect(PEAK_SLIP_RATIO).toBeLessThan(0.16);
    expect(PEAK_SLIP_ANGLE).toBeGreaterThan(0.13);
    expect(PEAK_SLIP_ANGLE).toBeLessThan(0.22);
    expect(magicFormula(PEAK_SLIP_RATIO, LONGITUDINAL_CURVE)).toBeCloseTo(1, 3);
    const locked = magicFormula(1, LONGITUDINAL_CURVE);
    expect(locked).toBeGreaterThan(0.55);
    expect(locked).toBeLessThan(0.8);
    expect(magicFormula(0.6, LATERAL_CURVE)).toBeGreaterThan(0.8);
  });

  it('share one friction circle between driving and cornering, always against the slide', () => {
    const grip = tyreGrip(4000, 1.2, 4000);
    expect(tyreForce(PEAK_SLIP_RATIO, 0, 4000, 1.2, 4000).fx).toBeCloseTo(grip, 1);
    expect(tyreForce(0, PEAK_SLIP_ANGLE, 4000, 1.2, 4000).fy).toBeCloseTo(-grip * magicFormula(PEAK_SLIP_ANGLE, LATERAL_CURVE), 1);
    for (const [kappa, alpha] of [[0.05, 0.05], [0.2, 0.3], [-0.5, -0.4], [1, 0.1], [-1, 0.8]]) {
      const force = tyreForce(kappa, alpha, 4000, 1.2, 4000);
      expect(Math.hypot(force.fx, force.fy)).toBeLessThanOrEqual(grip * 1.0001);
      expect(Math.sign(force.fx)).toBe(Math.sign(kappa));
      expect(Math.sign(force.fy)).toBe(-Math.sign(alpha));
    }
    // Braking at the peak leaves little for cornering.
    expect(Math.abs(tyreForce(-PEAK_SLIP_RATIO, 0.05, 4000, 1.2, 4000).fy)).toBeLessThan(Math.abs(tyreForce(0, 0.05, 4000, 1.2, 4000).fy));
    expect(tyreForce(0.1, 0.1, 0, 1.2, 4000)).toEqual({ fx: 0, fy: 0 });
  });

  it('grip a little less per newton as the load rises', () => {
    expect(tyreGrip(8000, 1, 4000) / 8000).toBeLessThan(tyreGrip(4000, 1, 4000) / 4000);
    expect(tyreGrip(2000, 1, 4000) / 2000).toBeGreaterThan(1);
  });

  it('measure slip against a floor at low speed', () => {
    expect(slipRatio(10, 10)).toBe(0);
    expect(slipRatio(0, 10)).toBe(-1);
    expect(Number.isFinite(slipRatio(1, 0))).toBe(true);
    expect(slipAngle(0, 0)).toBe(0);
    expect(slipAngle(10, 10)).toBeCloseTo(Math.PI / 4, 9);
  });
});

describe('engine and gearbox', () => {
  it('peaks at the asked-for power, brakes with the throttle shut and cuts at the redline', () => {
    const engine = planEngine(150);
    let peak = 0;
    for (let rpm = engine.idleRpm; rpm <= engine.redlineRpm; rpm += 10) {
      peak = Math.max(peak, engineTorque(engine, rpm, 1) * (rpm * 2 * Math.PI) / 60);
    }
    expect(peak / 1000).toBeCloseTo(150, 0);
    expect(engineTorque(engine, 5000, 0)).toBeLessThan(0);
    expect(engineTorque(engine, engine.redlineRpm + 10, 1)).toBe(0);
    expect(torqueShare(0.55 * engine.redlineRpm, engine.redlineRpm)).toBeCloseTo(1, 6);
  });

  it('reaches the top speed at the redline in top gear, from a first gear about four times lower', () => {
    const box = planGearbox(50, 0.34, 6800, 6);
    expect(box.ratios).toHaveLength(6);
    expect(box.ratios.every((ratio, i) => i === 0 || ratio < box.ratios[i - 1])).toBe(true);
    expect(box.ratios[0] / box.ratios[5]).toBeCloseTo(4, 6);
    const topOmega = (6800 * 2 * Math.PI / 60) / overallRatio(box, 6);
    expect(topOmega * 0.34).toBeCloseTo(50 * 1.04, 3);
    expect(overallRatio(box, -1)).toBeLessThan(0);
    expect(overallRatio(box, 0)).toBe(0);
  });

  it('shifts up near the redline and down as the revs fall, cutting the drive while it shifts', () => {
    const engine = planEngine(120);
    const box = planGearbox(44, 0.34, engine.redlineRpm, 6);
    const state = createTransmission();
    const omegaAt = (rpm: number, gear: number) => (rpm * 2 * Math.PI / 60) / overallRatio(box, gear);
    stepTransmission(state, box, engine, omegaAt(6500, 1), 1, false, 1 / 60);
    expect(state.shifting).toBeGreaterThan(0);
    expect(state.target).toBe(2);
    expect(driveTorque(engine, box, state, omegaAt(6500, 1), 1).wheelTorque).toBe(0);
    for (let i = 0; i < 30; i++) stepTransmission(state, box, engine, omegaAt(4500, 2), 1, false, 1 / 60);
    expect(state.gear).toBe(2);
    // Held a moment before the next change.
    stepTransmission(state, box, engine, omegaAt(1500, 2), 0, false, 1 / 60);
    expect(state.shifting).toBe(0);
    for (let i = 0; i < 60; i++) stepTransmission(state, box, engine, omegaAt(1500, 2), 0, false, 1 / 60);
    expect(state.target).toBe(1);
    const reversing = createTransmission();
    stepTransmission(reversing, box, engine, 0, 1, true, 1 / 60);
    expect(reversing.target).toBe(-1);
  });

  it('slips the clutch on a launch and brakes on the engine with the throttle shut', () => {
    const engine = planEngine(120);
    const box = planGearbox(44, 0.34, engine.redlineRpm, 6);
    const launch = driveTorque(engine, box, createTransmission(), 0, 1);
    expect(launch.clutchSlip).toBe(true);
    expect(launch.rpm).toBeGreaterThan(engine.idleRpm);
    expect(launch.wheelTorque).toBeGreaterThan(0);
    const cruising = createTransmission();
    cruising.gear = 3;
    cruising.target = 3;
    const omega = (5000 * 2 * Math.PI / 60) / overallRatio(box, 3);
    const coast = driveTorque(engine, box, cruising, omega, 0);
    expect(coast.clutchSlip).toBe(false);
    expect(coast.rpm).toBeCloseTo(5000, 3);
    expect(coast.wheelTorque).toBeLessThan(0);
  });
});

describe('differential', () => {
  it('splits evenly when open, leans to the slower wheel when limited, holds them together when locked', () => {
    expect(splitAxleTorque(1000, 10, 30, 'open')).toEqual([500, 500]);
    const [slowLimited, fastLimited] = splitAxleTorque(1000, 10, 30, 'limited');
    expect(slowLimited).toBeGreaterThan(fastLimited);
    expect(slowLimited + fastLimited).toBeCloseTo(1000, 9);
    expect(slowLimited).toBeLessThanOrEqual(500 + 1000 * 0.35 + 1e-9);
    const [slowLocked, fastLocked] = splitAxleTorque(1000, 10, 30, 'locked');
    expect(slowLocked - fastLocked).toBeGreaterThan(slowLimited - fastLimited);
  });
});

describe('wheels', () => {
  const contact = (longitudinal: number, load = 3000, mu = 1.2): WheelContact => ({ longitudinal, lateral: 0, load, mu, nominalLoad: 3000 });
  const wheel = (omega = 0): WheelDynamics => ({ omega, radius: 0.34, inertia: wheelInertia(0.34) });

  it('rolls up to the ground speed without ringing', () => {
    const w = wheel(0);
    const slips: number[] = [];
    for (let i = 0; i < 60; i++) slips.push(stepWheel(w, contact(20), 0, 0, 1 / 60, 4).slipRatio);
    expect(Math.abs(slips[slips.length - 1])).toBeLessThan(0.01);
    // Settles from below without overshooting into spin.
    expect(slips.every(slip => slip <= 0.02)).toBe(true);
  });

  it('locks under a hard brake and stays locked, never spinning backwards', () => {
    const w = wheel(20 / 0.34);
    let result = stepWheel(w, contact(20), 0, 5000, 1 / 60, 4);
    for (let i = 0; i < 30; i++) result = stepWheel(w, contact(20), 0, 5000, 1 / 60, 4);
    expect(w.omega).toBe(0);
    expect(result.slipRatio).toBe(-1);
    expect(result.fx).toBeLessThan(0);
  });

  it('spins up past the tyre under more torque than it can put down, and stays still at rest', () => {
    const spinning = wheel(0);
    const result = (() => { let r = stepWheel(spinning, contact(0), 4000, 0, 1 / 60, 4); for (let i = 0; i < 20; i++) r = stepWheel(spinning, contact(0), 4000, 0, 1 / 60, 4); return r; })();
    expect(result.slipRatio).toBeGreaterThan(0.5);
    expect(result.fx).toBeGreaterThan(0);
    const still = wheel(0);
    for (let i = 0; i < 60; i++) stepWheel(still, contact(0), 0, 0, 1 / 60, 4);
    expect(still.omega).toBe(0);
  });

  it('has no grip in the air', () => {
    const w = wheel(10);
    const result = stepWheel(w, null, 200, 0, 1 / 60, 4);
    expect(result.fx).toBe(0);
    expect(w.omega).toBeGreaterThan(10);
  });
});

describe('suspension and assists', () => {
  it('pushes with its spring and damper, hard at the bump stop, never pulling', () => {
    const spec = planSuspension(1200, 4, 30, 0.45, 0.3);
    expect(spec.stiffness).toBe(36000);
    expect(spec.reboundDamping).toBeGreaterThan(spec.compressionDamping);
    // Sag at rest: the spring holds a quarter of the weight.
    expect(suspensionForce(spec, G / (4 * 30), 0)).toBeCloseTo(1200 * G / 4, 6);
    expect(suspensionForce(spec, 0.29, 0)).toBeGreaterThan(spec.stiffness * 0.29 * 2);
    expect(suspensionForce(spec, 0.01, -5)).toBe(0);
  });

  it('lets a locking brake off, trims a spinning throttle, and brakes one wheel against a slide', () => {
    expect(absBrake(1000, ABS_SLIP - 0.1, 20)).toBe(250);
    expect(absBrake(1000, -0.05, 20)).toBe(1000);
    expect(absBrake(1000, -1, 1)).toBe(1000);
    const tcs = createTractionControl();
    expect(stepTractionControl(tcs, 1, 0.05, 1 / 60)).toBe(1);
    // A flaring wheel is cut hard and fast, never to nothing...
    expect(stepTractionControl(tcs, 1, 1.5, 1 / 60)).toBeLessThan(0.2);
    for (let i = 0; i < 30; i++) stepTractionControl(tcs, 1, 3, 1 / 60);
    expect(stepTractionControl(tcs, 1, 3, 1 / 60)).toBeGreaterThan(0);
    // ...and the throttle comes back gradually once it grips.
    expect(stepTractionControl(tcs, 1, 0, 1 / 60)).toBeLessThan(0.1);
    for (let i = 0; i < 120; i++) stepTractionControl(tcs, 1, 0, 1 / 60);
    expect(stepTractionControl(tcs, 1, 0, 1 / 60)).toBe(1);
    expect(stabilityCorrection(0, 20, 2.6, 0, 1.2).wheel).toBeNull();
    // Steering right (yaw should be negative) while spinning hard to the right: oversteer, the outer (left) front braked and the throttle trimmed.
    const spinning = stabilityCorrection(0.1, 20, 2.6, -2, 1.2);
    expect(spinning.wheel).toEqual({ front: true, left: true });
    expect(spinning.throttle).toBeLessThan(1);
    // Steering hard right while barely turning: understeer, the inner (right) rear braked.
    expect(stabilityCorrection(0.3, 20, 2.6, -0.2, 1.2)).toMatchObject({ wheel: { front: false, left: false }, throttle: 1 });
    // At speed the tyres cannot hold the yaw full lock asks for: turning as hard as they can is not understeer...
    const limit = (0.9 * 1.2 * G) / 30;
    expect(stabilityCorrection(0.3, 30, 2.6, -limit, 1.2).wheel).toBeNull();
    // ...and turning harder than that is oversteer, even though the steering asks for more.
    expect(stabilityCorrection(0.3, 30, 2.6, -1, 1.2).wheel).toEqual({ front: true, left: true });
    // Countersteering a slide to the right still brakes the left front.
    expect(stabilityCorrection(-0.1, 30, 2.6, -1, 1.2).wheel).toEqual({ front: true, left: true });
  });
});

describe('a car down a straight road', () => {
  /** A 1200 kg rear-drive car on four wheels, longitudinal only: launch, top speed, then a stop on brakes stronger than the tyres. */
  const run = (abs: boolean) => {
    const mass = 1200;
    const engine = planEngine(120);
    const box = planGearbox(160 / 3.6, 0.34, engine.redlineRpm, 6);
    const transmission = createTransmission();
    const tcs = createTractionControl();
    const wheels = [0, 1, 2, 3].map(() => wheel());
    const load = (mass * G) / 4;
    let v = 0;
    let t = 0;
    let to100: number | null = null;
    let launchSpin = 0;
    const dt = 1 / 60;
    const step = (pedal: number, brake: number) => {
      const driven = (wheels[2].omega + wheels[3].omega) / 2;
      const spin = Math.max(slipRatio(wheels[2].omega * 0.34, v), slipRatio(wheels[3].omega * 0.34, v));
      const throttle = stepTractionControl(tcs, pedal, spin, dt);
      if (t > 0.3 && t < 4) launchSpin = Math.max(launchSpin, spin);
      stepTransmission(transmission, box, engine, v / 0.34, throttle, false, dt);
      const drive = driveTorque(engine, box, transmission, driven, throttle);
      const [left, right] = splitAxleTorque(drive.wheelTorque, wheels[2].omega, wheels[3].omega, 'limited');
      let force = 0;
      wheels.forEach((w, i) => {
        const slip = slipRatio(w.omega * w.radius, v);
        const pedal = abs ? absBrake(brake * (i < 2 ? 0.6 : 0.4) * mass * 25 * 0.34 / 2, slip, v) : brake * (i < 2 ? 0.6 : 0.4) * mass * 25 * 0.34 / 2;
        force += stepWheel(w, { longitudinal: v, lateral: 0, load, mu: 1.6, nominalLoad: load }, i === 2 ? left : i === 3 ? right : 0, pedal, dt, 4).fx;
      });
      force -= 0.4 * v * Math.abs(v);
      v += (force / mass) * dt;
      t += dt;
    };
    function wheel(): WheelDynamics { return { omega: 0, radius: 0.34, inertia: wheelInertia(0.34) }; }
    while (t < 40) {
      step(1, 0);
      if (to100 === null && v >= 100 / 3.6) to100 = t;
    }
    const top = v;
    let distance = 0;
    const brakeFrom = 100 / 3.6;
    // Coast down to 100 km/h, then stop.
    while (v > brakeFrom) step(0, 1);
    while (v > 0.1 && distance < 200) {
      step(0, 1);
      distance += v * dt;
    }
    return { to100, top: top * 3.6, stop: distance, launchSpin };
  };

  it('launches, holds its top speed, and stops in a road-car distance, shorter with ABS', () => {
    const withAbs = run(true);
    const without = run(false);
    expect(withAbs.to100).not.toBeNull();
    expect(withAbs.to100!).toBeGreaterThan(3.5);
    expect(withAbs.to100!).toBeLessThan(9);
    expect(withAbs.top).toBeGreaterThan(150);
    expect(withAbs.top).toBeLessThan(172);
    expect(withAbs.stop).toBeGreaterThan(20);
    expect(withAbs.stop).toBeLessThan(50);
    expect(withAbs.stop).toBeLessThan(without.stop);
    // Traction control holds the driven wheels near their best slip off the line.
    expect(withAbs.launchSpin).toBeLessThan(0.3);
  });
});
