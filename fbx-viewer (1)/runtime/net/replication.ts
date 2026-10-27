import * as THREE from 'three';
import type { NetEntityState, NetVec3 } from './protocol';

/**
 * REPLICATION
 *
 * Remote entities are drawn a little in the past (the interpolation delay) between the two states
 * that straddle that moment, so 20 states a second look smooth. When states stop arriving the entity
 * keeps moving along its last velocity for at most MAX_EXTRAPOLATION_MS, then holds.
 */

export const DEFAULT_INTERPOLATION_DELAY_MS = 100;
export const MAX_EXTRAPOLATION_MS = 200;
/** States older than this behind the newest are dropped. */
export const BUFFER_SPAN_MS = 1000;

interface Sample {
    time: number;
    state: NetEntityState;
}

export interface InterpolationBuffer {
    /** Adds a state taken at `time` (relay clock, ms); out-of-order states are put in place. */
    push(time: number, state: NetEntityState): void;
    /** The entity as it was at `renderTime - delay`, or null before the first state. */
    sample(renderTime: number): NetEntityState | null;
    /** Relay time of the newest state, or -Infinity. */
    newest(): number;
}

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _euler = new THREE.Euler();

const lerpVec = (a: NetVec3, b: NetVec3, t: number): NetVec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Rotation between two Euler XYZ rotations along the shortest arc. */
export const slerpEuler = (a: NetVec3, b: NetVec3, t: number): NetVec3 => {
    _qa.setFromEuler(_euler.set(a[0], a[1], a[2]));
    _qb.setFromEuler(_euler.set(b[0], b[1], b[2]));
    _qa.slerp(_qb, t);
    _euler.setFromQuaternion(_qa);
    return [_euler.x, _euler.y, _euler.z];
};

export const createInterpolationBuffer = (delayMs: number = DEFAULT_INTERPOLATION_DELAY_MS): InterpolationBuffer => {
    const samples: Sample[] = [];
    return {
        push(time, state) {
            let index = samples.length;
            while (index > 0 && samples[index - 1].time > time) index--;
            samples.splice(index, 0, { time, state });
            const cutoff = samples[samples.length - 1].time - BUFFER_SPAN_MS;
            while (samples.length > 2 && samples[0].time < cutoff) samples.shift();
        },
        newest: () => (samples.length ? samples[samples.length - 1].time : -Infinity),
        sample(renderTime) {
            if (!samples.length) return null;
            const target = renderTime - delayMs;
            const first = samples[0];
            const last = samples[samples.length - 1];
            if (target <= first.time) return first.state;
            if (target >= last.time) {
                const ahead = Math.min(target - last.time, MAX_EXTRAPOLATION_MS) / 1000;
                const velocity = last.state.velocity;
                if (!velocity || ahead <= 0) return last.state;
                return {
                    ...last.state,
                    position: [last.state.position[0] + velocity[0] * ahead, last.state.position[1] + velocity[1] * ahead, last.state.position[2] + velocity[2] * ahead],
                };
            }
            let index = samples.length - 1;
            while (index > 0 && samples[index - 1].time > target) index--;
            const before = samples[index - 1];
            const after = samples[index];
            const span = after.time - before.time;
            const t = span > 0 ? (target - before.time) / span : 1;
            return {
                id: after.state.id,
                position: lerpVec(before.state.position, after.state.position, t),
                rotation: slerpEuler(before.state.rotation, after.state.rotation, t),
                ...(after.state.velocity ? { velocity: after.state.velocity } : {}),
                ...(before.state.vars ? { vars: before.state.vars } : {}),
            };
        },
    };
};

/**
 * Level objects the host replicates (netSync components) register here while this peer is host; the
 * local replicator sends whatever is registered with the player's own state.
 */
export const netSyncOutbox = new Map<string, () => NetEntityState | null>();

const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();

/** An object's world position and Euler XYZ rotation as an entity state. */
export const entityStateOf = (id: string, object: THREE.Object3D, velocity?: NetVec3): NetEntityState => {
    object.updateWorldMatrix(true, false);
    object.matrixWorld.decompose(_position, _quaternion, _scale);
    _euler.setFromQuaternion(_quaternion);
    return {
        id,
        position: [_position.x, _position.y, _position.z],
        rotation: [_euler.x, _euler.y, _euler.z],
        ...(velocity ? { velocity } : {}),
    };
};

/** Puts `object` at a world-space entity state, converting into its parent's space. */
export const applyEntityState = (object: THREE.Object3D, state: NetEntityState): void => {
    _position.set(...state.position);
    _quaternion.setFromEuler(_euler.set(...state.rotation));
    if (object.parent) {
        object.parent.updateWorldMatrix(true, false);
        const parentInverse = new THREE.Matrix4().copy(object.parent.matrixWorld).invert();
        const world = new THREE.Matrix4().compose(_position, _quaternion, _scale.set(1, 1, 1)).premultiply(parentInverse);
        const scale = object.scale.clone();
        world.decompose(object.position, object.quaternion, _scale);
        object.scale.copy(scale);
    } else {
        object.position.copy(_position);
        object.quaternion.copy(_quaternion);
    }
};
