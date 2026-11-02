import type { ModelFileReport } from './nativeImporter';

/**
 * What a glTF document holds, read from its JSON alone: the same description an FBX gets from the
 * native importer, as far as a glTF needs one. Sizes come from each mesh's stored bounds and the
 * transforms above it, so nothing is decoded.
 */

type Matrix = number[];

const multiply = (a: Matrix, b: Matrix): Matrix => {
  const out = new Array<number>(16);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      out[column * 4 + row] = a[row] * b[column * 4] + a[row + 4] * b[column * 4 + 1] + a[row + 8] * b[column * 4 + 2] + a[row + 12] * b[column * 4 + 3];
    }
  }
  return out;
};

const fromTransform = (node: { matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }): Matrix => {
  if (node.matrix?.length === 16) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
};

interface Document {
  asset?: { generator?: string };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: { name?: string; mesh?: number; skin?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes?: { primitives?: { attributes?: Record<string, number>; indices?: number; material?: number; targets?: unknown[]; mode?: number }[] }[];
  accessors?: { count?: number; min?: number[]; max?: number[] }[];
  skins?: { joints?: number[] }[];
  animations?: { name?: string; samplers?: { input?: number }[] }[];
  materials?: unknown[];
  images?: { name?: string; uri?: string }[];
}

const emptyReport = (): ModelFileReport => ({
  format: 'gltf', version: 2, ascii: false, creator: '', application: '', upAxis: '+Y', frontAxis: '+Z', metresPerUnit: 1, framesPerSecond: 0,
  meshes: 0, triangles: 0, vertices: 0, skinnedMeshes: 0, blendShapes: 0, meshesWithPolygons: 0, meshesWithoutUvs: 0, meshesWithoutNormals: 0,
  looseMeshes: [], bones: 0, boneNames: [], collisionMeshes: 0, sockets: 0, lodGroups: 0, cameras: 0, lights: 0, materials: 0,
  outputVertices: 0, outputTriangles: 0, tangentsGenerated: 0, tangentsFromFile: 0, partsWithoutTangents: 0, maxInfluences: 0, verticesOverInfluenceLimit: 0, verticesWithoutWeights: 0,
  clips: [], warnings: [],
});

const TRIANGLES = 4;

export const gltfReport = (json: object): ModelFileReport => {
  const document = json as Document;
  const report = emptyReport();
  const accessors = document.accessors ?? [];
  const nodes = document.nodes ?? [];
  report.creator = document.asset?.generator ?? '';
  report.version = 2;
  report.materials = document.materials?.length ?? 0;

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const expand = (world: Matrix, low: number[], high: number[]): void => {
    for (let corner = 0; corner < 8; corner += 1) {
      const x = corner & 1 ? high[0] : low[0];
      const y = corner & 2 ? high[1] : low[1];
      const z = corner & 4 ? high[2] : low[2];
      for (let axis = 0; axis < 3; axis += 1) {
        const value = world[axis] * x + world[axis + 4] * y + world[axis + 8] * z + world[axis + 12];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }
  };
  const visit = (index: number, parent: Matrix, seen: Set<number>): void => {
    const node = nodes[index];
    if (!node || seen.has(index)) return;
    seen.add(index);
    const world = multiply(parent, fromTransform(node));
    if (node.mesh !== undefined) {
      if (node.skin !== undefined) report.skinnedMeshes += 1;
      report.meshes += 1;
      for (const primitive of document.meshes?.[node.mesh]?.primitives ?? []) {
        const position = accessors[primitive.attributes?.POSITION ?? -1];
        if ((primitive.mode ?? TRIANGLES) === TRIANGLES) {
          const corners = primitive.indices !== undefined ? accessors[primitive.indices]?.count ?? 0 : position?.count ?? 0;
          report.triangles += Math.floor(corners / 3);
        }
        report.vertices += position?.count ?? 0;
        if (position?.min && position.max) expand(world, position.min, position.max);
      }
    }
    for (const child of node.children ?? []) visit(child, world, seen);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = document.scenes?.[document.scene ?? 0];
  const seen = new Set<number>();
  for (const root of scene?.nodes ?? []) visit(root, identity, seen);
  if (min[0] <= max[0]) {
    report.boundsMin = min as [number, number, number];
    report.boundsMax = max as [number, number, number];
  }

  report.blendShapes = (document.meshes ?? []).reduce((most, mesh) => Math.max(most, mesh.primitives?.[0]?.targets?.length ?? 0), 0);
  const joints = new Set<number>();
  for (const skin of document.skins ?? []) for (const joint of skin.joints ?? []) joints.add(joint);
  report.bones = joints.size;
  report.boneNames = [...joints].map((joint) => nodes[joint]?.name ?? '').filter(Boolean);
  for (const [index, animation] of (document.animations ?? []).entries()) {
    const duration = (animation.samplers ?? []).reduce((longest, sampler) => Math.max(longest, accessors[sampler.input ?? -1]?.max?.[0] ?? 0), 0);
    report.clips.push({ name: animation.name || `Clip ${index + 1}`, duration, start: 0, layers: 1 });
  }
  report.images = (document.images ?? []).map((image, index) => ({ file: image.name || `image ${index + 1}`, embedded: true }));
  return report;
};
