import { MeshoptClusterizer, MeshoptSimplifier } from "meshoptimizer";
import {
  CLUSTER_WORDS,
  GROUP_CLUSTERS,
  GROUP_WORDS,
  MAX_CLUSTER_TRIANGLES,
  MAX_CLUSTER_VERTICES,
  NODE_LEAF,
  NODE_WORDS,
  NO_GROUP,
  PAGE_WORDS,
  ROOT_ERROR,
  mergeSpheres,
  writeClusterHierarchy,
  type ClusterSphere,
} from "./clusterFormat";

/**
 * THE CLUSTER BUILDER
 *
 * Turns a mesh's triangles into the hierarchy described in clusterFormat.ts: clusters, grouped with their neighbours,
 * each group simplified to half with its border locked, the result split into clusters again, until few remain. It is
 * plain arithmetic over typed arrays with no three.js and no graphics card, because it runs in a worker: the editor's
 * (workers/clusterBuild.worker.ts) on first sight of a big mesh, or the model preparation step's when a game is built,
 * so that a built game has it from the file and never does this at load.
 */

/** A cone wider than this much bias toward one facing costs too many clusters, and narrower culls too few. */
const CONE_WEIGHT = 0.25;
/** A group must lose at least this share of its triangles to count. Otherwise its clusters try again in other company. */
const MIN_REDUCTION = 0.85;
/** How far a group's simplification may move the surface, as a share of the group's size. */
const MAX_GROUP_ERROR = 0.5;
/** A level with this few clusters is the top. */
const ROOT_CLUSTERS = 4;
const MAX_LEVELS = 48;
/** Children of a node in the tree the cull walks. */
const TREE_FANOUT = 4;
/** A vertex this many clusters touch is a pole, and says nothing about who is next to whom. */
const MAX_VERTEX_CLUSTERS = 16;
/**
 * Clusters that came out of different groups share a border that was locked last time. Pulling those together is
 * what lets that border finally simplify, where otherwise it would stay at full detail all the way up.
 */
const LOCKED_BORDER_WEIGHT = 3;

const SIMPLIFY_FLAGS: ("LockBorder" | "ErrorAbsolute")[] = ["LockBorder", "ErrorAbsolute"];

/** The mesh a hierarchy is built over. */
export interface ClusterSourceMesh {
  /** Three per vertex. */
  positions: Float32Array;
  /** Extra numbers per vertex that count as error when they change, or null. */
  attributes: Float32Array | null;
  attributeStride: number;
  attributeWeights: number[];
}

/** Resolves once the builder can run. Its wasm is compiled lazily, so a page that never builds never pays for it. */
export const clusterBuilderReady = (): Promise<void> => Promise.all([MeshoptClusterizer.ready, MeshoptSimplifier.ready]).then(() => undefined);

interface BuildCluster {
  /** Source mesh vertex numbers. */
  vertices: Uint32Array;
  /** Three numbers into `vertices` per triangle. */
  triangles: Uint8Array;
  triangleCount: number;
  bounds: ClusterSphere;
  coneX: number;
  coneY: number;
  coneZ: number;
  coneCutoff: number;
  maxEdge: number;
  /** The group this came out of, or NO_GROUP at full detail. */
  madeFrom: number;
  /** The group this is a member of, once it has one. */
  group: number;
  /** Its own error and the sphere it applies to: the group it came out of, or nothing and its own bounds at full detail. */
  selfError: number;
  selfSphere: ClusterSphere;
}

interface BuildGroup {
  sphere: ClusterSphere;
  error: number;
  members: BuildCluster[];
  level: number;
  /** Around the members' bounds. */
  bounds: ClusterSphere;
}

const longestEdge = (cluster: { vertices: Uint32Array; triangles: Uint8Array; triangleCount: number }, positions: Float32Array): number => {
  let longest = 0;
  const { vertices, triangles, triangleCount } = cluster;
  const edge = (a: number, b: number): number => {
    const dx = positions[a * 3] - positions[b * 3];
    const dy = positions[a * 3 + 1] - positions[b * 3 + 1];
    const dz = positions[a * 3 + 2] - positions[b * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  };
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const a = vertices[triangles[triangle * 3]];
    const b = vertices[triangles[triangle * 3 + 1]];
    const c = vertices[triangles[triangle * 3 + 2]];
    longest = Math.max(longest, edge(a, b), edge(b, c), edge(c, a));
  }
  return Math.sqrt(longest);
};

