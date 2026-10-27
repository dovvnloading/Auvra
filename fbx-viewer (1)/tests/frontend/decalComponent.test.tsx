import * as THREE from 'three';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DECAL_COMPONENT,
  DECAL_DEFAULTS,
  DECAL_RESCAN_FRAMES,
  DecalProjector,
  MAX_DECAL_SIZE,
  MIN_DECAL_SIZE,
  buildDecalGeometry,
  canReceiveDecal,
  collectDecalReceivers,
  resolveDecalSettings,
} from '../../runtime/components/decalComponent';
import type { DecalRequest } from '../../runtime/components/decalComponent';
import { collectHostGeometry } from '../../runtime/components/physicsComponents';
import { GameContentProvider } from '../../runtime/GameContentContext';
import type { GameContent } from '../../runtime/types';
import type { LevelComponent, LevelObject } from '../../types';

const frame = vi.hoisted(() => ({ callback: null as (() => void) | null }));

vi.mock('@react-three/fiber', () => ({
  useFrame: (callback: () => void) => { frame.callback = callback; },
}));

const lit = () => new THREE.MeshStandardMaterial();

/** A floor plate at y = 0 facing up (world +Y). */
const floor = (side = 10, material: THREE.Material = lit()) =>
  new THREE.Mesh(new THREE.PlaneGeometry(side, side).rotateX(-Math.PI / 2), material);

/** A decal owner `height` m above the floor, aimed straight down: its local -Z is world -Y and its local Y is world -Z. */
const ownerAbove = (scene: THREE.Object3D, x: number, height: number, z: number) => {
  const owner = new THREE.Group();
  owner.position.set(x, height, z);
  owner.rotation.set(-Math.PI / 2, 0, 0);
  scene.add(owner);
  return owner;
};

const mount = (owner: THREE.Object3D) => {
  const projector = new DecalProjector();
  owner.add(projector.root);
  let root = owner;
  while (root.parent) root = root.parent;
  root.updateMatrixWorld(true);
  return projector;
};

const request = (overrides: Partial<DecalRequest> = {}): DecalRequest => ({
  size: [1, 2, 0.5], mode: 'scene', objectId: 'decal', model: null, ...overrides,
});

/** The decal geometry's bounds in world space. */
const worldBounds = (projector: DecalProjector) => new THREE.Box3()
  .setFromBufferAttribute(projector.mesh.geometry.getAttribute('position') as THREE.BufferAttribute)
  .applyMatrix4(projector.root.matrixWorld);

/** The rigid projector transform the decal uses: its owner's world position and rotation. */
const projectorOf = (projector: DecalProjector) => {
  projector.root.updateWorldMatrix(true, false);
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  projector.root.matrixWorld.decompose(position, rotation, new THREE.Vector3());
  return new THREE.Matrix4().compose(position, rotation, new THREE.Vector3(1, 1, 1));
};

/** Whether every triangle winds counter-clockwise around its vertex normals (so it is a front face). */
const frontFacesAgree = (geometry: THREE.BufferGeometry) => {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const [a, b, c, n, face, edge] = Array.from({ length: 6 }, () => new THREE.Vector3());
  for (let t = 0; t < position.count; t += 3) {
    a.fromBufferAttribute(position, t);
    b.fromBufferAttribute(position, t + 1);
    c.fromBufferAttribute(position, t + 2);
    face.subVectors(c, b).cross(edge.subVectors(a, b));
    if (face.lengthSq() < 1e-12) continue;
    if (face.dot(n.fromBufferAttribute(normal, t)) <= 0) return false;
  }
  return true;
};

beforeEach(() => {
  frame.callback = null;
});

