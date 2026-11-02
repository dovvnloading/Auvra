import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { LoadedModelData } from '../../../types';
import { PHYSICS_IGNORED_USER_DATA } from '../../../runtime/components/physicsComponents';
import { seededRandom } from '../../../runtime/proceduralScatter';
import { splineModelParts, type SplineModelPart } from '../../../runtime/splineMesh';
import type { TerrainLiveEdit } from './terrainLiveEdit';
import type { TerrainGrassVariety, TerrainTextureLayerSettings } from './terrainSplatCodec';

/**
 * TERRAIN GRASS
 *
 * Grass that grows by itself wherever a texture layer is painted. A layer lists models with a density and
 * a distance. Copies are made in cells around the camera from the painted weights, the same each time
 * they are made, and are never stored: repainting a layer repaints its grass, and a whole landscape of it
 * costs nothing in the level's data. A cell is thinned towards the far distance by drawing fewer of its
 * copies, which are in random order, so nearby grass is thick and it fades out rather than ending.
 */

/** Metres across each cell. */
export const GRASS_CELL_SIZE = 16;
/** Seconds between looks at which cells are wanted. */
const CELL_INTERVAL = 0.2;
/** Most cells made in a frame: a cell is a few thousand copies, and walking must not hitch. */
const CELLS_PER_FRAME = 2;
/** Most copies in a cell. */
const MAX_CELL_INSTANCES = 16384;
/** Below this share of a layer, none of its grass grows. */
const MIN_WEIGHT = 0.05;

const GRASS_USER_DATA = { ...PHYSICS_IGNORED_USER_DATA, ignorePlacement: true };

const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _align = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _matrix = new THREE.Matrix4();
const _normal = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _camera = new THREE.Vector3();
const _inverse = new THREE.Matrix4();

export interface GrassSource {
  live: TerrainLiveEdit;
  /** RGBA weights of layers 1 to 4, and 5 to 8. */
  weights: Uint8Array;
  weights2: Uint8Array | null;
  holes: Uint8Array | null;
}

/** A layer's weight (0-1) at a place on the terrain, in samples (fractional). */
const weightAt = (source: GrassSource, layer: number, fx: number, fy: number): number => {
  const { live, weights, weights2 } = source;
  const map = layer < 4 ? weights : weights2;
  if (!map) return layer === 0 ? 1 : 0;
  const channel = layer < 4 ? layer : layer - 4;
  const c0 = Math.min(live.columns - 2, Math.floor(fx));
  const r0 = Math.min(live.rows - 2, Math.floor(fy));
  const tx = fx - c0;
  const ty = fy - r0;
  const read = (column: number, row: number) => map[(row * live.columns + column) * 4 + channel];
  const top = read(c0, r0) * (1 - tx) + read(c0 + 1, r0) * tx;
  const bottom = read(c0, r0 + 1) * (1 - tx) + read(c0 + 1, r0 + 1) * tx;
  return (top * (1 - ty) + bottom * ty) / 255;
};

const heightAt = (live: TerrainLiveEdit, fx: number, fy: number): number => {
  const { heights, columns, rows } = live;
  const c0 = Math.min(columns - 2, Math.floor(fx));
  const r0 = Math.min(rows - 2, Math.floor(fy));
  const tx = fx - c0;
  const ty = fy - r0;
  const top = heights[r0 * columns + c0] * (1 - tx) + heights[r0 * columns + c0 + 1] * tx;
  const bottom = heights[(r0 + 1) * columns + c0] * (1 - tx) + heights[(r0 + 1) * columns + c0 + 1] * tx;
  return top * (1 - ty) + bottom * ty;
};

/**
 * The copies of one kind of grass in one cell, in the terrain object's space (x across, y up, z along the
 * depth) and in random order. `cx`, `cz` is the cell. Worked out from the seed, so a cell comes back the same.
 */
