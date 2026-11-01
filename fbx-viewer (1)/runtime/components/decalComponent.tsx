import React, { useEffect, useLayoutEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import type { TextureData } from '../../types';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { useGameContent } from '../GameContentContext';
import type { ComponentDefinition, ComponentRenderProps } from './types';

type Vec3 = [number, number, number];

// --- SETTINGS ---

/** 'parent' projects onto the owning object's own model; 'scene' onto any mesh the box touches. */
export type DecalReceiverMode = 'parent' | 'scene';

const RECEIVER_MODES: readonly DecalReceiverMode[] = ['parent', 'scene'];

export interface DecalSettings {
    /** Texture asset id or name; empty (or unknown) draws the tint alone. */
    textureId: string;
    /** Projection box in metres: width (local X), height (local Y), depth (local Z). */
    size: Vec3;
    /** Where the box's centre is from the object's origin, in metres along its local axes: most props have their origin at their base. */
    offset: Vec3;
    /** 0..1, multiplied with the texture's own alpha. */
    opacity: number;
    /** Tint multiplied with the texture. */
    color: string;
    receivers: DecalReceiverMode;
}

export const DECAL_DEFAULTS: DecalSettings = { textureId: '', size: [1, 1, 3], offset: [0, 0, 0], opacity: 1, color: '#ffffff', receivers: 'parent' };

/** Smallest side of the projection box, in metres. */
export const MIN_DECAL_SIZE = 0.01;
/** Largest side of the projection box, in metres. */
export const MAX_DECAL_SIZE = 100;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const readSize = (value: unknown): Vec3 => {
    const valid = Array.isArray(value) && value.length === 3 && value.every(v => typeof v === 'number' && Number.isFinite(v));
    const [x, y, z] = valid ? value as Vec3 : DECAL_DEFAULTS.size;
    const side = (length: number) => clamp(Math.abs(length), MIN_DECAL_SIZE, MAX_DECAL_SIZE);
    return [side(x), side(y), side(z)];
};

const readOffset = (value: unknown): Vec3 => {
    const valid = Array.isArray(value) && value.length === 3 && value.every(v => typeof v === 'number' && Number.isFinite(v));
    const [x, y, z] = valid ? value as Vec3 : DECAL_DEFAULTS.offset;
    const axis = (length: number) => clamp(length, -MAX_DECAL_SIZE, MAX_DECAL_SIZE);
    return [axis(x), axis(y), axis(z)];
};

/**
 * Stored decal props to settings: missing or invalid values fall back to the defaults, box sides
 * are made positive and clamped to MIN_DECAL_SIZE..MAX_DECAL_SIZE, opacity to 0..1.
 */
export const resolveDecalSettings = (props: Record<string, unknown>): DecalSettings => {
    const { textureId, opacity, color, receivers } = props;
    return {
        textureId: typeof textureId === 'string' ? textureId.trim() : DECAL_DEFAULTS.textureId,
        size: readSize(props.size),
        offset: readOffset(props.offset),
        opacity: typeof opacity === 'number' && Number.isFinite(opacity) ? clamp(opacity, 0, 1) : DECAL_DEFAULTS.opacity,
        color: typeof color === 'string' && HEX_COLOR.test(color) ? color : DECAL_DEFAULTS.color,
        receivers: typeof receivers === 'string' && (RECEIVER_MODES as readonly string[]).includes(receivers)
            ? receivers as DecalReceiverMode
            : DECAL_DEFAULTS.receivers
    };
};

/** A texture asset by id, or by name so a hand-typed reference in the string field still resolves. */
export const findDecalTexture = (textures: readonly TextureData[], reference: string): TextureData | undefined =>
    reference ? textures.find(texture => texture.id === reference) ?? textures.find(texture => texture.name === reference) : undefined;

// --- RECEIVERS ---

type VertexAttribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

const attributeVersion = (attribute: VertexAttribute): number =>
    (attribute as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
        ? (attribute as THREE.InterleavedBufferAttribute).data.version
        : (attribute as THREE.BufferAttribute).version;

/**
 * Whether a material is a surface decals land on. Unlit (basic) and shader materials are the editor's
 * markers, previews, grid and sky; see-through, wireframe and non-depth-writing ones (other decals
 * among them) would leave the decal floating.
 */
const isReceiverMaterial = (material: THREE.Material): boolean =>
    material.visible
    && material.depthTest
    && material.depthWrite
    && !(material.transparent && material.opacity < 1)
    && !(material as THREE.MeshStandardMaterial).wireframe
    && !(material as THREE.MeshBasicMaterial).isMeshBasicMaterial
    && !(material as THREE.ShaderMaterial).isShaderMaterial;

/**
 * Whether `mesh` can take a decal: it has triangles and at least one receiving material. Skinned
 * meshes are skipped (the decal would not follow their bones), and so are batched meshes.
 */
export const canReceiveDecal = (mesh: THREE.Mesh): boolean => {
    if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh || (mesh as THREE.BatchedMesh).isBatchedMesh) return false;
    const position = mesh.geometry?.hasAttribute('position') ? mesh.geometry.getAttribute('position') : null;
    if (!position || position.count < 3) return false;
    const material = mesh.material;
    return Array.isArray(material) ? material.some(isReceiverMaterial) : Boolean(material) && isReceiverMaterial(material);
};

const boundsCache = new WeakMap<THREE.BufferGeometry, { version: number; box: THREE.Box3 }>();

/** Local bounds of a geometry's positions, recomputed when they change (three's cached boundingBox can be stale). */
const geometryBounds = (geometry: THREE.BufferGeometry): THREE.Box3 => {
    const position = geometry.getAttribute('position');
    const version = attributeVersion(position);
    const cached = boundsCache.get(geometry);
    if (cached && cached.version === version) return cached.box;
    // setFromBufferAttribute reads through getX/getY/getZ, so interleaved positions work too.
    const box = new THREE.Box3().setFromBufferAttribute(position as THREE.BufferAttribute);
    boundsCache.set(geometry, { version, box });
    return box;
};

/** One surface a decal can land on, as found by collectDecalReceivers. */
export interface DecalReceiver {
    /** The mesh that draws it; for a model part, the model's own (template) mesh. */
    mesh: THREE.Mesh;
    /** The instance of an instanced mesh, else -1. */
    instance: number;
    /** A model part placed at the owner: its matrix relative to the owner. Null for meshes in the scene. */
    placement: THREE.Matrix4 | null;
    geometry: THREE.BufferGeometry;
    /** Version of the geometry's positions when collected, so edits in place (sculpting) re-project. */
    version: number;
    /** Receiver space to world when collected. */
    matrixWorld: THREE.Matrix4;
    /** Identifies the surface and its vertex data. */
    key: string;
}

export interface DecalReceiverOptions {
    mode: DecalReceiverMode;
    /** The owner's level object id: in 'parent' mode, only meshes belonging to it receive. */
    objectId: string;
    /**
     * The owner's model, projected onto at the owner when the owner draws no mesh of its own (the
     * editor draws unselected props instanced, away from their component group).
     */
    model?: THREE.Object3D | null;
}

/** Instances whose matrix is this close to singular are collapsed (hidden) and never receive. */
const SINGULAR = 1e-12;

const _scanInverse = new THREE.Matrix4();
const _scanRelative = new THREE.Matrix4();
const _scanVolume = new THREE.Box3();
const _scanSphere = new THREE.Sphere();
const _scanCenter = new THREE.Vector3();
const _scanBounds = new THREE.Box3();
const _meshSphere = new THREE.Sphere();
const _instanceMatrix = new THREE.Matrix4();
const _candidate = new THREE.Matrix4();
const _placed = new THREE.Matrix4();

const sceneRoot = (node: THREE.Object3D): THREE.Object3D => {
    let root = node;
    while (root.parent) root = root.parent;
    return root;
};

/** Whether local `bounds`, carried to world by `matrixWorld`, reach into the projection box set up by collectDecalReceivers. */
const reachesVolume = (bounds: THREE.Box3, matrixWorld: THREE.Matrix4): boolean =>
    _scanBounds.copy(bounds).applyMatrix4(_scanRelative.multiplyMatrices(_scanInverse, matrixWorld)).intersectsBox(_scanVolume);

const geometryKey = (geometry: THREE.BufferGeometry, version: number) => `${geometry.uuid}:${version}`;

const addReceiver = (receivers: DecalReceiver[], mesh: THREE.Mesh, matrixWorld: THREE.Matrix4, placement: THREE.Matrix4 | null): void => {
    const geometry = mesh.geometry;
    const version = attributeVersion(geometry.getAttribute('position'));
    const bounds = geometryBounds(geometry);
    const instanced = mesh as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) {
        // The whole layer first: most instanced meshes are nowhere near the box.
        if (!instanced.boundingSphere) instanced.computeBoundingSphere();
        if (!instanced.boundingSphere || !_meshSphere.copy(instanced.boundingSphere).applyMatrix4(matrixWorld).intersectsSphere(_scanSphere)) return;
        for (let i = 0; i < instanced.count; i++) {
            instanced.getMatrixAt(i, _instanceMatrix);
            if (Math.abs(_instanceMatrix.determinant()) < SINGULAR) continue;
            _candidate.multiplyMatrices(matrixWorld, _instanceMatrix);
            if (!reachesVolume(bounds, _candidate)) continue;
            receivers.push({
                mesh, instance: i, placement: null, geometry, version,
                matrixWorld: _candidate.clone(), key: `${mesh.uuid}#${i}:${geometryKey(geometry, version)}`
            });
        }
        return;
    }
    if (!reachesVolume(bounds, matrixWorld)) return;
    receivers.push({
        mesh, instance: -1, placement: placement?.clone() ?? null, geometry, version, matrixWorld: matrixWorld.clone(),
        key: `${placement ? 'model:' : ''}${mesh.uuid}:${geometryKey(geometry, version)}`
    });
};

