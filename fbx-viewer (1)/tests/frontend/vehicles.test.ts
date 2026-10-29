import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  ackermannAngles,
  AI_BACK_OUT_TIME,
  AI_BLOCKED_TIME,
  AI_STOP_GAP,
  AI_STUCK_TIME,
  avoidAhead,
  canStepOut,
  createAiRecovery,
  createControlState,
  createVehicleSession,
  driveAlongPath,
  findWheelNodes,
  GRAVITY,
  isWheelName,
  KMH,
  planVehicleLayout,
  readVehicleSettings,
  restingSag,
  obstacleSpeedLimit,
  RIGHT_AFTER,
  stepAiRecovery,
  stepOutOfVehicle,
  stepUpright,
  stepVehicleControls,
  uprightRotation,
  trackProgress,
  VEHICLE_DEFAULTS,
  VEHICLE_SHELL_MASS_SHARE,
  vehicleFrame,
  wheelGeometry,
  wheelNameTags,
  type DrivePath,
  type VehicleHandle,
} from '../../runtime/vehicles';
import { planPhysicsBody } from '../../runtime/components/physicsComponents';
import { flowNodeOutputValue, type FlowNode } from '../../hooks/levelBlueprintNodes/flow';
import { WORLD_NODE_DEFINITIONS, WORLD_NODE_EXECUTORS, type WorldNodeServices, type WorldNodeType } from '../../hooks/levelBlueprintNodes/world';
import { createLevelVariablesStore } from '../../runtime/levelVariables';
import { parseScriptCommand, scriptVehicleStates } from '../../runtime/scripting/ScriptRuntime';
import type { LevelObject } from '../../types';

const settings = (overrides: Partial<typeof VEHICLE_DEFAULTS> = {}) => ({ ...VEHICLE_DEFAULTS, ...overrides });
const DT = 1 / 60;

describe('vehicle settings', () => {
  it('reads props with defaults, and clamps or ignores bad values', () => {
    expect(readVehicleSettings({ props: {} })).toEqual(VEHICLE_DEFAULTS);
    const read = readVehicleSettings({ props: { mass: -5, drive: 'tank', grip: 1e6, aiPath: 7, playerCanDrive: false, maxSpeed: Number.NaN } });
    expect(read.mass).toBe(1);
    expect(read.drive).toBe('rear');
    expect(read.grip).toBe(20);
    expect(read.aiPath).toBe('');
    expect(read.playerCanDrive).toBe(false);
    expect(read.maxSpeed).toBe(VEHICLE_DEFAULTS.maxSpeed);
  });
});

