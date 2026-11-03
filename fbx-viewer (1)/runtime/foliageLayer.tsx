import React, { useContext, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import type { LevelObject, LoadedModelData } from '../types';
import { MeshLodContext, useMeshLodReady } from '../components/Scene/useMeshLod';
import { chooseLodLevel, lodPixelsPerUnit, meshLodChain, type MeshLodLevel } from '../utils/meshLod';
import { FOLIAGE_INSTANCE_FLOATS, foliageInstanceMatrix, type FoliageType } from './foliage';
import { physicsUserData, usePhysicsAvailable } from './physicsQueries';
import { bakeImpostor, impostorMaterial, impostorQuad, scatterTier, updateImpostorLight, type Impostor, type ScatterTier } from './proceduralScatter';
import { splineModelBounds, splineModelParts, type SplineModelPart } from './splineMesh';
import { PHYSICS_IGNORED_USER_DATA } from './components/physicsComponents';

/**
 * FOLIAGE LAYER
 *
 * Draws a level's foliage set. A type's instances are cut into cells of the ground, each drawn as one
 * instanced mesh per part of the model: a cell near the camera draws the model at the detail its distance
 * calls for, a farther one flat pictures, and beyond that nothing. Painting changes a few cells, so only
 * those are rebuilt.
 */

const CELL_SIZE = 32;
/** Seconds between looks at how far each cell is. */
const TIER_INTERVAL = 0.25;
const MAX_COLLIDERS = 4000;

const FOLIAGE_USER_DATA = { ...PHYSICS_IGNORED_USER_DATA, ignorePlacement: true, staticLighting: true, foliageMesh: true };

const impostors = new WeakMap<THREE.Object3D, Impostor>();

const SELECTION_MATERIAL = new THREE.MeshBasicMaterial({
    color: '#3b82f6', wireframe: true, depthTest: false, depthWrite: false, transparent: true, opacity: 0.7, toneMapped: false,
});

const _matrix = new THREE.Matrix4();
const _camera = new THREE.Vector3();
const _world = new THREE.Vector3();
const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

interface FoliageModel {
    object: THREE.Object3D;
    parts: SplineModelPart[];
    bounds: THREE.Box3;
    /** Model-space radius, for how far a cell's edge reaches. */
    radius: number;
}

const foliageModelOf = (model: LoadedModelData | undefined): FoliageModel | null => {
    if (!model) return null;
    const parts = splineModelParts(model.object);
    if (parts.length === 0) return null;
    const bounds = splineModelBounds(parts);
    return { object: model.object, parts, bounds, radius: bounds.isEmpty() ? 1 : bounds.getBoundingSphere(new THREE.Sphere()).radius };
};

/** One cell of one type. */
class FoliageCell {
    readonly full = new THREE.Group();
    readonly far = new THREE.Group();
    tier: ScatterTier = 'full';
    private impostorsBuilt = false;
    private meshes: THREE.InstancedMesh[] = [];
    private chains: MeshLodLevel[][] | null = null;
    private level = 0;
    centre = new THREE.Vector3();
    radius = 0;
    /** The largest scale in it. */
    scale = 1;
    /** Each slot's instance floats, to tell whether a repaint changed the cell. */
    values: Float32Array;

    constructor(readonly key: string, private readonly model: FoliageModel, values: Float32Array, castShadow: boolean) {
        this.values = values;
        const count = Math.floor(values.length / FOLIAGE_INSTANCE_FLOATS);
        for (const part of model.parts) {
            const mesh = new THREE.InstancedMesh(part.geometry, part.material, count);
            for (let slot = 0; slot < count; slot++) mesh.setMatrixAt(slot, foliageInstanceMatrix(values, slot, _matrix));
            mesh.instanceMatrix.needsUpdate = true;
            mesh.computeBoundingSphere();
            mesh.castShadow = castShadow;
            mesh.receiveShadow = true;
            mesh.userData = FOLIAGE_USER_DATA;
            this.meshes.push(mesh);
            this.full.add(mesh);
        }
        this.far.visible = false;
        this.measure();
    }

    private measure(): void {
        const { values } = this;
        let lowest = Infinity;
        let highest = -Infinity;
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        let scale = 0;
        for (let at = 0; at < values.length; at += FOLIAGE_INSTANCE_FLOATS) {
            const x = values[at];
            const y = values[at + 1];
            const z = values[at + 2];
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < lowest) lowest = y;
            if (y > highest) highest = y;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
            scale = Math.max(scale, values[at + 7], values[at + 8], values[at + 9]);
        }
        this.centre.set((minX + maxX) / 2, (lowest + highest) / 2, (minZ + maxZ) / 2);
        this.radius = Math.hypot(maxX - minX, highest - lowest, maxZ - minZ) / 2 + this.model.radius * scale;
        this.scale = scale || 1;
    }

    setCastShadow(castShadow: boolean): void {
        for (const mesh of this.meshes) mesh.castShadow = castShadow;
    }

    /** Hides or moves one instance of a stroke or a gizmo drag, until the level has the result. */
    writeSlot(slot: number, matrix: THREE.Matrix4 | null): void {
        for (const mesh of this.meshes) {
            mesh.setMatrixAt(slot, matrix ?? ZERO_MATRIX);
            mesh.instanceMatrix.needsUpdate = true;
            mesh.boundingSphere = null;
        }
    }

    settleBounds(): void {
        for (const mesh of this.meshes) if (!mesh.boundingSphere) mesh.computeBoundingSphere();
    }

    private buildImpostors(renderer: THREE.WebGLRenderer): void {
        if (this.impostorsBuilt) return;
        this.impostorsBuilt = true;
        const { model, values } = this;
        let impostor = impostors.get(model.object);
        if (!impostor) {
            impostor = bakeImpostor(renderer, model.parts, model.bounds);
            impostors.set(model.object, impostor);
        }
        const count = Math.floor(values.length / FOLIAGE_INSTANCE_FLOATS);
        const mesh = new THREE.InstancedMesh(impostorQuad(), impostorMaterial(impostor), count);
        for (let slot = 0; slot < count; slot++) mesh.setMatrixAt(slot, foliageInstanceMatrix(values, slot, _matrix));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        // A card is a picture for the camera that made it. Anything that traces light wants what it stands in for.
        mesh.userData = { ...FOLIAGE_USER_DATA, standsInFor: model.parts };
        this.far.add(mesh);
    }

    update(type: FoliageType, renderer: THREE.WebGLRenderer, pixelsPerUnit: number, camera: THREE.Vector3, useLod: boolean): void {
        const distance = Math.max(0, camera.distanceTo(_world.copy(this.centre)) - this.radius);
        const tier = scatterTier(distance, type, this.tier);
        if (tier === 'impostor') this.buildImpostors(renderer);
        if (tier !== this.tier) {
            this.tier = tier;
            this.full.visible = tier === 'full';
            this.far.visible = tier === 'impostor';
        }
        for (const mesh of this.far.children) updateImpostorLight((mesh as THREE.InstancedMesh).material as THREE.ShaderMaterial);
        if (tier !== 'full' || !useLod) return;
        // The whole cell takes the detail its nearest instance needs: cheap to choose, and it never pops one tree at a time.
        this.chains ??= this.model.parts.map(part => meshLodChain(part.geometry));
        let level = 0;
        for (const chain of this.chains) level = Math.max(level, chooseLodLevel(chain, this.scale, distance, pixelsPerUnit));
        if (level === this.level) return;
        this.level = level;
        this.chains.forEach((chain, index) => {
            this.meshes[index].geometry = chain[Math.min(level, chain.length - 1)].geometry;
        });
    }

    dispose(): void {
        // Geometry and materials of the full batches are the model's; only instance buffers are ours.
        for (const mesh of this.meshes) mesh.dispose();
        for (const mesh of this.far.children as THREE.InstancedMesh[]) {
            mesh.geometry.dispose();
            (mesh.material as THREE.Material).dispose();
            mesh.dispose();
        }
    }
}