export const grassCellMatrices = (
  source: GrassSource,
  variety: TerrainGrassVariety,
  layer: number,
  cx: number,
  cz: number,
  seed: number,
  /** World metres per local unit across the terrain, so density and cells are in metres. */
  scaleX = 1,
  scaleZ = 1,
): THREE.Matrix4[] => {
  const { live, holes } = source;
  const { width, depth, columns, rows } = live;
  const random = seededRandom(((cx * 73856093) ^ (cz * 19349663) ^ seed) >>> 0);
  const wanted = Math.min(MAX_CELL_INSTANCES, Math.round(variety.density * GRASS_CELL_SIZE * GRASS_CELL_SIZE));
  const cellX = (width * scaleX) / (columns - 1);
  const cellZ = (depth * scaleZ) / (rows - 1);
  const segments = columns - 1;
  const out: THREE.Matrix4[] = [];
  const [low, high] = variety.scale;
  for (let index = 0; index < wanted; index++) {
    // Drawn in full whatever is kept, so a change of paint in one spot does not move the rest of the cell.
    const rx = random();
    const rz = random();
    const keep = random();
    const yaw = random();
    const size = low + (high - low) * random();
    const worldX = (cx + rx) * GRASS_CELL_SIZE;
    const worldZ = (cz + rz) * GRASS_CELL_SIZE;
    const localX = worldX / scaleX;
    const localZ = worldZ / scaleZ;
    if (Math.abs(localX) > width / 2 || Math.abs(localZ) > depth / 2) continue;
    const fx = (localX + width / 2) / (width / (columns - 1));
    const fy = (localZ + depth / 2) / (depth / (rows - 1));
    const weight = weightAt(source, layer, fx, fy);
    if (weight < MIN_WEIGHT || keep > weight) continue;
    if (holes && holes[Math.min(segments - 1, Math.floor(fy)) * segments + Math.min(segments - 1, Math.floor(fx))]) continue;
    const height = heightAt(live, fx, fy);
    _position.set(localX, height, localZ);
    _quaternion.setFromAxisAngle(_up, variety.randomRotation === false ? 0 : yaw * Math.PI * 2);
    if (variety.alignToSurface !== false) {
      const dx = (heightAt(live, Math.min(columns - 1, fx + 1), fy) - heightAt(live, Math.max(0, fx - 1), fy)) / (2 * cellX);
      const dz = (heightAt(live, fx, Math.min(rows - 1, fy + 1)) - heightAt(live, fx, Math.max(0, fy - 1))) / (2 * cellZ);
      _normal.set(-dx, 1, -dz).normalize();
      _align.setFromUnitVectors(_up, _normal);
      _quaternion.premultiply(_align);
    }
    _scale.setScalar(size);
    out.push(new THREE.Matrix4().compose(_position, _quaternion, _scale));
  }
  return out;
};

/** How much of a cell is drawn at this distance from the camera: thinned from the start of the fade to its end. */
export const grassDrawnShare = (distance: number, fadeStart: number, fadeEnd: number): number => {
  if (distance <= fadeStart) return 1;
  if (distance >= fadeEnd) return 0;
  const t = 1 - (distance - fadeStart) / Math.max(1e-3, fadeEnd - fadeStart);
  return t * t;
};

/** One kind of grass in one cell. */
class GrassCell {
  readonly meshes: THREE.InstancedMesh[];
  readonly total: number;
  readonly centre: THREE.Vector3;

  constructor(parts: readonly SplineModelPart[], matrices: readonly THREE.Matrix4[], castShadow: boolean, centre: THREE.Vector3) {
    this.total = matrices.length;
    this.centre = centre;
    this.meshes = parts.map((part) => {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, Math.max(1, matrices.length));
      matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
      mesh.count = matrices.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (matrices.length) mesh.computeBoundingSphere();
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      mesh.userData = GRASS_USER_DATA;
      mesh.raycast = () => undefined;
      return mesh;
    });
  }

  show(share: number): void {
    const count = Math.round(this.total * share);
    for (const mesh of this.meshes) {
      mesh.count = count;
      mesh.visible = count > 0;
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) mesh.dispose();
  }
}

interface GrassEntry {
  variety: TerrainGrassVariety;
  layer: number;
  parts: SplineModelPart[];
  seed: number;
}

interface TerrainGrassProps {
  live: TerrainLiveEdit;
  layers: readonly TerrainTextureLayerSettings[];
  models: readonly LoadedModelData[];
  weights: Uint8Array;
  weights2: Uint8Array | null;
  /** Changes whenever the heights, paint or holes do, so the grass grows again from them. */
  version: unknown;
}

