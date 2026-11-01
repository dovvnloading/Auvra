import * as THREE from 'three';
import { overrideTextureFlipY } from '../../../utils/materialOverrides';
import { blurred, type Pixels } from './keepOriginal';
import type { ModelPart, PartMaterial } from './parts';

/**
 * A texture map means little as a picture: cut into islands, it shows a model scraps, each of which it treats on its own. The
 * object itself means something. So a map is changed through pictures of the object as it is drawn now: one sheet of it seen
 * from every side, which a model edits as one picture, whose changes are then put back on the map through the same cameras.
 */

const SHEET_COLUMNS = 3;
const SHEET_ROWS = 2;
const CELL_PX = 682;
/** Room around the object in its cell, as a model can move an outline a little. */
const CELL_MARGIN = 1.08;
/** A plain mid grey, which nothing is mistaken for and a model leaves alone. */
const BACKDROP = 128;

/** What a sheet comes to, for working out what a run costs. */
export const SHEET_MEGAPIXELS = (CELL_PX * SHEET_COLUMNS * CELL_PX * SHEET_ROWS) / 1_000_000;
/** The broad colour of a cell is worked out at this size: only its overall look is wanted from it. */
const BROAD_CELL_PX = 128;
const BROAD_BLUR_RADIUS = 3;
/** How far behind what a camera sees a point may lie and still count as seen, as a share of the depth range. */
const SEEN_DEPTH_BIAS = 0.004;

/** How a sheet's picture goes back on an object. */
export interface BakeStyle {
  /** How sharply the views hand over to each other around it. */
  handover: number;
  /** A view that sees a surface more edge-on than this counts only where no other can see it, as down a barrel. */
  leastFacing: number;
  /** A pixel of a view this near its object's outline does not count, as a model's outline is never quite where it was. */
  outlinePx: number;
}

/** Only broad colour moves in a change to a map, so a long blend hides any difference between the views. */
const CHANGING: BakeStyle = { handover: 3, leastFacing: 0, outlinePx: 0 };
/** Painted from nothing, a picture goes on as it is: a long blend would show two views' detail at once, and what is picked up from the backdrop would stay. What no view can answer for then takes its colour from what is next to it. */
const PAINTING: BakeStyle = { handover: 8, leastFacing: 0.2, outlinePx: 2 };

const VIEW_DIRECTIONS: readonly [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];

export interface SheetCell {
  camera: THREE.OrthographicCamera;
  /** From the object towards the camera. */
  direction: THREE.Vector3;
  /** Left and bottom of the cell in the sheet, in pixels from its bottom left. */
  x: number;
  y: number;
}

export interface ViewSheet {
  width: number;
  height: number;
  cell: number;
  cells: SheetCell[];
  /** The object as drawn: RGBA, from the bottom row up. Alpha tells it from what is around it. */
  drawn: Uint8Array;
  /** The sheet as a model is sent it. */
  picture: string;
}

const meshesOf = (object: THREE.Object3D, part: ModelPart): THREE.Mesh[] => {
  const meshes: THREE.Mesh[] = [];
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).some((material) => part.materials.includes(material as PartMaterial))) meshes.push(mesh);
  });
  return meshes;
};

/** Runs `work` with a renderer of its own, which is gone again after. Returns null where one cannot be had. */
const withRenderer = <T>(work: (renderer: THREE.WebGLRenderer) => T): T | null => {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
  } catch {
    return null;
  }
  try {
    renderer.setSize(1, 1, false);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = false;
    return work(renderer);
  } finally {
    renderer.dispose();
    renderer.forceContextLoss();
  }
};

