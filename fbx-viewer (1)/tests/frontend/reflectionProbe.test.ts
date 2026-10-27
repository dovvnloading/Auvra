import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  nearestProbe, REFLECTION_PROBE_DEFAULTS, resolveReflectionProbeSettings, shouldCapture, updateProbeAssignments, type ProbeEntry,
} from '../../runtime/components/reflectionProbe';

const probe = (id: string, position: [number, number, number], radius: number, texture: THREE.Texture | null = new THREE.Texture()): ProbeEntry => ({
  id, position: new THREE.Vector3(...position), radius, texture, intensity: 1.5, host: null,
});

const shinyMesh = (position: [number, number, number], material = new THREE.MeshStandardMaterial()) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.position.set(...position);
  return mesh;
};

describe('reflection probe settings', () => {
  it('defaults and clamps', () => {
    expect(resolveReflectionProbeSettings({ id: 'p', type: 'reflectionProbe', enabled: true, props: {} })).toEqual(REFLECTION_PROBE_DEFAULTS);
    expect(resolveReflectionProbeSettings({ id: 'p', type: 'reflectionProbe', enabled: true, props: { radius: -1, resolution: '256', update: 'never', intensity: 99 } }))
      .toMatchObject({ radius: 0.1, resolution: 256, update: 'once', intensity: 10 });
  });

  it('captures at the start, once more after things load, and then by its update mode', () => {
    expect(shouldCapture('once', null, 2, 0)).toBe(true);
    expect(shouldCapture('once', 0.5, 2, 0.5)).toBe(false);
    expect(shouldCapture('once', 1.05, 2, 1.05)).toBe(true);
    expect(shouldCapture('once', 0.5, 2, 1.6)).toBe(false);
    expect(shouldCapture('interval', 1.9, 2, 10)).toBe(false);
    expect(shouldCapture('interval', 2, 2, 10)).toBe(true);
    expect(shouldCapture('realtime', 0, 2, 10)).toBe(true);
  });
});

describe('probe assignment', () => {
  it('picks the nearest probe whose radius holds the point', () => {
    const near = probe('near', [2, 0, 0], 5);
    const far = probe('far', [-4, 0, 0], 10);
    expect(nearestProbe(new THREE.Vector3(1, 0, 0), [far, near])).toBe(near);
    expect(nearestProbe(new THREE.Vector3(-8, 0, 0), [far, near])).toBe(far);
    expect(nearestProbe(new THREE.Vector3(50, 0, 0), [far, near])).toBeNull();
  });

  it('gives covered meshes a copy of their material with the probe map, and the original back when they leave', () => {
    const shared = new THREE.MeshStandardMaterial({ roughness: 0.2 });
    const inside = shinyMesh([1, 0, 0], shared);
    const outside = shinyMesh([30, 0, 0], shared);
    const unlit = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    const scene = new THREE.Scene();
    scene.add(inside, outside, unlit);
    const entry = probe('a', [0, 0, 0], 5);

    updateProbeAssignments(scene, [entry]);
    const copy = inside.material as THREE.MeshStandardMaterial;
    expect(copy).not.toBe(shared);
    expect(copy.envMap).toBe(entry.texture);
    expect(copy.envMapIntensity).toBe(1.5);
    expect(copy.roughness).toBe(0.2);
    expect(outside.material).toBe(shared);
    expect(shared.envMap).toBeNull();
    expect(unlit.material).toBeInstanceOf(THREE.MeshBasicMaterial);

    inside.position.set(20, 0, 0);
    updateProbeAssignments(scene, [entry]);
    expect(inside.material).toBe(shared);
  });

  it('hands a mesh to the nearer probe, skips uncaptured probes, and lets go when no probe is left', () => {
    const mesh = shinyMesh([3, 0, 0]);
    const original = mesh.material;
    const scene = new THREE.Scene();
    scene.add(mesh);
    const a = probe('a', [0, 0, 0], 10);
    const b = probe('b', [4, 0, 0], 10);
    updateProbeAssignments(scene, [a, b]);
    expect((mesh.material as THREE.MeshStandardMaterial).envMap).toBe(b.texture);
    updateProbeAssignments(scene, [a, { ...b, texture: null }]);
    expect((mesh.material as THREE.MeshStandardMaterial).envMap).toBe(a.texture);
    updateProbeAssignments(scene, []);
    expect(mesh.material).toBe(original);
  });

  it('never lights the probe object itself', () => {
    const host = new THREE.Group();
    const own = shinyMesh([0, 0, 0]);
    host.add(own);
    const scene = new THREE.Scene();
    scene.add(host);
    const original = own.material;
    updateProbeAssignments(scene, [{ ...probe('a', [0, 0, 0], 10), host }]);
    expect(own.material).toBe(original);
  });
});