/**
 * Splits triangles into clusters. `indices` count into `positions`, and `toSource` then turns those numbers into the
 * source mesh's; null when they already are. `sourcePositions` is what edge lengths are read from.
 */
const makeClusters = (indices: Uint32Array, positions: Float32Array, toSource: Uint32Array | null, sourcePositions: Float32Array): BuildCluster[] => {
  const built = MeshoptClusterizer.buildMeshlets(indices, positions, 3, MAX_CLUSTER_VERTICES, MAX_CLUSTER_TRIANGLES, CONE_WEIGHT);
  const bounds = MeshoptClusterizer.computeMeshletBounds(built, positions, 3);
  const clusters: BuildCluster[] = [];
  for (let meshlet = 0; meshlet < built.meshletCount; meshlet++) {
    const vertexOffset = built.meshlets[meshlet * 4];
    const triangleOffset = built.meshlets[meshlet * 4 + 1];
    const vertexCount = built.meshlets[meshlet * 4 + 2];
    const triangleCount = built.meshlets[meshlet * 4 + 3];
    const local = built.vertices.subarray(vertexOffset, vertexOffset + vertexCount);
    const vertices = new Uint32Array(vertexCount);
    for (let vertex = 0; vertex < vertexCount; vertex++) vertices[vertex] = toSource ? toSource[local[vertex]] : local[vertex];
    const triangles = built.triangles.slice(triangleOffset, triangleOffset + triangleCount * 3);
    const b = bounds[meshlet];
    const sphere = { x: b.centerX, y: b.centerY, z: b.centerZ, r: b.radius };
    const cluster: BuildCluster = {
      vertices,
      triangles,
      triangleCount,
      bounds: sphere,
      coneX: b.coneAxisX,
      coneY: b.coneAxisY,
      coneZ: b.coneAxisZ,
      coneCutoff: b.coneCutoff,
      maxEdge: 0,
      madeFrom: NO_GROUP,
      group: NO_GROUP,
      selfError: 0,
      selfSphere: sphere,
    };
    cluster.maxEdge = longestEdge(cluster, sourcePositions);
    clusters.push(cluster);
  }
  return clusters;
};

const spread = (value: number): number => {
  let v = value & 0x3ff;
  v = (v | (v << 16)) & 0x030000ff;
  v = (v | (v << 8)) & 0x0300f00f;
  v = (v | (v << 4)) & 0x030c30c3;
  v = (v | (v << 2)) & 0x09249249;
  return v;
};

/** Numbers of `count` things in an order that keeps what is near in space near in the list. */
const spaceOrder = (count: number, center: (index: number) => ClusterSphere): Uint32Array => {
  let lowX = Infinity, lowY = Infinity, lowZ = Infinity, highX = -Infinity, highY = -Infinity, highZ = -Infinity;
  for (let index = 0; index < count; index++) {
    const c = center(index);
    lowX = Math.min(lowX, c.x); lowY = Math.min(lowY, c.y); lowZ = Math.min(lowZ, c.z);
    highX = Math.max(highX, c.x); highY = Math.max(highY, c.y); highZ = Math.max(highZ, c.z);
  }
  const scale = 1023 / Math.max(highX - lowX, highY - lowY, highZ - lowZ, 1e-12);
  const codes = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    const c = center(index);
    codes[index] = spread((c.x - lowX) * scale) | (spread((c.y - lowY) * scale) << 1) | (spread((c.z - lowZ) * scale) << 2);
  }
  return Uint32Array.from({ length: count }, (_, index) => index).sort((a, b) => codes[a] - codes[b]);
};

/**
 * Sorts clusters into groups of neighbours, each at most GROUP_CLUSTERS: grown outward from a seed, always taking the
 * cluster most tied to the group so far. `weld` gives the first vertex at each vertex's position, because a seam splits
 * a vertex but not the surface.
 */
