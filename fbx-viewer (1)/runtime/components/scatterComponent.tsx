import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import { createPlacementQuery } from '../../utils/surfacePlacement';
import { useGameContent } from '../GameContentContext';
import { physicsUserData, usePhysicsAvailable } from '../physics';
import {
    bakeImpostor, cellsOf, generateScatter, impostorMaterial, impostorQuad, readScatterSettings, scatterTier, updateImpostorLight,
    type Impostor, type ScatterCell, type ScatterGround, type ScatterSettings, type ScatterTier,
} from '../proceduralScatter';
import { splineModelBounds, splineModelParts, type SplineModelPart } from '../splineMesh';
import { PHYSICS_IGNORED_USER_DATA } from './physicsComponents';
import type { ComponentDefinition, ComponentRenderProps } from './types';

/**
 * PROCEDURAL SCATTER
 *
 * The Procedural Scatter component fills a box around its object with layers of models by rule (see
 * runtime/proceduralScatter.ts): placed on the terrain and meshes under it when it mounts and again
 * whenever its settings or its object change, drawn in cells that switch to impostors and then to
 * nothing with distance, and in play given colliders where a layer asks for them. Every copy is
 * drawn, never stored in the level.
 */

export const SCATTER_COMPONENT_TYPE = 'proceduralScatter';

/** Seconds between looks at how far each cell is. */
const TIER_INTERVAL = 0.25;
/** Placement runs this soon after a change, then is checked again every second for this long. */
const PLACE_DELAY = 250;
const SETTLE_TIME = 12000;
/** Most colliders one scatter makes. */
const MAX_COLLIDERS = 4000;

/** Marks scatter meshes so no placement (another scatter, the foliage brush) lands on them. */
const SCATTER_USER_DATA = { ...PHYSICS_IGNORED_USER_DATA, ignorePlacement: true };

const impostors = new WeakMap<THREE.Object3D, Impostor>();

const _down = new THREE.Vector3(0, -1, 0);
const _origin = new THREE.Vector3();
const _world = new THREE.Vector3();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();

interface LayerModel {
    object: THREE.Object3D;
    parts: SplineModelPart[];
    bounds: THREE.Box3;
}

/** One cell drawn: its models' parts as batches, and its impostors (made the first time they are wanted). */
class CellView {
    readonly full = new THREE.Group();
    readonly far = new THREE.Group();
    tier: ScatterTier = 'full';
    private impostorsBuilt = false;

    constructor(readonly cell: ScatterCell, private readonly models: (LayerModel | null)[], castShadow: boolean) {
        cell.layers.forEach((matrices, index) => {
            const model = models[index];
            if (!model || matrices.length === 0) return;
            for (const part of model.parts) {
                const mesh = new THREE.InstancedMesh(part.geometry, part.material, matrices.length);
                matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
                mesh.instanceMatrix.needsUpdate = true;
                mesh.computeBoundingSphere();
                mesh.castShadow = castShadow;
                mesh.receiveShadow = true;
                mesh.userData = SCATTER_USER_DATA;
                this.full.add(mesh);
            }
        });
        this.far.visible = false;
    }

    /** Builds the impostor batches once each layer's model has its picture. */
    buildImpostors(renderer: THREE.WebGLRenderer): void {
        if (this.impostorsBuilt) return;
        this.impostorsBuilt = true;
        this.cell.layers.forEach((matrices, index) => {
            const model = this.models[index];
            if (!model || matrices.length === 0 || model.parts.length === 0) return;
            let impostor = impostors.get(model.object);
            if (!impostor) {
                impostor = bakeImpostor(renderer, model.parts, model.bounds);
                impostors.set(model.object, impostor);
            }
            const mesh = new THREE.InstancedMesh(impostorQuad(), impostorMaterial(impostor), matrices.length);
            matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
            mesh.instanceMatrix.needsUpdate = true;
            mesh.computeBoundingSphere();
            mesh.userData = SCATTER_USER_DATA;
            this.far.add(mesh);
        });
    }

    show(tier: ScatterTier): void {
        this.tier = tier;
        this.full.visible = tier === 'full';
        this.far.visible = tier === 'impostor';
    }

