import * as THREE from 'three';
import type { TerrainBrushMask, TerrainGridRect } from './terrainBrush';
import { terrainIndices } from './terrainChunks';

/**
 * TERRAIN LIVE EDIT
 *
 * The heights a terrain's drawn mesh is showing, held where a tool can change them cheaply. A tool
 * edits `heights` and calls writeRegion with the rectangle it touched: only those vertices and their
 * normals are rewritten and sent to the GPU, so a stroke costs what its brush covers whatever the
 * size of the terrain. Nothing here reaches the level until the stroke is committed.
 */
export class TerrainLiveEdit {
  readonly columns: number;
  readonly rows: number;
  /** Sample heights, row by row in PlaneGeometry order. */
  readonly heights: Float32Array;
  private readonly positions: THREE.BufferAttribute;
  private readonly normals: THREE.BufferAttribute;
  private lowest = 0;
  private highest = 0;
  /** Told about every region written, so level-of-detail chunks can follow. */
  onRegion: ((rect: TerrainGridRect) => void) | null = null;
  /** The heights array a tool last committed: when the level hands it back, the mesh already shows it. */
  committed: readonly number[] | null = null;
  /** Cells cut out of the terrain, row by row (segments * segments); null with none. */
  holes: Uint8Array | null = null;
  /** The holes array a tool last committed. */
  committedHoles: readonly number[] | null = null;
  /** Told about every run of cells cut or filled, so level-of-detail chunks can follow. */
  onHoles: ((rect: TerrainGridRect) => void) | null = null;
  /** The ground chosen for the brushes to work on (0-255 per sample). A working aid: lasts until cleared, never saved. */
  regionData: Uint8Array | null = null;
  regionTexture: THREE.DataTexture | null = null;

  constructor(
    private readonly geometry: THREE.BufferGeometry,
    segments: number,
    readonly width: number,
    readonly depth: number,
  ) {
    this.columns = segments + 1;
    this.rows = segments + 1;
    this.heights = new Float32Array(this.columns * this.rows);
    this.positions = geometry.getAttribute('position') as THREE.BufferAttribute;
    this.normals = geometry.getAttribute('normal') as THREE.BufferAttribute;
  }

  /** Shows these heights across the whole terrain (empty or the wrong length: leaves it flat). */
  setAll(values: ArrayLike<number> | null | undefined): void {
    const { heights, positions } = this;
    if (values && values.length === heights.length) {
      for (let index = 0; index < heights.length; index++) heights[index] = values[index];
    } else {
      heights.fill(0);
    }
    const array = positions.array as Float32Array;
    for (let index = 0; index < heights.length; index++) array[index * 3 + 2] = heights[index];
    this.writeNormals({ c0: 0, r0: 0, c1: this.columns - 1, r1: this.rows - 1 });
    positions.clearUpdateRanges();
    this.normals.clearUpdateRanges();
    positions.needsUpdate = true;
    this.normals.needsUpdate = true;
    this.measure();
    this.geometry.computeBoundingSphere();
    this.geometry.computeBoundingBox();
  }

  /** Sends the heights inside `rect` to the mesh. */
  writeRegion(rect: TerrainGridRect): void {
    const { heights, columns, positions, normals } = this;
    const array = positions.array as Float32Array;
    let { lowest, highest } = this;
    const stride = rect.c1 - rect.c0 + 1;
    for (let row = rect.r0; row <= rect.r1; row++) {
      for (let column = rect.c0; column <= rect.c1; column++) {
        const index = row * columns + column;
        const value = heights[index];
        array[index * 3 + 2] = value;
        if (value < lowest) lowest = value;
        if (value > highest) highest = value;
      }
      positions.addUpdateRange((row * columns + rect.c0) * 3, stride * 3);
    }
    positions.needsUpdate = true;
    this.lowest = lowest;
    this.highest = highest;
    this.publishRange();
    // A normal depends on the samples beside it, so the ones just outside the rectangle change too.
    const around: TerrainGridRect = {
      c0: Math.max(0, rect.c0 - 1), r0: Math.max(0, rect.r0 - 1),
      c1: Math.min(columns - 1, rect.c1 + 1), r1: Math.min(this.rows - 1, rect.r1 + 1),
    };
    this.writeNormals(around);
    const aroundStride = around.c1 - around.c0 + 1;
    for (let row = around.r0; row <= around.r1; row++) normals.addUpdateRange((row * columns + around.c0) * 3, aroundStride * 3);
    normals.needsUpdate = true;
    this.onRegion?.(around);
  }

  /** Shows these holes across the whole terrain. */
  setHoles(values: ArrayLike<number> | null | undefined): void {
    const segments = this.columns - 1;
    if (values && values.length === segments * segments) {
      this.holes = this.holes ?? new Uint8Array(segments * segments);
      for (let index = 0; index < values.length; index++) this.holes[index] = values[index] ? 1 : 0;
    } else {
      this.holes = null;
    }
    this.writeHoleIndices();
    this.onHoles?.({ c0: 0, r0: 0, c1: segments - 1, r1: segments - 1 });
  }

