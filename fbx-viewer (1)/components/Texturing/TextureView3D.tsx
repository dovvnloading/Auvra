import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GridIcon, InfoIcon, RotateIcon, SunIcon, WarningIcon } from '../UI/Icons';
import { PREVIEW_LIGHTINGS, captureLighting, type PreviewLighting } from '../Materials/previewLighting';
import { bindMaterialGraph } from '../../runtime/materials/graphMaterial';
import { defaultParams, type MaterialGraph } from '../../runtime/materials/materialGraph';
import type { TextureGpu } from '../../texturing/gpu/textureGpu';
import { materialGraphForTextures, type ChannelTextureIds } from '../../texturing/materialOutput';
import { IconButton, Segmented } from '../UI/kit';
import { Select } from '../UI/Select';
import { finishPicking, usePicking } from './eyedropper';
import { previewGeometry, type BaseShape, type PreviewMeshMaps, type PreviewShape } from './previewMeshMaps';
import type { PreviewSet } from './textureGraphSession';

/**
 * The 3D view: the material on a shape (or on one of the project's models), drawn the way the engine
 * draws materials in a level (its own material path, physical where the material needs it), lit by
 * the lighting chosen (as the shader preview offers), with shadows, and height pushing the surface
 * out. One channel can be shown alone; the wireframe can be laid over it, and the UV layout shown
 * flat. Drag to turn round it, wheel to come closer, Shift-drag to turn the light. A setting's
 * eyedropper picks the base colour under a click on the model.
 */

export type { PreviewShape } from './previewMeshMaps';

const BASE_SHAPES: ReadonlyArray<{ value: PreviewShape; label: string }> = [
    { value: 'sphere', label: 'Sphere' },
    { value: 'roundedBox', label: 'Rounded cube' },
    { value: 'cylinder', label: 'Cylinder' },
    { value: 'plane', label: 'Flat square' },
];

type Shown = 'material' | 'baseColor' | 'normal' | 'roughness' | 'metallic' | 'ambientOcclusion' | 'height' | 'emissive' | 'opacity';
const SHOWN: ReadonlyArray<{ value: Shown; label: string }> = [
    { value: 'material', label: 'Material' }, { value: 'baseColor', label: 'Base colour' }, { value: 'normal', label: 'Normal' },
    { value: 'roughness', label: 'Roughness' }, { value: 'metallic', label: 'Metallic' }, { value: 'ambientOcclusion', label: 'Ambient occlusion' },
    { value: 'height', label: 'Height' }, { value: 'emissive', label: 'Emissive' }, { value: 'opacity', label: 'Opacity' },
];
/** Where a channel shown alone comes from: a picture of the preview set, and how to read it (0 a colour, 1 as stored, 2-4 one of red, green, blue). */
const ALONE: Record<Exclude<Shown, 'material'>, { image: keyof Omit<PreviewSet, 'version'>; mode: number }> = {
    baseColor: { image: 'baseColor', mode: 0 }, normal: { image: 'normal', mode: 1 }, ambientOcclusion: { image: 'orm', mode: 2 },
    roughness: { image: 'orm', mode: 3 }, metallic: { image: 'orm', mode: 4 }, height: { image: 'height', mode: 2 }, emissive: { image: 'emissive', mode: 0 }, opacity: { image: 'opacity', mode: 2 },
};
const LIVE_IDS = { baseColor: 'live:baseColor', normal: 'live:normal', orm: 'live:orm', emissive: 'live:emissive', opacity: 'live:opacity' } as const;

