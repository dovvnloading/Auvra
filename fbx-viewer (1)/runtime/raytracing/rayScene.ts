import * as THREE from 'three';
import { BOUNDS_FLOATS, NODE_FLOATS, buildBvh, refitBvh, type Bvh } from './bvh';

/**
 * THE RAY SCENE
 *
 * What rays see of a level, kept in textures a fragment shader can walk (traceShader.ts). A tree over the
 * triangles of each distinct geometry, made once however many objects share it, and one tree over the
 * instances placing them in the world, refitted as they move. So a moved crate costs a matrix, and a
 * thousand crates cost one tree.
 *
 * Skinned characters enter as a box around their bones: rays do not need their fingers, and rebuilding a tree
 * over a posed mesh every frame would cost more than all the rest.
 *
 * Tables, RGBA float, RAY_TEXTURE_WIDTH texels wide:
 *   triangles  3 texels: first vertex and material slot; the two edges from it
 *   meshNodes  2 texels: see bvh.ts
 *   sceneNodes 2 texels: see bvh.ts; a leaf holds the instance's index
 *   instances  4 texels: the world-to-object matrix's three rows; mesh root node, first material, flags
 *   materials  2 texels: albedo and flags; emitted light
 */

export const RAY_TEXTURE_WIDTH = 2048;
export const RAY_TEXTURE_SHIFT = 11;

const TRIANGLE_FLOATS = 12;
const INSTANCE_FLOATS = 16;
const MATERIAL_FLOATS = 8;
const TRIANGLE_VERTEX_FLOATS = 9;

/** A material drawn without lighting: what it shows is what it gives off. */
export const MATERIAL_UNLIT = 1;
/** A material drawn from both sides, so a ray meeting its back has not gone inside anything. */
export const MATERIAL_TWO_SIDED = 2;
/** An instance that rays meeting from behind pass through: a character's box, which probes may stand inside. */
export const INSTANCE_ONE_WAY = 1;
/** An instance that casts no shadow when drawn, and blocks no shadow ray. */
export const INSTANCE_NO_SHADOW = 2;

/** A mesh of more triangles than this is simplified first: bounced light does not need them. */
const MAX_MESH_TRIANGLES = 48000;
/** Terrain cells along a side, at most: a coarser grid carries the same bounce. */
const MAX_TERRAIN_CELLS = 96;
const MAX_INSTANCES = 65536;
/** Refits loosen a tree: it is built again this often while something keeps moving. */
const REBUILD_AFTER_MOVES = 240;
/** Frames between looks through the scene for what was added or removed. */
const SCAN_INTERVAL = 15;
/** Frames an unused mesh tree stays, in case the view that used it comes straight back. */
const MESH_GRACE = 300;
/** Pool share that must be dead before it is worth moving everything else down. */
const COMPACT_SHARE = 0.5;

/** A table of floats and the texture that shows it to shaders. */
class FloatTable {
    data: Float32Array;
    readonly texture: THREE.DataTexture;
    private dirty = true;

    constructor(name: string, private readonly floatsPerRecord: number) {
        this.data = new Float32Array(RAY_TEXTURE_WIDTH * 4);
        this.texture = new THREE.DataTexture(this.data, RAY_TEXTURE_WIDTH, 1, THREE.RGBAFormat, THREE.FloatType);
        this.texture.name = name;
        this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
        this.texture.generateMipmaps = false;
        this.texture.unpackAlignment = 1;
        this.texture.needsUpdate = true;
    }

    /** Room for `records`, keeping what is held. */
    reserve(records: number): void {
        const floats = records * this.floatsPerRecord;
        if (floats <= this.data.length) return;
        const rows = Math.ceil(floats / (RAY_TEXTURE_WIDTH * 4));
        const height = Math.min(16384, 2 ** Math.ceil(Math.log2(Math.max(rows, 1))));
        const data = new Float32Array(height * RAY_TEXTURE_WIDTH * 4);
        data.set(this.data);
        this.data = data;
        // A new size needs new storage: dispose frees it, and the next draw allocates afresh.
        this.texture.dispose();
        this.texture.image = { data, width: RAY_TEXTURE_WIDTH, height };
        this.dirty = true;
    }

    touch(): void {
        this.dirty = true;
    }

    /** Shows what changed to shaders; the upload happens when one next reads it. */
    flush(): void {
        if (!this.dirty) return;
        this.dirty = false;
        this.texture.needsUpdate = true;
    }

    dispose(): void {
        this.texture.dispose();
    }
}

/** Triangles from a mesh: three vertices each, and the material slot each draws with. */
export interface MeshTriangles {
    positions: Float32Array;
    slots: Uint16Array;
    count: number;
}

const readVertex = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, index: number, out: Float32Array, at: number): void => {
    out[at] = attribute.getX(index);
    out[at + 1] = attribute.getY(index);
    out[at + 2] = attribute.getZ(index);
};

/**
 * The triangles of `geometry`, optionally through `indices` in place of its own. Groups give each its material
 * slot; a mesh of one material, whatever its groups say, draws everything with slot 0.
 */
