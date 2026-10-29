import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCATTER_LAYER, DEFAULT_SCATTER_SETTINGS, MAX_SCATTER_LAYERS, bakeImpostor, cellsOf, clumpNoise, generateScatter, impostorMaterial,
  readScatterSettings, scatterTier, seededRandom, type ScatterGroundQuery, type ScatterLayer, type ScatterSettings,
} from '../../runtime/proceduralScatter';

/*
 * Procedural placement: settings, the seeded placement rules (count, spacing across layers, slope,
 * height, clumping, lean, sink), cells, distance tiers and impostor baking.
 */

const layer = (overrides: Partial<ScatterLayer>): ScatterLayer => ({ ...DEFAULT_SCATTER_LAYER, modelId: 'tree', clump: 0, ...overrides });
const settings = (layers: ScatterLayer[], overrides: Partial<ScatterSettings> = {}): ScatterSettings => ({
  ...DEFAULT_SCATTER_SETTINGS, size: [40, 20, 40], layers, ...overrides,
});

/** Flat ground at height `y`, or ground tilted about Z by `slope` degrees. */
const flat = (y = 0): ScatterGroundQuery => (x, z) => ({ point: new THREE.Vector3(x, y, z), normal: new THREE.Vector3(0, 1, 0), worldY: y });
const tilted = (slope: number): ScatterGroundQuery => {
  const normal = new THREE.Vector3(Math.sin(slope * Math.PI / 180), Math.cos(slope * Math.PI / 180), 0);
  return (x, z) => ({ point: new THREE.Vector3(x, 0, z), normal: normal.clone(), worldY: 0 });
};

const positions = (matrices: THREE.Matrix4[]) => matrices.map(matrix => new THREE.Vector3().setFromMatrixPosition(matrix));

describe('scatter settings', () => {
  it('default, clamp and order every field', () => {
    const read = readScatterSettings({
      size: [0, 5, 1e9], seed: -3, cellSize: 1, impostorDistance: -1, castShadow: 'yes',
      layers: [{ modelId: 'rock', density: -2, scale: [3, 1], slope: [120, 10], collision: 'mesh' }, ...Array.from({ length: 10 }, () => ({}))],
    });
    expect(read.size).toEqual([1, 5, 10000]);
    expect(read.seed).toBe(0);
    expect(read.cellSize).toBe(4);
    expect(read.impostorDistance).toBe(0);
    expect(read.castShadow).toBe(true);
    expect(read.layers).toHaveLength(MAX_SCATTER_LAYERS);
    expect(read.layers[0]).toMatchObject({ modelId: 'rock', density: 0, scale: [1, 3], slope: [10, 90], collision: 'none' });
    expect(readScatterSettings({})).toEqual(DEFAULT_SCATTER_SETTINGS);
  });

  it('draws the same numbers from the same seed', () => {
    const a = seededRandom(42), b = seededRandom(42), c = seededRandom(43);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect([c(), c(), c()]).not.toEqual(first);
    for (const value of first) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    const n = clumpNoise(3.3, 7.7, 1);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(1);
    expect(clumpNoise(3.3, 7.7, 1)).toBe(n);
  });
});

