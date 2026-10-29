import * as THREE from 'three';

/**
 * PROCEDURAL RIG
 *
 * Constraints laid on a character's bones after its animation has posed them, in order, each with a
 * weight: the rig a model needs for what clips cannot know.
 *  - Aim: points one of a bone's axes at a target (the camera, the player, an object or a point), within
 *    an angle: a head or a turret tracking, a gun lined up with the crosshair.
 *  - Copy rotation: takes another bone's rotation on chosen axes, replacing or adding: a cape following
 *    the spine, a second arm mirroring the first.
 *  - Offset: turns a bone by fixed angles: a slouch, a tilt, a re-aimed hand.
 *  - Limit: keeps a bone's rotation within angles on each axis, after everything before it.
 *  - Lag: the bone follows its animated rotation late, like something loose or heavy (a tail, antenna,
 *    a hanging lamp) with a stiffness and an overshoot.
 *  - Twist: spreads a share of another bone's twist about its length onto this one, as forearms twist
 *    with the wrist so the skin does not pinch.
 */

export type RigConstraintKind = 'aim' | 'copyRotation' | 'offset' | 'limit' | 'lag' | 'twist';
export const RIG_CONSTRAINT_KINDS: readonly RigConstraintKind[] = ['aim', 'copyRotation', 'offset', 'limit', 'lag', 'twist'];

export type RigAxis = 'x' | 'y' | 'z' | '-x' | '-y' | '-z';
export const RIG_AXES: readonly RigAxis[] = ['x', 'y', 'z', '-x', '-y', '-z'];

/** What an aim looks at: the camera, the player, a level object (by id), or a fixed world point. */
export type RigTarget = { kind: 'camera' } | { kind: 'player' } | { kind: 'object'; id: string } | { kind: 'point'; point: [number, number, number] };

export interface RigConstraint {
    kind: RigConstraintKind;
    /** The bone it moves, by name. */
    bone: string;
    /** 0-1: how much of it applies. */
    weight: number;
    /** Aim: the target, the bone's axis that points at it, and the most it turns away from the animation (degrees). */
    target: RigTarget;
    axis: RigAxis;
    maxAngle: number;
    /** Copy rotation and Twist: the bone it takes from. */
    source: string;
    /** Copy rotation: which axes, and whether added to the bone's own rotation instead of replacing it. */
    axes: [boolean, boolean, boolean];
    additive: boolean;
    /** Offset: degrees about X, Y, Z. Limit: the lowest angles; `max` the highest. */
    angles: [number, number, number];
    max: [number, number, number];
    /** Lag: how quickly it catches up (1/s) and how much it overshoots (0 none, 1 a lot). */
    stiffness: number;
    bounce: number;
}

export const DEFAULT_RIG_CONSTRAINT: RigConstraint = {
    kind: 'aim', bone: '', weight: 1, target: { kind: 'camera' }, axis: 'z', maxAngle: 70, source: '', axes: [true, true, true],
    additive: false, angles: [0, 0, 0], max: [0, 0, 0], stiffness: 8, bounce: 0.3,
};

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const num = (value: unknown, fallback: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, typeof value === 'number' && Number.isFinite(value) ? value : fallback));
const triple = (value: unknown, fallback: [number, number, number], min: number, max: number): [number, number, number] =>
    Array.isArray(value) && value.length === 3 ? [num(value[0], fallback[0], min, max), num(value[1], fallback[1], min, max), num(value[2], fallback[2], min, max)] : [...fallback];
const name = (value: unknown): string => (typeof value === 'string' ? value.slice(0, 128) : '');

const sanitizeTarget = (value: unknown): RigTarget => {
    const t = record(value);
    if (t.kind === 'player') return { kind: 'player' };
    if (t.kind === 'object' && typeof t.id === 'string') return { kind: 'object', id: t.id.slice(0, 128) };
    if (t.kind === 'point') return { kind: 'point', point: triple(t.point, [0, 0, 0], -1e6, 1e6) };
    return { kind: 'camera' };
};