export const geometryTriangles = (geometry: THREE.BufferGeometry, slotted: boolean, indices?: ArrayLike<number>): MeshTriangles | null => {
    const position = geometry.getAttribute('position');
    if (!position) return null;
    const index = indices ?? geometry.index?.array;
    const vertices = index ? index.length : position.count;
    const count = Math.floor(vertices / 3);
    if (!count) return null;
    const positions = new Float32Array(count * TRIANGLE_VERTEX_FLOATS);
    const slots = new Uint16Array(count);
    for (let triangle = 0; triangle < count; triangle++) {
        const at = triangle * 3;
        readVertex(position, index ? index[at] : at, positions, triangle * TRIANGLE_VERTEX_FLOATS);
        readVertex(position, index ? index[at + 1] : at + 1, positions, triangle * TRIANGLE_VERTEX_FLOATS + 3);
        readVertex(position, index ? index[at + 2] : at + 2, positions, triangle * TRIANGLE_VERTEX_FLOATS + 6);
    }
    if (slotted && !indices) {
        for (const group of geometry.groups) {
            const first = Math.floor(group.start / 3);
            const last = Math.min(count, Math.floor((group.start + group.count) / 3));
            slots.fill(group.materialIndex ?? 0, first, last);
        }
    }
    return { positions, slots, count };
};

/**
 * Fewer triangles by merging vertices that share a cell of a grid over the mesh, dropping what collapses. Crude
 * next to what the eye would need, and quite enough for what light bounces off.
 */
export const simplifyTriangles = (mesh: MeshTriangles, target: number): MeshTriangles => {
    if (mesh.count <= target) return mesh;
    const { positions } = mesh;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let at = 0; at < mesh.count * TRIANGLE_VERTEX_FLOATS; at += 3) {
        minX = Math.min(minX, positions[at]);
        minY = Math.min(minY, positions[at + 1]);
        minZ = Math.min(minZ, positions[at + 2]);
        maxX = Math.max(maxX, positions[at]);
        maxY = Math.max(maxY, positions[at + 1]);
        maxZ = Math.max(maxZ, positions[at + 2]);
    }
    const spanX = Math.max(maxX - minX, 1e-6), spanY = Math.max(maxY - minY, 1e-6), spanZ = Math.max(maxZ - minZ, 1e-6);
    // A surface of n triangles has about n / 2 vertices, and crosses about a square of the cells along each side.
    let side = Math.ceil(Math.sqrt(target / 2));
    for (let attempt = 0; ; attempt++) {
        const size = Math.max(spanX, spanY, spanZ) / side;
        const cellOf = (at: number): number => {
            const x = Math.floor((positions[at] - minX) / size);
            const y = Math.floor((positions[at + 1] - minY) / size);
            const z = Math.floor((positions[at + 2] - minZ) / size);
            return x + (side + 1) * (y + (side + 1) * z);
        };
        const merged = new Map<number, { x: number; y: number; z: number; n: number }>();
        const cells = new Float64Array(mesh.count * 3);
        for (let vertex = 0; vertex < mesh.count * 3; vertex++) {
            const at = vertex * 3;
            const cell = cellOf(at);
            cells[vertex] = cell;
            const sum = merged.get(cell);
            if (sum) {
                sum.x += positions[at];
                sum.y += positions[at + 1];
                sum.z += positions[at + 2];
                sum.n++;
            } else {
                merged.set(cell, { x: positions[at], y: positions[at + 1], z: positions[at + 2], n: 1 });
            }
        }
        const kept: number[] = [];
        for (let triangle = 0; triangle < mesh.count; triangle++) {
            const a = cells[triangle * 3], b = cells[triangle * 3 + 1], c = cells[triangle * 3 + 2];
            if (a !== b && b !== c && a !== c) kept.push(triangle);
        }
        if (kept.length > target && attempt < 6) {
            side = Math.max(2, Math.floor(side * 0.75));
            continue;
        }
        const out: MeshTriangles = { positions: new Float32Array(kept.length * TRIANGLE_VERTEX_FLOATS), slots: new Uint16Array(kept.length), count: kept.length };
        kept.forEach((triangle, index) => {
            out.slots[index] = mesh.slots[triangle];
            for (let corner = 0; corner < 3; corner++) {
                const sum = merged.get(cells[triangle * 3 + corner])!;
                const to = index * TRIANGLE_VERTEX_FLOATS + corner * 3;
                out.positions[to] = sum.x / sum.n;
                out.positions[to + 1] = sum.y / sum.n;
                out.positions[to + 2] = sum.z / sum.n;
            }
        });
        return out;
    }
};

/** Only the triangles of the slots in `seen`: a window in the same mesh as its wall must not stop light. */
export const keepSlots = (mesh: MeshTriangles, seen: readonly boolean[]): MeshTriangles => {
    const kept: number[] = [];
    for (let triangle = 0; triangle < mesh.count; triangle++) {
        if (seen[mesh.slots[triangle]] !== false) kept.push(triangle);
    }
    if (kept.length === mesh.count) return mesh;
    const out: MeshTriangles = { positions: new Float32Array(kept.length * TRIANGLE_VERTEX_FLOATS), slots: new Uint16Array(kept.length), count: kept.length };
    kept.forEach((triangle, index) => {
        out.slots[index] = mesh.slots[triangle];
        out.positions.set(mesh.positions.subarray(triangle * TRIANGLE_VERTEX_FLOATS, (triangle + 1) * TRIANGLE_VERTEX_FLOATS), index * TRIANGLE_VERTEX_FLOATS);
    });
    return out;
};

