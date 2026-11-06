import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { InfoIcon, RotateIcon, WarningIcon } from '../UI/Icons';
import type { TextureGpu } from '../../texturing/gpu/textureGpu';
import { IconButton } from '../UI/kit';
import { Select } from '../UI/Select';
import { previewGeometry, type BaseShape, type PreviewMeshMaps, type PreviewShape } from './previewMeshMaps';
import type { PreviewSet } from './textureGraphSession';

/**
 * The 3D view: the material on a shape (or on one of the project's models), lit by a studio
 * environment. Drag to turn round it, wheel to come closer; height can push the surface out for real.
 * When the graph reads mesh maps, the view says where they come from; the picture is then shown once
 * (the maps follow the surface), and on a model only the baked surface wears the graph.
 */

export type { PreviewShape } from './previewMeshMaps';

const BASE_SHAPES: ReadonlyArray<{ value: PreviewShape; label: string }> = [
    { value: 'sphere', label: 'Sphere' },
    { value: 'roundedBox', label: 'Rounded cube' },
    { value: 'cylinder', label: 'Cylinder' },
    { value: 'plane', label: 'Flat square' },
];

const environments = new WeakMap<TextureGpu, THREE.Texture>();
const environmentOf = (gpu: TextureGpu): THREE.Texture => {
    let texture = environments.get(gpu);
    if (texture) return texture;
    const pmrem = new THREE.PMREMGenerator(gpu.renderer);
    texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    environments.set(gpu, texture);
    return texture;
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
    const [tiling, setTiling] = useState(1);
    const [displace, setDisplace] = useState(0.04);
    const [light, setLight] = useState(1.25);
    const [spin, setSpin] = useState(false);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const orbit = useRef({ yaw: 0.6, pitch: 0.35, distance: 4, lightTurn: 0 });
    const [orbitVersion, setOrbitVersion] = useState(0);
    // Real mesh maps follow the surface one to one: the picture is shown once.
    const repeat = meshMaps.real ? 1 : tiling;
    const wearing = meshMaps.surface ? meshMaps.surface.materialNames : null;
    const wearingKey = wearing ? wearing.join('\n') : '';

    const world = useMemo(() => {
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x18181b);
        const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
        const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 1 });
        const plain = new THREE.MeshStandardMaterial({ color: 0x5a5a60, roughness: 0.7, metalness: 0 });
        const sun = new THREE.DirectionalLight(0xffffff, 1.4);
        sun.position.set(3, 4, 2);
        scene.add(sun);
        return { scene, camera, material, plain, sun, object: null as THREE.Object3D | null };
    }, []);

    useEffect(() => () => {
        world.material.dispose();
        world.plain.dispose();
        world.object?.traverse((child) => { if ((child as THREE.Mesh).isMesh && !(child.userData.shared)) (child as THREE.Mesh).geometry.dispose(); });
    }, [world]);

    // The shape (or model) the material is shown on.
    useEffect(() => {
        if (world.object) {
            world.scene.remove(world.object);
            world.object.traverse((child) => { if ((child as THREE.Mesh).isMesh && !child.userData.shared) (child as THREE.Mesh).geometry.dispose(); });
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
        world.object = object;
        world.scene.add(object);
        setOrbitVersion((value) => value + 1);
    }, [meshMaps.uniqueLayout, models, shape, wearingKey, world]);

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
        const { scene, camera, material } = world;
        scene.environment = environmentOf(gpu);
        const texture = (image: PreviewSet['baseColor']) => {
            const value = image?.target.texture ?? null;
            if (value) {
                value.repeat.set(repeat, repeat);
                value.wrapS = value.wrapT = THREE.RepeatWrapping;
            }
            return value;
        };
        const changed = (key: 'map' | 'normalMap' | 'roughnessMap' | 'metalnessMap' | 'aoMap' | 'emissiveMap' | 'displacementMap' | 'alphaMap', value: THREE.Texture | null) => {
            if (material[key] === value) return false;
            material[key] = value;
            return true;
        };
        let rebuild = false;
        rebuild = changed('map', texture(preview.baseColor)) || rebuild;
        rebuild = changed('normalMap', texture(preview.normal)) || rebuild;
        const orm = texture(preview.orm);
        rebuild = changed('roughnessMap', orm) || rebuild;
        rebuild = changed('metalnessMap', orm) || rebuild;
        rebuild = changed('aoMap', orm) || rebuild;
        rebuild = changed('emissiveMap', texture(preview.emissive)) || rebuild;
        const isModel = shape.startsWith('model:');
        rebuild = changed('displacementMap', isModel ? null : texture(preview.height)) || rebuild;
        rebuild = changed('alphaMap', texture(preview.opacity)) || rebuild;
        material.metalness = orm ? 1 : 0;
        material.roughness = orm ? 1 : 0.5;
        material.emissive.setScalar(preview.emissive ? 1 : 0);
        material.displacementScale = displace;
        material.displacementBias = -displace * 0.5;
        material.alphaTest = preview.opacity ? 0.5 : 0;
        if (rebuild) material.needsUpdate = true;

        // The light: as bright as asked, turned round the shape by Shift-dragging.
        const { yaw, pitch, distance, lightTurn } = orbit.current;
        scene.environmentIntensity = light;
        scene.environmentRotation.set(0, lightTurn, 0);
        world.sun.intensity = 1.4 * light;
        world.sun.position.set(3, 4, 2).applyAxisAngle(new THREE.Vector3(0, 1, 0), lightTurn);
        camera.aspect = size.width / size.height;
        // Fitted both ways: a view taller than wide moves back so the shape's sides stay in.
        const fit = camera.aspect < 1 ? 1 / camera.aspect : 1;
        camera.position.set(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)).multiplyScalar(distance * fit);
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
        gpu.present(element, () => gpu.renderer.render(scene, camera));
    }, [displace, gpu, light, orbitVersion, preview, repeat, shape, size, version, world]);

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

    const drag = useRef<{ x: number; y: number } | null>(null);
    const shapes = useMemo(() => [...BASE_SHAPES, ...models.map((model) => ({ value: `model:${model.id}` as PreviewShape, label: model.name }))], [models]);

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-1.5 border-b border-zinc-800 px-2 py-1">
                <span className="text-2xs font-semibold text-zinc-300">3D</span>
                <Select value={shape} options={shapes} onChange={(value) => onShapeChange(value as PreviewShape)} className="w-36" />
                {meshMaps.surfaces.length > 1 && (
                    <Select value={meshMaps.surface?.id ?? ''} options={meshMaps.surfaces.map((surface) => ({ value: surface.id, label: surface.name }))}
                        onChange={(value) => onSurfaceChange(String(value))} className="min-w-0 flex-1" placeholder="Baked surface" />
                )}
                <span className="flex-1" />
                <IconButton label={spin ? 'Stop turning' : 'Turn slowly'} active={spin} onClick={() => setSpin((value) => !value)}><RotateIcon size={13} /></IconButton>
            </div>
            <div
                ref={host}
                className="relative min-h-0 flex-1 cursor-grab"
                title="Drag to turn round it, wheel to come closer, Shift-drag to turn the light"
                onPointerDown={(event) => { drag.current = { x: event.clientX, y: event.clientY }; (event.target as HTMLElement).setPointerCapture(event.pointerId); }}
                onPointerMove={(event) => {
                    if (!drag.current) return;
                    if (event.shiftKey) orbit.current.lightTurn += (event.clientX - drag.current.x) * 0.01;
                    else {
                        orbit.current.yaw -= (event.clientX - drag.current.x) * 0.01;
                        orbit.current.pitch = Math.min(1.45, Math.max(-1.45, orbit.current.pitch + (event.clientY - drag.current.y) * 0.01));
                    }
                    drag.current = { x: event.clientX, y: event.clientY };
                    setOrbitVersion((value) => value + 1);
                }}
                onPointerUp={() => { drag.current = null; }}
            >
                <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
                {meshMaps.note && (
                    <div className={`pointer-events-none absolute inset-x-2 bottom-2 flex items-start gap-1.5 rounded border px-2 py-1 text-2xs leading-snug shadow ${meshMaps.tone === 'warning' ? 'border-amber-900 bg-zinc-950/90 text-amber-200' : 'border-zinc-800 bg-zinc-950/85 text-zinc-300'}`}>
                        {meshMaps.tone === 'warning' ? <WarningIcon size={12} className="mt-px shrink-0" /> : <InfoIcon size={12} className="mt-px shrink-0 text-zinc-500" />}
                        <span>{meshMaps.note}</span>
                    </div>
                )}
            </div>
            <div className="flex items-center gap-3 border-t border-zinc-800 px-2 py-1 text-2xs text-zinc-400">
                <label className="flex items-center gap-1" title={meshMaps.real ? 'Shown once: the mesh maps follow the surface' : 'How many times the picture repeats on the shape'}>Repeat
                    <input type="range" min={1} max={8} step={1} value={repeat} disabled={meshMaps.real} onChange={(event) => setTiling(Number(event.target.value))} className="w-16 accent-sky-500 disabled:opacity-40" aria-label="Repeat on the shape" />
                    <span className="w-3 tabular-nums">{repeat}</span>
                </label>
                <label className="flex items-center gap-1" title="How far height pushes the surface out (shapes only)">Height
                    <input type="range" min={0} max={0.2} step={0.005} value={displace} onChange={(event) => setDisplace(Number(event.target.value))} className="w-16 accent-sky-500" aria-label="Height on the shape" />
                </label>
                <label className="flex items-center gap-1" title="How bright the light is; Shift-drag the view to turn it">Light
                    <input type="range" min={0.25} max={3} step={0.05} value={light} onChange={(event) => setLight(Number(event.target.value))} className="w-16 accent-sky-500" aria-label="Light brightness" />
                </label>
            </div>
        </div>
    );
};
