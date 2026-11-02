import * as THREE from 'three';
import { PaintedMap } from '../Tools/Retexture/keepOriginal';
import { BAKE_PLACE_ATTRIBUTE, captureMaterial, isUnboundedValue, type CapturedValue } from '../../runtime/materials/captureMaterial';

/**
 * Drawing out what materials work out, for a renderer that cannot run them: onto pictures across a map, and for what moves
 * its vertices in its shader, as numbers for each vertex.
 */

export const bytesOfDataUrl = (url: string): Uint8Array => Uint8Array.from(atob(url.split(',')[1]), (character) => character.charCodeAt(0));

/** How far in from its place's edge a triangle lies on a map made for it, in pixels, as a map is read from between them. */
const PLACE_INSET_PX = 2;
/** A place smaller than this, in pixels, holds too little to be worth it. */
const SMALLEST_PLACE_PX = 8;

/** A mesh's triangles under one material, in world space, a corner at a time. */
export interface MeshChunk {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  /** Vertex colours, for a material that draws with them. */
  colors?: Float32Array;
}

/** Draws with `run` on a target of its own, leaving the renderer as it was. */
const onTarget = <T>(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, run: () => T): T => {
  const before = { target: renderer.getRenderTarget(), autoClear: renderer.autoClear, alpha: renderer.getClearAlpha(), colour: renderer.getClearColor(new THREE.Color()) };
  try {
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    return run();
  } finally {
    renderer.setRenderTarget(before.target);
    renderer.autoClear = before.autoClear;
    renderer.setClearColor(before.colour, before.alpha);
  }
};

/**
 * What a material works out for one value, across the map of each mesh that draws with it: RGBA from the bottom row up, alpha
 * saying which pixels a mesh covers, in bytes or for a value that can go past them in floats.
 */
export const drawnValue = (
  renderer: THREE.WebGLRenderer, camera: THREE.Camera, material: THREE.Material, meshes: readonly THREE.Mesh[],
  value: CapturedValue, edge: number, place: 'uv' | typeof BAKE_PLACE_ATTRIBUTE,
): Uint8Array | Float32Array => {
  const unbounded = isUnboundedValue(value);
  const capture = captureMaterial(material, value, place);
  const nothing = new THREE.MeshBasicMaterial({ visible: false });
  const target = new THREE.WebGLRenderTarget(edge, edge, {
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false, depthBuffer: false,
    ...(unbounded ? { type: THREE.FloatType } : {}),
  });
  try {
    return onTarget(renderer, target, () => {
      for (const mesh of meshes) {
        const instanced = mesh as THREE.InstancedMesh;
        const own = { material: mesh.material, culled: mesh.frustumCulled, count: instanced.count, children: mesh.children.map((child) => child.visible) };
        mesh.material = Array.isArray(own.material) ? own.material.map((item) => (item === material ? capture : nothing)) : capture;
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
      const pixels = unbounded ? new Float32Array(edge * edge * 4) : new Uint8Array(edge * edge * 4);
      renderer.readRenderTargetPixels(target, 0, 0, edge, edge, pixels);
      return pixels;
    });
  } finally {
    target.dispose();
    capture.dispose();
    nothing.dispose();
  }
};

/** Where a material's shader moves each vertex of a mesh, in world space, with the way each then faces. */
export interface MovedVertices {
  positions: Float32Array;
  normals: Float32Array;
}

const vertexGrid = (count: number): { columns: number; rows: number } => {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  return { columns, rows: Math.max(1, Math.ceil(count / columns)) };
};

/** Reads back where a shader puts a mesh's vertices, which it alone knows: waves, wind and offsets wired in a graph. */
export const movedVertices = (renderer: THREE.WebGLRenderer, camera: THREE.Camera, mesh: THREE.Mesh, material: THREE.Material): MovedVertices => {
  const count = mesh.geometry.getAttribute('position').count;
  const grid = vertexGrid(count);
  const read = (value: 'worldPosition' | 'worldNormal'): Float32Array => {
    const capture = captureMaterial(material, value, grid);
    const points = new THREE.Points(mesh.geometry, capture);
    points.matrixAutoUpdate = false;
    points.matrixWorldAutoUpdate = false;
    points.matrixWorld.copy(mesh.matrixWorld);
    points.frustumCulled = false;
    const target = new THREE.WebGLRenderTarget(grid.columns, grid.rows, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false, depthBuffer: false });
    try {
      return onTarget(renderer, target, () => {
        renderer.render(points, camera);
        const pixels = new Float32Array(grid.columns * grid.rows * 4);
        renderer.readRenderTargetPixels(target, 0, 0, grid.columns, grid.rows, pixels);
        const out = new Float32Array(count * 3);
        for (let vertex = 0; vertex < count; vertex += 1) out.set(pixels.subarray(vertex * 4, vertex * 4 + 3), vertex * 3);
        return out;
      });
    } finally {
      target.dispose();
      capture.dispose();
    }
  };
  return { positions: read('worldPosition'), normals: read('worldNormal') };
};

