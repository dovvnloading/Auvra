/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { GrowableBuffer, RangeAllocator } from "./buffers";

/**
 * THE GEOMETRY POOL
 *
 * Every mesh's vertices and indices in a few long buffers that vertex shaders read directly, so drawing a
 * different mesh is a different range rather than a different buffer: what makes one indirect draw per
 * mesh cheap, and what lets compute passes reach any vertex.
 *
 * A vertex is ten words (see VERTEX_WGSL): position, normal and tangent packed octahedrally, two uv sets,
 * and a colour. Skin weights and morph deltas live in their own tables, read only by the skinning pass,
 * which writes what it poses back into the same vertex table.
 *
 * Geometries that share attributes share the place they are kept. Vertices go by the position attribute: a detail
 * level or a terrain chunk is the same vertices over other indices, so it costs only those indices. Indices go by
 * the index attribute, and a geometry holds on to the few it has used, so that swapping back to one (what a terrain
 * chunk does as the camera moves) changes which range is drawn and sends nothing to the graphics card.
 */

export const VERTEX_WORDS = 10;
export const VERTEX_BYTES = VERTEX_WORDS * 4;
export const SKIN_WORDS = 3;
export const MORPH_WORDS = 6;

export const VERTEX_WGSL = /* wgsl */ `
struct Vertex {
  px: f32, py: f32, pz: f32,
  normal: u32,
  tangent: u32,
  u0: f32, v0: f32,
  u1: f32, v1: f32,
  color: u32,
}
struct SkinVertex { joints0: u32, joints1: u32, weights: u32 }
struct MorphVertex { px: f32, py: f32, pz: f32, nx: f32, ny: f32, nz: f32 }
`;

const INITIAL_VERTICES = 1 << 17;
const INITIAL_INDICES = 1 << 19;
/** Index lists one geometry keeps in the pool while it is using another: a terrain chunk has four. */
const HELD_INDEX_LISTS = 8;
/** Past this many separate changed ranges in an attribute, the whole of it goes up instead. */
const MAX_PARTIAL_RANGES = 32;

type AnyAttribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

/** Where one range of a geometry's triangles or lines lies in the index buffer. */
export interface DrawRange {
  firstIndex: number;
  indexCount: number;
}

/** A place in the vertex, skin and morph tables, and the geometries drawn from it. */
export interface VertexRun {
  position: AnyAttribute;
  normal: AnyAttribute | undefined;
  tangent: AnyAttribute | undefined;
  uv: AnyAttribute | undefined;
  uv1: AnyAttribute | undefined;
  color: AnyAttribute | undefined;
  skinIndex: AnyAttribute | undefined;
  skinWeight: AnyAttribute | undefined;
  morphPositions: AnyAttribute[] | undefined;
  morphNormals: AnyAttribute[] | undefined;
  morphRelative: boolean;
  vertexBase: number;
  vertexCount: number;
  skinBase: number;
  skinCount: number;
  morphBase: number;
  morphTargets: number;
  /** The geometries using the run; it is given back with the last of them. */
  users: GeometryEntry[];
  version: number;
  attributeVersions: number[];
  /** How many times the vertices were sent again. */
  edits: number;
  checked: number;
}

/** One index attribute's place in the index buffer (or a run of counting numbers, for a geometry without one). */
export interface IndexList {
  source: THREE.BufferAttribute | null;
  base: number;
  count: number;
  refs: number;
  version: number;
}

export interface GeometryEntry {
  geometry: THREE.BufferGeometry;
  vertexBase: number;
  vertexCount: number;
  indexBase: number;
  indexCount: number;
  /** Lazily made list of edges, for wireframes. */
  wire: DrawRange | null;
  /** Each edge pair of a line strip or loop, for Line objects. */
  strip: DrawRange | null;
  skinBase: number;
  skinCount: number;
  morphBase: number;
  morphTargets: number;
  morphRelative: boolean;
  /** Sum of the attribute versions at the last upload. */
  version: number;
  sphere: THREE.Sphere;
  /** Goes up when any range above moved or was replaced: whoever copied one reads it again. */
  placement: number;
  /** Its triangles or its vertex count changed after it came in, so detail levels made from it no longer fit. */
  reshaped: boolean;
  /** How many times its vertices were sent again. */
  vertexEdits: number;
  /** Freed with its geometry. Drawn again, the geometry comes back as a new entry. */
  released: boolean;
  /** It has detail levels over its own vertices, so it is not alone in its run for any other reason. */
  hasLevels: boolean;
  run: VertexRun;
  indexList: IndexList;
  /** Index lists it holds, the longest unused first. */
  heldIndexLists: IndexList[];
  checked: number;
}

