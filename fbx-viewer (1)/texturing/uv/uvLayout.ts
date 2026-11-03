import * as THREE from 'three';
import type { PartMesh } from '../mesh/partMesh';

/**
 * UV LAYOUTS ON MODELS
 *
 * A new unwrap changes a model's geometry: corners split where new seams run, and every corner of the
 * unwrapped surface gets new texture coordinates. A layout records, for each changed mesh, which
 * original vertex each new vertex copies, its coordinates, and the new triangle list, so loading the
 * project rebuilds the same meshes from the model's own file (positions, normals, skin weights and
 * every other attribute copied over). It is kept as a small binary asset beside the model.
 *
 *   'AUV1', mesh count; per mesh: its place among the model's meshes, its name, its original vertex
 *   count, new vertex count, index count; then the source of each new vertex (u32), the coordinates
 *   (two f32 each) and the triangle list (u32).
 */

export const UV_LAYOUT_ENCODING = 'uv-layout-v1';
export const UV_LAYOUT_MIME = 'application/x-auvra-uv-layout';
export const UV_LAYOUT_FILE_NAME = 'uv-layout.auvuv';

export interface MeshLayout {
    /** The mesh's place in a depth-first walk of the model's meshes. */
    meshIndex: number;
    name: string;
    originalVertexCount: number;
    sourceOf: Uint32Array;
    uv: Float32Array;
    index: Uint32Array;
}

export interface UvLayoutFile { meshes: MeshLayout[] }

/** A model's meshes in the order layouts name them. */
export const modelMeshes = (root: THREE.Object3D): THREE.Mesh[] => {
    const meshes: THREE.Mesh[] = [];
    root.traverse((child) => { if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh); });
    return meshes;
};

/**
 * The layout giving a texture set's corners `cornerUv` (two per corner of each of its triangles, in
 * triangle order), with `cornerKey` naming which corners share a vertex (same original vertex and the
 * same key share; different keys split). Meshes already laid out keep their earlier changes.
 */
export const buildLayout = (root: THREE.Object3D, part: PartMesh, cornerUv: Float32Array | Float64Array, cornerKey: Uint32Array, previous: UvLayoutFile | null): UvLayoutFile => {
    const all = modelMeshes(root);
    const kept = new Map((previous?.meshes ?? []).map((layout) => [layout.meshIndex, layout]));
    const result = new Map<number, MeshLayout>();
    part.meshes.forEach((mesh, partMeshIndex) => {
        const meshIndex = all.indexOf(mesh);
        if (meshIndex < 0) return;
        const geometry = mesh.geometry;
        const count = geometry.attributes.position.count;
        const index = geometry.index ? Uint32Array.from(geometry.index.array as ArrayLike<number>) : Uint32Array.from({ length: count }, (_, i) => i);
        const uvAttribute = geometry.attributes.uv;
        const sourceOf: number[] = Array.from({ length: count }, (_, i) => i);
        const uv: number[] = [];
        for (let i = 0; i < count; i++) uv.push(uvAttribute ? uvAttribute.getX(i) : 0, uvAttribute ? uvAttribute.getY(i) : 0);
        // Vertices used by triangles outside the set keep their coordinates: never reuse them.
        const inSet = new Uint8Array(index.length / 3);
        for (let t = 0; t < part.triangleMesh.length; t++) if (part.triangleMesh[t] === partMeshIndex) inSet[part.triangleSource[t] / 3] = 1;
        const shared = new Uint8Array(count);
        for (let t = 0; t < inSet.length; t++) if (!inSet[t]) for (let k = 0; k < 3; k++) shared[index[t * 3 + k]] = 1;
        const claimed = new Uint8Array(count);
        const made = new Map<string, number>();
        for (let t = 0; t < part.triangleMesh.length; t++) {
            if (part.triangleMesh[t] !== partMeshIndex) continue;
            for (let k = 0; k < 3; k++) {
                const source = part.vertexSource[part.indices[t * 3 + k]];
                const key = `${source}:${cornerKey[t * 3 + k]}`;
                let id = made.get(key);
                if (id === undefined) {
                    if (!shared[source] && !claimed[source]) {
                        id = source;
                        claimed[source] = 1;
                    } else {
                        id = sourceOf.length;
                        sourceOf.push(source);
                        uv.push(0, 0);
                    }
                    uv[id * 2] = cornerUv[(t * 3 + k) * 2];
                    uv[id * 2 + 1] = cornerUv[(t * 3 + k) * 2 + 1];
                    made.set(key, id);
                }
                index[part.triangleSource[t] + k] = id;
            }
        }
        const earlier = kept.get(meshIndex);
        // A mesh laid out before keeps pointing at its file's vertices.
        const resolved = earlier ? Uint32Array.from(sourceOf, (s) => earlier.sourceOf[s] ?? s) : Uint32Array.from(sourceOf);
        result.set(meshIndex, { meshIndex, name: mesh.name, originalVertexCount: earlier?.originalVertexCount ?? count, sourceOf: resolved, uv: Float32Array.from(uv), index });
    });
    for (const [meshIndex, layout] of kept) if (!result.has(meshIndex)) result.set(meshIndex, layout);
    return { meshes: [...result.values()].sort((a, b) => a.meshIndex - b.meshIndex) };
};