const merged = (chunks: readonly MeshChunk[], key: 'positions' | 'normals' | 'uvs'): Float32Array => {
  const all = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk[key].length, 0));
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk[key], at);
    at += chunk[key].length;
  }
  return all;
};

const mergedColors = (chunks: readonly MeshChunk[]): Float32Array | null => {
  if (!chunks.every((chunk) => chunk.colors)) return null;
  const all = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.colors!.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk.colors!, at);
    at += chunk.colors!.length;
  }
  return all;
};

/** A mesh of the surfaces as they stand in the level, for a material to be drawn out on, each corner placed on the map by `places`. */
const standingMesh = (positions: Float32Array, normals: Float32Array, uvs: Float32Array, colors: Float32Array | null, places: Float32Array): THREE.Mesh => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (colors) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute(BAKE_PLACE_ATTRIBUTE, new THREE.BufferAttribute(places, 2));
  return new THREE.Mesh(geometry);
};

/** Surfaces to draw out on a map of their own, and where each corner lies on it. */
export interface PlacedSurfaces {
  mesh: THREE.Mesh;
  places: Float32Array;
}

/**
 * A material's surfaces as they stand in the level, each triangle with a place of its own on a map. A graph that goes by where a
 * surface stands or faces gives each its own look, where a box's six faces and every copy of it share one place on their map.
 * Null where there are too many triangles for that.
 */
export const placedTrianglesOf = (chunks: readonly MeshChunk[], edge: number): PlacedSurfaces | null => {
  const positions = merged(chunks, 'positions');
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
  return { mesh: standingMesh(positions, merged(chunks, 'normals'), merged(chunks, 'uvs'), mergedColors(chunks), places), places };
};

/** How far from the camera each ring of a surface too large for one map reaches, in metres. The last takes the rest. */
const RING_REACH = [14, 60];

/** One ring of a large surface: its triangles as a chunk of their own, and where each lies on its own map. */
export interface SurfaceRing extends PlacedSurfaces {
  chunk: MeshChunk;
}

/**
 * Splits a surface too large for one map, as terrain is, into rings around the camera, each on a map of its own. Near the camera
 * a map's every pixel then covers a centimetre or two, where a whole level on one would cover several.
 */