describe('driver controls', () => {
  const NONE = { throttle: 0, brake: 0, steer: 0, handbrake: false };

  it('drives forward on throttle, brakes on the pedal while rolling, and reverses only from a stop', () => {
    const s = settings();
    const state = createControlState();
    const forward = stepVehicleControls(state, { ...NONE, throttle: 1 }, 0, DT, s);
    expect(forward).toMatchObject({ throttle: 1, brake: 0, reverse: false });

    const braking = stepVehicleControls(state, { ...NONE, brake: 1 }, 15, DT, s);
    expect(braking).toMatchObject({ throttle: 0, brake: 1, reverse: false });

    // Stopped with the pedal held: reverse, the pedal now the throttle.
    const reverse = stepVehicleControls(state, { ...NONE, brake: 1 }, 0.2, DT, s);
    expect(reverse).toMatchObject({ throttle: 1, brake: 0, reverse: true });
    // No faster backwards than the reverse speed.
    expect(stepVehicleControls(state, { ...NONE, brake: 1 }, -s.reverseSpeed * KMH - 0.1, DT, s).throttle).toBe(0);

    // Rolling backwards, throttle brakes first; once stopped it drives forward.
    expect(stepVehicleControls(state, { ...NONE, throttle: 1 }, -3, DT, s)).toMatchObject({ throttle: 0, brake: 1, reverse: true });
    expect(stepVehicleControls(state, { ...NONE, throttle: 1 }, 0.1, DT, s)).toMatchObject({ throttle: 1, reverse: false });
  });

  it('clamps the pedals and passes the handbrake through', () => {
    const pedals = stepVehicleControls(createControlState(), { throttle: 4, brake: -2, steer: 0, handbrake: true }, 10, DT, settings());
    expect(pedals).toMatchObject({ throttle: 1, brake: 0, handbrake: true });
  });

  it('eases the steering towards the lock, with less lock at speed', () => {
    const s = settings();
    const lock = THREE.MathUtils.degToRad(s.steerAngle);
    const state = createControlState();
    const first = stepVehicleControls(state, { ...NONE, steer: 1 }, 0, DT, s);
    expect(first.steer).toBeGreaterThan(0);
    expect(first.steer).toBeLessThan(lock);
    for (let i = 0; i < 120; i++) stepVehicleControls(state, { ...NONE, steer: 1 }, 0, DT, s);
    expect(state.steer).toBeCloseTo(lock, 6);

    const fast = createControlState();
    for (let i = 0; i < 120; i++) stepVehicleControls(fast, { ...NONE, steer: 1 }, s.maxSpeed * KMH, DT, s);
    expect(fast.steer).toBeCloseTo(lock * s.steerAtSpeed, 6);
  });

  it('turns the inner front wheel more than the outer one (Ackermann)', () => {
    const right = ackermannAngles(0.4, 2.6, 1.6);
    expect(right.right).toBeGreaterThan(right.left);
    expect(right.left).toBeGreaterThan(0);
    const left = ackermannAngles(-0.4, 2.6, 1.6);
    expect(left.left).toBeLessThan(left.right);
    expect(left.left).toBeCloseTo(-right.right, 9);
    expect(ackermannAngles(0, 2.6, 1.6)).toEqual({ left: 0, right: 0 });
  });
});