/** A plane's vertices (w + 1 by h + 1), indexed every `stride` cells along each side. */
export const coarseGridIndices = (widthSegments: number, heightSegments: number, stride: number): Uint32Array => {
    const columns = Math.ceil(widthSegments / stride);
    const rows = Math.ceil(heightSegments / stride);
    const indices = new Uint32Array(columns * rows * 6);
    const at = (x: number, y: number) => Math.min(y * stride, heightSegments) * (widthSegments + 1) + Math.min(x * stride, widthSegments);
    let to = 0;
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < columns; x++) {
            const a = at(x, y), b = at(x, y + 1), c = at(x + 1, y + 1), d = at(x + 1, y);
            indices[to++] = a;
            indices[to++] = b;
            indices[to++] = d;
            indices[to++] = b;
            indices[to++] = c;
            indices[to++] = d;
        }
    }
    return indices;
};

interface MeshTree {
    key: string;
    root: number;
    nodeCount: number;
    firstTriangle: number;
    triangleCount: number;
    /** Box around the mesh, in its own space: min x, y, z, max x, y, z. */
    bounds: Float32Array;
    /** Objects using it now, and the frame the last of them went. */
    users: number;
    idleSince: number;
}

interface Tracked {
    node: THREE.Mesh;
    tree: MeshTree;
    firstMaterial: number;
    materialKey: string;
    /** Instances of it, from `first` in the table. */
    first: number;
    count: number;
    flags: number;
    seen: number;
    /** What its instances were last placed by: as exact as the matrix itself, or an unmoved object would look moved. */
    matrix: Float64Array;
    instanceVersion: number;
    /** The last frame it asked for a tree of a new shape. */
    asked: number;
    bones?: THREE.Bone[];
}

/** What a material gives rays: all linear, as drawn. */
export interface RayMaterial {
    albedo: [number, number, number];
    emissive: [number, number, number];
    flags: number;
}

const LIT_KEYS = ['isMeshStandardMaterial', 'isMeshLambertMaterial', 'isMeshPhongMaterial', 'isMeshToonMaterial'] as const;

const isLit = (material: THREE.Material): boolean => LIT_KEYS.some(key => (material as unknown as Record<string, unknown>)[key] === true);

/** Whether rays can meet a material at all: not glass, wireframes, or what draws nothing. */
export const raysSeeMaterial = (material: THREE.Material): boolean => {
    if (!material.visible || !material.colorWrite) return false;
    const look = material as THREE.MeshStandardMaterial & THREE.MeshPhysicalMaterial;
    if (look.wireframe) return false;
    if (material.transparent && material.opacity < 0.5) return false;
    if (look.transmission > 0) return false;
    return isLit(material) || (material as THREE.MeshBasicMaterial).isMeshBasicMaterial === true;
};

/** The average of a texture, for a surface that shows it: filled in by whoever can read the GPU. */
export type TextureMean = (texture: THREE.Texture) => [number, number, number];

const WHITE: [number, number, number] = [1, 1, 1];

export const rayMaterialFor = (material: THREE.Material, mean: TextureMean): RayMaterial => {
    const look = material as THREE.MeshStandardMaterial;
    const color = look.color ?? new THREE.Color(1, 1, 1);
    const map = look.map ? mean(look.map) : WHITE;
    // A solid surface drawn from both sides (terrain) still has an inside: what is under the ground stays there.
    const twoSided = material.side === THREE.DoubleSide && material.userData?.raySolid !== true;
    const flags = (isLit(material) ? 0 : MATERIAL_UNLIT) | (twoSided ? MATERIAL_TWO_SIDED : 0);
    const override = material.userData?.rayAlbedo as THREE.Color | undefined;
    const layers = material.userData?.rayAlbedoMaps as readonly THREE.Texture[] | undefined;
    let albedo: [number, number, number] = override
        ? [override.r, override.g, override.b]
        : [color.r * map[0], color.g * map[1], color.b * map[2]];
    if (layers?.length) {
        albedo = [0, 0, 0];
        for (const layer of layers) {
            const average = mean(layer);
            albedo[0] += average[0] / layers.length;
            albedo[1] += average[1] / layers.length;
            albedo[2] += average[2] / layers.length;
        }
    }
    let emissive: [number, number, number] = [0, 0, 0];
    if (look.emissive && look.emissiveIntensity > 0) {
        const glow = look.emissiveMap ? mean(look.emissiveMap) : WHITE;
        emissive = [look.emissive.r * look.emissiveIntensity * glow[0], look.emissive.g * look.emissiveIntensity * glow[1], look.emissive.b * look.emissiveIntensity * glow[2]];
    }
    return { albedo, emissive, flags };
};

/** The geometry a mesh tree was built from. */
const geometryOfKey = (key: string): string => key.slice(0, key.indexOf(':'));

const _box = new THREE.Box3();
const _matrix = new THREE.Matrix4();
const _inverse = new THREE.Matrix4();
const _instance = new THREE.Matrix4();
const _point = new THREE.Vector3();

/** Writes the box around `bounds` (min, max in its own space) after `matrix`, as six floats at `at`. */
const worldBounds = (bounds: Float32Array, matrix: THREE.Matrix4, out: Float32Array, at: number): void => {
    const e = matrix.elements;
    for (let axis = 0; axis < 3; axis++) {
        let low = e[12 + axis];
        let high = e[12 + axis];
        for (let column = 0; column < 3; column++) {
            const a = e[column * 4 + axis] * bounds[column];
            const b = e[column * 4 + axis] * bounds[column + 3];
            low += Math.min(a, b);
            high += Math.max(a, b);
        }
        out[at + axis] = low;
        out[at + 3 + axis] = high;
    }
};

