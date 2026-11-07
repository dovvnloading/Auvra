import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { GpuImage, TextureGpu } from '../../../texturing/gpu/textureGpu';
import { tileGeometry } from '../../../texturing/mesh/partMesh';
import type { MeshMapName } from '../../../texturing/graph/nodes/io';
import type { BakeSettings, ExtraBakeMap } from '../../../texturing/bake/meshBaker';
import { MAX_BRUSH_SIZE, lazyFollow, pictureAspect, renderDepth, stencilPlace, Stroke, type BrushSettings, type HistoryEntry, type StrokeTarget } from '../../../texturing/paint/strokes';
import { decalCoordinates, type DecalStart } from '../../../texturing/paint/decals';
import { builtInAlphaTexture } from '../../../texturing/paint/brushLibrary';
import { pathLength, samplePath, type SurfacePath, type Vec3 } from '../../../texturing/paint/paths';

import type { PaintChannel } from '../../../texturing/paint/paintTypes';
import { PICK_LABELS, type PickMode } from '../../../texturing/paint/selection';
import type { PaintSession } from './paintSession';
import type { UvSession } from './uvSession';
import { layPathAlong } from './pathLaying';

/**
 * The painting view: the model in its rest pose, the texture set being painted drawn with its live
 * pictures and the rest of the model as it is. Left button paints (or fills an island, or picks a
 * colour), right button turns round the model, middle button (or Shift+right) pans, the wheel comes
 * closer. [ and ] change the brush size.
 *
 * The live pictures are copied into pictures with smaller versions of themselves (mipmaps), so the model
 * does not shimmer when seen from afar, and the view is drawn with several samples per pixel and then
 * smoothed onto the screen, so its edges are clean.
 */

export type PaintTool = 'paint' | 'erase' | 'island' | 'polygon' | 'path' | 'pick' | 'seam' | 'decal';

/** A decal as the Brush panel sets it: its picture, its width as a share of the set's size, its turn in degrees and its strength. */
export interface DecalSettings {
    textureId: string;
    size: number;
    angle: number;
    strength: number;
}

/** Why painting waits while a decal is placed (the Brush panel knows a decal is placed by it). */
export const DECAL_LOCK = 'A decal is being placed: lay it on or give it up first.';

/** The path tool: the path being drawn, its selected point, and what clicks do to it. */
export interface PathEdit {
    path: SurfacePath | null;
    point: number | null;
    /** A click on the surface away from the path's points: a new point there, sized from the brush. */
    onAdd: (position: Vec3, normal: Vec3, size: number) => void;
    onSelect: (index: number | null) => void;
    onMove: (index: number, position: Vec3, normal: Vec3) => void;
}

/** What the workspace asks of the view. */
export interface ViewportCommands {
    /** Lays a path on the selected paint layer or painted mask: along it, or filling inside it (seen from here). */
    paintPath: (path: SurfacePath, how: 'along' | 'fill') => Promise<void>;
    /** Keeps the decal being placed as a step of the history. */
    keepDecal: () => void;
    /** Gives up the decal being placed. */
    dropDecal: () => void;
}

