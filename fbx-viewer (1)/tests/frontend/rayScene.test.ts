import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
    INSTANCE_NO_SHADOW,
    INSTANCE_ONE_WAY,
    MATERIAL_TWO_SIDED,
    MATERIAL_UNLIT,
    RayScene,
    coarseGridIndices,
    geometryTriangles,
    keepSlots,
    rayMaterialFor,
    raysSeeMaterial,
    simplifyTriangles,
} from '../../runtime/raytracing/rayScene';

const everything = () => true;
const white = (): [number, number, number] => [1, 1, 1];

const material = () => new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });

const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** A level's worth of variety: scaled, turned and nested meshes, shared geometry, and instances. */
const levelScene = (): THREE.Scene => {
    const scene = new THREE.Scene();
    const box = new THREE.BoxGeometry(1, 2, 3);
    const ball = new THREE.SphereGeometry(1.5, 12, 8);
    const next = random(11);
    for (let index = 0; index < 40; index++) {
        const mesh = new THREE.Mesh(index % 2 ? box : ball, material());
        mesh.position.set(next() * 60 - 30, next() * 20, next() * 60 - 30);
        mesh.rotation.set(next() * 3, next() * 3, next() * 3);
        mesh.scale.set(0.5 + next() * 2, 0.5 + next() * 2, 0.5 + next() * 2);
        const parent = new THREE.Group();
        parent.rotation.y = next();
        parent.position.y = next() * 2;
        parent.add(mesh);
        scene.add(parent);
    }
    const crates = new THREE.InstancedMesh(box, material(), 50);
    const dummy = new THREE.Object3D();
    for (let index = 0; index < 50; index++) {
        dummy.position.set(next() * 60 - 30, next() * 20, next() * 60 - 30);
        dummy.rotation.set(next() * 3, next() * 3, 0);
        dummy.scale.setScalar(0.5 + next());
        dummy.updateMatrix();
        crates.setMatrixAt(index, dummy.matrix);
    }
    crates.instanceMatrix.needsUpdate = true;
    scene.add(crates);
    scene.updateMatrixWorld(true);
    return scene;
};

/** Compares what the ray scene finds with what three's own raycaster finds. */
const compareWithRaycaster = (scene: THREE.Scene, rays: RayScene, count: number, seed: number): number => {
    const next = random(seed);
    const caster = new THREE.Raycaster();
    let hits = 0;
    for (let ray = 0; ray < count; ray++) {
        const origin = new THREE.Vector3(next() * 80 - 40, next() * 30 - 5, next() * 80 - 40);
        const direction = new THREE.Vector3(next() - 0.5, next() - 0.5, next() - 0.5).normalize();
        caster.set(origin, direction);
        const expected = caster.intersectObject(scene, true)[0];
        const found = rays.closestHit(origin, direction);
        if (expected) {
            hits++;
            expect(found).not.toBeNull();
            expect(found!.distance).toBeCloseTo(expected.distance, 2);
        } else {
            expect(found).toBeNull();
        }
    }
    return hits;
};