const packOctahedral = (x: number, y: number, z: number): number => {
  const length = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / length;
  let v = y / length;
  if (z < 0) {
    const ou = u;
    u = (1 - Math.abs(v)) * (ou >= 0 ? 1 : -1);
    v = (1 - Math.abs(ou)) * (v >= 0 ? 1 : -1);
  }
  const su = Math.round(Math.max(-1, Math.min(1, u)) * 32767) & 0xffff;
  const sv = Math.round(Math.max(-1, Math.min(1, v)) * 32767) & 0xffff;
  return (su | (sv << 16)) >>> 0;
};

const clampByte = (value: number): number => Math.max(0, Math.min(255, Math.round(value * 255)));

const _weightShare = [0, 0, 0, 0];
const _weightByte = [0, 0, 0, 0];

/**
 * Four skin weights as a word, one byte each. Rounding one by one could leave weights that add up to slightly more or
 * less than they did, and skinning scales a vertex about the world's origin by that sum: far from the origin that is
 * a visible jump. So what rounding loses goes to the weights that lost the most, and the sum stays what it was.
 */
const packWeights = (a: number, b: number, c: number, d: number): number => {
  _weightShare[0] = a * 255;
  _weightShare[1] = b * 255;
  _weightShare[2] = c * 255;
  _weightShare[3] = d * 255;
  let given = 0;
  for (let at = 0; at < 4; at++) {
    _weightByte[at] = Math.max(0, Math.min(255, Math.floor(_weightShare[at])));
    _weightShare[at] -= _weightByte[at];
    given += _weightByte[at];
  }
  let left = Math.round(a * 255 + b * 255 + c * 255 + d * 255) - given;
  while (left > 0) {
    let most = 0;
    for (let at = 1; at < 4; at++) if (_weightShare[at] > _weightShare[most]) most = at;
    if (_weightByte[most] === 255) break;
    _weightByte[most]++;
    _weightShare[most] = -1;
    left--;
  }
  return (_weightByte[0] | (_weightByte[1] << 8) | (_weightByte[2] << 16) | (_weightByte[3] << 24)) >>> 0;
};

const versionOf = (attribute: AnyAttribute | undefined | null): number => {
  if (!attribute) return 0;
  const interleaved = attribute as THREE.InterleavedBufferAttribute;
  return interleaved.isInterleavedBufferAttribute ? interleaved.data.version : (attribute as THREE.BufferAttribute).version;
};

const clearUpdateRanges = (attribute: AnyAttribute | undefined): void => {
  if (!attribute) return;
  const interleaved = attribute as THREE.InterleavedBufferAttribute;
  if (interleaved.isInterleavedBufferAttribute) interleaved.data.clearUpdateRanges?.();
  else (attribute as THREE.BufferAttribute).clearUpdateRanges?.();
};

/** The attributes of a vertex, in the order `attributeVersions` holds them; skin and morph come after. */
const VERTEX_ATTRIBUTES = ["position", "normal", "tangent", "uv", "uv1", "color"] as const;
const AT_SKIN_INDEX = VERTEX_ATTRIBUTES.length;
const AT_SKIN_WEIGHT = AT_SKIN_INDEX + 1;
const AT_MORPHS = AT_SKIN_WEIGHT + 1;
const VERSION_SLOTS = AT_MORPHS + 1;

const morphVersion = (geometry: THREE.BufferGeometry): number => {
  const { position, normal } = geometry.morphAttributes as Record<string, AnyAttribute[] | undefined>;
  let sum = 0;
  if (position) for (let at = 0; at < position.length; at++) sum += versionOf(position[at]);
  if (normal) for (let at = 0; at < normal.length; at++) sum += versionOf(normal[at]);
  return sum;
};

/** Sum of the versions of what lives in a vertex run: the fast look for whether anything changed. */
const runVersion = (geometry: THREE.BufferGeometry): number => {
  const { attributes } = geometry;
  return versionOf(attributes.position) + versionOf(attributes.normal) + versionOf(attributes.tangent) + versionOf(attributes.uv) + versionOf(attributes.uv1)
    + versionOf(attributes.color) + versionOf(attributes.skinIndex) + versionOf(attributes.skinWeight) + morphVersion(geometry);
};