const groupNeighbours = (clusters: BuildCluster[], weld: Uint32Array): BuildCluster[][] => {
  const count = clusters.length;
  if (count <= GROUP_CLUSTERS) return count ? [clusters] : [];

  // Which clusters touch each vertex, as one long list by vertex.
  const starts = new Uint32Array(weld.length + 1);
  for (const cluster of clusters) {
    for (let vertex = 0; vertex < cluster.vertices.length; vertex++) starts[weld[cluster.vertices[vertex]] + 1]++;
  }
  for (let vertex = 0; vertex < weld.length; vertex++) starts[vertex + 1] += starts[vertex];
  const toucher = new Uint32Array(starts[weld.length]);
  const cursor = starts.slice();
  clusters.forEach((cluster, index) => {
    for (let vertex = 0; vertex < cluster.vertices.length; vertex++) toucher[cursor[weld[cluster.vertices[vertex]]]++] = index;
  });

  const ties: Map<number, number>[] = clusters.map(() => new Map());
  for (let vertex = 0; vertex < weld.length; vertex++) {
    const start = starts[vertex];
    const end = starts[vertex + 1];
    if (end - start < 2 || end - start > MAX_VERTEX_CLUSTERS) continue;
    for (let i = start; i < end; i++) {
      for (let j = i + 1; j < end; j++) {
        const a = toucher[i];
        const b = toucher[j];
        if (a === b) continue;
        const weight = clusters[a].madeFrom !== clusters[b].madeFrom ? LOCKED_BORDER_WEIGHT : 1;
        ties[a].set(b, (ties[a].get(b) ?? 0) + weight);
        ties[b].set(a, (ties[b].get(a) ?? 0) + weight);
      }
    }
  }

  const groupOf = new Int32Array(count).fill(-1);
  const groups: number[][] = [];
  const order = spaceOrder(count, (index) => clusters[index].bounds);
  for (let at = 0; at < count; at++) {
    const seed = order[at];
    if (groupOf[seed] >= 0) continue;
    const number = groups.length;
    const members = [seed];
    groupOf[seed] = number;
    const frontier = new Map<number, number>();
    const grow = (member: number) => {
      for (const [other, weight] of ties[member]) {
        if (groupOf[other] < 0) frontier.set(other, (frontier.get(other) ?? 0) + weight);
      }
    };
    grow(seed);
    while (members.length < GROUP_CLUSTERS && frontier.size) {
      let best = -1;
      let bestWeight = -1;
      for (const [other, weight] of frontier) {
        if (weight > bestWeight) {
          best = other;
          bestWeight = weight;
        }
      }
      frontier.delete(best);
      groupOf[best] = number;
      members.push(best);
      grow(best);
    }
    groups.push(members);
  }

  // Small leftovers join a neighbouring group that has room.
  for (let number = 0; number < groups.length; number++) {
    const members = groups[number];
    if (!members.length || members.length * 2 > GROUP_CLUSTERS) continue;
    const pull = new Map<number, number>();
    for (const member of members) {
      for (const [other, weight] of ties[member]) {
        const home = groupOf[other];
        if (home !== number && groups[home].length + members.length <= GROUP_CLUSTERS) pull.set(home, (pull.get(home) ?? 0) + weight);
      }
    }
    let best = -1;
    let bestWeight = 0;
    for (const [home, weight] of pull) {
      if (weight > bestWeight) {
        best = home;
        bestWeight = weight;
      }
    }
    if (best < 0) continue;
    for (const member of members) {
      groupOf[member] = best;
      groups[best].push(member);
    }
    groups[number] = [];
  }

  // Separate pieces touch nothing, and would never merge. What is near them in space will do.
  const result: number[][] = [];
  let open: number[] | null = null;
  for (let at = 0; at < count; at++) {
    const number = groupOf[order[at]];
    const members = groups[number];
    if (!members.length) continue;
    groups[number] = [];
    if (members.length * 2 > GROUP_CLUSTERS) {
      result.push(members);
      continue;
    }
    if (open && open.length + members.length <= GROUP_CLUSTERS) {
      open.push(...members);
    } else {
      open = [...members];
      result.push(open);
    }
  }
  return result.map((members) => members.map((index) => clusters[index]));
};

const encloseAll = (spheres: ClusterSphere[]): ClusterSphere => spheres.reduce((merged, sphere) => mergeSpheres(merged, sphere));

/** A tree node before it has a number. */
interface TreeNode {
  bounds: ClusterSphere;
  detail: ClusterSphere;
  maxError: number;
  children: TreeNode[];
  group: number;
}

/**
 * The tree the cull walks, over groups of one level: closest neighbours share a parent, so a whole branch out of view
 * goes at once.
 */