describe('what rays meet', () => {
    it('finds what the raycaster finds, through shared geometry, nesting, scale and instances', () => {
        const scene = levelScene();
        const rays = new RayScene();
        rays.settle(scene, everything, white);
        expect(rays.stats.instances).toBe(90);
        // Two geometries, however many objects use them.
        expect(rays.stats.meshes).toBe(2);
        expect(compareWithRaycaster(scene, rays, 1500, 21)).toBeGreaterThan(100);
    });

    it('turns normals with the object, against the ray', () => {
        const scene = new THREE.Scene();
        const wall = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), material());
        wall.rotation.y = Math.PI / 2;
        wall.scale.set(3, 1, 1);
        scene.add(wall);
        scene.updateMatrixWorld(true);
        const rays = new RayScene();
        rays.settle(scene, everything, white);
        const hit = rays.closestHit(new THREE.Vector3(5, 0, 0), new THREE.Vector3(-1, 0, 0))!;
        expect(hit.distance).toBeCloseTo(5);
        expect(hit.normal.x).toBeCloseTo(1);
        expect(hit.front).toBe(true);
        const behind = rays.closestHit(new THREE.Vector3(-5, 0, 0), new THREE.Vector3(1, 0, 0))!;
        expect(behind.front).toBe(false);
    });

    it('sees through a character box from inside it, and not from outside', () => {
        const scene = new THREE.Scene();
        const bones = [new THREE.Bone(), new THREE.Bone()];
        bones[1].position.y = 2;
        bones[0].add(bones[1]);
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const character = new THREE.SkinnedMesh(geometry, material());
        character.add(bones[0]);
        character.bind(new THREE.Skeleton(bones));
        scene.add(character);
        scene.updateMatrixWorld(true);
        const rays = new RayScene();
        rays.settle(scene, everything, white);
        expect(rays.stats.instances).toBe(1);
        expect(rays.closestHit(new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0))).toBeNull();
        const outside = rays.closestHit(new THREE.Vector3(5, 1, 0), new THREE.Vector3(-1, 0, 0));
        expect(outside).not.toBeNull();
        expect(outside!.distance).toBeLessThan(5);
    });

    it('takes one box for all the meshes of one character, skeleton each or not', () => {
        const scene = new THREE.Scene();
        const hips = new THREE.Bone();
        const spine = new THREE.Bone();
        hips.add(spine);
        for (let part = 0; part < 3; part++) {
            const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 1, 1), material());
            // As some loaders do: every mesh its own skeleton, over the same bones.
            mesh.bind(new THREE.Skeleton([hips, spine]));
            scene.add(mesh);
        }
        scene.add(hips);
        scene.updateMatrixWorld(true);
        const rays = new RayScene();
        rays.settle(scene, everything, white);
        expect(rays.stats.instances).toBe(1);
    });

    it('does not lay everything out again for a character of several materials', () => {
        const scene = new THREE.Scene();
        const bone = new THREE.Bone();
        const skeleton = new THREE.Skeleton([bone]);
        for (let part = 0; part < 2; part++) {
            const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 1, 1), material());
            mesh.bind(skeleton);
            scene.add(mesh);
        }
        scene.add(bone);
        const rays = new RayScene();
        scene.updateMatrixWorld(true);
        for (let frame = 0; frame < 20; frame++) rays.update(scene, everything, white, Infinity);
        const version = rays.sceneNodes.texture.version;
        for (let frame = 0; frame < 45; frame++) rays.update(scene, everything, white, Infinity);
        expect(rays.sceneNodes.texture.version).toBe(version);
    });

    it('takes one box for all the meshes on one skeleton', () => {
        const scene = new THREE.Scene();
        const bone = new THREE.Bone();
        const skeleton = new THREE.Skeleton([bone]);
        for (let part = 0; part < 3; part++) {
            const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 1, 1), material());
            mesh.bind(skeleton);
            scene.add(mesh);
        }
        scene.add(bone);
        scene.updateMatrixWorld(true);
        const rays = new RayScene();
        rays.settle(scene, everything, white);
        expect(rays.stats.instances).toBe(1);
        expect(INSTANCE_ONE_WAY).toBeGreaterThan(0);
    });

    it('sees nothing in a scene with nothing in it', () => {
        const rays = new RayScene();
        rays.settle(new THREE.Scene(), everything, white);
        expect(rays.closestHit(new THREE.Vector3(), new THREE.Vector3(1, 0, 0))).toBeNull();
    });

    it('leaves out what is hidden, and what the filter turns down', () => {
        const scene = new THREE.Scene();
        const shown = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material());
        const hidden = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material());
        hidden.visible = false;
        const parentHidden = new THREE.Group();
        parentHidden.visible = false;
        parentHidden.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material()));
        const refused = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material());
        refused.userData.refused = true;
        scene.add(shown, hidden, parentHidden, refused);
        scene.updateMatrixWorld(true);
        const rays = new RayScene();
        rays.settle(scene, mesh => !mesh.userData.refused, white);
        expect(rays.stats.instances).toBe(1);
    });
});

