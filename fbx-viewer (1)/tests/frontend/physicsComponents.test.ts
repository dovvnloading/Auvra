import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { RapierContext } from '@react-three/rapier';
import { createComponent, getComponentDefinition } from '../../runtime/components/registry';
import {
  collectHostGeometry,
  colliderMass,
  createTriggerOverlapTracker,
  followHostState,
  planHull,
  planPhysicsBody,
  resolveColliderSettings,
  resolveRigidBodySettings,
} from '../../runtime/components/physicsComponents';
import { createPhysicsQueries, objectIdFromUserData, physicsUserData, PLAYER_PHYSICS_ID } from '../../runtime/physicsQueries';
import type { LevelComponent, LevelObject } from '../../types';
import type { TriggerEvent } from '../../runtime/triggers';

const component = (type: string, props: Record<string, unknown> = {}, enabled = true): LevelComponent => ({
  ...createComponent(type),
  enabled,
  props: { ...createComponent(type).props, ...props },
});

const objectWith = (components: LevelComponent[]): LevelObject => ({
  id: 'crate',
  components,
} as unknown as LevelObject);

describe('physics component definitions', () => {
  it('registers collider and rigidBody with renderers and documented defaults', () => {
    for (const type of ['collider', 'rigidBody']) {
      const definition = getComponentDefinition(type);
      expect(definition?.label).toBeTruthy();
      expect(typeof definition?.Render).toBe('function');
    }
    expect(createComponent('collider').props).toEqual({
      shape: 'box', size: [1, 1, 1], radius: 0.5, height: 2, offset: [0, 0, 0], isTrigger: false, surface: 'auto',
    });
    expect(createComponent('rigidBody').props).toEqual({ type: 'dynamic', mass: 1, gravityScale: 1, lockRotation: false });
    expect(getComponentDefinition('collider')!.props.find(prop => prop.key === 'shape')!.options!.map(option => option.value))
      .toEqual(['box', 'sphere', 'capsule', 'mesh']);
    expect(getComponentDefinition('rigidBody')!.props.find(prop => prop.key === 'type')!.options!.map(option => option.value))
      .toEqual(['fixed', 'dynamic', 'kinematicPosition']);
  });

  it('resolves invalid stored props to defaults and keeps sizes positive', () => {
    const settings = resolveColliderSettings(component('collider', {
      shape: 'teapot', size: [-2, 0, 3], radius: -1, height: 'tall', offset: [1, 2], isTrigger: 'yes', surface: 'lava',
    }));
    expect(settings).toEqual({ shape: 'box', size: [2, 0.01, 3], radius: 0.01, height: 2, offset: [0, 0, 0], isTrigger: false, surface: 'auto' });
    expect(resolveColliderSettings(component('collider', { surface: 'gravel' })).surface).toBe('gravel');
    expect(resolveRigidBodySettings(component('rigidBody', { type: 'floaty', mass: 0, gravityScale: Number.NaN })))
      .toEqual({ type: 'dynamic', mass: 0.001, gravityScale: 1, lockRotation: false });
  });
});

describe('planPhysicsBody', () => {
  it('makes enabled colliders without a rigid body one fixed body owned by the first collider', () => {
    const off = component('collider', {}, false);
    const box = component('collider');
    const trigger = component('collider', { shape: 'sphere', isTrigger: true });
    const plan = planPhysicsBody(objectWith([off, box, trigger]))!;
    expect(plan.ownerId).toBe(box.id);
    expect(plan.body.type).toBe('fixed');
    expect(plan.colliders.map(entry => entry.id)).toEqual([box.id, trigger.id]);
    expect(plan.autoHull).toBe(false);
    expect(colliderMass(plan, plan.colliders[0].settings)).toBeUndefined();
  });

  it('gives a rigid body without colliders an automatic hull, and shares dynamic mass over solid colliders', () => {
    const body = component('rigidBody', { mass: 6 });
    expect(planPhysicsBody(objectWith([body]))).toMatchObject({ ownerId: body.id, autoHull: true, colliders: [] });

    const plan = planPhysicsBody(objectWith([
      component('collider'), body, component('collider', { shape: 'capsule' }), component('collider', { isTrigger: true }),
    ]))!;
    expect(plan.ownerId).toBe(body.id);
    expect(plan.autoHull).toBe(false);
    expect(plan.colliders.map(entry => colliderMass(plan, entry.settings))).toEqual([3, 3, 0]);
    expect(planPhysicsBody(objectWith([component('rotator')]))).toBeNull();
  });
});

describe('object geometry', () => {
  it('merges the host meshes into host-local triangles, skipping physics previews and separately simulated children', () => {
    const host = new THREE.Group();
    host.position.set(10, 0, 0);
    host.scale.setScalar(2);
    const model = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    model.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    model.position.set(0, 1, 0);
    host.add(model);

    const hidden = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ visible: false }));
    const preview = new THREE.Group();
    preview.userData = { auvraPhysicsAnchor: true };
    preview.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    const physicalChild = new THREE.Group();
    physicalChild.userData = { levelObjectId: 'child' };
    physicalChild.add(preview.clone(), new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    host.add(hidden, preview, physicalChild);

    const geometry = collectHostGeometry(host, 'crate')!;
    expect(Array.from(geometry.positions)).toEqual([0, 1, 0, 1, 1, 0, 0, 2, 0]);
    expect(Array.from(geometry.indices)).toEqual([0, 1, 2]);
    expect(collectHostGeometry(new THREE.Group(), 'crate')).toBeNull();
  });

  it('hulls solid point sets and boxes flat ones that Rapier cannot hull', () => {
    const cube = new THREE.BoxGeometry(1, 2, 3).getAttribute('position').array as Float32Array;
    expect(planHull(cube).kind).toBe('hull');
    const plane = new Float32Array([0, 0, 0, 2, 0, 0, 0, 0, 4, 2, 0, 4]);
    expect(planHull(plane)).toEqual({ kind: 'box', halfExtents: [1, 0.005, 2], center: [1, 0, 2] });
  });
});