describe('decal settings', () => {
  it('fills in defaults and clamps every field', () => {
    expect(resolveDecalSettings({})).toEqual(DECAL_DEFAULTS);
    expect(resolveDecalSettings({
      textureId: '  Brick ', size: [-3, 0, 500], opacity: 2, color: '#FF8800', receivers: 'scene',
    })).toEqual({ textureId: 'Brick', size: [3, MIN_DECAL_SIZE, MAX_DECAL_SIZE], opacity: 1, color: '#FF8800', receivers: 'scene' });
    expect(resolveDecalSettings({
      textureId: 42, size: [1, Number.NaN, 1], opacity: -1, color: 'red', receivers: 'everything',
    })).toEqual({ ...DECAL_DEFAULTS, opacity: 0 });
    expect(resolveDecalSettings({ size: [1, 2], opacity: Number.POSITIVE_INFINITY }).size).toEqual(DECAL_DEFAULTS.size);
    expect(resolveDecalSettings({ opacity: Number.POSITIVE_INFINITY }).opacity).toBe(DECAL_DEFAULTS.opacity);
  });

  it('declares its props with defaults inside their ranges', () => {
    expect(DECAL_COMPONENT.type).toBe('decal');
    expect(DECAL_COMPONENT.label).toBe('Decal');
    const props = Object.fromEntries(DECAL_COMPONENT.props.map(prop => [prop.key, prop]));
    expect(Object.keys(props)).toEqual(['textureId', 'size', 'opacity', 'color', 'receivers']);
    expect(props.size.default).toEqual([1, 1, 0.5]);
    expect(props.size).toMatchObject({ type: 'vector3', min: MIN_DECAL_SIZE, max: MAX_DECAL_SIZE });
    expect(props.opacity).toMatchObject({ type: 'number', min: 0, max: 1, default: 1 });
    expect(props.receivers.options?.map(option => option.value)).toEqual(['parent', 'scene']);
  });
});