/** All the cells of one type, and what a tool needs to change them as it works. */
export class FoliageTypeView {
    readonly group = new THREE.Group();
    private cells = new Map<string, FoliageCell>();
    /** Each instance's cell and its slot in the cell. */
    private cellOf: FoliageCell[] = [];
    private slotOf = new Int32Array(0);
    private instances: Float32Array | undefined;
    private pending: THREE.InstancedMesh[] = [];
    private pendingCount = 0;
    private selection: THREE.InstancedMesh[] = [];

    constructor(private readonly model: FoliageModel, private type: FoliageType) {
        this.group.userData = FOLIAGE_USER_DATA;
    }

    get footprint(): number {
        const size = this.model.bounds.getSize(new THREE.Vector3());
        return Math.max(size.x, size.z);
    }

    get modelRadius(): number {
        return this.model.radius;
    }

    get modelBounds(): THREE.Box3 {
        return this.model.bounds;
    }

    get parts(): SplineModelPart[] {
        return this.model.parts;
    }

    setType(type: FoliageType): void {
        if (type.castShadow !== this.type.castShadow) {
            for (const cell of this.cells.values()) cell.setCastShadow(type.castShadow);
        }
        this.type = type;
        this.setInstances(type.instances);
    }

    /** Shows these instances; cells whose instances did not change are kept. */
    setInstances(instances: Float32Array | undefined): void {
        if (instances === this.instances) return;
        this.instances = instances;
        this.clearPending();
        const count = instances ? Math.floor(instances.length / FOLIAGE_INSTANCE_FLOATS) : 0;
        const counts = new Map<string, number>();
        const keyOf = (x: number, z: number) => `${Math.floor(x / CELL_SIZE)}:${Math.floor(z / CELL_SIZE)}`;
        const keys = new Array<string>(count);
        for (let index = 0; index < count; index++) {
            const at = index * FOLIAGE_INSTANCE_FLOATS;
            const key = keyOf(instances![at], instances![at + 2]);
            keys[index] = key;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const values = new Map<string, Float32Array>();
        for (const [key, total] of counts) values.set(key, new Float32Array(total * FOLIAGE_INSTANCE_FLOATS));
        const filled = new Map<string, number>();
        this.slotOf = new Int32Array(count);
        for (let index = 0; index < count; index++) {
            const key = keys[index];
            const slot = filled.get(key) ?? 0;
            filled.set(key, slot + 1);
            this.slotOf[index] = slot;
            const at = index * FOLIAGE_INSTANCE_FLOATS;
            values.get(key)!.set(instances!.subarray(at, at + FOLIAGE_INSTANCE_FLOATS), slot * FOLIAGE_INSTANCE_FLOATS);
        }
        const next = new Map<string, FoliageCell>();
        for (const [key, cellValues] of values) {
            const existing = this.cells.get(key);
            if (existing && sameValues(existing.values, cellValues)) {
                next.set(key, existing);
                this.cells.delete(key);
            } else {
                const cell = new FoliageCell(key, this.model, cellValues, this.type.castShadow);
                next.set(key, cell);
                this.group.add(cell.full, cell.far);
            }
        }
        for (const cell of this.cells.values()) {
            this.group.remove(cell.full, cell.far);
            cell.dispose();
        }
        this.cells = next;
        this.cellOf = keys.map(key => next.get(key)!);
    }

    /** Draws instances a stroke has placed, until the level has them. */
    addPending(instance: ArrayLike<number>): void {
        const capacity = this.pending[0]?.instanceMatrix.count ?? 0;
        if (this.pendingCount >= capacity) {
            const size = Math.max(256, capacity * 2);
            const grown = this.model.parts.map((part, index) => {
                const mesh = new THREE.InstancedMesh(part.geometry, part.material, size);
                mesh.castShadow = this.type.castShadow;
                mesh.receiveShadow = true;
                mesh.frustumCulled = false;
                mesh.userData = FOLIAGE_USER_DATA;
                const old = this.pending[index];
                if (old) {
                    (mesh.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array.subarray(0, this.pendingCount * 16));
                }
                return mesh;
            });
            for (const mesh of this.pending) {
                this.group.remove(mesh);
                mesh.dispose();
            }
            this.pending = grown;
            for (const mesh of grown) this.group.add(mesh);
        }
        foliageInstanceMatrix(instance as Float32Array, 0, _matrix);
        for (const mesh of this.pending) {
            mesh.setMatrixAt(this.pendingCount, _matrix);
            mesh.count = this.pendingCount + 1;
            mesh.instanceMatrix.needsUpdate = true;
        }
        this.pendingCount++;
    }

    clearPending(): void {
        for (const mesh of this.pending) {
            this.group.remove(mesh);
            mesh.dispose();
        }
        this.pending = [];
        this.pendingCount = 0;
    }

    /** Hides instance `index` until the level has the result. */
    hide(index: number): void {
        this.cellOf[index]?.writeSlot(this.slotOf[index], null);
    }

    /** Draws instance `index` at this matrix until the level has the result. */
    move(index: number, matrix: THREE.Matrix4): void {
        this.cellOf[index]?.writeSlot(this.slotOf[index], matrix);
    }

    settle(): void {
        for (const cell of this.cells.values()) cell.settleBounds();
    }

    /** Outlines these instances. */
    showSelection(instances: Float32Array | undefined, selected: ReadonlySet<number>): void {
        for (const mesh of this.selection) {
            this.group.remove(mesh);
            mesh.dispose();
        }
        this.selection = [];
        if (!instances || selected.size === 0) return;
        const shown = Math.min(selected.size, 4096);
        for (const part of this.model.parts) {
            const mesh = new THREE.InstancedMesh(part.geometry, SELECTION_MATERIAL, shown);
            let slot = 0;
            for (const index of selected) {
                if (slot >= shown) break;
                mesh.setMatrixAt(slot++, foliageInstanceMatrix(instances, index, _matrix));
            }
            mesh.frustumCulled = false;
            mesh.renderOrder = 1;
            mesh.userData = FOLIAGE_USER_DATA;
            mesh.raycast = () => undefined;
            this.selection.push(mesh);
            this.group.add(mesh);
        }
    }

    moveSelectionOutline(slot: number, matrix: THREE.Matrix4): void {
        for (const mesh of this.selection) {
            if (slot < mesh.count) {
                mesh.setMatrixAt(slot, matrix);
                mesh.instanceMatrix.needsUpdate = true;
            }
        }
    }

    update(renderer: THREE.WebGLRenderer, camera: THREE.Vector3, pixelsPerUnit: number, useLod: boolean): void {
        for (const cell of this.cells.values()) cell.update(this.type, renderer, pixelsPerUnit, camera, useLod);
    }

    dispose(): void {
        for (const cell of this.cells.values()) cell.dispose();
        this.clearPending();
        for (const mesh of this.selection) mesh.dispose();
        this.cells.clear();
    }
}

const sameValues = (a: Float32Array, b: Float32Array): boolean => {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) {
        if (a[index] !== b[index]) return false;
    }
    return true;
};