    dispose(): void {
        // Geometry and materials of the full batches are the models'; only instance buffers are ours.
        for (const mesh of this.full.children as THREE.InstancedMesh[]) mesh.dispose();
        for (const mesh of this.far.children as THREE.InstancedMesh[]) {
            mesh.geometry.dispose();
            (mesh.material as THREE.Material).dispose();
            mesh.dispose();
        }
    }
}

/** The boxes copies collide with in play: a narrow column (trunk) or the model's bounds, per copy. */
const colliderBoxes = (placements: THREE.Matrix4[][], settings: ScatterSettings, models: (LayerModel | null)[]) => {
    const boxes: Array<{ half: [number, number, number]; position: [number, number, number]; rotation: [number, number, number] }> = [];
    placements.forEach((matrices, index) => {
        const layer = settings.layers[index];
        const model = models[index];
        if (!layer || layer.collision === 'none' || !model || model.bounds.isEmpty()) return;
        const size = model.bounds.getSize(new THREE.Vector3());
        const centre = model.bounds.getCenter(new THREE.Vector3());
        const across = layer.collision === 'trunk' ? 0.2 : 1;
        for (const matrix of matrices) {
            if (boxes.length >= MAX_COLLIDERS) return;
            matrix.decompose(_position, _quaternion, _scale);
            _world.set(layer.collision === 'trunk' ? 0 : centre.x, centre.y, layer.collision === 'trunk' ? 0 : centre.z).applyMatrix4(matrix);
            _euler.setFromQuaternion(_quaternion);
            boxes.push({
                half: [size.x * across * _scale.x / 2, size.y * _scale.y / 2, size.z * across * _scale.z / 2],
                position: [_world.x, _world.y, _world.z],
                rotation: [_euler.x, _euler.y, _euler.z],
            });
        }
    });
    return boxes;
};

/** What visible ground there is (terrains and meshes, not the scatter's own), as a key that changes when it does. */
const groundSignature = (scene: THREE.Object3D, own: THREE.Object3D | null): string => {
    let terrains = 0;
    let meshes = 0;
    const visit = (node: THREE.Object3D) => {
        if (!node.visible || node === own || node.userData?.ignorePlacement) return;
        if ((node as THREE.Mesh).isMesh) {
            if (node.userData?.isTerrain) terrains++;
            else meshes++;
        }
        for (const child of node.children) visit(child);
    };
    visit(scene);
    return `${terrains}:${meshes}`;
};

