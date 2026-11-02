import * as THREE from 'three';
import { texturePicture } from '../Tools/Retexture/parts';
import { BAKE_PLACE_ATTRIBUTE, type CapturedValue } from '../../runtime/materials/captureMaterial';
import type { PostProcessSettings } from '../../runtime/components/postProcess';
import { frameLook } from '../../runtime/frameLook';
import { graphSurface, type GraphSurface } from '../../runtime/materials/graphMaterial';
import { lookTexture, whiteBalance } from '../../runtime/postEffects';
import { cloudShadowsFallOn, leaveOutCloudShadows } from '../../runtime/lighting/skyScene';
import { hasOwnShader, swaysInWind, weatherIsOn } from '../../runtime/weatherSurfaces';
import { bytesOfDataUrl, drawnCloudShade, drawnFogColour, drawnOverPicture, drawnValue, movedVertices, radianceFile, pictureOfDrawnValue, placedTrianglesOf, readGlow, ringsAround, type MeshChunk, type MovedVertices } from './renderCapture';

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
/** A sky has no fine detail to speak of, and is sampled for light as much as seen. */
const CAPTURED_SKY_WIDTH = 1536;
const CAPTURED_SKY_FACE = 512;
/**
 * How far a decal stands off the surface it lies on, as a share of the level's size. A ray that passes through a clear part of it
 * steps on by 2e-5 of that size, and one that steps past the surface behind finds the inside of whatever it lies on.
 */
const DECAL_LIFT = 4e-5;
const FLOATS_PER_CORNER = { positions: 3, normals: 3, uvs: 2 } as const;
/** three's filmic curve is the renderer's own, after dividing the light by this. */
const FILMIC_WHITE = 0.6;
/** The curves the renderer has, for each a stack can choose. Those it has none for get the nearest. */
const TONE_OF: Record<PostProcessSettings['toneMapping'], string> = { aces: 'aces', agx: 'aces', neutral: 'aces', reinhard: 'reinhard', none: 'linear' };
const LOOK_TABLE_SIZE = 32;

type StandardLike = THREE.MeshStandardMaterial;
type PartReference = { offset: number; length: number };

/** What draws as a surface. Editor markers, wires and the sky itself are drawn with other materials. */
const isSurface = (material: THREE.Material | undefined): material is StandardLike => {
  if (!material || !material.visible) return false;
  const candidate = material as THREE.MeshStandardMaterial & { isMeshPhongMaterial?: boolean; isMeshLambertMaterial?: boolean };
  return Boolean(candidate.isMeshStandardMaterial || candidate.isMeshPhongMaterial || candidate.isMeshLambertMaterial);
};

const _corner = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _foot = new THREE.Vector3();
const _tip = new THREE.Vector3();
const _instance = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _normalMatrix = new THREE.Matrix3();

/** As many triangles as one batch of far copies may come to, beyond which only some of them are drawn. Far off, nothing shows the gaps. */
const MOST_FAR_TRIANGLES = 400_000;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/** A material shaded flat shows each triangle facing its own way, whatever its vertices' normals say. */
const faceNormals = (chunk: MeshChunk): void => {
  for (let at = 0; at + 8 < chunk.positions.length; at += 9) {
    _a.fromArray(chunk.positions, at);
    _b.fromArray(chunk.positions, at + 3).sub(_a);
    _c.fromArray(chunk.positions, at + 6).sub(_a);
    _b.cross(_c).normalize();
    for (let corner = 0; corner < 3; corner += 1) _b.toArray(chunk.normals, at + corner * 3);
  }
};