/** The views of a set as drawn, for the editor's tools (group.userData.foliageViews). */
export type FoliageViews = Map<string, FoliageTypeView>;

/** The boxes a type's instances collide with in play: a narrow column (trunk) or the model's bounds, per instance. */
const colliderBoxes = (types: readonly FoliageType[], models: ReadonlyMap<string, FoliageModel>) => {
    const boxes: Array<{ half: [number, number, number]; position: [number, number, number]; rotation: [number, number, number] }> = [];
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const offset = new THREE.Vector3();
    for (const type of types) {
        const model = models.get(type.id);
        const instances = type.instances;
        if (type.collision === 'none' || !model || !instances || model.bounds.isEmpty()) continue;
        const size = model.bounds.getSize(new THREE.Vector3());
        const centre = model.bounds.getCenter(new THREE.Vector3());
        const across = type.collision === 'trunk' ? 0.2 : 1;
        for (let at = 0; at < instances.length && boxes.length < MAX_COLLIDERS; at += FOLIAGE_INSTANCE_FLOATS) {
            quaternion.set(instances[at + 3], instances[at + 4], instances[at + 5], instances[at + 6]);
            euler.setFromQuaternion(quaternion);
            const sx = instances[at + 7];
            const sy = instances[at + 8];
            const sz = instances[at + 9];
            offset.set(type.collision === 'trunk' ? 0 : centre.x * sx, centre.y * sy, type.collision === 'trunk' ? 0 : centre.z * sz).applyQuaternion(quaternion);
            boxes.push({
                half: [(size.x * across * sx) / 2, (size.y * sy) / 2, (size.z * across * sz) / 2],
                position: [instances[at] + offset.x, instances[at + 1] + offset.y, instances[at + 2] + offset.z],
                rotation: [euler.x, euler.y, euler.z],
            });
        }
    }
    return boxes;
};

