import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import type { LoadedModelData } from '../../types';
import { usablePreparedModels } from '../../player/gamePack';
import { GAME_PACK_FORMAT, type GamePackManifest } from '../../runtime/types';
import { prepareAnimationClips } from '../../utils/animationBinding';
import { readGlb, readGlbBinary } from '../../utils/gltfContainer';
import { overrideTextureFlipY } from '../../utils/materialOverrides';
import { meshLodChain, meshLodReady, MIN_LOD_TRIANGLES } from '../../utils/meshLod';
import { loadModelFile, type ModelLoadOptions } from '../../utils/modelLoader';
import { PREPARED_EXTENSION, PREPARED_MODEL_VERSION, type PreparedMetadata } from '../../utils/preparedModels/format';
import { prepareGlb, UnpreparableModelError, type CompressImage, type PrepareOptions } from '../../utils/preparedModels/prepareGlb';
import { weldMeshes } from '../../utils/preparedModels/weldMeshes';
import { normalizeModel } from '../../utils/processing/ModelTransforms';
import { createGameContentLoader } from '../../utils/projectHydration';

/** What the import worker has when it exports an FBX: separate triangles, several materials, bones and clips. */
const fbxLikeScene = (): THREE.Group => {
  const root = new THREE.Group();
  root.name = 'Hero';
  const hips = new THREE.Bone();
  hips.name = 'Hips';
  const spine = new THREE.Bone();
  spine.name = 'Spine';
  spine.position.y = 0.5;
  hips.add(spine);
  root.add(hips);

  const bodyGeometry = new THREE.SphereGeometry(1, 32, 24).toNonIndexed();
  const vertices = bodyGeometry.attributes.position.count;
  bodyGeometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(vertices * 4), 4));
  const weights = new Float32Array(vertices * 4);
  for (let vertex = 0; vertex < vertices; vertex++) weights[vertex * 4] = 1;
  bodyGeometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  const body = new THREE.SkinnedMesh(bodyGeometry, new THREE.MeshStandardMaterial({ name: 'Skin' }));
  body.name = 'Body';
  root.add(body);
  body.bind(new THREE.Skeleton([hips, spine]));

  const armorGeometry = new THREE.SphereGeometry(0.5, 32, 24).toNonIndexed();
  const half = Math.floor(armorGeometry.attributes.position.count / 6) * 3;
  armorGeometry.addGroup(0, half, 0);
  armorGeometry.addGroup(half, armorGeometry.attributes.position.count - half, 1);
  const armor = new THREE.Mesh(armorGeometry, [new THREE.MeshStandardMaterial({ name: 'Metal' }), new THREE.MeshStandardMaterial({ name: 'Leather' })]);
  armor.name = 'Armor';
  armor.position.set(0, 1.5, 0);
  root.add(armor);

  const button = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1).toNonIndexed(), new THREE.MeshStandardMaterial({ name: 'Plastic' }));
  button.name = 'Button';
  button.position.set(0.8, 0.2, 0);
  root.add(button);

  root.animations = [
    new THREE.AnimationClip('Walk', 1, [new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 0, 0, 0, 1, 0])]),
    new THREE.AnimationClip('Take 001', 2, [new THREE.QuaternionKeyframeTrack('Spine.quaternion', [0, 2], [0, 0, 0, 1, 0, 1, 0, 0])]),
  ];
  return root;
};

const exportGlb = async (object: THREE.Object3D): Promise<ArrayBuffer> => {
  const exported = await new GLTFExporter().parseAsync(object, { binary: true, animations: object.animations, onlyVisible: false, trs: false });
  return exported as ArrayBuffer;
};

const sourceGlb = (): Promise<ArrayBuffer> => exportGlb(fbxLikeScene());
const weldedGlb = async (): Promise<ArrayBuffer> => {
  const scene = fbxLikeScene();
  weldMeshes(scene);
  return exportGlb(scene);
};

/** Stands in for the import worker, which runs FBXLoader and GLTFExporter in the real thing. */
const stubImportWorker = (glb: ArrayBuffer, metresPerUnit: number | null = 0.01): void => {
  class StubWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    postMessage(): void {
      queueMicrotask(() => this.onmessage?.({ data: { type: 'complete', glb: glb.slice(0), itemCount: 0, clipCount: 0, missingTextures: 0, metresPerUnit } }));
    }
    terminate(): void { /* nothing runs */ }
  }
  vi.stubGlobal('Worker', StubWorker);
};

