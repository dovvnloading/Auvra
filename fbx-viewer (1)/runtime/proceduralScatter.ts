import * as THREE from 'three';
import { sceneDaylight } from './daylight';

/**
 * PROCEDURAL SCATTER
 *
 * Fills an area with copies of models by rules instead of by hand: forests, rocks, grass, ruins. Each
 * layer places one model at a density, keeps its copies (and every other layer's) a spacing apart,
 * gathers them in clumps, and keeps to the ground it likes: a slope range and a height range. Copies
 * stand on whatever is under them (terrain or level meshes), lean with the ground as much as asked,
 * turn and size at random. The same seed always gives the same placement.
 *
 * Drawing keeps large scatters cheap. The area is cut into cells, each drawn as one batch per model
 * part; a cell near the camera draws its models, a farther one draws each copy as a flat picture of
 * the model turned toward the camera (an impostor, rendered from the model once), and beyond that
 * nothing.
 */

export type ScatterCollision = 'none' | 'trunk' | 'box';
export const SCATTER_COLLISIONS: readonly ScatterCollision[] = ['none', 'trunk', 'box'];

export interface ScatterLayer {
    modelId: string;
    /** Copies per 100 m². */
    density: number;
    /** Metres kept clear around each copy, from this layer's and every other layer's. */
    spacing: number;
    /** Uniform scale, picked between the two. */
    scale: [number, number];
    /** 0 stands upright, 1 leans with the ground. */
    align: number;
    /** Degrees of ground slope the layer grows on. */
    slope: [number, number];
    /** World heights (m) it grows between. */
    height: [number, number];
    /** 0 spreads evenly, 1 gathers in clumps of about clumpSize metres. */
    clump: number;
    clumpSize: number;
    /** Metres up (negative: down into the ground). */
    sink: number;
    /** In play: none, a narrow column (tree trunks), or the model's box. */
    collision: ScatterCollision;
}

export interface ScatterSettings {
    /** The area: width (X), height to search for ground within (Y), depth (Z), metres, centred on the object. */
    size: [number, number, number];
    seed: number;
    layers: ScatterLayer[];
    /** Metres across each cell drawn as one batch. */
    cellSize: number;
    /** Beyond this, a cell's copies are drawn as impostors; 0 never. */
    impostorDistance: number;
    /** Beyond this, a cell is not drawn; 0 never. */
    cullDistance: number;
    castShadow: boolean;
}

/** Most copies one layer places. */
export const MAX_SCATTER_PER_LAYER = 20000;
export const MAX_SCATTER_LAYERS = 6;

export const DEFAULT_SCATTER_LAYER: ScatterLayer = {
    modelId: '', density: 2, spacing: 3, scale: [0.8, 1.2], align: 0, slope: [0, 35], height: [-1000, 1000],
    clump: 0.3, clumpSize: 12, sink: 0, collision: 'none',
};

export const DEFAULT_SCATTER_SETTINGS: ScatterSettings = {
    size: [60, 40, 60], seed: 1, layers: [], cellSize: 24, impostorDistance: 80, cullDistance: 300, castShadow: true,
};

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const num = (value: unknown, fallback: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, typeof value === 'number' && Number.isFinite(value) ? value : fallback));
const pair = (value: unknown, fallback: [number, number], min: number, max: number): [number, number] => {
    if (!Array.isArray(value) || value.length < 2) return [...fallback];
    const a = num(value[0], fallback[0], min, max);
    const b = num(value[1], fallback[1], min, max);
    return a <= b ? [a, b] : [b, a];
};

export const sanitizeScatterLayer = (value: unknown): ScatterLayer => {
    const l = record(value);
    const base = DEFAULT_SCATTER_LAYER;
    return {
        modelId: typeof l.modelId === 'string' ? l.modelId.slice(0, 128) : '',
        density: num(l.density, base.density, 0, 1000),
        spacing: num(l.spacing, base.spacing, 0, 100),
        scale: pair(l.scale, base.scale, 0.01, 100),
        align: num(l.align, base.align, 0, 1),
        slope: pair(l.slope, base.slope, 0, 90),
        height: pair(l.height, base.height, -100000, 100000),
        clump: num(l.clump, base.clump, 0, 1),
        clumpSize: num(l.clumpSize, base.clumpSize, 0.5, 1000),
        sink: num(l.sink, base.sink, -100, 100),
        collision: typeof l.collision === 'string' && (SCATTER_COLLISIONS as readonly string[]).includes(l.collision) ? l.collision as ScatterCollision : base.collision,
    };
};