/**
 * Calls `visit` for every receiving mesh below `node` (not `node` itself), skipping hidden subtrees and
 * `skip`'s. `owner` is the level object the nodes belong to, taken from the nearest userData.levelObjectId.
 */
const forEachReceivingMesh = (
    node: THREE.Object3D,
    skip: THREE.Object3D,
    owner: string | null,
    visit: (mesh: THREE.Mesh, owner: string | null) => void
): void => {
    for (const child of node.children) {
        if (child === skip || !child.visible) continue;
        const tag = child.userData?.levelObjectId;
        const childOwner = typeof tag === 'string' ? tag : owner;
        if ((child as THREE.Mesh).isMesh && canReceiveDecal(child as THREE.Mesh)) visit(child as THREE.Mesh, childOwner);
        forEachReceivingMesh(child, skip, childOwner, visit);
    }
};

/**
 * Calls `visit` for every receiving mesh of a model template with its matrix relative to the model's
 * parent, the model root's own (import normalisation) transform included, as the level draws it.
 * The template's matrices are read, never updated.
 */
const forEachModelMesh = (root: THREE.Object3D, visit: (mesh: THREE.Mesh, placement: THREE.Matrix4) => void): void => {
    const walk = (node: THREE.Object3D, parent: THREE.Matrix4 | null) => {
        if (!node.visible) return;
        const local = node.matrixAutoUpdate ? new THREE.Matrix4().compose(node.position, node.quaternion, node.scale) : node.matrix.clone();
        const placement = parent ? local.premultiply(parent) : local;
        const mesh = node as THREE.Mesh;
        if (mesh.isMesh && !(mesh as THREE.InstancedMesh).isInstancedMesh && canReceiveDecal(mesh)) visit(mesh, placement);
        for (const child of node.children) walk(child, placement);
    };
    walk(root, null);
};