describe('placement', () => {
  it('places about the density asked, within the area, the same way for the same seed', () => {
    const plan = settings([layer({ density: 5, spacing: 0.5 })]);
    const [placed] = generateScatter(plan, flat());
    // 5 per 100 m² over 1600 m².
    expect(placed.length).toBeGreaterThan(70);
    expect(placed.length).toBeLessThanOrEqual(80);
    for (const at of positions(placed)) {
      expect(Math.abs(at.x)).toBeLessThanOrEqual(20);
      expect(Math.abs(at.z)).toBeLessThanOrEqual(20);
    }
    expect(positions(generateScatter(plan, flat())[0])).toEqual(positions(placed));
    expect(positions(generateScatter({ ...plan, seed: 99 }, flat())[0])).not.toEqual(positions(placed));
  });

  it('keeps each layer its spacing from every copy, across layers', () => {
    const plan = settings([layer({ density: 10, spacing: 4 }), layer({ modelId: 'rock', density: 20, spacing: 1 })]);
    const [trees, rocks] = generateScatter(plan, flat()).map(positions);
    for (let i = 0; i < trees.length; i++) {
      for (let j = i + 1; j < trees.length; j++) expect(trees[i].distanceTo(trees[j])).toBeGreaterThanOrEqual(4 - 1e-9);
      for (const rock of rocks) expect(trees[i].distanceTo(rock)).toBeGreaterThanOrEqual(4 - 1e-9);
    }
    expect(rocks.length).toBeGreaterThan(0);
  });

  it('keeps to its slopes and heights, and needs ground', () => {
    const steep = settings([layer({ density: 5, spacing: 0.5, slope: [0, 20] })]);
    expect(generateScatter(steep, tilted(35))[0]).toHaveLength(0);
    expect(generateScatter(steep, tilted(10))[0].length).toBeGreaterThan(0);
    const high = settings([layer({ density: 5, spacing: 0.5, height: [50, 100] })]);
    expect(generateScatter(high, flat(10))[0]).toHaveLength(0);
    expect(generateScatter(high, flat(60))[0].length).toBeGreaterThan(0);
    expect(generateScatter(steep, () => null)[0]).toHaveLength(0);
    // A layer without a model places nothing.
    expect(generateScatter(settings([layer({ modelId: '' })]), flat())[0]).toHaveLength(0);
  });

  it('gathers copies in clumps when asked', () => {
    const spread = (clump: number) => {
      const plan = settings([layer({ density: 20, spacing: 0.1, clump, clumpSize: 8 })], { size: [80, 20, 80] });
      const counts = new Map<string, number>();
      for (const at of positions(generateScatter(plan, flat())[0])) {
        const key = `${Math.floor(at.x / 10)}:${Math.floor(at.z / 10)}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const values = [...counts.values()];
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) / mean;
    };
    // Clumped copies vary far more from patch to patch.
    expect(spread(1)).toBeGreaterThan(spread(0) * 2);
  });

  it('stands copies upright or leans them with the ground, sized and sunk as asked', () => {
    const lean = (align: number) => {
      const [matrices] = generateScatter(settings([layer({ density: 2, spacing: 1, align, slope: [0, 90], scale: [2, 2], sink: -0.5 })]), tilted(30));
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      const position = new THREE.Vector3();
      matrices[0].decompose(position, quaternion, scale);
      return { up: new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion), scale, position };
    };
    const upright = lean(0);
    expect(upright.up.y).toBeCloseTo(1);
    expect(upright.scale.toArray().map(v => +v.toFixed(5))).toEqual([2, 2, 2]);
    expect(upright.position.y).toBeCloseTo(-0.5);
    const leaning = lean(1);
    expect(leaning.up.angleTo(new THREE.Vector3(0, 1, 0)) * 180 / Math.PI).toBeCloseTo(30, 3);
  });
});

describe('cells and distance', () => {
  it('cuts copies into cells, each at the average height of what it holds', () => {
    const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
    const cells = cellsOf([[at(1, 2, 1), at(3, 4, 2), at(30, 0, 1)], [at(2, 6, 3)]], 10);
    expect(cells).toHaveLength(2);
    const near = cells.find(cell => cell.centre.x === 5)!;
    expect(near.layers.map(list => list.length)).toEqual([2, 1]);
    expect(near.centre.y).toBe(4);
    expect(near.radius).toBeCloseTo(10 * Math.SQRT1_2);
  });

  it('switches cells to impostors and then off with distance, without flickering at the edges', () => {
    const plan = { impostorDistance: 50, cullDistance: 200 };
    expect(scatterTier(10, plan, 'full')).toBe('full');
    expect(scatterTier(60, plan, 'full')).toBe('impostor');
    // Back inside the edge, but not by enough to come back.
    expect(scatterTier(48, plan, 'impostor')).toBe('impostor');
    expect(scatterTier(44, plan, 'impostor')).toBe('full');
    expect(scatterTier(250, plan, 'impostor')).toBe('hidden');
    expect(scatterTier(190, plan, 'hidden')).toBe('hidden');
    expect(scatterTier(170, plan, 'hidden')).toBe('impostor');
    expect(scatterTier(1e6, { impostorDistance: 0, cullDistance: 0 }, 'full')).toBe('full');
  });
});

describe('impostors', () => {
  it('bake a model into a picture framed on its bounds, leaving the renderer as it was', () => {
    const calls: string[] = [];
    let target: unknown = 'screen';
    const renderer = {
      shadowMap: { autoUpdate: true },
      getRenderTarget: () => target,
      setRenderTarget: (next: unknown) => { target = next; calls.push('target'); },
      getClearColor: (into: THREE.Color) => into.set(0x123456),
      getClearAlpha: () => 1,
      setClearColor: () => undefined,
      clear: () => { calls.push('clear'); },
      render: (scene: THREE.Scene, camera: THREE.Camera) => { calls.push(`render ${scene.children.length} ${(camera as THREE.OrthographicCamera).isOrthographicCamera}`); },
    } as unknown as THREE.WebGLRenderer;
    const parts = [{ geometry: new THREE.BoxGeometry(2, 6, 1), material: new THREE.MeshStandardMaterial() }];
    const bounds = new THREE.Box3(new THREE.Vector3(-1, 0, -0.5), new THREE.Vector3(1, 6, 0.5));
    const impostor = bakeImpostor(renderer, parts, bounds);
    expect(impostor).toMatchObject({ width: 2, height: 6, left: -1, bottom: 0 });
    // Taller than wide: the picture is too.
    const image = impostor.texture.image as { width: number; height: number };
    expect(image.height).toBeGreaterThan(image.width);
    expect(calls).toContain('render 3 true');
    expect(target).toBe('screen');
    expect(renderer.shadowMap.autoUpdate).toBe(true);
    const material = impostorMaterial(impostor);
    expect(material.uniforms.map.value).toBe(impostor.texture);
    expect((material.uniforms.impostorRect.value as THREE.Vector4).toArray()).toEqual([-1, 0, 2, 6]);
    impostor.dispose();
  });
});