describe('wheels', () => {
  it('tells road wheels from steering wheels, spares and arches by name', () => {
    for (const name of ['Wheel_FL', 'wheelFR', 'FrontLeftTire', 'rim_rr', 'Tyre.003', 'WHEEL_LB', 'hubcap_fl']) expect(isWheelName(name)).toBe(true);
    for (const name of ['SteeringWheel', 'Steering_Wheel', 'SpareTire', 'WheelArch_FL', 'mudflap', 'Body', 'Primary']) expect(isWheelName(name)).toBe(false);
  });

  const wheelMesh = (name: string, x: number, y: number, z: number, radius = 0.35, width = 0.25) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 16).rotateZ(Math.PI / 2), new THREE.MeshBasicMaterial());
    mesh.name = name;
    mesh.position.set(x, y, z);
    return mesh;
  };

  const car = () => {
    const host = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.7, 4.2), new THREE.MeshBasicMaterial());
    body.name = 'Body';
    body.position.set(0, 0.65, 0);
    host.add(body);
    const wheels = new THREE.Group();
    wheels.name = 'Wheels';
    wheels.add(wheelMesh('Wheel_FL', 0.8, 0.35, 1.35), wheelMesh('Wheel_FR', -0.8, 0.35, 1.35), wheelMesh('Wheel_RL', 0.8, 0.35, -1.35), wheelMesh('Wheel_RR', -0.8, 0.35, -1.35));
    host.add(wheels);
    // A rim sharing the front-left tyre's centre is part of the same wheel.
    host.add(wheelMesh('Rim_FL', 0.8, 0.35, 1.35, 0.22, 0.27));
    const steering = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.02), new THREE.MeshBasicMaterial());
    steering.name = 'SteeringWheel';
    steering.position.set(0.35, 0.9, 0.4);
    host.add(steering);
    return host;
  };

  it('opens a group of wheels and finds each one, leaving out the steering wheel', () => {
    const names = findWheelNodes(car()).map(node => node.name).sort();
    expect(names).toEqual(['Rim_FL', 'Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR']);
  });

  it("lays out the model's own wheels: front and left, radius and width, a tyre and its rim as one", () => {
    const host = car();
    host.position.set(10, 0, -4);
    host.rotation.y = Math.PI / 2;
    host.updateMatrixWorld(true);
    const layout = planVehicleLayout(host);
    expect(layout.generated).toBe(false);
    expect(layout.wheels).toHaveLength(4);
    const fl = layout.wheels.find(wheel => wheel.front && wheel.left)!;
    expect(fl.nodes.map(node => node.name).sort()).toEqual(['Rim_FL', 'Wheel_FL']);
    // In the chassis frame: the object's own axes, whatever its world placement.
    expect(fl.centre.x).toBeCloseTo(0.8, 3);
    expect(fl.centre.y).toBeCloseTo(0.35, 3);
    expect(fl.centre.z).toBeCloseTo(1.35, 3);
    expect(fl.radius).toBeCloseTo(0.35, 3);
    expect(layout.wheels.filter(wheel => wheel.front)).toHaveLength(2);
    expect(layout.wheels.filter(wheel => wheel.left)).toHaveLength(2);
    // The body's bounds leave the wheels out.
    expect(layout.chassis.min.y).toBeCloseTo(0.3, 3);
    expect(wheelGeometry(layout.wheels)).toEqual({ wheelbase: expect.closeTo(2.7, 3), track: expect.closeTo(1.6, 3) });
  });

  it('draws four wheels at the corners of a model without any, poking out below its body', () => {
    const host = new THREE.Group();
    host.add(new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4).translate(0, 0.5, 0), new THREE.MeshBasicMaterial()));
    host.updateMatrixWorld(true);
    const layout = planVehicleLayout(host);
    expect(layout.generated).toBe(true);
    expect(layout.wheels).toHaveLength(4);
    for (const wheel of layout.wheels) {
      expect(wheel.nodes).toEqual([]);
      expect(wheel.centre.y - wheel.radius).toBeLessThan(0);
      expect(Math.abs(wheel.centre.x)).toBeLessThan(1);
      expect(Math.abs(wheel.centre.z)).toBeLessThan(2);
    }
    expect(planVehicleLayout(host, 0.6).wheels[0].radius).toBe(0.6);
  });

  it('sags the springs to share the weight', () => {
    expect(restingSag({ suspensionStiffness: 30 }, 4)).toBeCloseTo(GRAVITY / 120, 9);
  });

  it('reads where a wheel sits from its name', () => {
    expect(wheelNameTags('wheel fl')).toEqual({ front: true, left: true });
    expect(wheelNameTags('Wheel_BR')).toEqual({ front: false, left: false });
    expect(wheelNameTags('RearLeftTyre')).toEqual({ front: false, left: true });
    expect(wheelNameTags('Tyre.003')).toEqual({});
  });

  it('turns a model that faces another way into the vehicle frame, from its wheel names', () => {
    // A car modelled facing -X (its front wheels at -X), so its left is +Z.
    const host = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.7, 1.8), new THREE.MeshBasicMaterial());
    body.position.set(0, 0.65, 0);
    host.add(body);
    host.add(
      wheelMesh('wheel fl', -1.35, 0.35, 0.8).rotateY(Math.PI / 2),
      wheelMesh('wheel fr', -1.35, 0.35, -0.8).rotateY(Math.PI / 2),
      wheelMesh('wheel bl', 1.35, 0.35, 0.8).rotateY(Math.PI / 2),
      wheelMesh('wheel br', 1.35, 0.35, -0.8).rotateY(Math.PI / 2),
    );
    host.updateMatrixWorld(true);
    const layout = planVehicleLayout(host);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(layout.facing);
    expect(forward.x).toBeCloseTo(-1, 6);
    const fl = layout.wheels.find(wheel => wheel.front && wheel.left)!;
    // In the vehicle frame the front is +Z and the left +X.
    expect(fl.centre.z).toBeCloseTo(1.35, 3);
    expect(fl.centre.x).toBeCloseTo(0.8, 3);
    expect(fl.radius).toBeCloseTo(0.35, 3);
    expect(fl.width).toBeCloseTo(0.25, 3);
    expect(layout.chassis.max.z - layout.chassis.min.z).toBeCloseTo(4.2, 3);
    // The vehicle frame maps the wheel back onto the model.
    const world = fl.centre.clone().applyMatrix4(vehicleFrame(host, layout.facing));
    expect(world.x).toBeCloseTo(-1.35, 3);
    expect(world.z).toBeCloseTo(0.8, 3);
    // A set facing wins over the names.
    expect(new THREE.Vector3(0, 0, 1).applyQuaternion(planVehicleLayout(host, 0, undefined, '+z').facing).z).toBeCloseTo(1, 6);
  });
});