const modelOptions = (overrides: Partial<PrepareOptions> = {}): PrepareOptions => ({
  kind: 'model', sourceFormat: 'fbx', metresPerUnit: 0.01, missingTextures: 0, textureCompression: true, meshLod: true, ...overrides,
});
const neverCompress: CompressImage = async () => null;

const fileOf = (bytes: ArrayBuffer, name: string): File => {
  const file = new File([bytes], name, { type: 'application/octet-stream' });
  // jsdom's File cannot be read as an ArrayBuffer.
  file.arrayBuffer = async () => bytes.slice(0);
  return file;
};

const load = (bytes: ArrayBuffer, name: string, options: ModelLoadOptions): Promise<LoadedModelData> =>
  loadModelFile(fileOf(bytes, name), { compressTextures: false, ...options });

const summary = (model: LoadedModelData) => {
  model.object.updateMatrixWorld(true);
  const nodes: string[] = [];
  const materials: string[] = [];
  let triangles = 0;
  model.object.traverse((node) => {
    nodes.push(`${node.type}:${node.name}`);
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry;
    triangles += (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
    materials.push((mesh.material as THREE.Material).name);
  });
  return { nodes, materials, triangles, clips: model.animations.map((clip) => [clip.name, clip.duration, clip.tracks.map((track) => track.name)]) };
};

const expectSameBounds = (a: THREE.Object3D, b: THREE.Object3D): void => {
  const [first, second] = [new THREE.Box3().setFromObject(a), new THREE.Box3().setFromObject(b)];
  // Welding keeps the first of the corners it merges, up to its tolerance.
  for (const key of ['x', 'y', 'z'] as const) {
    expect(first.min[key]).toBeCloseTo(second.min[key], 3);
    expect(first.max[key]).toBeCloseTo(second.max[key], 3);
  }
};

const documentOf = (glb: ArrayBuffer): Record<string, any> => readGlb(glb).json as Record<string, any>;

beforeAll(async () => { await meshLodReady; });

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:test' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('a prepared model and its source', () => {
  it('load the same nodes, materials, clips, bounds and triangles', async () => {
    stubImportWorker(await sourceGlb());
    const prepared = await prepareGlb(await weldedGlb(), 'glb', modelOptions(), neverCompress);
    for (const normalize of [true, false]) {
      const fromSource = await load(new ArrayBuffer(4), 'Hero.fbx', { normalize });
      const fromPrepared = await load(prepared, 'Hero.fbx', { normalize, prepared: true });
      expect(summary(fromPrepared)).toEqual(summary(fromSource));
      expectSameBounds(fromPrepared.object, fromSource.object);
      expect(fromPrepared.initialScale?.[0]).toBeCloseTo(fromSource.initialScale?.[0] ?? 0, 3);
      expect(fromPrepared.name).toBe(fromSource.name);
    }
  });

  it('keeps a file of one clip named after the file, however the document is named', async () => {
    const scene = fbxLikeScene();
    scene.animations = scene.animations.slice(0, 1);
    stubImportWorker(await exportGlb(scene));
    weldMeshes(scene);
    const prepared = await prepareGlb(await exportGlb(scene), 'glb', modelOptions(), neverCompress);
    const fromSource = await load(new ArrayBuffer(4), 'Renamed.fbx', { normalize: true });
    const fromPrepared = await load(prepared, 'Renamed.fbx', { normalize: true, prepared: true });
    expect(fromSource.animations.map((clip) => clip.name)).toEqual(['Renamed']);
    expect(fromPrepared.animations.map((clip) => clip.name)).toEqual(['Renamed']);
  });

  it('treats a prepared FBX as an FBX and a prepared GLB as a GLB', async () => {
    const fromFbx = await load(await prepareGlb(await weldedGlb(), 'glb', modelOptions(), neverCompress), 'Hero.fbx', { normalize: true, prepared: true });
    const fromGlb = await load(await prepareGlb(await weldedGlb(), 'glb', modelOptions({ sourceFormat: 'glb', metresPerUnit: null }), neverCompress), 'Hero.glb', { normalize: true, prepared: true });
    // Override textures would come out upside down otherwise.
    expect(overrideTextureFlipY(fromFbx.object)).toBe(true);
    expect(overrideTextureFlipY(fromGlb.object)).toBe(false);
  });

  it('keeps the unit the source says it is authored in, for keeping its authored size', async () => {
    const prepared = await prepareGlb(await weldedGlb(), 'glb', modelOptions(), neverCompress);
    const model = await load(prepared, 'Hero.fbx', { normalize: true, prepared: true });
    expect(normalizeModel(model.object, { normalize: false, targetSize: 5 })).toEqual([0.01, 0.01, 0.01]);
  });

  it('refuses a file that does not say it is prepared, so its caller falls back to the source', async () => {
    await expect(load(await sourceGlb(), 'Hero.fbx', { normalize: true, prepared: true })).rejects.toThrow('prepared model');
    const later = documentOf(await prepareGlb(await weldedGlb(), 'glb', modelOptions(), neverCompress));
    expect(later.extensions[PREPARED_EXTENSION]).toEqual({ version: PREPARED_MODEL_VERSION, sourceFormat: 'fbx', metresPerUnit: 0.01, missingTextures: 0 } satisfies PreparedMetadata);
  });
});