/** Which meshes rays see, beyond their materials. Undefined leaves it to the mesh's own place in the level. */
export type RayFilter = (mesh: THREE.Mesh) => boolean;

export interface RaySceneStats {
    triangles: number;
    meshes: number;
    instances: number;
    pending: number;
    bytes: number;
}

/** What a ray met, from `closestHit`. */
export interface RayHit {
    distance: number;
    instance: number;
    triangle: number;
    material: number;
    /** World space, facing however the triangle faces. */
    normal: THREE.Vector3;
    front: boolean;
}

/** The unit box a character's bounds scale: three triangles per corner would do, this is simply the box. */
const unitBoxTriangles = (): MeshTriangles => {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const triangles = geometryTriangles(box, false)!;
    box.dispose();
    return triangles;
};

export class RayScene {
    readonly triangles = new FloatTable('RayTriangles', TRIANGLE_FLOATS);
    readonly meshNodes = new FloatTable('RayMeshNodes', NODE_FLOATS);
    readonly sceneNodes = new FloatTable('RaySceneNodes', NODE_FLOATS);
    readonly instances = new FloatTable('RayInstances', INSTANCE_FLOATS);
    readonly materials = new FloatTable('RayMaterials', MATERIAL_FLOATS);

    private readonly trees = new Map<string, MeshTree>();
    /** The tree built last for each geometry: what a mesh changing shape uses until its newest shape is built. */
    private readonly latest = new Map<string, MeshTree>();
    private readonly tracked = new Map<THREE.Object3D, Tracked>();
    private readonly queue: Array<{ key: string; build: () => MeshTriangles | null }> = [];
    private readonly queued = new Set<string>();
    private readonly materialSlots = new Map<string, number>();
    private materialCount = 0;
    private triangleCount = 0;
    private nodeCount = 0;
    private deadTriangles = 0;
    private frame = 0;
    private movesSinceBuild = 0;
    private layoutChanged = true;
    /** A tree was just built: the objects waiting for it can take it without waiting for the next look. */
    private lookAgain = false;
    private moved = false;
    private instanceCount = 0;
    private bounds = new Float32Array(0);
    private sceneTree: Bvh = buildBvh(new Float32Array(0), 0);
    private unitBox: MeshTree | null = null;

    get stats(): RaySceneStats {
        const bytes = [this.triangles, this.meshNodes, this.sceneNodes, this.instances, this.materials].reduce((sum, table) => sum + table.data.byteLength, 0);
        return { triangles: this.triangleCount - this.deadTriangles, meshes: this.trees.size, instances: this.instanceCount, pending: this.queue.length, bytes };
    }

    /** Whether everything found so far has its tree: light built on anything less is about to change. */
    get settled(): boolean {
        return this.queue.length === 0;
    }

    /**
     * Keeps the tables up with `root`: a look for what was added or removed every few frames, the trees that
     * needs for up to `budgetMs`, and every frame what moved.
     */
    update(root: THREE.Object3D, include: RayFilter, mean: TextureMean, budgetMs = 4): void {
        this.frame++;
        if (this.frame === 1 || this.lookAgain || this.frame % SCAN_INTERVAL === 0) this.scan(root, include, mean);
        this.buildQueued(budgetMs);
        if (this.layoutChanged) this.layOut();
        else this.followMoves();
        this.triangles.flush();
        this.meshNodes.flush();
        this.sceneNodes.flush();
        this.instances.flush();
        this.materials.flush();
    }

    /** Looks at every mesh below `root` once, however the frame's timing falls: for checks, and for a level just loaded. */
    settle(root: THREE.Object3D, include: RayFilter, mean: TextureMean): void {
        this.frame++;
        this.scan(root, include, mean);
        this.buildQueued(Infinity);
        this.frame++;
        this.scan(root, include, mean);
        this.layOut();
        for (const table of [this.triangles, this.meshNodes, this.sceneNodes, this.instances, this.materials]) table.flush();
    }

    private treeKey(mesh: THREE.Mesh): string {
        const geometry = mesh.geometry;
        const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
        const index = geometry.index;
        // Which slots it draws from, and which of them rays can see, decide what the tree holds.
        const slots = Array.isArray(mesh.material) ? mesh.material.map(material => (raysSeeMaterial(material) ? 1 : 0)).join('') : 's';
        return `${geometry.uuid}:${position?.version ?? 0}:${mesh.userData?.isTerrain ? 't' : index?.version ?? 'n'}:${index?.count ?? 0}:${slots}`;
    }