export const encodeLayout = (file: UvLayoutFile): Uint8Array => {
    const encoder = new TextEncoder();
    const names = file.meshes.map((mesh) => encoder.encode(mesh.name.slice(0, 200)));
    let size = 8;
    file.meshes.forEach((mesh, i) => { size += 20 + Math.ceil(names[i].length / 4) * 4 + mesh.sourceOf.length * 12 + mesh.index.length * 4; });
    const buffer = new ArrayBuffer(size);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    view.setUint32(0, 0x31565541, true);
    view.setUint32(4, file.meshes.length, true);
    let at = 8;
    file.meshes.forEach((mesh, i) => {
        view.setUint32(at, mesh.meshIndex, true);
        view.setUint32(at + 4, names[i].length, true);
        view.setUint32(at + 8, mesh.originalVertexCount, true);
        view.setUint32(at + 12, mesh.sourceOf.length, true);
        view.setUint32(at + 16, mesh.index.length, true);
        at += 20;
        bytes.set(names[i], at);
        at += Math.ceil(names[i].length / 4) * 4;
        new Uint32Array(buffer, at, mesh.sourceOf.length).set(mesh.sourceOf);
        at += mesh.sourceOf.length * 4;
        new Float32Array(buffer, at, mesh.uv.length).set(mesh.uv);
        at += mesh.uv.length * 4;
        new Uint32Array(buffer, at, mesh.index.length).set(mesh.index);
        at += mesh.index.length * 4;
    });
    return bytes;
};

export const decodeLayout = (bytes: ArrayBuffer): UvLayoutFile => {
    const view = new DataView(bytes);
    if (bytes.byteLength < 8 || view.getUint32(0, true) !== 0x31565541) throw new Error('This is not a UV layout.');
    const count = view.getUint32(4, true);
    const decoder = new TextDecoder();
    const meshes: MeshLayout[] = [];
    let at = 8;
    for (let m = 0; m < count; m++) {
        const meshIndex = view.getUint32(at, true);
        const nameLength = view.getUint32(at + 4, true);
        const originalVertexCount = view.getUint32(at + 8, true);
        const vertices = view.getUint32(at + 12, true);
        const indices = view.getUint32(at + 16, true);
        at += 20;
        const name = decoder.decode(new Uint8Array(bytes, at, nameLength));
        at += Math.ceil(nameLength / 4) * 4;
        if (at + vertices * 12 + indices * 4 > bytes.byteLength) throw new Error('This UV layout is cut short.');
        const sourceOf = new Uint32Array(bytes.slice(at, at + vertices * 4));
        at += vertices * 4;
        const uv = new Float32Array(bytes.slice(at, at + vertices * 8));
        at += vertices * 8;
        const index = new Uint32Array(bytes.slice(at, at + indices * 4));
        at += indices * 4;
        meshes.push({ meshIndex, name, originalVertexCount, sourceOf, uv, index });
    }
    return { meshes };
};

/** A geometry with every attribute gathered through `sourceOf`, the new coordinates and triangles. */
const relaid = (geometry: THREE.BufferGeometry, layout: MeshLayout): THREE.BufferGeometry => {
    const next = new THREE.BufferGeometry();
    const gather = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute => {
        const size = attribute.itemSize;
        const Ctor = (attribute.array as unknown as { constructor: new (length: number) => THREE.TypedArray }).constructor;
        const array = new Ctor(layout.sourceOf.length * size);
        for (let i = 0; i < layout.sourceOf.length; i++) {
            const s = layout.sourceOf[i];
            for (let c = 0; c < size; c++) array[i * size + c] = attribute.getComponent(s, c);
        }
        return new THREE.BufferAttribute(array, size, attribute.normalized);
    };
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
        if (name === 'uv') continue;
        next.setAttribute(name, gather(attribute));
    }
    next.setAttribute('uv', new THREE.BufferAttribute(layout.uv, 2));
    for (const [name, list] of Object.entries(geometry.morphAttributes)) (next.morphAttributes as Record<string, THREE.BufferAttribute[]>)[name] = (list as Array<THREE.BufferAttribute | THREE.InterleavedBufferAttribute>).map(gather);
    next.morphTargetsRelative = geometry.morphTargetsRelative;
    next.setIndex(new THREE.BufferAttribute(layout.index, 1));
    for (const group of geometry.groups) next.addGroup(group.start, group.count, group.materialIndex);
    next.boundingBox = geometry.boundingBox?.clone() ?? null;
    next.boundingSphere = geometry.boundingSphere?.clone() ?? null;
    next.name = geometry.name;
    next.userData = { ...geometry.userData, uvLayout: true };
    return next;
};

/**
 * Puts a layout on a model loaded from its file. Meshes that do not match (another file, a changed
 * import) are left as they are; returns how many were laid out.
 */
export const applyLayout = (root: THREE.Object3D, file: UvLayoutFile): number => {
    const meshes = modelMeshes(root);
    let applied = 0;
    for (const layout of file.meshes) {
        const mesh = meshes[layout.meshIndex];
        if (!mesh) continue;
        const geometry = mesh.geometry;
        const original = geometry.userData?.uvLayoutSource as THREE.BufferGeometry | undefined;
        const source = original ?? geometry;
        if (source.attributes.position.count !== layout.originalVertexCount) continue;
        if (layout.sourceOf.some((s) => s >= layout.originalVertexCount)) continue;
        const next = relaid(source, layout);
        // Kept so laying out again starts from the file's own vertices.
        next.userData.uvLayoutSource = source;
        mesh.geometry = next;
        applied++;
    }
    return applied;
};