describe('keeping up with a level', () => {
    const frames = (rays: RayScene, scene: THREE.Scene, count: number) => {
        for (let frame = 0; frame < count; frame++) {
            scene.updateMatrixWorld(true);
            rays.update(scene, everything, white, Infinity);
        }
    };

    it('follows what moves, a frame later', () => {
        const scene = new THREE.Scene();
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material());
        scene.add(mesh);
        const rays = new RayScene();
        frames(rays, scene, 3);
        const origin = new THREE.Vector3(0, 0, 10);
        const toward = new THREE.Vector3(0, 0, -1);
        expect(rays.closestHit(origin, toward)!.distance).toBeCloseTo(9);
        mesh.position.z = 4;
        frames(rays, scene, 1);
        expect(rays.closestHit(origin, toward)!.distance).toBeCloseTo(5);
        mesh.position.x = 100;
        frames(rays, scene, 1);
        expect(rays.closestHit(origin, toward)).toBeNull();
    });

    it('follows instances that move, and a changed count', () => {
        const scene = new THREE.Scene();
        const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 2, 2), material(), 4);
        const place = (index: number, x: number) => {
            mesh.setMatrixAt(index, new THREE.Matrix4().makeTranslation(x, 0, 0));
            mesh.instanceMatrix.needsUpdate = true;
        };
        for (let index = 0; index < 4; index++) place(index, index * 10);
        scene.add(mesh);
        const rays = new RayScene();
        frames(rays, scene, 3);
        const origin = new THREE.Vector3(30, 0, 10);
        const toward = new THREE.Vector3(0, 0, -1);
        expect(rays.closestHit(origin, toward)).not.toBeNull();
        place(3, 500);
        frames(rays, scene, 1);
        expect(rays.closestHit(origin, toward)).toBeNull();
        expect(rays.closestHit(new THREE.Vector3(500, 0, 10), toward)).not.toBeNull();
        mesh.count = 2;
        frames(rays, scene, 16);
        expect(rays.stats.instances).toBe(2);
        expect(rays.closestHit(new THREE.Vector3(500, 0, 10), toward)).toBeNull();
    });

    it('takes in what is added and lets go of what is removed', () => {
        const scene = new THREE.Scene();
        const rays = new RayScene();
        frames(rays, scene, 2);
        const origin = new THREE.Vector3(0, 0, 10);
        const toward = new THREE.Vector3(0, 0, -1);
        expect(rays.closestHit(origin, toward)).toBeNull();
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material());
        scene.add(mesh);
        frames(rays, scene, 17);
        expect(rays.closestHit(origin, toward)).not.toBeNull();
        scene.remove(mesh);
        frames(rays, scene, 16);
        expect(rays.closestHit(origin, toward)).toBeNull();
    });

    it('builds a new tree when a mesh changes shape', () => {
        const scene = new THREE.Scene();
        const geometry = new THREE.PlaneGeometry(2, 2);
        const mesh = new THREE.Mesh(geometry, material());
        scene.add(mesh);
        const rays = new RayScene();
        frames(rays, scene, 2);
        const origin = new THREE.Vector3(0, 0, 10);
        const toward = new THREE.Vector3(0, 0, -1);
        expect(rays.closestHit(origin, toward)!.distance).toBeCloseTo(10);
        const position = geometry.getAttribute('position') as THREE.BufferAttribute;
        for (let vertex = 0; vertex < position.count; vertex++) position.setZ(vertex, 3);
        position.needsUpdate = true;
        frames(rays, scene, 32);
        expect(rays.closestHit(origin, toward)!.distance).toBeCloseTo(7);
    });

    it('does not take an object that has not moved for one that has', () => {
        const scene = new THREE.Scene();
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material());
        // Values a 32-bit float cannot hold exactly, as most positions and every turned object have.
        mesh.position.set(1.1, 2.2, 3.3);
        mesh.rotation.x = -Math.PI / 2;
        scene.add(mesh);
        const rays = new RayScene();
        frames(rays, scene, 20);
        const version = rays.sceneNodes.texture.version;
        frames(rays, scene, 10);
        expect(rays.sceneNodes.texture.version).toBe(version);
    });

    it('does not send a material\'s colour again when it has not changed', () => {
        const scene = new THREE.Scene();
        // Colours a 32-bit float cannot hold exactly.
        scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: new THREE.Color(0.1, 0.2, 0.3) })));
        const rays = new RayScene();
        frames(rays, scene, 20);
        const version = rays.materials.texture.version;
        frames(rays, scene, 45);
        expect(rays.materials.texture.version).toBe(version);
    });

    it('keeps a mesh in sight all through a change of shape on every frame, and only holds on to two shapes', () => {
        const scene = new THREE.Scene();
        const geometry = new THREE.PlaneGeometry(2, 2);
        const mesh = new THREE.Mesh(geometry, material());
        mesh.position.z = -1;
        scene.add(mesh);
        const rays = new RayScene();
        frames(rays, scene, 2);
        const origin = new THREE.Vector3(0, 0, 10);
        const toward = new THREE.Vector3(0, 0, -1);
        const position = geometry.getAttribute('position') as THREE.BufferAttribute;
        let largest = 0;
        for (let frame = 0; frame < 120; frame++) {
            for (let vertex = 0; vertex < position.count; vertex++) position.setZ(vertex, frame * 0.01);
            position.needsUpdate = true;
            frames(rays, scene, 1);
            expect(rays.closestHit(origin, toward)).not.toBeNull();
            largest = Math.max(largest, rays.stats.meshes);
        }
        expect(largest).toBeLessThanOrEqual(2);
        // It catches up with the last shape once the changes stop.
        frames(rays, scene, 32);
        expect(rays.closestHit(origin, toward)!.distance).toBeCloseTo(10 + 1 - 1.19, 1);
    });

    it('still finds everything after dead trees are cleared away', () => {
        const scene = levelScene();
        const rays = new RayScene();
        for (let frame = 0; frame < 3; frame++) rays.update(scene, everything, white, Infinity);
        // Many short-lived meshes, each with its own geometry, come and go.
        for (let round = 0; round < 6; round++) {
            const temporary = Array.from({ length: 8 }, () => new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), material()));
            for (const mesh of temporary) {
                mesh.position.set(1000, 1000, 1000);
                scene.add(mesh);
            }
            frames(rays, scene, 30);
            for (const mesh of temporary) scene.remove(mesh);
            frames(rays, scene, 320);
        }
        expect(rays.stats.meshes).toBeLessThanOrEqual(3);
        expect(compareWithRaycaster(scene, rays, 1000, 31)).toBeGreaterThan(60);
    });
});