    private scan(root: THREE.Object3D, include: RayFilter, mean: TextureMean): void {
        this.lookAgain = false;
        const frame = this.frame;
        this.materialSlots.clear();
        let materialCount = 0;
        const placeMaterials = (materials: THREE.Material[]): { first: number; key: string } => {
            const key = materials.map(material => material.uuid).join(',');
            const known = this.materialSlots.get(key);
            if (known !== undefined) return { first: known, key };
            const first = materialCount;
            this.materialSlots.set(key, first);
            materialCount += materials.length;
            this.materials.reserve(materialCount);
            materials.forEach((material, slot) => this.writeMaterial(first + slot, rayMaterialFor(material, mean)));
            return { first, key };
        };

        const visit = (node: THREE.Object3D): void => {
            const mesh = node as THREE.Mesh;
            // A terrain's whole mesh stays hidden beside the pieces it draws: rays want it all the same.
            if (!node.visible && !(mesh.isMesh && node.userData?.isTerrain)) return;
            if (mesh.isMesh && include(mesh)) {
                const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                if (materials.some(raysSeeMaterial)) {
                    const skinned = mesh as THREE.SkinnedMesh;
                    if (skinned.isSkinnedMesh && skinned.skeleton) this.trackCharacter(skinned, placeMaterials(materials), frame);
                    else this.trackMesh(mesh, placeMaterials(materials), frame);
                }
            }
            for (const child of node.children) visit(child);
        };
        visit(root);
        if (materialCount !== this.materialCount) this.materials.touch();
        this.materialCount = materialCount;

        for (const [owner, entry] of this.tracked) {
            if (entry.seen === frame) continue;
            this.tracked.delete(owner);
            this.releaseTree(entry.tree);
            this.layoutChanged = true;
        }
        for (const tree of this.trees.values()) {
            if (tree.users === 0 && tree !== this.unitBox && frame - tree.idleSince > MESH_GRACE) this.freeTree(tree);
        }
        if (this.deadTriangles > 256 && this.deadTriangles > this.triangleCount * COMPACT_SHARE) this.compact();
    }

    private writeMaterial(index: number, material: RayMaterial): void {
        const data = this.materials.data;
        const at = index * MATERIAL_FLOATS;
        const values = [material.albedo[0], material.albedo[1], material.albedo[2], material.flags, material.emissive[0], material.emissive[1], material.emissive[2], 0];
        let changed = false;
        for (let k = 0; k < MATERIAL_FLOATS; k++) {
            // As the table holds it: a colour is rarely exact in 32 bits, and would look changed on every look.
            if (data[at + k] !== Math.fround(values[k])) {
                data[at + k] = values[k];
                changed = true;
            }
        }
        if (changed) this.materials.touch();
    }

    private trackMesh(mesh: THREE.Mesh, material: { first: number; key: string }, frame: number): void {
        const key = this.treeKey(mesh);
        const existing = this.tracked.get(mesh);
        const instanced = mesh as THREE.InstancedMesh;
        const count = instanced.isInstancedMesh ? instanced.count : 1;
        const flags = mesh.castShadow ? 0 : INSTANCE_NO_SHADOW;
        const built = this.trees.get(key);
        if (!existing) {
            if (!built) {
                this.requestTree(key, mesh);
                return;
            }
            built.users++;
            this.tracked.set(mesh, {
                node: mesh, tree: built, firstMaterial: material.first, materialKey: material.key, first: 0, count, flags, seen: frame,
                matrix: new Float64Array(16), instanceVersion: -1, asked: frame,
            });
            this.layoutChanged = true;
            return;
        }
        existing.seen = frame;
        if (existing.count !== count || existing.materialKey !== material.key || existing.firstMaterial !== material.first || existing.flags !== flags) {
            existing.count = count;
            existing.materialKey = material.key;
            existing.firstMaterial = material.first;
            existing.flags = flags;
            this.layoutChanged = true;
        }
        if (existing.tree.key === key) return;
        // Its shape changed, perhaps on every frame of a sculpting stroke. It keeps the shape it had rather than
        // leave a hole in what rays see, takes the latest that has been built, and asks for another only so often.
        if (!built && frame - existing.asked >= SCAN_INTERVAL) {
            existing.asked = frame;
            this.requestTree(key, mesh);
        }
        const latest = built ?? this.latest.get(mesh.geometry.uuid);
        if (!latest || latest === existing.tree) return;
        this.releaseTree(existing.tree);
        // A shape left for good: nothing will come back for it.
        if (existing.tree.users === 0 && geometryOfKey(existing.tree.key) === mesh.geometry.uuid) this.freeTree(existing.tree);
        latest.users++;
        existing.tree = latest;
        this.layoutChanged = true;
    }

    private trackCharacter(mesh: THREE.SkinnedMesh, material: { first: number; key: string }, frame: number): void {
        // By the bones themselves: some loaders give each mesh of one character a skeleton of its own.
        let owner: THREE.Object3D = mesh.skeleton.bones[0] ?? mesh;
        while ((owner.parent as THREE.Bone | null)?.isBone) owner = owner.parent!;
        const flags = INSTANCE_ONE_WAY | (mesh.castShadow ? 0 : INSTANCE_NO_SHADOW);
        const existing = this.tracked.get(owner);
        if (existing) {
            // One box for all of it, taking its material from whichever mesh comes first.
            if (existing.seen === frame) return;
            existing.seen = frame;
            if (existing.materialKey !== material.key || existing.firstMaterial !== material.first || existing.flags !== flags) {
                existing.materialKey = material.key;
                existing.firstMaterial = material.first;
                existing.flags = flags;
                this.layoutChanged = true;
            }
            return;
        }
        const box = this.unitBoxTree();
        box.users++;
        this.tracked.set(owner, {
            node: mesh, tree: box, firstMaterial: material.first, materialKey: material.key, first: 0, count: 1, flags, seen: frame,
            matrix: new Float64Array(16), instanceVersion: -1, asked: frame, bones: mesh.skeleton.bones,
        });
        this.layoutChanged = true;
    }

    private unitBoxTree(): MeshTree {
        if (!this.unitBox) this.unitBox = this.addTree('unit-box', unitBoxTriangles());
        return this.unitBox;
    }

