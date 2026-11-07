/// <reference lib="webworker" />

import { buildClusterHierarchy, clusterBuilderReady, weldClusterSource, type ClusterSourceMesh } from "../renderer/gpu/clusters/clusterBuild";

/** Builds a big mesh's cluster hierarchy off the main thread (renderer/gpu/clusters/clusterRegistry.ts asks); one mesh per request. */

/** A run of the mesh's triangles that draws as one, by material. */
export interface ClusterBuildPart {
  start: number;
  count: number;
}

export type ClusterBuildRequest = {
  id: number;
  /** Three per vertex. */
  positions: Float32Array;
  /** Three per vertex, or null. */
  normals: Float32Array | null;
  /** Two per vertex, or null. */
  uvs: Float32Array | null;
  /** Null for a mesh with none, whose triangles are welded here. */
  indices: Uint32Array | null;
  parts: ClusterBuildPart[];
};

export type ClusterBuildResponse =
  | { id: number; parts: (ClusterBuildPart & { hierarchy: ArrayBuffer | null })[] }
  | { id: number; error: string };

/** The same weights the mesh detail levels use: a unit of texture coordinate or normal against the size of what is simplified. */
const UV_WEIGHT = 2;
const NORMAL_WEIGHT = 0.5;

const sourceMesh = ({ positions, normals, uvs }: ClusterBuildRequest): ClusterSourceMesh => {
  const stride = (uvs ? 2 : 0) + (normals ? 3 : 0);
  if (!stride) return { positions, attributes: null, attributeStride: 0, attributeWeights: [] };
  const vertexCount = positions.length / 3;
  const attributes = new Float32Array(vertexCount * stride);
  for (let vertex = 0, at = 0; vertex < vertexCount; vertex++) {
    if (uvs) {
      attributes[at++] = uvs[vertex * 2];
      attributes[at++] = uvs[vertex * 2 + 1];
    }
    if (normals) {
      attributes[at++] = normals[vertex * 3];
      attributes[at++] = normals[vertex * 3 + 1];
      attributes[at++] = normals[vertex * 3 + 2];
    }
  }
  return {
    positions,
    attributes,
    attributeStride: stride,
    attributeWeights: [...(uvs ? [UV_WEIGHT, UV_WEIGHT] : []), ...(normals ? [NORMAL_WEIGHT, NORMAL_WEIGHT, NORMAL_WEIGHT] : [])],
  };
};

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (event: MessageEvent<ClusterBuildRequest>) => {
  const request = event.data;
  try {
    await clusterBuilderReady();
    const mesh = sourceMesh(request);
    const indices = request.indices ?? weldClusterSource(mesh);
    const parts = request.parts.map((part) => ({
      ...part,
      hierarchy: buildClusterHierarchy(mesh, indices.subarray(part.start, part.start + part.count)),
    }));
    const transfer = parts.flatMap((part) => (part.hierarchy ? [part.hierarchy] : []));
    scope.postMessage({ id: request.id, parts } satisfies ClusterBuildResponse, transfer);
  } catch (error) {
    scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : "The cluster hierarchy could not be built" } satisfies ClusterBuildResponse);
  }
};
