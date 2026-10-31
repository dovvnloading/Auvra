import * as THREE from 'three';
import type { GLTFLoaderPlugin, GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GltfDocument } from '../gltfContainer';
import { seedMeshLodChain } from '../meshLod';
import type { BlockFormat } from '../textureCompression/bcEncoder';
import { compressedTexture, rebuildNormalZ } from '../textureCompression/compressTextures';
import { MESH_LOD_EXTENSION, PREPARED_EXTENSION, PREPARED_MODEL_VERSION, TEXTURE_BC_EXTENSION, type PreparedMetadata } from './format';

/** Reads the model a build prepared (see ./format.ts) as GLTFLoader reads anything else. */

const MODEL_FORMATS: readonly string[] = ['fbx', 'obj', 'glb', 'gltf'];
/** glTF's sampler values, as GLTFLoader reads them. */
const MAG_FILTERS: Record<number, THREE.MagnificationTextureFilter> = { 9728: THREE.NearestFilter, 9729: THREE.LinearFilter };
const WRAPPINGS: Record<number, THREE.Wrapping> = { 33071: THREE.ClampToEdgeWrapping, 33648: THREE.MirroredRepeatWrapping, 10497: THREE.RepeatWrapping };

/** What a prepared model says about its source; a file that cannot say is not one this version reads. */
export const readPreparedMetadata = (json: GltfDocument): PreparedMetadata => {
  const metadata = json.extensions?.[PREPARED_EXTENSION] as Partial<PreparedMetadata> | undefined;
  if (metadata?.version !== PREPARED_MODEL_VERSION || !MODEL_FORMATS.includes(metadata.sourceFormat as string)) {
    throw new Error('This file is not a prepared model this version can read.');
  }
  return metadata as PreparedMetadata;
};

interface TextureBc { format: BlockFormat; levels: { bufferView: number; width: number; height: number }[] }
interface MeshLod { levels: { indices: number; error: number }[] }

export const preparedModelPlugin = (parser: GLTFParser): GLTFLoaderPlugin => ({
  name: PREPARED_EXTENSION,

  beforeRoot: () => {
    // As for the plugin's own name: not an unknown extension to copy into each mesh's userData.
    parser.extensions[MESH_LOD_EXTENSION] = true;
    return null;
  },

  loadTexture: (textureIndex) => {
    const definition = parser.json.textures[textureIndex];
    const bc = definition.extensions?.[TEXTURE_BC_EXTENSION] as TextureBc | undefined;
    if (!bc) return null;
    return Promise.all(bc.levels.map((level) => parser.getDependency('bufferView', level.bufferView) as Promise<ArrayBuffer>)).then((buffers) => {
      const sampler = parser.json.samplers?.[definition.sampler] ?? {};
      const placement = new THREE.Texture();
      placement.name = definition.name ?? '';
      placement.magFilter = MAG_FILTERS[sampler.magFilter] ?? THREE.LinearFilter;
      placement.wrapS = WRAPPINGS[sampler.wrapS] ?? THREE.RepeatWrapping;
      placement.wrapT = WRAPPINGS[sampler.wrapT] ?? THREE.RepeatWrapping;
      const texture = compressedTexture(placement, {
        format: bc.format,
        levels: bc.levels.map((level, index) => ({ data: buffers[index], width: level.width, height: level.height })),
      });
      parser.associations.set(texture, { textures: textureIndex });
      return texture;
    });
  },

  afterRoot: (result) => {
    const pending: Promise<void>[] = [];
    for (const scene of result.scenes) {
      scene.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        const material = mesh.material as THREE.MeshStandardMaterial;
        if (material.normalMap?.format === THREE.RED_GREEN_RGTC2_Format) rebuildNormalZ(material);
        const reference = parser.associations.get(mesh) as { meshes?: number; primitives?: number } | undefined;
        if (reference?.meshes === undefined || reference.primitives === undefined) return;
        const primitive = parser.json.meshes[reference.meshes].primitives[reference.primitives];
        const lod = primitive.extensions?.[MESH_LOD_EXTENSION] as MeshLod | undefined;
        if (!lod) return;
        pending.push(Promise.all(lod.levels.map((level) => parser.getDependency('accessor', level.indices) as Promise<THREE.BufferAttribute>)).then((accessors) => {
          seedMeshLodChain(mesh.geometry, lod.levels.map((level, index) => ({
            indices: accessors[index].array as Uint16Array | Uint32Array,
            error: level.error,
          })));
        }));
      });
    }
    return Promise.all(pending).then(() => undefined);
  },
});