describe('decal projection', () => {
  it('builds geometry on a floor under the decal, clipped to the box and mapped across it', () => {
    const scene = new THREE.Scene();
    scene.add(floor());
    const projector = mount(ownerAbove(scene, 2, 0.1, -1));

    expect(projector.update(request())).toBe(true);
    expect(projector.mesh.visible).toBe(true);
    const bounds = worldBounds(projector);
    // Width (local X) along world X, height (local Y) along world -Z, flat on the floor.
    expect(bounds.min.x).toBeCloseTo(1.5);
    expect(bounds.max.x).toBeCloseTo(2.5);
    expect(bounds.min.z).toBeCloseTo(-2);
    expect(bounds.max.z).toBeCloseTo(0);
    expect(bounds.min.y).toBeCloseTo(0);
    expect(bounds.max.y).toBeCloseTo(0);

    const uv = projector.mesh.geometry.getAttribute('uv');
    expect(uv.count).toBe(projector.mesh.geometry.getAttribute('position').count);
    const us = Array.from({ length: uv.count }, (_, i) => uv.getX(i));
    const vs = Array.from({ length: uv.count }, (_, i) => uv.getY(i));
    expect(Math.min(...us)).toBeCloseTo(0);
    expect(Math.max(...us)).toBeCloseTo(1);
    expect(Math.min(...vs)).toBeCloseTo(0);
    expect(Math.max(...vs)).toBeCloseTo(1);
    expect(frontFacesAgree(projector.mesh.geometry)).toBe(true);

    const material = projector.mesh.material;
    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(material).toMatchObject({ transparent: true, depthWrite: false, polygonOffset: true });
    expect(material.polygonOffsetFactor).toBeLessThan(0);
    // The decal never takes clicks or placement hits from the floor under it.
    const hits: THREE.Intersection[] = [];
    projector.mesh.raycast(new THREE.Raycaster(new THREE.Vector3(2, 5, -1), new THREE.Vector3(0, -1, 0)), hits);
    expect(hits).toHaveLength(0);
  });

  it('builds nothing without a receiver in the box', () => {
    const outcome = (receiver: THREE.Object3D | null, height = 0.1) => {
      const scene = new THREE.Scene();
      if (receiver) scene.add(receiver);
      const projector = mount(ownerAbove(scene, 0, height, 0));
      projector.update(request());
      return projector;
    };

    const empty = outcome(null);
    expect(empty.mesh.visible).toBe(false);
    expect(empty.mesh.geometry.hasAttribute('position')).toBe(false);
    expect(buildDecalGeometry([], new THREE.Matrix4(), [1, 1, 1])).toBeNull();

    // Out of reach of the box, facing away from the projector, an editor helper, or skinned.
    expect(outcome(floor(), 2).mesh.visible).toBe(false);
    expect(outcome(new THREE.Mesh(new THREE.PlaneGeometry(10, 10).rotateX(Math.PI / 2), lit())).mesh.visible).toBe(false);
    expect(outcome(floor(10, new THREE.MeshBasicMaterial())).mesh.visible).toBe(false);
    expect(outcome(floor(10, new THREE.MeshStandardMaterial({ wireframe: true }))).mesh.visible).toBe(false);
    const skinned = new THREE.SkinnedMesh(new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2), lit());
    expect(canReceiveDecal(skinned)).toBe(false);
    expect(outcome(skinned).mesh.visible).toBe(false);
    // A hidden floor draws nothing to land on.
    const hidden = floor();
    hidden.visible = false;
    expect(outcome(hidden).mesh.visible).toBe(false);
  });

  it("lands only on the owner's own model for 'parent', and on anything in the box for 'scene'", () => {
    const scene = new THREE.Scene();
    scene.add(floor());
    const owner = ownerAbove(scene, 0, 0.1, 0);
    // The owner's own 0.4 m plate, 5 cm in front of it (local -Z), facing back at it (local +Z).
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), lit());
    plate.position.z = -0.05;
    owner.add(plate);
    // A nested child object keeps its own meshes.
    const child = new THREE.Group();
    child.userData = { levelObjectId: 'child' };
    const childPlate = new THREE.Mesh(new THREE.PlaneGeometry(1, 2), lit());
    childPlate.position.z = -0.02;
    child.add(childPlate);
    owner.add(child);
    const projector = mount(owner);

    projector.update(request({ mode: 'parent' }));
    let bounds = worldBounds(projector);
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(0.4);
    expect(bounds.min.y).toBeCloseTo(0.05);
    expect(bounds.max.y).toBeCloseTo(0.05);

    expect(projector.update(request({ mode: 'scene' }))).toBe(true);
    bounds = worldBounds(projector);
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(1);
    expect(bounds.min.y).toBeCloseTo(0);
    expect(bounds.max.y).toBeCloseTo(0.08);
  });

  it("falls back to meshes tagged with the owner's id, then to its model placed at the owner", () => {
    // Terrain draws itself elsewhere, tagged with its object id.
    const scene = new THREE.Scene();
    const terrain = floor();
    terrain.userData = { levelObjectId: 'decal' };
    const other = floor(10);
    other.position.y = -0.05;
    other.userData = { levelObjectId: 'someone-else' };
    scene.add(terrain, other);
    const onTerrain = mount(ownerAbove(scene, 0, 0.1, 0));
    onTerrain.update(request({ mode: 'parent' }));
    expect(worldBounds(onTerrain).min.y).toBeCloseTo(0);
    expect(worldBounds(onTerrain).max.y).toBeCloseTo(0);

    // An instanced prop: its component group is empty, so its model is projected onto at the owner.
    const model = new THREE.Group();
    model.scale.setScalar(2);
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), lit());
    wall.position.z = -0.1;
    model.add(wall);
    const room = new THREE.Scene();
    const owner = new THREE.Group();
    owner.position.set(3, 1, 0);
    room.add(owner);
    const onModel = mount(owner);
    onModel.update(request({ mode: 'parent', size: [1, 1, 0.5], model }));
    const bounds = worldBounds(onModel);
    expect(bounds.min.x).toBeCloseTo(2.5);
    expect(bounds.max.x).toBeCloseTo(3.5);
    expect(bounds.min.y).toBeCloseTo(0.5);
    expect(bounds.max.y).toBeCloseTo(1.5);
    expect(bounds.min.z).toBeCloseTo(-0.2);
    expect(bounds.max.z).toBeCloseTo(-0.2);
    // The template is read, never placed or updated.
    expect(model.parent).toBeNull();
    expect(wall.matrixWorld.equals(new THREE.Matrix4())).toBe(true);

    // Once the owner draws its own copy, the next re-scan uses that instead.
    const drawn = wall.clone();
    drawn.position.z = -0.15;
    owner.add(drawn);
    const rebuilt = Array.from({ length: DECAL_RESCAN_FRAMES }, () => onModel.update(request({ mode: 'parent', size: [1, 1, 0.5], model })));
    expect(rebuilt.filter(Boolean)).toHaveLength(1);
    expect(worldBounds(onModel).min.z).toBeCloseTo(-0.15);
  });

  it('lands on the instances of an instanced mesh under the box, never on collapsed ones', () => {
    const scene = new THREE.Scene();
    const tiles = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), lit(), 3);
    tiles.setMatrixAt(0, new THREE.Matrix4());
    tiles.setMatrixAt(1, new THREE.Matrix4().makeTranslation(50, 0, 0));
    // Hidden instances collapse to nothing (the editor draws a selected one elsewhere).
    tiles.setMatrixAt(2, new THREE.Matrix4().makeScale(0, 0, 0).setPosition(0, 0.05, 0));
    scene.add(tiles);
    const projector = mount(ownerAbove(scene, 0, 0.1, 0));

    const receivers = collectDecalReceivers(projector.root, projectorOf(projector), [1, 1, 0.5], { mode: 'scene', objectId: 'decal' });
    expect(receivers.map(receiver => receiver.instance)).toEqual([0]);
    projector.update(request());
    expect(worldBounds(projector).max.y).toBeCloseTo(0);
  });

  it('keeps front faces on meshes without normals and under mirrored transforms', () => {
    const cases: [string, (receiver: THREE.Mesh, owner: THREE.Object3D) => void][] = [
      ['no normals', receiver => { receiver.geometry.deleteAttribute('normal'); }],
      ['mirrored receiver', receiver => { receiver.scale.set(-1, 1, 1); }],
      ['mirrored owner', (_receiver, owner) => { owner.scale.set(-1, 1, 1); }],
    ];
    for (const [name, setup] of cases) {
      const scene = new THREE.Scene();
      const receiver = floor();
      scene.add(receiver);
      const owner = ownerAbove(scene, 0, 0.1, 0);
      setup(receiver, owner);
      const projector = mount(owner);
      projector.update(request());
      expect(projector.mesh.visible, name).toBe(true);
      expect(frontFacesAgree(projector.mesh.geometry), name).toBe(true);
      // The decal's normals point up off the floor in world space.
      const normal = new THREE.Vector3().fromBufferAttribute(projector.mesh.geometry.getAttribute('normal'), 0)
        .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(projector.root.matrixWorld));
      expect(normal.y, name).toBeCloseTo(1);
    }
  });

  it('re-projects only when the owner, a receiver or the request changes', () => {
    const scene = new THREE.Scene();
    const ground = floor();
    scene.add(ground);
    const owner = ownerAbove(scene, 0, 0.1, 0);
    const projector = mount(owner);
    expect(projector.update(request())).toBe(true);
    const first = projector.mesh.geometry;
    const disposeFirst = vi.spyOn(first, 'dispose');

    // Past a periodic re-scan, nothing changed.
    for (let i = 0; i < 40; i++) expect(projector.update(request())).toBe(false);
    expect(projector.mesh.geometry).toBe(first);

    owner.position.x = 1;
    expect(projector.update(request())).toBe(true);
    expect(disposeFirst).toHaveBeenCalledTimes(1);
    expect(worldBounds(projector).min.x).toBeCloseTo(0.5);

    ground.position.y = -0.05;
    expect(projector.update(request())).toBe(true);
    expect(worldBounds(projector).max.y).toBeCloseTo(-0.05);

    // Vertices edited in place (terrain sculpting) re-project.
    const positions = ground.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < positions.count; i++) positions.setY(i, 0.05);
    positions.needsUpdate = true;
    expect(projector.update(request())).toBe(true);
    expect(worldBounds(projector).max.y).toBeCloseTo(0);

    expect(projector.update(request({ size: [2, 2, 0.5] }))).toBe(true);
    expect(worldBounds(projector).max.x - worldBounds(projector).min.x).toBeCloseTo(2);
  });

  it("follows its own moving model without re-projecting, and hides when the owner collapses", () => {
    const scene = new THREE.Scene();
    const owner = ownerAbove(scene, 0, 1, 0);
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), lit());
    plate.position.z = -0.05;
    owner.add(plate);
    const projector = mount(owner);
    expect(projector.update(request({ mode: 'parent' }))).toBe(true);
    const built = projector.mesh.geometry;

    // A spinning (rotator) or moving owner carries its model and decal along together.
    owner.rotateZ(1);
    owner.position.x = 4;
    expect(projector.update(request({ mode: 'parent' }))).toBe(false);
    expect(projector.mesh.geometry).toBe(built);

    owner.scale.set(0, 0, 0);
    expect(projector.update(request({ mode: 'parent' }))).toBe(true);
    expect(projector.mesh.visible).toBe(false);
    owner.scale.set(1, 1, 1);
    expect(projector.update(request({ mode: 'parent' }))).toBe(true);
    expect(projector.mesh.visible).toBe(true);
  });

  it("stays out of the owner's physics shape", () => {
    const scene = new THREE.Scene();
    scene.add(floor());
    const owner = ownerAbove(scene, 0, 0.1, 0);
    owner.add(new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), lit()));
    const projector = mount(owner);
    projector.update(request({ mode: 'scene' }));
    expect(projector.mesh.visible).toBe(true);
    // Only the owner's own plate shapes a mesh collider or automatic hull, never the decal on the floor.
    expect(collectHostGeometry(owner, 'decal')!.positions).toHaveLength(4 * 3);
  });
});