export const ringsAround = (chunks: readonly MeshChunk[], camera: THREE.Vector3): SurfaceRing[] => {
  const positions = merged(chunks, 'positions');
  const normals = merged(chunks, 'normals');
  const uvs = merged(chunks, 'uvs');
  const count = positions.length / 9;
  const sorted: number[][] = Array.from({ length: RING_REACH.length + 1 }, () => []);
  for (let triangle = 0; triangle < count; triangle += 1) {
    const at = triangle * 9;
    const x = (positions[at] + positions[at + 3] + positions[at + 6]) / 3 - camera.x;
    const z = (positions[at + 2] + positions[at + 5] + positions[at + 8]) / 3 - camera.z;
    const away = Math.hypot(x, z);
    const ring = RING_REACH.findIndex((reach) => away <= reach);
    sorted[ring < 0 ? RING_REACH.length : ring].push(triangle);
  }
  return sorted.filter((triangles) => triangles.length > 0).map((triangles) => {
    const ringPositions = new Float32Array(triangles.length * 9);
    const ringNormals = new Float32Array(triangles.length * 9);
    const ringUvs = new Float32Array(triangles.length * 6);
    let lowU = Infinity;
    let lowV = Infinity;
    let highU = -Infinity;
    let highV = -Infinity;
    triangles.forEach((triangle, index) => {
      ringPositions.set(positions.subarray(triangle * 9, triangle * 9 + 9), index * 9);
      ringNormals.set(normals.subarray(triangle * 9, triangle * 9 + 9), index * 9);
      ringUvs.set(uvs.subarray(triangle * 6, triangle * 6 + 6), index * 6);
    });
    for (let at = 0; at < ringUvs.length; at += 2) {
      lowU = Math.min(lowU, ringUvs[at]);
      highU = Math.max(highU, ringUvs[at]);
      lowV = Math.min(lowV, ringUvs[at + 1]);
      highV = Math.max(highV, ringUvs[at + 1]);
    }
    const spanU = Math.max(highU - lowU, 1e-6);
    const spanV = Math.max(highV - lowV, 1e-6);
    const places = new Float32Array(ringUvs.length);
    for (let at = 0; at < ringUvs.length; at += 2) {
      places[at] = (ringUvs[at] - lowU) / spanU;
      places[at + 1] = (ringUvs[at + 1] - lowV) / spanV;
    }
    return {
      chunk: { positions: ringPositions, normals: ringNormals, uvs: ringUvs },
      mesh: standingMesh(ringPositions, ringNormals, ringUvs, null, places),
      places,
    };
  });
};