/** A path from points, with straight segments between them. */
const polyline = (points: [number, number][], closed = false): DrivePath => {
  const pts = points.map(([x, z]) => new THREE.Vector3(x, 0, z));
  if (closed) pts.push(pts[0].clone());
  const lengths = [0];
  for (let i = 1; i < pts.length; i++) lengths.push(lengths[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const length = lengths[lengths.length - 1];
  const locate = (distance: number) => {
    const d = closed ? ((distance % length) + length) % length : Math.min(length, Math.max(0, distance));
    let i = 1;
    while (i < lengths.length - 1 && lengths[i] < d) i++;
    return { i, t: (d - lengths[i - 1]) / Math.max(1e-9, lengths[i] - lengths[i - 1]) };
  };
  return {
    length,
    closed,
    pointAt: (distance, out) => { const { i, t } = locate(distance); return out.lerpVectors(pts[i - 1], pts[i], t); },
    tangentAt: (distance, out) => { const { i } = locate(distance); return out.subVectors(pts[i], pts[i - 1]).normalize(); },
  };
};

describe('AI driving', () => {
  const pose = (x: number, z: number, heading: number, speed: number) => ({
    position: new THREE.Vector3(x, 0, z),
    forward: new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading)),
    speed,
  });

  it('drives straight down a straight path at its cruise speed', () => {
    const path = polyline([[0, 0], [0, 400]]);
    const controls = driveAlongPath({ progress: null }, path, pose(0, 10, 0, 5), settings({ aiSpeed: 60 }), 2.6);
    expect(Math.abs(controls.steer)).toBeLessThan(0.01);
    expect(controls.throttle).toBeGreaterThan(0.5);
    expect(controls.brake).toBe(0);
  });

  it('steers right towards a path to its right, left towards one to its left', () => {
    // Facing +Z, the right is -X.
    expect(driveAlongPath({ progress: null }, polyline([[-4, 0], [-4, 400]]), pose(0, 10, 0, 5), settings(), 2.6).steer).toBeGreaterThan(0.1);
    expect(driveAlongPath({ progress: null }, polyline([[4, 0], [4, 400]]), pose(0, 10, 0, 5), settings(), 2.6).steer).toBeLessThan(-0.1);
  });

  it('brakes for a tight corner ahead, and stops at the end of an open path', () => {
    const corner = polyline([[0, 0], [0, 30], [30, 30]]);
    const fast = driveAlongPath({ progress: null }, corner, pose(0, 10, 0, 30), settings({ aiSpeed: 150 }), 2.6);
    expect(fast.brake).toBeGreaterThan(0);
    expect(fast.throttle).toBe(0);

    const end = polyline([[0, 0], [0, 50]]);
    const arriving = driveAlongPath({ progress: null }, end, pose(0, 49.5, 0, 0.1), settings(), 2.6);
    expect(arriving.throttle).toBe(0);
    expect(arriving.handbrake).toBe(true);
  });

  it('keeps its place on a path that crosses itself instead of jumping to the other stretch', () => {
    // A figure of eight through the origin: the second pass crosses the first.
    const eight = polyline([[0, 0], [20, 20], [40, 0], [20, -20], [0, 0], [-20, 20], [-40, 0], [-20, -20]], true);
    const state = { progress: null as number | null };
    trackProgress(state, eight, new THREE.Vector3(18, 0, 18));
    const first = state.progress!;
    expect(first).toBeLessThan(40);
    // Moving on along the first lobe, near (but not at) the crossing.
    trackProgress(state, eight, new THREE.Vector3(39, 0, 1));
    expect(state.progress!).toBeGreaterThan(first);
    expect(state.progress!).toBeLessThan(eight.length / 2);
  });
});

