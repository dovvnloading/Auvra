import * as THREE from 'three';

/**
 * THE MESH OF A TEXTURE SET
 *
 * The triangles a set of materials covers on a model, in the model's own space and its rest pose,
 * welded where the file left corners shared: what baking, painting and UV tools all work on.
 * Texture coordinates may spread over several UDIM tiles (1001 is 0..1, 1002 the next to the right,
 * 1011 the one above); each tile is a picture of its own.
 */

export interface PartMesh {
    /** Three per corner, model space. */
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    /** Four per corner, when the source meshes carry tangents (then normal maps use them). */
    tangents: Float32Array | null;
    /** Three per corner, when the source meshes carry vertex colours. */
    colors: Float32Array | null;
    indices: Uint32Array;
    /** For each triangle, which source mesh it came from. */
    triangleMesh: Uint16Array;
    meshNames: string[];
    /** For each triangle, its UV island. */
    triangleIsland: Uint32Array;
    islandCount: number;
    bounds: THREE.Box3;
    /** Area of the surface in model units squared. */
    area: number;
    /** UDIM tiles the triangles lie in, in order. */
    tiles: number[];
    /** For each triangle, its UDIM tile. */
    triangleTile: Uint16Array;
    /** For each triangle, the whole-number shift that brings it into its tile (two per triangle). */
    triangleShift: Int16Array;
    /** Whether the set's tiles are UDIM tiles of their own, or one picture repeated (coordinates past 0..1 wrap). */
    udim: boolean;
    /** The source meshes, and for each part vertex its mesh (index into `meshes`) and vertex there. */
    meshes: THREE.Mesh[];
    vertexMesh: Uint16Array;
    vertexSource: Uint32Array;
    /** For each triangle, where its first corner sits in its mesh's index list (or vertex list, unindexed). */
    triangleSource: Uint32Array;
}

export const tileOf = (u: number, v: number): number => 1001 + Math.max(0, Math.min(9, Math.floor(u))) + 10 * Math.max(0, Math.floor(v));
export const tileOffset = (tile: number): [number, number] => [(tile - 1001) % 10, Math.floor((tile - 1001) / 10)];

const materialsOf = (mesh: THREE.Mesh): THREE.Material[] => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]);

/** The meshes of `root` and, for each, the triangle ranges drawn with one of `materials` (all, when null). */
const collect = (root: THREE.Object3D, materials: ReadonlySet<THREE.Material> | null) => {
    const found: Array<{ mesh: THREE.Mesh; ranges: Array<[number, number]> }> = [];
    root.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry?.attributes.position) return;
        const geometry = mesh.geometry;
        const count = geometry.index ? geometry.index.count : geometry.attributes.position.count;
        const list = materialsOf(mesh);
        const ranges: Array<[number, number]> = [];
        if (geometry.groups.length && Array.isArray(mesh.material)) {
            for (const group of geometry.groups) {
                const material = list[group.materialIndex ?? 0];
                if (!materials || (material && materials.has(material))) ranges.push([group.start, Math.min(count, group.start + group.count)]);
            }
        } else if (!materials || list.some((material) => materials.has(material))) {
            ranges.push([0, count]);
        }
        if (ranges.length) found.push({ mesh, ranges });
    });
    return found;
};

/** Union-find over triangles, for islands. */
const find = (parent: Uint32Array, a: number): number => {
    while (parent[a] !== a) {
        parent[a] = parent[parent[a]];
        a = parent[a];
    }
    return a;
};

/**
 * The part of `root` drawn with `materials` (every mesh when null), in rest pose relative to `root`.
 * Throws when none of its triangles have texture coordinates.
 */
