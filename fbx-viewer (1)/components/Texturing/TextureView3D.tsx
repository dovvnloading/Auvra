import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RotateCw } from 'lucide-react';
import type { TextureGpu } from '../../texturing/gpu/textureGpu';
import { IconButton } from '../UI/kit';
import { Select } from '../UI/Select';
import type { PreviewSet } from './textureGraphSession';

/**
 * The 3D view: the material on a shape (or on one of the project's models), lit by a studio
 * environment. Drag to turn round it, wheel to come closer; height can push the surface out for real.
 */

export type PreviewShape = 'sphere' | 'roundedBox' | 'plane' | 'cylinder' | `model:${string}`;

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

const shapeGeometry = (shape: PreviewShape): THREE.BufferGeometry => {
    switch (shape) {
        case 'roundedBox': return new RoundedBoxGeometry(1.5, 1.5, 1.5, 24, 0.18);
        case 'cylinder': return new THREE.CylinderGeometry(0.8, 0.8, 1.8, 256, 96);
        case 'plane': {
            const geometry = new THREE.PlaneGeometry(2.2, 2.2, 384, 384);
            geometry.rotateX(-Math.PI / 2);
            return geometry;
        }
        default: return new THREE.SphereGeometry(1, 384, 192);
    }
};

/** A model's meshes in their rest pose, drawn with the preview material and fitted into a unit box. */
const modelGroup = (source: THREE.Object3D, material: THREE.Material): THREE.Group => {
    const group = new THREE.Group();
    source.updateWorldMatrix(true, true);
    const rootInverse = source.matrixWorld.clone().invert();
    source.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry?.attributes.uv) return;
        const copy = new THREE.Mesh(mesh.geometry, material);
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
}> = ({ gpu, preview, version, models = [] }) => {
    const host = useRef<HTMLDivElement>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const [shape, setShape] = useState<PreviewShape>('sphere');
    const [tiling, setTiling] = useState(1);
    const [displace, setDisplace] = useState(0.04);
    const [spin, setSpin] = useState(false);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const orbit = useRef({ yaw: 0.6, pitch: 0.35, distance: 3.4 });
    const [orbitVersion, setOrbitVersion] = useState(0);

    const world = useMemo(() => {
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x18181b);
        const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
        const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 1 });
        const sun = new THREE.DirectionalLight(0xffffff, 1.4);
        sun.position.set(3, 4, 2);
        scene.add(sun);
        return { scene, camera, material, sun, object: null as THREE.Object3D | null };
    }, []);

    useEffect(() => () => {
        world.material.dispose();
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
            object = model ? modelGroup(model.object, world.material) : new THREE.Mesh(shapeGeometry('sphere'), world.material);
            object.traverse((child) => { child.userData.shared = true; });
        } else {
            object = new THREE.Mesh(shapeGeometry(shape), world.material);
        }
        world.object = object;
        world.scene.add(object);
        setOrbitVersion((value) => value + 1);
    }, [models, shape, world]);

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
                value.repeat.set(tiling, tiling);
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

        const { yaw, pitch, distance } = orbit.current;
        camera.position.set(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)).multiplyScalar(distance);
        camera.lookAt(0, 0, 0);
        camera.aspect = size.width / size.height;
        camera.updateProjectionMatrix();
        gpu.present(element, () => gpu.renderer.render(scene, camera));
    }, [displace, gpu, orbitVersion, preview, shape, size, tiling, version, world]);

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
                <Select value={shape} options={shapes} onChange={(value) => setShape(value as PreviewShape)} className="w-36" />
                <span className="flex-1" />
                <IconButton label={spin ? 'Stop turning' : 'Turn slowly'} active={spin} onClick={() => setSpin((value) => !value)}><RotateCw size={13} /></IconButton>
            </div>
            <div
                ref={host}
                className="relative min-h-0 flex-1 cursor-grab"
                onPointerDown={(event) => { drag.current = { x: event.clientX, y: event.clientY }; (event.target as HTMLElement).setPointerCapture(event.pointerId); }}
                onPointerMove={(event) => {
                    if (!drag.current) return;
                    orbit.current.yaw -= (event.clientX - drag.current.x) * 0.01;
                    orbit.current.pitch = Math.min(1.45, Math.max(-1.45, orbit.current.pitch + (event.clientY - drag.current.y) * 0.01));
                    drag.current = { x: event.clientX, y: event.clientY };
                    setOrbitVersion((value) => value + 1);
                }}
                onPointerUp={() => { drag.current = null; }}
            >
                <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
            </div>
            <div className="flex items-center gap-3 border-t border-zinc-800 px-2 py-1 text-2xs text-zinc-400">
                <label className="flex items-center gap-1">Repeat
                    <input type="range" min={1} max={8} step={1} value={tiling} onChange={(event) => setTiling(Number(event.target.value))} className="w-16 accent-sky-500" aria-label="Repeat on the shape" />
                    <span className="w-3 tabular-nums">{tiling}</span>
                </label>
                <label className="flex items-center gap-1" title="How far height pushes the surface out (shapes only)">Height
                    <input type="range" min={0} max={0.2} step={0.005} value={displace} onChange={(event) => setDisplace(Number(event.target.value))} className="w-16 accent-sky-500" aria-label="Height on the shape" />
                </label>
            </div>
        </div>
    );
};