const handle = (objectId: string, overrides: Partial<VehicleHandle> = {}): VehicleHandle => ({
  objectId,
  host: new THREE.Group(),
  playerCanDrive: () => true,
  speed: () => 0,
  gear: () => 1,
  rpm: () => 900,
  seat: out => out.set(0, 0, 0),
  reach: () => 2,
  exitPoint: out => out.set(2, 0, 0),
  setScriptControls: vi.fn(),
  telemetry: () => null,
  frame: out => out.identity(),
  chassis: () => null,
  ...overrides,
});

describe('AI traffic and recovery', () => {
  const cruise = { throttle: 0.8, brake: 0, steer: 0.1, handbrake: false };

  it('carries no more speed than it could stop from short of what is ahead, and holds still close to it', () => {
    expect(obstacleSpeedLimit(AI_STOP_GAP)).toBe(0);
    expect(obstacleSpeedLimit(AI_STOP_GAP + 30)).toBeCloseTo(Math.sqrt(2 * 6 * 30), 9);
    expect(avoidAhead(cruise, 20, Infinity)).toBe(cruise);
    expect(avoidAhead(cruise, 10, 200)).toBe(cruise);
    const closing = avoidAhead(cruise, 25, 30);
    expect(closing.throttle).toBe(0);
    expect(closing.brake).toBeGreaterThan(0);
    // Stopped inside the gap it does not creep up.
    expect(avoidAhead(cruise, 0, AI_STOP_GAP - 1)).toMatchObject({ throttle: 0 });
  });

  it('backs out with the steering reversed when pinned, or when held up too long, then drives on', () => {
    const state = createAiRecovery();
    let controls = cruise;
    for (let t = 0; t < AI_STUCK_TIME + 0.1; t += 0.1) controls = stepAiRecovery(state, cruise, cruise, false, 0, 0.1);
    expect(controls).toMatchObject({ throttle: 0, brake: 1, steer: -cruise.steer });
    for (let t = 0; t < AI_BACK_OUT_TIME + 0.1; t += 0.1) controls = stepAiRecovery(state, cruise, cruise, false, -2, 0.1);
    expect(controls).toBe(cruise);
    // Moving along it never backs out.
    const moving = createAiRecovery();
    for (let t = 0; t < 10; t += 0.1) expect(stepAiRecovery(moving, cruise, cruise, false, 10, 0.1)).toBe(cruise);
    // Held up behind something: waits, then backs out.
    const waiting = createAiRecovery();
    const held = avoidAhead(cruise, 0, 1);
    for (let t = 0; t < AI_BLOCKED_TIME - 0.5; t += 0.1) expect(stepAiRecovery(waiting, cruise, held, true, 0, 0.1)).toBe(held);
    for (let t = 0; t < 1; t += 0.1) controls = stepAiRecovery(waiting, cruise, held, true, 0, 0.1);
    expect(controls.brake).toBe(1);
  });

  it('rights a vehicle that has lain over, nearly still, for a while, facing the way it headed', () => {
    const state = { over: 0 };
    expect(stepUpright(state, -1, 0, RIGHT_AFTER / 2)).toBe(false);
    // Rolling over at speed does not count.
    expect(stepUpright(state, -1, 10, 1)).toBe(false);
    expect(state.over).toBe(0);
    expect(stepUpright(state, -1, 0, RIGHT_AFTER / 2)).toBe(false);
    expect(stepUpright(state, -1, 0, RIGHT_AFTER / 2 + 0.01)).toBe(true);
    // Upside down heading 0.7 rad, for a model built facing +X.
    const facing = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    const vehicle = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI));
    const body = uprightRotation(vehicle, facing);
    const righted = body.clone().multiply(facing);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(righted);
    expect(new THREE.Vector3(0, 1, 0).applyQuaternion(righted).y).toBeCloseTo(1, 6);
    expect(Math.atan2(forward.x, forward.z)).toBeCloseTo(0.7, 6);
  });
});