describe('prepared detail levels', () => {
  it('holds a chain per primitive that nothing has to build when the model loads', async () => {
    const prepared = await prepareGlb(await weldedGlb(), 'glb', modelOptions(), neverCompress);
    const simplify = vi.spyOn(MeshoptSimplifier, 'simplifyWithAttributes');
    const model = await load(prepared, 'Hero.fbx', { normalize: true, prepared: true });
    const chains: Record<string, ReturnType<typeof meshLodChain>> = {};
    model.object.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) chains[(mesh.material as THREE.Material).name] = meshLodChain(mesh.geometry);
    });
    expect(simplify).not.toHaveBeenCalled();
    // A mesh of many materials welded before its export reduces like any other.
    for (const name of ['Skin', 'Metal', 'Leather']) {
      expect(chains[name].length).toBeGreaterThan(1);
      const vertexCount = chains[name][0].geometry.attributes.position.count;
      for (const level of chains[name].slice(1)) {
        expect(level.error).toBeGreaterThanOrEqual(0);
        expect(level.triangles).toBeLessThan(chains[name][0].triangles);
        expect(level.geometry.attributes.position).toBe(chains[name][0].geometry.attributes.position);
        const indices = level.geometry.index!;
        expect(indices.count).toBe(level.triangles * 3);
        for (let index = 0; index < indices.count; index++) expect(indices.getX(index)).toBeLessThan(vertexCount);
      }
    }
    // Under the threshold there are none to hold.
    expect(chains.Plastic).toHaveLength(1);
    expect(chains.Plastic[0].triangles).toBeLessThan(MIN_LOD_TRIANGLES);
  });

  it('shows why: the same mesh of many materials, not welded, has separate triangles and no levels', async () => {
    stubImportWorker(await sourceGlb());
    const model = await load(new ArrayBuffer(4), 'Hero.fbx', { normalize: true });
    const levels: Record<string, number> = {};
    model.object.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) levels[(mesh.material as THREE.Material).name] = meshLodChain(mesh.geometry).length;
    });
    expect(levels.Metal).toBe(1);
    expect(levels.Leather).toBe(1);
    expect(levels.Skin).toBeGreaterThan(1);
  });

  it('records that a mesh could not be reduced, so loading does not try again', async () => {
    // Over the threshold, but every triangle stands alone: there is nothing to collapse.
    const separate = new THREE.SphereGeometry(1, 32, 24).toNonIndexed();
    separate.setIndex(Array.from({ length: separate.attributes.position.count }, (_, index) => index));
    const prepared = await prepareGlb(await exportGlb(new THREE.Mesh(separate, new THREE.MeshStandardMaterial())), 'glb', modelOptions(), neverCompress);
    expect(documentOf(prepared).meshes[0].primitives[0].extensions.AUVRA_mesh_lod).toEqual({ levels: [] });
    const simplify = vi.spyOn(MeshoptSimplifier, 'simplifyWithAttributes');
    const model = await load(prepared, 'Cards.fbx', { normalize: true, prepared: true });
    model.object.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) expect(meshLodChain(mesh.geometry)).toHaveLength(1);
    });
    expect(simplify).not.toHaveBeenCalled();
  });

  it('bakes none when the game turned detail levels off, and leaves an unindexed GLB to build its own', async () => {
    const off = documentOf(await prepareGlb(await weldedGlb(), 'glb', modelOptions({ meshLod: false }), neverCompress));
    expect(JSON.stringify(off)).not.toContain('AUVRA_mesh_lod');
    const unindexed = documentOf(await prepareGlb(await exportGlb(new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24).toNonIndexed(), new THREE.MeshStandardMaterial())), 'glb', modelOptions({ sourceFormat: 'glb' }), neverCompress));
    expect(unindexed.meshes[0].primitives[0].indices).toBeUndefined();
    expect(unindexed.meshes[0].primitives[0].extensions).toBeUndefined();
  });
});

