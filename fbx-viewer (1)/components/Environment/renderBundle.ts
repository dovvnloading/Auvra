import * as THREE from 'three';
import { PaintedMap } from '../Tools/Retexture/keepOriginal';
import { texturePicture } from '../Tools/Retexture/parts';
import { BAKE_PLACE_ATTRIBUTE, graphBakeMaterial, graphSurface, type BakedGraphInput } from '../../runtime/materials/graphMaterial';

/** The view being looked at, and what the sky is drawn with: what a render of it starts from. Set by the canvas and the sky. */
export const renderView: {
  scene: THREE.Scene | null;
  camera: THREE.Camera | null;
  renderer: THREE.WebGLRenderer | null;
  panorama: { url: string; rotation: number; brightness: number } | null;
  /** Draws a level's own sky onto a cube, without what stands in front of it. Null without one. */
  drawSky: ((renderer: THREE.WebGLRenderer, onto: THREE.WebGLCubeRenderTarget) => void) | null;
} = { scene: null, camera: null, renderer: null, panorama: null, drawSky: null };

const MAGIC = new TextEncoder().encode('AUVRARB1');
/** Large enough for what a frame shows, and what a graphics card holds comfortably for a whole level's textures. */
const MAX_TEXTURE_EDGE = 2048;
/** What a material's values are drawn out at. Colour and normals have the fine detail. */
const GRAPH_COLOUR_EDGE = MAX_TEXTURE_EDGE;
const GRAPH_VALUE_EDGE = 1024;
/** How far in from its place's edge a triangle lies on a map made for it, in pixels, as a map is read from between them. */
const PLACE_INSET_PX = 2;
/** A place smaller than this, in pixels, holds too little to be worth it. */
const SMALLEST_PLACE_PX = 8;
/** How far a drawn glow may vary, out of 255, and still count as one colour. */
const EVEN_GLOW = 2;
/** A sky has no fine detail to speak of, and is sampled for light as much as seen. */
const CAPTURED_SKY_WIDTH = 1536;
const CAPTURED_SKY_FACE = 512;
/**
 * How far a decal stands off the surface it lies on, as a share of the level's size. A ray that passes through a clear part of it
 * steps on by 2e-5 of that size, and one that steps past the surface behind finds the inside of whatever it lies on.
 */
const DECAL_LIFT = 4e-5;
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
const _foot = new THREE.Vector3();
const _tip = new THREE.Vector3();
const _instance = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _normalMatrix = new THREE.Matrix3();