export const sanitizeRigConstraint = (value: unknown): RigConstraint => {
    const c = record(value);
    const base = DEFAULT_RIG_CONSTRAINT;
    const axes = Array.isArray(c.axes) && c.axes.length === 3 ? c.axes.map(axis => axis !== false) as [boolean, boolean, boolean] : [...base.axes] as [boolean, boolean, boolean];
    return {
        kind: typeof c.kind === 'string' && (RIG_CONSTRAINT_KINDS as readonly string[]).includes(c.kind) ? c.kind as RigConstraintKind : base.kind,
        bone: name(c.bone),
        weight: num(c.weight, base.weight, 0, 1),
        target: sanitizeTarget(c.target),
        axis: typeof c.axis === 'string' && (RIG_AXES as readonly string[]).includes(c.axis) ? c.axis as RigAxis : base.axis,
        maxAngle: num(c.maxAngle, base.maxAngle, 0, 180),
        source: name(c.source),
        axes,
        additive: c.additive === true,
        angles: triple(c.angles, base.angles, -360, 360),
        max: triple(c.max, base.max, -360, 360),
        stiffness: num(c.stiffness, base.stiffness, 0.1, 100),
        bounce: num(c.bounce, base.bounce, 0, 1),
    };
};

/** A Procedural Rig component's constraints from its props, at most 32, every field in range. */
export const readRigConstraints = (props: Record<string, unknown>): RigConstraint[] =>
    (Array.isArray(props.constraints) ? props.constraints : []).slice(0, 32).map(sanitizeRigConstraint);

const AXIS_VECTORS: Record<RigAxis, THREE.Vector3> = {
    x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1),
    '-x': new THREE.Vector3(-1, 0, 0), '-y': new THREE.Vector3(0, -1, 0), '-z': new THREE.Vector3(0, 0, -1),
};

const DEG = Math.PI / 180;
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _position = new THREE.Vector3();
const _world = new THREE.Quaternion();
const _parent = new THREE.Quaternion();
const _delta = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _twist = new THREE.Quaternion();
const _identity = new THREE.Quaternion();
const _flatFrom = new THREE.Vector3();
const _flatTo = new THREE.Vector3();
const _yaw = new THREE.Quaternion();

/** The rotation of `rotation` about `axis` alone (its twist), from a swing-twist split. */
export const twistAbout = (rotation: THREE.Quaternion, axis: THREE.Vector3, out = new THREE.Quaternion()): THREE.Quaternion => {
    const along = rotation.x * axis.x + rotation.y * axis.y + rotation.z * axis.z;
    out.set(axis.x * along, axis.y * along, axis.z * along, rotation.w);
    const length = Math.hypot(out.x, out.y, out.z, out.w);
    return length < 1e-9 ? out.identity() : out.set(out.x / length, out.y / length, out.z / length, out.w / length);
};

/** Turns a bone (in its parent's space) so its world rotation becomes `world`. */
const setWorldRotation = (bone: THREE.Object3D, world: THREE.Quaternion): void => {
    if (bone.parent) {
        bone.parent.getWorldQuaternion(_parent).invert();
        bone.quaternion.copy(_parent.multiply(world));
    } else {
        bone.quaternion.copy(world);
    }
};

/** One rig: a character's constraints, with the state lag keeps between frames. */
export class ProceduralRig {
    private readonly lagged = new Map<number, { rotation: THREE.Quaternion; velocity: THREE.Vector3 }>();

    constructor(public constraints: RigConstraint[]) {}

