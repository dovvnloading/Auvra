import { useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { edgesOf, weldVertices, type SkinnedPart } from '../autoRig/skinWeights';
import { skeletonBones, type SkeletonBone, type SkinBrushMode } from '../skeletonView';
import { boneSlot, fileWeightsOf, markSkinChanged, readModelSkin, type FileWeights, type ModelSkin } from './modelSkin';
import { encodeSkinPaint, NO_PAINTED_BONE, type SkinPaintFile } from './skinPaintFile';
import { addBone, BONES_PER_VERTEX, NO_BONE, removeBone, smoothedVertex, WeightMix, type VertexWeights, type WeightHeirs } from './weights';

/**
 * A model's weights being painted. The brush works on places, not vertices: every vertex standing at one
 * point of the surface, across texture seams, materials and meshes, is one place and always moves as one.
 */

/** Undo goes back this many strokes, or as far as this many places changed. */
const HISTORY_STROKES = 100;
const HISTORY_PLACES = 2_000_000;
/** Shares closer than this are the same: what the brush leaves as it was is not painted. */
const SAME_SHARE = 1e-5;

/** Where a ray from the view met the model. */
export interface SkinPaintHit {
  point: THREE.Vector3;
  /** Of the triangle it met, towards the ray. */
  normal: THREE.Vector3;
  /** The places at the triangle's corners. */
  corners: [number, number, number];
  /** Of those, the nearest to the point. */
  nearest: number;
}

export interface SkinPaintStatus {
  /** Places that differ from the file. */
  painted: number;
  canUndo: boolean;
  canRedo: boolean;
  saving: boolean;
  saveFailed: boolean;
}

/** Stores painted weights; `encode` reads them when they are written, and is null when none are left. */
export type SkinPaintSaver = (encode: () => SkinPaintFile | null) => Promise<void>;

/** What some places were before a change, ready to swap back in. */
interface PaintChange {
  places: Int32Array;
  bones: Int32Array;
  shares: Float32Array;
  edited: Uint8Array;
}

/** What is painted changes how much each bone moves: anything counting that listens here. */
let revision = 0;
const revisionListeners = new Set<() => void>();
const nextRevision = (): void => {
  revision += 1;
  for (const listener of revisionListeners) listener();
};

export const useSkinPaintRevision = (): number => useSyncExternalStore(
  (listener) => {
    revisionListeners.add(listener);
    return () => revisionListeners.delete(listener);
  },
  () => revision,
);

export class SkinPaintSession {
  readonly bones: readonly SkeletonBone[];
  /** Places on the model, after welding. */
  readonly placeCount: number;
  /** Where each place is on screen now, three per place. */
  readonly surface: Float32Array;
  /** The model's longest side, as it first stood. */
  size = 0;

  private readonly skin: ModelSkin;
  private readonly boneNumbers: Map<THREE.Object3D, number>;
  /** For each part, each bone's position on its skeleton; -1 until asked for. */
  private readonly slots: Int32Array[];
  private readonly files: FileWeights[];
  private readonly firstPart: Uint16Array;
  private readonly firstVertex: Uint32Array;
  /** The vertices at place p are members `memberStarts[p]` to `memberStarts[p + 1] - 1`. */
  private readonly memberStarts: Uint32Array;
  private readonly memberParts: Uint16Array;
  private readonly memberVertices: Uint32Array;
  /** The places that share a triangle with place p are `links[linkStarts[p]]` to `links[linkStarts[p + 1] - 1]`. */
  private readonly linkStarts: Uint32Array;
  private readonly links: Int32Array;
  /** Which connected piece of surface each place is on. */
  private readonly pieces: Int32Array;
  /** Each part's triangles, as places. */
  private readonly triangles: Int32Array[];
  private readonly shown: boolean[];
  private readonly weights: VertexWeights;
  private readonly edited: Uint8Array;
  private readonly mix: WeightMix;
  private readonly tally: WeightMix;
  private readonly changedParts: Uint8Array;

  private readonly bounds = new THREE.Box3();
  private readonly seenPoses: Float32Array[] = [];
  private readonly seenPlacing: Float32Array;
  private readonly blends: Float64Array[] = [];
  private surfaceStale = true;

  private readonly marks: Uint32Array;
  private mark = 0;
  private readonly reachPlaces: Int32Array;
  private readonly reachAmounts: Float32Array;
  private smoothed: VertexWeights | null = null;

  /** What a place was before the brush touched it, until it is known whether anything changed. */
  private readonly heldBones = new Int32Array(BONES_PER_VERTEX);
  private readonly heldShares = new Float32Array(BONES_PER_VERTEX);
  private stroking = false;
  private strokeNumber = 0;
  private readonly strokeSeen: Uint32Array;
  private strokePlaces: number[] = [];
  private strokeBones: number[] = [];
  private strokeShares: number[] = [];
  private strokeEdited: number[] = [];

  private readonly past: PaintChange[] = [];
  private readonly future: PaintChange[] = [];
  private paintedCount = 0;

  private saver: SkinPaintSaver | null = null;
  private wantsSave = false;
  private saving: Promise<void> | null = null;
  private saveFailed = false;
  private status: SkinPaintStatus;
  private readonly listeners = new Set<() => void>();

  constructor(root: THREE.Object3D) {
    this.skin = readModelSkin(root);
    const { parts } = this.skin;
    this.bones = skeletonBones(root);
    this.boneNumbers = new Map(this.bones.map((entry, number) => [entry.bone, number]));
    this.slots = parts.map(() => new Int32Array(this.bones.length).fill(-1));
    this.files = parts.map(fileWeightsOf);
    const shapes: SkinnedPart[] = parts.map((part) => ({
      positions: part.rest,
      indices: (part.geometry.index?.array ?? null) as Uint32Array | Uint16Array | null,
    }));
    const { ids, first } = weldVertices(shapes, this.skin.tolerance);
    this.placeCount = first.length;
    this.firstPart = Uint16Array.from(first, (entry) => entry.part);
    this.firstVertex = Uint32Array.from(first, (entry) => entry.vertex);

    this.memberStarts = new Uint32Array(this.placeCount + 1);
    for (const partIds of ids) for (const id of partIds) this.memberStarts[id + 1] += 1;
    for (let place = 0; place < this.placeCount; place += 1) this.memberStarts[place + 1] += this.memberStarts[place];
    this.memberParts = new Uint16Array(this.memberStarts[this.placeCount]);
    this.memberVertices = new Uint32Array(this.memberStarts[this.placeCount]);
    const nextMember = this.memberStarts.slice(0, this.placeCount);
    ids.forEach((partIds, partIndex) => partIds.forEach((id, vertex) => {
      this.memberParts[nextMember[id]] = partIndex;
      this.memberVertices[nextMember[id]] = vertex;
      nextMember[id] += 1;
    }));

    const { starts, links } = edgesOf(shapes, ids, this.placeCount);
    this.linkStarts = starts;
    this.links = links;
    this.pieces = this.piecesOfSurface();
    this.triangles = shapes.map((shape, partIndex) => {
      const partIds = ids[partIndex];
      const corners = shape.indices;
      return corners ? Int32Array.from(corners, (vertex) => partIds[vertex]) : partIds;
    });
    this.shown = parts.map(() => true);

    this.weights = {
      bones: new Int32Array(this.placeCount * BONES_PER_VERTEX).fill(NO_BONE),
      shares: new Float32Array(this.placeCount * BONES_PER_VERTEX),
    };
    this.edited = new Uint8Array(this.placeCount);
    this.mix = new WeightMix(this.bones.length);
    this.tally = new WeightMix(this.bones.length);
    this.changedParts = new Uint8Array(parts.length);
    for (let place = 0; place < this.placeCount; place += 1) {
      this.readPlace(place);
      for (let member = this.memberStarts[place]; member < this.memberStarts[place + 1]; member += 1) {
        if (this.files[this.memberParts[member]].painted[this.memberVertices[member]]) this.edited[place] = 1;
      }
      this.paintedCount += this.edited[place];
    }

    this.surface = new Float32Array(this.placeCount * 3);
    this.seenPlacing = new Float32Array(parts.length * 16);
    this.marks = new Uint32Array(this.placeCount);
    this.reachPlaces = new Int32Array(this.placeCount);
    this.reachAmounts = new Float32Array(this.placeCount);
    this.strokeSeen = new Uint32Array(this.placeCount);
    this.status = this.readStatus();
  }

  /** Whether there is anything skinned to paint. */
  get isEmpty(): boolean {
    return this.placeCount === 0;
  }

  private piecesOfSurface(): Int32Array {
    const pieces = new Int32Array(this.placeCount).fill(-1);
    const stack: number[] = [];
    let piece = 0;
    for (let start = 0; start < this.placeCount; start += 1) {
      if (pieces[start] >= 0) continue;
      pieces[start] = piece;
      stack.push(start);
      while (stack.length) {
        const place = stack.pop()!;
        for (let link = this.linkStarts[place]; link < this.linkStarts[place + 1]; link += 1) {
          const other = this.links[link];
          if (pieces[other] < 0) {
            pieces[other] = piece;
            stack.push(other);
          }
        }
      }
      piece += 1;
    }
    return pieces;
  }

  /** Reads a place's weights from its vertices: their average, should a file have them differ. */
  private readPlace(place: number): void {
    const { parts } = this.skin;
    const firstMember = this.memberStarts[place];
    const lastMember = this.memberStarts[place + 1];
    const each = 1 / Math.max(1, lastMember - firstMember);
    for (let member = firstMember; member < lastMember; member += 1) {
      const part = parts[this.memberParts[member]];
      const vertex = this.memberVertices[member];
      for (let slot = 0; slot < BONES_PER_VERTEX; slot += 1) {
        const share = part.shares[vertex * BONES_PER_VERTEX + slot];
        if (!(share > 0)) continue;
        const number = this.boneNumbers.get(part.mesh.skeleton.bones[part.joints[vertex * BONES_PER_VERTEX + slot]]);
        if (number !== undefined) this.mix.add(number, share * each);
      }
    }
    this.mix.write(this.weights, place);
  }

  private slotOn(partIndex: number, bone: number): number {
    let slot = this.slots[partIndex][bone];
    if (slot < 0) {
      slot = boneSlot(this.skin, this.skin.parts[partIndex], this.bones[bone].bone);
      this.slots[partIndex][bone] = slot;
    }
    return slot;
  }

  /** Writes a place's weights to every vertex at it. */
  private writePlace(place: number): void {
    const at = place * BONES_PER_VERTEX;
    // Nothing to follow would send its vertices to the origin.
    if (this.weights.bones[at] === NO_BONE) return;
    const { parts } = this.skin;
    for (let member = this.memberStarts[place]; member < this.memberStarts[place + 1]; member += 1) {
      const partIndex = this.memberParts[member];
      const part = parts[partIndex];
      const vertexAt = this.memberVertices[member] * BONES_PER_VERTEX;
      for (let slot = 0; slot < BONES_PER_VERTEX; slot += 1) {
        const bone = this.weights.bones[at + slot];
        part.joints[vertexAt + slot] = bone === NO_BONE ? 0 : this.slotOn(partIndex, bone);
        part.shares[vertexAt + slot] = this.weights.shares[at + slot];
      }
      this.changedParts[partIndex] = 1;
    }
  }

  /** Lets the graphics card know, and has the surface read again. */
  private flushWrites(): void {
    this.skin.parts.forEach((part, partIndex) => {
      if (!this.changedParts[partIndex]) return;
      this.changedParts[partIndex] = 0;
      markSkinChanged(part);
    });
    this.surfaceStale = true;
  }

  private setEdited(place: number, edited: number): void {
    this.paintedCount += edited - this.edited[place];
    this.edited[place] = edited;
  }

  /** Moves the surface to the pose last drawn. False when it was there already. */
  updatePose(): boolean {
    const { parts } = this.skin;
    let moved = this.surfaceStale;
    parts.forEach((part, partIndex) => {
      const { mesh } = part;
      let shown = true;
      for (let node: THREE.Object3D | null = mesh; node && shown; node = node.parent) shown = node.visible;
      this.shown[partIndex] = shown;
      mesh.skeleton.update();
      const pose = mesh.skeleton.boneMatrices as Float32Array;
      let seen = this.seenPoses[partIndex];
      if (seen?.length !== pose.length) {
        seen = pose.slice();
        this.seenPoses[partIndex] = seen;
        moved = true;
      } else if (!moved) {
        for (let index = 0; index < pose.length; index += 1) {
          if (seen[index] !== pose[index]) {
            moved = true;
            break;
          }
        }
      }
      if (moved) seen.set(pose);
      for (let index = 0; index < 16; index += 1) {
        const value = mesh.matrixWorld.elements[index];
        if (this.seenPlacing[partIndex * 16 + index] !== value) {
          this.seenPlacing[partIndex * 16 + index] = value;
          moved = true;
        }
      }
    });
    if (!moved) return false;
    this.surfaceStale = false;

    // Each bone's full matrix for each part, then each place from the vertex that stands for it: as the
    // skinning shader does. Blend shapes are left out, as they move a brush too little to notice.
    const toWorld = new THREE.Matrix4();
    const boneMatrix = new THREE.Matrix4();
    parts.forEach((part, partIndex) => {
      const { mesh } = part;
      const pose = mesh.skeleton.boneMatrices as Float32Array;
      const slotCount = mesh.skeleton.bones.length;
      if (this.blends[partIndex]?.length !== slotCount * 12) this.blends[partIndex] = new Float64Array(slotCount * 12);
      const blend = this.blends[partIndex];
      toWorld.multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse);
      for (let slot = 0; slot < slotCount; slot += 1) {
        boneMatrix.fromArray(pose, slot * 16);
        boneMatrix.premultiply(toWorld).multiply(mesh.bindMatrix);
        const e = boneMatrix.elements;
        const at = slot * 12;
        blend[at] = e[0]; blend[at + 1] = e[4]; blend[at + 2] = e[8]; blend[at + 3] = e[12];
        blend[at + 4] = e[1]; blend[at + 5] = e[5]; blend[at + 6] = e[9]; blend[at + 7] = e[13];
        blend[at + 8] = e[2]; blend[at + 9] = e[6]; blend[at + 10] = e[10]; blend[at + 11] = e[14];
      }
    });
    const { surface } = this;
    let minX = Infinity; let minY = Infinity; let minZ = Infinity;
    let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
    for (let place = 0; place < this.placeCount; place += 1) {
      const partIndex = this.firstPart[place];
      const part = parts[partIndex];
      const vertex = this.firstVertex[place];
      const blend = this.blends[partIndex];
      const lx = part.local[vertex * 3];
      const ly = part.local[vertex * 3 + 1];
      const lz = part.local[vertex * 3 + 2];
      let x = 0;
      let y = 0;
      let z = 0;
      for (let slot = 0; slot < BONES_PER_VERTEX; slot += 1) {
        const share = part.shares[vertex * BONES_PER_VERTEX + slot];
        if (!(share > 0)) continue;
        const at = part.joints[vertex * BONES_PER_VERTEX + slot] * 12;
        x += share * (blend[at] * lx + blend[at + 1] * ly + blend[at + 2] * lz + blend[at + 3]);
        y += share * (blend[at + 4] * lx + blend[at + 5] * ly + blend[at + 6] * lz + blend[at + 7]);
        z += share * (blend[at + 8] * lx + blend[at + 9] * ly + blend[at + 10] * lz + blend[at + 11]);
      }
      surface[place * 3] = x;
      surface[place * 3 + 1] = y;
      surface[place * 3 + 2] = z;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    this.bounds.min.set(minX, minY, minZ);
    this.bounds.max.set(maxX, maxY, maxZ);
    if (!this.size && this.placeCount) this.size = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
    return true;
  }

  /** Where a ray first meets the model as it stands now, or null. */
  hitAt(ray: THREE.Ray): SkinPaintHit | null {
    if (!this.placeCount || !ray.intersectsBox(this.bounds)) return null;
    const { surface: p } = this;
    const ox = ray.origin.x; const oy = ray.origin.y; const oz = ray.origin.z;
    const dx = ray.direction.x; const dy = ray.direction.y; const dz = ray.direction.z;
    let best = Infinity;
    let bestList: Int32Array | null = null;
    let bestAt = 0;
    let bestU = 0;
    let bestV = 0;
    for (let partIndex = 0; partIndex < this.triangles.length; partIndex += 1) {
      if (!this.shown[partIndex]) continue;
      const list = this.triangles[partIndex];
      for (let at = 0; at + 2 < list.length; at += 3) {
        const a = list[at] * 3;
        const b = list[at + 1] * 3;
        const c = list[at + 2] * 3;
        const e1x = p[b] - p[a]; const e1y = p[b + 1] - p[a + 1]; const e1z = p[b + 2] - p[a + 2];
        const e2x = p[c] - p[a]; const e2y = p[c + 1] - p[a + 1]; const e2z = p[c + 2] - p[a + 2];
        const px = dy * e2z - dz * e2y; const py = dz * e2x - dx * e2z; const pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det === 0) continue;
        const inverse = 1 / det;
        const sx = ox - p[a]; const sy = oy - p[a + 1]; const sz = oz - p[a + 2];
        const u = (sx * px + sy * py + sz * pz) * inverse;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y; const qy = sz * e1x - sx * e1z; const qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inverse;
        if (v < 0 || u + v > 1) continue;
        const distance = (e2x * qx + e2y * qy + e2z * qz) * inverse;
        if (distance > 0 && distance < best) {
          best = distance;
          bestList = list;
          bestAt = at;
          bestU = u;
          bestV = v;
        }
      }
    }
    if (!bestList) return null;
    const corners: [number, number, number] = [bestList[bestAt], bestList[bestAt + 1], bestList[bestAt + 2]];
    const [a, b, c] = corners;
    const normal = new THREE.Vector3(
      (p[b * 3 + 1] - p[a * 3 + 1]) * (p[c * 3 + 2] - p[a * 3 + 2]) - (p[b * 3 + 2] - p[a * 3 + 2]) * (p[c * 3 + 1] - p[a * 3 + 1]),
      (p[b * 3 + 2] - p[a * 3 + 2]) * (p[c * 3] - p[a * 3]) - (p[b * 3] - p[a * 3]) * (p[c * 3 + 2] - p[a * 3 + 2]),
      (p[b * 3] - p[a * 3]) * (p[c * 3 + 1] - p[a * 3 + 1]) - (p[b * 3 + 1] - p[a * 3 + 1]) * (p[c * 3] - p[a * 3]),
    ).normalize();
    if (normal.dot(ray.direction) > 0) normal.negate();
    return {
      point: new THREE.Vector3(ox + dx * best, oy + dy * best, oz + dz * best),
      normal,
      corners,
      nearest: corners[bestU + bestV < 0.5 ? 0 : bestU > bestV ? 1 : 2],
    };
  }

  /** The bones moving a place, strongest first. */
  influencesAt(place: number): { name: string; share: number }[] {
    const out: { name: string; share: number }[] = [];
    for (let slot = 0; slot < BONES_PER_VERTEX; slot += 1) {
      const bone = this.weights.bones[place * BONES_PER_VERTEX + slot];
      if (bone !== NO_BONE) out.push({ name: this.bones[bone].name, share: this.weights.shares[place * BONES_PER_VERTEX + slot] });
    }
    return out.sort((a, b) => b.share - a.share);
  }

  /**
   * What a brush landing at `hit` reaches, with how much of `strength` each place gets. It follows the
   * surface out from where it landed, so a hand resting on a thigh is not painted with the thigh, and
   * takes anything else in reach that is another piece of the mesh, such as clothes over a body.
   */
  private reach(hit: SkinPaintHit, radius: number, strength: number): number {
    const { surface: p, marks, pieces, reachPlaces, reachAmounts } = this;
    const reachSquared = radius * radius;
    const { x: cx, y: cy, z: cz } = hit.point;
    this.mark += 2;
    const within = this.mark;
    const visited = within + 1;
    const piece = pieces[hit.corners[0]];
    let count = 0;
    const take = (place: number): void => {
      const dx = p[place * 3] - cx;
      const dy = p[place * 3 + 1] - cy;
      const dz = p[place * 3 + 2] - cz;
      const fade = 1 - (dx * dx + dy * dy + dz * dz) / reachSquared;
      reachPlaces[count] = place;
      reachAmounts[count] = strength * fade * fade;
      count += 1;
    };
    for (let place = 0; place < this.placeCount; place += 1) {
      const dx = p[place * 3] - cx;
      const dy = p[place * 3 + 1] - cy;
      const dz = p[place * 3 + 2] - cz;
      if (dx * dx + dy * dy + dz * dz > reachSquared) continue;
      if (pieces[place] === piece) marks[place] = within;
      else take(place);
    }
    const stack: number[] = [];
    for (const corner of hit.corners) {
      if (marks[corner] === within) {
        marks[corner] = visited;
        stack.push(corner);
      }
    }
    while (stack.length) {
      const place = stack.pop()!;
      take(place);
      for (let link = this.linkStarts[place]; link < this.linkStarts[place + 1]; link += 1) {
        const other = this.links[link];
        if (marks[other] === within) {
          marks[other] = visited;
          stack.push(other);
        }
      }
    }
    // A brush smaller than the triangle it lands on still touches its nearest corner.
    if (count === 0) {
      reachPlaces[0] = hit.nearest;
      reachAmounts[0] = strength * 0.5;
      count = 1;
    }
    return count;
  }

  /** What leaves a place that follows nothing else goes to the other bones around it, or to the bone above. */
  private readonly passOn: WeightHeirs = (mix, place, bone, share) => {
    const { tally } = this;
    for (let link = this.linkStarts[place]; link < this.linkStarts[place + 1]; link += 1) tally.addVertex(this.weights, this.links[link], 1, bone);
    const total = tally.total();
    if (total > 0) {
      tally.moveInto(mix, share / total);
      return true;
    }
    const parent = this.bones[bone].parent;
    if (parent < 0) return false;
    mix.add(parent, share);
    return true;
  };

  beginStroke(): void {
    this.stroking = true;
    this.strokeNumber += 1;
    this.strokePlaces = [];
    this.strokeBones = [];
    this.strokeShares = [];
    this.strokeEdited = [];
  }

  private hold(place: number): void {
    const at = place * BONES_PER_VERTEX;
    for (let slot = 0; slot < BONES_PER_VERTEX; slot += 1) {
      this.heldBones[slot] = this.weights.bones[at + slot];
      this.heldShares[slot] = this.weights.shares[at + slot];
    }
  }

  /** Remembers what a place was, held just before the stroke first changed it. */
  private note(place: number): void {
    if (this.strokeSeen[place] === this.strokeNumber) return;
    this.strokeSeen[place] = this.strokeNumber;
    this.strokePlaces.push(place);
    for (let slot = 0; slot < BONES_PER_VERTEX; slot += 1) {
      this.strokeBones.push(this.heldBones[slot]);
      this.strokeShares.push(this.heldShares[slot]);
    }
    this.strokeEdited.push(this.edited[place]);
  }

  /** Takes a touch on a place held before it: left as it was, it is not painted; changed, it goes to its vertices. */
  private settle(place: number): void {
    const { weights, heldBones, heldShares } = this;
    const at = place * BONES_PER_VERTEX;
    let same = true;
    for (let slot = 0; slot < BONES_PER_VERTEX && same; slot += 1) {
      const share = weights.shares[at + slot];
      if (!(share > 0)) continue;
      const held = heldBones.indexOf(weights.bones[at + slot]);
      same = held >= 0 && Math.abs(heldShares[held] - share) < SAME_SHARE;
    }
    for (let slot = 0; slot < BONES_PER_VERTEX && same; slot += 1) {
      if (heldShares[slot] >= SAME_SHARE) same = weights.bones.subarray(at, at + BONES_PER_VERTEX).includes(heldBones[slot]);
    }
    if (same) {
      weights.bones.set(heldBones, at);
      weights.shares.set(heldShares, at);
      return;
    }
    this.note(place);
    this.setEdited(place, 1);
    this.writePlace(place);
  }

  /** One touch of the brush, in the stroke begun last. */
  dab(hit: SkinPaintHit, radius: number, mode: Exclude<SkinBrushMode, 'off'>, boneName: string, strength: number): void {
    const bone = this.bones.findIndex((entry) => entry.name === boneName);
    if (bone < 0) return;
    const count = this.reach(hit, radius, strength);
    const { reachPlaces, reachAmounts, weights, mix } = this;
    if (mode === 'smooth') {
      this.smoothed ??= {
        bones: new Int32Array(this.placeCount * BONES_PER_VERTEX),
        shares: new Float32Array(this.placeCount * BONES_PER_VERTEX),
      };
      const out = this.smoothed;
      // From the weights as they were before this touch, so the order the places come in does not matter.
      for (let index = 0; index < count; index += 1) {
        const place = reachPlaces[index];
        smoothedVertex(weights, place, this.links, this.linkStarts[place], this.linkStarts[place + 1], reachAmounts[index], mix, out, index);
      }
      for (let index = 0; index < count; index += 1) {
        const place = reachPlaces[index];
        this.hold(place);
        for (let slot = 0; slot < BONES_PER_VERTEX; slot += 1) {
          weights.bones[place * BONES_PER_VERTEX + slot] = out.bones[index * BONES_PER_VERTEX + slot];
          weights.shares[place * BONES_PER_VERTEX + slot] = out.shares[index * BONES_PER_VERTEX + slot];
        }
        this.settle(place);
      }
    } else {
      for (let index = 0; index < count; index += 1) {
        const place = reachPlaces[index];
        this.hold(place);
        if (mode === 'add') addBone(weights, place, bone, reachAmounts[index], mix);
        else removeBone(weights, place, bone, reachAmounts[index], mix, this.passOn);
        this.settle(place);
      }
    }
    this.flushWrites();
  }

  /** Ends the stroke, as one step to undo. */
  endStroke(): void {
    this.stroking = false;
    if (!this.strokePlaces.length) return;
    this.past.push({
      places: Int32Array.from(this.strokePlaces),
      bones: Int32Array.from(this.strokeBones),
      shares: Float32Array.from(this.strokeShares),
      edited: Uint8Array.from(this.strokeEdited),
    });
    this.strokePlaces = [];
    this.future.length = 0;
    let places = this.past.reduce((sum, change) => sum + change.places.length, 0);
    while (this.past.length > HISTORY_STROKES || (this.past.length > 1 && places > HISTORY_PLACES)) places -= this.past.shift()!.places.length;
    this.afterChange();
  }

  /** Swaps what a change holds with what its places are now, so the same change serves to undo and to redo. */
  private swap(change: PaintChange): void {
    const { weights } = this;
    change.places.forEach((place, index) => {
      for (let slot = 0; slot < BONES_PER_VERTEX; slot += 1) {
        const from = index * BONES_PER_VERTEX + slot;
        const to = place * BONES_PER_VERTEX + slot;
        const bone = weights.bones[to];
        const share = weights.shares[to];
        weights.bones[to] = change.bones[from];
        weights.shares[to] = change.shares[from];
        change.bones[from] = bone;
        change.shares[from] = share;
      }
      const edited = this.edited[place];
      this.setEdited(place, change.edited[index]);
      change.edited[index] = edited;
      this.writePlace(place);
    });
    this.flushWrites();
  }

  undo(): void {
    // What a stroke under way remembers is measured from what is there now.
    if (this.stroking) return;
    const change = this.past.pop();
    if (!change) return;
    this.swap(change);
    this.future.push(change);
    this.afterChange();
  }

  redo(): void {
    if (this.stroking) return;
    const change = this.future.pop();
    if (!change) return;
    this.swap(change);
    this.past.push(change);
    this.afterChange();
  }

  /** Puts back the weights the model's file gave, as one step to undo. */
  putBack(): void {
    if (!this.paintedCount || this.stroking) return;
    this.beginStroke();
    for (let place = 0; place < this.placeCount; place += 1) {
      if (!this.edited[place]) continue;
      this.hold(place);
      this.note(place);
      for (let member = this.memberStarts[place]; member < this.memberStarts[place + 1]; member += 1) {
        const partIndex = this.memberParts[member];
        const part = this.skin.parts[partIndex];
        const file = this.files[partIndex];
        const at = this.memberVertices[member] * BONES_PER_VERTEX;
        for (let slot = 0; slot < BONES_PER_VERTEX; slot += 1) {
          part.joints[at + slot] = file.joints[at + slot];
          part.shares[at + slot] = file.shares[at + slot];
        }
        this.changedParts[partIndex] = 1;
      }
      this.readPlace(place);
      this.setEdited(place, 0);
    }
    this.flushWrites();
    this.endStroke();
  }

  /** The painted places as a file; null when none are left. */
  private encode(): SkinPaintFile | null {
    if (!this.paintedCount) return null;
    const count = this.paintedCount;
    const boneNames: string[] = [];
    const nameAt = new Map<number, number>();
    const places = new Float32Array(count * 3);
    const bones = new Uint16Array(count * BONES_PER_VERTEX).fill(NO_PAINTED_BONE);
    const shares = new Float32Array(count * BONES_PER_VERTEX);
    let written = 0;
    for (let place = 0; place < this.placeCount; place += 1) {
      if (!this.edited[place]) continue;
      const { rest } = this.skin.parts[this.firstPart[place]];
      const vertex = this.firstVertex[place];
      places[written * 3] = rest[vertex * 3];
      places[written * 3 + 1] = rest[vertex * 3 + 1];
      places[written * 3 + 2] = rest[vertex * 3 + 2];
      for (let slot = 0; slot < BONES_PER_VERTEX; slot += 1) {
        const bone = this.weights.bones[place * BONES_PER_VERTEX + slot];
        if (bone === NO_BONE) continue;
        let name = nameAt.get(bone);
        if (name === undefined) {
          name = boneNames.length;
          boneNames.push(this.bones[bone].name);
          nameAt.set(bone, name);
        }
        bones[written * BONES_PER_VERTEX + slot] = name;
        shares[written * BONES_PER_VERTEX + slot] = this.weights.shares[place * BONES_PER_VERTEX + slot];
      }
      written += 1;
    }
    return encodeSkinPaint({ boneNames, places, bones, shares });
  }

  setSaver(saver: SkinPaintSaver): void {
    this.saver = saver;
  }

  private afterChange(): void {
    nextRevision();
    this.requestSave();
    this.publish();
  }

  /** Saves what is painted now. One save runs at a time, and the last to come reads the newest weights. */
  requestSave(): void {
    if (!this.saver) return;
    this.wantsSave = true;
    this.saving ??= this.runSaves();
  }

  private async runSaves(): Promise<void> {
    while (this.wantsSave && this.saver) {
      this.wantsSave = false;
      this.publish();
      try {
        await this.saver(() => this.encode());
        this.saveFailed = false;
      } catch (error) {
        frontendDiagnostics.failure('skin_paint_save_failed', error);
        this.saveFailed = true;
      }
    }
    this.saving = null;
    this.publish();
  }

  /** Resolves once everything painted so far is stored. */
  async flush(): Promise<void> {
    while (this.saving) await this.saving;
  }

  private readStatus(): SkinPaintStatus {
    return {
      painted: this.paintedCount,
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
      saving: this.saving !== null,
      saveFailed: this.saveFailed,
    };
  }

  private publish(): void {
    this.status = this.readStatus();
    for (const listener of this.listeners) listener();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getStatus = (): SkinPaintStatus => this.status;
}

const sessions = new WeakMap<THREE.Object3D, SkinPaintSession>();

/** A model's painting session, which lasts as long as its loaded object. */
export const skinPaintSession = (root: THREE.Object3D): SkinPaintSession => {
  let session = sessions.get(root);
  if (!session) {
    session = new SkinPaintSession(root);
    sessions.set(root, session);
  }
  return session;
};

/** Resolves once a model's painted weights are stored, if it has been painted at all. */
export const flushSkinPaint = (root: THREE.Object3D): Promise<void> => sessions.get(root)?.flush() ?? Promise.resolve();

export const useSkinPaintStatus = (session: SkinPaintSession): SkinPaintStatus => useSyncExternalStore(session.subscribe, session.getStatus);