describe('one geometry, used in different ways', () => {
    it('builds a tree for each way of drawing it, so slots never read the wrong material', () => {
        const scene = new THREE.Scene();
        const box = new THREE.BoxGeometry(1, 1, 1);
        const slotted = new THREE.Mesh(box, Array.from({ length: 6 }, () => material()));
        const single = new THREE.Mesh(box, material());
        single.position.x = 5;
        scene.add(slotted, single);
        scene.updateMatrixWorld(true);
        const rays = new RayScene();
        rays.settle(scene, everything, white);
        expect(rays.stats.meshes).toBe(2);
        const hit = rays.closestHit(new THREE.Vector3(5, 0, 5), new THREE.Vector3(0, 0, -1))!;
        expect(hit.material).toBe(6);
    });

    it('lets light through a window in the same mesh as its wall', () => {
        const scene = new THREE.Scene();
        const box = new THREE.BoxGeometry(1, 1, 1);
        // Slot 4 is the +z face.
        const materials = Array.from({ length: 6 }, () => material());
        materials[4] = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.1 });
        scene.add(new THREE.Mesh(box, materials));
        scene.updateMatrixWorld(true);
        const rays = new RayScene();
        rays.settle(scene, everything, white);
        // In through where the +z face would be, to the -z face behind it.
        expect(rays.closestHit(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1))!.distance).toBeCloseTo(5.5);
    });

    it('drops only the slots it should', () => {
        const triangles = geometryTriangles(new THREE.BoxGeometry(1, 1, 1), true)!;
        expect(keepSlots(triangles, [true, true, true, true, false, true]).count).toBe(10);
        expect(keepSlots(triangles, [true, true, true, true, true, true])).toBe(triangles);
    });
});

describe('what stops a shadow', () => {
    const flagsOf = (rays: RayScene, instance: number) => rays.instances.data[instance * 16 + 14];

    it('marks what casts no shadow when drawn', () => {
        const scene = new THREE.Scene();
        const casting = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material());
        casting.castShadow = true;
        const not = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material());
        not.castShadow = false;
        not.position.x = 5;
        scene.add(casting, not);
        scene.updateMatrixWorld(true);
        const rays = new RayScene();
        rays.settle(scene, everything, white);
        const flags = [flagsOf(rays, 0), flagsOf(rays, 1)].sort();
        expect(flags).toEqual([0, INSTANCE_NO_SHADOW]);
    });

    it('follows a change of mind', () => {
        const scene = new THREE.Scene();
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material());
        mesh.castShadow = true;
        scene.add(mesh);
        const rays = new RayScene();
        rays.settle(scene, everything, white);
        expect(flagsOf(rays, 0)).toBe(0);
        mesh.castShadow = false;
        rays.settle(scene, everything, white);
        expect(flagsOf(rays, 0)).toBe(INSTANCE_NO_SHADOW);
    });
});