/** The grass of a terrain's layers. Mount inside the terrain object's own group. */
export const TerrainGrass: React.FC<TerrainGrassProps> = ({ live, layers, models, weights, weights2, version }) => {
  const groupRef = useRef<THREE.Group>(null);
  const cells = useRef(new Map<string, GrassCell>());
  const since = useRef(Infinity);

  const entries = useMemo<GrassEntry[]>(() => {
    const found: GrassEntry[] = [];
    layers.forEach((layer, layerIndex) => {
      layer.grass?.forEach((variety, varietyIndex) => {
        const model = models.find(entry => entry.id === variety.modelId);
        if (!model || !(variety.density > 0)) return;
        const parts = splineModelParts(model.object);
        if (parts.length) found.push({ variety, layer: layerIndex, parts, seed: (layerIndex + 1) * 7919 + varietyIndex * 104729 });
      });
    });
    return found;
  }, [layers, models]);

  const clear = () => {
    const group = groupRef.current;
    for (const cell of cells.current.values()) {
      if (group) group.remove(...cell.meshes);
      cell.dispose();
    }
    cells.current.clear();
  };

  // Anything the grass grows from changed: it grows again.
  useEffect(() => {
    clear();
    since.current = Infinity;
  }, [entries, live, weights, weights2, version]);
  useEffect(() => clear, []);

  useFrame(({ camera }, delta) => {
    const group = groupRef.current;
    since.current += delta;
    if (!group || entries.length === 0 || since.current < CELL_INTERVAL) return;
    since.current = 0;
    group.updateWorldMatrix(true, false);
    _camera.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(_inverse.copy(group.matrixWorld).invert());
    const scaleX = Math.max(1e-6, new THREE.Vector3().setFromMatrixColumn(group.matrixWorld, 0).length());
    const scaleZ = Math.max(1e-6, new THREE.Vector3().setFromMatrixColumn(group.matrixWorld, 2).length());
    const cameraX = _camera.x * scaleX;
    const cameraZ = _camera.z * scaleZ;
    const wanted = new Set<string>();
    let made = 0;
    const source: GrassSource = { live, weights, weights2, holes: live.holes };
    entries.forEach((entry, entryIndex) => {
      const { variety } = entry;
      const reach = Math.ceil(variety.fadeEnd / GRASS_CELL_SIZE);
      const homeX = Math.floor(cameraX / GRASS_CELL_SIZE);
      const homeZ = Math.floor(cameraZ / GRASS_CELL_SIZE);
      // Nearest first, so walking fills in around the player before far away.
      const ring: Array<{ cx: number; cz: number; distance: number }> = [];
      for (let i = -reach; i <= reach; i++) {
        for (let j = -reach; j <= reach; j++) {
          const cx = homeX + i;
          const cz = homeZ + j;
          const distance = Math.hypot((cx + 0.5) * GRASS_CELL_SIZE - cameraX, (cz + 0.5) * GRASS_CELL_SIZE - cameraZ) - GRASS_CELL_SIZE * Math.SQRT1_2;
          if (distance < variety.fadeEnd) ring.push({ cx, cz, distance: Math.max(0, distance) });
        }
      }
      ring.sort((a, b) => a.distance - b.distance);
      for (const { cx, cz, distance } of ring) {
        const key = `${entryIndex}:${cx}:${cz}`;
        wanted.add(key);
        let cell = cells.current.get(key);
        if (!cell) {
          if (made >= CELLS_PER_FRAME) continue;
          made++;
          const matrices = grassCellMatrices(source, variety, entry.layer, cx, cz, entry.seed, scaleX, scaleZ);
          cell = new GrassCell(entry.parts, matrices, variety.castShadow === true, new THREE.Vector3((cx + 0.5) * GRASS_CELL_SIZE, 0, (cz + 0.5) * GRASS_CELL_SIZE));
          cells.current.set(key, cell);
          if (cell.total > 0) group.add(...cell.meshes);
        }
        cell.show(grassDrawnShare(distance, variety.fadeStart, variety.fadeEnd));
      }
    });
    for (const [key, cell] of cells.current) {
      if (wanted.has(key)) continue;
      group.remove(...cell.meshes);
      cell.dispose();
      cells.current.delete(key);
    }
  });

  return <group ref={groupRef} userData={GRASS_USER_DATA} />;
};