    /**
     * Applies every constraint in order to the bones `find` returns by name, after the animation posed
     * them. `targetOf` gives an aim's target in the world (null: the aim rests this frame).
     */
    apply(find: (name: string) => THREE.Object3D | null, targetOf: (target: RigTarget) => THREE.Vector3 | null, dt: number): void {
        this.constraints.forEach((constraint, index) => {
            if (constraint.weight <= 0) return;
            const bone = find(constraint.bone);
            if (!bone) return;
            switch (constraint.kind) {
                case 'aim': {
                    const target = targetOf(constraint.target);
                    if (!target) return;
                    bone.updateWorldMatrix(true, false);
                    bone.getWorldPosition(_position);
                    bone.getWorldQuaternion(_world);
                    _from.copy(AXIS_VECTORS[constraint.axis]).applyQuaternion(_world).normalize();
                    _to.copy(target).sub(_position);
                    if (_to.lengthSq() < 1e-8) return;
                    _to.normalize();
                    // Turned about the world's up, then tipped up or down: the bone stays upright (a head does not roll).
                    _flatFrom.set(_from.x, 0, _from.z);
                    _flatTo.set(_to.x, 0, _to.z);
                    if (_flatFrom.lengthSq() > 1e-6 && _flatTo.lengthSq() > 1e-6) {
                        _yaw.setFromUnitVectors(_flatFrom.normalize(), _flatTo.normalize());
                        _delta.setFromUnitVectors(_from.applyQuaternion(_yaw), _to).multiply(_yaw);
                    } else {
                        _delta.setFromUnitVectors(_from, _to);
                    }
                    // Never more than maxAngle from where the animation put it, then weighted.
                    const angle = 2 * Math.acos(Math.min(1, Math.abs(_delta.w)));
                    const limit = constraint.maxAngle * DEG;
                    const share = (angle > limit && angle > 1e-6 ? limit / angle : 1) * constraint.weight;
                    _delta.slerp(_identity, 1 - share);
                    setWorldRotation(bone, _world.premultiply(_delta));
                    return;
                }
                case 'copyRotation': {
                    const source = find(constraint.source);
                    if (!source) return;
                    _euler.setFromQuaternion(source.quaternion, 'XYZ');
                    const own = new THREE.Euler().setFromQuaternion(bone.quaternion, 'XYZ');
                    const mix = (axis: 0 | 1 | 2, from: number, to: number) => (constraint.axes[axis] ? (constraint.additive ? from + to : to) : from);
                    _delta.setFromEuler(new THREE.Euler(mix(0, own.x, _euler.x), mix(1, own.y, _euler.y), mix(2, own.z, _euler.z), 'XYZ'));
                    bone.quaternion.slerp(_delta, constraint.weight);
                    return;
                }
                case 'offset': {
                    _delta.setFromEuler(_euler.set(constraint.angles[0] * DEG, constraint.angles[1] * DEG, constraint.angles[2] * DEG, 'XYZ'));
                    _delta.slerp(_identity, 1 - constraint.weight);
                    bone.quaternion.multiply(_delta);
                    return;
                }
                case 'limit': {
                    _euler.setFromQuaternion(bone.quaternion, 'XYZ');
                    const clamp = (value: number, axis: 0 | 1 | 2) => {
                        const low = Math.min(constraint.angles[axis], constraint.max[axis]) * DEG;
                        const high = Math.max(constraint.angles[axis], constraint.max[axis]) * DEG;
                        return Math.min(high, Math.max(low, value));
                    };
                    _delta.setFromEuler(new THREE.Euler(clamp(_euler.x, 0), clamp(_euler.y, 1), clamp(_euler.z, 2), 'XYZ'));
                    bone.quaternion.slerp(_delta, constraint.weight);
                    return;
                }
                case 'lag': {
                    // A spring on rotation: angular velocity pulled toward the animated rotation, damped.
                    let state = this.lagged.get(index);
                    if (!state) {
                        state = { rotation: bone.quaternion.clone(), velocity: new THREE.Vector3() };
                        this.lagged.set(index, state);
                    }
                    const step = Math.min(dt, 0.1);
                    if (step > 0) {
                        _delta.copy(state.rotation).invert().premultiply(bone.quaternion);
                        if (_delta.w < 0) _delta.set(-_delta.x, -_delta.y, -_delta.z, -_delta.w);
                        const angle = 2 * Math.acos(Math.min(1, _delta.w));
                        const s = Math.sqrt(Math.max(1e-12, 1 - _delta.w * _delta.w));
                        _to.set(_delta.x / s, _delta.y / s, _delta.z / s).multiplyScalar(angle);
                        const k = constraint.stiffness * constraint.stiffness;
                        const damping = 2 * constraint.stiffness * (1 - constraint.bounce * 0.9);
                        state.velocity.addScaledVector(_to, k * step).multiplyScalar(Math.exp(-damping * step));
                        const turn = state.velocity.length() * step;
                        if (turn > 1e-9) {
                            _twist.setFromAxisAngle(_from.copy(state.velocity).normalize(), turn);
                            state.rotation.premultiply(_twist).normalize();
                        }
                    }
                    bone.quaternion.slerp(state.rotation, constraint.weight);
                    return;
                }
                case 'twist': {
                    const source = find(constraint.source);
                    if (!source) return;
                    twistAbout(source.quaternion, AXIS_VECTORS[constraint.axis], _twist);
                    _twist.slerp(_identity, 1 - constraint.weight);
                    bone.quaternion.multiply(_twist);
                    return;
                }
            }
        });
    }

    /** Forgets lag state (after a teleport or a new animation set). */
    reset(): void {
        this.lagged.clear();
    }
}