const levelTree = (items: TreeNode[]): TreeNode => {
  if (items.length === 1) return items[0];
  let parts = [items];
  // Halve along the widest direction until there are about as many parts as a node has children.
  for (let parts4 = 1; parts4 < TREE_FANOUT; parts4 *= 2) {
    const next: TreeNode[][] = [];
    for (const part of parts) {
      if (part.length < 2) {
        next.push(part);
        continue;
      }
      let lowX = Infinity, lowY = Infinity, lowZ = Infinity, highX = -Infinity, highY = -Infinity, highZ = -Infinity;
      for (const item of part) {
        lowX = Math.min(lowX, item.bounds.x); lowY = Math.min(lowY, item.bounds.y); lowZ = Math.min(lowZ, item.bounds.z);
        highX = Math.max(highX, item.bounds.x); highY = Math.max(highY, item.bounds.y); highZ = Math.max(highZ, item.bounds.z);
      }
      const width = [highX - lowX, highY - lowY, highZ - lowZ];
      const axis = (["x", "y", "z"] as const)[width.indexOf(Math.max(...width))];
      const sorted = [...part].sort((a, b) => a.bounds[axis] - b.bounds[axis]);
      const middle = sorted.length >> 1;
      next.push(sorted.slice(0, middle), sorted.slice(middle));
    }
    parts = next;
  }
  const children = parts.map((part) => levelTree(part));
  return {
    bounds: encloseAll(children.map((child) => child.bounds)),
    detail: encloseAll(children.map((child) => child.detail)),
    maxError: Math.max(...children.map((child) => child.maxError)),
    children,
    group: -1,
  };
};

const makeTree = (groups: BuildGroup[]): { root: TreeNode; depth: number } => {
  const levels = new Map<number, TreeNode[]>();
  groups.forEach((group, number) => {
    let level = levels.get(group.level);
    if (!level) levels.set(group.level, level = []);
    level.push({ bounds: group.bounds, detail: group.sphere, maxError: group.error, children: [], group: number });
  });
  // One branch per level under the root: a far away object ends its walk in the coarse branches without touching the fine.
  const branches = [...levels.keys()].sort((a, b) => a - b).map((level) => levelTree(levels.get(level)!));
  const root: TreeNode = branches.length === 1 && branches[0].children.length ? branches[0] : {
    bounds: encloseAll(branches.map((child) => child.bounds)),
    detail: encloseAll(branches.map((child) => child.detail)),
    maxError: Math.max(...branches.map((child) => child.maxError)),
    children: branches,
    group: -1,
  };
  const depthOf = (node: TreeNode): number => 1 + node.children.reduce((deepest, child) => Math.max(deepest, depthOf(child)), 0);
  return { root, depth: depthOf(root) };
};

/** Sets the mesh's first vertex per welded position, using an open hash over the positions' bits. */
const positionWeld = (positions: Float32Array): Uint32Array => {
  const vertexCount = positions.length / 3;
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
  const size = Math.max(16, 2 ** Math.ceil(Math.log2(vertexCount * 2)));
  const table = new Int32Array(size).fill(-1);
  const weld = new Uint32Array(vertexCount);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const x = bits[vertex * 3];
    const y = bits[vertex * 3 + 1];
    const z = bits[vertex * 3 + 2];
    let slot = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (size - 1);
    for (;;) {
      const held = table[slot];
      if (held < 0) {
        table[slot] = vertex;
        weld[vertex] = vertex;
        break;
      }
      if (bits[held * 3] === x && bits[held * 3 + 1] === y && bits[held * 3 + 2] === z) {
        weld[vertex] = held;
        break;
      }
      slot = (slot + 1) & (size - 1);
    }
  }
  return weld;
};

/**
 * Triangles over each mesh vertex's first exact twin, for a mesh with no indices of its own: position and attributes
 * must match bit for bit. Each triple of vertices in order is a triangle.
 */