describe('prepared textures', () => {
  const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
  const png = (tag: number): string => `data:image/png;base64,${base64(new Uint8Array([137, 80, 78, 71, tag]))}`;
  /** A self-contained glTF: one triangle, and a material using `textures` as its maps. */
  const gltfWithTextures = (): ArrayBuffer => {
    const data = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
    return new TextEncoder().encode(JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ uri: `data:application/octet-stream;base64,${base64(data)}`, byteLength: data.length }],
      bufferViews: [{ buffer: 0, byteLength: data.length }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      images: [{ uri: png(1), name: 'Colour' }, { uri: png(2) }, { uri: png(3) }, { uri: png(4) }, { uri: png(5) }],
      samplers: [{ magFilter: 9728, wrapS: 33071, wrapT: 33648 }],
      textures: [{ source: 0, sampler: 0 }, { source: 1 }, { source: 2 }, { source: 3 }, { source: 4 }],
      materials: [{
        name: 'Painted',
        pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 2 } },
        normalTexture: { index: 1 },
        occlusionTexture: { index: 2 },
        emissiveTexture: { index: 3 },
        // A slot that reads every channel of its texture.
        extensions: { KHR_materials_clearcoat: { clearcoatNormalTexture: { index: 3 } } },
      }, { name: 'Small', pbrMetallicRoughness: { baseColorTexture: { index: 4 } } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      nodes: [{ mesh: 0, name: 'Plane' }],
      scenes: [{ nodes: [0] }],
    })).buffer;
  };
  const levels = () => [{ data: new ArrayBuffer(16), width: 4, height: 4 }, { data: new ArrayBuffer(16), width: 2, height: 2 }];

  it('carries BC mip chains by the loading rules, and images only where they are still read', async () => {
    const kinds: string[] = [];
    const compress: CompressImage = async (bytes, _mime, kind) => {
      kinds.push(`${bytes[4]}:${kind}`);
      // The fifth image is too small to compress.
      return bytes[4] === 5 ? null : { format: kind === 'normal' ? 'bc5' : 'bc1', levels: levels() };
    };
    const prepared = await prepareGlb(gltfWithTextures(), 'gltf', modelOptions({ sourceFormat: 'gltf' }), compress);
    const json = documentOf(prepared);
    expect(kinds).toEqual(['1:colour', '3:data', '2:normal', '5:colour']);
    expect(json.textures[0].source).toBeUndefined();
    expect(json.textures[0].name).toBe('Colour');
    expect(json.textures[0].extensions.AUVRA_texture_bc.format).toBe('bc1');
    expect(json.textures[0].extensions.AUVRA_texture_bc.levels).toHaveLength(2);
    expect(json.textures[1].extensions.AUVRA_texture_bc.format).toBe('bc5');
    // Kept: the one a clearcoat also reads, and the one too small to compress.
    expect(json.textures[3].extensions).toBeUndefined();
    expect(json.images).toHaveLength(2);
    expect(json.textures[3].source).toBe(0);
    expect(json.textures[4].source).toBe(1);
    expect(json.images.every((image: { uri?: string; bufferView?: number }) => image.uri === undefined && image.bufferView !== undefined)).toBe(true);
    expect(json.buffers).toEqual([{ byteLength: expect.any(Number) }]);
    expect(json.extensionsUsed).toEqual(expect.arrayContaining(['AUVRA_prepared', 'AUVRA_texture_bc']));
    // Every view stands inside the one binary chunk, on a four-byte boundary.
    const { jsonEnd } = readGlb(prepared);
    const binary = readGlbBinary(prepared, jsonEnd)!;
    for (const view of json.bufferViews) {
      expect(view.byteOffset % 4).toBe(0);
      expect(view.byteOffset + view.byteLength).toBeLessThanOrEqual(binary.byteLength);
    }
  });

  it('builds compressed textures that are placed and sampled as the source says, and rebuilds BC5 normals', async () => {
    const compress: CompressImage = async (_bytes, _mime, kind) => ({ format: kind === 'normal' ? 'bc5' : 'bc3', levels: levels() });
    const source = JSON.parse(new TextDecoder().decode(gltfWithTextures()));
    // Nothing here can decode an image, so every texture is one this path builds.
    delete source.materials[0].extensions;
    const prepared = await prepareGlb(new TextEncoder().encode(JSON.stringify(source)).buffer, 'gltf', modelOptions({ sourceFormat: 'gltf' }), compress);
    const model = await load(prepared, 'Painted.gltf', { normalize: true, prepared: true });
    let material: THREE.MeshStandardMaterial | null = null;
    model.object.traverse((node) => { if ((node as THREE.Mesh).isMesh) material = (node as THREE.Mesh).material as THREE.MeshStandardMaterial; });
    const painted = material as unknown as THREE.MeshStandardMaterial;
    const map = painted.map as THREE.CompressedTexture;
    expect(map.isCompressedTexture).toBe(true);
    expect(map.format).toBe(THREE.RGBA_S3TC_DXT5_Format);
    expect(map.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(map.name).toBe('Colour');
    expect(map.mipmaps).toHaveLength(2);
    expect(map.magFilter).toBe(THREE.NearestFilter);
    expect(map.wrapS).toBe(THREE.ClampToEdgeWrapping);
    expect(map.wrapT).toBe(THREE.MirroredRepeatWrapping);
    expect(map.flipY).toBe(false);
    expect(map.generateMipmaps).toBe(false);
    expect(painted.normalMap?.format).toBe(THREE.RED_GREEN_RGTC2_Format);
    expect(painted.normalMap?.colorSpace).toBe(THREE.NoColorSpace);
    expect(painted.customProgramCacheKey()).toContain('normal-rg');
    expect(painted.roughnessMap).toBe(painted.metalnessMap);
    expect(painted.aoMap).toBe(painted.roughnessMap);
  });

  it('keeps every image when the game turned compression off', async () => {
    const compress = vi.fn(neverCompress);
    const json = documentOf(await prepareGlb(gltfWithTextures(), 'gltf', modelOptions({ textureCompression: false, sourceFormat: 'gltf' }), compress));
    expect(compress).not.toHaveBeenCalled();
    expect(json.images).toHaveLength(5);
    expect(JSON.stringify(json)).not.toContain('AUVRA_texture_bc');
  });
});