/**
 * The surfaces a decal mounted at `anchor` (a child of its owner's transform group) can land on, for
 * a projection box of `size` at the rigid world transform `projector`: those whose bounds reach into
 * the box. 'scene' takes every receiving mesh in the scene, each instance of an instanced mesh on its
 * own. 'parent' takes the owner's own meshes (not nested objects'); when the owner draws none, the
 * meshes tagged with its object id elsewhere (terrain), else its model placed at the owner.
 */
export const collectDecalReceivers = (
    anchor: THREE.Object3D,
    projector: THREE.Matrix4,
    size: Vec3,
    options: DecalReceiverOptions
): DecalReceiver[] => {
    const owner = anchor.parent;
    if (!owner) return [];
    _scanInverse.copy(projector).invert();
    _scanVolume.min.set(-size[0] / 2, -size[1] / 2, -size[2] / 2);
    _scanVolume.max.set(size[0] / 2, size[1] / 2, size[2] / 2);
    _scanSphere.set(_scanCenter.setFromMatrixPosition(projector), Math.hypot(size[0], size[1], size[2]) / 2);

    const receivers: DecalReceiver[] = [];
    const root = sceneRoot(owner);
    if (options.mode === 'scene') {
        forEachReceivingMesh(root, anchor, null, mesh => addReceiver(receivers, mesh, mesh.matrixWorld, null));
        return receivers;
    }

    const { objectId, model } = options;
    // Child matrices are only refreshed at render, after the owner may have moved this frame.
    owner.updateWorldMatrix(false, true);
    let drawn = false;
    forEachReceivingMesh(owner, anchor, objectId, (mesh, meshOwner) => {
        if (meshOwner !== objectId) return;
        drawn = true;
        addReceiver(receivers, mesh, mesh.matrixWorld, null);
    });
    if (!drawn && root !== owner) {
        forEachReceivingMesh(root, owner, null, (mesh, meshOwner) => {
            if (meshOwner !== objectId) return;
            drawn = true;
            addReceiver(receivers, mesh, mesh.matrixWorld, null);
        });
    }
    if (!drawn && model) {
        forEachModelMesh(model, (mesh, placement) => addReceiver(receivers, mesh, _placed.multiplyMatrices(owner.matrixWorld, placement), placement));
    }
    return receivers;
};