const noteVersions = (run: VertexRun, geometry: THREE.BufferGeometry): void => {
  const { attributes } = geometry;
  for (let at = 0; at < VERTEX_ATTRIBUTES.length; at++) run.attributeVersions[at] = versionOf(attributes[VERTEX_ATTRIBUTES[at]] as AnyAttribute | undefined);
  run.attributeVersions[AT_SKIN_INDEX] = versionOf(attributes.skinIndex as AnyAttribute | undefined);
  run.attributeVersions[AT_SKIN_WEIGHT] = versionOf(attributes.skinWeight as AnyAttribute | undefined);
  run.attributeVersions[AT_MORPHS] = morphVersion(geometry);
};

export class GeometryPool {
  readonly vertices: GrowableBuffer;
  readonly indices: GrowableBuffer;
  readonly skins: GrowableBuffer;
  readonly morphs: GrowableBuffer;
  /** Positions of posed vertices one frame ago, three floats each, read for motion. */
  readonly previousPositions: GrowableBuffer;
  readonly vertexAllocator = new RangeAllocator();
  readonly previousAllocator = new RangeAllocator();
  private readonly indexAllocator = new RangeAllocator();
  private readonly skinAllocator = new RangeAllocator();
  private readonly morphAllocator = new RangeAllocator();
  private readonly entries = new WeakMap<THREE.BufferGeometry, GeometryEntry>();
  private readonly runs = new WeakMap<AnyAttribute, VertexRun>();
  private readonly indexLists = new WeakMap<THREE.BufferAttribute, IndexList>();
  private vertexScratch = new ArrayBuffer(VERTEX_BYTES * 1024);
  private scratchFloats = new Float32Array(this.vertexScratch);
  private scratchWords = new Uint32Array(this.vertexScratch);
  private readonly changedRanges: number[] = [];
  /** Each entry and run is looked at for changes once per stamp. */
  private stamp = 0;

  /** Goes up when any of the buffers changed, so bind groups over them are made again. */
  get generation(): number {
    return this.vertices.generation + this.indices.generation + this.skins.generation + this.morphs.generation + this.previousPositions.generation;
  }

  constructor(private readonly device: GPUDevice) {
    this.vertices = new GrowableBuffer(device, "gpu vertices", GPUBufferUsage.STORAGE, INITIAL_VERTICES * VERTEX_BYTES);
    this.indices = new GrowableBuffer(device, "gpu indices", GPUBufferUsage.INDEX | GPUBufferUsage.STORAGE, INITIAL_INDICES * 4);
    this.skins = new GrowableBuffer(device, "gpu skin weights", GPUBufferUsage.STORAGE, 1024 * SKIN_WORDS * 4);
    this.morphs = new GrowableBuffer(device, "gpu morph deltas", GPUBufferUsage.STORAGE, 1024 * MORPH_WORDS * 4);
    this.previousPositions = new GrowableBuffer(device, "gpu previous positions", GPUBufferUsage.STORAGE, 1024 * 12);
  }

  /** Starts a frame's looking: from here on each geometry is compared with what was sent once. */
  beginFrame(): void {
    this.stamp++;
  }

  /** The geometry's place in the pool, uploaded or brought up to date as needed. */
  acquire(geometry: THREE.BufferGeometry): GeometryEntry | null {
    const position = geometry.attributes.position;
    if (!position) return null;
    const entry = this.entries.get(geometry);
    if (!entry) return this.upload(geometry);
    return this.check(entry);
  }

  /**
   * Brings an entry already held up to date: the cheap form of `acquire`, for what looks every frame. An index
   * attribute swapped for one seen before only moves the entry's range. Look at `released` after: a freed geometry's
   * entry stays freed, and `acquire` gives its new one.
   */
  check(entry: GeometryEntry): GeometryEntry {
    if (entry.checked === this.stamp || entry.released) return entry;
    entry.checked = this.stamp;
    const { geometry } = entry;
    if (!geometry.attributes.position) {
      this.release(geometry);
      return entry;
    }
    let { run } = entry;
    if (!this.fits(run, geometry)) {
      // Attributes were replaced: what the geometry draws from is now somewhere else.
      this.leaveRun(entry);
      run = this.runFor(geometry);
      this.joinRun(entry, run);
      entry.reshaped = true;
      entry.placement++;
    } else if (run.checked !== this.stamp) {
      run.checked = this.stamp;
      const version = runVersion(geometry);
      if (version !== run.version) this.refreshRun(run, geometry, version);
    }
    const { index } = geometry;
    const list = entry.indexList;
    if (index !== list.source || (!index && list.count !== entry.vertexCount)) {
      this.useIndex(entry, index);
      entry.reshaped = true;
    } else if (index && index.version !== list.version) {
      this.fillIndices(index, list.base, list.count);
      list.version = index.version;
      this.dropEdges(entry);
      entry.reshaped = true;
      entry.placement++;
    }
    entry.version = run.version + versionOf(index);
    if (geometry.boundingSphere) entry.sphere = geometry.boundingSphere;
    return entry;
  }