export const weldClusterSource = (mesh: ClusterSourceMesh): Uint32Array => {
  const vertexCount = mesh.positions.length / 3;
  const stride = mesh.attributes ? mesh.attributeStride : 0;
  const positionBits = new Uint32Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.length);
  const attributeBits = mesh.attributes ? new Uint32Array(mesh.attributes.buffer, mesh.attributes.byteOffset, mesh.attributes.length) : null;
  const size = Math.max(16, 2 ** Math.ceil(Math.log2(vertexCount * 2)));
  const table = new Int32Array(size).fill(-1);
  const indices = new Uint32Array(vertexCount - vertexCount % 3);
  const same = (a: number, b: number): boolean => {
    for (let word = 0; word < 3; word++) if (positionBits[a * 3 + word] !== positionBits[b * 3 + word]) return false;
    for (let word = 0; word < stride; word++) if (attributeBits![a * stride + word] !== attributeBits![b * stride + word]) return false;
    return true;
  };
  for (let vertex = 0; vertex < indices.length; vertex++) {
    let hash = 0;
    for (let word = 0; word < 3; word++) hash = Math.imul(hash ^ positionBits[vertex * 3 + word], 16777619);
    for (let word = 0; word < stride; word++) hash = Math.imul(hash ^ attributeBits![vertex * stride + word], 16777619);
    let slot = (hash ^ (hash >>> 15)) & (size - 1);
    for (;;) {
      const held = table[slot];
      if (held < 0) {
        table[slot] = vertex;
        indices[vertex] = vertex;
        break;
      }
      if (same(held, vertex)) {
        indices[vertex] = held;
        break;
      }
      slot = (slot + 1) & (size - 1);
    }
  }
  return indices;
};

/** Numbers everything, children of a node side by side, and writes the tables out. */
const packHierarchy = (groups: BuildGroup[], sphere: ClusterSphere, sourceTriangles: number, rootGroups: number): ArrayBuffer => {
  const { root, depth } = makeTree(groups);
  const flat: TreeNode[] = [root];
  const firstChild: number[] = [];
  for (let at = 0; at < flat.length; at++) {
    firstChild[at] = flat.length;
    if (flat[at].children.length) flat.push(...flat[at].children);
  }

  let clusterCount = 0;
  let vertexRefCount = 0;
  let triangleCount = 0;
  for (const group of groups) {
    clusterCount += group.members.length;
    for (const member of group.members) {
      vertexRefCount += member.vertices.length;
      triangleCount += member.triangleCount;
    }
  }

  const clusterBytes = new ArrayBuffer(clusterCount * CLUSTER_WORDS * 4);
  const clusterWords = new Uint32Array(clusterBytes);
  const clusterFloats = new Float32Array(clusterBytes);
  const groupBytes = new ArrayBuffer(groups.length * GROUP_WORDS * 4);
  const groupWords = new Uint32Array(groupBytes);
  const groupFloats = new Float32Array(groupBytes);
  const pages = new Uint32Array(groups.length * PAGE_WORDS);
  const vertexRefs = new Uint32Array(vertexRefCount);
  const triangles = new Uint32Array(triangleCount);
  const firstClusterOf = new Uint32Array(groups.length);

  let clusterAt = 0;
  let vertexAt = 0;
  let triangleAt = 0;
  groups.forEach((group, number) => {
    const pageVertex = vertexAt;
    const pageTriangle = triangleAt;
    firstClusterOf[number] = clusterAt;
    for (const member of group.members) {
      const at = clusterAt * CLUSTER_WORDS;
      clusterFloats[at] = member.bounds.x;
      clusterFloats[at + 1] = member.bounds.y;
      clusterFloats[at + 2] = member.bounds.z;
      clusterFloats[at + 3] = member.bounds.r;
      clusterFloats[at + 4] = member.coneX;
      clusterFloats[at + 5] = member.coneY;
      clusterFloats[at + 6] = member.coneZ;
      clusterFloats[at + 7] = member.coneCutoff;
      clusterWords[at + 8] = number;
      clusterWords[at + 9] = member.madeFrom;
      clusterWords[at + 10] = vertexAt - pageVertex;
      clusterWords[at + 11] = triangleAt - pageTriangle;
      clusterWords[at + 12] = member.vertices.length | (member.triangleCount << 8);
      clusterFloats[at + 13] = member.maxEdge;
      vertexRefs.set(member.vertices, vertexAt);
      vertexAt += member.vertices.length;
      for (let triangle = 0; triangle < member.triangleCount; triangle++) {
        triangles[triangleAt++] = member.triangles[triangle * 3] | (member.triangles[triangle * 3 + 1] << 8) | (member.triangles[triangle * 3 + 2] << 16);
      }
      clusterAt++;
    }
    const at = number * GROUP_WORDS;
    groupFloats[at] = group.sphere.x;
    groupFloats[at + 1] = group.sphere.y;
    groupFloats[at + 2] = group.sphere.z;
    groupFloats[at + 3] = group.sphere.r;
    groupFloats[at + 4] = group.error;
    groupWords[at + 5] = firstClusterOf[number];
    groupWords[at + 6] = group.members.length;
    groupWords[at + 7] = group.level;
    const page = number * PAGE_WORDS;
    pages[page] = pageVertex;
    pages[page + 1] = vertexAt - pageVertex;
    pages[page + 2] = pageTriangle;
    pages[page + 3] = triangleAt - pageTriangle;
  });

  const nodeBytes = new ArrayBuffer(flat.length * NODE_WORDS * 4);
  const nodeWords = new Uint32Array(nodeBytes);
  const nodeFloats = new Float32Array(nodeBytes);
  flat.forEach((node, number) => {
    const at = number * NODE_WORDS;
    nodeFloats[at] = node.bounds.x;
    nodeFloats[at + 1] = node.bounds.y;
    nodeFloats[at + 2] = node.bounds.z;
    nodeFloats[at + 3] = node.bounds.r;
    nodeFloats[at + 4] = node.detail.x;
    nodeFloats[at + 5] = node.detail.y;
    nodeFloats[at + 6] = node.detail.z;
    nodeFloats[at + 7] = node.detail.r;
    nodeFloats[at + 8] = node.maxError;
    if (node.children.length) {
      nodeWords[at + 9] = firstChild[number];
      nodeWords[at + 10] = node.children.length;
    } else {
      nodeWords[at + 9] = firstClusterOf[node.group];
      nodeWords[at + 10] = (groups[node.group].members.length | NODE_LEAF) >>> 0;
    }
  });

  return writeClusterHierarchy({
    nodes: nodeWords,
    clusters: clusterWords,
    groups: groupWords,
    pages,
    vertexRefs,
    triangles,
    rootGroups,
    treeDepth: depth,
    sourceTriangles,
    sphere,
  });
};