interface FoliageLayerProps {
    set: LevelObject;
    models: LoadedModelData[];
    /** In play instances collide, as their types ask. */
    runtime?: boolean;
}

/** A level's foliage set, drawn. */
export const FoliageLayer: React.FC<FoliageLayerProps> = ({ set, models, runtime = false }) => {
    const types = set.foliageData?.types;
    const gl = useThree(state => state.gl);
    const lodReady = useMeshLodReady();
    const lodAllowed = useContext(MeshLodContext);
    const group = useMemo(() => new THREE.Group(), []);
    const views = useRef<FoliageViews>(new Map());

    const foliageModels = useMemo(() => {
        const found = new Map<string, FoliageModel>();
        for (const type of types ?? []) {
            const model = foliageModelOf(models.find(entry => entry.id === type.modelId));
            if (model) found.set(type.id, model);
        }
        return found;
    }, [types, models]);

    // A type keeps its view while it keeps its model; its settings and instances are handed on.
    useEffect(() => {
        const current = views.current;
        const wanted = new Set<string>();
        for (const type of types ?? []) {
            const model = foliageModels.get(type.id);
            if (!model) continue;
            wanted.add(type.id);
            let view = current.get(type.id);
            if (view && view.parts !== model.parts) {
                group.remove(view.group);
                view.dispose();
                view = undefined;
            }
            if (!view) {
                view = new FoliageTypeView(model, type);
                current.set(type.id, view);
                group.add(view.group);
            }
            view.setType(type);
        }
        for (const [id, view] of current) {
            if (wanted.has(id)) continue;
            group.remove(view.group);
            view.dispose();
            current.delete(id);
        }
    }, [types, foliageModels, group]);
    useEffect(() => () => {
        for (const view of views.current.values()) view.dispose();
        views.current.clear();
    }, []);

    const since = useRef(Infinity);
    useFrame(({ camera, size }, delta) => {
        since.current += delta;
        if (since.current < TIER_INTERVAL) return;
        since.current = 0;
        camera.getWorldPosition(_camera);
        const pixelsPerUnit = lodPixelsPerUnit(camera, size.height);
        for (const view of views.current.values()) view.update(gl, _camera, pixelsPerUnit, lodReady && lodAllowed);
    });

    const physics = usePhysicsAvailable();
    const boxes = useMemo(() => (runtime && types ? colliderBoxes(types, foliageModels) : []), [runtime, types, foliageModels]);
    const userData = useMemo(() => physicsUserData(set.id), [set.id]);
    const groupData = useMemo(() => ({ ...FOLIAGE_USER_DATA, levelObjectId: set.id, foliageViews: views.current }), [set.id]);

    return (
        <>
            <primitive object={group} userData={groupData} />
            {physics && boxes.length > 0 && (
                <RigidBody type="fixed" colliders={false} userData={userData}>
                    {boxes.map((box, index) => <CuboidCollider key={index} args={box.half} position={box.position} rotation={box.rotation} />)}
                </RigidBody>
            )}
        </>
    );
};