  private upload(geometry: THREE.BufferGeometry): GeometryEntry {
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    const run = this.runFor(geometry);
    const entry: GeometryEntry = {
      geometry,
      vertexBase: 0,
      vertexCount: 0,
      indexBase: 0,
      indexCount: 0,
      wire: null,
      strip: null,
      skinBase: 0,
      skinCount: 0,
      morphBase: 0,
      morphTargets: 0,
      morphRelative: geometry.morphTargetsRelative,
      version: 0,
      sphere: geometry.boundingSphere ?? new THREE.Sphere(new THREE.Vector3(), 0),
      placement: 0,
      reshaped: false,
      vertexEdits: 0,
      released: false,
      hasLevels: false,
      run,
      indexList: null as unknown as IndexList,
      heldIndexLists: [],
      checked: this.stamp,
    };
    this.joinRun(entry, run);
    this.useIndex(entry, geometry.index);
    entry.version = run.version + versionOf(geometry.index);
    this.entries.set(geometry, entry);
    geometry.addEventListener("dispose", this.onDispose);
    return entry;
  }

  private readonly onDispose = (event: { target?: unknown }): void => {
    const geometry = event.target as THREE.BufferGeometry;
    geometry.removeEventListener("dispose", this.onDispose);
    this.release(geometry);
  };

  /** Whether `run` holds what `geometry` would draw: the same attributes, not merely the same positions. */
  private fits(run: VertexRun, geometry: THREE.BufferGeometry): boolean {
    const { attributes, morphAttributes } = geometry;
    return run.position === attributes.position && run.normal === attributes.normal && run.tangent === attributes.tangent
      && run.uv === attributes.uv && run.uv1 === attributes.uv1 && run.color === attributes.color
      && run.skinIndex === attributes.skinIndex && run.skinWeight === attributes.skinWeight
      && run.morphPositions === morphAttributes.position && run.morphNormals === morphAttributes.normal
      && run.morphRelative === geometry.morphTargetsRelative;
  }

  private runFor(geometry: THREE.BufferGeometry): VertexRun {
    const position = geometry.attributes.position as AnyAttribute;
    const known = this.runs.get(position);
    if (known && this.fits(known, geometry)) return known;
    const run = this.makeRun(geometry);
    // Positions shared by geometries that differ in something else: the first keeps the shared place, the rest their own.
    if (!known) this.runs.set(position, run);
    return run;
  }

  private makeRun(geometry: THREE.BufferGeometry): VertexRun {
    const attributes = geometry.attributes as Record<string, AnyAttribute | undefined>;
    const morphs = geometry.morphAttributes as Record<string, AnyAttribute[] | undefined>;
    const position = attributes.position as AnyAttribute;
    const vertexCount = position.count;
    const vertexBase = this.vertexAllocator.allocate(vertexCount);
    this.vertices.ensure((vertexBase + vertexCount) * VERTEX_BYTES);
    this.writeVertices(geometry, vertexBase, vertexCount);
    const run: VertexRun = {
      position,
      normal: attributes.normal,
      tangent: attributes.tangent,
      uv: attributes.uv,
      uv1: attributes.uv1,
      color: attributes.color,
      skinIndex: attributes.skinIndex,
      skinWeight: attributes.skinWeight,
      morphPositions: morphs.position,
      morphNormals: morphs.normal,
      morphRelative: geometry.morphTargetsRelative,
      vertexBase,
      vertexCount,
      skinBase: 0,
      skinCount: 0,
      morphBase: 0,
      morphTargets: 0,
      users: [],
      version: runVersion(geometry),
      attributeVersions: new Array<number>(VERSION_SLOTS).fill(0),
      edits: 0,
      checked: this.stamp,
    };
    noteVersions(run, geometry);
    this.writeSkin(geometry, run);
    this.writeMorphs(geometry, run);
    this.clearRanges(geometry);
    return run;
  }

