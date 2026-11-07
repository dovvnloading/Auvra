/**
 * THE CLUSTER HIERARCHY, AS BYTES
 *
 * What the builder (clusterBuild.ts) makes and everything else reads: one ArrayBuffer that a worker can hand over, a
 * prepared model can carry and the renderer can copy straight into its tables. It knows nothing of three.js or of the
 * graphics card, so a worker can read it too.
 *
 * A mesh becomes small clusters of triangles. Neighbouring clusters form a group, the group is simplified to half its
 * triangles with its outer border held still, and the result is split into clusters again, which form groups with
 * their own neighbours, and so on upward. A group is two things at once: its members are the finer clusters, and what
 * came out of simplifying it are the coarser clusters that can stand in for all of them together. The border stayed
 * still, so swapping a whole group for what came out of it can never open a crack.
 *
 * A group also records the error its simplification made and a sphere around everything that error applies to. Each
 * cluster then reads two groups: the one it came out of (its own error) and the one it is a member of (its parent's
 * error). The same numbers from the same place on both sides is what makes the parent or child choice exact: for one
 * view, exactly one level along any path up the hierarchy passes "my own error is small enough and my parent's is not".
 *
 * Sections in the buffer, in this order, each a run of 32-bit words:
 *   header   HEADER_WORDS
 *   nodes    NODE_WORDS each. The tree the cull walks; see NODE_LEAF.
 *   clusters CLUSTER_WORDS each. Stays in memory always: the choice is made from these, loaded or not.
 *   groups   GROUP_WORDS each.
 *   pages    PAGE_WORDS each, one per group: where its vertex numbers and triangles lie in the two runs below.
 *   vertexRefs  One word per cluster vertex: its number in the source mesh, a cluster's run after the one before.
 *   triangles   One word per triangle: three cluster-local vertex numbers, a byte each.
 *
 * A group's members are the streamed unit: its page is its members' triangles and vertices, loaded and freed together.
 * Vertices are kept as numbers and packed when the page is loaded, so anything load-time does to the source mesh
 * (import settings, material overrides) reaches them, and a model file carries four bytes per vertex here and not forty.
 */

/** A cluster's most triangles, and vertices: what the index stream and software rasteriser have bits and room for. */
export const MAX_CLUSTER_TRIANGLES = 128;
export const MAX_CLUSTER_VERTICES = 128;
/** Clusters to a group. */
export const GROUP_CLUSTERS = 8;
/** Fewer triangles than this and a mesh stays on the normal path: walking a hierarchy would cost more than it saves. */
export const MIN_CLUSTERED_TRIANGLES = 16384;

/** A cluster at full detail came out of no group. */
export const NO_GROUP = 0xffffffff;
/** In the renderer's group table: this group's page is not in memory. */
export const NOT_RESIDENT = 0xffffffff;
/** The error of a group nothing simplified, the top of the hierarchy: never small enough. */
export const ROOT_ERROR = 1e20;
/** On a node's count word: its children are clusters, not nodes. */
export const NODE_LEAF = 0x80000000;

const MAGIC = 0x4c435641;
const FORMAT_VERSION = 1;

export const HEADER_WORDS = 16;
/** bounds sphere (4), detail sphere (4), largest parent error, first child, child count, unused. */
export const NODE_WORDS = 12;
/**
 * bounds sphere (4), back cone axis and cutoff (4), member-of group, came-from group, first vertex and first triangle
 * within the page, vertices | triangles << 8, longest triangle edge, two unused.
 */
export const CLUSTER_WORDS = 16;
/**
 * In a file: sphere (4), error, first member cluster, member count, level.
 * In the renderer: sphere (4), error, page's first vertex or NOT_RESIDENT, page's first triangle, unused.
 */
export const GROUP_WORDS = 8;
/** First vertex ref, vertex count, first triangle, triangle count. */
export const PAGE_WORDS = 4;

export interface ClusterSphere {
  x: number;
  y: number;
  z: number;
  r: number;
}