describe('driving session', () => {
  it('gets the player in and out, raising events, and refuses vehicles they cannot drive', () => {
    const session = createVehicleSession();
    const events: string[] = [];
    session.onEvent(event => events.push(`${event.type}:${event.objectId}`));
    session.register(handle('car'));
    session.register(handle('tank', { playerCanDrive: () => false }));
    expect(session.enter('tank')).toBe(false);
    expect(session.enter('missing')).toBe(false);
    expect(session.enter('car')).toBe(true);
    expect(session.state().driving).toBe('car');
    expect(session.enter('car')).toBe(false);
    expect(session.exit()).toBe(true);
    expect(session.exit()).toBe(false);
    expect(events).toEqual(['entered:car', 'exited:car']);
  });

  it('puts the driver back on foot when their vehicle goes away', () => {
    const session = createVehicleSession();
    const unregister = session.register(handle('car'));
    session.enter('car');
    unregister();
    expect(session.state().driving).toBeNull();
    expect(session.get('car')).toBeNull();
  });

  it('lets the driver out only when slow, with room to step out', () => {
    expect(canStepOut(handle('a'))).toBe(true);
    expect(canStepOut(handle('b', { speed: () => 10 }))).toBe(false);
    expect(canStepOut(handle('c', { exitPoint: () => null }))).toBe(false);
    const session = createVehicleSession();
    session.register(handle('boxed', { exitPoint: () => null }));
    session.enter('boxed');
    expect(stepOutOfVehicle(session)).toBe(false);
    expect(session.state().driving).toBe('boxed');
  });

  it('notifies listeners only when the prompt or the shown HUD changes', () => {
    const session = createVehicleSession();
    const listener = vi.fn();
    session.subscribe(listener);
    session.setPrompt({ objectId: 'car', key: 'F' });
    session.setPrompt({ objectId: 'car', key: 'F' });
    session.setHud({ objectId: 'car', speed: 40, gear: '2', rpm: 0.5 });
    session.setHud({ objectId: 'car', speed: 40, gear: '2', rpm: 0.51 });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('vehicle physics body', () => {
  const object = (components: LevelObject['components']): LevelObject => ({
    id: 'car', name: 'Car', type: 'prop', modelId: 'm', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], components,
  } as LevelObject);

  it('makes a Vehicle a dynamic body whose colliders carry a share of its mass, its hull without the wheels', () => {
    const plan = planPhysicsBody(object([{ id: 'v', type: 'vehicle', enabled: true, props: { mass: 1500 } }]))!;
    expect(plan.ownerId).toBe('v');
    expect(plan.rigidBody).toBe(true);
    expect(plan.vehicle).toBe(true);
    expect(plan.autoHull).toBe(true);
    expect(plan.body.type).toBe('dynamic');
    expect(plan.body.mass).toBeCloseTo(1500 * VEHICLE_SHELL_MASS_SHARE, 9);
  });

  it('lets a Rigid Body component on the same object own the body', () => {
    const plan = planPhysicsBody(object([
      { id: 'v', type: 'vehicle', enabled: true, props: {} },
      { id: 'rb', type: 'rigidBody', enabled: true, props: { type: 'dynamic', mass: 900 } },
    ]))!;
    expect(plan.ownerId).toBe('rb');
    expect(plan.body.mass).toBe(900);
    expect(plan.vehicle).toBe(true);
  });
});

describe('vehicle level-script nodes', () => {
  const run = (type: WorldNodeType, inputs: Record<string, unknown>, extra: Partial<WorldNodeServices>) => {
    const definition = WORLD_NODE_DEFINITIONS.find(d => d.type === type)!;
    const node: FlowNode = {
      id: type, type,
      inputs: definition.inputs.map((pin, i) => ({ ...pin, id: `in-${i}` })),
      outputs: definition.outputs.map((pin, i) => ({ ...pin, id: `out-${i}` })),
      data: { ...definition.data },
    };
    const nodeState: Record<string, unknown> = {};
    const fired: string[] = [];
    const services: WorldNodeServices = {
      spawnPrefab: () => [], playSound: () => undefined, getObject: () => null, setObjectTransform: () => undefined,
      applyImpulse: () => undefined, raycast: () => null, input: { isDown: () => false },
      vars: createLevelVariablesStore(() => {}), print: () => undefined, ...extra,
    };
    WORLD_NODE_EXECUTORS[type]!(node, {
      evaluate: name => (name in inputs ? inputs[name] : node.data?.[`default_${name}`] ?? null),
      fire: pin => { fired.push(pin); },
      schedule: () => undefined,
      nodeState,
      services,
    });
    return { out: (pin: string) => flowNodeOutputValue(nodeState, pin), fired };
  };

  it('enters and exits a vehicle and reads its state', () => {
    const enterVehicle = vi.fn((id: string) => id === 'car');
    expect(run('EnterVehicle', { Vehicle: 'car' }, { enterVehicle }).out('Entered')).toBe(true);
    expect(run('EnterVehicle', { Vehicle: 'rock' }, { enterVehicle }).out('Entered')).toBe(false);
    expect(run('ExitVehicle', {}, { exitVehicle: () => true }).out('Exited')).toBe(true);
    const state = run('GetVehicleState', { Vehicle: 'car' }, { vehicle: () => ({ speed: 72, gear: 3, playerDriving: true }) });
    expect([state.out('Found'), state.out('Speed'), state.out('Gear'), state.out('Player Driving')]).toEqual([true, 72, 3, true]);
    expect(run('GetVehicleState', { Vehicle: 'rock' }, { vehicle: () => null }).out('Found')).toBe(false);
    const player = run('GetPlayerVehicle', {}, { playerVehicle: () => 'car' });
    expect([player.out('Driving'), player.out('Vehicle')]).toEqual([true, 'car']);
  });

  it('drives a vehicle from the script with clamped input, and releases it', () => {
    const setVehicleInput = vi.fn(() => true);
    const set = run('SetVehicleInput', { Vehicle: 'car', Throttle: 2, Brake: -1, Steer: -3, Handbrake: true }, { setVehicleInput });
    expect(set.out('Set')).toBe(true);
    expect(setVehicleInput).toHaveBeenLastCalledWith('car', { throttle: 1, brake: 0, steer: -1, handbrake: true });
    run('ReleaseVehicleInput', { Vehicle: 'car' }, { setVehicleInput });
    expect(setVehicleInput).toHaveBeenLastCalledWith('car', null);
  });
});

describe('vehicles in gameplay scripts', () => {
  it('accepts well-formed vehicle commands only', () => {
    expect(parseScriptCommand({ type: 'enterVehicle', objectId: 'car' })).toEqual({ type: 'enterVehicle', objectId: 'car' });
    expect(parseScriptCommand({ type: 'exitVehicle' })).toEqual({ type: 'exitVehicle' });
    expect(parseScriptCommand({ type: 'setVehicleInput', objectId: 'car', throttle: 0.5, brake: 0, steer: -0.2, handbrake: false }))
      .toEqual({ type: 'setVehicleInput', objectId: 'car', throttle: 0.5, brake: 0, steer: -0.2, handbrake: false });
    expect(parseScriptCommand({ type: 'setVehicleInput', objectId: 'car', throttle: 2, brake: 0, steer: 0, handbrake: false })).toBeNull();
    expect(parseScriptCommand({ type: 'setVehicleInput', objectId: 'car', throttle: 0, brake: 0, steer: 0 })).toBeNull();
    expect(parseScriptCommand({ type: 'releaseVehicleInput', objectId: '' })).toBeNull();
  });

  it('describes the session vehicles in km/h, marking the one the player drives', () => {
    const session = createVehicleSession();
    expect(scriptVehicleStates(session)).toBeUndefined();
    session.register(handle('car', { speed: () => 10, gear: () => 3 }));
    session.register(handle('van'));
    session.enter('car');
    expect(scriptVehicleStates(session)).toEqual({
      car: { speed: 36, gear: 3, playerDriving: true },
      van: { speed: 0, gear: 1, playerDriving: false },
    });
  });
});