  private copyRun(entry: GeometryEntry, run: VertexRun): void {
    entry.vertexBase = run.vertexBase;
    entry.vertexCount = run.vertexCount;
    entry.skinBase = run.skinBase;
    entry.skinCount = run.skinCount;
    entry.morphBase = run.morphBase;
    entry.morphTargets = run.morphTargets;
    entry.morphRelative = run.morphRelative;
    entry.vertexEdits = run.edits;
  }

  private joinRun(entry: GeometryEntry, run: VertexRun): void {
    entry.run = run;
    run.users.push(entry);
    this.copyRun(entry, run);
  }

  /** Stops using a run, giving it back when no other geometry draws from it. */
  private leaveRun(entry: GeometryEntry): void {
    const { run } = entry;
    const at = run.users.indexOf(entry);
    if (at >= 0) run.users.splice(at, 1);
    if (run.users.length) return;
    if (this.runs.get(run.position) === run) this.runs.delete(run.position);
    this.vertexAllocator.release(run.vertexBase, run.vertexCount);
    if (run.skinCount) this.skinAllocator.release(run.skinBase, run.skinCount);
    if (run.morphTargets) this.morphAllocator.release(run.morphBase, run.morphTargets * run.vertexCount);
  }

  /** What is in the run changed. Every geometry on it sees the same new vertices. */
  private refreshRun(run: VertexRun, geometry: THREE.BufferGeometry, version: number): void {
    const vertexCount = (geometry.attributes.position as AnyAttribute).count;
    const resized = vertexCount !== run.vertexCount;
    const skinChanged = resized || versionOf(geometry.attributes.skinIndex as AnyAttribute | undefined) !== run.attributeVersions[AT_SKIN_INDEX]
      || versionOf(geometry.attributes.skinWeight as AnyAttribute | undefined) !== run.attributeVersions[AT_SKIN_WEIGHT];
    const morphsChanged = resized || morphVersion(geometry) !== run.attributeVersions[AT_MORPHS];
    // The old count gives the morph table's run back, so those go before the count changes.
    if (skinChanged && run.skinCount) {
      this.skinAllocator.release(run.skinBase, run.skinCount);
      run.skinCount = 0;
    }
    if (morphsChanged && run.morphTargets) {
      this.morphAllocator.release(run.morphBase, run.morphTargets * run.vertexCount);
      run.morphTargets = 0;
    }
    if (resized) {
      this.vertexAllocator.release(run.vertexBase, run.vertexCount);
      run.vertexBase = this.vertexAllocator.allocate(vertexCount);
      run.vertexCount = vertexCount;
      this.vertices.ensure((run.vertexBase + vertexCount) * VERTEX_BYTES);
      this.writeVertices(geometry, run.vertexBase, vertexCount);
    } else if (!this.writeChangedRanges(run, geometry)) {
      this.writeVertices(geometry, run.vertexBase, vertexCount);
    }
    if (skinChanged) this.writeSkin(geometry, run);
    if (morphsChanged) this.writeMorphs(geometry, run);
    noteVersions(run, geometry);
    this.clearRanges(geometry);
    run.version = version;
    run.edits++;
    for (let at = 0; at < run.users.length; at++) {
      const user = run.users[at];
      this.copyRun(user, run);
      if (resized) {
        user.reshaped = true;
        user.placement++;
      }
    }
  }

  /**
   * Sends only the vertices an attribute's update ranges cover, which is what a trail that adds a quad a frame asks
   * for. Returns false when something changed that names no ranges, and so all of it has to go.
   */
  private writeChangedRanges(run: VertexRun, geometry: THREE.BufferGeometry): boolean {
    const ranges = this.changedRanges;
    ranges.length = 0;
    for (let at = 0; at < VERTEX_ATTRIBUTES.length; at++) {
      const attribute = geometry.attributes[VERTEX_ATTRIBUTES[at]] as AnyAttribute | undefined;
      if (!attribute || versionOf(attribute) === run.attributeVersions[at]) continue;
      const plain = attribute as THREE.BufferAttribute;
      const named = plain.isBufferAttribute ? plain.updateRanges : undefined;
      if (!named?.length || named.length > MAX_PARTIAL_RANGES) return false;
      for (let which = 0; which < named.length; which++) {
        const { start, count } = named[which];
        let first = Math.floor(start / plain.itemSize);
        let last = Math.ceil((start + count) / plain.itemSize);
        // Ranges that touch become one, so that two attributes naming the same vertices send them once.
        for (let other = ranges.length - 2; other >= 0; other -= 2) {
          if (first > ranges[other + 1] || last < ranges[other]) continue;
          first = Math.min(first, ranges[other]);
          last = Math.max(last, ranges[other + 1]);
          ranges.splice(other, 2);
        }
        ranges.push(first, last);
      }
    }
    for (let at = 0; at < ranges.length; at += 2) {
      const first = Math.max(0, ranges[at]);
      const last = Math.min(run.vertexCount, ranges[at + 1]);
      if (last > first) this.writeVertices(geometry, run.vertexBase, last - first, first);
    }
    return true;
  }