/** A scatter component's settings from its props, every field defaulted and in range. */
export const readScatterSettings = (props: Record<string, unknown>): ScatterSettings => {
    const base = DEFAULT_SCATTER_SETTINGS;
    const size = Array.isArray(props.size) && props.size.length === 3 ? props.size : base.size;
    return {
        size: [num(size[0], base.size[0], 1, 10000), num(size[1], base.size[1], 0.1, 10000), num(size[2], base.size[2], 1, 10000)],
        seed: Math.round(num(props.seed, base.seed, 0, 1e9)),
        layers: (Array.isArray(props.layers) ? props.layers : []).slice(0, MAX_SCATTER_LAYERS).map(sanitizeScatterLayer),
        cellSize: num(props.cellSize, base.cellSize, 4, 1000),
        impostorDistance: num(props.impostorDistance, base.impostorDistance, 0, 100000),
        cullDistance: num(props.cullDistance, base.cullDistance, 0, 100000),
        castShadow: typeof props.castShadow === 'boolean' ? props.castShadow : base.castShadow,
    };
};

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** A seeded random number generator (mulberry32): the same seed, the same numbers. */
export const seededRandom = (seed: number): (() => number) => {
    let state = (seed >>> 0) || 0x9e3779b9;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const hash2 = (x: number, z: number, seed: number): number => {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Smooth value noise in 0-1, for clumping. */
export const clumpNoise = (x: number, z: number, seed: number): number => {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed), c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
    return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sz;
};

/** What lies under a point of the area: in the scatter's own space, with its world height. */
export interface ScatterGround {
    point: THREE.Vector3;
    normal: THREE.Vector3;
    worldY: number;
}

/** Finds the ground under local (x, z), searching down from the top of the area; null for none. */
export type ScatterGroundQuery = (x: number, z: number) => ScatterGround | null;

const UP = new THREE.Vector3(0, 1, 0);
const _yaw = new THREE.Quaternion();
const _lean = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _position = new THREE.Vector3();

/**
 * Places every layer's copies (local matrices, one list per layer). Candidates are thrown at random,
 * thinned by clumping, kept a spacing from every copy so far (each copy keeps its own layer's spacing
 * around it), then stood on the ground if it is one the layer grows on.
 */
export const generateScatter = (settings: ScatterSettings, ground: ScatterGroundQuery): THREE.Matrix4[][] => {
    const [width, , depth] = settings.size;
    const area = width * depth;
    const cell = Math.max(0.5, ...settings.layers.map(layer => layer.spacing));
    const grid = new Map<number, Array<{ x: number; z: number; radius: number }>>();
    const key = (cx: number, cz: number) => cx * 73856093 ^ cz * 19349663;
    const clear = (x: number, z: number, radius: number): boolean => {
        const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
        const reach = Math.ceil((radius + cell) / cell);
        for (let i = -reach; i <= reach; i++) {
            for (let j = -reach; j <= reach; j++) {
                for (const other of grid.get(key(cx + i, cz + j)) ?? []) {
                    const keep = Math.max(radius, other.radius);
                    if ((other.x - x) ** 2 + (other.z - z) ** 2 < keep * keep) return false;
                }
            }
        }
        return true;
    };
    const claim = (x: number, z: number, radius: number) => {
        const k = key(Math.floor(x / cell), Math.floor(z / cell));
        const list = grid.get(k);
        if (list) list.push({ x, z, radius });
        else grid.set(k, [{ x, z, radius }]);
    };

    return settings.layers.map((layer, index) => {
        const placed: THREE.Matrix4[] = [];
        if (!layer.modelId || layer.density <= 0) return placed;
        const random = seededRandom(settings.seed * 7919 + index * 104729 + 17);
        const wanted = Math.min(MAX_SCATTER_PER_LAYER, Math.round(layer.density * area / 100));
        const attempts = wanted * 4;
        const cosMin = Math.cos(layer.slope[1] * Math.PI / 180);
        const cosMax = Math.cos(layer.slope[0] * Math.PI / 180);
        for (let attempt = 0; attempt < attempts && placed.length < wanted; attempt++) {
            const x = (random() - 0.5) * width;
            const z = (random() - 0.5) * depth;
            const keep = random();
            const yaw = random() * Math.PI * 2;
            const size = layer.scale[0] + (layer.scale[1] - layer.scale[0]) * random();
            if (layer.clump > 0) {
                const n = clumpNoise(x / layer.clumpSize, z / layer.clumpSize, settings.seed + index * 31);
                if (keep > 1 - layer.clump + layer.clump * n * n * 2) continue;
            }
            if (!clear(x, z, layer.spacing)) continue;
            const hit = ground(x, z);
            if (!hit) continue;
            const up = hit.normal.y;
            if (up < cosMin - 1e-6 || up > cosMax + 1e-6) continue;
            if (hit.worldY < layer.height[0] || hit.worldY > layer.height[1]) continue;
            claim(x, z, layer.spacing);
            _yaw.setFromAxisAngle(UP, yaw);
            _lean.setFromUnitVectors(UP, hit.normal);
            _lean.slerp(new THREE.Quaternion(), 1 - layer.align).multiply(_yaw);
            _position.copy(hit.point);
            _position.y += layer.sink;
            placed.push(new THREE.Matrix4().compose(_position, _lean, _scale.setScalar(size)));
        }
        return placed;
    });
};

// ---------------------------------------------------------------------------
// Cells and distance
// ---------------------------------------------------------------------------

export interface ScatterCell {
    /** Cell centre in the scatter's own space. */
    centre: THREE.Vector3;
    /** How far its copies reach from the centre (so a cell is judged by its nearest copy). */
    radius: number;
    /** The copies in it, per layer. */
    layers: THREE.Matrix4[][];
}

/** Cuts the placement into cells of `cellSize` metres. */
export const cellsOf = (placements: THREE.Matrix4[][], cellSize: number): ScatterCell[] => {
    const cells = new Map<string, ScatterCell>();
    const at = new THREE.Vector3();
    placements.forEach((layer, index) => {
        for (const matrix of layer) {
            at.setFromMatrixPosition(matrix);
            const cx = Math.floor(at.x / cellSize), cz = Math.floor(at.z / cellSize);
            const id = `${cx}:${cz}`;
            let cell = cells.get(id);
            if (!cell) {
                cell = { centre: new THREE.Vector3((cx + 0.5) * cellSize, 0, (cz + 0.5) * cellSize), radius: cellSize * Math.SQRT1_2, layers: placements.map(() => []) };
                cells.set(id, cell);
            }
            cell.layers[index].push(matrix);
        }
    });
    for (const cell of cells.values()) {
        let sum = 0, count = 0;
        for (const layer of cell.layers) for (const matrix of layer) { sum += matrix.elements[13]; count++; }
        cell.centre.y = count ? sum / count : 0;
    }
    return [...cells.values()];
};

/** How a cell is drawn: its models, impostors, or not at all. */
export type ScatterTier = 'full' | 'impostor' | 'hidden';

/**
 * The tier for a cell whose nearest copy is `distance` metres from the camera. Once farther than a
 * boundary, it comes back only `hysteresis` (a share) nearer than it, so a cell on the edge does not flicker.
 */
export const scatterTier = (distance: number, settings: Pick<ScatterSettings, 'impostorDistance' | 'cullDistance'>, previous: ScatterTier, hysteresis = 0.1): ScatterTier => {
    const back = (edge: number, wasBeyond: boolean) => (wasBeyond ? edge * (1 - hysteresis) : edge);
    const { impostorDistance, cullDistance } = settings;
    if (cullDistance > 0 && distance > back(cullDistance, previous === 'hidden')) return 'hidden';
    if (impostorDistance > 0 && distance > back(impostorDistance, previous !== 'full')) return 'impostor';
    return 'full';
};

// ---------------------------------------------------------------------------
// Impostors
// ---------------------------------------------------------------------------

/** A model drawn once from the side into a texture, and where that picture sits on it. */
export interface Impostor {
    texture: THREE.Texture;
    /** Model-space width and height the picture covers, its left and bottom edges. */
    width: number;
    height: number;
    left: number;
    bottom: number;
    dispose(): void;
}

const IMPOSTOR_PIXELS = 256;

/**
 * Renders `parts` (meshes in model space) from the front with even light into a transparent texture.
 * The renderer's target and clear colour are left as they were.
 */
export const bakeImpostor = (
    renderer: THREE.WebGLRenderer,
    parts: ReadonlyArray<{ geometry: THREE.BufferGeometry; material: THREE.Material }>,
    bounds: THREE.Box3,
): Impostor => {
    const size = bounds.getSize(new THREE.Vector3());
    const width = Math.max(1e-3, size.x, size.z);
    const height = Math.max(1e-3, size.y);
    const centre = bounds.getCenter(new THREE.Vector3());
    const aspect = width / height;
    const target = new THREE.WebGLRenderTarget(
        Math.max(16, Math.round(aspect >= 1 ? IMPOSTOR_PIXELS : IMPOSTOR_PIXELS * aspect)),
        Math.max(16, Math.round(aspect >= 1 ? IMPOSTOR_PIXELS / aspect : IMPOSTOR_PIXELS)),
        { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter },
    );
    const scene = new THREE.Scene();
    for (const part of parts) scene.add(new THREE.Mesh(part.geometry, part.material));
    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x4a4030, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(0.4, 1, 0.8);
    scene.add(sun);
    const camera = new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, 0.01, Math.max(size.x, size.z) * 4 + 10);
    camera.position.set(centre.x, centre.y, bounds.max.z + Math.max(size.x, size.z) + 1);
    camera.lookAt(centre.x, centre.y, centre.z);
    const before = renderer.getRenderTarget();
    const clear = renderer.getClearColor(new THREE.Color());
    const alpha = renderer.getClearAlpha();
    const shadows = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    renderer.setRenderTarget(before);
    renderer.setClearColor(clear, alpha);
    renderer.shadowMap.autoUpdate = shadows;
    sun.dispose();
    return {
        texture: target.texture,
        width,
        height,
        left: centre.x - width / 2,
        bottom: bounds.min.y,
        dispose: () => target.dispose(),
    };
};