/** A drawn value as a picture the way up UVs are read in, with what lies around each piece of the layout filled, as it is read from at a distance. */
export const pictureOfDrawnValue = (pixels: Uint8Array, edge: number): Uint8Array => {
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

/** Pixels in floats, from the bottom row up, as a flat Radiance picture: light of any strength, in a file most renderers read. */
export const radianceFile = (pixels: Float32Array, width: number, height: number): Uint8Array => {
  const head = new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`);
  const file = new Uint8Array(head.length + width * height * 4);
  file.set(head);
  let at = head.length;
  for (let row = height - 1; row >= 0; row -= 1) {
    for (let column = 0; column < width; column += 1, at += 4) {
      const from = (row * width + column) * 4;
      const brightest = Math.max(pixels[from], pixels[from + 1], pixels[from + 2]);
      if (!(brightest > 1e-30) || !Number.isFinite(brightest)) continue;
      const exponent = Math.floor(Math.log2(brightest)) + 1;
      const scale = 2 ** (8 - exponent);
      file[at] = Math.min(255, Math.max(0, pixels[from] * scale));
      file[at + 1] = Math.min(255, Math.max(0, pixels[from + 1] * scale));
      file[at + 2] = Math.min(255, Math.max(0, pixels[from + 2] * scale));
      file[at + 3] = exponent + 128;
    }
  }
  return file;
};

/** A layer of its own, for drawing a chosen few things from a scene that holds many. */
const OVER_LAYER = 31;

/** A target of float pixels for a picture the size of a frame. With `onScreen` what is drawn on it comes out as it does on screen, tone mapped and in display colours. */
const pictureTarget = (width: number, height: number, onScreen: boolean): THREE.WebGLRenderTarget => {
  const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false, depthBuffer: true });
  if (onScreen) {
    target.texture.colorSpace = THREE.SRGBColorSpace;
    // What three goes by to treat a target as the screen.
    (target as THREE.WebGLRenderTarget & { isXRRenderTarget?: boolean }).isXRRenderTarget = true;
  }
  return target;
};

/** Surfaces that hide what is behind them, through and through. */
const solidOf = (surfaces: readonly THREE.Mesh[]): THREE.Mesh[] => surfaces.filter((mesh) => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).some((material) => !material.transparent && material.depthWrite));

/** Runs `draw` with only the chosen objects to be drawn. Lights stay, or every material would be compiled again for having none. */
const drawingOnly = <T>(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, chosen: readonly THREE.Object3D[], draw: () => T): T => {
  const shown = new Set(chosen);
  const masks = new Map<THREE.Object3D, number>();
  scene.traverse((object) => {
    masks.set(object, object.layers.mask);
    if (shown.has(object) || (object as THREE.Light).isLight) object.layers.enable(OVER_LAYER);
    else object.layers.disable(OVER_LAYER);
  });
  const own = { background: scene.background, layers: camera.layers.mask, shadows: renderer.shadowMap.autoUpdate };
  try {
    camera.layers.set(OVER_LAYER);
    // A background colour clears the target, depth and all.
    scene.background = null;
    renderer.shadowMap.autoUpdate = false;
    return draw();
  } finally {
    scene.background = own.background;
    camera.layers.mask = own.layers;
    renderer.shadowMap.autoUpdate = own.shadows;
    masks.forEach((mask, object) => { object.layers.mask = mask; });
  }
};

const pixelsOn = (renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget): Float32Array => {
  const pixels = new Float32Array(target.width * target.height * 4);
  renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, pixels);
  return pixels;
};

/**
 * How far the shadows of the clouds dim the light on what each pixel shows, 1 for none: RGBA in floats from the bottom row up, for
 * what cannot draw them itself. It draws the surfaces with and without them, through their own shaders, with `leaveOut` taking them away.
 */
export const drawnCloudShade = (renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, surfaces: readonly THREE.Mesh[], width: number, height: number, leaveOut: () => () => void): Float32Array => {
  const target = pictureTarget(width, height, false);
  const fog = scene.fog as (THREE.Fog & THREE.FogExp2) | null;
  const own = { density: fog?.density, near: fog?.near, far: fog?.far };
  const drawn = () => onTarget(renderer, target, () => {
    renderer.render(scene, camera);
    return pixelsOn(renderer, target);
  });
  try {
    if (fog?.isFogExp2) fog.density = 0;
    else if (fog) { fog.near = 1e9; fog.far = 2e9; }
    return drawingOnly(renderer, scene, camera, solidOf(surfaces), () => {
      const shaded = drawn();
      const putBack = leaveOut();
      let clear: Float32Array;
      try {
        clear = drawn();
      } finally {
        putBack();
      }
      const shade = new Float32Array(width * height * 4);
      for (let at = 0; at < shade.length; at += 4) {
        const without = clear[at] + clear[at + 1] + clear[at + 2];
        shade.fill(without > 1e-5 ? Math.min(1, (shaded[at] + shaded[at + 1] + shaded[at + 2]) / without) : 1, at, at + 3);
        shade[at + 3] = 1;
      }
      return shade;
    });
  } finally {
    if (fog?.isFogExp2) fog.density = own.density!;
    else if (fog) { fog.near = own.near!; fog.far = own.far!; }
    target.dispose();
  }
};

/**
 * The colour fog turns things in each direction, as a picture, RGBA in floats from the bottom row up. It may follow the sky behind
 * it, so nothing but a surface's own shader knows it: this draws a surface all round the camera, all of it lost in the fog.
 */
export const drawnFogColour = (renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, width: number, height: number, onScreen: boolean): Float32Array => {
  const fog = scene.fog as (THREE.Fog & THREE.FogExp2);
  const own = { density: fog.density, near: fog.near, far: fog.far };
  const target = pictureTarget(width, height, onScreen);
  const round = new THREE.Mesh(new THREE.SphereGeometry(Math.min(camera.far * 0.5, camera.near * 100), 32, 16), new THREE.MeshLambertMaterial({ side: THREE.BackSide, depthTest: false, depthWrite: false }));
  round.position.copy(camera.getWorldPosition(new THREE.Vector3()));
  round.frustumCulled = false;
  round.updateMatrixWorld(true);
  try {
    if (fog.isFogExp2) fog.density = 1000;
    else { fog.near = 0; fog.far = 1e-3; }
    scene.add(round);
    return drawingOnly(renderer, scene, camera, [round], () => onTarget(renderer, target, () => {
      renderer.render(scene, camera);
      return pixelsOn(renderer, target);
    }));
  } finally {
    scene.remove(round);
    if (fog.isFogExp2) fog.density = own.density;
    else { fog.near = own.near; fog.far = own.far; }
    round.geometry.dispose();
    (round.material as THREE.Material).dispose();
    target.dispose();
  }
};

/**
 * What has no surface for a ray to meet, drawn as the view draws it and hidden by what stands in front of it: particles. RGBA in
 * floats from the bottom row up, already blended, to go over the picture as it would over the scene. With no post-process stack
 * the view blends them on screen, tone mapped and in display colours, and with `onScreen` these come out the same way.
 */
export const drawnOverPicture = (
  renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, surfaces: readonly THREE.Mesh[], effects: readonly THREE.Mesh[], width: number, height: number, onScreen: boolean,
): Float32Array => {
  const target = pictureTarget(width, height, onScreen);
  const materialsOf = (mesh: THREE.Mesh) => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]);
  // Through their own shaders, so a leaf's holes and a wave's height hide what they should. What can be seen through hides nothing.
  const solid = solidOf(surfaces);
  const solidMaterials = [...new Set(solid.flatMap(materialsOf))].filter((material) => material.colorWrite);
  // Light added to a picture leaves what is behind it as it was: blended over nothing, it would also be counted as covering it.
  const added = effects.flatMap(materialsOf).filter((material) => material.blending === THREE.AdditiveBlending);
  try {
    return onTarget(renderer, target, () => {
      solidMaterials.forEach((material) => { material.colorWrite = false; });
      try {
        drawingOnly(renderer, scene, camera, solid, () => renderer.render(scene, camera));
      } finally {
        solidMaterials.forEach((material) => { material.colorWrite = true; });
      }
      for (const material of added) {
        material.blending = THREE.CustomBlending;
        material.blendSrc = THREE.SrcAlphaFactor;
        material.blendDst = THREE.OneFactor;
        material.blendSrcAlpha = THREE.ZeroFactor;
        material.blendDstAlpha = THREE.OneFactor;
      }
      try {
        drawingOnly(renderer, scene, camera, effects, () => renderer.render(scene, camera));
      } finally {
        for (const material of added) material.blending = THREE.AdditiveBlending;
      }
      return pixelsOn(renderer, target);
    });
  } finally {
    target.dispose();
  }
};

/** A glow of any strength as a picture and how strong it is at its brightest, or just the strength where it is one colour all over. */
export interface DrawnGlow {
  /** The least and most it comes to, by channel, in linear light. */
  least: [number, number, number];
  brightest: number;
  /** In a picture's values, its brightest at 255. Null where it does not vary. */
  pixels: Uint8Array | null;
}

/** How far a glow may vary and still count as one colour, as a share of its brightest. */
const EVEN_GLOW = 0.01;

const encodedOfLinear = (linear: number): number => (linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055);

export const readGlow = (pixels: Float32Array): DrawnGlow => {
  const least: [number, number, number] = [Infinity, Infinity, Infinity];
  const most: [number, number, number] = [0, 0, 0];
  for (let at = 0; at < pixels.length; at += 4) {
    if (!pixels[at + 3]) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      least[channel] = Math.min(least[channel], pixels[at + channel]);
      most[channel] = Math.max(most[channel], pixels[at + channel]);
    }
  }
  if (least[0] === Infinity) return { least: [0, 0, 0], brightest: 0, pixels: null };
  const brightest = Math.max(most[0], most[1], most[2]);
  const varies = most.some((value, channel) => value - least[channel] > brightest * EVEN_GLOW);
  if (!varies || brightest <= 0) return { least, brightest, pixels: null };
  const out = new Uint8Array(pixels.length);
  for (let at = 0; at < pixels.length; at += 4) {
    if (!pixels[at + 3]) continue;
    for (let channel = 0; channel < 3; channel += 1) out[at + channel] = Math.round(encodedOfLinear(Math.min(1, pixels[at + channel] / brightest)) * 255);
    out[at + 3] = 255;
  }
  return { least, brightest, pixels: out };
};