  private clearRanges(geometry: THREE.BufferGeometry): void {
    for (let at = 0; at < VERTEX_ATTRIBUTES.length; at++) clearUpdateRanges(geometry.attributes[VERTEX_ATTRIBUTES[at]] as AnyAttribute | undefined);
  }

  /** Writes `vertexCount` vertices from `firstVertex` on, to where they lie in the run starting at `vertexBase`. */
  private writeVertices(geometry: THREE.BufferGeometry, vertexBase: number, vertexCount: number, firstVertex = 0): void {
    const needed = vertexCount * VERTEX_BYTES;
    if (this.vertexScratch.byteLength < needed) {
      this.vertexScratch = new ArrayBuffer(needed);
      this.scratchFloats = new Float32Array(this.vertexScratch);
      this.scratchWords = new Uint32Array(this.vertexScratch);
    }
    const floats = this.scratchFloats;
    const words = this.scratchWords;
    const { position, normal, tangent, uv, uv1, color } = geometry.attributes as Record<string, AnyAttribute | undefined>;
    const fastPosition = position && !(position as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
      && position.array instanceof Float32Array && position.itemSize === 3 ? position.array as Float32Array : null;
    const end = firstVertex + vertexCount;
    for (let vertex = firstVertex, at = 0; vertex < end; vertex++, at += VERTEX_WORDS) {
      if (fastPosition) {
        floats[at] = fastPosition[vertex * 3];
        floats[at + 1] = fastPosition[vertex * 3 + 1];
        floats[at + 2] = fastPosition[vertex * 3 + 2];
      } else {
        floats[at] = position!.getX(vertex);
        floats[at + 1] = position!.getY(vertex);
        floats[at + 2] = position!.getZ(vertex);
      }
      words[at + 3] = normal ? packOctahedral(normal.getX(vertex), normal.getY(vertex), normal.getZ(vertex)) : packOctahedral(0, 1, 0);
      if (tangent) {
        // The lowest bit of the second half holds the bitangent's sign; a zero tangent word means "none".
        const packed = packOctahedral(tangent.getX(vertex), tangent.getY(vertex), tangent.getZ(vertex));
        words[at + 4] = ((packed & 0xfffeffff) | (tangent.getW(vertex) < 0 ? 0 : 0x10000) | 1) >>> 0;
      } else {
        words[at + 4] = 0;
      }
      floats[at + 5] = uv ? uv.getX(vertex) : 0;
      floats[at + 6] = uv ? uv.getY(vertex) : 0;
      floats[at + 7] = uv1 ? uv1.getX(vertex) : (uv ? uv.getX(vertex) : 0);
      floats[at + 8] = uv1 ? uv1.getY(vertex) : (uv ? uv.getY(vertex) : 0);
      if (color) {
        const alpha = color.itemSize >= 4 ? color.getW(vertex) : 1;
        words[at + 9] = (clampByte(color.getX(vertex)) | (clampByte(color.getY(vertex)) << 8) | (clampByte(color.getZ(vertex)) << 16) | (clampByte(alpha) << 24)) >>> 0;
      } else {
        words[at + 9] = 0xffffffff;
      }
    }
    this.device.queue.writeBuffer(this.vertices.buffer, (vertexBase + firstVertex) * VERTEX_BYTES, this.vertexScratch, 0, needed);
  }

  /**
   * Has the entry draw `index` (or counting numbers, for none). One it has used before, or that another geometry
   * shares, is already there: only the range moves. Nothing here moves any other geometry's drawing.
   */
  private useIndex(entry: GeometryEntry, index: THREE.BufferAttribute | null): void {
    const held = entry.heldIndexLists;
    let list: IndexList | null = null;
    for (let at = 0; at < held.length; at++) {
      const candidate = held[at];
      if (candidate.source === index && (index || candidate.count === entry.vertexCount)) {
        list = candidate;
        // Last in the list is the most recently used.
        held.splice(at, 1);
        held.push(candidate);
        break;
      }
    }
    if (!list) {
      list = this.indexListFor(index, entry.vertexCount);
      held.push(list);
      if (held.length > HELD_INDEX_LISTS) this.dropIndexList(held.shift() as IndexList);
    } else if (index && index.version !== list.version) {
      this.fillIndices(index, list.base, list.count);
      list.version = index.version;
    }
    entry.indexList = list;
    entry.indexBase = list.base;
    entry.indexCount = list.count;
    this.dropEdges(entry);
    entry.placement++;
  }

  private indexListFor(index: THREE.BufferAttribute | null, vertexCount: number): IndexList {
    if (index) {
      const known = this.indexLists.get(index);
      if (known) {
        known.refs++;
        return known;
      }
    }
    const count = index ? index.count : vertexCount;
    const base = this.indexAllocator.allocate(count);
    this.indices.ensure((base + count) * 4);
    this.fillIndices(index, base, count);
    const list: IndexList = { source: index, base, count, refs: 1, version: index ? index.version : 0 };
    if (index) this.indexLists.set(index, list);
    return list;
  }

  private dropIndexList(list: IndexList): void {
    if (--list.refs > 0) return;
    this.indexAllocator.release(list.base, list.count);
    if (list.source) this.indexLists.delete(list.source);
  }

  private fillIndices(source: THREE.BufferAttribute | null, indexBase: number, indexCount: number): void {
    const data = new Uint32Array(indexCount);
    if (source) {
      data.set(source.array as ArrayLike<number>);
    } else {
      for (let index = 0; index < indexCount; index++) data[index] = index;
    }
    this.device.queue.writeBuffer(this.indices.buffer, indexBase * 4, data);
  }

  /** Edges were made from the indices, which have changed. */
  private dropEdges(entry: GeometryEntry): void {
    if (entry.wire) this.indexAllocator.release(entry.wire.firstIndex, entry.wire.indexCount);
    if (entry.strip) this.indexAllocator.release(entry.strip.firstIndex, entry.strip.indexCount);
    entry.wire = null;
    entry.strip = null;
  }

  private writeSkin(geometry: THREE.BufferGeometry, run: VertexRun): void {
    const { skinIndex, skinWeight } = geometry.attributes as Record<string, AnyAttribute | undefined>;
    if (!skinIndex || !skinWeight) return;
    run.skinCount = run.vertexCount;
    run.skinBase = this.skinAllocator.allocate(run.skinCount);
    this.skins.ensure((run.skinBase + run.skinCount) * SKIN_WORDS * 4);
    const data = new Uint32Array(run.skinCount * SKIN_WORDS);
    for (let vertex = 0, at = 0; vertex < run.skinCount; vertex++, at += SKIN_WORDS) {
      data[at] = ((skinIndex.getX(vertex) & 0xffff) | (skinIndex.getY(vertex) << 16)) >>> 0;
      data[at + 1] = ((skinIndex.getZ(vertex) & 0xffff) | (skinIndex.getW(vertex) << 16)) >>> 0;
      data[at + 2] = packWeights(skinWeight.getX(vertex), skinWeight.getY(vertex), skinWeight.getZ(vertex), skinWeight.getW(vertex));
    }
    this.skins.write(run.skinBase * SKIN_WORDS * 4, data);
  }

  private writeMorphs(geometry: THREE.BufferGeometry, run: VertexRun): void {
    const positions = geometry.morphAttributes.position as AnyAttribute[] | undefined;
    if (!positions?.length) return;
    const normals = geometry.morphAttributes.normal as AnyAttribute[] | undefined;
    const base = geometry.attributes.position as AnyAttribute;
    const baseNormal = geometry.attributes.normal as AnyAttribute | undefined;
    const relative = geometry.morphTargetsRelative;
    const targets = positions.length;
    run.morphTargets = targets;
    run.morphBase = this.morphAllocator.allocate(targets * run.vertexCount);
    this.morphs.ensure((run.morphBase + targets * run.vertexCount) * MORPH_WORDS * 4);
    const data = new Float32Array(targets * run.vertexCount * MORPH_WORDS);
    let at = 0;
    for (let target = 0; target < targets; target++) {
      const delta = positions[target];
      const normalDelta = normals?.[target];
      for (let vertex = 0; vertex < run.vertexCount; vertex++, at += MORPH_WORDS) {
        data[at] = delta.getX(vertex) - (relative ? 0 : base.getX(vertex));
        data[at + 1] = delta.getY(vertex) - (relative ? 0 : base.getY(vertex));
        data[at + 2] = delta.getZ(vertex) - (relative ? 0 : base.getZ(vertex));
        if (normalDelta) {
          data[at + 3] = normalDelta.getX(vertex) - (relative || !baseNormal ? 0 : baseNormal.getX(vertex));
          data[at + 4] = normalDelta.getY(vertex) - (relative || !baseNormal ? 0 : baseNormal.getY(vertex));
          data[at + 5] = normalDelta.getZ(vertex) - (relative || !baseNormal ? 0 : baseNormal.getZ(vertex));
        }
      }
    }
    this.morphs.write(run.morphBase * MORPH_WORDS * 4, data);
  }

  /** The geometry's edges, one pair of indices each, for a wireframe. */
  wireRange(entry: GeometryEntry): DrawRange {
    if (entry.wire) return entry.wire;
    const { geometry } = entry;
    const seen = new Set<number>();
    const edges: number[] = [];
    const read = geometry.index ? (index: number) => geometry.index!.array[index] : (index: number) => index;
    const add = (a: number, b: number) => {
      const key = a < b ? a * entry.vertexCount + b : b * entry.vertexCount + a;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push(a, b);
    };
    for (let at = 0; at + 2 < entry.indexCount; at += 3) {
      const a = read(at), b = read(at + 1), c = read(at + 2);
      add(a, b);
      add(b, c);
      add(c, a);
    }
    const firstIndex = this.indexAllocator.allocate(edges.length);
    this.indices.ensure((firstIndex + edges.length) * 4);
    this.device.queue.writeBuffer(this.indices.buffer, firstIndex * 4, new Uint32Array(edges));
    entry.wire = { firstIndex, indexCount: edges.length };
    return entry.wire;
  }

  /** The geometry as a line strip (closing it for a loop), one pair of indices per segment. */
  stripRange(entry: GeometryEntry, loop: boolean): DrawRange {
    if (entry.strip) return entry.strip;
    const { geometry } = entry;
    const count = geometry.index?.count ?? entry.vertexCount;
    const read = geometry.index ? (index: number) => geometry.index!.array[index] : (index: number) => index;
    const segments: number[] = [];
    for (let at = 0; at + 1 < count; at++) segments.push(read(at), read(at + 1));
    if (loop && count > 2) segments.push(read(count - 1), read(0));
    const firstIndex = this.indexAllocator.allocate(segments.length);
    this.indices.ensure((firstIndex + segments.length) * 4);
    this.device.queue.writeBuffer(this.indices.buffer, firstIndex * 4, new Uint32Array(segments));
    entry.strip = { firstIndex, indexCount: segments.length };
    return entry.strip;
  }

  /** A run of vertex slots for a posed copy of a skinned mesh, and one for its previous positions. */
  allocatePosed(vertexCount: number): { vertexBase: number; previousBase: number } {
    const vertexBase = this.vertexAllocator.allocate(vertexCount);
    this.vertices.ensure((vertexBase + vertexCount) * VERTEX_BYTES);
    const previousBase = this.previousAllocator.allocate(vertexCount);
    this.previousPositions.ensure((previousBase + vertexCount) * 12);
    return { vertexBase, previousBase };
  }

  releasePosed(vertexBase: number, previousBase: number, vertexCount: number): void {
    this.vertexAllocator.release(vertexBase, vertexCount);
    this.previousAllocator.release(previousBase, vertexCount);
  }

  private release(geometry: THREE.BufferGeometry): void {
    const entry = this.entries.get(geometry);
    if (!entry) return;
    this.entries.delete(geometry);
    entry.released = true;
    this.leaveRun(entry);
    this.dropEdges(entry);
    for (let at = 0; at < entry.heldIndexLists.length; at++) this.dropIndexList(entry.heldIndexLists[at]);
    entry.heldIndexLists.length = 0;
  }

  destroy(): void {
    this.vertices.destroy();
    this.indices.destroy();
    this.skins.destroy();
    this.morphs.destroy();
    this.previousPositions.destroy();
  }
}
