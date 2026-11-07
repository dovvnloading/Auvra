import { Blob as NodeBlob } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createMaterialGraph, type MaterialGraph } from '../../runtime/materials/materialGraph';
import { tileAtlasLayout } from '../../texturing/materialOutput';
import { buildPartMesh } from '../../texturing/mesh/partMesh';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { atlasMesh, atlasUvs, markPaintedMaterials, surfaceOfGraph, withPaintedMaterials, writePaintedGlb, type GltfPictures } from '../../texturing/paint/gltfExport';
import { readGlb } from '../../utils/gltfContainer';
import { loadModelFile } from '../../utils/modelLoader';

/** A material document using every physical part, its coat wired from a Number node. */
const physicalGraph = (): MaterialGraph => {
    const graph = createMaterialGraph();
    Object.assign(graph.nodes[0].params, {
        coatRoughness: 0.2, sheenColor: [0.5, 0.4, 0.3], sheenRoughness: 0.3, transmission: 0.6, thickness: 0.5, attenuationColor: [0.9, 0.8, 0.7],
        specularWeight: 0.7, specularColor: [1, 0.9, 0.8], ior: 1.45, thinFilm: 0.9, thinFilmThickness: 500, emissiveStrength: 3,
    });
    graph.nodes.push({ id: 'coat', type: 'float', x: 0, y: 0, params: { value: 0.8 } });
    graph.links.push({ fromNode: 'coat', fromOutput: 'out', toNode: 'output', toInput: 'coat' });
    return graph;
};

/** The start of a PNG file 4 pixels across, tagged so each picture can be told apart (nothing here decodes pictures). */
const png = (tag: number): Uint8Array => {
    const bytes = new Uint8Array(33);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, 4);
    view.setUint32(20, 4);
    bytes[32] = tag;
    return bytes;
};

const plane = () => {
    const material = new THREE.MeshStandardMaterial();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    return buildPartMesh(mesh, new Set([material]), { udim: false });
};