const chunkOf = (mesh: THREE.Mesh, start: number, end: number, indexOf: (corner: number) => number, bounds: THREE.Box3): MeshChunk[] => {
  const instanced = mesh as THREE.InstancedMesh;
  const copies = instanced.isInstancedMesh ? instanced.count : 1;
  const corners = end - start;
  const position = mesh.geometry.getAttribute('position');
  const normal = mesh.geometry.getAttribute('normal');
  const uv = mesh.geometry.getAttribute('uv');
  const skinned = (mesh as THREE.SkinnedMesh).isSkinnedMesh ? mesh as THREE.SkinnedMesh : null;
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
      bounds.expandByPoint(_corner);
      if (normal) {
        _normal.fromBufferAttribute(normal, vertex);
        if (skinned) {
          // Bones turn a surface as well as moving it: where a normal's tip goes, from where its foot goes.
          _foot.fromBufferAttribute(position, vertex);
          _tip.copy(_foot).add(_normal);
          _normal.subVectors(skinned.applyBoneTransform(vertex, _tip), skinned.applyBoneTransform(vertex, _foot));
        }
        _normal.applyMatrix3(_normalMatrix).normalize();
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
// The same way round as the sky's own panoramas and the renderer's: longitude from atan(z, x), the middle of the picture at zero.
const EQUIRECT_FRAGMENT = `
  uniform samplerCube sky;
  varying vec2 vPlace;
  void main() {
    float longitude = (vPlace.x - 0.5) * 6.28318530718;
    float latitude = (vPlace.y - 0.5) * 3.14159265359;
    vec3 direction = vec3(cos(latitude) * cos(longitude), sin(latitude), cos(latitude) * sin(longitude));
    vec3 color = textureCube(sky, direction).rgb;
    gl_FragColor = vec4(pow(clamp(color, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
  }
`;

/** The level's sky as a panorama: one worked out in a shader exists nowhere else as a picture. Null where it has none. */
const capturedSkyPicture = (renderer: THREE.WebGLRenderer): Uint8Array | null => {
  if (!renderView.drawSky) return null;
  const cube = new THREE.WebGLCubeRenderTarget(CAPTURED_SKY_FACE, { type: THREE.HalfFloatType });
  const flat = new THREE.WebGLRenderTarget(CAPTURED_SKY_WIDTH, CAPTURED_SKY_WIDTH / 2, { depthBuffer: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ vertexShader: EQUIRECT_VERTEX, fragmentShader: EQUIRECT_FRAGMENT, uniforms: { sky: { value: cube.texture } }, depthTest: false, depthWrite: false }));
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const toneMapping = renderer.toneMapping;
  const before = renderer.getRenderTarget();
  try {
    renderer.toneMapping = THREE.NoToneMapping;
    renderView.drawSky(renderer, cube);
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
    cube.dispose();
    flat.dispose();
    quad.geometry.dispose();
    quad.material.dispose();
  }
};

/**
 * What a material's graph gives one of its inputs, across the map of each mesh that draws with it: RGBA from the bottom row up,
 * alpha saying which pixels a mesh covers. A graph is a shader, and worked out anywhere else it would be another material.
 */
const drawnGraphInput = (renderer: THREE.WebGLRenderer, camera: THREE.Camera, material: THREE.Material, meshes: readonly THREE.Mesh[], input: BakedGraphInput, edge: number, place: 'uv' | typeof BAKE_PLACE_ATTRIBUTE): Uint8Array | null => {
  const baker = graphBakeMaterial(material, input, place);
  if (!baker) return null;
  const nothing = new THREE.MeshBasicMaterial({ visible: false });
  const target = new THREE.WebGLRenderTarget(edge, edge, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false, depthBuffer: false });
  const before = { target: renderer.getRenderTarget(), autoClear: renderer.autoClear, alpha: renderer.getClearAlpha(), colour: renderer.getClearColor(new THREE.Color()) };
  try {
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    for (const mesh of meshes) {
      const instanced = mesh as THREE.InstancedMesh;
      const own = { material: mesh.material, culled: mesh.frustumCulled, count: instanced.count, children: mesh.children.map((child) => child.visible) };
      mesh.material = Array.isArray(own.material) ? own.material.map((item) => (item === material ? baker : nothing)) : baker;
      mesh.frustumCulled = false;
      // Every copy of an object lies on the same place on its map.
      if (instanced.isInstancedMesh) instanced.count = 1;
      mesh.children.forEach((child) => { child.visible = false; });
      try {
        renderer.render(mesh, camera);
      } finally {
        mesh.material = own.material;
        mesh.frustumCulled = own.culled;
        if (instanced.isInstancedMesh) instanced.count = own.count;
        mesh.children.forEach((child, index) => { child.visible = own.children[index]; });
      }
    }
    const pixels = new Uint8Array(edge * edge * 4);
    renderer.readRenderTargetPixels(target, 0, 0, edge, edge, pixels);
    return pixels;
  } finally {
    renderer.setRenderTarget(before.target);
    renderer.autoClear = before.autoClear;
    renderer.setClearColor(before.colour, before.alpha);
    target.dispose();
    baker.dispose();
    nothing.dispose();
  }
};

/**
 * A material's surfaces as they stand in the level, each triangle with a place of its own on a map. A graph that goes by where a
 * surface stands or faces gives each its own look, where a box's six faces and every copy of it share one place on their map.
 * Null where there are too many triangles for that.
 */
const placedTrianglesOf = (chunks: readonly MeshChunk[], edge: number): { mesh: THREE.Mesh; places: Float32Array } | null => {
  const merged = (key: keyof typeof FLOATS_PER_CORNER) => {
    const all = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk[key].length, 0));
    let at = 0;
    for (const chunk of chunks) {
      all.set(chunk[key], at);
      at += chunk[key].length;
    }
    return all;
  };
  const positions = merged('positions');
  const count = positions.length / 9;
  const columns = Math.ceil(Math.sqrt(count));
  const cell = 1 / columns;
  if (edge * cell < SMALLEST_PLACE_PX) return null;
  const inset = PLACE_INSET_PX / edge;
  const places = new Float32Array(count * 6);
  for (let triangle = 0; triangle < count; triangle += 1) {
    const left = (triangle % columns) * cell + inset;
    const bottom = Math.floor(triangle / columns) * cell + inset;
    const across = cell - inset * 2;
    places.set([left, bottom, left + across, bottom, left, bottom + across], triangle * 6);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(merged('normals'), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(merged('uvs'), 2));
  geometry.setAttribute(BAKE_PLACE_ATTRIBUTE, new THREE.BufferAttribute(places, 2));
  return { mesh: new THREE.Mesh(geometry), places };
};

