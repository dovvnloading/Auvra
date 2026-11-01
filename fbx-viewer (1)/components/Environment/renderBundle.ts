import * as THREE from 'three';
import { texturePicture } from '../Tools/Retexture/parts';
import { boundMaterialGraph } from '../../runtime/materials/graphMaterial';
import { OUTPUT_NODE_TYPE } from '../../runtime/materials/materialNodes';

/** The view being looked at, and what the sky is drawn with: what a render of it starts from. Set by the canvas and the sky. */
export const renderView: {
  scene: THREE.Scene | null;
  camera: THREE.Camera | null;
  renderer: THREE.WebGLRenderer | null;
  panorama: { url: string; rotation: number; brightness: number } | null;
} = { scene: null, camera: null, renderer: null, panorama: null };

const MAGIC = new TextEncoder().encode('AUVRARB1');
/** Large enough for what a frame shows, and what a graphics card holds comfortably for a whole level's textures. */
const MAX_TEXTURE_EDGE = 2048;
/** A sky has no fine detail to speak of, and is sampled for light as much as seen. */
const CAPTURED_SKY_FACE = 512;
const CAPTURED_SKY_WIDTH = 1536;
const FLOATS_PER_CORNER = { positions: 3, normals: 3, uvs: 2 } as const;

type StandardLike = THREE.MeshStandardMaterial;
type PartReference = { offset: number; length: number };

/** What draws as a surface. Editor markers, wires and the sky itself are drawn with other materials. */
const isSurface = (material: THREE.Material | undefined): material is StandardLike => {
  if (!material || !material.visible) return false;
  const candidate = material as THREE.MeshStandardMaterial & { isMeshPhongMaterial?: boolean; isMeshLambertMaterial?: boolean };
  return Boolean(candidate.isMeshStandardMaterial || candidate.isMeshPhongMaterial || candidate.isMeshLambertMaterial);
};

/** A mesh's triangles under one material, in world space, a corner at a time. */
interface MeshChunk {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
}

const _corner = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _instance = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _normalMatrix = new THREE.Matrix3();

const chunkOf = (mesh: THREE.Mesh, start: number, end: number, indexOf: (corner: number) => number): MeshChunk[] => {
  const instanced = mesh as THREE.InstancedMesh;
  const copies = instanced.isInstancedMesh ? instanced.count : 1;
  const corners = end - start;
  const normal = mesh.geometry.getAttribute('normal');
  const uv = mesh.geometry.getAttribute('uv');
  const chunks: MeshChunk[] = [];
  for (let copy = 0; copy < copies; copy += 1) {
    if (instanced.isInstancedMesh) {
      instanced.getMatrixAt(copy, _instance);
      // A hidden instance is collapsed.
      if (Math.abs(_instance.determinant()) < 1e-12) continue;
      _world.multiplyMatrices(mesh.matrixWorld, _instance);
    } else {
      _world.copy(mesh.matrixWorld);
    }
    _normalMatrix.getNormalMatrix(_world);
    const chunk: MeshChunk = { positions: new Float32Array(corners * 3), normals: new Float32Array(corners * 3), uvs: new Float32Array(corners * 2) };
    for (let at = 0; at < corners; at += 1) {
      const vertex = indexOf(start + at);
      // Skinned and morphed, as it stands now.
      mesh.getVertexPosition(vertex, _corner).applyMatrix4(_world);
      chunk.positions.set([_corner.x, _corner.y, _corner.z], at * 3);
      if (normal) {
        _normal.fromBufferAttribute(normal, vertex).applyMatrix3(_normalMatrix).normalize();
        chunk.normals.set([_normal.x, _normal.y, _normal.z], at * 3);
      }
      if (uv) chunk.uvs.set([uv.getX(vertex), uv.getY(vertex)], at * 2);
    }
    chunks.push(chunk);
  }
  return chunks;
};