    private requestTree(key: string, mesh: THREE.Mesh): void {
        if (this.queued.has(key)) return;
        this.queued.add(key);
        const geometry = mesh.geometry;
        const slotted = Array.isArray(mesh.material);
        const seen = Array.isArray(mesh.material) ? mesh.material.map(raysSeeMaterial) : null;
        const terrain = mesh.userData?.isTerrain === true;
        this.queue.push({
            key,
            build: () => {
                const plane = (geometry as THREE.PlaneGeometry).parameters;
                if (terrain && plane?.widthSegments) {
                    const stride = Math.max(1, Math.ceil(Math.max(plane.widthSegments, plane.heightSegments) / MAX_TERRAIN_CELLS));
                    return geometryTriangles(geometry, false, coarseGridIndices(plane.widthSegments, plane.heightSegments, stride));
                }
                const triangles = geometryTriangles(geometry, slotted);
                if (!triangles) return null;
                return simplifyTriangles(seen ? keepSlots(triangles, seen) : triangles, MAX_MESH_TRIANGLES);
            },
        });
    }

    private buildQueued(budgetMs: number): void {
        const start = performance.now();
        while (this.queue.length) {
            const next = this.queue.shift()!;
            this.queued.delete(next.key);
            const triangles = next.build();
            if (triangles?.count) this.addTree(next.key, triangles);
            if (performance.now() - start >= budgetMs) return;
        }
    }

    private addTree(key: string, mesh: MeshTriangles): MeshTree {
        const bounds = new Float32Array(mesh.count * BOUNDS_FLOATS);
        const whole = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
        for (let triangle = 0; triangle < mesh.count; triangle++) {
            const at = triangle * TRIANGLE_VERTEX_FLOATS;
            const to = triangle * BOUNDS_FLOATS;
            for (let axis = 0; axis < 3; axis++) {
                const a = mesh.positions[at + axis], b = mesh.positions[at + 3 + axis], c = mesh.positions[at + 6 + axis];
                const low = Math.min(a, b, c), high = Math.max(a, b, c);
                bounds[to + axis] = low;
                bounds[to + 3 + axis] = high;
                whole[axis] = Math.min(whole[axis], low);
                whole[3 + axis] = Math.max(whole[3 + axis], high);
            }
        }
        const bvh = buildBvh(bounds, mesh.count);
        const firstTriangle = this.triangleCount;
        const root = this.nodeCount;
        this.triangles.reserve(firstTriangle + mesh.count);
        this.meshNodes.reserve(root + bvh.nodeCount);
        const triangles = this.triangles.data;
        for (let index = 0; index < mesh.count; index++) {
            const from = bvh.order[index] * TRIANGLE_VERTEX_FLOATS;
            const to = (firstTriangle + index) * TRIANGLE_FLOATS;
            const p = mesh.positions;
            triangles[to] = p[from];
            triangles[to + 1] = p[from + 1];
            triangles[to + 2] = p[from + 2];
            triangles[to + 3] = mesh.slots[bvh.order[index]];
            triangles[to + 4] = p[from + 3] - p[from];
            triangles[to + 5] = p[from + 4] - p[from + 1];
            triangles[to + 6] = p[from + 5] - p[from + 2];
            triangles[to + 8] = p[from + 6] - p[from];
            triangles[to + 9] = p[from + 7] - p[from + 1];
            triangles[to + 10] = p[from + 8] - p[from + 2];
        }
        const nodes = this.meshNodes.data;
        nodes.set(bvh.nodes, root * NODE_FLOATS);
        for (let node = 0; node < bvh.nodeCount; node++) {
            const at = (root + node) * NODE_FLOATS;
            nodes[at + 3] += nodes[at + 7] !== 0 ? firstTriangle : root;
        }
        this.triangleCount += mesh.count;
        this.nodeCount += bvh.nodeCount;
        this.triangles.touch();
        this.meshNodes.touch();
        this.lookAgain = true;
        const tree: MeshTree = { key, root, nodeCount: bvh.nodeCount, firstTriangle, triangleCount: mesh.count, bounds: whole, users: 0, idleSince: this.frame };
        this.trees.set(key, tree);
        this.latest.set(geometryOfKey(key), tree);
        return tree;
    }

    private releaseTree(tree: MeshTree): void {
        tree.users = Math.max(0, tree.users - 1);
        if (tree.users === 0) tree.idleSince = this.frame;
    }

    private freeTree(tree: MeshTree): void {
        this.trees.delete(tree.key);
        if (this.latest.get(geometryOfKey(tree.key)) === tree) this.latest.delete(geometryOfKey(tree.key));
        this.deadTriangles += tree.triangleCount;
    }

    /** Moves the live trees down over the dead ones, so a level edited for hours does not fill the GPU. */
    private compact(): void {
        const trees = [...this.trees.values()].sort((a, b) => a.root - b.root);
        let triangleTo = 0;
        let nodeTo = 0;
        const triangles = this.triangles.data;
        const nodes = this.meshNodes.data;
        for (const tree of trees) {
            const triangleShift = tree.firstTriangle - triangleTo;
            const nodeShift = tree.root - nodeTo;
            if (triangleShift) triangles.copyWithin(triangleTo * TRIANGLE_FLOATS, tree.firstTriangle * TRIANGLE_FLOATS, (tree.firstTriangle + tree.triangleCount) * TRIANGLE_FLOATS);
            if (nodeShift) nodes.copyWithin(nodeTo * NODE_FLOATS, tree.root * NODE_FLOATS, (tree.root + tree.nodeCount) * NODE_FLOATS);
            for (let node = 0; node < tree.nodeCount; node++) {
                const at = (nodeTo + node) * NODE_FLOATS;
                nodes[at + 3] -= nodes[at + 7] !== 0 ? triangleShift : nodeShift;
            }
            tree.firstTriangle = triangleTo;
            tree.root = nodeTo;
            triangleTo += tree.triangleCount;
            nodeTo += tree.nodeCount;
        }
        this.triangleCount = triangleTo;
        this.nodeCount = nodeTo;
        this.deadTriangles = 0;
        this.triangles.touch();
        this.meshNodes.touch();
        this.layoutChanged = true;
    }