/** One group's triangles over a run of vertices of its own, which is all the simplifier and clusteriser need to look at. */
class GroupGather {
  private readonly localOf: Int32Array;
  private sourceOf: Uint32Array;
  private indexScratch: Uint32Array;

  constructor(private readonly mesh: ClusterSourceMesh) {
    this.localOf = new Int32Array(mesh.positions.length / 3).fill(-1);
    this.sourceOf = new Uint32Array(GROUP_CLUSTERS * MAX_CLUSTER_VERTICES);
    this.indexScratch = new Uint32Array(GROUP_CLUSTERS * MAX_CLUSTER_TRIANGLES * 3);
  }

  gather(members: BuildCluster[]): { indices: Uint32Array; positions: Float32Array; attributes: Float32Array | null; sourceOf: Uint32Array; extent: number } {
    const { localOf } = this;
    const { positions, attributes, attributeStride } = this.mesh;
    let triangleTotal = 0;
    let vertexBound = 0;
    for (const member of members) {
      triangleTotal += member.triangleCount;
      vertexBound += member.vertices.length;
    }
    if (this.indexScratch.length < triangleTotal * 3) this.indexScratch = new Uint32Array(triangleTotal * 3);
    if (this.sourceOf.length < vertexBound) this.sourceOf = new Uint32Array(vertexBound);
    const { indexScratch, sourceOf } = this;
    let localCount = 0;
    let write = 0;
    for (const member of members) {
      const { vertices, triangles } = member;
      for (let corner = 0; corner < member.triangleCount * 3; corner++) {
        const source = vertices[triangles[corner]];
        let local = localOf[source];
        if (local < 0) {
          local = localCount++;
          localOf[source] = local;
          sourceOf[local] = source;
        }
        indexScratch[write++] = local;
      }
    }
    const localPositions = new Float32Array(localCount * 3);
    const localAttributes = attributes ? new Float32Array(localCount * attributeStride) : null;
    let lowX = Infinity, lowY = Infinity, lowZ = Infinity, highX = -Infinity, highY = -Infinity, highZ = -Infinity;
    for (let local = 0; local < localCount; local++) {
      const source = sourceOf[local];
      localOf[source] = -1;
      const x = positions[source * 3];
      const y = positions[source * 3 + 1];
      const z = positions[source * 3 + 2];
      localPositions[local * 3] = x;
      localPositions[local * 3 + 1] = y;
      localPositions[local * 3 + 2] = z;
      lowX = Math.min(lowX, x); lowY = Math.min(lowY, y); lowZ = Math.min(lowZ, z);
      highX = Math.max(highX, x); highY = Math.max(highY, y); highZ = Math.max(highZ, z);
      if (localAttributes) {
        for (let word = 0; word < attributeStride; word++) localAttributes[local * attributeStride + word] = attributes![source * attributeStride + word];
      }
    }
    return {
      indices: indexScratch.slice(0, write),
      positions: localPositions,
      attributes: localAttributes,
      sourceOf: sourceOf.slice(0, localCount),
      extent: Math.max(highX - lowX, highY - lowY, highZ - lowZ),
    };
  }
}