describe('what a mesh gives the tree', () => {
    it('reads indexed and plain geometry alike, and each group\'s material', () => {
        const box = new THREE.BoxGeometry(1, 1, 1);
        const indexed = geometryTriangles(box, true)!;
        const plain = geometryTriangles(box.toNonIndexed(), true)!;
        expect(indexed.count).toBe(12);
        expect(plain.count).toBe(12);
        expect(indexed.slots[0]).toBe(0);
        expect(indexed.slots[11]).toBe(5);
        expect(geometryTriangles(box, false)!.slots[11]).toBe(0);
    });

    it('has nothing to give without positions', () => {
        expect(geometryTriangles(new THREE.BufferGeometry(), false)).toBeNull();
    });

    it('simplifies a dense mesh to about the size asked, keeping its extent', () => {
        const dense = geometryTriangles(new THREE.SphereGeometry(10, 256, 128), false)!;
        expect(dense.count).toBeGreaterThan(50000);
        const light = simplifyTriangles(dense, 4000);
        expect(light.count).toBeLessThanOrEqual(4000);
        expect(light.count).toBeGreaterThan(500);
        let far = 0;
        for (let at = 0; at < light.count * 9; at += 3) far = Math.max(far, Math.hypot(light.positions[at], light.positions[at + 1], light.positions[at + 2]));
        expect(far).toBeGreaterThan(9);
        expect(far).toBeLessThan(10.01);
    });

    it('leaves alone a mesh already small enough', () => {
        const small = geometryTriangles(new THREE.BoxGeometry(1, 1, 1), false)!;
        expect(simplifyTriangles(small, 100)).toBe(small);
    });

    it('makes a coarse grid that still reaches the far corner', () => {
        const indices = coarseGridIndices(100, 100, 7);
        expect(indices.length).toBe(15 * 15 * 6);
        expect(Math.max(...indices)).toBe(101 * 101 - 1);
        expect(Math.min(...indices)).toBe(0);
        const plane = new THREE.PlaneGeometry(10, 10, 100, 100);
        const triangles = geometryTriangles(plane, false, indices)!;
        expect(triangles.count).toBe(15 * 15 * 2);
    });
});

describe('what a material gives rays', () => {
    it('takes its colour times its map, as drawn', () => {
        const map = new THREE.Texture();
        const look = rayMaterialFor(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.5, 0.25, 1), map }), () => [0.5, 1, 0.5]);
        expect(look.albedo[0]).toBeCloseTo(0.25);
        expect(look.albedo[1]).toBeCloseTo(0.25);
        expect(look.albedo[2]).toBeCloseTo(0.5);
        expect(look.flags).toBe(0);
    });

    it('takes what it gives off', () => {
        const look = rayMaterialFor(new THREE.MeshStandardMaterial({ emissive: new THREE.Color(1, 0.5, 0), emissiveIntensity: 4 }), white);
        expect(look.emissive).toEqual([4, 2, 0]);
    });

    it('marks what draws unlit, and what draws from both sides', () => {
        expect(rayMaterialFor(new THREE.MeshBasicMaterial(), white).flags & MATERIAL_UNLIT).toBeTruthy();
        expect(rayMaterialFor(new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }), white).flags & MATERIAL_TWO_SIDED).toBeTruthy();
    });

    it('takes a colour a shader-painted surface says it averages to', () => {
        const ground = new THREE.MeshStandardMaterial();
        ground.userData.rayAlbedo = new THREE.Color(0.1, 0.3, 0.05);
        expect(rayMaterialFor(ground, white).albedo[1]).toBeCloseTo(0.3);
    });

    it('sees solid things only', () => {
        expect(raysSeeMaterial(new THREE.MeshStandardMaterial())).toBe(true);
        expect(raysSeeMaterial(new THREE.MeshBasicMaterial())).toBe(true);
        expect(raysSeeMaterial(new THREE.MeshStandardMaterial({ wireframe: true }))).toBe(false);
        expect(raysSeeMaterial(new THREE.MeshStandardMaterial({ visible: false }))).toBe(false);
        expect(raysSeeMaterial(new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.2 }))).toBe(false);
        expect(raysSeeMaterial(new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.9 }))).toBe(true);
        expect(raysSeeMaterial(new THREE.MeshPhysicalMaterial({ transmission: 1 }))).toBe(false);
        expect(raysSeeMaterial(new THREE.ShaderMaterial())).toBe(false);
    });
});