const bytesOfDataUrl = (url: string): Uint8Array => Uint8Array.from(atob(url.split(',')[1]), (character) => character.charCodeAt(0));

const pictureOfUrl = async (url: string): Promise<Uint8Array> => {
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The sky could not be read.');
  context.drawImage(image, 0, 0);
  return bytesOfDataUrl(canvas.toDataURL('image/png'));
};

const EQUIRECT_VERTEX = 'varying vec2 vPlace; void main() { vPlace = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const EQUIRECT_FRAGMENT = `
  uniform samplerCube sky;
  varying vec2 vPlace;
  void main() {
    float around = (vPlace.x - 0.5) * 6.28318530718;
    float up = (vPlace.y - 0.5) * 3.14159265359;
    vec3 direction = vec3(cos(up) * sin(around), sin(up), -cos(up) * cos(around));
    vec3 color = textureCube(sky, vec3(-direction.x, direction.y, direction.z)).rgb;
    gl_FragColor = vec4(pow(clamp(color, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
  }
`;

/** The sky as it is drawn now, as a panorama: a procedural sky exists nowhere else as a picture. Null where it cannot be had. */
const captureSky = (scene: THREE.Scene, camera: THREE.Camera, renderer: THREE.WebGLRenderer): Uint8Array | null => {
  const hidden: THREE.Object3D[] = [];
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    const drawn = (mesh as THREE.Mesh).isMesh || (object as THREE.Points).isPoints || (object as THREE.Line).isLine || (object as THREE.Sprite).isSprite;
    if (!drawn || !object.visible) return;
    const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.Material[];
    // The sky is drawn by shader materials on a mesh far around the camera; anything else is in front of it.
    const isSky = materials.some((material) => (material as THREE.ShaderMaterial).isShaderMaterial) && !object.name.startsWith('Particles');
    if (isSky) return;
    object.visible = false;
    hidden.push(object);
  });
  const target = new THREE.WebGLCubeRenderTarget(CAPTURED_SKY_FACE, { type: THREE.HalfFloatType });
  const faces = new THREE.CubeCamera(0.1, 1_000_000, target);
  camera.getWorldPosition(faces.position);
  const flat = new THREE.WebGLRenderTarget(CAPTURED_SKY_WIDTH, CAPTURED_SKY_WIDTH / 2, { depthBuffer: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ vertexShader: EQUIRECT_VERTEX, fragmentShader: EQUIRECT_FRAGMENT, uniforms: { sky: { value: target.texture } }, depthTest: false, depthWrite: false }));
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  quad.frustumCulled = false;
  const toneMapping = renderer.toneMapping;
  const before = renderer.getRenderTarget();
  try {
    renderer.toneMapping = THREE.NoToneMapping;
    faces.update(renderer, scene);
    renderer.setRenderTarget(flat);
    renderer.render(quadScene, new THREE.Camera());
    const pixels = new Uint8Array(flat.width * flat.height * 4);
    renderer.readRenderTargetPixels(flat, 0, 0, flat.width, flat.height, pixels);
    const canvas = document.createElement('canvas');
    canvas.width = flat.width;
    canvas.height = flat.height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    const image = context.createImageData(flat.width, flat.height);
    for (let row = 0; row < flat.height; row += 1) {
      image.data.set(pixels.subarray(row * flat.width * 4, (row + 1) * flat.width * 4), (flat.height - 1 - row) * flat.width * 4);
    }
    context.putImageData(image, 0, 0);
    return bytesOfDataUrl(canvas.toDataURL('image/png'));
  } finally {
    renderer.setRenderTarget(before);
    renderer.toneMapping = toneMapping;
    hidden.forEach((object) => { object.visible = true; });
    target.dispose();
    flat.dispose();
    quad.geometry.dispose();
    quad.material.dispose();
  }
};

/** Which project textures a material graph takes each of its surface's inputs from, and any plain base colour, for the graphs that have them. */
const graphLook = (material: THREE.Material) => {
  const graph = boundMaterialGraph(material);
  if (!graph) return null;
  const output = graph.nodes.find((node) => node.type === OUTPUT_NODE_TYPE);
  const textureOf = (input: string): string | undefined => {
    const link = graph.links.find((item) => item.toNode === output?.id && item.toInput === input);
    const from = link && graph.nodes.find((node) => node.id === link.fromNode);
    const texture = from?.params?.texture;
    return typeof texture === 'string' && texture ? texture : undefined;
  };
  const color = output?.params?.baseColor;
  return {
    color: textureOf('baseColor'),
    normal: textureOf('normal'),
    roughness: textureOf('roughness'),
    metalness: textureOf('metalness'),
    plainColor: Array.isArray(color) && color.length >= 3 ? color.slice(0, 3) as number[] : undefined,
  };
};

export interface RenderBundle {
  bundle: Blob;
  triangles: number;
  meshes: number;
  /** Width over height of the view. */
  aspect: number;
}

/** The view as it stands, for a renderer on this computer: every surface with its look, the lights, the sky and the camera. */
export const buildRenderBundle = async (textureUrls: ReadonlyMap<string, string> = new Map()): Promise<RenderBundle | null> => {
  const { scene, camera, panorama, renderer } = renderView;
  if (!scene || !camera) return null;
  scene.updateMatrixWorld(true);

  const byMaterial = new Map<StandardLike, MeshChunk[]>();
  const lights: Record<string, unknown>[] = [];
  const add = (material: StandardLike, chunks: MeshChunk[]) => {
    const list = byMaterial.get(material) ?? [];
    list.push(...chunks);
    byMaterial.set(material, list);
  };
  scene.traverseVisible((object) => {
    const light = object as THREE.Light & { target?: THREE.Object3D; angle?: number };
    if (light.isLight && light.intensity > 0) {
      const position = light.getWorldPosition(new THREE.Vector3());
      const color = [light.color.r, light.color.g, light.color.b];
      const direction = light.target ? light.target.getWorldPosition(new THREE.Vector3()).sub(position).normalize().toArray() : [0, -1, 0];
      if ((light as THREE.DirectionalLight).isDirectionalLight) lights.push({ type: 'directional', color, intensity: light.intensity, direction });
      else if ((light as THREE.PointLight).isPointLight) lights.push({ type: 'point', color, intensity: light.intensity, position: position.toArray() });
      else if ((light as THREE.SpotLight).isSpotLight) lights.push({ type: 'spot', color, intensity: light.intensity, position: position.toArray(), direction, angle: THREE.MathUtils.radToDeg(light.angle ?? 0.5) });
      return;
    }
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.getAttribute('position')) return;
    const index = mesh.geometry.index;
    const total = index ? index.count : mesh.geometry.getAttribute('position').count;
    const indexOf = index ? (corner: number) => index.getX(corner) : (corner: number) => corner;
    if (Array.isArray(mesh.material)) {
      for (const group of mesh.geometry.groups) {
        const material = mesh.material[group.materialIndex ?? 0];
        if (isSurface(material)) add(material, chunkOf(mesh, group.start, Math.min(group.start + group.count, total), indexOf));
      }
    } else if (isSurface(mesh.material)) {
      add(mesh.material, chunkOf(mesh, 0, total - (total % 3), indexOf));
    }
  });
  if (byMaterial.size === 0) return null;

  // Laid out as it is made, so that nothing is held twice for long.
  const parts: BlobPart[] = [];
  let offset = 0;
  const addPart = (bytes: ArrayBufferView): PartReference => {
    parts.push(bytes as unknown as BlobPart);
    const reference = { offset, length: bytes.byteLength };
    offset += bytes.byteLength;
    return reference;
  };
  const pictures = new Map<THREE.Texture, PartReference | null>();
  const pictureOf = (texture: THREE.Texture | null | undefined): PartReference | undefined => {
    if (!texture) return undefined;
    if (!pictures.has(texture)) {
      // The way up that UVs are read in: a texture may have been made either way.
      const picture = texturePicture(texture, MAX_TEXTURE_EDGE, 'image/png', true);
      pictures.set(texture, picture ? addPart(bytesOfDataUrl(picture.url)) : null);
    }
    return pictures.get(texture) ?? undefined;
  };

  const projectPictures = new Map<string, Promise<PartReference | undefined>>();
  const projectPicture = (id: string | undefined): Promise<PartReference | undefined> => {
    const url = id ? textureUrls.get(id) : undefined;
    if (!id || !url) return Promise.resolve(undefined);
    let found = projectPictures.get(id);
    if (!found) {
      found = pictureOfUrl(url).then(addPart, () => undefined);
      projectPictures.set(id, found);
    }
    return found;
  };

  let triangles = 0;
  const meshes = await Promise.all([...byMaterial].map(async ([material, chunks]) => {
    const merge = (key: keyof typeof FLOATS_PER_CORNER): PartReference => {
      const merged = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk[key].length, 0));
      let at = 0;
      for (const chunk of chunks) {
        merged.set(chunk[key], at);
        at += chunk[key].length;
      }
      return addPart(merged);
    };
    const positions = merge('positions');
    triangles += positions.length / 36;
    const uvs = merge('uvs');
    const normals = merge('normals');
    const emissive = material.emissive ? material.emissive.clone().multiplyScalar(material.emissiveIntensity ?? 1) : null;
    // Worked out in a shader, these do not have their colours on the material: bounced light has the same problem, and the same answer.
    const worked = material.userData?.rayAlbedo as THREE.Color | undefined;
    const graph = graphLook(material);
    const baseColor = worked ? [worked.r, worked.g, worked.b]
      : graph?.plainColor ?? (material.color ? [material.color.r, material.color.g, material.color.b] : [1, 1, 1]);
    return {
      positions, uvs, normals,
      material: {
        baseColor: graph?.color ? [1, 1, 1] : baseColor,
        roughness: graph?.roughness ? 1 : material.roughness,
        metallic: graph?.metalness ? 1 : material.metalness,
        opacity: material.opacity,
        ...(emissive ? { emission: [emissive.r, emissive.g, emissive.b] } : {}),
        baseColorTexture: graph ? await projectPicture(graph.color) : pictureOf(material.map),
        normalTexture: graph ? await projectPicture(graph.normal) : pictureOf(material.normalMap),
        roughnessTexture: graph ? await projectPicture(graph.roughness) : pictureOf(material.roughnessMap),
        metallicTexture: graph ? await projectPicture(graph.metalness) : pictureOf(material.metalnessMap),
      },
    };
  }));

  const background = scene.background instanceof THREE.Color ? [scene.background.r, scene.background.g, scene.background.b] : undefined;
  const captured = !panorama && renderer ? captureSky(scene, camera, renderer) : null;
  const sky = panorama ? addPart(await pictureOfUrl(panorama.url)) : captured ? addPart(captured) : undefined;
  const look = camera.getWorldDirection(new THREE.Vector3());
  const position = camera.getWorldPosition(new THREE.Vector3());
  const perspective = camera as THREE.PerspectiveCamera;
  const header = new TextEncoder().encode(JSON.stringify({
    meshes, lights,
    environment: { background, intensity: panorama?.brightness ?? 1, ...(sky ? { panorama: sky, rotation: panorama?.rotation ?? 0 } : {}) },
    camera: { position: position.toArray(), target: position.clone().add(look).toArray(), fov: perspective.fov ?? 45 },
  }));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, header.byteLength, true);
  return {
    bundle: new Blob([MAGIC, length, header, ...parts], { type: 'application/octet-stream' }),
    triangles,
    meshes: meshes.length,
    aspect: perspective.aspect ?? 16 / 9,
  };
};