/**
 * The hierarchy over `indices`, ready for readClusterHierarchy, or null when there is nothing to build. Call only after
 * clusterBuilderReady.
 */
export const buildClusterHierarchy = (mesh: ClusterSourceMesh, indices: Uint32Array): ArrayBuffer | null => {
  if (!MeshoptClusterizer.supported || !MeshoptSimplifier.supported) return null;
  const sourceTriangles = Math.floor(indices.length / 3);
  if (!sourceTriangles) return null;
  const { positions } = mesh;
  const weld = positionWeld(positions);
  const whole = indices.length % 3 ? indices.subarray(0, sourceTriangles * 3) : indices;

  let active = makeClusters(whole, positions, null, positions);
  if (!active.length) return null;
  const meshSphere = encloseAll(active.map((cluster) => cluster.bounds));
  const groups: BuildGroup[] = [];
  const gatherer = new GroupGather(mesh);

  for (let level = 0; level < MAX_LEVELS && active.length > ROOT_CLUSTERS; level++) {
    const next: BuildCluster[] = [];
    let simplified = 0;
    for (const members of groupNeighbours(active, weld)) {
      const part = gatherer.gather(members);
      const target = Math.max(3, Math.floor(part.indices.length / 6) * 3);
      const limit = part.extent * MAX_GROUP_ERROR;
      const [result, simplifyError] = part.attributes
        ? MeshoptSimplifier.simplifyWithAttributes(part.indices, part.positions, 3, part.attributes, mesh.attributeStride, mesh.attributeWeights, null, target, limit, SIMPLIFY_FLAGS)
        : MeshoptSimplifier.simplify(part.indices, part.positions, 3, target, limit, SIMPLIFY_FLAGS);
      if (result.length > part.indices.length * MIN_REDUCTION) {
        // Too little gave way with this border. Next time around these clusters have different neighbours.
        next.push(...members);
        continue;
      }
      simplified++;
      const number = groups.length;
      // Errors add up the hierarchy, and spheres enclose the ones below: a parent is never less wrong than a child,
      // from anywhere. That is what the choice relies on to find exactly one level along any path.
      let error = 0;
      const spheres: ClusterSphere[] = [];
      for (const member of members) {
        member.group = number;
        error = Math.max(error, member.selfError);
        spheres.push(member.selfSphere, member.bounds);
      }
      const sphere = encloseAll(spheres);
      error += simplifyError;
      groups.push({ sphere, error, members, level, bounds: encloseAll(members.map((member) => member.bounds)) });
      if (result.length) {
        for (const made of makeClusters(result, part.positions, part.sourceOf, positions)) {
          made.madeFrom = number;
          made.selfError = error;
          made.selfSphere = sphere;
          next.push(made);
        }
      }
    }
    active = next;
    if (!simplified) break;
  }

  // What is left is the top. Nothing replaces it, and it stays in memory, so that there is always something to draw.
  const level = groups.reduce((highest, group) => Math.max(highest, group.level + 1), 0);
  const roots = groupNeighbours(active, weld);
  for (const members of roots) {
    const number = groups.length;
    for (const member of members) member.group = number;
    groups.push({ sphere: meshSphere, error: ROOT_ERROR, members, level, bounds: encloseAll(members.map((member) => member.bounds)) });
  }
  return packHierarchy(groups, meshSphere, sourceTriangles, roots.length);
};
