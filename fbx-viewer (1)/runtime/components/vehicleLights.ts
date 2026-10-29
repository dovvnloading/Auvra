import * as THREE from 'three';
import type { VehicleLayout } from '../vehicles';

/**
 * A vehicle's lights: lamps on the model found by name (headlights, tail, brake and reversing
 * lights), which glow when lit, and headlight beams that light the road (from the headlight lamps,
 * or the front corners of a model without any). The beams stay in the scene, dark while off:
 * adding or removing a light would make every lit material recompile.
 */

export type LampKind = 'head' | 'tail' | 'brake' | 'reverse';

const LAMP_NAMES: [RegExp, LampKind][] = [
    [/(reverse|reversing|backup|back up) ?(light|lamp)/, 'reverse'],
    [/(brake|stop) ?(light|lamp)/, 'brake'],
    [/(tail|rear) ?(light|lamp)|taillight|taillamp/, 'tail'],
    [/(head|front) ?(light|lamp)|headlight|headlamp/, 'head'],
];

/** The lamp a node's name says it is, or null. */
export const lampKind = (name: string): LampKind | null => {
    const text = name.toLowerCase().replace(/[_.\-]+/g, ' ');
    for (const [pattern, kind] of LAMP_NAMES) if (pattern.test(text)) return kind;
    return null;
};

/** What is lit this frame. */
export interface VehicleLightState {
    head: boolean;
    brake: boolean;
    reverse: boolean;
}

interface Lamp {
    kind: LampKind;
    mesh: THREE.Mesh;
    original: THREE.Material | THREE.Material[];
    materials: THREE.MeshStandardMaterial[];
}

const LAMP_GLOW: Record<LampKind, { color: string; on: number; dim: number }> = {
    head: { color: '#fff4dc', on: 4, dim: 0 },
    // Tail lamps glow dimly with the headlights and brightly when braking.
    tail: { color: '#ff1414', on: 4, dim: 1.2 },
    brake: { color: '#ff1414', on: 4, dim: 0 },
    reverse: { color: '#ffffff', on: 3, dim: 0 },
};

/** Candela: physically falling off, about a dipped headlight's reach. */
const BEAM_INTENSITY = 6000;
const BEAM_DISTANCE = 70;
const BEAM_ANGLE = 0.38;
/** Where the beams aim: this far ahead of the lamps, and this far below them, metres. */
const BEAM_REACH = 25;
const BEAM_DIP = 0.9;

export interface VehicleLights {
    lamps: Lamp[];
    beams: THREE.SpotLight[];
    root: THREE.Group;
    last: VehicleLightState;
}

const toStandard = (material: THREE.Material): THREE.MeshStandardMaterial | null => {
    const standard = material as THREE.MeshStandardMaterial;
    return standard.isMeshStandardMaterial ? standard.clone() : null;
};

/**
 * Builds the lights of the vehicle drawn under `host`: `frame` maps its vehicle frame (+Z forward,
 * +X left) to world space, and `skip` leaves out what is not part of its model.
 */
export const buildVehicleLights = (
    host: THREE.Object3D,
    layout: VehicleLayout,
    frame: THREE.Matrix4,
    skip: (node: THREE.Object3D) => boolean,
    withBeams: boolean,
): VehicleLights => {
    const toVehicle = frame.clone().invert();
    const lamps: Lamp[] = [];
    const heads: THREE.Vector3[] = [];
    const visit = (node: THREE.Object3D, inherited: LampKind | null) => {
        for (const child of node.children) {
            if (skip(child)) continue;
            const kind = lampKind(child.name) ?? inherited;
            const mesh = child as THREE.Mesh;
            if (kind && mesh.isMesh) {
                const originals = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                const copies = originals.map(toStandard);
                if (copies.every((copy): copy is THREE.MeshStandardMaterial => copy !== null)) {
                    lamps.push({ kind, mesh, original: mesh.material, materials: copies });
                    mesh.material = Array.isArray(mesh.material) ? copies : copies[0];
                }
                if (kind === 'head') {
                    const box = new THREE.Box3().setFromObject(mesh).applyMatrix4(toVehicle);
                    if (!box.isEmpty()) heads.push(box.getCenter(new THREE.Vector3()));
                }
            }
            visit(child, kind);
        }
    };
    visit(host, null);

    const chassis = layout.chassis;
    const size = chassis.getSize(new THREE.Vector3());
    const centreX = (chassis.min.x + chassis.max.x) / 2;
    // A beam from each side's headlights, or from the front corners of a model without any.
    const sides = [true, false].map(left => {
        const own = heads.filter(point => (point.x > centreX) === left);
        if (own.length) return own.reduce((sum, point) => sum.add(point), new THREE.Vector3()).divideScalar(own.length);
        return new THREE.Vector3(centreX + (left ? 1 : -1) * size.x * 0.33, chassis.min.y + size.y * 0.32, chassis.max.z);
    });

    const root = new THREE.Group();
    root.name = 'VehicleLights';
    host.add(root);
    host.updateWorldMatrix(true, false);
    const toHost = host.matrixWorld.clone().invert().multiply(frame);
    const beams = withBeams ? sides.map(point => {
        const beam = new THREE.SpotLight('#fff1d6', 0, BEAM_DISTANCE, BEAM_ANGLE, 0.65, 2);
        beam.position.copy(point).applyMatrix4(toHost);
        beam.target.position.copy(point).add(new THREE.Vector3(0, -BEAM_DIP, BEAM_REACH)).applyMatrix4(toHost);
        root.add(beam, beam.target);
        return beam;
    }) : [];
    const lights: VehicleLights = { lamps, beams, root, last: { head: true, brake: true, reverse: true } };
    setVehicleLights(lights, { head: false, brake: false, reverse: false });
    return lights;
};

/** Lights what `state` says; does nothing when it has not changed. */
export const setVehicleLights = (lights: VehicleLights, state: VehicleLightState): void => {
    const last = lights.last;
    if (last.head === state.head && last.brake === state.brake && last.reverse === state.reverse) return;
    lights.last = { ...state };
    for (const lamp of lights.lamps) {
        const glow = LAMP_GLOW[lamp.kind];
        const lit = lamp.kind === 'head' ? state.head
            : lamp.kind === 'reverse' ? state.reverse
                : state.brake;
        const intensity = lit ? glow.on : lamp.kind === 'tail' && state.head ? glow.dim : 0;
        for (const material of lamp.materials) {
            material.emissive.set(intensity > 0 ? glow.color : '#000000');
            material.emissiveIntensity = intensity;
        }
    }
    for (const beam of lights.beams) beam.intensity = state.head ? BEAM_INTENSITY : 0;
};

/** Takes the lights off the vehicle, giving its lamps their own materials back. */
export const disposeVehicleLights = (lights: VehicleLights): void => {
    for (const lamp of lights.lamps) {
        lamp.mesh.material = lamp.original;
        for (const material of lamp.materials) material.dispose();
    }
    for (const beam of lights.beams) beam.dispose();
    lights.root.removeFromParent();
};