describe('decal component render', () => {
  beforeEach(() => {
    // react-dom does not know the <primitive> intrinsic; that noise is not under test.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  const content = (textures: GameContent['textures'] = []): GameContent => ({
    models: [], blueprints: [], attachments: [], sockets: [], textures, audioAssets: [],
  });

  const decal = (props: Record<string, unknown>): LevelComponent => ({ id: 'decal', type: 'decal', enabled: true, props });

  const owner = { id: 'owner', modelId: '' } as LevelObject;

  /** Renders the component and returns its projector, captured as it gets its first appearance. */
  const renderDecal = (component: LevelComponent, mode: 'editor' | 'runtime', textures: GameContent['textures'] = []) => {
    const appearance = vi.spyOn(DecalProjector.prototype, 'setAppearance');
    const Render = DECAL_COMPONENT.Render!;
    const view = render(
      <GameContentProvider value={content(textures)}>
        <Render object={owner} component={component} mode={mode} />
      </GameContentProvider>,
    );
    const projector = appearance.mock.contexts[0] as DecalProjector;
    return { view, projector, Render };
  };

  it('projects each frame, outlines the box only in the editor, and disposes everything on unmount', () => {
    const component = decal({ size: [1, 1, 0.5], receivers: 'scene', opacity: 0.5, color: '#ff0000' });
    const { view, projector, Render } = renderDecal(component, 'editor');
    expect(projector.volume.visible).toBe(true);
    expect(projector.mesh.material.opacity).toBe(0.5);
    expect(projector.mesh.material.color.getHexString()).toBe('ff0000');

    const scene = new THREE.Scene();
    scene.add(floor());
    ownerAbove(scene, 0, 0.1, 0).add(projector.root);
    frame.callback?.();
    const geometry = projector.mesh.geometry;
    expect(geometry.getAttribute('position').count).toBeGreaterThan(0);
    expect(projector.mesh.visible).toBe(true);

    view.rerender(
      <GameContentProvider value={content()}>
        <Render object={owner} component={component} mode="runtime" />
      </GameContentProvider>,
    );
    expect(projector.volume.visible).toBe(false);

    const disposals = [
      vi.spyOn(geometry, 'dispose'),
      vi.spyOn(projector.mesh.material, 'dispose'),
      vi.spyOn(projector.volume.geometry, 'dispose'),
      vi.spyOn(projector.volume.material, 'dispose'),
    ];
    view.unmount();
    for (const spy of disposals) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('applies the texture asset it names (by id or name) and frees it when it goes', () => {
    const loaded: THREE.Texture[] = [];
    vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation((_url, onLoad) => {
      const texture = new THREE.Texture(document.createElement('img'));
      loaded.push(texture);
      onLoad?.(texture);
      return texture;
    });
    const textures = [{ id: 'tex-brick', name: 'Brick', url: 'blob:brick', dimensions: { width: 4, height: 4 } }];
    const { view, projector } = renderDecal(decal({ textureId: 'Brick' }), 'runtime', textures);
    expect(loaded).toHaveLength(1);
    expect(projector.mesh.material.map).toBe(loaded[0]);
    expect(loaded[0].colorSpace).toBe(THREE.SRGBColorSpace);

    const dispose = vi.spyOn(loaded[0], 'dispose');
    view.unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(projector.mesh.material.map).toBeNull();
  });
});