/** The buffer's sections as views over it. */
export interface ClusterHierarchy {
  bytes: ArrayBuffer;
  nodeCount: number;
  clusterCount: number;
  groupCount: number;
  /** The last this many groups hold the top of the hierarchy: always in memory. */
  rootGroups: number;
  /** How many steps from the tree's root to its deepest leaf, the root counting as one. */
  treeDepth: number;
  /** The mesh's triangles at full detail. */
  sourceTriangles: number;
  sphere: ClusterSphere;
  nodes: Uint32Array;
  clusters: Uint32Array;
  groups: Uint32Array;
  pages: Uint32Array;
  vertexRefs: Uint32Array;
  triangles: Uint32Array;
}

export interface ClusterHierarchyTables {
  nodes: Uint32Array;
  clusters: Uint32Array;
  groups: Uint32Array;
  pages: Uint32Array;
  vertexRefs: Uint32Array;
  triangles: Uint32Array;
  rootGroups: number;
  treeDepth: number;
  sourceTriangles: number;
  sphere: ClusterSphere;
}

/** The tables as one buffer. */
export const writeClusterHierarchy = (tables: ClusterHierarchyTables): ArrayBuffer => {
  const sections = [tables.nodes, tables.clusters, tables.groups, tables.pages, tables.vertexRefs, tables.triangles];
  const words = sections.reduce((sum, section) => sum + section.length, HEADER_WORDS);
  const bytes = new ArrayBuffer(words * 4);
  const out = new Uint32Array(bytes);
  const floats = new Float32Array(bytes);
  out[0] = MAGIC;
  out[1] = FORMAT_VERSION;
  out[2] = tables.nodes.length / NODE_WORDS;
  out[3] = tables.clusters.length / CLUSTER_WORDS;
  out[4] = tables.groups.length / GROUP_WORDS;
  out[5] = tables.vertexRefs.length;
  out[6] = tables.triangles.length;
  out[7] = tables.rootGroups;
  out[8] = tables.treeDepth;
  out[9] = tables.sourceTriangles;
  floats[10] = tables.sphere.x;
  floats[11] = tables.sphere.y;
  floats[12] = tables.sphere.z;
  floats[13] = tables.sphere.r;
  let at = HEADER_WORDS;
  for (const section of sections) {
    out.set(section, at);
    at += section.length;
  }
  return bytes;
};

/** Reads a buffer made by writeClusterHierarchy; null for anything else, a file from another version included. */
export const readClusterHierarchy = (bytes: ArrayBuffer): ClusterHierarchy | null => {
  if (bytes.byteLength < HEADER_WORDS * 4 || bytes.byteLength % 4) return null;
  const words = new Uint32Array(bytes);
  if (words[0] !== MAGIC || words[1] !== FORMAT_VERSION) return null;
  const floats = new Float32Array(bytes);
  const nodeCount = words[2];
  const clusterCount = words[3];
  const groupCount = words[4];
  const lengths = [nodeCount * NODE_WORDS, clusterCount * CLUSTER_WORDS, groupCount * GROUP_WORDS, groupCount * PAGE_WORDS, words[5], words[6]];
  if (lengths.reduce((sum, length) => sum + length, HEADER_WORDS) !== words.length) return null;
  let at = HEADER_WORDS;
  const [nodes, clusters, groups, pages, vertexRefs, triangles] = lengths.map((length) => {
    const section = new Uint32Array(bytes, at * 4, length);
    at += length;
    return section;
  });
  return {
    bytes,
    nodeCount,
    clusterCount,
    groupCount,
    rootGroups: words[7],
    treeDepth: words[8],
    sourceTriangles: words[9],
    sphere: { x: floats[10], y: floats[11], z: floats[12], r: floats[13] },
    nodes,
    clusters,
    groups,
    pages,
    vertexRefs,
    triangles,
  };
};

/** A sphere around two spheres. */
export const mergeSpheres = (a: ClusterSphere, b: ClusterSphere): ClusterSphere => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (distance + b.r <= a.r) return a;
  if (distance + a.r <= b.r) return b;
  const r = (distance + a.r + b.r) / 2;
  // Rounding must not leave either sphere poking out: enclosure is what keeps the error test from ever going backward.
  const along = (r - a.r) / distance;
  return { x: a.x + dx * along, y: a.y + dy * along, z: a.z + dz * along, r: r * (1 + 1e-6) };
};