/** A drawn input as a picture the way up UVs are read in, with what lies around each piece of the layout filled, as it is read from at a distance. */
const pictureOfDrawnInput = (pixels: Uint8Array, edge: number): Uint8Array => {
  const filled = new Uint8ClampedArray(pixels.length);
  new PaintedMap(pixels, edge, edge).mix(0, filled);
  const canvas = document.createElement('canvas');
  canvas.width = edge;
  canvas.height = edge;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('A material could not be read.');
  const image = context.createImageData(edge, edge);
  for (let row = 0; row < edge; row += 1) image.data.set(filled.subarray(row * edge * 4, (row + 1) * edge * 4), (edge - 1 - row) * edge * 4);
  context.putImageData(image, 0, 0);
  return bytesOfDataUrl(canvas.toDataURL('image/png'));
};

/** The most and least of each channel that a drawn input holds where a mesh covers it, out of 255. */
const rangeOf = (pixels: Uint8Array): { least: [number, number, number]; most: [number, number, number] } => {
  const least: [number, number, number] = [255, 255, 255];
  const most: [number, number, number] = [0, 0, 0];
  for (let at = 0; at < pixels.length; at += 4) {
    if (!pixels[at + 3]) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      least[channel] = Math.min(least[channel], pixels[at + channel]);
      most[channel] = Math.max(most[channel], pixels[at + channel]);
    }
  }
  return { least, most };
};

const ENCODED_TO_LINEAR = Float32Array.from({ length: 256 }, (_, value) => new THREE.Color().setRGB(value / 255, 0, 0, THREE.SRGBColorSpace).r);

/**
 * Adds a glow to a drawn colour, each in place: `colour` holds pictures' values, and `glow` light's. Reframe takes one glow for a
 * whole surface, so what varies across one can only go on as colour, which shows it where it is though it lights nothing.
 */
const addGlowToColour = (colour: Uint8Array, glow: Uint8Array, least: readonly number[]): void => {
  for (let at = 0; at < colour.length; at += 4) {
    if (!colour[at + 3]) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      const linear = ENCODED_TO_LINEAR[colour[at + channel]] + Math.max(0, glow[at + channel] - least[channel]) / 255;
      const encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
      colour[at + channel] = Math.round(Math.min(1, encoded) * 255);
    }
  }
};

/** Lets the editor draw between one long piece of work and the next. */
const breathe = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

export interface RenderBundle {
  bundle: Blob;
  triangles: number;
  meshes: number;
  /** Width over height of the view. */
  aspect: number;
}