  /** Cuts or fills the cells under a brush's weights; true when any changed. */
  markHoles(rect: TerrainGridRect, weights: Float32Array, cut: boolean): boolean {
    const segments = this.columns - 1;
    if (!this.holes && !cut) return false;
    this.holes = this.holes ?? new Uint8Array(segments * segments);
    const { holes } = this;
    let changed = false;
    const stride = rect.c1 - rect.c0 + 1;
    for (let row = rect.r0; row <= Math.min(rect.r1, segments - 1); row++) {
      for (let column = rect.c0; column <= Math.min(rect.c1, segments - 1); column++) {
        if (weights[(row - rect.r0) * stride + column - rect.c0] < 0.5) continue;
        const value = cut ? 1 : 0;
        if (holes[row * segments + column] !== value) {
          holes[row * segments + column] = value;
          changed = true;
        }
      }
    }
    if (changed) this.onHoles?.({ c0: rect.c0, r0: rect.r0, c1: rect.c1, r1: rect.r1 });
    return changed;
  }

  /** Adds to the region under a brush's weights, or takes from it. */
  markRegion({ rect, weights, stride }: TerrainBrushMask, amount: number, remove: boolean): void {
    if (!this.regionData) {
      if (remove) return;
      this.regionData = new Uint8Array(this.columns * this.rows);
      const texture = new THREE.DataTexture(this.regionData, this.columns, this.rows, THREE.RedFormat, THREE.UnsignedByteType);
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearFilter;
      texture.unpackAlignment = 1;
      this.regionTexture = texture;
    }
    const { regionData, columns } = this;
    const step = amount * (remove ? -255 : 255);
    let slot = 0;
    for (let row = rect.r0; row <= rect.r1; row++) {
      for (let column = rect.c0; column < rect.c0 + stride; column++, slot++) {
        if (weights[slot] <= 0) continue;
        const index = row * columns + column;
        regionData[index] = Math.max(0, Math.min(255, Math.round(regionData[index] + step * weights[slot])));
      }
    }
    this.regionTexture!.needsUpdate = true;
  }

  /** A region with nothing left in it is no region. */
  settleRegion(): void {
    if (this.regionData && !this.regionData.some(value => value > 0)) this.clearRegion();
  }

  clearRegion(): void {
    this.regionTexture?.dispose();
    this.regionTexture = null;
    this.regionData = null;
  }

  /** The holes as the level stores them; undefined when none are cut. */
  holesForLevel(): number[] | undefined {
    return this.holes && this.holes.some(value => value > 0) ? Array.from(this.holes) : undefined;
  }

  /** The source mesh's triangles follow the holes: it is what draws a small terrain and what traces light. */
  writeHoleIndices(): void {
    this.geometry.dispose();
    this.geometry.setIndex(new THREE.BufferAttribute(terrainIndices(this.columns - 1, this.holes), 1));
  }

  /** The stroke ended: bounds that only ever grew during it are measured exactly again. */
  settle(): void {
    this.measure();
    this.geometry.computeBoundingSphere();
    this.geometry.computeBoundingBox();
  }

  private writeNormals(rect: TerrainGridRect): void {
    const { heights, columns, rows, width, depth } = this;
    const array = this.normals.array as Float32Array;
    const cellX = width / (columns - 1);
    const cellY = depth / (rows - 1);
    for (let row = rect.r0; row <= rect.r1; row++) {
      const above = Math.max(0, row - 1);
      const below = Math.min(rows - 1, row + 1);
      const spanY = (below - above) * cellY;
      for (let column = rect.c0; column <= rect.c1; column++) {
        const left = Math.max(0, column - 1);
        const right = Math.min(columns - 1, column + 1);
        const dhdx = (heights[row * columns + right] - heights[row * columns + left]) / ((right - left) * cellX);
        // Row grows towards -y.
        const dhdy = (heights[above * columns + column] - heights[below * columns + column]) / spanY;
        const length = Math.sqrt(dhdx * dhdx + dhdy * dhdy + 1);
        const index = (row * columns + column) * 3;
        array[index] = -dhdx / length;
        array[index + 1] = -dhdy / length;
        array[index + 2] = 1 / length;
      }
    }
  }

  private measure(): void {
    let lowest = Infinity;
    let highest = -Infinity;
    const { heights } = this;
    for (let index = 0; index < heights.length; index++) {
      const value = heights[index];
      if (value < lowest) lowest = value;
      if (value > highest) highest = value;
    }
    this.lowest = lowest;
    this.highest = highest;
    this.publishRange();
  }

  private publishRange(): void {
    // Surface placement reads this instead of searching every vertex each time it casts a ray.
    this.geometry.userData.terrainHeightRange = { min: this.lowest, max: this.highest };
  }
}