/** What a mesh's surfaces come to under one material, a corner at a time. `moved` holds where a shader puts its vertices, where it moves them. */
const chunkOf = (mesh: THREE.Mesh, material: StandardLike, start: number, end: number, indexOf: (corner: number) => number, bounds: THREE.Box3, moved: MovedVertices | null, everyNth = 1): MeshChunk[] => {
  const instanced = mesh as THREE.InstancedMesh;
  const copies = instanced.isInstancedMesh ? instanced.count : 1;
  const corners = end - start;
  const position = mesh.geometry.getAttribute('position');
  const normal = mesh.geometry.getAttribute('normal');
  const uv = mesh.geometry.getAttribute('uv');
  const skinned = (mesh as THREE.SkinnedMesh).isSkinnedMesh ? mesh as THREE.SkinnedMesh : null;
  const colour = material.vertexColors ? mesh.geometry.getAttribute('color') : null;
  const chunks: MeshChunk[] = [];
  for (let copy = 0; copy < copies; copy += everyNth) {
    if (instanced.isInstancedMesh) {
      instanced.getMatrixAt(copy, _instance);
      // A hidden instance is collapsed.
      if (Math.abs(_instance.determinant()) < 1e-12) continue;
      _world.multiplyMatrices(mesh.matrixWorld, _instance);
    } else {
      _world.copy(mesh.matrixWorld);
    }
    _normalMatrix.getNormalMatrix(_world);
    const chunk: MeshChunk = {
      positions: new Float32Array(corners * 3), normals: new Float32Array(corners * 3), uvs: new Float32Array(corners * 2),
      ...(colour ? { colors: new Float32Array(corners * 3) } : {}),
    };
    for (let at = 0; at < corners; at += 1) {
      const vertex = indexOf(start + at);
      if (moved) {
        _corner.fromArray(moved.positions, vertex * 3);
      } else {
        // Skinned and morphed, as it stands now.
        mesh.getVertexPosition(vertex, _corner).applyMatrix4(_world);
      }
      chunk.positions.set([_corner.x, _corner.y, _corner.z], at * 3);
      bounds.expandByPoint(_corner);
      if (moved) {
        chunk.normals.set(moved.normals.subarray(vertex * 3, vertex * 3 + 3), at * 3);
      } else if (normal) {
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
      if (colour && chunk.colors) chunk.colors.set([colour.getX(vertex), colour.getY(vertex), colour.getZ(vertex)], at * 3);
    }
    if (material.flatShading) faceNormals(chunk);
    chunks.push(chunk);
  }
  return chunks;
};

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
  uniform vec3 fromAbove;
  uniform vec3 fromBelow;
  varying vec2 vPlace;
  void main() {
    float longitude = (vPlace.x - 0.5) * 6.28318530718;
    float latitude = (vPlace.y - 0.5) * 3.14159265359;
    vec3 direction = vec3(cos(latitude) * cos(longitude), sin(latitude), cos(latitude) * sin(longitude));
    gl_FragColor = vec4(textureCube(sky, direction).rgb + (direction.y >= 0.0 ? fromAbove : fromBelow), 1.0);
  }
`;

/** What is drawn on a cube as a panorama, with even light added from above and below it. */
const panoramaOf = (renderer: THREE.WebGLRenderer, draw: (onto: THREE.WebGLCubeRenderTarget) => void, fromAbove = new THREE.Color(0x000000), fromBelow = new THREE.Color(0x000000)): Uint8Array => {
  const cube = new THREE.WebGLCubeRenderTarget(CAPTURED_SKY_FACE, { type: THREE.HalfFloatType });
  const flat = new THREE.WebGLRenderTarget(CAPTURED_SKY_WIDTH, CAPTURED_SKY_WIDTH / 2, { type: THREE.FloatType, depthBuffer: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ vertexShader: EQUIRECT_VERTEX, fragmentShader: EQUIRECT_FRAGMENT, uniforms: { sky: { value: cube.texture }, fromAbove: { value: fromAbove }, fromBelow: { value: fromBelow } }, depthTest: false, depthWrite: false }));
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const before = renderer.getRenderTarget();
  try {
    draw(cube);
    renderer.setRenderTarget(flat);
    renderer.render(quadScene, new THREE.Camera());
    const pixels = new Float32Array(flat.width * flat.height * 4);
    renderer.readRenderTargetPixels(flat, 0, 0, flat.width, flat.height, pixels);
    return radianceFile(pixels, flat.width, flat.height);
  } finally {
    renderer.setRenderTarget(before);
    cube.dispose();
    flat.dispose();
    quad.geometry.dispose();
    quad.material.dispose();
  }
};

/**
 * All the light a surface gets from around it in the view, as a panorama: what a lit material reads for reflections and soft light,
 * with the plain fill from above and below. A fill's light on a white surface is as much as that much sky would give it, over pi.
 */
const lightAroundPanorama = (renderer: THREE.WebGLRenderer, scene: THREE.Scene, fromAbove: THREE.Color, fromBelow: THREE.Color): Uint8Array => panoramaOf(renderer, (onto) => {
  const around = new THREE.Scene();
  around.background = scene.environment ?? new THREE.Color(0x000000);
  around.backgroundIntensity = scene.environmentIntensity;
  around.backgroundRotation.copy(scene.environmentRotation);
  new THREE.CubeCamera(0.1, 10, onto).update(renderer, around);
}, fromAbove.clone().multiplyScalar(1 / Math.PI), fromBelow.clone().multiplyScalar(1 / Math.PI));

/** Whether a material's shader moves its vertices, which only that shader then knows the result of. */
const movesItsVertices = (material: StandardLike): boolean => Boolean(material.userData?.movesVertices) || Boolean(graphSurface(material)?.wired.has('worldPositionOffset')) || swaysInWind(material);

/** Surfaces this big in a frame are shown near the camera at a finer scale than one map could hold. */
const usesRings = (material: StandardLike): boolean => material.userData?.raySolid === true;


/** What a level's material draws with where nothing in its shader varies a value, in linear light. */
const plainValuesOf = (material: StandardLike): GraphSurface => {
  // Worked out in a shader, these do not have their colours on the material: bounced light has the same problem, and the same answer.
  const worked = material.userData?.rayAlbedo as THREE.Color | undefined;
  const color = worked ?? material.color ?? new THREE.Color(1, 1, 1);
  const glow = material.emissive ? material.emissive.clone().multiplyScalar(material.emissiveIntensity ?? 1) : new THREE.Color(0, 0, 0);
  return {
    wired: new Set<string>(), readsPlace: false,
    baseColor: [color.r, color.g, color.b], emissive: [glow.r, glow.g, glow.b],
    roughness: material.roughness ?? 0.6, metalness: material.metalness ?? 0, opacity: material.opacity ?? 1,
  };
};

/** Whether a material's look can only be had from its shader, there being no picture of it on the material to send. */
const drawnFromShader = (material: StandardLike): boolean => Boolean(graphSurface(material)) || hasOwnShader(material) || material.vertexColors;

/** What of a material without a graph to draw out, its other values being the ones on the material. */
const valuesToDraw = (material: StandardLike): ReadonlySet<CapturedValue> => {
  const values = new Set<CapturedValue>(['baseColor']);
  const glow = plainValuesOf(material).emissive;
  if (material.emissiveMap || glow.some((channel) => channel > 0)) values.add('emissive');
  if (material.transparent || material.alphaTest > 0) values.add('opacity');
  // Rain and snow change these, in the shader.
  if (weatherIsOn() && material.isMeshStandardMaterial) {
    values.add('roughness');
    values.add('metalness');
  }
  return values;
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

/** How tall a frame of this width is, for the view's shape. */
export const frameHeight = (width: number): number => Math.max(16, Math.round(width / ((renderView.camera as THREE.PerspectiveCamera | null)?.aspect ?? 16 / 9) / 2) * 2);

/** The view as it stands, for a renderer on this computer: every surface with its look, the lights, the sky and the camera. */
export const buildRenderBundle = async (frame?: { width: number; height: number }): Promise<RenderBundle | null> => {
  const { scene, camera, panorama, renderer } = renderView;
  if (!scene || !camera) return null;
  scene.updateMatrixWorld(true);

  const byMaterial = new Map<StandardLike, MeshChunk[]>();
  // One mesh of each shape that draws with a material: copies lie the same way on its map.
  const shapesOf = new Map<StandardLike, Map<THREE.BufferGeometry, THREE.Mesh>>();
  const lights: Record<string, unknown>[] = [];
  const bounds = new THREE.Box3();
  const decals: MeshChunk[] = [];
  const drawnSurfaces: THREE.Mesh[] = [];
  const drawnOver: THREE.Mesh[] = [];
  const fillFromAbove = new THREE.Color(0x000000);
  const fillFromBelow = new THREE.Color(0x000000);
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
      const dome = light as THREE.Light & { isAmbientLight?: boolean; isHemisphereLight?: boolean; groundColor?: THREE.Color };
      if (dome.isAmbientLight || dome.isHemisphereLight) {
        fillFromAbove.add(light.color.clone().multiplyScalar(light.intensity));
        fillFromBelow.add((dome.groundColor ?? light.color).clone().multiplyScalar(light.intensity));
      }
      else if ((light as THREE.DirectionalLight).isDirectionalLight) lights.push({ type: 'directional', color, intensity: light.intensity, direction });
      else if ((light as THREE.PointLight).isPointLight) lights.push({ type: 'point', color, intensity: light.intensity, position: position.toArray() });
      else if ((light as THREE.SpotLight).isSpotLight) lights.push({ type: 'spot', color, intensity: light.intensity, position: position.toArray(), direction, angle: THREE.MathUtils.radToDeg(light.angle ?? 0.5), softness: (light as THREE.SpotLight).penumbra ?? 0 });
      return;
    }
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.getAttribute('position')) return;
    if (mesh.userData?.drawnOverPicture) {
      drawnOver.push(mesh);
      return;
    }
    const standsInFor = mesh.userData?.standsInFor as readonly { geometry: THREE.BufferGeometry; material: THREE.Material }[] | undefined;
    if (standsInFor) {
      const cards = mesh as THREE.InstancedMesh;
      for (const part of standsInFor) {
        if (!isSurface(part.material)) continue;
        const copies = new THREE.InstancedMesh(part.geometry, part.material, cards.count);
        copies.instanceMatrix = cards.instanceMatrix;
        copies.matrixWorld.copy(cards.matrixWorld);
        const partIndex = part.geometry.index;
        const corners = partIndex ? partIndex.count : part.geometry.getAttribute('position').count;
        const everyNth = Math.max(1, Math.ceil((cards.count * corners / 3) / MOST_FAR_TRIANGLES));
        add(part.material, copies, chunkOf(copies, part.material, 0, corners - (corners % 3), partIndex ? (corner) => partIndex.getX(corner) : (corner) => corner, bounds, null, everyNth));
      }
      return;
    }
    if ((Array.isArray(mesh.material) ? mesh.material : [mesh.material]).some(isSurface)) drawnSurfaces.push(mesh);
    const index = mesh.geometry.index;
    const total = index ? index.count : mesh.geometry.getAttribute('position').count;
    const indexOf = index ? (corner: number) => index.getX(corner) : (corner: number) => corner;
    const instancedOrBoned = (mesh as THREE.InstancedMesh).isInstancedMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh;
    const movedBy = (material: StandardLike) => (renderer && !instancedOrBoned && movesItsVertices(material) ? movedVertices(renderer, camera, mesh, material) : null);
    if (Array.isArray(mesh.material)) {
      for (const group of mesh.geometry.groups) {
        const material = mesh.material[group.materialIndex ?? 0];
        if (isSurface(material)) add(material, mesh, chunkOf(mesh, material, group.start, Math.min(group.start + group.count, total), indexOf, bounds, movedBy(material)));
      }
    } else if (isSurface(mesh.material)) {
      const chunks = chunkOf(mesh, mesh.material, 0, total - (total % 3), indexOf, bounds, movedBy(mesh.material));
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

  const sent = async (pixels: Uint8Array, edge: number): Promise<PartReference> => {
    const part = addPart(pictureOfDrawnValue(pixels, edge));
    await breathe();
    return part;
  };

  /** A material's look, drawn out by its own shader over `shapes`. */
  const drawnLook = async (material: StandardLike, surface: GraphSurface | null, shapes: readonly THREE.Mesh[], place: 'uv' | typeof BAKE_PLACE_ATTRIBUTE, ownMap: boolean): Promise<Record<string, unknown>> => {
    const plain = surface ?? plainValuesOf(material);
    const values = surface ? surface.wired : valuesToDraw(material);
    const draw = (value: CapturedValue, edge: number) => drawnValue(renderer!, camera, material, shapes, value, edge, place);
    const picture = async (value: CapturedValue, edge: number): Promise<PartReference | undefined> => {
      if (!renderer || !values.has(value)) return undefined;
      return sent(draw(value, edge) as Uint8Array, edge);
    };
    const glow = renderer && values.has('emissive') ? readGlow(draw('emissive', GRAPH_COLOUR_EDGE) as Float32Array) : null;
    const baseColorTexture = await picture('baseColor', GRAPH_COLOUR_EDGE);
    // A normal is told in terms of the way a surface lies on its map, which holds nothing for a place made up for baking.
    const normalTexture = !ownMap ? undefined : surface ? await picture('normal', GRAPH_COLOUR_EDGE) : pictureOf(material.normalMap);
    const roughnessTexture = await picture('roughness', GRAPH_VALUE_EDGE);
    const metallicTexture = await picture('metalness', GRAPH_VALUE_EDGE);
    const opacityTexture = await picture('opacity', GRAPH_VALUE_EDGE);
    const emissionTexture = glow?.pixels ? await sent(glow.pixels, GRAPH_COLOUR_EDGE) : undefined;
    return {
      baseColor: baseColorTexture ? [1, 1, 1] : plain.baseColor,
      roughness: roughnessTexture ? 1 : plain.roughness,
      metallic: metallicTexture ? 1 : plain.metalness,
      opacity: opacityTexture ? 1 : plain.opacity,
      emission: glow ? (glow.pixels ? [glow.brightest, glow.brightest, glow.brightest] : glow.least) : plain.emissive,
      baseColorTexture, normalTexture, roughnessTexture, metallicTexture, opacityTexture, emissionTexture,
    };
  };

  /** A material with a picture for each thing it draws with, which is all there is to send. */
  const pictureLook = (material: StandardLike): Record<string, unknown> => {
    const plain = plainValuesOf(material);
    const glows = plain.emissive.some((channel) => channel > 0);
    return {
      baseColor: plain.baseColor,
      roughness: plain.roughness,
      metallic: plain.metalness,
      opacity: plain.opacity,
      ...(glows ? { emission: plain.emissive } : {}),
      baseColorTexture: pictureOf(material.map),
      // Cards, cut-outs and decals draw through their colour map's alpha, or a map of its own for that.
      opacityTexture: pictureOf(material.alphaMap) ?? (material.transparent || material.alphaTest > 0 ? pictureOf(material.map) : undefined),
      normalTexture: pictureOf(material.normalMap),
      roughnessTexture: pictureOf(material.roughnessMap),
      metallicTexture: pictureOf(material.metalnessMap),
      emissionTexture: glows ? pictureOf(material.emissiveMap) : undefined,
    };
  };

  let triangles = 0;
  const meshes: Record<string, unknown>[] = [];
  const cameraAt = camera.getWorldPosition(new THREE.Vector3());
  /** Sends a material's surfaces, on the map `places` gives them or else their own. */
  const send = (chunks: readonly MeshChunk[], places: Float32Array | null, material: Record<string, unknown>) => {
    const merge = (key: keyof typeof FLOATS_PER_CORNER): PartReference => {
      const all = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk[key].length, 0));
      let at = 0;
      for (const chunk of chunks) {
        all.set(chunk[key], at);
        at += chunk[key].length;
      }
      return addPart(all);
    };
    const positions = merge('positions');
    triangles += positions.length / 36;
    meshes.push({ positions, uvs: places ? addPart(places) : merge('uvs'), normals: merge('normals'), material });
  };
  for (const [material, chunks] of byMaterial) {
    const surface = graphSurface(material);
    if (!renderer || !drawnFromShader(material)) {
      send(chunks, null, surface ? { baseColor: surface.baseColor, roughness: surface.roughness, metallic: surface.metalness, opacity: surface.opacity, emission: surface.emissive } : pictureLook(material));
      continue;
    }
    if (usesRings(material)) {
      for (const ring of ringsAround(chunks, cameraAt)) {
        send([ring.chunk], ring.places, await drawnLook(material, surface, [ring.mesh], BAKE_PLACE_ATTRIBUTE, false));
        ring.mesh.geometry.dispose();
      }
      continue;
    }
    const placed = surface?.readsPlace || material.vertexColors ? placedTrianglesOf(chunks, GRAPH_COLOUR_EDGE) : null;
    const shapes = placed ? [placed.mesh] : [...(shapesOf.get(material)?.values() ?? [])];
    send(chunks, placed?.places ?? null, await drawnLook(material, surface, shapes, placed ? BAKE_PLACE_ATTRIBUTE : 'uv', !placed));
    placed?.mesh.geometry.dispose();
  }

  const background = scene.background instanceof THREE.Color ? [scene.background.r, scene.background.g, scene.background.b] : undefined;
  const drawSky = renderView.drawSky;
  const captured = !panorama && renderer && drawSky ? panoramaOf(renderer, (onto) => drawSky(renderer, onto)) : null;
  const sky = panorama ? addPart(await pictureOfUrl(panorama.url)) : captured ? addPart(captured) : undefined;
  const lightAround = renderer ? addPart(lightAroundPanorama(renderer, scene, fillFromAbove, fillFromBelow)) : undefined;
  const facing = camera.getWorldDirection(new THREE.Vector3());
  const position = camera.getWorldPosition(new THREE.Vector3());
  const perspective = camera as THREE.PerspectiveCamera;
  const fog = scene.fog as (THREE.Fog | THREE.FogExp2 | null);
  const post = frameLook.settings;
  const adapted = renderer && post?.autoExposure && frameLook.adaptedExposure ? frameLook.adaptedExposure(renderer) : 1;
  const toneMapping = post ? TONE_OF[post.toneMapping] : 'aces';
  // Without a stack, what is blended over a surface goes on after tone mapping, in the colours on screen. With one it goes on in the light.
  const blendsOnScreen = !post;
  const over = renderer && frame && drawnOver.length > 0 ? drawnOverPicture(renderer, scene, camera, drawnSurfaces, drawnOver, frame.width, frame.height, blendsOnScreen) : null;
  const cloudShade = renderer && frame && cloudShadowsFallOn(scene) ? drawnCloudShade(renderer, scene, camera, drawnSurfaces, frame.width, frame.height, () => leaveOutCloudShadows(scene)) : null;
  const fogColour = renderer && frame && fog ? drawnFogColour(renderer, scene, camera as THREE.PerspectiveCamera, frame.width, frame.height, blendsOnScreen) : null;
  const look = post && post.look !== 'none' && post.lookStrength > 0 ? lookTexture(post.look) : null;
  const header = new TextEncoder().encode(JSON.stringify({
    meshes, lights,
    // The same curve at the same brightness as the view, and the same fog.
    toneMapping,
    exposure: Math.log2(((renderer?.toneMappingExposure ?? 1) * adapted) / (toneMapping === 'aces' ? FILMIC_WHITE : 1)),
    blendsOnScreen,
    ...(cloudShade && frame ? { cloudShade: { picture: addPart(cloudShade), width: frame.width, height: frame.height } } : {}),
    ...(over && frame ? { over: { picture: addPart(over), width: frame.width, height: frame.height } } : {}),
    ...(post ? {
      post: {
        whiteBalance: post.temperature !== 0 || post.tint !== 0 ? whiteBalance(post.temperature, post.tint) : undefined,
        bloom: post.bloom ? { intensity: post.bloomIntensity, threshold: post.bloomThreshold } : undefined,
        depthOfField: post.depthOfField ? { focus: post.focusDistance, bokeh: post.bokehScale } : undefined,
        saturation: post.saturation, brightness: post.brightness, contrast: post.contrast,
        vignette: post.vignette ? post.vignetteDarkness : 0,
        look: look ? { table: addPart(look.image.data as Float32Array), size: LOOK_TABLE_SIZE, strength: post.lookStrength } : undefined,
        fringe: post.chromaticAberration,
      },
    } : {}),
    ...(fog ? {
      fog: {
        color: [fog.color.r, fog.color.g, fog.color.b],
        ...(fogColour && frame ? { picture: { picture: addPart(fogColour), width: frame.width, height: frame.height } } : {}),
        ...((fog as THREE.FogExp2).isFogExp2 ? { density: (fog as THREE.FogExp2).density } : { near: (fog as THREE.Fog).near, far: (fog as THREE.Fog).far }),
      },
    } : {}),
    environment: { background, intensity: panorama?.brightness ?? 1, lightAround, ...(sky ? { panorama: sky, panoramaIsLight: Boolean(captured), rotation: -(panorama?.rotation ?? 0) } : {}) },
    camera: { position: position.toArray(), target: position.clone().add(facing).toArray(), fov: perspective.fov ?? 45 },
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