describe('prepared animation assets', () => {
  const clipOptions = modelOptions({ kind: 'animation' });

  it('keep nodes, skins and clips, and nothing that draws', async () => {
    const source = await sourceGlb();
    const prepared = await prepareGlb(source, 'glb', clipOptions, neverCompress);
    const json = documentOf(prepared);
    for (const key of ['meshes', 'materials', 'textures', 'images', 'samplers']) expect(json[key]).toBeUndefined();
    expect(json.nodes.some((node: Record<string, unknown>) => 'mesh' in node || 'skin' in node)).toBe(false);
    expect(json.skins).toHaveLength(1);
    expect(json.animations).toHaveLength(2);
    expect(prepared.byteLength).toBeLessThan(source.byteLength / 4);
  });

  it('give a model the same clips as the source file', async () => {
    const target = await load(await sourceGlb(), 'Target.glb', { normalize: true });
    stubImportWorker(await sourceGlb());
    const fromSource = await load(new ArrayBuffer(4), 'Clips.fbx', { normalize: false });
    const fromPrepared = await load(await prepareGlb(await sourceGlb(), 'glb', clipOptions, neverCompress), 'Clips.fbx', { normalize: false, prepared: true });
    let bones = 0;
    fromPrepared.object.traverse((node) => { if ((node as THREE.Bone).isBone) bones += 1; });
    expect(bones).toBe(2);
    const [sourceClips, preparedClips] = [fromSource, fromPrepared].map((model) => prepareAnimationClips(target.object, model.object, model.animations));
    expect(preparedClips.mode).toBe(sourceClips.mode);
    expect(preparedClips.clips.map((clip) => [clip.name, clip.duration, clip.tracks.map((track) => track.name)]))
      .toEqual(sourceClips.clips.map((clip) => [clip.name, clip.duration, clip.tracks.map((track) => track.name)]));
    expect(Array.from(preparedClips.clips[0].tracks[0].values)).toEqual(Array.from(sourceClips.clips[0].tracks[0].values));
  });

  it('keep the meshes a clip moves the blend shapes of', async () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 3), 3)];
    const face = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    face.name = 'Face';
    face.updateMorphTargets();
    face.animations = [new THREE.AnimationClip('Smile', 1, [new THREE.NumberKeyframeTrack('Face.morphTargetInfluences[0]', [0, 1], [0, 1])])];
    const json = documentOf(await prepareGlb(await exportGlb(face), 'glb', clipOptions, neverCompress));
    expect(json.meshes).toHaveLength(1);
    expect(json.animations).toHaveLength(1);
  });
});