/** Fonts the browser has, for text along a path. */
export const PATH_FONTS = ['sans-serif', 'serif', 'monospace', 'cursive', 'Arial', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Trebuchet MS', 'Impact'];

/** Where a click met the surface: its triangle, the place on the model and its texture coordinates. */
export interface SurfaceHit { triangle: number; point: THREE.Vector3; uv: THREE.Vector2 }
export type ViewMode = 'material' | PaintChannel | 'ambientOcclusion' | `mesh:${MeshMapName}` | `extra:${ExtraBakeMap}` | 'mask' | 'uvChecker' | 'uvStretch';

/** A tile's live pictures as the view draws them, each with its smaller versions, made when first needed. */
interface Preview { base: THREE.WebGLRenderTarget | null; orm: THREE.WebGLRenderTarget | null; emissive: THREE.WebGLRenderTarget | null; normal: THREE.WebGLRenderTarget | null; single: THREE.WebGLRenderTarget | null }

const FIELD_OF_VIEW = 32;

/**
 * A picture the view draws with, kept with its smaller versions (made again after every pass into it).
 * Colour is kept as sRGB bytes (written in linear values, read back in them); data as bytes or half floats.
 */
const previewTarget = (size: number, kind: 'colour' | 'bytes' | 'half'): THREE.WebGLRenderTarget => new THREE.WebGLRenderTarget(size, size, {
    type: kind === 'half' ? THREE.HalfFloatType : THREE.UnsignedByteType,
    colorSpace: kind === 'colour' ? THREE.SRGBColorSpace : THREE.NoColorSpace,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    generateMipmaps: true,
    anisotropy: 4,
    depthBuffer: false,
});

/**
 * Where the view is drawn before it reaches the screen: several samples per pixel, smoothed as it is
 * read. It is marked as a target three draws into as onto the screen (tone mapped and turned to sRGB
 * by each material, so materials that show raw values stay raw) and kept in plain bytes.
 */
const viewTarget = (gpu: TextureGpu, width: number, height: number): THREE.WebGLRenderTarget => {
    const samples = Math.min(width * height > 4_000_000 ? 2 : 4, gpu.renderer.capabilities.maxSamples);
    const target = new THREE.WebGLRenderTarget(width, height, {
        samples,
        type: THREE.UnsignedByteType,
        colorSpace: THREE.SRGBColorSpace,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
        depthBuffer: true,
    });
    target.texture.internalFormat = 'RGBA8';
    (target as THREE.WebGLRenderTarget & { isXRRenderTarget?: boolean }).isXRRenderTarget = true;
    return target;
};

/** The room light, drawn once per GPU context (a reset loses it with everything else drawn on the GPU). */
const environments = new WeakMap<TextureGpu, { texture: THREE.Texture; generation: number }>();
const environmentOf = (gpu: TextureGpu): THREE.Texture => {
    const kept = environments.get(gpu);
    if (kept && kept.generation === gpu.generation) return kept.texture;
    const pmrem = new THREE.PMREMGenerator(gpu.renderer);
    const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    environments.set(gpu, { texture, generation: gpu.generation });
    return texture;
};

/** How far back the camera stands to see a model of this box diagonal whole, in a view of this aspect. */
const fitDistance = (diagonal: number, aspect: number): number => (diagonal / 2) / Math.sin(THREE.MathUtils.degToRad(FIELD_OF_VIEW / 2)) * 1.05 / Math.min(1, aspect);

const NO_SUBSCRIBE = () => () => undefined;
const ZERO = () => 0;

/** A checker laid on by texture coordinates (to judge a layout), or each triangle coloured by its stretch. */
const LAYOUT_VIEW = new THREE.ShaderMaterial({
    uniforms: { stretchView: { value: 0 } },
    vertexShader: 'attribute float stretch; varying vec2 vUv; varying float vStretch; varying vec3 vNormal; void main() { vUv = uv; vStretch = stretch; vNormal = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform int stretchView; varying vec2 vUv; varying float vStretch; varying vec3 vNormal;
void main() {
    float light = 0.55 + 0.45 * max(0.0, dot(normalize(vNormal), normalize(vec3(0.4, 0.8, 0.6))));
    if (stretchView == 1) {
        vec3 c = vStretch < 0.0 ? vec3(0.9, 0.1, 0.6) : mix(vec3(0.2, 0.45, 0.95), mix(vec3(0.25, 0.85, 0.35), vec3(0.95, 0.25, 0.15), smoothstep(0.15, 1.0, vStretch)), smoothstep(0.0, 0.15, vStretch));
        gl_FragColor = vec4(c * light, 1.0);
        return;
    }
    vec2 cell = floor(vUv * 32.0);
    float checker = mod(cell.x + cell.y, 2.0);
    vec3 c = mix(vec3(0.85), vec3(0.25), checker);
    vec2 big = floor(vUv * 4.0);
    c *= mix(vec3(1.0, 0.85, 0.8), vec3(0.8, 0.9, 1.0), mod(big.x + big.y, 2.0));
    // Each UDIM tile past the first (1001) has a tint of its own, to see which tile an island is on.
    vec2 tile = floor(vUv);
    float id = tile.x + tile.y * 10.0;
    if (id > 0.5) c *= 0.55 + 0.45 * cos(6.28318 * (id * 0.618 + vec3(0.0, 0.33, 0.67)));
    gl_FragColor = vec4(c * light, 1.0);
}`,
    side: THREE.DoubleSide,
});
LAYOUT_VIEW.toneMapped = false;

const SINGLE_VIEW = new THREE.ShaderMaterial({
    uniforms: { map: { value: null }, gray: { value: 0 }, encodeNormal: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform sampler2D map; uniform int gray; varying vec2 vUv; void main() { vec4 c = texture2D(map, vUv); gl_FragColor = vec4(gray == 1 ? c.rrr : c.rgb, 1.0); }',
});
SINGLE_VIEW.toneMapped = false;

/** The stencil drawn faintly over the view where it lies, so it can be seen and placed while painting. */
export const StencilOverlay: React.FC<{ texture: THREE.Texture; place: ReturnType<typeof stencilPlace> }> = ({ texture, place }) => {
    const ref = useRef<HTMLCanvasElement>(null);
    const version = texture.version;
    useEffect(() => {
        const canvas = ref.current;
        const image = texture.image as (CanvasImageSource & { width?: number; height?: number }) | undefined;
        if (!canvas || !image?.width || !image.height) return;
        const scale = Math.min(1, 1024 / Math.max(image.width, image.height));
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        try {
            canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
        } catch {
            // A picture kept as raw data cannot be drawn here; painting through it still works.
        }
    }, [texture, version]);
    return (
        <canvas ref={ref} className="pointer-events-none absolute opacity-40" style={{
            left: place.x - place.width / 2, top: place.y - place.height / 2, width: place.width, height: place.height, transform: `rotate(${place.angle}deg)`,
        }} />
    );
};

export const PaintViewport: React.FC<{
    session: PaintSession;
    tool: PaintTool;
    brush: BrushSettings;
    target: StrokeTarget | null;
    view: ViewMode;
    maskImage: (tile: number) => GpuImage | null;
    onBrushSize: (size: number) => void;
    onPick: (color: [number, number, number]) => void;
    onMessage: (message: string | null) => void;
    frameSignal: number;
    /** The UV editing session, for seams and the layout views. */
    uv: UvSession | null;
    /** What a polygon fill takes in: a triangle, a quad, a mesh part, a UV piece or an edge loop. */
    pickMode: PickMode;
    /**
     * A click on the surface with the polygon or pick tool, offered first to whatever is being picked for
     * (a polygon or ID colour mask): true when it took the click. Shift takes away instead of adding.
     */
    onSurfacePick?: (hit: SurfaceHit, remove: boolean) => boolean;
    pathEdit?: PathEdit | null;
    /** A part or ID colour mask is selected: clicks on the model pick for it, whatever the tool. */
    picking?: boolean;
    /** Bake settings whose rays are shown where the model is clicked (null: clicks do as the tool does). */
    bakeRays?: BakeSettings | null;
    commands?: React.MutableRefObject<ViewportCommands | null>;
    /** The decal the decal tool places. */
    decal?: DecalSettings | null;
}> = ({ session, tool, brush, target, view, maskImage, onBrushSize, onPick, onMessage, frameSignal, uv, pickMode, onSurfacePick, pathEdit, commands, picking = false, bakeRays = null, decal = null }) => {
    const uvVersion = useSyncExternalStore(uv?.subscribe ?? NO_SUBSCRIBE, uv?.getVersion ?? ZERO);
    const host = useRef<HTMLDivElement>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const version = useSyncExternalStore(session.subscribe, session.getVersion);
    const [size, setSize] = useState({ width: 0, height: 0, ratio: 1 });
    const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
    const [, redraw] = useState(0);
    const gpu = session.gpu;
    const stack = session.stack;

    // The model: the set's tiles with materials of their own, the rest as it is.
    const world = useMemo(() => {
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x1b1b1e);
        const root = new THREE.Group();
        scene.add(root);
        const sun = new THREE.DirectionalLight(0xffffff, 1.6);
        sun.position.set(2, 4, 3);
        scene.add(sun);
        const camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, 0.01, 1000);
        const object = session.target.object;
        object.updateWorldMatrix(true, true);
        const inverse = object.matrixWorld.clone().invert();
        const painted = new Set<THREE.Material>(session.target.materials);
        const hidden = new THREE.MeshBasicMaterial({ visible: false });
        object.traverse((child) => {
            const mesh = child as THREE.Mesh;
            if (!mesh.isMesh) return;
            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            const shown = materials.map((material) => (painted.has(material) ? hidden : material));
            if (shown.every((material) => material === hidden)) return;
            const copy = new THREE.Mesh(mesh.geometry, Array.isArray(mesh.material) ? shown : shown[0]);
            copy.matrixAutoUpdate = false;
            copy.matrix.multiplyMatrices(inverse, mesh.matrixWorld);
            root.add(copy);
        });
        const tiles = new Map<number, { mesh: THREE.Mesh; lit: THREE.MeshStandardMaterial; single: THREE.ShaderMaterial; preview: Preview }>();
        for (const tile of stack.tiles) {
            const lit = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 1, side: THREE.DoubleSide });
            const single = SINGLE_VIEW.clone();
            single.toneMapped = false;
            const mesh = new THREE.Mesh(tileGeometry(session.part, tile), lit);
            root.add(mesh);
            tiles.set(tile, { mesh, lit, single, preview: { base: null, orm: null, emissive: null, normal: null, single: null } });
        }
        const layoutMesh = new THREE.Mesh(new THREE.BufferGeometry(), LAYOUT_VIEW);
        layoutMesh.visible = false;
        layoutMesh.frustumCulled = false;
        root.add(layoutMesh);
        // Seams lie on the surface itself, so they are drawn a hair nearer the eye: unbroken, yet still hidden behind the model.
        const seamLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
            vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z -= 0.0015 * gl_Position.w; }',
            fragmentShader: 'void main() { gl_FragColor = vec4(1.0, 0.478, 0.102, 1.0); }',
            depthTest: true,
            toneMapped: false,
        }));
        seamLines.frustumCulled = false;
        seamLines.renderOrder = 2;
        scene.add(seamLines);
        const box = new THREE.Box3().setFromObject(root);
        const diagonal = box.getSize(new THREE.Vector3()).length() || 1;
        const orbit = { target: box.getCenter(new THREE.Vector3()), yaw: 0.5, pitch: 0.2, distance: fitDistance(diagonal, 1), radius: diagonal };
        return { scene, root, camera, tiles, orbit, box, hidden, layoutMesh, seamLines };
    }, [session, stack]);

    useEffect(() => () => {
        for (const entry of world.tiles.values()) {
            entry.mesh.geometry.dispose();
            entry.lit.dispose();
            entry.single.dispose();
            for (const target of Object.values(entry.preview)) target?.dispose();
        }
        world.hidden.dispose();
        world.seamLines.geometry.dispose();
        (world.seamLines.material as THREE.Material).dispose();
        world.layoutMesh.geometry.dispose();
    }, [gpu, world]);

    const frame = useCallback(() => {
        world.orbit.target.copy(world.box.getCenter(new THREE.Vector3()));
        world.orbit.distance = fitDistance(world.orbit.radius, size.width / Math.max(1, size.height));
        redraw((value) => value + 1);
    }, [size, world]);
    // Framed when asked, not again whenever the view changes size.
    const latestFrame = useRef(frame);
    latestFrame.current = frame;
    useEffect(() => { if (frameSignal) latestFrame.current(); }, [frameSignal]);

    useEffect(() => {
        const element = host.current;
        if (!element) return undefined;
        const observer = new ResizeObserver(() => {
            const box = element.getBoundingClientRect();
            const ratio = window.devicePixelRatio || 1;
            setSize({ width: Math.max(1, Math.floor(box.width * ratio)), height: Math.max(1, Math.floor(box.height * ratio)), ratio });
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const placeCamera = useCallback(() => {
        const { camera, orbit } = world;
        const offset = new THREE.Vector3(Math.cos(orbit.pitch) * Math.sin(orbit.yaw), Math.sin(orbit.pitch), Math.cos(orbit.pitch) * Math.cos(orbit.yaw)).multiplyScalar(orbit.distance);
        camera.position.copy(orbit.target).add(offset);
        camera.lookAt(orbit.target);
        camera.near = Math.max(orbit.radius * 0.001, orbit.distance * 0.01);
        camera.far = orbit.distance + orbit.radius * 10;
        camera.aspect = size.width / Math.max(1, size.height);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
    }, [size, world]);

    // Keep the tiles' materials in step with the set's pictures and the view chosen.
    const updateMaterials = useCallback(() => {
        // Copies a live picture into the tile's view picture of that name (made the first time), whose smaller
        // versions are made again as it is drawn.
        const copyInto = (preview: Preview, name: keyof Preview, kind: 'colour' | 'bytes' | 'half', fragment: string, inputs: Record<string, GpuImage | THREE.Texture | null>, uniforms?: Record<string, unknown>): THREE.WebGLRenderTarget => {
            let target = preview[name];
            if (!target || target.width !== stack.size) {
                target?.dispose();
                target = preview[name] = previewTarget(stack.size, kind);
            }
            gpu.passNow(target, { fragment, inputs, uniforms });
            return target;
        };
        const COPY = 'void main() { outColor = texture(source, vUv); }';
        // Colour pictures hold sRGB values: written to the view's sRGB pictures in linear ones.
        const LINEAR = 'void main() { outColor = vec4(srgbToLinear(texture(source, vUv).rgb), 1.0); }';
        for (const [tile, entry] of world.tiles) {
            const outputs = stack.outputs.get(tile) ?? {};
            const preview = entry.preview;
            if (view === 'material') {
                const base = outputs.baseColor ? copyInto(preview, 'base', 'colour', LINEAR, { source: outputs.baseColor }) : null;
                const emissive = outputs.emissive ? copyInto(preview, 'emissive', 'colour', LINEAR, { source: outputs.emissive }) : null;
                const normal = outputs.normal ? copyInto(preview, 'normal', 'half', COPY, { source: outputs.normal }) : null;
                const orm = copyInto(preview, 'orm', 'bytes',
                    'uniform int hasR; uniform int hasM;\nvoid main() { outColor = vec4(texture(ao, vUv).r, hasR == 1 ? texture(rough, vUv).r : 0.6, hasM == 1 ? texture(metal, vUv).r : 0.0, 1.0); }',
                    { ao: outputs.ambientOcclusion ?? gpu.constant('white'), rough: outputs.roughness ?? null, metal: outputs.metallic ?? null },
                    { hasR: outputs.roughness ? 1 : 0, hasM: outputs.metallic ? 1 : 0 });
                const lit = entry.lit;
                const maps = [base, normal, orm, emissive].map((target) => target?.texture ?? null);
                // Only a change of which pictures it draws with makes three build the material again.
                const changed = lit.map !== maps[0] || lit.normalMap !== maps[1] || lit.roughnessMap !== maps[2] || lit.emissiveMap !== maps[3];
                lit.map = maps[0];
                lit.color.set(base ? 0xffffff : 0x808080);
                lit.normalMap = maps[1];
                lit.roughnessMap = maps[2];
                lit.metalnessMap = maps[2];
                lit.aoMap = maps[2];
                lit.emissiveMap = maps[3];
                lit.emissive.setScalar(emissive ? 1 : 0);
                if (changed) lit.needsUpdate = true;
                entry.mesh.material = lit;
            } else {
                let image: GpuImage | null | undefined = null;
                if (view === 'mask') image = maskImage(tile);
                else if (view.startsWith('mesh:')) image = stack.meshMaps(tile)[view.slice(5) as MeshMapName];
                else if (view.startsWith('extra:')) image = stack.bakeExtras(tile)[view.slice(6) as ExtraBakeMap];
                else image = outputs[view as PaintChannel | 'ambientOcclusion'];
                const single = image ? copyInto(preview, 'single', 'half', COPY, { source: image }) : null;
                entry.single.uniforms.map.value = single?.texture ?? gpu.constant('black');
                entry.single.uniforms.gray.value = image?.kind === 'gray' ? 1 : 0;
                entry.mesh.material = entry.single;
            }
        }
        // The layout views: the proposed coordinates (or the current ones) on the model.
        const layoutView = view === 'uvChecker' || view === 'uvStretch';
        world.layoutMesh.visible = layoutView;
        for (const entry of world.tiles.values()) entry.mesh.visible = !layoutView;
        if (layoutView) {
            const part = session.part;
            const corners = part.indices.length;
            const position = new Float32Array(corners * 3);
            const normal = new Float32Array(corners * 3);
            const uvs = new Float32Array(corners * 2);
            const stretch = new Float32Array(corners);
            for (let i = 0; i < corners; i++) {
                const v = part.indices[i];
                position.set(part.positions.subarray(v * 3, v * 3 + 3), i * 3);
                normal.set(part.normals.subarray(v * 3, v * 3 + 3), i * 3);
                if (uv?.proposal) uvs.set(uv.proposal.cornerUv.subarray(i * 2, i * 2 + 2), i * 2);
                else uvs.set([part.uvs[v * 2], part.uvs[v * 2 + 1]], i * 2);
                // The proposal's stretch, or the current layout's.
                stretch[i] = (uv?.proposal ? uv.proposal.triangleStretch : uv?.currentStretch)?.[Math.floor(i / 3)] ?? 0;
            }
            const geometry = world.layoutMesh.geometry;
            geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
            geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
            geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
            geometry.setAttribute('stretch', new THREE.BufferAttribute(stretch, 1));
            LAYOUT_VIEW.uniforms.stretchView.value = view === 'uvStretch' ? 1 : 0;
        }
        const lines = uv && (tool === 'seam' || layoutView) ? uv.seamLines() : new Float32Array(0);
        world.seamLines.geometry.setAttribute('position', new THREE.BufferAttribute(lines, 3));
        world.seamLines.geometry.computeBoundingSphere();
    }, [gpu, maskImage, session.part, stack, tool, uv, view, world]); // eslint-disable-line react-hooks/exhaustive-deps

    // Where the view is drawn with several samples per pixel, sized to it.
    const smooth = useRef<THREE.WebGLRenderTarget | null>(null);
    useEffect(() => () => { smooth.current?.dispose(); smooth.current = null; }, []);

    const pathRef = useRef(pathEdit);
    pathRef.current = pathEdit;
    /** Bake rays shown at the last clicked spot: from the cage (start) to the surface and on behind it (end). */
    const rays = useRef<Array<{ start: THREE.Vector3; surface: THREE.Vector3; end: THREE.Vector3 }>>([]);
    useEffect(() => { if (!bakeRays) rays.current = []; }, [bakeRays]);

    const drawRays = useCallback((element: HTMLCanvasElement) => {
        const context = element.getContext('2d');
        if (!rays.current.length || !context) return;
        const matrix = new THREE.Matrix4().multiplyMatrices(world.camera.projectionMatrix, world.camera.matrixWorldInverse);
        const screen = (p: THREE.Vector3) => { const v = p.clone().applyMatrix4(matrix); return { x: (v.x * 0.5 + 0.5) * element.width, y: (0.5 - v.y * 0.5) * element.height }; };
        const r = size.ratio;
        const blue = 'rgb(56, 189, 248)';
        const amber = 'rgb(251, 191, 36)';
        /** A line with a dark edge under it, so it reads over any surface. */
        const line = (from: { x: number; y: number }, to: { x: number; y: number }, colour: string) => {
            for (const [width, style] of [[6, 'rgba(9, 9, 11, 0.85)'], [3, colour]] as const) {
                context.lineWidth = width * r;
                context.strokeStyle = style;
                context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke();
            }
        };
        const dot = (at: { x: number; y: number }, radius: number, colour: string, ring = false) => {
            context.beginPath();
            context.arc(at.x, at.y, radius * r, 0, Math.PI * 2);
            context.lineWidth = 2.5 * r;
            context.strokeStyle = ring ? colour : 'rgba(9, 9, 11, 0.9)';
            if (ring) context.stroke();
            else { context.fillStyle = colour; context.fill(); context.stroke(); }
        };
        context.save();
        context.lineCap = 'round';
        for (const ray of rays.current) {
            const [a, b, c] = [screen(ray.start), screen(ray.surface), screen(ray.end)];
            if (Math.hypot(a.x - c.x, a.y - c.y) < 14 * r) {
                // Seen head on the ray is a point: rings say where it starts (blue, outer) and ends (amber, inner).
                dot(b, 10, blue, true);
                dot(b, 6, amber, true);
                dot(b, 3, '#f4f4f5');
                continue;
            }
            line(a, b, blue);
            line(b, c, amber);
            dot(a, 4.5, blue);
            dot(c, 4.5, amber);
            dot(b, 3.5, '#f4f4f5');
        }
        context.restore();
    }, [size.ratio, world.camera]);

    /** The path being drawn, over the view: its curve and its points (the selected one larger). */
    const drawPath = useCallback((element: HTMLCanvasElement) => {
        const edit = pathRef.current;
        const path = edit?.path;
        const context = element.getContext('2d');
        if (!path?.points.length || !context) return;
        const matrix = new THREE.Matrix4().multiplyMatrices(world.camera.projectionMatrix, world.camera.matrixWorldInverse);
        const screen = (p: Vec3) => {
            const v = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(matrix);
            return v.z > 1 || v.z < -1 ? null : { x: (v.x * 0.5 + 0.5) * element.width, y: (0.5 - v.y * 0.5) * element.height };
        };
        const samples = samplePath(path.points, Math.max(pathLength(path.points, path.closed) / 300, 1e-6), path.closed);
        context.save();
        context.lineWidth = 2 * size.ratio;
        context.strokeStyle = 'rgba(56, 189, 248, 0.9)';
        context.beginPath();
        let drawing = false;
        for (const sample of samples) {
            const q = screen(sample.position);
            if (!q) { drawing = false; continue; }
            if (drawing) context.lineTo(q.x, q.y);
            else { context.moveTo(q.x, q.y); drawing = true; }
        }
        context.stroke();
        path.points.forEach((point, i) => {
            const q = screen(point.position);
            if (!q) return;
            context.beginPath();
            context.arc(q.x, q.y, (i === edit?.point ? 5 : 3.5) * size.ratio, 0, Math.PI * 2);
            context.fillStyle = i === edit?.point ? '#38bdf8' : '#f4f4f5';
            context.fill();
            context.lineWidth = size.ratio;
            context.strokeStyle = '#09090b';
            context.stroke();
        });
        context.restore();
    }, [size.ratio, world.camera]);

    const draw = useCallback(() => {
        const element = canvas.current;
        if (!element || !size.width) return;
        element.width = size.width;
        element.height = size.height;
        world.scene.environment = environmentOf(gpu);
        placeCamera();
        gpu.present(element, (width, height) => {
            let target = smooth.current;
            if (!target || target.width !== width || target.height !== height) {
                target?.dispose();
                target = smooth.current = viewTarget(gpu, width, height);
            }
            const renderer = gpu.renderer;
            renderer.setRenderTarget(target);
            renderer.render(world.scene, world.camera);
            // Back onto the screen's corner the view takes, the samples smoothed into each pixel.
            renderer.setRenderTarget(null);
            gpu.drawToScreen({ fragment: 'void main() { outColor = texture(source, vUv); }', inputs: { source: target.texture } });
        });
        drawPath(element);
        drawRays(element);
    }, [drawPath, drawRays, gpu, placeCamera, size, world]);

    useEffect(() => { draw(); }, [draw, pathEdit?.path, pathEdit?.point]);

    useEffect(() => {
        updateMaterials();
        draw();
    }, [draw, updateMaterials, version, uvVersion]);

    // ---- pointer ----
    const gesture = useRef<{ kind: 'orbit' | 'pan'; x: number; y: number } | { kind: 'stroke'; stroke: Stroke; depth: GpuImage; anchor: { x: number; y: number } } | { kind: 'pathPoint'; index: number } | { kind: 'decal' } | null>(null);
    /** Clone: where strokes copy from (Ctrl-click sets it). */
    const cloneSource = useRef<{ triangle: number; uv: THREE.Vector2 } | null>(null);

    const toPixels = (event: { clientX: number; clientY: number }) => {
        const box = host.current!.getBoundingClientRect();
        return { x: (event.clientX - box.left) * size.ratio, y: (event.clientY - box.top) * size.ratio };
    };

    const hitAt = useCallback((x: number, y: number) => {
        placeCamera();
        const ndc = new THREE.Vector2((x / size.width) * 2 - 1, -(y / size.height) * 2 + 1);
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, world.camera);
        return session.picker.cast(ray.ray.origin, ray.ray.direction);
    }, [placeCamera, session.picker, size, world.camera]);

    const startStroke = (x: number, y: number, pressure: number, tilt?: { x: number; y: number }) => {
        if (!session.usable) {
            onMessage('The graphics card was reset: painting waits until the set has opened again from its saved pictures.');
            return;
        }
        if (session.locked) {
            onMessage(session.locked);
            return;
        }
        if (!target) {
            onMessage(tool === 'island' || tool === 'polygon' ? 'Pick a paint layer or a painted mask to fill, or a polygon or ID colour mask effect to pick for.' : 'Pick a paint layer, or a painted mask effect, to paint on. Fill layers take their values from their settings.');
            return;
        }
        if (brush.mode === 'clone' && !cloneSource.current && tool !== 'island' && tool !== 'polygon') {
            onMessage('Ctrl-click where to copy from first, then paint where the copy goes.');
            return;
        }
        onMessage(null);
        placeCamera();
        const depth = renderDepth(gpu, world.root, world.camera, size.width, size.height);
        const perspective = (size.height / 2) / Math.tan(THREE.MathUtils.degToRad(world.camera.fov / 2));
        const alpha = brush.shape === 'picture' && brush.alphaTexture ? builtInAlphaTexture(brush.alphaTexture) ?? session.host.texture(brush.alphaTexture) : null;
        const stencil = brush.stencil.enabled && brush.stencil.textureId ? session.host.texture(brush.stencil.textureId) : null;
        const stroke = new Stroke(stack, target, tool === 'erase' ? 'erase' : 'paint', brush, {
            viewProjection: new THREE.Matrix4().multiplyMatrices(world.camera.projectionMatrix, world.camera.matrixWorldInverse),
            cameraPosition: world.camera.position.clone(),
            cameraRight: new THREE.Vector3().setFromMatrixColumn(world.camera.matrixWorld, 0).normalize(),
            cameraUp: new THREE.Vector3().setFromMatrixColumn(world.camera.matrixWorld, 1).normalize(),
            width: size.width,
            height: size.height,
            depth,
            perspective,
        }, alpha, stencil);
        if (tool === 'island' || tool === 'polygon') {
            const hit = hitAt(x, y);
            const mode: PickMode = tool === 'island' ? 'island' : pickMode;
            if (hit) stroke.fillTriangles(session.selector.pick(mode, hit.triangle, [hit.point.x, hit.point.y, hit.point.z]));
            const entry = stroke.finish(tool === 'island' ? 'Fill island' : `Fill ${PICK_LABELS[mode].toLowerCase()}`);
            gpu.release(depth);
            if (hit) session.record(entry);
            return;
        }
        if (brush.mode === 'clone' && cloneSource.current) stroke.cloneSource(cloneSource.current.triangle, cloneSource.current.uv);
        gesture.current = { kind: 'stroke', stroke, depth, anchor: { x, y } };
        stroke.moveTo(x, y, pressure, (px, py) => hitAt(px, py), tilt);
    };

    const pickColour = (x: number, y: number) => {
        const hit = hitAt(x, y);
        if (!hit) return;
        // The picture and place the triangle is drawn with: coordinates past 0..1 on a set that is not laid
        // out in UDIM tiles wrap onto its one picture, as they do on the model.
        const part = session.part;
        const tile = part.triangleTile[hit.triangle];
        const image = stack.outputs.get(tile)?.baseColor;
        if (!image) return;
        const at = new THREE.Vector2(hit.uv.x - part.triangleShift[hit.triangle * 2], hit.uv.y - part.triangleShift[hit.triangle * 2 + 1]);
        const probe = gpu.image(1, 1, 'color', 32);
        gpu.passNow(probe, { fragment: 'uniform vec2 uAt;\nvoid main() { outColor = texture(source, fract(uAt)); }', inputs: { source: image }, uniforms: { uAt: at } });
        const value = gpu.readFloat(probe);
        gpu.release(probe);
        onPick([value[0], value[1], value[2]]);
    };


    // ---- Decals: placed by clicking and dragging on the model, shown laid on, kept or given up ----

    /** Where the decal sits (the surface point, and the way across it was placed with), or null. */
    const decalPlace = useRef<{ start: DecalStart; hint: THREE.Vector3 } | null>(null);
    /** The decal laid on for showing: a stroke not yet kept, given up on before every change. */
    const decalLive = useRef<Stroke | null>(null);
    /** Each vertex's place on the decal, kept while the decal stays where it is. */
    const decalCoords = useRef<{ start: DecalStart; reach: number; coords: Float32Array } | null>(null);
    const decalFrame = useRef<number | null>(null);

    /** Gives up the decal shown (the pictures as they were) and lets painting go on. */
    const dropDecal = useCallback((forget: boolean) => {
        if (decalFrame.current !== null) { cancelAnimationFrame(decalFrame.current); decalFrame.current = null; }
        const live = decalLive.current;
        decalLive.current = null;
        if (live) live.cancel();
        if (forget) { decalPlace.current = null; decalCoords.current = null; }
        if (session.locked === DECAL_LOCK) session.unlock();
    }, [session]);

    /** Lays the decal on again where it is now, as it is now set (the last showing given up first). */
    const showDecal = () => {
        decalFrame.current = null;
        const live = decalLive.current;
        decalLive.current = null;
        if (live) live.cancel();
        const place = decalPlace.current;
        if (!place || !decal) return;
        if (!session.usable) return;
        if (session.locked && session.locked !== DECAL_LOCK) { onMessage(session.locked); return; }
        if (!target) { onMessage('Pick a paint layer, or a painted mask effect, to lay the decal on.'); return; }
        const picture = decal.textureId ? session.host.texture(decal.textureId) : null;
        if (!picture) { onMessage(decal.textureId ? 'The decal\'s picture is still loading: move the decal again in a moment.' : 'Pick the decal\'s picture in the Brush panel first.'); return; }
        const modelSize = Math.max(1e-6, session.part.bounds.getSize(new THREE.Vector3()).length());
        const width = decal.size * modelSize;
        const height = width / pictureAspect(picture);
        const reach = Math.hypot(width, height) * 0.75;
        let cached = decalCoords.current;
        if (!cached || cached.start !== place.start || cached.reach < reach) {
            cached = { start: place.start, reach, coords: decalCoordinates(session.part, place.start, place.hint, reach) };
            decalCoords.current = cached;
        }
        if (session.locked !== DECAL_LOCK) session.lock(DECAL_LOCK);
        placeCamera();
        const stroke = new Stroke(stack, target, 'paint', brush, {
            viewProjection: new THREE.Matrix4().multiplyMatrices(world.camera.projectionMatrix, world.camera.matrixWorldInverse),
            cameraPosition: world.camera.position.clone(),
            width: size.width,
            height: size.height,
            depth: null,
            perspective: (size.height / 2) / Math.tan(THREE.MathUtils.degToRad(world.camera.fov / 2)),
        }, null, null);
        stroke.layDecal({ coords: cached.coords, picture, width, height, angle: THREE.MathUtils.degToRad(decal.angle), strength: decal.strength });
        decalLive.current = stroke;
        onMessage('Drag the decal over the model; set its size and turn in the Brush panel. Enter or "Lay it on" keeps it, Escape gives it up.');
        draw();
    };
    const showDecalRef = useRef(showDecal);
    showDecalRef.current = showDecal;
    /** Shows the decal again at the next frame (dragging gives many moves a frame). */
    const showDecalSoon = () => {
        if (decalFrame.current === null) decalFrame.current = requestAnimationFrame(() => showDecalRef.current());
    };

    /** Puts the decal where the pointer meets the surface, its way across the screen's. */
    const placeDecal = (x: number, y: number) => {
        const hit = hitAt(x, y);
        if (!hit) return;
        decalPlace.current = { start: { point: hit.point, normal: hit.normal, triangle: hit.triangle }, hint: new THREE.Vector3().setFromMatrixColumn(world.camera.matrixWorld, 0).normalize() };
        showDecalSoon();
    };

    /** Keeps the decal shown as a step of the history. */
    const keepDecal = () => {
        const live = decalLive.current;
        if (!live) { onMessage('Click the model to place the decal first.'); return; }
        decalLive.current = null;
        decalPlace.current = null;
        decalCoords.current = null;
        if (session.locked === DECAL_LOCK) session.unlock();
        session.record(live.finish('Lay decal'));
        onMessage('Decal laid on. Click the model to place another.');
    };

    // A change to the decal's picture, size, turn or strength shows it again; another tool or target gives it up.
    useEffect(() => {
        if (tool === 'decal' && decalPlace.current) showDecalSoon();
    }, [decal?.textureId, decal?.size, decal?.angle, decal?.strength]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        if (tool !== 'decal') dropDecal(true);
    }, [tool, dropDecal]);
    const targetKey = target ? (target.kind === 'layer' ? `layer:${target.layerId}:${target.channels.join(',')}` : `mask:${target.effectId}`) : '';
    useEffect(() => () => dropDecal(true), [targetKey, dropDecal]);

    const onPointerDown = (event: React.PointerEvent) => {
        try { host.current?.setPointerCapture(event.pointerId); } catch { /* a pointer the page did not see start */ }
        const { x, y } = toPixels(event);
        if (event.button === 2 || event.button === 1 || event.altKey) {
            gesture.current = { kind: event.button === 1 || event.shiftKey ? 'pan' : 'orbit', x: event.clientX, y: event.clientY };
            return;
        }
        if (event.button !== 0) return;
        if (tool === 'path' && pathEdit) {
            // A point near the pointer is picked (and can be dragged); elsewhere a new point goes on the surface.
            placeCamera();
            const matrix = new THREE.Matrix4().multiplyMatrices(world.camera.projectionMatrix, world.camera.matrixWorldInverse);
            const near = (pathEdit.path?.points ?? []).findIndex((point) => {
                const v = new THREE.Vector3(...point.position).applyMatrix4(matrix);
                return Math.hypot((v.x * 0.5 + 0.5) * size.width - x, (0.5 - v.y * 0.5) * size.height - y) < 9 * size.ratio;
            });
            if (near >= 0) {
                pathEdit.onSelect(near);
                gesture.current = { kind: 'pathPoint', index: near };
                return;
            }
            const hit = hitAt(x, y);
            if (!hit) return;
            const perspective = (size.height / 2) / Math.tan(THREE.MathUtils.degToRad(world.camera.fov / 2));
            pathEdit.onAdd([hit.point.x, hit.point.y, hit.point.z], [hit.normal.x, hit.normal.y, hit.normal.z], (brush.size * hit.distance) / perspective);
            return;
        }
        if (brush.mode === 'clone' && (event.ctrlKey || event.metaKey) && (tool === 'paint' || tool === 'erase')) {
            const hit = hitAt(x, y);
            if (hit) {
                cloneSource.current = { triangle: hit.triangle, uv: hit.uv.clone() };
                onMessage('Copying from there: paint where the copy goes. The copy keeps its distance on the picture.');
            }
            return;
        }
        if (tool === 'decal') {
            placeDecal(x, y);
            gesture.current = { kind: 'decal' };
            return;
        }
        // Showing bake rays: a click shows the rays at that spot and its triangle's corners.
        if (bakeRays && tool !== 'seam' && tool !== 'path') {
            const hit = hitAt(x, y);
            if (!hit) return;
            const part = session.part;
            const box = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(session.occluder.positions, 3));
            const diagonal = Math.max(1e-6, box.getSize(new THREE.Vector3()).length());
            const front = bakeRays.frontDistance * diagonal;
            const rear = bakeRays.rearDistance * diagonal;
            const normals = (bakeRays.averagedNormals ?? true) ? session.averagedNormals : part.normals;
            const corners = [0, 1, 2].map((k) => part.indices[hit.triangle * 3 + k]);
            const direction = (v: number) => new THREE.Vector3(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]).normalize();
            const middle = corners.reduce((sum, v) => sum.add(direction(v)), new THREE.Vector3()).normalize();
            const spots: Array<[THREE.Vector3, THREE.Vector3]> = [[hit.point.clone(), middle], ...corners.map((v): [THREE.Vector3, THREE.Vector3] => [new THREE.Vector3(part.positions[v * 3], part.positions[v * 3 + 1], part.positions[v * 3 + 2]), direction(v)])];
            rays.current = spots.map(([at, dir]) => ({ start: at.clone().addScaledVector(dir, front), surface: at, end: at.clone().addScaledVector(dir, -rear) }));
            onMessage(`Bake rays here start ${front.toPrecision(2)} out (blue dot) and look ${rear.toPrecision(2)} in to the amber dot; seen head on they show as rings, so turn the view to see them side on${bakeRays.cage === 'auto' ? '; an automatic cage finds its own distances when baking, so these use the set ones' : bakeRays.cage === 'mesh' ? '; a cage model sets its own, so these use the set distances' : ''}.`);
            draw();
            return;
        }
        // A part or ID colour mask selected takes the click, with any tool but the seam and path tools.
        if (picking && tool !== 'seam' && tool !== 'path') {
            const hit = hitAt(x, y);
            if (hit && onSurfacePick?.(hit, event.shiftKey)) return;
            if (!hit) return;
        }
        if (tool === 'pick') { pickColour(x, y); return; }
        if (tool === 'seam') {
            const hit = hitAt(x, y);
            if (hit && uv) uv.toggleSeam(hit.triangle, hit.point, event.shiftKey);
            else if (!uv) onMessage('Open the UVs panel to edit seams.');
            return;
        }
        startStroke(x, y, event.pointerType === 'pen' ? event.pressure : 1, event.pointerType === 'pen' ? { x: event.tiltX, y: event.tiltY } : undefined);
    };

    const onPointerMove = (event: React.PointerEvent) => {
        const { x, y } = toPixels(event);
        setCursor({ x: x / size.ratio, y: y / size.ratio });
        const current = gesture.current;
        if (!current) return;
        if (current.kind === 'decal') {
            placeDecal(x, y);
            return;
        }
        if (current.kind === 'pathPoint') {
            const hit = hitAt(x, y);
            if (hit && pathEdit) pathEdit.onMove(current.index, [hit.point.x, hit.point.y, hit.point.z], [hit.normal.x, hit.normal.y, hit.normal.z]);
            return;
        }
        if (current.kind === 'stroke') {
            const coalesced = (event.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [];
            const events = coalesced.length ? coalesced : [event.nativeEvent];
            for (const each of events) {
                // Lazy mouse: the stroke trails the pointer on a string.
                const point = lazyFollow(current.anchor, toPixels(each), brush.lazy * size.ratio);
                if (point.x === current.anchor.x && point.y === current.anchor.y) continue;
                current.anchor = point;
                current.stroke.moveTo(point.x, point.y, each.pointerType === 'pen' ? each.pressure : 1, (px, py) => hitAt(px, py), each.pointerType === 'pen' ? { x: each.tiltX, y: each.tiltY } : undefined);
            }
            return;
        }
        const dx = event.clientX - current.x;
        const dy = event.clientY - current.y;
        current.x = event.clientX;
        current.y = event.clientY;
        const orbit = world.orbit;
        if (current.kind === 'orbit') {
            orbit.yaw -= dx * 0.008;
            orbit.pitch = Math.max(-1.5, Math.min(1.5, orbit.pitch + dy * 0.008));
        } else {
            const scale = orbit.distance * 0.0015;
            const right = new THREE.Vector3().setFromMatrixColumn(world.camera.matrixWorld, 0);
            const up = new THREE.Vector3().setFromMatrixColumn(world.camera.matrixWorld, 1);
            orbit.target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
        }
        draw();
    };

    const onPointerUp = () => {
        const current = gesture.current;
        gesture.current = null;
        if (current?.kind === 'stroke') {
            const entry = current.stroke.finish(tool === 'erase' ? 'Erase' : 'Paint');
            gpu.release(current.depth);
            session.record(entry);
        }
    };

    /** The step each path was last laid on with (by path and how), to take it back when the path is laid on again. */
    const laidPaths = useRef(new Map<string, HistoryEntry>());

    // Laying a path on: dabs along it (the brush, a ribbon, stitches from a texture graph, letters), or
    // the brush through its outline as seen from here. Laid on again straight after, it replaces its copy.
    const paintPath = async (path: SurfacePath, how: 'along' | 'fill') => {
        const laidKey = `${path.id}:${how}`;
        const replaces = laidPaths.current.get(laidKey);
        if (replaces && session.latest === replaces) session.undo();
        else if (replaces) onMessage('Laid on as a new copy: other changes came after the last one, so it was left as it is.');
        const keep = (entry: HistoryEntry) => {
            session.record(entry);
            laidPaths.current.set(laidKey, entry);
        };
        if (!session.usable || session.locked) { onMessage(session.locked ?? 'The graphics card was reset: wait until the set has opened again.'); return; }
        if (!target) { onMessage('Pick a paint layer or a painted mask to lay the path on.'); return; }
        if (path.points.length < (how === 'fill' ? 3 : 1)) { onMessage(how === 'fill' ? 'A path needs three points or more to fill inside it.' : 'Click the model to give the path points first.'); return; }
        placeCamera();
        const depth = renderDepth(gpu, world.root, world.camera, size.width, size.height);
        const perspective = (size.height / 2) / Math.tan(THREE.MathUtils.degToRad(world.camera.fov / 2));
        const view = {
            viewProjection: new THREE.Matrix4().multiplyMatrices(world.camera.projectionMatrix, world.camera.matrixWorldInverse),
            cameraPosition: world.camera.position.clone(),
            cameraRight: new THREE.Vector3().setFromMatrixColumn(world.camera.matrixWorld, 0).normalize(),
            cameraUp: new THREE.Vector3().setFromMatrixColumn(world.camera.matrixWorld, 1).normalize(),
            width: size.width,
            height: size.height,
            depth,
            perspective,
        };
        const plain: BrushSettings = { ...brush, mode: 'paint', buildUp: false, symmetry: { x: false, y: false, z: false }, radial: { count: 1, axis: 'y' } };
        const disposables: THREE.Texture[] = [];
        try {
            if (how === 'fill') {
                const outline = document.createElement('canvas');
                outline.width = size.width;
                outline.height = size.height;
                const context = outline.getContext('2d')!;
                context.fillStyle = 'black';
                context.fillRect(0, 0, size.width, size.height);
                context.fillStyle = 'white';
                context.beginPath();
                const samples = samplePath(path.points, Math.max(pathLength(path.points, true) / 400, 1e-6), true);
                samples.forEach((sample, i) => {
                    const v = new THREE.Vector3(...sample.position).applyMatrix4(view.viewProjection);
                    const px = (v.x * 0.5 + 0.5) * size.width, py = (0.5 - v.y * 0.5) * size.height;
                    if (i === 0) context.moveTo(px, py);
                    else context.lineTo(px, py);
                });
                context.closePath();
                context.fill();
                const stencil = new THREE.CanvasTexture(outline);
                stencil.colorSpace = THREE.NoColorSpace;
                disposables.push(stencil);
                const fill: BrushSettings = { ...plain, projection: 'screen', shape: 'square', hardness: 1, stencil: { enabled: true, textureId: 'path', scale: 1, rotation: 0, offsetX: 0, offsetY: 0, opacity: 1 } };
                const stroke = new Stroke(stack, target, 'paint', fill, view, null, stencil);
                stroke.stamp([{ x: size.width / 2, y: size.height / 2, radius: Math.hypot(size.width, size.height) / 2 + 2, angle: 0, flow: 1 }], null);
                keep(stroke.finish(`Fill inside ${path.name}`));
                return;
            }
            const laid = await layPathAlong({
                session, target, brush, path, view, onMessage,
                pixelsAt: (point, worldRadius) => (worldRadius * perspective) / Math.max(1e-6, world.camera.position.distanceTo(point)),
            });
            if (laid) keep(laid);
        } finally {
            gpu.release(depth);
            for (const texture of disposables) texture.dispose();
        }
    };
    const paintPathRef = useRef(paintPath);
    paintPathRef.current = paintPath;
    const keepDecalRef = useRef(keepDecal);
    keepDecalRef.current = keepDecal;
    const dropDecalRef = useRef(dropDecal);
    dropDecalRef.current = dropDecal;
    useEffect(() => {
        if (!commands) return undefined;
        commands.current = { paintPath: (path, how) => paintPathRef.current(path, how), keepDecal: () => keepDecalRef.current(), dropDecal: () => dropDecalRef.current(true) };
        return () => { commands.current = null; };
    }, [commands]);

    useEffect(() => {
        const element = host.current;
        if (!element) return undefined;
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            world.orbit.distance = Math.max(world.orbit.radius * 0.05, Math.min(world.orbit.radius * 20, world.orbit.distance * Math.exp(event.deltaY * 0.001)));
            draw();
        };
        element.addEventListener('wheel', onWheel, { passive: false });
        return () => element.removeEventListener('wheel', onWheel);
    }, [draw, world]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const element = event.target as HTMLElement | null;
            if (element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable)) return;
            if (!host.current?.matches(':hover')) return;
            if (event.key === '[') onBrushSize(Math.max(1, Math.round(brush.size / 1.15)));
            else if (event.key === ']') onBrushSize(Math.min(MAX_BRUSH_SIZE, Math.round(brush.size * 1.15) + 1));
            else if (event.key.toLowerCase() === 'f' && !event.ctrlKey) frame();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [brush.size, frame, onBrushSize]);

    const showCursor = cursor && !picking && (tool === 'paint' || tool === 'erase');
    const stencilTexture = brush.stencil.enabled && brush.stencil.textureId && (tool === 'paint' || tool === 'erase') ? session.host.texture(brush.stencil.textureId) : null;
    return (
        <div
            ref={host}
            className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
            style={{ cursor: picking || tool === 'pick' || tool === 'polygon' || tool === 'decal' ? 'crosshair' : showCursor ? 'none' : 'default' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => setCursor(null)}
            onContextMenu={(event) => event.preventDefault()}
        >
            <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
            {stencilTexture && <StencilOverlay texture={stencilTexture} place={stencilPlace(brush.stencil, pictureAspect(stencilTexture), size.width / size.ratio, size.height / size.ratio)} />}
            {showCursor && (
                <div className="pointer-events-none absolute rounded-full border border-white/80 mix-blend-difference" style={{
                    left: cursor.x - brush.size / size.ratio, top: cursor.y - brush.size / size.ratio, width: (brush.size * 2) / size.ratio, height: (brush.size * 2) / size.ratio,
                    borderRadius: brush.shape === 'square' ? 2 : '50%',
                }}>
                    <div className="absolute rounded-full border border-white/40" style={{ inset: `${(1 - brush.hardness) * 50}%` }} />
                </div>
            )}
        </div>
    );
};