describe('physics body sync', () => {
  it('syncs dynamic bodies to the host group and keeps fixed and kinematic bodies from writing back', () => {
    const parent = new THREE.Group();
    parent.position.set(0, 5, 0);
    const host = new THREE.Group();
    host.scale.set(1, 2, 1);
    parent.add(host);
    parent.updateMatrixWorld(true);
    const state = {
      meshType: 'mesh', rigidBody: {}, object: new THREE.Object3D(), invertedWorldMatrix: new THREE.Matrix4(),
      setMatrix: vi.fn(), getMatrix: vi.fn(), scale: new THREE.Vector3(1, 1, 1), isSleeping: false,
    } as unknown as Parameters<typeof followHostState>[0];

    const dynamic = followHostState(state, host, true);
    expect(dynamic.object).toBe(host);
    expect(dynamic.scale.toArray()).toEqual([1, 2, 1]);
    expect(dynamic.meshType).toBe('mesh');
    parent.position.set(0, 7, 0);
    parent.updateMatrixWorld(true);
    expect(new THREE.Vector3().setFromMatrixPosition(dynamic.invertedWorldMatrix).toArray()).toEqual([0, -7, 0]);

    const fixed = followHostState(state, host, false);
    expect(fixed.meshType).toBe('instancedMesh');
    fixed.setMatrix(new THREE.Matrix4().makeTranslation(1, 2, 3));
    expect(state.setMatrix).not.toHaveBeenCalled();
  });
});

describe('trigger overlaps', () => {
  it('reports one enter and one exit per other object, never for the trigger itself', () => {
    const events: TriggerEvent[] = [];
    const tracker = createTriggerOverlapTracker('door', event => events.push(event));
    tracker.enter(PLAYER_PHYSICS_ID);
    tracker.enter(PLAYER_PHYSICS_ID);
    tracker.enter('door');
    tracker.exit(PLAYER_PHYSICS_ID);
    tracker.exit('barrel');
    expect(events).toEqual([{ kind: 'enter', triggerObjectId: 'door', otherObjectId: 'player' }]);
    tracker.exit(PLAYER_PHYSICS_ID);
    expect(events[1]).toEqual({ kind: 'exit', triggerObjectId: 'door', otherObjectId: 'player' });
  });
});

describe('physics queries', () => {
  class FakeRay {
    constructor(public origin: { x: number; y: number; z: number }, public dir: { x: number; y: number; z: number }) {}
  }
  const rapier = { Ray: FakeRay, QueryFilterFlags: { EXCLUDE_SENSORS: 8 } } as unknown as RapierContext['rapier'];
  const colliderOf = (userData: unknown) => ({ parent: () => ({ userData }) });

  it('maps the hit collider to its object and returns the hit point and normal', () => {
    const castRayAndGetNormal = vi.fn((_ray: FakeRay, _max: number, _solid: boolean, _flags?: number, _g?: unknown, _c?: unknown, _b?: unknown,
      predicate?: (collider: unknown) => boolean) => {
      expect(predicate?.(colliderOf(physicsUserData(PLAYER_PHYSICS_ID)))).toBe(false);
      return { collider: colliderOf(physicsUserData('wall')), timeOfImpact: 4, normal: { x: -1, y: 0, z: 0 } };
    });
    const queries = createPhysicsQueries({ castRayAndGetNormal } as unknown as RapierContext['world'], rapier);
    const hit = queries.raycast(new THREE.Vector3(1, 1, 0), new THREE.Vector3(10, 0, 0), 50, { excludeObjectId: PLAYER_PHYSICS_ID })!;
    expect(hit.objectId).toBe('wall');
    expect(hit.point.toArray()).toEqual([5, 1, 0]);
    expect(hit.normal.toArray()).toEqual([-1, 0, 0]);
    expect(hit.distance).toBe(4);
    const [ray, maxDistance, solid, flags] = castRayAndGetNormal.mock.calls[0];
    expect(ray.dir).toEqual({ x: 1, y: 0, z: 0 });
    expect([maxDistance, solid, flags]).toEqual([50, true, 8]);
  });

  it('returns null for a miss or a degenerate ray, and reads ids only from physics userData', () => {
    const castRayAndGetNormal = vi.fn(() => null);
    const queries = createPhysicsQueries({ castRayAndGetNormal } as unknown as RapierContext['world'], rapier);
    expect(queries.raycast(new THREE.Vector3(), new THREE.Vector3(0, -1, 0), 10)).toBeNull();
    expect(queries.raycast(new THREE.Vector3(), new THREE.Vector3(), 10)).toBeNull();
    expect(queries.raycast(new THREE.Vector3(), new THREE.Vector3(0, -1, 0), 0)).toBeNull();
    expect(castRayAndGetNormal).toHaveBeenCalledTimes(1);
    expect(objectIdFromUserData({ levelObjectId: '' })).toBeNull();
    expect(objectIdFromUserData('crate')).toBeNull();
  });
});