// --- GEOMETRY ---

/**
 * Cosine a surface must face back along the projection with (towards the projector's local +Z), so a
 * decal never smears along surfaces parallel to it or prints through onto back faces.
 */
const MIN_FACING = 0.1;

interface DecalSurface {
    positions: number[];
    normals: number[];
}

let projectedScratch = new Float32Array(0);

const _buildInverse = new THREE.Matrix4();
const _buildRelative = new THREE.Matrix4();
const _normalMatrix = new THREE.Matrix3();
const _axis = new THREE.Vector3();
const _half = new THREE.Vector3();
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _vc = new THREE.Vector3();
const _na = new THREE.Vector3();
const _nb = new THREE.Vector3();
const _nc = new THREE.Vector3();
const _edge = new THREE.Vector3();
const _face = new THREE.Vector3();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();
const _size = new THREE.Vector3();

/** Whether a triangle (indices into projector-space xyz triples) lies wholly beyond one side of the box on `axis`. */
const outsideSlab = (projected: Float32Array, a: number, b: number, c: number, axis: number, half: number): boolean => {
    const pa = projected[a * 3 + axis];
    const pb = projected[b * 3 + axis];
    const pc = projected[c * 3 + axis];
    return (pa > half && pb > half && pc > half) || (pa < -half && pb < -half && pc < -half);
};

const pushVertex = (surface: DecalSurface, position: THREE.Vector3, normal: THREE.Vector3) => {
    surface.positions.push(position.x, position.y, position.z);
    surface.normals.push(normal.x, normal.y, normal.z);
};

/**
 * Appends, in world space, the receiver's triangles that reach into the box and face the projector.
 * A mesh without normals gets its face normals. Mirrored receivers have their winding swapped so
 * front faces stay counter-clockwise in world space.
 */