describe('what stays unprepared', () => {
  const gltfUsing = (extension: string): ArrayBuffer => new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, extensionsUsed: [extension] })).buffer;

  it('is a model with compressed geometry, without calling that a failure', async () => {
    for (const extension of ['KHR_draco_mesh_compression', 'EXT_meshopt_compression']) {
      await expect(prepareGlb(gltfUsing(extension), 'gltf', modelOptions(), neverCompress)).rejects.toBeInstanceOf(UnpreparableModelError);
    }
  });

  it('is a model that refers to files outside itself', async () => {
    const external = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: 'colour.png' }] })).buffer;
    await expect(prepareGlb(external, 'gltf', modelOptions(), neverCompress)).rejects.toBeInstanceOf(UnpreparableModelError);
  });
});

describe('which prepared models a game uses', () => {
  const sourceId = 'a'.repeat(64);
  const preparedId = 'e'.repeat(64);
  const manifest = (prepared: GamePackManifest['prepared']): GamePackManifest => ({
    format: GAME_PACK_FORMAT,
    assets: [{ id: sourceId, file: 'a.fbx', mime: 'model/fbx', size: 1 }, { id: preparedId, file: 'e.glb', mime: 'model/gltf-binary', size: 1 }],
    ...(prepared ? { prepared } : {}),
  } as GamePackManifest);
  const models = [{ source: sourceId, asset: preparedId }];
  const capable = { colour: true, normal: true };

  it('uses them where it can', () => {
    expect(usablePreparedModels(manifest({ version: PREPARED_MODEL_VERSION, textures: 'bc', models }), capable).get(sourceId)).toBe(preparedId);
    expect(usablePreparedModels(manifest({ version: PREPARED_MODEL_VERSION, textures: 'none', models }), { colour: false, normal: false }).get(sourceId)).toBe(preparedId);
  });

  it('loads sources from a pack without them, of an unknown version, or with BC on a GPU that cannot read it', () => {
    expect(usablePreparedModels(manifest(undefined), capable).size).toBe(0);
    expect(usablePreparedModels(manifest({ version: PREPARED_MODEL_VERSION + 1, textures: 'bc', models }), capable).size).toBe(0);
    expect(usablePreparedModels(manifest({ version: PREPARED_MODEL_VERSION, textures: 'bc', models }), { colour: true, normal: false }).size).toBe(0);
    expect(usablePreparedModels(manifest({ version: PREPARED_MODEL_VERSION, textures: 'bc', models }), { colour: false, normal: true }).size).toBe(0);
  });

  it('ignores an entry whose file the pack does not hold', () => {
    const missing = [{ source: sourceId, asset: 'f'.repeat(64) }];
    expect(usablePreparedModels(manifest({ version: PREPARED_MODEL_VERSION, textures: 'bc', models: missing }), capable).size).toBe(0);
  });
});