describe('a painted set as glTF', () => {
    it('takes the material document\'s values and the KHR extensions it uses', () => {
        const surface = surfaceOfGraph(physicalGraph(), 'Painted', new Set(['baseColor', 'roughness', 'metallic']));
        expect(surface.baseColor).toEqual([1, 1, 1]);
        expect(surface.metalness).toBe(1);
        expect(surface.extensions.KHR_materials_clearcoat).toEqual({ clearcoatFactor: 0.8, clearcoatRoughnessFactor: 0.2 });
        expect(Object.keys(surface.extensions).sort()).toEqual([
            'KHR_materials_clearcoat', 'KHR_materials_emissive_strength', 'KHR_materials_ior', 'KHR_materials_iridescence', 'KHR_materials_sheen',
            'KHR_materials_specular', 'KHR_materials_transmission', 'KHR_materials_volume',
        ]);
        // A plain material uses none; its own colour and values stand where nothing is painted.
        const plain = createMaterialGraph();
        Object.assign(plain.nodes[0].params, { baseColor: [0.2, 0.3, 0.4], roughness: 0.25 });
        const flat = surfaceOfGraph(plain, 'Plain', new Set());
        expect(flat.extensions).toEqual({});
        expect(flat.baseColor).toEqual([0.2, 0.3, 0.4]);
        expect(flat.roughness).toBe(0.25);
        expect(flat.alphaMode).toBe('OPAQUE');
        expect(surfaceOfGraph(plain, 'Cut out', new Set(['opacity'])).alphaMode).toBe('MASK');
    });

    it('moves a UDIM set\'s corners into their tiles\' cells on one atlas', () => {
        const layout = tileAtlasLayout([1001, 1002], 64, 4096);
        const part = {
            positions: new Float32Array(9 * 2), normals: null, tangents: null,
            // Two triangles sharing the vertex at u = 1, one in each tile.
            uvs: new Float32Array([0, 0, 1, 0, 0, 1, 2, 0, 1, 1]),
            indices: new Uint32Array([0, 1, 2, 1, 3, 4]),
            triangleTile: new Uint16Array([1001, 1002]),
            triangleShift: new Int16Array([0, 0, 1, 0]),
        };
        const mesh = atlasMesh(part, layout);
        // The shared corner is split: once at the right edge of the first cell, once at the left of the second.
        expect(mesh.positions.length / 3).toBe(6);
        const stride = layout.cell + 2 * layout.gutter;
        const width = layout.columns * stride;
        const height = layout.rows * stride;
        const uv = (corner: number) => [mesh.uvs[corner * 2], mesh.uvs[corner * 2 + 1]];
        expect(uv(mesh.indices[1])).toEqual([Math.fround((layout.gutter + layout.cell) / width), Math.fround(layout.gutter / height)]);
        expect(uv(mesh.indices[3])).toEqual([Math.fround((stride + layout.gutter) / width), Math.fround(layout.gutter / height)]);
    });

    it('is opened again by the importer with its mesh, maps and extensions', async () => {
        const part = plane();
        const surface = surfaceOfGraph(physicalGraph(), 'Painted', new Set(['baseColor', 'opacity', 'roughness', 'metallic', 'ambientOcclusion', 'normal', 'emissive']));
        const pictures: GltfPictures = {
            baseColor: png(1),
            orm: { png: png(2), occlusion: true, metallicRoughness: true },
            normal: png(3),
            emissive: png(4),
        };
        const glb = writePaintedGlb({ name: 'Crate_Body', mesh: part, surface: { ...surface, roughness: 1, metalness: 1 }, pictures });
        const { json } = readGlb(glb);
        expect(json.extensionsUsed).toContain('KHR_materials_sheen');
        expect((json as { images?: unknown[] }).images).toHaveLength(4);

        // Nothing here decodes pictures: each is handed back as its size, its bytes kept to look at. The
        // loader's pictures go through blob URLs, which keep their bytes only as Node's own blobs.
        vi.stubGlobal('Blob', NodeBlob);
        const decoded: Uint8Array[] = [];
        vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
            const bytes = new Uint8Array(await blob.arrayBuffer());
            decoded.push(bytes);
            const view = new DataView(bytes.buffer);
            return { width: view.getUint32(16), height: view.getUint32(20), close: () => undefined };
        });
        try {
            const model = await loadModelFile(new File([glb], 'Crate_Body.glb', { type: 'model/gltf-binary' }), { normalize: false, compressTextures: false });
            const meshes: THREE.Mesh[] = [];
            model.object.traverse((node) => { if ((node as THREE.Mesh).isMesh) meshes.push(node as THREE.Mesh); });
            const mesh = meshes[0];
            expect(mesh.geometry.attributes.position.count).toBe(part.positions.length / 3);
            expect(Array.from(mesh.geometry.attributes.uv.array)).toEqual(Array.from(part.uvs));
            expect(mesh.geometry.index?.count).toBe(part.indices.length);
            const material = mesh.material as THREE.MeshPhysicalMaterial;
            expect(material.isMeshPhysicalMaterial).toBe(true);
            // The painted maps, each where glTF puts it.
            expect(material.map).toBeTruthy();
            expect(material.normalMap).toBeTruthy();
            expect(material.emissiveMap).toBeTruthy();
            expect(material.roughnessMap).toBe(material.metalnessMap);
            expect(material.aoMap).toBe(material.roughnessMap);
            expect(material.alphaTest).toBeCloseTo(0.5);
            expect(decoded).toHaveLength(4);
            expect(decoded.map((bytes) => bytes[32]).sort()).toEqual([1, 2, 3, 4]);
            expect((material.map?.image as { width: number }).width).toBe(4);
            // The physical parts.
            expect(material.clearcoat).toBeCloseTo(0.8);
            expect(material.clearcoatRoughness).toBeCloseTo(0.2);
            expect(material.sheen).toBe(1);
            expect(material.sheenColor.toArray()).toEqual([0.5, 0.4, 0.3].map((value) => expect.closeTo(value, 5)));
            expect(material.sheenRoughness).toBeCloseTo(0.3);
            expect(material.transmission).toBeCloseTo(0.6);
            expect(material.thickness).toBeCloseTo(0.5);
            expect(material.specularIntensity).toBeCloseTo(0.7);
            expect(material.ior).toBeCloseTo(1.45);
            expect(material.iridescence).toBeCloseTo(0.9);
            expect(material.iridescenceThicknessRange[1]).toBeCloseTo(500);
            expect(material.emissiveIntensity).toBeCloseTo(3);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('exports the whole model: every material, painted ones filled in, with its skin and clips, and opens again', async () => {
        // A rigged body wearing a painted material, and a hat in a plain one.
        const root = new THREE.Group();
        root.name = 'Hero';
        const hips = new THREE.Bone();
        hips.name = 'Hips';
        const spine = new THREE.Bone();
        spine.name = 'Spine';
        spine.position.y = 0.5;
        hips.add(spine);
        root.add(hips);
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const count = geometry.attributes.position.count;
        geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
        const weights = new Float32Array(count * 4);
        for (let v = 0; v < count; v++) weights[v * 4] = 1;
        geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
        const body = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({ name: 'Skin' }));
        body.name = 'Body';
        root.add(body);
        body.bind(new THREE.Skeleton([hips, spine]));
        const hat = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.6), new THREE.MeshStandardMaterial({ name: 'Felt', color: 0xff0000 }));
        hat.name = 'Hat';
        hat.position.y = 1;
        root.add(hat);
        root.animations = [new THREE.AnimationClip('Wave', 1, [new THREE.QuaternionKeyframeTrack('Spine.quaternion', [0, 1], [0, 0, 0, 1, 0, 0.7071, 0, 0.7071])])];

        const copy = cloneSkinned(root);
        copy.animations = root.animations;
        expect([...markPaintedMaterials(copy, (material) => (material.name === 'Skin' ? 'open' : null))]).toEqual(['open']);
        const exported = await new GLTFExporter().parseAsync(copy, { binary: true, animations: copy.animations, onlyVisible: false }) as ArrayBuffer;
        const surface = surfaceOfGraph(physicalGraph(), 'Skin (painted)', new Set(['baseColor', 'roughness', 'metallic', 'normal']));
        const glb = withPaintedMaterials(exported, new Map([['open', { name: 'Hero_Skin', surface: { ...surface, roughness: 1, metalness: 1 }, pictures: { baseColor: png(5), orm: { png: png(6), occlusion: false, metallicRoughness: true }, normal: png(7) } }]]));

        vi.stubGlobal('Blob', NodeBlob);
        vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
            const view = new DataView(await blob.arrayBuffer());
            return { width: view.getUint32(16), height: view.getUint32(20), close: () => undefined };
        });
        try {
            const model = await loadModelFile(new File([glb], 'Hero.glb', { type: 'model/gltf-binary' }), { normalize: false, compressTextures: false });
            const meshes: THREE.Mesh[] = [];
            model.object.traverse((node) => { if ((node as THREE.Mesh).isMesh) meshes.push(node as THREE.Mesh); });
            const skinned = meshes.find((mesh) => (mesh as THREE.SkinnedMesh).isSkinnedMesh) as THREE.SkinnedMesh;
            expect(skinned.skeleton.bones.map((bone) => bone.name).sort()).toEqual(['Hips', 'Spine']);
            expect(model.animations.map((clip) => clip.tracks.length)).toEqual([1]);
            const skin = skinned.material as THREE.MeshPhysicalMaterial;
            expect(skin.name).toBe('Skin');
            expect(skin.map).toBeTruthy();
            expect(skin.normalMap).toBeTruthy();
            expect(skin.roughnessMap).toBe(skin.metalnessMap);
            expect(skin.clearcoat).toBeCloseTo(0.8);
            const felt = meshes.find((mesh) => mesh !== skinned)!.material as THREE.MeshStandardMaterial;
            expect(felt.name).toBe('Felt');
            expect(felt.map).toBeNull();
            expect(felt.color.r).toBeCloseTo(1);
            expect(felt.color.g).toBeCloseTo(0);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('moves the texture coordinates of a UDIM set onto its atlas vertex by vertex', () => {
        const layout = tileAtlasLayout([1001, 1002], 64, 4096);
        const stride = layout.cell + 2 * layout.gutter;
        const uvs = atlasUvs([0.5, 0.5, 1.5, 0.25], layout);
        expect(uvs[0]).toBeCloseTo((layout.gutter + 0.5 * layout.cell) / (layout.columns * stride), 6);
        expect(uvs[2]).toBeCloseTo((stride + layout.gutter + 0.5 * layout.cell) / (layout.columns * stride), 6);
        expect(uvs[3]).toBeCloseTo((layout.gutter + 0.25 * layout.cell) / (layout.rows * stride), 6);
    });
});