    /** Hands each tracked mesh its instance slots and builds the top tree. */
    private layOut(): void {
        this.layoutChanged = false;
        this.movesSinceBuild = 0;
        let count = 0;
        for (const entry of this.tracked.values()) {
            const room = Math.max(0, MAX_INSTANCES - count);
            entry.first = count;
            count += Math.min(entry.count, room);
        }
        this.instanceCount = count;
        this.instances.reserve(count);
        if (this.bounds.length < count * BOUNDS_FLOATS) this.bounds = new Float32Array(count * BOUNDS_FLOATS * 2);
        for (const entry of this.tracked.values()) {
            const slots = Math.min(entry.count, Math.max(0, count - entry.first));
            this.writeInstances(entry, slots);
        }
        this.sceneTree = buildBvh(this.bounds.subarray(0, count * BOUNDS_FLOATS), count, 1);
        this.uploadSceneTree();
        this.instances.touch();
    }

    private followMoves(): void {
        this.moved = false;
        for (const entry of this.tracked.values()) {
            const slots = Math.min(entry.count, Math.max(0, this.instanceCount - entry.first));
            if (slots > 0 && this.hasMoved(entry)) this.writeInstances(entry, slots);
        }
        if (!this.moved) return;
        this.instances.touch();
        if (++this.movesSinceBuild >= REBUILD_AFTER_MOVES) {
            this.layOut();
            return;
        }
        refitBvh(this.sceneTree, this.bounds);
        this.uploadSceneTree();
    }

    private hasMoved(entry: Tracked): boolean {
        if (entry.bones) {
            // A character breathing in place does not change what light does: only a box that has really moved counts.
            characterBox(entry.bones, _matrix);
            const box = _matrix.elements;
            for (let k = 0; k < 16; k++) {
                if (Math.abs(entry.matrix[k] - box[k]) > CHARACTER_MOVE) return true;
            }
            return false;
        }
        const instanced = entry.node as THREE.InstancedMesh;
        if (instanced.isInstancedMesh && instanced.instanceMatrix.version !== entry.instanceVersion) return true;
        const elements = entry.node.matrixWorld.elements;
        const matrix = entry.matrix;
        for (let k = 0; k < 16; k++) {
            if (matrix[k] !== elements[k]) return true;
        }
        return false;
    }

    private writeInstances(entry: Tracked, slots: number): void {
        this.moved = true;
        if (entry.bones) {
            characterBox(entry.bones, _matrix);
            entry.matrix.set(_matrix.elements);
        } else {
            entry.matrix.set(entry.node.matrixWorld.elements);
        }
        const instanced = entry.node as THREE.InstancedMesh;
        if (instanced.isInstancedMesh) entry.instanceVersion = instanced.instanceMatrix.version;
        const table = this.instances.data;
        for (let slot = 0; slot < slots; slot++) {
            if (entry.bones) characterBox(entry.bones, _matrix);
            else if (instanced.isInstancedMesh) {
                instanced.getMatrixAt(slot, _instance);
                _matrix.multiplyMatrices(entry.node.matrixWorld, _instance);
            } else _matrix.copy(entry.node.matrixWorld);
            const index = entry.first + slot;
            worldBounds(entry.tree.bounds, _matrix, this.bounds, index * BOUNDS_FLOATS);
            const e = _inverse.copy(_matrix).invert().elements;
            const to = index * INSTANCE_FLOATS;
            table[to] = e[0];
            table[to + 1] = e[4];
            table[to + 2] = e[8];
            table[to + 3] = e[12];
            table[to + 4] = e[1];
            table[to + 5] = e[5];
            table[to + 6] = e[9];
            table[to + 7] = e[13];
            table[to + 8] = e[2];
            table[to + 9] = e[6];
            table[to + 10] = e[10];
            table[to + 11] = e[14];
            table[to + 12] = entry.tree.root;
            table[to + 13] = entry.firstMaterial;
            table[to + 14] = entry.flags;
            table[to + 15] = 0;
        }
    }

    /** The top tree as shaders read it: a leaf names its instance outright. */
    private uploadSceneTree(): void {
        const tree = this.sceneTree;
        this.sceneNodes.reserve(tree.nodeCount);
        const data = this.sceneNodes.data;
        data.set(tree.nodes);
        for (let node = 0; node < tree.nodeCount; node++) {
            const at = node * NODE_FLOATS;
            if (data[at + 7] > 0) data[at + 3] = tree.order[data[at + 3]];
        }
        this.sceneNodes.touch();
    }