describe('a game loading prepared models', () => {
  const sourceId = 'a'.repeat(64);
  const preparedId = 'e'.repeat(64);
  const domains = { models: [{ id: 'hero', name: 'Hero.fbx', assetId: sourceId, category: 'Character' }] };

  const stubAssets = (assets: Record<string, ArrayBuffer>, fetched: string[]): void => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      fetched.push(url);
      const bytes = assets[url];
      if (!bytes) return { ok: false, status: 404, headers: new Headers(), blob: async () => new Blob() };
      const blob = new Blob([bytes]);
      return { ok: true, status: 200, headers: new Headers(), blob: async () => blob };
    }));
    // The hydration's File is built from a Blob, which jsdom cannot read back as an ArrayBuffer.
    vi.spyOn(File.prototype, 'arrayBuffer').mockImplementation(async function arrayBuffer(this: File) {
      const named = Object.entries(assets).find(([, bytes]) => bytes.byteLength === this.size);
      return (named?.[1] ?? new ArrayBuffer(0)).slice(0);
    });
  };

  it('reads the prepared copy instead of the source', async () => {
    const prepared = await prepareGlb(await weldedGlb(), 'glb', modelOptions(), neverCompress);
    const fetched: string[] = [];
    stubAssets({ [preparedId]: prepared }, fetched);
    const loader = createGameContentLoader(domains, {
      resolveAssetUrl: async (assetId) => assetId,
      generateThumbnails: false,
      preparedAssetFor: (assetId) => (assetId === sourceId ? preparedId : undefined),
    });
    await loader.load();
    expect(fetched).toEqual([preparedId]);
    expect(loader.content().models.map((model) => model.name)).toEqual(['Hero.fbx']);
    expect(overrideTextureFlipY(loader.content().models[0].object)).toBe(true);
    loader.releaseAll();
  });

  it('falls back to the source when the prepared copy cannot be read or parsed, without failing the asset', async () => {
    const source = await sourceGlb();
    stubImportWorker(source);
    const fetched: string[] = [];
    // Unreadable as a GLB, and of a size the source does not share.
    stubAssets({ [preparedId]: new ArrayBuffer(8), [sourceId]: new ArrayBuffer(64) }, fetched);
    const loader = createGameContentLoader(domains, {
      resolveAssetUrl: async (assetId) => assetId,
      generateThumbnails: false,
      preparedAssetFor: () => preparedId,
    });
    await expect(loader.load()).resolves.toBeUndefined();
    expect(fetched).toEqual([preparedId, sourceId]);
    expect(loader.content().models).toHaveLength(1);
    fetched.length = 0;
    loader.releaseAll();

    // A copy that is missing altogether goes the same way.
    stubAssets({ [sourceId]: new ArrayBuffer(64) }, fetched);
    const again = createGameContentLoader(domains, {
      resolveAssetUrl: async (assetId) => assetId,
      generateThumbnails: false,
      preparedAssetFor: () => preparedId,
    });
    await expect(again.load()).resolves.toBeUndefined();
    expect(fetched).toEqual([preparedId, sourceId]);
    again.releaseAll();
  });

  it('still fails an asset whose source cannot be read, and does not read past a cancelled load', async () => {
    const fetched: string[] = [];
    stubAssets({}, fetched);
    const failing = createGameContentLoader(domains, {
      resolveAssetUrl: async (assetId) => assetId,
      generateThumbnails: false,
      preparedAssetFor: () => preparedId,
    });
    await expect(failing.load()).rejects.toThrow('Project hydration failed');
    expect(fetched).toEqual([preparedId, sourceId]);

    fetched.length = 0;
    const controller = new AbortController();
    const cancelled = createGameContentLoader(domains, {
      resolveAssetUrl: async (assetId) => { controller.abort(); return assetId; },
      generateThumbnails: false,
      signal: controller.signal,
      preparedAssetFor: () => preparedId,
    });
    await expect(cancelled.load()).rejects.toThrow();
    expect(fetched).not.toContain(sourceId);
  });
});