/** The view as it stands, for a renderer on this computer: every surface with its look, the lights, the sky and the camera. */
export const buildRenderBundle = async (): Promise<RenderBundle | null> => {
  const { scene, camera, panorama, renderer } = renderView;
  if (!scene || !camera) return null;
  scene.updateMatrixWorld(true);

  const byMaterial = new Map<StandardLike, MeshChunk[]>();
  // One mesh of each shape that draws with a material: copies lie the same way on its map.
  const shapesOf = new Map<StandardLike, Map<THREE.BufferGeometry, THREE.Mesh>>();
  const lights: Record<string, unknown>[] = [];
  const bounds = new THREE.Box3();
  const decals: MeshChunk[] = [];
  const add = (material: StandardLike, mesh: THREE.Mesh, chunks: MeshChunk[]) => {
    const list = byMaterial.get(material) ?? [];
    list.push(...chunks);
    byMaterial.set(material, list);
    const shapes = shapesOf.get(material) ?? new Map<THREE.BufferGeometry, THREE.Mesh>();
    if (!shapes.has(mesh.geometry)) shapes.set(mesh.geometry, mesh);
    shapesOf.set(material, shapes);
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
        if (isSurface(material)) add(material, mesh, chunkOf(mesh, group.start, Math.min(group.start + group.count, total), indexOf, bounds));
      }
    } else if (isSurface(mesh.material)) {
      const chunks = chunkOf(mesh, 0, total - (total % 3), indexOf, bounds);
      add(mesh.material, mesh, chunks);
      // Only a decal is pulled off its surface, for the viewport.
      if (mesh.material.polygonOffset) decals.push(...chunks);
    }
  });
  if (byMaterial.size === 0) return null;
  const lift = DECAL_LIFT * bounds.getSize(new THREE.Vector3()).length();
  for (const { positions, normals } of decals) {
    for (let at = 0; at < positions.length; at += 1) positions[at] += normals[at] * lift;
  }

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

  let triangles = 0;
  const meshes: Record<string, unknown>[] = [];
  for (const [material, chunks] of byMaterial) {
    const merge = (key: keyof typeof FLOATS_PER_CORNER): PartReference => {
      const merged = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk[key].length, 0));
      let at = 0;
      for (const chunk of chunks) {
        merged.set(chunk[key], at);
        at += chunk[key].length;
      }
      return addPart(merged);
    };
    const surface = graphSurface(material);
    const placed = surface?.readsPlace && renderer ? placedTrianglesOf(chunks, GRAPH_COLOUR_EDGE) : null;
    const positions = merge('positions');
    triangles += positions.length / 36;
    const uvs = placed ? addPart(placed.places) : merge('uvs');
    const normals = merge('normals');
    if (surface) {
      const shapes = placed ? [placed.mesh] : [...(shapesOf.get(material)?.values() ?? [])];
      const place = placed ? BAKE_PLACE_ATTRIBUTE : 'uv';
      const draw = (input: BakedGraphInput, edge: number) => (renderer ? drawnGraphInput(renderer, camera, material, shapes, input, edge, place) : null);
      const drawn = (input: BakedGraphInput, edge: number) => (surface.wired.has(input) ? draw(input, edge) : null);
      const sent = async (pixels: Uint8Array, edge: number): Promise<PartReference> => {
        const part = addPart(pictureOfDrawnInput(pixels, edge));
        await breathe();
        return part;
      };
      const picture = async (input: BakedGraphInput, edge: number): Promise<PartReference | undefined> => {
        const pixels = drawn(input, edge);
        return pixels ? sent(pixels, edge) : undefined;
      };
      const glow = drawn('emissive', GRAPH_COLOUR_EDGE);
      const glowRange = glow ? rangeOf(glow) : null;
      const glowVaries = glowRange ? glowRange.most.some((most, channel) => most - glowRange.least[channel] > EVEN_GLOW) : false;
      // The base colour need not be wired to have a varying glow added to it: the graph draws it either way.
      let colour = glowVaries ? draw('baseColor', GRAPH_COLOUR_EDGE) : drawn('baseColor', GRAPH_COLOUR_EDGE);
      if (colour && glow && glowRange && glowVaries) addGlowToColour(colour, glow, glowRange.least);
      const baseColorTexture = colour ? await sent(colour, GRAPH_COLOUR_EDGE) : undefined;
      colour = null;
      // A normal is told in terms of the way a surface lies on its map, which holds nothing for a place made up for baking.
      const normalTexture = placed ? undefined : await picture('normal', GRAPH_COLOUR_EDGE);
      const roughnessTexture = await picture('roughness', GRAPH_VALUE_EDGE);
      const metallicTexture = await picture('metalness', GRAPH_VALUE_EDGE);
      const opacityTexture = await picture('opacity', GRAPH_VALUE_EDGE);
      placed?.mesh.geometry.dispose();
      meshes.push({
        positions, uvs, normals,
        material: {
          baseColor: baseColorTexture ? [1, 1, 1] : surface.baseColor,
          roughness: roughnessTexture ? 1 : surface.roughness,
          metallic: metallicTexture ? 1 : surface.metalness,
          opacity: opacityTexture ? 1 : surface.opacity,
          emission: glowRange ? glowRange.least.map((value) => value / 255) : surface.emissive,
          baseColorTexture, normalTexture, roughnessTexture, metallicTexture, opacityTexture,
        },
      });
      continue;
    }
    const emissive = material.emissive ? material.emissive.clone().multiplyScalar(material.emissiveIntensity ?? 1) : null;
    // Worked out in a shader, these do not have their colours on the material: bounced light has the same problem, and the same answer.
    const worked = material.userData?.rayAlbedo as THREE.Color | undefined;
    const baseColor = worked ? [worked.r, worked.g, worked.b] : material.color ? [material.color.r, material.color.g, material.color.b] : [1, 1, 1];
    meshes.push({
      positions, uvs, normals,
      material: {
        baseColor,
        roughness: material.roughness,
        metallic: material.metalness,
        opacity: material.opacity,
        ...(emissive ? { emission: [emissive.r, emissive.g, emissive.b] } : {}),
        baseColorTexture: pictureOf(material.map),
        // Cards, cut-outs and decals draw through their colour map's alpha.
        opacityTexture: material.transparent ? pictureOf(material.map) : undefined,
        normalTexture: pictureOf(material.normalMap),
        roughnessTexture: pictureOf(material.roughnessMap),
        metallicTexture: pictureOf(material.metalnessMap),
      },
    });
  }

  const background = scene.background instanceof THREE.Color ? [scene.background.r, scene.background.g, scene.background.b] : undefined;
  const captured = !panorama && renderer ? capturedSkyPicture(renderer) : null;
  const sky = panorama ? addPart(await pictureOfUrl(panorama.url)) : captured ? addPart(captured) : undefined;
  const look = camera.getWorldDirection(new THREE.Vector3());
  const position = camera.getWorldPosition(new THREE.Vector3());
  const perspective = camera as THREE.PerspectiveCamera;
  const header = new TextEncoder().encode(JSON.stringify({
    meshes, lights,
    environment: { background, intensity: panorama?.brightness ?? 1, ...(sky ? { panorama: sky, rotation: -(panorama?.rotation ?? 0) } : {}) },
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