    /** The closest thing a ray meets, walked as the shader walks it: for checks, and for code on the CPU. */
    closestHit(origin: THREE.Vector3, direction: THREE.Vector3, limit = Infinity): RayHit | null {
        const instances = this.instances.data;
        const nodes = this.sceneNodes.data;
        let closest = limit;
        let best: Omit<RayHit, 'normal' | 'front'> & { nx: number; ny: number; nz: number } | null = null;
        const stack: number[] = [0];
        while (stack.length) {
            const node = stack.pop()! * NODE_FLOATS;
            if (!hitsBox(nodes, node, origin.x, origin.y, origin.z, direction.x, direction.y, direction.z, closest)) continue;
            const count = nodes[node + 7];
            if (count < 0) continue;
            if (count === 0) {
                stack.push(nodes[node + 3], nodes[node + 3] + 1);
                continue;
            }
            const instance = nodes[node + 3];
            const at = instance * INSTANCE_FLOATS;
            const r = instances;
            const ox = r[at] * origin.x + r[at + 1] * origin.y + r[at + 2] * origin.z + r[at + 3];
            const oy = r[at + 4] * origin.x + r[at + 5] * origin.y + r[at + 6] * origin.z + r[at + 7];
            const oz = r[at + 8] * origin.x + r[at + 9] * origin.y + r[at + 10] * origin.z + r[at + 11];
            const dx = r[at] * direction.x + r[at + 1] * direction.y + r[at + 2] * direction.z;
            const dy = r[at + 4] * direction.x + r[at + 5] * direction.y + r[at + 6] * direction.z;
            const dz = r[at + 8] * direction.x + r[at + 9] * direction.y + r[at + 10] * direction.z;
            const oneWay = (r[at + 14] & INSTANCE_ONE_WAY) !== 0;
            const inner: number[] = [r[at + 12]];
            const meshNodes = this.meshNodes.data;
            const triangles = this.triangles.data;
            while (inner.length) {
                const meshNode = inner.pop()! * NODE_FLOATS;
                if (!hitsBox(meshNodes, meshNode, ox, oy, oz, dx, dy, dz, closest)) continue;
                const held = meshNodes[meshNode + 7];
                if (held === 0) {
                    inner.push(meshNodes[meshNode + 3], meshNodes[meshNode + 3] + 1);
                    continue;
                }
                const first = meshNodes[meshNode + 3];
                for (let triangle = first; triangle < first + held; triangle++) {
                    const t = triangle * TRIANGLE_FLOATS;
                    const e1x = triangles[t + 4], e1y = triangles[t + 5], e1z = triangles[t + 6];
                    const e2x = triangles[t + 8], e2y = triangles[t + 9], e2z = triangles[t + 10];
                    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
                    const det = e1x * px + e1y * py + e1z * pz;
                    if (det === 0 || (oneWay && det < 0)) continue;
                    const f = 1 / det;
                    const sx = ox - triangles[t], sy = oy - triangles[t + 1], sz = oz - triangles[t + 2];
                    const u = f * (sx * px + sy * py + sz * pz);
                    if (u < 0 || u > 1) continue;
                    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
                    const v = f * (dx * qx + dy * qy + dz * qz);
                    if (v < 0 || u + v > 1) continue;
                    const distance = f * (e2x * qx + e2y * qy + e2z * qz);
                    if (distance <= 1e-5 || distance >= closest) continue;
                    closest = distance;
                    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
                    best = {
                        distance, instance, triangle, material: r[at + 13] + triangles[t + 3],
                        nx: r[at] * nx + r[at + 4] * ny + r[at + 8] * nz,
                        ny: r[at + 1] * nx + r[at + 5] * ny + r[at + 9] * nz,
                        nz: r[at + 2] * nx + r[at + 6] * ny + r[at + 10] * nz,
                    };
                }
            }
        }
        if (!best) return null;
        const normal = new THREE.Vector3(best.nx, best.ny, best.nz).normalize();
        return { distance: best.distance, instance: best.instance, triangle: best.triangle, material: best.material, normal, front: normal.dot(direction) < 0 };
    }

    dispose(): void {
        for (const table of [this.triangles, this.meshNodes, this.sceneNodes, this.instances, this.materials]) table.dispose();
    }
}

/** Fits the unit box to a character's bones, with room for the flesh around them. */
const CHARACTER_MARGIN = 0.18;
/** How far a character's box must change, in metres, before the tree hears about it. */
const CHARACTER_MOVE = 0.05;
const characterBox = (bones: THREE.Bone[], out: THREE.Matrix4): void => {
    _box.makeEmpty();
    for (const bone of bones) _box.expandByPoint(_point.setFromMatrixPosition(bone.matrixWorld));
    if (_box.isEmpty()) {
        out.makeScale(1e-3, 1e-3, 1e-3);
        return;
    }
    const min = _box.min, max = _box.max;
    out.makeScale(max.x - min.x + CHARACTER_MARGIN * 2, max.y - min.y + CHARACTER_MARGIN * 2, max.z - min.z + CHARACTER_MARGIN * 2);
    out.setPosition((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
};

const hitsBox = (nodes: Float32Array, at: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, limit: number): boolean => {
    let near = 0;
    let far = limit;
    const origin = [ox, oy, oz], direction = [dx, dy, dz];
    for (let axis = 0; axis < 3; axis++) {
        // A direction along an axis would divide by zero: leaning it by a hair loses nothing, as in the shader.
        const inverse = 1 / (direction[axis] || 1e-9);
        const a = (nodes[at + axis] - origin[axis]) * inverse;
        const b = (nodes[at + 4 + axis] - origin[axis]) * inverse;
        near = Math.max(near, Math.min(a, b));
        far = Math.min(far, Math.max(a, b));
    }
    return near <= far;
};