const ScatterRender: React.FC<ComponentRenderProps> = ({ object, component, mode }) => {
    const settings = useMemo(() => readScatterSettings(component.props), [component.props]);
    const { models } = useGameContent();
    const scene = useThree(state => state.scene);
    const gl = useThree(state => state.gl);
    const anchor = useRef<THREE.Group>(null);
    const [placements, setPlacements] = useState<THREE.Matrix4[][] | null>(null);

    const layerModels = useMemo((): (LayerModel | null)[] => settings.layers.map(layer => {
        const model = layer.modelId ? models.find(entry => entry.id === layer.modelId)?.object ?? null : null;
        if (!model) return null;
        const parts = splineModelParts(model);
        return { object: model, parts, bounds: splineModelBounds(parts) };
    }), [settings.layers, models]);

    // Placement: when it mounts, and whenever its settings or its object's transform change.
    const transform = `${object.position.join(',')}|${object.rotation.join(',')}|${object.scale.join(',')}`;
    useEffect(() => {
        const place = () => {
            const host = anchor.current?.parent;
            if (!host) return;
            host.updateWorldMatrix(true, false);
            const toWorld = host.matrixWorld.clone();
            const toLocal = toWorld.clone().invert();
            const normals = new THREE.Matrix3().getNormalMatrix(toLocal);
            // Only real ground: where there is no terrain or mesh, nothing grows.
            const query = createPlacementQuery(scene, [], { ignore: [host], groundPlane: false });
            const raycaster = new THREE.Raycaster();
            const top = settings.size[1] / 2;
            const ground = (x: number, z: number): ScatterGround | null => {
                _origin.set(x, top, z).applyMatrix4(toWorld);
                const bottom = _world.set(x, -top, z).applyMatrix4(toWorld);
                raycaster.set(_origin, _down);
                raycaster.far = Math.max(0.1, _origin.y - bottom.y);
                const hit = query(raycaster);
                if (!hit) return null;
                return { point: hit.point.clone().applyMatrix4(toLocal), normal: hit.normal.clone().applyMatrix3(normals).normalize(), worldY: hit.point.y };
            };
            setPlacements(generateScatter(settings, ground));
        };
        // The ground may arrive after the scatter (terrain and models loading, a level shown once ready):
        // while it settles, placement runs again whenever the visible ground changes.
        let placedOn = '';
        const check = () => {
            const ground = groundSignature(scene, anchor.current?.parent ?? null);
            if (ground === placedOn) return;
            placedOn = ground;
            place();
        };
        const first = setTimeout(check, PLACE_DELAY);
        const watch = setInterval(check, 1000);
        const stop = setTimeout(() => clearInterval(watch), SETTLE_TIME);
        return () => {
            clearTimeout(first);
            clearInterval(watch);
            clearTimeout(stop);
        };
    }, [settings, scene, transform]);

    const views = useMemo(() => {
        if (!placements) return [];
        return cellsOf(placements, settings.cellSize).map(cell => new CellView(cell, layerModels, settings.castShadow));
    }, [placements, settings.cellSize, settings.castShadow, layerModels]);
    useEffect(() => () => views.forEach(view => view.dispose()), [views]);

    // Each cell's tier by how far its nearest copy is from the camera.
    const since = useRef(Infinity);
    useFrame((state, delta) => {
        since.current += delta;
        if (since.current < TIER_INTERVAL || views.length === 0) return;
        since.current = 0;
        const host = anchor.current?.parent;
        if (!host) return;
        const camera = state.camera.getWorldPosition(_origin);
        const scale = Math.max(Math.abs(host.matrixWorld.elements[0]), Math.abs(host.matrixWorld.elements[10]), 1e-6);
        for (const view of views) {
            _world.copy(view.cell.centre).applyMatrix4(host.matrixWorld);
            const distance = Math.max(0, camera.distanceTo(_world) - view.cell.radius * scale);
            const tier = scatterTier(distance, settings, view.tier);
            if (tier === 'impostor') view.buildImpostors(gl);
            if (tier !== view.tier) view.show(tier);
            for (const mesh of view.far.children) updateImpostorLight((mesh as THREE.InstancedMesh).material as THREE.ShaderMaterial);
        }
    });

    const physics = usePhysicsAvailable();
    const boxes = useMemo(
        () => (mode === 'runtime' && placements ? colliderBoxes(placements, settings, layerModels) : []),
        [mode, placements, settings, layerModels],
    );
    const userData = useMemo(() => physicsUserData(object.id), [object.id]);

    return (
        <group ref={anchor} userData={SCATTER_USER_DATA}>
            {views.map((view, index) => (
                <group key={index}>
                    <primitive object={view.full} />
                    <primitive object={view.far} />
                </group>
            ))}
            {physics && boxes.length > 0 && (
                <RigidBody type="fixed" colliders={false} userData={userData}>
                    {boxes.map((box, index) => <CuboidCollider key={index} args={box.half} position={box.position} rotation={box.rotation} />)}
                </RigidBody>
            )}
        </group>
    );
};

export const SCATTER_COMPONENT: ComponentDefinition = {
    type: SCATTER_COMPONENT_TYPE,
    label: 'Procedural Scatter',
    description: 'Fills a box around the object with layers of models by rule: forests, rocks, grass, ruins. Each layer sets a density, '
        + 'a spacing, clumping, the slopes and heights it grows on, how much copies lean with the ground, their size, and whether '
        + 'they collide. Far away they are drawn as impostors, then not at all. The same seed gives the same placement.',
    props: [
        { key: 'size', label: 'Area (m)', type: 'vector3', default: [60, 40, 60] },
        { key: 'seed', label: 'Seed', type: 'number', default: 1, min: 0, max: 1e9, step: 1 },
        { key: 'cellSize', label: 'Cell size (m)', type: 'number', default: 24, min: 4, max: 1000, step: 1 },
        { key: 'impostorDistance', label: 'Impostors beyond (m)', type: 'number', default: 80, min: 0, max: 100000, step: 5 },
        { key: 'cullDistance', label: 'Hidden beyond (m)', type: 'number', default: 300, min: 0, max: 100000, step: 10 },
        { key: 'castShadow', label: 'Cast shadows', type: 'boolean', default: true },
    ],
    Render: ScatterRender,
};