export const buildPartMesh = (root: THREE.Object3D, materials: ReadonlySet<THREE.Material> | null, layout: { udim: boolean | 'auto' } = { udim: 'auto' }): PartMesh => {
    root.updateWorldMatrix(true, true);
    const rootInverse = root.matrixWorld.clone().invert();
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const tangents: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const triangleMesh: number[] = [];
    const triangleSource: number[] = [];
    const vertexMesh: number[] = [];
    const vertexSource: number[] = [];
    const sourceMeshes: THREE.Mesh[] = [];
    const meshNames: string[] = [];
    let anyTangents = false;
    let anyColors = false;
    const meshes = collect(root, materials);
    for (const { mesh } of meshes) {
        const geometry = mesh.geometry;
        if (!geometry.attributes.uv) continue;
        anyTangents ||= Boolean(geometry.attributes.tangent);
        anyColors ||= Boolean(geometry.attributes.color);
    }
    meshes.forEach(({ mesh, ranges }) => {
        const geometry = mesh.geometry;
        const position = geometry.attributes.position;
        const uv = geometry.attributes.uv;
        if (!uv) return;
        const normal = geometry.attributes.normal;
        const tangent = geometry.attributes.tangent;
        const color = geometry.attributes.color;
        const matrix = new THREE.Matrix4().multiplyMatrices(rootInverse, mesh.matrixWorld);
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
        const meshIndex = meshNames.length;
        meshNames.push(mesh.name || `Mesh ${meshIndex + 1}`);
        sourceMeshes.push(mesh);
        // Each source vertex once, then its triangles.
        const remap = new Map<number, number>();
        const p = new THREE.Vector3();
        const n = new THREE.Vector3();
        const t = new THREE.Vector3();
        const vertex = (source: number): number => {
            const known = remap.get(source);
            if (known !== undefined) return known;
            const at = positions.length / 3;
            p.fromBufferAttribute(position, source).applyMatrix4(matrix);
            positions.push(p.x, p.y, p.z);
            if (normal) n.fromBufferAttribute(normal, source).applyMatrix3(normalMatrix).normalize();
            else n.set(0, 0, 0);
            normals.push(n.x, n.y, n.z);
            uvs.push(uv.getX(source), uv.getY(source));
            if (anyTangents) {
                // A mesh without tangents among meshes with them: a w of 0 asks for the frame from texture
                // slopes, as the renderer uses for it.
                if (tangent) {
                    t.set(tangent.getX(source), tangent.getY(source), tangent.getZ(source)).transformDirection(matrix);
                    tangents.push(t.x, t.y, t.z, tangent.itemSize > 3 ? tangent.getW(source) : 1);
                } else tangents.push(0, 0, 0, 0);
            }
            if (anyColors) {
                if (color) colors.push(color.getX(source), color.getY(source), color.getZ(source));
                else colors.push(1, 1, 1);
            }
            vertexMesh.push(meshIndex);
            vertexSource.push(source);
            remap.set(source, at);
            return at;
        };
        const index = geometry.index;
        for (const [start, end] of ranges) {
            for (let corner = start; corner + 2 < end; corner += 3) {
                const a = index ? index.getX(corner) : corner;
                const b = index ? index.getX(corner + 1) : corner + 1;
                const c = index ? index.getX(corner + 2) : corner + 2;
                indices.push(vertex(a), vertex(b), vertex(c));
                triangleMesh.push(meshIndex);
                triangleSource.push(corner);
            }
        }
    });
    if (!indices.length) throw new Error('This surface has no texture coordinates to paint on. Unwrap it first.');

    const positionArray = new Float32Array(positions);
    const normalArray = new Float32Array(normals);
    const uvArray = new Float32Array(uvs);
    const indexArray = new Uint32Array(indices);
    const triangles = indexArray.length / 3;

    // Normals the file did not give come from the faces.
    const missing = normalArray.every((value) => value === 0);
    if (missing) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
        geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
        geometry.computeVertexNormals();
        normalArray.set(geometry.attributes.normal.array as Float32Array);
        geometry.dispose();
    }

    // Islands: triangles meeting at a corner with the same place and texture coordinate are one piece.
    const parent = new Uint32Array(triangles);
    for (let i = 0; i < triangles; i++) parent[i] = i;
    const owner = new Map<string, number>();
    const key = (vertex: number) => `${Math.round(positionArray[vertex * 3] * 1e5)},${Math.round(positionArray[vertex * 3 + 1] * 1e5)},${Math.round(positionArray[vertex * 3 + 2] * 1e5)}|${Math.round(uvArray[vertex * 2] * 1e6)},${Math.round(uvArray[vertex * 2 + 1] * 1e6)}`;
    for (let triangle = 0; triangle < triangles; triangle++) {
        for (let k = 0; k < 3; k++) {
            const id = key(indexArray[triangle * 3 + k]);
            const other = owner.get(id);
            if (other === undefined) owner.set(id, triangle);
            else {
                const a = find(parent, triangle);
                const b = find(parent, other);
                if (a !== b) parent[a] = b;
            }
        }
    }
    const islandOf = new Map<number, number>();
    const triangleIsland = new Uint32Array(triangles);
    for (let triangle = 0; triangle < triangles; triangle++) {
        const root = find(parent, triangle);
        let island = islandOf.get(root);
        if (island === undefined) islandOf.set(root, island = islandOf.size);
        triangleIsland[triangle] = island;
    }

    // Tiles and area. Coordinates past 0..1 are UDIM tiles only when several tiles each hold a real share
    // of the layout and few triangles straddle a tile's edge; otherwise they wrap onto one picture.
    const centroidTile = new Uint16Array(triangles);
    const triangleShift = new Int16Array(triangles * 2);
    const tileArea = new Map<number, number>();
    let straddling = 0;
    let totalUvArea = 0;
    let area = 0;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (let triangle = 0; triangle < triangles; triangle++) {
        const i0 = indexArray[triangle * 3];
        const i1 = indexArray[triangle * 3 + 1];
        const i2 = indexArray[triangle * 3 + 2];
        const us = [uvArray[i0 * 2], uvArray[i1 * 2], uvArray[i2 * 2]];
        const vs = [uvArray[i0 * 2 + 1], uvArray[i1 * 2 + 1], uvArray[i2 * 2 + 1]];
        const u = (us[0] + us[1] + us[2]) / 3;
        const v = (vs[0] + vs[1] + vs[2]) / 3;
        const tile = tileOf(u, v);
        centroidTile[triangle] = tile;
        triangleShift[triangle * 2] = Math.floor(u);
        triangleShift[triangle * 2 + 1] = Math.floor(v);
        if (Math.floor(Math.min(...us) + 1e-6) !== Math.floor(Math.max(...us) - 1e-6) || Math.floor(Math.min(...vs) + 1e-6) !== Math.floor(Math.max(...vs) - 1e-6)) straddling++;
        const uvArea = Math.abs((us[1] - us[0]) * (vs[2] - vs[0]) - (us[2] - us[0]) * (vs[1] - vs[0])) / 2;
        tileArea.set(tile, (tileArea.get(tile) ?? 0) + uvArea);
        totalUvArea += uvArea;
        a.fromArray(positionArray, i0 * 3);
        b.fromArray(positionArray, i1 * 3);
        c.fromArray(positionArray, i2 * 3);
        area += b.sub(a).cross(c.sub(a)).length() / 2;
    }
    const substantial = [...tileArea.values()].filter((value) => value >= totalUvArea * 0.05).length;
    const udim = layout.udim === 'auto' ? substantial >= 2 && straddling <= triangles * 0.02 : layout.udim;
    const triangleTile = udim ? centroidTile : new Uint16Array(triangles).fill(1001);
    const tiles = new Set<number>(triangleTile);
    const bounds = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(positionArray, 3));
    return {
        positions: positionArray,
        normals: normalArray,
        uvs: uvArray,
        tangents: anyTangents ? new Float32Array(tangents) : null,
        colors: anyColors ? new Float32Array(colors) : null,
        indices: indexArray,
        triangleMesh: new Uint16Array(triangleMesh),
        meshNames,
        triangleIsland,
        islandCount: islandOf.size,
        bounds,
        area,
        tiles: [...tiles].sort((x, y) => x - y),
        triangleTile,
        triangleShift,
        udim,
        meshes: sourceMeshes,
        vertexMesh: new Uint16Array(vertexMesh),
        vertexSource: new Uint32Array(vertexSource),
        triangleSource: new Uint32Array(triangleSource),
    };
};