const appendFacingTriangles = (geometry: THREE.BufferGeometry, matrixWorld: THREE.Matrix4, surface: DecalSurface): void => {
    const position = geometry.getAttribute('position');
    const normal = geometry.hasAttribute('normal') ? geometry.getAttribute('normal') : null;
    const index = geometry.index;
    const count = position.count;
    if (projectedScratch.length < count * 3) projectedScratch = new Float32Array(count * 3);
    const projected = projectedScratch;
    const m = _buildRelative.multiplyMatrices(_buildInverse, matrixWorld).elements;
    for (let i = 0; i < count; i++) {
        const x = position.getX(i);
        const y = position.getY(i);
        const z = position.getZ(i);
        const at = i * 3;
        projected[at] = m[0] * x + m[4] * y + m[8] * z + m[12];
        projected[at + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        projected[at + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }

    _normalMatrix.getNormalMatrix(matrixWorld);
    const mirrored = matrixWorld.determinant() < 0;
    const corners = index ? index.count : count;
    for (let t = 0; t + 2 < corners; t += 3) {
        const a = index ? index.getX(t) : t;
        const b = index ? index.getX(t + 1) : t + 1;
        const c = index ? index.getX(t + 2) : t + 2;
        if (outsideSlab(projected, a, b, c, 0, _half.x) || outsideSlab(projected, a, b, c, 1, _half.y)
            || outsideSlab(projected, a, b, c, 2, _half.z)) continue;

        _va.fromBufferAttribute(position, a).applyMatrix4(matrixWorld);
        _vb.fromBufferAttribute(position, b).applyMatrix4(matrixWorld);
        _vc.fromBufferAttribute(position, c).applyMatrix4(matrixWorld);
        if (normal) {
            _na.fromBufferAttribute(normal, a).applyNormalMatrix(_normalMatrix);
            _nb.fromBufferAttribute(normal, b).applyNormalMatrix(_normalMatrix);
            _nc.fromBufferAttribute(normal, c).applyNormalMatrix(_normalMatrix);
            _face.copy(_na).add(_nb).add(_nc).normalize();
        } else {
            // Counter-clockwise face normal (as THREE.Triangle computes it), flipped back for a mirrored receiver.
            _face.subVectors(_vc, _vb).cross(_edge.subVectors(_va, _vb)).normalize();
            if (mirrored) _face.negate();
            _na.copy(_face);
            _nb.copy(_face);
            _nc.copy(_face);
        }
        if (!(_face.dot(_axis) > MIN_FACING)) continue;

        pushVertex(surface, _va, _na);
        if (mirrored) {
            pushVertex(surface, _vc, _nc);
            pushVertex(surface, _vb, _nb);
        } else {
            pushVertex(surface, _vb, _nb);
            pushVertex(surface, _vc, _nc);
        }
    }
};

/** Reverses every triangle of a non-indexed geometry, keeping its attributes per vertex. */
const flipWinding = (geometry: THREE.BufferGeometry): void => {
    for (const name of ['position', 'normal', 'uv']) {
        if (!geometry.hasAttribute(name)) continue;
        const attribute = geometry.getAttribute(name) as THREE.BufferAttribute;
        const { array, itemSize } = attribute;
        for (let t = 0; t + 2 < attribute.count; t += 3) {
            const b = (t + 1) * itemSize;
            const c = (t + 2) * itemSize;
            for (let k = 0; k < itemSize; k++) {
                const swap = array[b + k];
                array[b + k] = array[c + k];
                array[c + k] = swap;
            }
        }
    }
};

/**
 * Projects a box of `size` at the rigid world transform `projector` onto `receivers` with THREE's
 * DecalGeometry and returns one geometry (position, normal, uv) in `toLocal` space, or world space
 * when it is null. The projection runs along the projector's local -Z: only triangles in the box that
 * face back towards +Z take part, and UVs span the box's width (U, local X) and height (V, local Y).
 * Returns null when nothing is hit.
 */
export const buildDecalGeometry = (
    receivers: readonly Pick<DecalReceiver, 'geometry' | 'matrixWorld'>[],
    projector: THREE.Matrix4,
    size: Vec3,
    toLocal: THREE.Matrix4 | null = null
): THREE.BufferGeometry | null => {
    _buildInverse.copy(projector).invert();
    _axis.setFromMatrixColumn(projector, 2).normalize();
    _half.set(size[0] / 2, size[1] / 2, size[2] / 2);
    const surface: DecalSurface = { positions: [], normals: [] };
    for (const receiver of receivers) appendFacingTriangles(receiver.geometry, receiver.matrixWorld, surface);
    if (surface.positions.length === 0) return null;

    const proxy = new THREE.BufferGeometry();
    proxy.setAttribute('position', new THREE.Float32BufferAttribute(surface.positions, 3));
    proxy.setAttribute('normal', new THREE.Float32BufferAttribute(surface.normals, 3));
    projector.decompose(_position, _quaternion, _scale);
    // The surface is already in world space, so its stand-in mesh keeps an identity world matrix.
    const geometry = new DecalGeometry(new THREE.Mesh(proxy), _position, _euler.setFromQuaternion(_quaternion), _size.set(size[0], size[1], size[2]));
    proxy.dispose();
    if (geometry.getAttribute('position').count === 0) {
        geometry.dispose();
        return null;
    }
    if (toLocal) {
        geometry.applyMatrix4(toLocal);
        // A mirrored owner flips the winding back when it draws the geometry; undo that here.
        if (toLocal.determinant() < 0) flipWinding(geometry);
    }
    geometry.computeBoundingSphere();
    return geometry;
};

// --- PROJECTOR ---

/** Receivers are re-scanned at least this often (in updates), so meshes that load, appear or move into the box are found. */
export const DECAL_RESCAN_FRAMES = 30;
/** Matrix elements this close (relative to their size) count as unchanged. */
const MATRIX_EPSILON = 1e-6;
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
const VOLUME_COLOR = '#e879f9';

/** Spreads the periodic re-scans of many decals over different frames. */
let nextRescanOffset = 0;

const sameMatrix = (a: THREE.Matrix4, b: THREE.Matrix4): boolean => {
    const x = a.elements;
    const y = b.elements;
    for (let i = 0; i < 16; i++) {
        if (Math.abs(x[i] - y[i]) > MATRIX_EPSILON * Math.max(1, Math.abs(x[i]))) return false;
    }
    return true;
};

/** What a decal projects with; DecalProjector.update re-projects when any of it changes. */
export interface DecalRequest extends DecalReceiverOptions {
    size: Vec3;
    /** From the owner's origin to the box's centre, along the owner's axes. */
    offset?: Vec3;
}

const sameRequest = (a: DecalRequest, b: DecalRequest): boolean =>
    a.mode === b.mode && a.objectId === b.objectId && (a.model ?? null) === (b.model ?? null)
    && a.size[0] === b.size[0] && a.size[1] === b.size[1] && a.size[2] === b.size[2]
    && (a.offset?.[0] ?? 0) === (b.offset?.[0] ?? 0) && (a.offset?.[1] ?? 0) === (b.offset?.[1] ?? 0) && (a.offset?.[2] ?? 0) === (b.offset?.[2] ?? 0);

interface BuiltDecal {
    request: DecalRequest;
    keys: string;
    /** Each receiver's matrix in projector space. */
    relatives: THREE.Matrix4[];
    /** The projector in the owner's space. */
    local: THREE.Matrix4;
}

/** Previews never take clicks or placement hits from the surfaces under them. */
const ignoreRaycast: THREE.Object3D['raycast'] = () => undefined;

/** Unit cube edges, plus a line from the centre to the far (-Z) face: the direction the decal projects in. */
const createVolumeGeometry = (): THREE.BufferGeometry => {
    const points: number[] = [];
    const corner = (i: number) => [(i & 1) - 0.5, ((i >> 1) & 1) - 0.5, ((i >> 2) & 1) - 0.5];
    for (let i = 0; i < 8; i++) {
        for (const bit of [1, 2, 4]) {
            if (!(i & bit)) points.push(...corner(i), ...corner(i | bit));
        }
    }
    points.push(0, 0, 0, 0, 0, -0.5);
    return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
};

const _hostPosition = new THREE.Vector3();
const _hostQuaternion = new THREE.Quaternion();
const _hostScale = new THREE.Vector3();
const _hostOffset = new THREE.Vector3();
const _volumeScale = new THREE.Matrix4();
const _trackInstance = new THREE.Matrix4();
const _trackWorld = new THREE.Matrix4();

/** Whether `node` and its ancestors are visible and attached under `scene`. */
const isDrawnIn = (node: THREE.Object3D, scene: THREE.Object3D): boolean => {
    let current: THREE.Object3D = node;
    while (current.parent) {
        if (!current.visible) return false;
        current = current.parent;
    }
    return current === scene;
};

/**
 * A decal's scene objects and projection state. `root` is mounted in the owner's transform group and
 * the decal geometry is kept in that group's space, so it rides along with the owner between
 * re-projections. The projection box is the owner's world position and rotation (its scale is
 * ignored: size is in metres).
 */
export class DecalProjector {
    /** Mounted in the owner's transform group. */
    readonly root = new THREE.Group();
    readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    /** Outline of the projection box, for the editor. */
    readonly volume: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
    private readonly empty = new THREE.BufferGeometry();
    private readonly projector = new THREE.Matrix4();
    private readonly toProjector = new THREE.Matrix4();
    private readonly toLocal = new THREE.Matrix4();
    private readonly localProjector = new THREE.Matrix4();
    private readonly scannedWorld = new THREE.Matrix4();
    private receivers: DecalReceiver[] = [];
    private built: BuiltDecal | null = null;
    private frame = nextRescanOffset++ % DECAL_RESCAN_FRAMES;
    private opacity = 1;

    constructor() {
        const material = new THREE.MeshStandardMaterial({
            transparent: true,
            depthWrite: false,
            // Pulled towards the camera in depth only, so the decal never z-fights the surface it lies on.
            polygonOffset: true,
            polygonOffsetFactor: -4,
            polygonOffsetUnits: -4
        });
        this.mesh = new THREE.Mesh(this.empty, material);
        this.mesh.visible = false;
        this.mesh.receiveShadow = true;
        this.mesh.raycast = ignoreRaycast;
        this.volume = new THREE.LineSegments(
            createVolumeGeometry(),
            new THREE.LineBasicMaterial({ color: VOLUME_COLOR, transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false })
        );
        this.volume.matrixAutoUpdate = false;
        this.volume.visible = false;
        this.volume.raycast = ignoreRaycast;
        this.root.add(this.mesh, this.volume);
        // The physics components' anchor flag: their scans of the owner's model (mesh colliders,
        // automatic hulls) skip this group, as they skip their own previews.
        this.root.userData = { auvraPhysicsAnchor: true };
    }

    /** Tint and opacity; an opacity of 0 hides the decal. */
    setAppearance(color: string, opacity: number): void {
        const material = this.mesh.material;
        material.color.set(color);
        material.opacity = opacity;
        this.opacity = opacity;
        this.refreshVisibility();
    }

    /** The decal's texture, or null for the tint alone. The caller owns (and disposes) it. */
    setTexture(map: THREE.Texture | null): void {
        const material = this.mesh.material;
        if (material.map === map) return;
        // Adding or removing a map changes the shader.
        if ((material.map === null) !== (map === null)) material.needsUpdate = true;
        material.map = map;
    }

    /** Shows the projection box outline (the editor does). */
    setVolumeVisible(visible: boolean): void {
        this.volume.visible = visible;
    }

    /**
     * Re-projects when the owner's transform, the request or a receiver changed since the last build,
     * with at most one build per call. Receivers are re-scanned when the owner moves or the request
     * changes, and every DECAL_RESCAN_FRAMES calls. Returns whether the decal geometry was replaced.
     */
    update(request: DecalRequest): boolean {
        if (!this.root.parent) return false;
        this.root.updateWorldMatrix(true, false);
        const world = this.root.matrixWorld;
        if (Math.abs(world.determinant()) < SINGULAR) {
            // A collapsed owner draws nothing; it re-projects once it has a size again.
            const changed = this.mesh.geometry !== this.empty;
            this.setGeometry(null);
            this.receivers = [];
            this.built = null;
            return changed;
        }

        const reconfigured = !this.built || !sameRequest(this.built.request, request);
        const moved = !sameMatrix(world, this.scannedWorld);
        this.frame = (this.frame + 1) % DECAL_RESCAN_FRAMES;
        if (!reconfigured && !moved && this.frame !== 0 && !this.receiversChanged()) return false;

        world.decompose(_hostPosition, _hostQuaternion, _hostScale);
        if (request.offset) _hostPosition.add(_hostOffset.fromArray(request.offset).applyQuaternion(_hostQuaternion));
        this.projector.compose(_hostPosition, _hostQuaternion, UNIT_SCALE);
        this.toProjector.copy(this.projector).invert();
        this.toLocal.copy(world).invert();
        this.localProjector.multiplyMatrices(this.toLocal, this.projector);
        this.scannedWorld.copy(world);
        this.volume.matrix.multiplyMatrices(this.localProjector, _volumeScale.makeScale(request.size[0], request.size[1], request.size[2]));
        this.volume.matrixWorldNeedsUpdate = true;

        this.receivers = collectDecalReceivers(this.root, this.projector, request.size, request);
        const keys = this.receivers.map(receiver => receiver.key).join('|');
        const relatives = this.receivers.map(receiver => new THREE.Matrix4().multiplyMatrices(this.toProjector, receiver.matrixWorld));
        const built = this.built;
        // Owner and receivers moving together (a decal on its own moving model) need no new geometry.
        if (built && !reconfigured && built.keys === keys && sameMatrix(this.localProjector, built.local)
            && relatives.every((relative, i) => sameMatrix(relative, built.relatives[i]))) return false;

        this.setGeometry(buildDecalGeometry(this.receivers, this.projector, request.size, this.toLocal));
        this.built = {
            request: { mode: request.mode, objectId: request.objectId, model: request.model ?? null, size: [...request.size], offset: request.offset ? [...request.offset] : undefined },
            keys,
            relatives,
            local: this.localProjector.clone()
        };
        return true;
    }

    /** Frees the decal and outline geometry and materials (not the texture, which the caller owns). */
    dispose(): void {
        if (this.mesh.geometry !== this.empty) this.mesh.geometry.dispose();
        this.empty.dispose();
        this.mesh.material.dispose();
        this.volume.geometry.dispose();
        this.volume.material.dispose();
        this.receivers = [];
        this.built = null;
    }

    /** Whether a receiver moved, changed its vertices, or stopped being drawn since it was collected. */
    private receiversChanged(): boolean {
        const scene = sceneRoot(this.root);
        for (const receiver of this.receivers) {
            const mesh = receiver.mesh;
            if (mesh.geometry !== receiver.geometry || attributeVersion(receiver.geometry.getAttribute('position')) !== receiver.version) return true;
            // A model part is placed at the owner, which has not moved.
            if (receiver.placement) continue;
            if (!isDrawnIn(mesh, scene)) return true;
            mesh.updateWorldMatrix(true, false);
            if (receiver.instance < 0) {
                if (!sameMatrix(mesh.matrixWorld, receiver.matrixWorld)) return true;
                continue;
            }
            const instanced = mesh as THREE.InstancedMesh;
            if (receiver.instance >= instanced.count) return true;
            instanced.getMatrixAt(receiver.instance, _trackInstance);
            if (!sameMatrix(_trackWorld.multiplyMatrices(mesh.matrixWorld, _trackInstance), receiver.matrixWorld)) return true;
        }
        return false;
    }

    private setGeometry(geometry: THREE.BufferGeometry | null): void {
        const previous = this.mesh.geometry;
        this.mesh.geometry = geometry ?? this.empty;
        if (previous !== this.empty && previous !== this.mesh.geometry) previous.dispose();
        this.refreshVisibility();
    }

    private refreshVisibility(): void {
        this.mesh.visible = this.mesh.geometry !== this.empty && this.opacity > 0;
    }
}

// --- RENDERING ---

const DecalRender: React.FC<ComponentRenderProps> = ({ object, component, mode }) => {
    const settings = useMemo(() => resolveDecalSettings(component.props), [component.props]);
    const { textures, models } = useGameContent();
    const url = findDecalTexture(textures, settings.textureId)?.url;
    const model = useMemo(
        () => (object.modelId ? models.find(entry => entry.id === object.modelId)?.object ?? null : null),
        [models, object.modelId]
    );
    const request = useMemo<DecalRequest>(
        () => ({ size: settings.size, offset: settings.offset, mode: settings.receivers, objectId: object.id, model }),
        [settings.size, settings.offset, settings.receivers, object.id, model]
    );

    const projector = useMemo(() => new DecalProjector(), []);
    useEffect(() => () => projector.dispose(), [projector]);
    useLayoutEffect(() => projector.setAppearance(settings.color, settings.opacity), [projector, settings.color, settings.opacity]);
    // No selection reaches component renders, so the editor always shows the (faint) box.
    useLayoutEffect(() => projector.setVolumeVisible(mode === 'editor'), [projector, mode]);

    useEffect(() => {
        if (!url) return;
        let current = true;
        let loaded: THREE.Texture | null = null;
        new THREE.TextureLoader().load(url, (texture) => {
            if (!current) {
                texture.dispose();
                return;
            }
            texture.colorSpace = THREE.SRGBColorSpace;
            loaded = texture;
            projector.setTexture(texture);
        }, undefined, (error) => {
            if (current) frontendDiagnostics.failure('decal_texture_load_failed', error);
        });
        return () => {
            current = false;
            if (!loaded) return;
            // Detached before it is freed, so no frame draws a disposed texture.
            projector.setTexture(null);
            loaded.dispose();
        };
    }, [projector, url]);

    useFrame(() => {
        projector.update(request);
    });

    return <primitive object={projector.root} />;
};

// --- DEFINITION ---

export const DECAL_COMPONENT: ComponentDefinition = {
    type: 'decal',
    label: 'Decal',
    description: 'Projects a texture along the object\'s local -Z (rotate the object to aim it) onto surfaces inside a box. '
        + 'Size is the box\'s width, height and depth in metres, whatever the object\'s scale, and Offset moves it from the object\'s origin. This Object projects onto the object\'s own model; '
        + 'Whole Scene onto any surface the box touches. Skinned (animated) meshes never receive decals.',
    props: [
        { key: 'textureId', label: 'Texture', type: 'texture', default: DECAL_DEFAULTS.textureId },
        { key: 'size', label: 'Size (W, H, Depth)', type: 'vector3', default: DECAL_DEFAULTS.size, min: MIN_DECAL_SIZE, max: MAX_DECAL_SIZE, step: 0.05 },
        { key: 'offset', label: 'Offset (X, Y, Z)', type: 'vector3', default: DECAL_DEFAULTS.offset, min: -MAX_DECAL_SIZE, max: MAX_DECAL_SIZE, step: 0.05 },
        { key: 'opacity', label: 'Opacity', type: 'number', default: DECAL_DEFAULTS.opacity, min: 0, max: 1, step: 0.05 },
        { key: 'color', label: 'Tint', type: 'color', default: DECAL_DEFAULTS.color },
        {
            key: 'receivers', label: 'Project Onto', type: 'select', default: DECAL_DEFAULTS.receivers,
            options: [
                { label: 'This Object', value: 'parent' },
                { label: 'Whole Scene', value: 'scene' }
            ]
        }
    ],
    Render: DecalRender
};