/** The engine's material graph for the pictures the graph makes now, read through one tiling node. */
const liveGraph = (preview: PreviewSet, repeat: number): MaterialGraph => {
    const ids: ChannelTextureIds = {};
    if (preview.baseColor) ids.baseColor = LIVE_IDS.baseColor;
    if (preview.normal) ids.normal = LIVE_IDS.normal;
    if (preview.orm) ids.orm = LIVE_IDS.orm;
    if (preview.emissive) ids.emissive = LIVE_IDS.emissive;
    if (preview.opacity) ids.opacity = LIVE_IDS.opacity;
    const graph = materialGraphForTextures(ids, { opacityMode: preview.opacity ? 'masked' : undefined });
    graph.nodes.push({ id: 'liveTiling', type: 'tilingOffset', x: -220, y: 0, params: { ...defaultParams('tilingOffset'), tiling: [repeat, repeat] } });
    for (const node of graph.nodes) if (node.type === 'texture' || node.type === 'normalMap') graph.links.push({ fromNode: 'liveTiling', fromOutput: 'out', toNode: node.id, toInput: 'uv' });
    return graph;
};

const ALONE_SHADER = {
    vertexShader: 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform sampler2D map;
uniform int mode;
uniform int has;
uniform float repeat;
varying vec2 vUv;
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
    if (has == 0) { gl_FragColor = vec4(0.35, 0.35, 0.38, 1.0); return; }
    vec4 v = texture2D(map, vUv * repeat);
    vec3 c = mode == 0 ? toSrgb(v.rgb) : mode == 1 ? v.rgb : vec3(mode == 2 ? v.r : mode == 3 ? v.g : v.b);
    gl_FragColor = vec4(c, 1.0);
}`,
};

const lightings = new WeakMap<TextureGpu, Map<PreviewLighting, THREE.WebGLRenderTarget>>();
const lightingOf = (gpu: TextureGpu, lighting: PreviewLighting): THREE.Texture => {
    let cache = lightings.get(gpu);
    if (!cache) lightings.set(gpu, cache = new Map());
    let target = cache.get(lighting);
    if (!target) cache.set(lighting, target = captureLighting(gpu.renderer, lighting));
    return target.texture;
};

const materialName = (material: THREE.Material): string => material.name || '';

/**
 * A model's meshes in their rest pose, fitted into a unit box. Drawn with the preview material, or,
 * when `wearing` names some of the model's materials, those with it and the rest in plain grey.
 */
const modelGroup = (source: THREE.Object3D, material: THREE.Material, plain: THREE.Material, only: ReadonlySet<string> | null): THREE.Group => {
    const group = new THREE.Group();
    source.updateWorldMatrix(true, true);
    const rootInverse = source.matrixWorld.clone().invert();
    // A set named after something other than its materials (they had no names): the whole model wears it.
    let matched = false;
    if (only) source.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) for (const own of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (only.has(materialName(own))) matched = true;
    });
    const wearing = matched ? only : null;
    source.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry?.attributes.uv) return;
        const pick = (own: THREE.Material) => (!wearing || wearing.has(materialName(own)) ? material : plain);
        const copy = new THREE.Mesh(mesh.geometry, Array.isArray(mesh.material) ? mesh.material.map(pick) : pick(mesh.material));
        copy.matrixAutoUpdate = false;
        copy.matrix.multiplyMatrices(rootInverse, mesh.matrixWorld);
        group.add(copy);
    });
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const scale = 2 / Math.max(size.x, size.y, size.z, 1e-6);
    const holder = new THREE.Group();
    group.position.copy(centre).multiplyScalar(-1);
    holder.add(group);
    holder.scale.setScalar(scale);
    return holder;
};

/** The meshes of what is shown, with the geometry each draws. */
const meshesOf = (object: THREE.Object3D | null): THREE.Mesh[] => {
    const meshes: THREE.Mesh[] = [];
    object?.traverse((child) => { if ((child as THREE.Mesh).isMesh && !child.userData.overlay) meshes.push(child as THREE.Mesh); });
    return meshes;
};

/** A mesh's triangles laid flat at their UVs, as lines. */
const uvLines = (geometry: THREE.BufferGeometry): THREE.BufferGeometry | null => {
    const uv = geometry.attributes.uv;
    if (!uv) return null;
    const flat = new THREE.BufferGeometry();
    const positions = new Float32Array(uv.count * 3);
    for (let i = 0; i < uv.count; i++) { positions[i * 3] = uv.getX(i); positions[i * 3 + 1] = uv.getY(i); }
    flat.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    if (geometry.index) flat.setIndex(geometry.index);
    const lines = new THREE.WireframeGeometry(flat);
    flat.dispose();
    return lines;
};

export const TextureView3D: React.FC<{
    gpu: TextureGpu;
    preview: PreviewSet;
    version: number;
    models?: ReadonlyArray<{ id: string; name: string; object: THREE.Object3D }>;
    shape: PreviewShape;
    onShapeChange: (shape: PreviewShape) => void;
    /** Where the graph's mesh maps come from, for this shape or model. */
    meshMaps: PreviewMeshMaps;
    onSurfaceChange: (surfaceId: string) => void;
}> = ({ gpu, preview, version, models = [], shape, onShapeChange, meshMaps, onSurfaceChange }) => {
    const host = useRef<HTMLDivElement>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const picking = usePicking();
    const [tiling, setTiling] = useState(1);
    const [displace, setDisplace] = useState(0.04);
    const [light, setLight] = useState(1.25);
    const [lighting, setLighting] = useState<PreviewLighting>('room');
    const [shadows, setShadows] = useState(true);
    const [shown, setShown] = useState<Shown>('material');
    const [wireframe, setWireframe] = useState(false);
    const [layout, setLayout] = useState<'model' | 'uv'>('model');
    const [spin, setSpin] = useState(false);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const orbit = useRef({ yaw: 0.6, pitch: 0.35, distance: 4, lightTurn: 0 });
    /** The pictures (and repeat) the engine's material was last bound to. */
    const bound = useRef('');
    const [orbitVersion, setOrbitVersion] = useState(0);
    // Real mesh maps follow the surface one to one: the picture is shown once.
    const repeat = meshMaps.real ? 1 : tiling;
    const wearing = meshMaps.surface ? meshMaps.surface.materialNames : null;
    const wearingKey = wearing ? wearing.join('\n') : '';

    const world = useMemo(() => {
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x18181b);
        const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
        // Shaded by the engine's own material path: bound to the graph of the pictures as they are drawn.
        const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
        const plain = new THREE.MeshStandardMaterial({ color: 0x5a5a60, roughness: 0.7, metalness: 0 });
        const alone = new THREE.ShaderMaterial({ ...ALONE_SHADER, uniforms: { map: { value: null }, mode: { value: 0 }, has: { value: 0 }, repeat: { value: 1 } } });
        const sun = new THREE.DirectionalLight(0xffffff, 1.4);
        sun.position.set(3, 4, 2);
        sun.castShadow = true;
        sun.shadow.mapSize.set(1024, 1024);
        sun.shadow.camera.left = sun.shadow.camera.bottom = -2.2;
        sun.shadow.camera.right = sun.shadow.camera.top = 2.2;
        sun.shadow.camera.near = 0.5;
        sun.shadow.camera.far = 12;
        sun.shadow.bias = -0.0005;
        sun.shadow.normalBias = 0.02;
        scene.add(sun);
        // A floor that only shows the shadow cast on it.
        const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.ShadowMaterial({ opacity: 0.35 }));
        floor.rotation.x = -Math.PI / 2;
        floor.position.y = -1.08;
        floor.receiveShadow = true;
        floor.userData.overlay = true;
        scene.add(floor);
        // The UV layout, flat: the picture behind, the triangles over it.
        const flat = new THREE.Scene();
        flat.background = new THREE.Color(0x18181b);
        const flatCamera = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
        const sheet = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), alone.clone());
        sheet.position.set(0.5, 0.5, -0.5);
        flat.add(sheet);
        const flatLines = new THREE.Group();
        flat.add(flatLines);
        return { scene, camera, material, plain, alone, sun, floor, flat, flatCamera, sheet, flatLines, object: null as THREE.Object3D | null };
    }, []);

    useEffect(() => () => {
        world.material.dispose();
        world.plain.dispose();
        world.alone.dispose();
        (world.sheet.material as THREE.Material).dispose();
        world.floor.geometry.dispose();
        (world.floor.material as THREE.Material).dispose();
        world.object?.traverse((child) => { if ((child as THREE.Mesh).isMesh && !(child.userData.shared)) (child as THREE.Mesh).geometry.dispose(); });
    }, [world]);

    // The shape (or model) the material is shown on.
    useEffect(() => {
        if (world.object) {
            world.scene.remove(world.object);
            world.object.traverse((child) => {
                const mesh = child as THREE.Mesh & THREE.LineSegments;
                if ((mesh.isMesh && !child.userData.shared) || child.userData.overlay) mesh.geometry.dispose();
            });
        }
        let object: THREE.Object3D;
        if (shape.startsWith('model:')) {
            const model = models.find((candidate) => `model:${candidate.id}` === shape);
            const names = wearingKey ? new Set(wearingKey.split('\n')) : null;
            object = model ? modelGroup(model.object, world.material, world.plain, names) : new THREE.Mesh(previewGeometry('sphere', { unique: false, detail: 'view' }), world.material);
            if (model) object.traverse((child) => { child.userData.shared = true; });
        } else {
            object = new THREE.Mesh(previewGeometry(shape as BaseShape, { unique: meshMaps.uniqueLayout, detail: 'view' }), world.material);
        }
        object.traverse((child) => { if ((child as THREE.Mesh).isMesh) { child.castShadow = true; child.receiveShadow = true; } });
        world.object = object;
        world.scene.add(object);
        // The UV layout of what is shown.
        for (const line of [...world.flatLines.children]) {
            world.flatLines.remove(line);
            (line as THREE.LineSegments).geometry.dispose();
            ((line as THREE.LineSegments).material as THREE.Material).dispose();
        }
        const lineMaterial = new THREE.LineBasicMaterial({ color: 0xf08a3c, transparent: true, opacity: 0.7 });
        for (const mesh of meshesOf(object)) {
            const lines = uvLines(mesh.geometry);
            if (lines) world.flatLines.add(new THREE.LineSegments(lines, lineMaterial));
        }
        setOrbitVersion((value) => value + 1);
    }, [meshMaps.uniqueLayout, models, shape, wearingKey, world]);

    // The wireframe laid over the model.
    useEffect(() => {
        const overlays: THREE.LineSegments[] = [];
        if (wireframe) {
            const material = new THREE.LineBasicMaterial({ color: 0xf08a3c, transparent: true, opacity: 0.45 });
            for (const mesh of meshesOf(world.object)) {
                const lines = new THREE.LineSegments(new THREE.WireframeGeometry(mesh.geometry), material);
                lines.userData.overlay = true;
                mesh.add(lines);
                overlays.push(lines);
            }
        }
        setOrbitVersion((value) => value + 1);
        return () => {
            for (const lines of overlays) { lines.removeFromParent(); lines.geometry.dispose(); }
            (overlays[0]?.material as THREE.Material | undefined)?.dispose();
        };
    }, [shape, wearingKey, wireframe, world, models]);

    useEffect(() => {
        const element = host.current;
        if (!element) return undefined;
        const observer = new ResizeObserver(() => {
            const box = element.getBoundingClientRect();
            const ratio = window.devicePixelRatio || 1;
            setSize({ width: Math.max(1, Math.floor(box.width * ratio)), height: Math.max(1, Math.floor(box.height * ratio)) });
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (!spin) return undefined;
        let frame = requestAnimationFrame(function step() {
            orbit.current.yaw += 0.006;
            setOrbitVersion((value) => value + 1);
            frame = requestAnimationFrame(step);
        });
        return () => cancelAnimationFrame(frame);
    }, [spin]);

    useEffect(() => {
        const element = canvas.current;
        if (!element || !size.width) return;
        element.width = size.width;
        element.height = size.height;
        const { scene, camera, material, alone } = world;
        const texture = (image: PreviewSet['baseColor']) => {
            const value = image?.target.texture ?? null;
            if (value) value.wrapS = value.wrapT = THREE.RepeatWrapping;
            return value;
        };
        // The engine's material, bound to the pictures as they are now (again only when they change: the
        // same shape only updates values, nothing is compiled).
        const bindKey = `${preview.version}|${repeat}`;
        if (bound.current !== bindKey) {
            bound.current = bindKey;
            bindMaterialGraph(material, liveGraph(preview, repeat), (id) => {
                const key = (Object.keys(LIVE_IDS) as Array<keyof typeof LIVE_IDS>).find((name) => LIVE_IDS[name] === id);
                return key ? texture(preview[key]) : null;
            });
        }
        // Height pushes the surface out, on models as on shapes (seams in a model's UVs may open).
        const height = texture(preview.height);
        if (material.displacementMap !== height) { material.displacementMap = height; material.needsUpdate = true; }
        if (height) height.repeat.set(repeat, repeat);
        material.displacementScale = displace;
        material.displacementBias = -displace * 0.5;

        // One channel alone, unlit.
        const pickAlone = (target: THREE.ShaderMaterial, which: Shown) => {
            const source = which === 'material' ? ALONE.baseColor : ALONE[which];
            const image = texture(preview[source.image]);
            target.uniforms.map.value = image;
            target.uniforms.has.value = image ? 1 : 0;
            target.uniforms.mode.value = source.mode;
            target.uniforms.repeat.value = repeat;
        };
        pickAlone(alone, shown);
        const showAlone = shown !== 'material';
        for (const mesh of meshesOf(world.object)) {
            const wanted = (own: THREE.Material) => (own === world.plain ? own : showAlone ? alone : material);
            const current = mesh.material;
            if (Array.isArray(current)) mesh.material = current.map((own) => (own === alone || own === material ? wanted(material) : wanted(own)));
            else if (current === alone || current === material) mesh.material = wanted(material);
        }

        gpu.renderer.shadowMap.enabled = true;
        gpu.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        world.sun.castShadow = shadows;
        world.floor.visible = shadows && layout === 'model';

        // The light: as bright as asked, turned round the shape by Shift-dragging.
        const { yaw, pitch, distance, lightTurn } = orbit.current;
        scene.environment = lightingOf(gpu, lighting);
        scene.environmentIntensity = light;
        scene.environmentRotation.set(0, lightTurn, 0);
        world.sun.intensity = (lighting === 'night' ? 0.35 : 1.4) * light;
        world.sun.position.set(3, 4, 2).applyAxisAngle(new THREE.Vector3(0, 1, 0), lightTurn);
        camera.aspect = size.width / size.height;
        // Fitted both ways: a view taller than wide moves back so the shape's sides stay in.
        const fit = camera.aspect < 1 ? 1 / camera.aspect : 1;
        camera.position.set(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)).multiplyScalar(distance * fit);
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();

        if (layout === 'uv') {
            pickAlone(world.sheet.material as THREE.ShaderMaterial, shown);
            (world.sheet.material as THREE.ShaderMaterial).uniforms.repeat.value = 1;
            // The unit square, whole and centred, whatever the view's shape.
            const aspect = size.width / size.height;
            const span = 1.08;
            const cam = world.flatCamera;
            cam.left = 0.5 - (span * Math.max(1, aspect)) / 2;
            cam.right = 0.5 + (span * Math.max(1, aspect)) / 2;
            cam.bottom = 0.5 - (span * Math.max(1, 1 / aspect)) / 2;
            cam.top = 0.5 + (span * Math.max(1, 1 / aspect)) / 2;
            cam.updateProjectionMatrix();
            gpu.present(element, () => gpu.renderer.render(world.flat, cam));
            return;
        }
        gpu.present(element, () => gpu.renderer.render(scene, camera));
    }, [displace, gpu, layout, light, lighting, orbitVersion, preview, repeat, shadows, shape, shown, size, version, world]);

    useEffect(() => {
        const element = host.current;
        if (!element) return undefined;
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            orbit.current.distance = Math.min(12, Math.max(1.4, orbit.current.distance * Math.exp(event.deltaY * 0.001)));
            setOrbitVersion((value) => value + 1);
        };
        element.addEventListener('wheel', onWheel, { passive: false });
        return () => element.removeEventListener('wheel', onWheel);
    }, []);

    /** The base colour under a click on the model, for a waiting eyedropper (as picked colours are: sRGB). */
    const pickAt = async (clientX: number, clientY: number) => {
        const element = host.current;
        const image = preview.baseColor;
        if (!element || !image || !world.object) return;
        const box = element.getBoundingClientRect();
        const ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2(((clientX - box.left) / box.width) * 2 - 1, -((clientY - box.top) / box.height) * 2 + 1), world.camera);
        const hit = ray.intersectObjects(meshesOf(world.object), false).find((candidate) => candidate.uv);
        if (!hit?.uv) return;
        const u = (((hit.uv.x * repeat) % 1) + 1) % 1;
        const v = (((hit.uv.y * repeat) % 1) + 1) % 1;
        const read = await gpu.readPixelLater(image, Math.min(image.width - 1, Math.floor(u * image.width)), Math.min(image.height - 1, Math.floor(v * image.height)));
        if (!read) return;
        const encode = (value: number) => (value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055);
        finishPicking([encode(read[0]), encode(read[1]), encode(read[2]), 1]);
    };

    const drag = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
    const shapes = useMemo(() => [...BASE_SHAPES, ...models.map((model) => ({ value: `model:${model.id}` as PreviewShape, label: model.name }))], [models]);
    const missing = shown !== 'material' && !preview[ALONE[shown].image];

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-1.5 border-b border-line px-2 py-1">
                <span className="text-2xs font-semibold text-ink-2">3D</span>
                <Select value={shape} options={shapes} onChange={(value) => onShapeChange(value as PreviewShape)} className="w-32" />
                {meshMaps.surfaces.length > 1 && (
                    <Select value={meshMaps.surface?.id ?? ''} options={meshMaps.surfaces.map((surface) => ({ value: surface.id, label: surface.name }))}
                        onChange={(value) => onSurfaceChange(String(value))} className="min-w-0 flex-1" placeholder="Baked surface" />
                )}
                <span className="flex-1" />
                <IconButton label={spin ? 'Stop turning' : 'Turn slowly'} active={spin} onClick={() => setSpin((value) => !value)}><RotateIcon size={13} /></IconButton>
            </div>
            <div className="flex items-center gap-1 border-b border-line px-2 py-0.5">
                <Select value={shown} options={SHOWN} onChange={(value) => setShown(value as Shown)} className="w-32" />
                <Select value={lighting} options={PREVIEW_LIGHTINGS} onChange={(value) => setLighting(value as PreviewLighting)} className="w-24" />
                <span className="flex-1" />
                <IconButton label={shadows ? 'Shadows: on' : 'Shadows: off'} active={shadows} onClick={() => setShadows((value) => !value)}><SunIcon size={13} /></IconButton>
                <IconButton label={wireframe ? 'Hide the wireframe' : 'Show the wireframe'} active={wireframe} disabled={layout === 'uv'} onClick={() => setWireframe((value) => !value)}><GridIcon size={13} /></IconButton>
                <Segmented value={layout} options={[{ value: 'model', label: '3D', hint: 'The material on the shape' }, { value: 'uv', label: 'UV', hint: 'The UV layout, flat, over the picture' }]} onChange={setLayout} label="View" />
            </div>
            <div
                ref={host}
                className={`relative min-h-0 flex-1 ${picking?.kind === 'colour' ? 'cursor-crosshair' : layout === 'uv' ? 'cursor-default' : 'cursor-grab'}`}
                title={layout === 'uv' ? 'The UV layout of what is shown, over the picture' : 'Drag to turn round it, wheel to come closer, Shift-drag to turn the light'}
                onPointerDown={(event) => { drag.current = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY }; (event.target as HTMLElement).setPointerCapture(event.pointerId); }}
                onPointerMove={(event) => {
                    if (!drag.current || layout === 'uv') return;
                    if (event.shiftKey) orbit.current.lightTurn += (event.clientX - drag.current.x) * 0.01;
                    else {
                        orbit.current.yaw -= (event.clientX - drag.current.x) * 0.01;
                        orbit.current.pitch = Math.min(1.45, Math.max(-1.45, orbit.current.pitch + (event.clientY - drag.current.y) * 0.01));
                    }
                    drag.current = { ...drag.current, x: event.clientX, y: event.clientY };
                    setOrbitVersion((value) => value + 1);
                }}
                onPointerUp={(event) => {
                    const start = drag.current;
                    drag.current = null;
                    if (start && picking?.kind === 'colour' && layout === 'model' && Math.hypot(event.clientX - start.startX, event.clientY - start.startY) < 4) void pickAt(event.clientX, event.clientY);
                }}
            >
                <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
                {missing && <div className="pointer-events-none absolute left-2 top-2 rounded bg-panel/90 px-1.5 py-0.5 text-2xs text-ink-3">The graph gives no {SHOWN.find((item) => item.value === shown)?.label.toLowerCase()}.</div>}
                {picking?.kind === 'colour' && layout === 'model' && (
                    <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded bg-panel/95 px-2 py-1 text-2xs text-accent shadow">Click the model to pick {picking.label} · Esc to stop</div>
                )}
                {meshMaps.note && (
                    <div className={`pointer-events-none absolute inset-x-2 bottom-2 flex items-start gap-1.5 rounded border px-2 py-1 text-2xs leading-snug shadow ${meshMaps.tone === 'warning' ? 'border-warn/40 bg-panel/90 text-warn' : 'border-line bg-panel/85 text-ink-2'}`}>
                        {meshMaps.tone === 'warning' ? <WarningIcon size={12} className="mt-px shrink-0" /> : <InfoIcon size={12} className="mt-px shrink-0 text-ink-3" />}
                        <span>{meshMaps.note}</span>
                    </div>
                )}
            </div>
            <div className="flex items-center gap-3 border-t border-line px-2 py-1 text-2xs text-ink-2">
                <label className="flex items-center gap-1" title={meshMaps.real ? 'Shown once: the mesh maps follow the surface' : 'How many times the picture repeats on the shape'}>Repeat
                    <input type="range" min={1} max={8} step={1} value={repeat} disabled={meshMaps.real} onChange={(event) => setTiling(Number(event.target.value))} className="w-14 accent-accent disabled:opacity-40" aria-label="Repeat on the shape" />
                    <span className="w-3 tabular-nums">{repeat}</span>
                </label>
                <label className="flex items-center gap-1" title="How far height pushes the surface out">Height
                    <input type="range" min={0} max={0.2} step={0.005} value={displace} onChange={(event) => setDisplace(Number(event.target.value))} className="w-14 accent-accent" aria-label="Height on the shape" />
                </label>
                <label className="flex items-center gap-1" title="How bright the light is; Shift-drag the view to turn it">Light
                    <input type="range" min={0.25} max={3} step={0.05} value={light} onChange={(event) => setLight(Number(event.target.value))} className="w-14 accent-accent" aria-label="Light brightness" />
                </label>
            </div>
        </div>
    );
};