/** Every mesh of a model as one triangle soup (a high-poly source for baking). */
/**
 * A high-poly model for baking: the whole model's triangles, with each one's mesh (and the meshes' names,
 * for matching) and material (each material's colour, sRGB, and opacity, for carrying over).
 */
export const buildHighPoly = (root: THREE.Object3D): {
    positions: Float32Array; normals: Float32Array; indices: Uint32Array;
    triangleMesh: Uint16Array; meshNames: string[]; triangleMaterial: Uint16Array; materials: Array<{ color: [number, number, number]; opacity: number }>;
} => {
    const whole = buildWholeMesh(root);
    const triangleMesh: number[] = [];
    const triangleMaterial: number[] = [];
    const meshNames: string[] = [];
    const materials: Array<{ color: [number, number, number]; opacity: number }> = [];
    const known = new Map<THREE.Material, number>();
    const materialIndex = (material: THREE.Material | undefined): number => {
        if (!material) return 0;
        let index = known.get(material);
        if (index === undefined) {
            const standard = material as THREE.MeshStandardMaterial;
            const color = standard.color ? standard.color.clone().convertLinearToSRGB() : new THREE.Color(1, 1, 1);
            index = materials.length;
            materials.push({ color: [color.r, color.g, color.b], opacity: standard.transparent ? standard.opacity : 1 });
            known.set(material, index);
        }
        return index;
    };
    // Walked in the same order as buildWholeMesh, triangle by triangle.
    root.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry?.attributes.position) return;
        const meshIndex = meshNames.length;
        meshNames.push(mesh.name || `Mesh ${meshIndex + 1}`);
        const geometry = mesh.geometry;
        const count = (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (let t = 0; t < count; t++) {
            const group = Array.isArray(mesh.material) ? geometry.groups.find((g) => t * 3 >= g.start && t * 3 < g.start + g.count) : undefined;
            triangleMesh.push(meshIndex);
            triangleMaterial.push(materialIndex(list[group?.materialIndex ?? 0]));
        }
    });
    return { ...whole, triangleMesh: new Uint16Array(triangleMesh), meshNames, triangleMaterial: new Uint16Array(triangleMaterial), materials };
};