const camerasFor = (object: THREE.Object3D, part: ModelPart, cell: number): SheetCell[] | null => {
  const box = new THREE.Box3();
  for (const mesh of meshesOf(object, part)) box.expandByObject(mesh);
  if (box.isEmpty()) return null;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const reach = size.length() || 1;
  return VIEW_DIRECTIONS.map(([x, y, z], index) => {
    const direction = new THREE.Vector3(x, y, z);
    const up = y !== 0 ? new THREE.Vector3(0, 0, -y) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, direction);
    const across = Math.abs(right.x) * size.x + Math.abs(right.y) * size.y + Math.abs(right.z) * size.z;
    const high = Math.abs(up.x) * size.x + Math.abs(up.y) * size.y + Math.abs(up.z) * size.z;
    const half = (Math.max(across, high, reach * 0.01) * CELL_MARGIN) / 2;
    const camera = new THREE.OrthographicCamera(-half, half, half, -half, reach * 0.1, reach * 3);
    camera.position.copy(center).addScaledVector(direction, reach * 1.5);
    camera.up.copy(up);
    camera.lookAt(center);
    camera.updateMatrixWorld(true);
    const column = index % SHEET_COLUMNS;
    const rowFromTop = Math.floor(index / SHEET_COLUMNS);
    return { camera, direction, x: column * cell, y: (SHEET_ROWS - 1 - rowFromTop) * cell };
  });
};

const CLAY_LIGHT_EDGE = 64;
/** Where the light comes from, seen from the camera, whichever side that is. */
const CLAY_LIGHT = new THREE.Vector3(-0.25, 0.45, 0.85).normalize();
/** No darker than this, so that nothing is lost in the backdrop. */
const CLAY_SHADE = 0.3;
const CLAY_LIT = 0.45;

