import * as THREE from 'three';
import type { AttachmentData, MuzzleFlashConfig, SocketData, WeaponSettings } from '../types';
import { generatedMuzzleSocketName } from './weapons';

/**
 * A WEAPON'S MUZZLE FROM ITS MODEL
 *
 * A weapon fires from its muzzle socket when it has one. Without one, the engine finds the muzzle
 * on the weapon's model (its muzzle point, else the end of the barrel read from the model's shape)
 * and gives the weapon a socket there, on the bone that holds it, so its shots and flash leave its
 * own barrel rather than another weapon's socket.
 */

type Vec3 = [number, number, number];

/** A weapon model's muzzle in the model's own units: the end of the barrel and the way it points. */
export interface WeaponMuzzle {
    point: Vec3;
    direction: Vec3;
}

/** How deep each end's slice is, as a share of the model's length. */
const END_SLICE = 0.03;
/** Vertices read per model at most (evenly spread over each mesh). */
const MAX_VERTICES = 20000;

const muzzleCache = new WeakMap<THREE.Object3D, Map<string, WeaponMuzzle | null>>();

/** The model's vertices in its own frame (its own transform left out). */
const modelVertices = (model: THREE.Object3D): THREE.Vector3[] => {
    model.updateMatrixWorld(true);
    const toModel = model.matrixWorld.clone().invert();
    const meshes: THREE.Mesh[] = [];
    model.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.isMesh && mesh.geometry?.attributes.position) meshes.push(mesh);
    });
    const total = meshes.reduce((sum, mesh) => sum + mesh.geometry.attributes.position.count, 0);
    const step = Math.max(1, Math.ceil(total / MAX_VERTICES));
    const vertices: THREE.Vector3[] = [];
    for (const mesh of meshes) {
        const position = mesh.geometry.attributes.position;
        const toLocal = toModel.clone().multiply(mesh.matrixWorld);
        for (let i = 0; i < position.count; i += step) vertices.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(toLocal));
    }
    return vertices;
};

/**
 * The muzzle of a weapon model, read from its shape: the barrel runs along the model's longest
 * extent and ends at the end away from `grip` (where the holding hand closes, in the model's
 * units) or, without a grip, at the slimmer end (a stock or a pistol grip makes the other end
 * bulkier). The point is the middle of that end. Null for a model without geometry.
 */
export const findWeaponMuzzle = (model: THREE.Object3D, grip?: readonly number[] | null): WeaponMuzzle | null => {
    const key = grip ? grip.join(',') : '';
    let byGrip = muzzleCache.get(model);
    if (!byGrip) {
        byGrip = new Map();
        muzzleCache.set(model, byGrip);
    }
    if (byGrip.has(key)) return byGrip.get(key) ?? null;

    const vertices = modelVertices(model);
    let muzzle: WeaponMuzzle | null = null;
    if (vertices.length) {
        const box = new THREE.Box3().setFromPoints(vertices);
        const size = box.getSize(new THREE.Vector3()).toArray();
        const along = size.indexOf(Math.max(...size));
        const across = [0, 1, 2].filter(axis => axis !== along);
        const min = box.min.getComponent(along);
        const max = box.max.getComponent(along);
        const depth = (max - min) * END_SLICE;
        // The cross-section of each end: the box of the vertices in its slice, across the barrel.
        const slice = (end: number) => {
            const area = new THREE.Box2();
            for (const vertex of vertices) {
                if (Math.abs(vertex.getComponent(along) - end) <= depth) {
                    area.expandByPoint(new THREE.Vector2(vertex.getComponent(across[0]), vertex.getComponent(across[1])));
                }
            }
            return area;
        };
        const low = slice(min);
        const high = slice(max);
        const areaOf = (area: THREE.Box2) => {
            const extent = area.getSize(new THREE.Vector2());
            return extent.x * extent.y;
        };
        const atMax = grip
            ? Math.abs(max - grip[along]) >= Math.abs(min - grip[along])
            : areaOf(high) < areaOf(low);
        const end = atMax ? high : low;
        const centre = end.getCenter(new THREE.Vector2());
        const point: Vec3 = [0, 0, 0];
        point[along] = atMax ? max : min;
        point[across[0]] = centre.x;
        point[across[1]] = centre.y;
        const direction: Vec3 = [0, 0, 0];
        direction[along] = atMax ? 1 : -1;
        muzzle = { point, direction };
    }
    byGrip.set(key, muzzle);
    return muzzle;
};

/** The flash of a generated muzzle socket: the synthetic flash, briefly. */
export const GENERATED_MUZZLE_FLASH: MuzzleFlashConfig = { enabled: true, textureId: null, scale: 0.6, color: '#ffd38a', duration: 0.05 };

/**
 * The socket `weapon` fires from when it has no muzzle socket: at its model's muzzle (its muzzle
 * point, else the one read from the model), pointing along the barrel, on the bone `attachment`
 * holds it on, placed as the attachment places the model. Null when the weapon has a muzzle socket
 * or no model.
 */
export const weaponMuzzleSocket = (
    weapon: Pick<WeaponSettings, 'id' | 'muzzleSocket' | 'muzzlePoint' | 'gripPoint'>,
    attachment: Pick<AttachmentData, 'object' | 'parentModelId' | 'boneName' | 'position' | 'rotation' | 'scale'> | null | undefined,
): SocketData | null => {
    if (weapon.muzzleSocket || !attachment?.object) return null;
    const found = findWeaponMuzzle(attachment.object, weapon.gripPoint);
    if (!found) return null;
    const point = weapon.muzzlePoint ?? found.point;
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(attachment.rotation.map(value => THREE.MathUtils.degToRad(value)) as Vec3)));
    const placed = new THREE.Matrix4().compose(new THREE.Vector3(...attachment.position), rotation, new THREE.Vector3(...attachment.scale));
    const position = new THREE.Vector3(...point).applyMatrix4(placed);
    const direction = new THREE.Vector3(...found.direction).transformDirection(placed);
    const turn = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction), 'XYZ');
    return {
        id: generatedMuzzleSocketName(weapon.id),
        name: generatedMuzzleSocketName(weapon.id),
        parentModelId: attachment.parentModelId,
        boneName: attachment.boneName,
        position: position.toArray() as Vec3,
        rotation: [turn.x, turn.y, turn.z].map(angle => THREE.MathUtils.radToDeg(angle)) as Vec3,
        scale: [1, 1, 1],
        flashConfig: GENERATED_MUZZLE_FLASH,
    };
};