export const buildWholeMesh = (root: THREE.Object3D): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } => {
    root.updateWorldMatrix(true, true);
    const rootInverse = root.matrixWorld.clone().invert();
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    root.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry?.attributes.position) return;
        let geometry = mesh.geometry;
        if (!geometry.attributes.normal) { geometry = geometry.clone(); geometry.computeVertexNormals(); }
        const matrix = new THREE.Matrix4().multiplyMatrices(rootInverse, mesh.matrixWorld);
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
        const base = positions.length / 3;
        const position = geometry.attributes.position;
        const normal = geometry.attributes.normal;
        for (let i = 0; i < position.count; i++) {
            p.fromBufferAttribute(position, i).applyMatrix4(matrix);
            n.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
            positions.push(p.x, p.y, p.z);
            normals.push(n.x, n.y, n.z);
        }
        if (geometry.index) for (let i = 0; i < geometry.index.count; i++) indices.push(base + geometry.index.getX(i));
        else for (let i = 0; i < position.count; i++) indices.push(base + i);
    });
    return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
};

/**
 * A GPU geometry of the triangles in one UDIM tile, unshared so each corner carries its triangle's
 * edges (for the tangent frame the renderer works out) and its island, mesh and own number.
 */
export const tileGeometry = (part: PartMesh, tile: number): THREE.BufferGeometry => {
    const triangles: number[] = [];
    for (let t = 0; t < part.triangleTile.length; t++) if (part.triangleTile[t] === tile) triangles.push(t);
    const count = triangles.length * 3;
    const position = new Float32Array(count * 3);
    const normal = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const sourceUv = new Float32Array(count * 2);
    const edge1 = new Float32Array(count * 3);
    const edge2 = new Float32Array(count * 3);
    const uvEdges = new Float32Array(count * 4);
    const tangent = part.tangents ? new Float32Array(count * 4) : null;
    const color = new Float32Array(count * 3);
    const ids = new Float32Array(count * 3);
    triangles.forEach((triangle, slot) => {
        const corners = [0, 1, 2].map((k) => part.indices[triangle * 3 + k]);
        const [i0, i1, i2] = corners;
        const e1 = [0, 1, 2].map((axis) => part.positions[i1 * 3 + axis] - part.positions[i0 * 3 + axis]);
        const e2 = [0, 1, 2].map((axis) => part.positions[i2 * 3 + axis] - part.positions[i0 * 3 + axis]);
        const d1 = [part.uvs[i1 * 2] - part.uvs[i0 * 2], part.uvs[i1 * 2 + 1] - part.uvs[i0 * 2 + 1]];
        const d2 = [part.uvs[i2 * 2] - part.uvs[i0 * 2], part.uvs[i2 * 2 + 1] - part.uvs[i0 * 2 + 1]];
        corners.forEach((vertex, k) => {
            const at = slot * 3 + k;
            position.set(part.positions.subarray(vertex * 3, vertex * 3 + 3), at * 3);
            normal.set(part.normals.subarray(vertex * 3, vertex * 3 + 3), at * 3);
            uv[at * 2] = part.uvs[vertex * 2] - part.triangleShift[triangle * 2];
            uv[at * 2 + 1] = part.uvs[vertex * 2 + 1] - part.triangleShift[triangle * 2 + 1];
            sourceUv[at * 2] = part.uvs[vertex * 2];
            sourceUv[at * 2 + 1] = part.uvs[vertex * 2 + 1];
            edge1.set(e1, at * 3);
            edge2.set(e2, at * 3);
            uvEdges.set([d1[0], d1[1], d2[0], d2[1]], at * 4);
            if (tangent && part.tangents) tangent.set(part.tangents.subarray(vertex * 4, vertex * 4 + 4), at * 4);
            if (part.colors) color.set(part.colors.subarray(vertex * 3, vertex * 3 + 3), at * 3);
            else color.set([1, 1, 1], at * 3);
            ids[at * 3] = part.triangleIsland[triangle];
            ids[at * 3 + 1] = part.triangleMesh[triangle];
            ids[at * 3 + 2] = triangle;
        });
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geometry.setAttribute('sourceUv', new THREE.BufferAttribute(sourceUv, 2));
    geometry.setAttribute('edge1', new THREE.BufferAttribute(edge1, 3));
    geometry.setAttribute('edge2', new THREE.BufferAttribute(edge2, 3));
    geometry.setAttribute('uvEdges', new THREE.BufferAttribute(uvEdges, 4));
    if (tangent) geometry.setAttribute('tangent', new THREE.BufferAttribute(tangent, 4));
    geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
    geometry.setAttribute('ids', new THREE.BufferAttribute(ids, 3));
    return geometry;
};

/** The same corners as line segments along every triangle edge, so thin slivers still cover their texels. */
export const edgeGeometry = (triangles: THREE.BufferGeometry): THREE.BufferGeometry => {
    const count = triangles.attributes.position.count;
    const order: number[] = [];
    for (let t = 0; t < count; t += 3) order.push(t, t + 1, t + 1, t + 2, t + 2, t);
    const geometry = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(triangles.attributes)) {
        const source = attribute as THREE.BufferAttribute;
        const array = new Float32Array(order.length * source.itemSize);
        order.forEach((corner, at) => array.set((source.array as Float32Array).subarray(corner * source.itemSize, (corner + 1) * source.itemSize), at * source.itemSize));
        geometry.setAttribute(name, new THREE.BufferAttribute(array, source.itemSize));
    }
    return geometry;
};