/** Soft light by the way a surface faces, with nothing cast: a shape reads from any side, and no shadow falls on it to paint over. */
const clayLight = (): THREE.DataTexture => {
  const pixels = new Uint8Array(CLAY_LIGHT_EDGE * CLAY_LIGHT_EDGE * 4);
  for (let y = 0; y < CLAY_LIGHT_EDGE; y += 1) {
    for (let x = 0; x < CLAY_LIGHT_EDGE; x += 1) {
      const nx = ((x + 0.5) / CLAY_LIGHT_EDGE) * 2 - 1;
      const ny = ((y + 0.5) / CLAY_LIGHT_EDGE) * 2 - 1;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const shade = CLAY_SHADE + CLAY_LIT * Math.max(0, nx * CLAY_LIGHT.x + ny * CLAY_LIGHT.y + nz * CLAY_LIGHT.z);
      pixels.fill(Math.round(shade * 255), (y * CLAY_LIGHT_EDGE + x) * 4, (y * CLAY_LIGHT_EDGE + x) * 4 + 3);
      pixels[(y * CLAY_LIGHT_EDGE + x) * 4 + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(pixels, CLAY_LIGHT_EDGE, CLAY_LIGHT_EDGE, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
};

/** What the part being worked on is shown as: a plain shape to paint, or wearing a given map, rather than what is on it now. */
export type SheetLook = { asShape: true } | { map: THREE.Texture };

/**
 * Draws the object as it looks without any light, its materials put back after. With `shapeOf`, that part and whatever else
 * has no picture of its own are drawn as a plain shape instead, for painting from nothing. With a `look` wearing a map, the
 * part draws with that.
 */
const drawCells = (renderer: THREE.WebGLRenderer, object: THREE.Object3D, cells: readonly SheetCell[], cell: number, target: THREE.WebGLRenderTarget, part?: ModelPart, look?: SheetLook) => {
  const undo: (() => void)[] = [];
  const flatOf = new Map<THREE.Material, THREE.Material>();
  const clay = look && 'asShape' in look ? clayLight() : null;
  const flat = (from: THREE.Material): THREE.Material => {
    let copy = flatOf.get(from);
    if (!copy) {
      const source = from as PartMaterial & { alphaMap?: THREE.Texture | null };
      const inPart = part?.materials.includes(source) ?? false;
      copy = clay && (!source.map || inPart) ? new THREE.MeshMatcapMaterial({ matcap: clay, side: THREE.DoubleSide }) : new THREE.MeshBasicMaterial({
        map: (inPart && look && 'map' in look ? look.map : source.map) ?? null,
        alphaMap: source.alphaMap ?? null,
        color: source.color ?? 0xffffff,
        side: THREE.DoubleSide,
        transparent: source.transparent,
        alphaTest: source.alphaTest,
        opacity: source.opacity,
        depthWrite: source.depthWrite,
        toneMapped: false,
      });
      flatOf.set(from, copy);
    }
    return copy;
  };
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const own = mesh.material;
    const culled = mesh.frustumCulled;
    mesh.material = Array.isArray(own) ? own.map(flat) : flat(own);
    mesh.frustumCulled = false;
    undo.push(() => { mesh.material = own; mesh.frustumCulled = culled; });
  });
  try {
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    target.scissorTest = true;
    for (const view of cells) {
      target.viewport.set(view.x, view.y, cell, cell);
      target.scissor.set(view.x, view.y, cell, cell);
      renderer.setRenderTarget(target);
      renderer.render(object, view.camera);
    }
  } finally {
    undo.forEach((step) => step());
    flatOf.forEach((copy) => copy.dispose());
    clay?.dispose();
    renderer.setRenderTarget(null);
  }
};

const sheetTarget = (width: number, height: number, withDepth: boolean) => {
  const target = new THREE.WebGLRenderTarget(width, height, { colorSpace: THREE.SRGBColorSpace, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
  if (withDepth) {
    target.depthTexture = new THREE.DepthTexture(width, height, THREE.UnsignedIntType);
    target.depthTexture.minFilter = THREE.NearestFilter;
    target.depthTexture.magFilter = THREE.NearestFilter;
  }
  return target;
};

/** The object from every side, as a model is to be shown it, or null where it cannot be drawn. */
export const renderViewSheet = (object: THREE.Object3D, part: ModelPart, look?: SheetLook): ViewSheet | null => withRenderer((renderer) => {
  const cell = CELL_PX;
  const width = cell * SHEET_COLUMNS;
  const height = cell * SHEET_ROWS;
  const cells = camerasFor(object, part, cell);
  if (!cells) return null;
  object.updateMatrixWorld(true);
  const target = sheetTarget(width, height, true);
  try {
    drawCells(renderer, object, cells, cell, target, part, look);
    const drawn = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, drawn);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    const image = context.createImageData(width, height);
    for (let y = 0; y < height; y += 1) {
      const from = (height - 1 - y) * width * 4;
      const to = y * width * 4;
      for (let x = 0; x < width * 4; x += 4) {
        const solid = drawn[from + x + 3] > 127;
        image.data[to + x] = solid ? drawn[from + x] : BACKDROP;
        image.data[to + x + 1] = solid ? drawn[from + x + 1] : BACKDROP;
        image.data[to + x + 2] = solid ? drawn[from + x + 2] : BACKDROP;
        image.data[to + x + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    return { width, height, cell, cells, drawn, picture: canvas.toDataURL('image/png') };
  } finally {
    target.depthTexture?.dispose();
    target.dispose();
  }
});

/** A sheet's picture at a low size, each cell's colour spread over and past its object so that nothing is read from the backdrop. */
const broadSheet = (sheet: ViewSheet, picture: Uint8Array): THREE.DataTexture => {
  const { width, cell } = sheet;
  const columns = SHEET_COLUMNS * BROAD_CELL_PX;
  const rows = SHEET_ROWS * BROAD_CELL_PX;
  const out = new Uint8Array(columns * rows * 4);
  const count = BROAD_CELL_PX * BROAD_CELL_PX;
  const step = cell / BROAD_CELL_PX;
  for (const view of sheet.cells) {
    const mask = new Float32Array(count);
    const channels = [new Float32Array(count), new Float32Array(count), new Float32Array(count)];
    const totals = [0, 0, 0];
    let solidPixels = 0;
    for (let y = 0; y < cell; y += 1) {
      const row = Math.min(BROAD_CELL_PX - 1, Math.floor(y / step));
      for (let x = 0; x < cell; x += 1) {
        const at = ((view.y + y) * width + view.x + x) * 4;
        if (sheet.drawn[at + 3] < 128) continue;
        const low = row * BROAD_CELL_PX + Math.min(BROAD_CELL_PX - 1, Math.floor(x / step));
        mask[low] += 1;
        solidPixels += 1;
        for (let channel = 0; channel < 3; channel += 1) {
          channels[channel][low] += picture[at + channel];
          totals[channel] += picture[at + channel];
        }
      }
    }
    const spread = blurred(mask, BROAD_CELL_PX, BROAD_CELL_PX, BROAD_BLUR_RADIUS);
    const originColumn = Math.round(view.x / step);
    const originRow = Math.round(view.y / step);
    for (let channel = 0; channel < 3; channel += 1) {
      const blurredChannel = blurred(channels[channel], BROAD_CELL_PX, BROAD_CELL_PX, BROAD_BLUR_RADIUS);
      const mean = solidPixels ? totals[channel] / solidPixels : 0;
      for (let low = 0; low < count; low += 1) {
        const at = ((originRow + Math.floor(low / BROAD_CELL_PX)) * columns + originColumn + (low % BROAD_CELL_PX)) * 4;
        out[at + channel] = Math.round(spread[low] > 0.001 ? blurredChannel[low] / spread[low] : mean);
        out[at + 3] = 255;
      }
    }
  }
  const texture = new THREE.DataTexture(out, columns, rows, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
};

const BAKE_VERTEX = /* glsl */ `
  #include <common>
  #include <morphtarget_pars_vertex>
  #include <skinning_pars_vertex>
  uniform float flipV;
  varying vec3 vWorld;
  varying vec3 vFacing;
  void main() {
    #include <beginnormal_vertex>
    #include <morphnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    #include <begin_vertex>
    #include <morphtarget_vertex>
    #include <skinning_vertex>
    vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
    vFacing = mat3(modelMatrix) * objectNormal;
    float row = flipV > 0.5 ? 1.0 - uv.y : uv.y;
    gl_Position = vec4(uv.x * 2.0 - 1.0, row * 2.0 - 1.0, 0.0, 1.0);
  }
`;

const BAKE_FRAGMENT = /* glsl */ `
  uniform sampler2D colors;
  uniform sampler2D depths;
  uniform mat4 cameras[6];
  uniform vec4 cellsInSheet[6];
  uniform vec3 directions[6];
  uniform float bias;
  uniform float handover;
  uniform float leastFacing;
  uniform vec2 outlineReach;
  uniform float flipV;
  #ifdef AS_NORMALS
    uniform sampler2D broadColors;
    uniform mat3 frames[6];
  #endif
  varying vec3 vWorld;
  varying vec3 vFacing;
  void main() {
    vec3 facing = normalize(vFacing);
    vec3 sum = vec3(0.0);
    float weights = 0.0;
    vec3 edgeOnSum = vec3(0.0);
    float edgeOnWeights = 0.0;
    for (int view = 0; view < 6; view++) {
      vec4 clip = cameras[view] * vec4(vWorld, 1.0);
      vec3 ndc = clip.xyz / clip.w;
      if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) continue;
      vec2 at = cellsInSheet[view].xy + (ndc.xy * 0.5 + 0.5) * cellsInSheet[view].zw;
      if (ndc.z * 0.5 + 0.5 > texture2D(depths, at).r + bias) continue;
      float toward = abs(dot(facing, directions[view]));
      if (outlineReach.x > 0.0 && (
        texture2D(depths, at + outlineReach).r >= 1.0 || texture2D(depths, at - outlineReach).r >= 1.0
        || texture2D(depths, at + vec2(outlineReach.x, -outlineReach.y)).r >= 1.0 || texture2D(depths, at - vec2(outlineReach.x, -outlineReach.y)).r >= 1.0
      )) continue;
      float weight = pow(toward, handover) + 0.001;
      #ifdef AS_NORMALS
        // A normal map's picture tells of the view it was drawn from. The mesh has the large shapes itself, so only what differs
        // from the normals around it is wanted, as a turn of the surface along that view's own right and up.
        vec3 told = (texture2D(colors, at).rgb - texture2D(broadColors, at).rgb) * 2.0;
        vec3 seen = frames[view][0] * told.x + frames[view][1] * told.y;
      #else
        vec3 seen = texture2D(colors, at).rgb;
      #endif
      if (toward < leastFacing) {
        edgeOnSum += seen * weight;
        edgeOnWeights += weight;
      } else {
        sum += seen * weight;
        weights += weight;
      }
    }
    #ifdef AS_NORMALS
      // A normal map tells of the surface along its map's own directions, which is how each triangle lies on the map: the place
      // being drawn here. Which way the object was seen from means nothing to it.
      vec3 turn = weights > 0.0 ? sum / weights : edgeOnWeights > 0.0 ? edgeOnSum / edgeOnWeights : vec3(0.0);
      vec3 turned = normalize(facing + turn);
      vec3 across = normalize(dFdx(vWorld));
      vec3 along = normalize(dFdy(vWorld)) * (flipV > 0.5 ? -1.0 : 1.0);
      float seenAtAll = weights + edgeOnWeights > 0.0 ? 1.0 : 0.0;
      gl_FragColor = vec4(vec3(dot(turned, across), dot(turned, along), dot(turned, facing)) * 0.5 + 0.5, seenAtAll);
    #else
      gl_FragColor = weights > 0.0 ? vec4(sum / weights, 1.0) : edgeOnWeights > 0.0 ? vec4(edgeOnSum / edgeOnWeights, 1.0) : vec4(0.0);
    #endif
  }
`;

/** What a sheet's edit comes to on a map, a pixel at a time and in the map's own order. Alpha in `broad` says whether any camera saw that pixel. */
export interface BakedViews {
  /** The broad colour after and before the edit, whose difference is the change to make. */
  broad: Uint8Array;
  before: Uint8Array;
  /** The edit's own picture. */
  painted: Uint8Array;
}

/** What a bake can draw on a map. */
interface BakeSources {
  painted: THREE.Texture;
  /** The broad colour of a sheet's cells, of what was painted and of what was shown. */
  broadAfter: () => THREE.Texture;
  broadBefore: () => THREE.Texture;
}

/** Sets up putting a sheet's picture back on a part's map through the cameras that made it, and hands `work` the means to draw that. */
const withBake = <T>(
  object: THREE.Object3D, part: ModelPart, sheet: ViewSheet, painted: Pixels, width: number, height: number, style: BakeStyle, asNormals: boolean,
  work: (read: (colors: THREE.Texture) => Uint8Array, sources: BakeSources) => T,
): T | null => withRenderer((renderer) => {
  const fromBottom = new Uint8Array(sheet.width * sheet.height * 4);
  for (let y = 0; y < sheet.height; y += 1) {
    fromBottom.set(painted.data.subarray(y * sheet.width * 4, (y + 1) * sheet.width * 4), (sheet.height - 1 - y) * sheet.width * 4);
  }
  object.updateMatrixWorld(true);
  const depth = sheetTarget(sheet.width, sheet.height, true);
  drawCells(renderer, object, sheet.cells, sheet.cell, depth);
  const paintedTexture = new THREE.DataTexture(fromBottom, sheet.width, sheet.height, THREE.RGBAFormat);
  paintedTexture.minFilter = THREE.LinearFilter;
  paintedTexture.magFilter = THREE.LinearFilter;
  paintedTexture.needsUpdate = true;
  const made: THREE.Texture[] = [];
  const once = (make: () => THREE.Texture) => {
    let texture: THREE.Texture | null = null;
    return () => {
      if (!texture) {
        texture = make();
        made.push(texture);
      }
      return texture;
    };
  };
  const broadAfter = once(() => broadSheet(sheet, fromBottom));
  const broadBefore = once(() => broadSheet(sheet, sheet.drawn));
  const material = new THREE.ShaderMaterial({
    vertexShader: BAKE_VERTEX,
    fragmentShader: BAKE_FRAGMENT,
    defines: asNormals ? { AS_NORMALS: 1 } : {},
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      colors: { value: paintedTexture },
      depths: { value: depth.depthTexture },
      cameras: { value: sheet.cells.map((view) => new THREE.Matrix4().multiplyMatrices(view.camera.projectionMatrix, view.camera.matrixWorldInverse)) },
      cellsInSheet: { value: sheet.cells.map((view) => new THREE.Vector4(view.x / sheet.width, view.y / sheet.height, sheet.cell / sheet.width, sheet.cell / sheet.height)) },
      directions: { value: sheet.cells.map((view) => view.direction) },
      bias: { value: SEEN_DEPTH_BIAS },
      handover: { value: style.handover },
      leastFacing: { value: style.leastFacing },
      outlineReach: { value: new THREE.Vector2(style.outlinePx / sheet.width, style.outlinePx / sheet.height) },
      // The way round the picture of the map is, which a compressed texture cannot say.
      flipV: { value: overrideTextureFlipY(object) ? 1 : 0 },
      ...(asNormals ? {
        broadColors: { value: broadAfter() },
        frames: { value: sheet.cells.map((view) => new THREE.Matrix3().setFromMatrix4(view.camera.matrixWorld)) },
      } : {}),
    },
  });
  const nothing = new THREE.MeshBasicMaterial({ visible: false });
  const undo: (() => void)[] = [];
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const own = mesh.material;
    const culled = mesh.frustumCulled;
    const swap = (from: THREE.Material) => (part.materials.includes(from as PartMaterial) ? material : nothing);
    mesh.material = Array.isArray(own) ? own.map(swap) : swap(own);
    mesh.frustumCulled = false;
    undo.push(() => { mesh.material = own; mesh.frustumCulled = culled; });
  });
  const target = new THREE.WebGLRenderTarget(width, height, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false, depthBuffer: false });
  const camera = new THREE.Camera();
  const read = (colors: THREE.Texture): Uint8Array => {
    material.uniforms.colors.value = colors;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(object, camera);
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    return pixels;
  };
  try {
    renderer.autoClear = false;
    return work(read, { painted: paintedTexture, broadAfter, broadBefore });
  } finally {
    undo.forEach((step) => step());
    renderer.setRenderTarget(null);
    target.dispose();
    depth.depthTexture?.dispose();
    depth.dispose();
    paintedTexture.dispose();
    made.forEach((texture) => texture.dispose());
    material.dispose();
    nothing.dispose();
  }
});

/** Puts an edit of a sheet back on a part's map through the cameras that made it, or null where that cannot be drawn. */
export const bakeViews = (object: THREE.Object3D, part: ModelPart, sheet: ViewSheet, painted: Pixels, width: number, height: number): BakedViews | null => (
  withBake(object, part, sheet, painted, width, height, CHANGING, false, (read, { painted: picture, broadAfter, broadBefore }) => ({ broad: read(broadAfter()), before: read(broadBefore()), painted: read(picture) }))
);

/** Puts a sheet painted from nothing on a part's map as it is, or null where that cannot be drawn: RGBA, alpha saying whether any camera saw that pixel. */
export const bakePainted = (object: THREE.Object3D, part: ModelPart, sheet: ViewSheet, painted: Pixels, width: number, height: number): Uint8Array | null => (
  withBake(object, part, sheet, painted, width, height, PAINTING, false, (read, { painted: picture }) => read(picture))
);

/** Puts a sheet's normals on a part's map as a normal map of its fine detail, or null where that cannot be drawn. */
export const bakeNormals = (object: THREE.Object3D, part: ModelPart, sheet: ViewSheet, painted: Pixels, width: number, height: number): Uint8Array | null => (
  withBake(object, part, sheet, painted, width, height, PAINTING, true, (read, { painted: picture }) => read(picture))
);