const IMPOSTOR_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
uniform vec4 impostorRect;
varying vec2 vUv;
void main() {
    mat4 placed = modelMatrix * instanceMatrix;
    vec3 origin = ( placed * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
    float scale = length( ( placed * vec4( 1.0, 0.0, 0.0, 0.0 ) ).xyz );
    // Turned about the vertical toward the camera, standing where the model stands.
    vec3 toCamera = cameraPosition - origin;
    vec3 right = normalize( vec3( toCamera.z, 0.0, -toCamera.x ) + vec3( 1e-5, 0.0, 0.0 ) );
    vec3 world = origin + right * ( impostorRect.x + position.x * impostorRect.z ) * scale
        + vec3( 0.0, ( impostorRect.y + position.y * impostorRect.w ) * scale, 0.0 );
    vec4 mvPosition = viewMatrix * vec4( world, 1.0 );
    gl_Position = projectionMatrix * mvPosition;
    vUv = uv;
    #include <fog_vertex>
}`;

const IMPOSTOR_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D map;
uniform vec2 mapSize;
uniform float light;
varying vec2 vUv;
void main() {
    vec4 texel = texture2D( map, vUv );
    // Smaller mip levels average thin leaves' alpha away; raising it with the level keeps far copies full.
    vec2 dx = dFdx( vUv * mapSize ), dy = dFdy( vUv * mapSize );
    float level = max( 0.0, 0.5 * log2( max( dot( dx, dx ), dot( dy, dy ) ) ) );
    if ( texel.a * ( 1.0 + 0.25 * level ) < 0.5 ) discard;
    // The picture was drawn over clear black, which the mip levels average in: divided out, edges keep their colour.
    gl_FragColor = vec4( texel.rgb / max( texel.a, 1e-3 ) * light, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
}`;

/** A quad from (0, 0) to (1, 1), standing up from its bottom edge, for impostors. */
export const impostorQuad = (): THREE.BufferGeometry => {
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.translate(0.5, 0.5, 0);
    return quad;
};

/** The material `impostor`'s copies draw with; its light follows the day (see updateImpostorLight). */
export const impostorMaterial = (impostor: Impostor): THREE.ShaderMaterial => {
    const material = new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([
            THREE.UniformsLib.fog,
            { map: { value: null }, mapSize: { value: new THREE.Vector2(1, 1) }, light: { value: 1 }, impostorRect: { value: new THREE.Vector4() } },
        ]),
        vertexShader: IMPOSTOR_VERTEX,
        fragmentShader: IMPOSTOR_FRAGMENT,
        fog: true,
    });
    // Merged uniforms are copies, so the picture is set after.
    material.uniforms.map.value = impostor.texture;
    const picture = impostor.texture.image as { width?: number; height?: number } | undefined;
    (material.uniforms.mapSize.value as THREE.Vector2).set(picture?.width || 1, picture?.height || 1);
    (material.uniforms.impostorRect.value as THREE.Vector4).set(impostor.left, impostor.bottom, impostor.width, impostor.height);
    return material;
};

/** Dims impostors with the day, as the lit models they stand in for dim: their picture was baked at noon. */
export const updateImpostorLight = (material: THREE.ShaderMaterial): void => {
    material.uniforms.light.value = 0.15 + 0.85 * sceneDaylight();
};
