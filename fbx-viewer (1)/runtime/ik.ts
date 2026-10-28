import * as THREE from 'three';
import { isPartCopy } from '../utils/partCopies';

/**
 * Inverse kinematics for THREE.Object3D chains, usually skeleton Bones. Solves read the chain's current
 * pose (normally the frame's animated pose), work in world space and write only local quaternions, so
 * they hold under rotated, scaled or mirrored parents and never change a bone's length (offsetBoneWorld,
 * for pelvis offsets, is the one helper that moves a bone). Each solve leaves the world matrices of the
 * bones it moved, and of everything under them, up to date.
 */

/** Below this a length or angle counts as zero. */
const EPSILON = 1e-6;
/** Under a parent with non-uniform scale a turn changes a bone's world length, so the two-bone solve repeats with the new lengths. */
const MAX_TWO_BONE_PASSES = 8;
/** Relative change in bone length below which another two-bone pass would not move the chain. */
const LENGTH_SETTLED = 1e-7;

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_RIGHT = new THREE.Vector3(1, 0, 0);

const isFiniteVector = (v: THREE.Vector3): boolean => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/** True when `node` is `ancestor` or sits anywhere below it. */
export const isDescendantOf = (node: THREE.Object3D, ancestor: THREE.Object3D): boolean => {
    for (let current: THREE.Object3D | null = node; current; current = current.parent) {
        if (current === ancestor) return true;
    }
    return false;
};

// --- BONE LOOKUP ---

/** A bone name reduced for loose matching: no 'Armature|' or 'mixamorig:' namespace, case, separators or rig prefix. */
const looseBoneName = (name: string): string => (name.split(/[|:]/).pop() ?? name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^(mixamorig\d*|armature|skeleton)/, '');

/**
 * The first object under `root` (depth first, `root` included) named `name`. A Bone with the exact name
 * wins, then a Bone whose name matches loosely ('Head' finds 'mixamorig:Head', 'mixamorig1_Head' or
 * 'HEAD'), then any other object the same two ways. A part's copy of a bone ('mixamorigSpine_1' under
 * 'mixamorigSpine', see isPartCopy) is found only by its exact name, never for 'Spine1'.
 * `skip` leaves out a node and everything below it.
 */
export const findBone = (
    root: THREE.Object3D,
    name: string,
    skip?: (node: THREE.Object3D) => boolean
): THREE.Object3D | null => {
    const wanted = looseBoneName(name);
    if (!wanted) return null;
    const ranked: (THREE.Object3D | null)[] = [null, null, null, null];
    const stack: THREE.Object3D[] = [root];
    while (stack.length) {
        const node = stack.pop()!;
        const match = node.name === name ? 0 : looseBoneName(node.name) === wanted && !isPartCopy(node) ? 1 : -1;
        if (match >= 0) {
            const rank = match + ((node as THREE.Bone).isBone ? 0 : 2);
            if (rank === 0) return node;
            ranked[rank] ??= node;
        }
        for (let i = node.children.length - 1; i >= 0; i--) {
            const child = node.children[i];
            if (!skip?.(child)) stack.push(child);
        }
    }
    return ranked.find(Boolean) ?? null;
};

// --- SHARED ROTATION HELPERS ---

const _parentInverse = new THREE.Matrix4();
const _fromLocal = new THREE.Vector3();
const _toLocal = new THREE.Vector3();
const _turn = new THREE.Quaternion();

/**
 * Turns `bone` by the smallest rotation, applied in its parent's space, that swings the world direction
 * `from` (one the bone carries, such as towards its child) onto the world direction `to`. A linear map
 * keeps directions, so afterwards the carried direction points exactly along `to` whatever the parent's
 * scale. Expects the parent's world matrix to be current; returns false, changing nothing, when an input
 * is degenerate.
 */
const turnBoneToward = (bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3): boolean => {
    _fromLocal.copy(from);
    _toLocal.copy(to);
    if (bone.parent) {
        _parentInverse.copy(bone.parent.matrixWorld).invert();
        _fromLocal.transformDirection(_parentInverse);
        _toLocal.transformDirection(_parentInverse);
    } else {
        _fromLocal.normalize();
        _toLocal.normalize();
    }
    if (!(_fromLocal.lengthSq() > 0.5) || !(_toLocal.lengthSq() > 0.5)) return false;
    bone.quaternion.premultiply(_turn.setFromUnitVectors(_fromLocal, _toLocal)).normalize();
    return true;
};

/** A unit vector perpendicular to the unit vector `axis`. */
const anyPerpendicular = (axis: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 =>
    out.crossVectors(axis, Math.abs(axis.y) < 0.9 ? WORLD_UP : WORLD_RIGHT).normalize();

const _swingAxis = new THREE.Vector3();

/** The unit vector `from` turned `angle` radians towards the unit vector `to`, written to `out` (not `from` or `to`). */
const swing = (from: THREE.Vector3, to: THREE.Vector3, angle: number, out: THREE.Vector3): THREE.Vector3 => {
    _swingAxis.crossVectors(from, to);
    if (_swingAxis.lengthSq() > EPSILON * EPSILON) _swingAxis.normalize();
    else if (from.dot(to) > 0) return out.copy(from);
    else anyPerpendicular(from, _swingAxis);
    return out.copy(from).applyAxisAngle(_swingAxis, angle);
};

/**
 * The unit vector `from` turned towards the unit vector `to` by at most `maxAngleRadians`, written to
 * `out` (which must be neither input). Directions within the limit come back as `to` itself.
 */
export const limitDirection = (
    from: THREE.Vector3,
    to: THREE.Vector3,
    maxAngleRadians: number,
    out: THREE.Vector3
): THREE.Vector3 => {
    const limit = Number.isFinite(maxAngleRadians) ? THREE.MathUtils.clamp(maxAngleRadians, 0, Math.PI) : Math.PI;
    const angle = from.angleTo(to);
    return angle <= limit ? out.copy(to) : swing(from, to, limit, out);
};

// --- TWO-BONE IK ---

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _bend = new THREE.Vector3();
const _hint = new THREE.Vector3();
const _midGoal = new THREE.Vector3();
const _endGoal = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _rootStart = new THREE.Quaternion();
const _midStart = new THREE.Quaternion();
const _solved = new THREE.Quaternion();

/** The unit part of `hint` across the unit vector `axis`, into `out`; false when `hint` lies along the axis. */
const across = (axis: THREE.Vector3, hint: THREE.Vector3, out: THREE.Vector3): boolean => {
    const size = hint.length();
    out.copy(hint).addScaledVector(axis, -hint.dot(axis));
    const length = out.length();
    if (!(length > 1e-4 * size) || !(length > EPSILON)) return false;
    out.divideScalar(length);
    return true;
};

const worldDistance = (a: THREE.Object3D, b: THREE.Object3D): number =>
    _p.setFromMatrixPosition(a.matrixWorld).distanceTo(_q.setFromMatrixPosition(b.matrixWorld));

/** One analytic pass with the chain's current world lengths; its world matrices must be current. False for a degenerate chain. */
const twoBonePass = (
    root: THREE.Object3D,
    mid: THREE.Object3D,
    end: THREE.Object3D,
    target: THREE.Vector3,
    pole: THREE.Vector3 | null
): boolean => {
    _a.setFromMatrixPosition(root.matrixWorld);
    _b.setFromMatrixPosition(mid.matrixWorld);
    _c.setFromMatrixPosition(end.matrixWorld);
    const upper = _a.distanceTo(_b);
    const lower = _b.distanceTo(_c);
    if (!(upper > EPSILON) || !(lower > EPSILON)) return false;

    // Aim from the root at the target; a target on the root keeps the chain's current heading.
    _axis.subVectors(target, _a);
    let distance = _axis.length();
    if (!(distance > EPSILON)) {
        _axis.subVectors(_c, _a);
        distance = 0;
        if (!(_axis.lengthSq() > EPSILON * EPSILON)) return false;
    }
    _axis.normalize();
    // Out of range the chain straightens towards the target; closer than the bones allow it folds as far as it can.
    const reach = Math.max(EPSILON, THREE.MathUtils.clamp(distance, Math.abs(upper - lower), upper + lower));

    // The bend plane holds the aim axis and the pole (else the current middle joint), on the pole's side.
    if (!(pole && across(_axis, _hint.subVectors(pole, _a), _bend)) && !across(_axis, _hint.subVectors(_b, _a), _bend)) {
        anyPerpendicular(_axis, _bend);
    }
    // Law of cosines: the angle at the root between the aim axis and the upper bone.
    const cos = THREE.MathUtils.clamp((upper * upper + reach * reach - lower * lower) / (2 * upper * reach), -1, 1);
    const sin = Math.sqrt(1 - cos * cos);
    _midGoal.copy(_a).addScaledVector(_axis, upper * cos).addScaledVector(_bend, upper * sin);
    _endGoal.copy(_a).addScaledVector(_axis, reach);

    if (!turnBoneToward(root, _from.subVectors(_b, _a), _to.subVectors(_midGoal, _a))) return false;
    end.updateWorldMatrix(true, false);
    _b.setFromMatrixPosition(mid.matrixWorld);
    _c.setFromMatrixPosition(end.matrixWorld);
    turnBoneToward(mid, _from.subVectors(_c, _b), _to.subVectors(_endGoal, _b));
    end.updateWorldMatrix(true, false);
    return true;
};

/**
 * Two-bone IK (e.g. thigh, calf, foot): turns `root` and `mid` so `end` reaches the world-space `target`.
 * In range the end lands on the target; out of range the chain straightens and points at it; closer than
 * the bones can fold, it folds as far as it can. The middle joint bends towards the world-space `pole`
 * point, or keeps its current bend side when `pole` is null. `weight` (0..1) blends from the current pose;
 * 0 leaves the chain untouched. `mid` must sit below `root` and `end` below `mid` (directly or through
 * other nodes); anything else is ignored.
 */
export const solveTwoBoneIK = (
    root: THREE.Object3D,
    mid: THREE.Object3D,
    end: THREE.Object3D,
    target: THREE.Vector3,
    pole: THREE.Vector3 | null,
    weight: number
): void => {
    if (!(weight > 0) || !isFiniteVector(target) || (pole && !isFiniteVector(pole))) return;
    if (root === mid || mid === end || !isDescendantOf(mid, root) || !isDescendantOf(end, mid)) return;
    _rootStart.copy(root.quaternion);
    _midStart.copy(mid.quaternion);

    end.updateWorldMatrix(true, false);
    let upper = worldDistance(root, mid);
    let lower = worldDistance(mid, end);
    for (let pass = 0; pass < MAX_TWO_BONE_PASSES; pass++) {
        if (!twoBonePass(root, mid, end, target, pole)) break;
        const nextUpper = worldDistance(root, mid);
        const nextLower = worldDistance(mid, end);
        const settled = Math.abs(nextUpper - upper) + Math.abs(nextLower - lower) <= LENGTH_SETTLED * (upper + lower);
        upper = nextUpper;
        lower = nextLower;
        if (settled) break;
    }

    if (weight < 1) {
        _solved.copy(root.quaternion);
        root.quaternion.copy(_rootStart).slerp(_solved, weight);
        _solved.copy(mid.quaternion);
        mid.quaternion.copy(_midStart).slerp(_solved, weight);
    }
    root.updateMatrixWorld(true);
};

// --- LOOK-AT ---

const _lookFrom = new THREE.Vector3();
const _lookTo = new THREE.Vector3();
const _lookGoal = new THREE.Vector3();

/**
 * Turns `bone` so its local `forward` axis points at the world-space `target`, by at most
 * `maxAngleRadians` away from where that axis pointed before (its animated pose). `weight` (0..1)
 * scales the turn; 0 leaves the bone untouched. The turn is the smallest one, so the bone does not roll.
 */
export const applyLookAt = (
    bone: THREE.Object3D,
    target: THREE.Vector3,
    forward: THREE.Vector3,
    maxAngleRadians: number,
    weight: number
): void => {
    if (!(weight > 0) || !isFiniteVector(target) || !isFiniteVector(forward)) return;
    bone.updateWorldMatrix(true, false);
    _lookFrom.copy(forward).transformDirection(bone.matrixWorld);
    _lookTo.setFromMatrixPosition(bone.matrixWorld);
    _lookTo.subVectors(target, _lookTo);
    if (!(_lookFrom.lengthSq() > 0.5) || !(_lookTo.lengthSq() > EPSILON * EPSILON)) return;
    _lookTo.normalize();
    const limit = Number.isFinite(maxAngleRadians) ? THREE.MathUtils.clamp(maxAngleRadians, 0, Math.PI) : Math.PI;
    const angle = Math.min(_lookFrom.angleTo(_lookTo), limit) * Math.min(1, weight);
    if (!(angle > EPSILON)) return;
    swing(_lookFrom, _lookTo, angle, _lookGoal);
    if (turnBoneToward(bone, _lookFrom, _lookGoal)) bone.updateMatrixWorld(true);
};

// --- POSE HELPERS ---

const _keep = new THREE.Matrix4();
const _keepTilt = new THREE.Matrix4();
const _keepRotation = new THREE.Matrix4();
const _keepQuaternion = new THREE.Quaternion();

/**
 * After `bone`'s parent moved (e.g. a leg solve turned the calf above a foot), turns `bone` back to the
 * world rotation it had while the parent's world matrix was `parentBefore`, then by the world rotation
 * `tilt` (null for none), blended by `weight`. Exact under parents with rotation, mirroring and uniform
 * scale. Updates the world matrices of `bone` and everything under it.
 */
export const keepWorldRotation = (
    bone: THREE.Object3D,
    parentBefore: THREE.Matrix4,
    tilt: THREE.Quaternion | null,
    weight: number
): void => {
    if (!(weight > 0) || !bone.parent) return;
    bone.parent.updateWorldMatrix(true, false);
    // The parent-space rotation that undoes the parent's change: after^-1 * tilt * before (linear parts).
    _keep.copy(bone.parent.matrixWorld).invert();
    if (tilt) _keep.multiply(_keepTilt.makeRotationFromQuaternion(tilt));
    _keep.multiply(parentBefore);
    if (!(_keep.determinant() > EPSILON)) return;
    _keepQuaternion.setFromRotationMatrix(_keepRotation.extractRotation(_keep));
    _keepQuaternion.multiply(bone.quaternion);
    bone.quaternion.slerp(_keepQuaternion, Math.min(1, weight));
    bone.updateMatrixWorld(true);
};

const _offsetMatrix = new THREE.Matrix3();
const _offsetLocal = new THREE.Vector3();

/**
 * Moves `bone` by the world-space vector `offset` (through its position in the parent's space) and
 * updates the world matrices of it and everything under it. A parent that cannot be inverted leaves it.
 */
export const offsetBoneWorld = (bone: THREE.Object3D, offset: THREE.Vector3): void => {
    if (!isFiniteVector(offset)) return;
    bone.updateWorldMatrix(true, false);
    _offsetLocal.copy(offset);
    if (bone.parent) {
        _offsetMatrix.setFromMatrix4(bone.parent.matrixWorld);
        if (!(Math.abs(_offsetMatrix.determinant()) > EPSILON * EPSILON)) return;
        _offsetLocal.applyMatrix3(_offsetMatrix.invert());
    }
    bone.position.add(_offsetLocal);
    bone.updateMatrixWorld(true);
};

interface PoseSnapshot {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
}

interface GuardEntry {
    /** The bone's pose before IK this frame. */
    base: PoseSnapshot;
    /** What IK left on the bone last frame; null before the first commit. */
    written: PoseSnapshot | null;
}

const snapshot = (bone: THREE.Object3D, into?: PoseSnapshot | null): PoseSnapshot => {
    const out = into ?? { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
    out.position.copy(bone.position);
    out.quaternion.copy(bone.quaternion);
    return out;
};

/**
 * Keeps IK from building on its own output. An animation mixer rewrites the bones it drives every
 * frame, but a bone nothing animates keeps the pose IK left on it, so the next solve would start from
 * there: a look-at would turn past its limit and a pelvis offset would keep sinking. Call `begin` with
 * every bone the frame's IK may move, before solving: a bone still holding exactly what IK wrote gets its
 * pre-IK pose back, and one something else posed keeps that pose. Call `commit` after solving.
 */
export class IKPoseGuard {
    private readonly entries = new Map<THREE.Object3D, GuardEntry>();

    /** Restores the pre-IK pose of bones nothing re-posed and records each bone's pose before this frame's IK. */
    begin(bones: readonly THREE.Object3D[]): void {
        for (const [bone, entry] of this.entries) {
            if (bones.includes(bone)) continue;
            this.undo(bone, entry);
            this.entries.delete(bone);
        }
        for (const bone of bones) {
            const entry = this.entries.get(bone);
            if (!entry) {
                this.entries.set(bone, { base: snapshot(bone), written: null });
                continue;
            }
            this.undo(bone, entry);
            snapshot(bone, entry.base);
        }
    }

    /** Records what this frame's IK left on each bone. */
    commit(): void {
        for (const [bone, entry] of this.entries) entry.written = snapshot(bone, entry.written);
    }

    /**
     * Puts back the pre-IK pose of every bone still holding IK's pose and forgets them, e.g. when the IK
     * stops. Call it each frame before the animation mixer too (useRestoreBeforeAnimation): the mixer
     * writes only values that changed, and while blending it mixes in a property's original value, which
     * it captures from the bone as it is then; a bone still holding last frame's IK would feed into it
     * and the IK would build on itself.
     */
    release(): void {
        for (const [bone, entry] of this.entries) this.undo(bone, entry);
        this.entries.clear();
    }

    private undo(bone: THREE.Object3D, entry: GuardEntry): void {
        const written = entry.written;
        if (!written || !bone.position.equals(written.position) || !bone.quaternion.equals(written.quaternion)) return;
        bone.position.copy(entry.base.position);
        bone.quaternion.copy(entry.base.quaternion);
    }
}

// --- SUPPORT HAND ---

/**
 * A weapon held in one hand as its attachment is mounted there, and the point on it the other hand
 * holds (a rifle's handguard). The animation places the gripping hand; the other hand takes hold.
 */
export interface SupportGrip {
    /** The attachment's offsets on the gripping hand: position, rotation in degrees, scale. */
    position: readonly [number, number, number];
    rotation: readonly [number, number, number];
    scale: readonly [number, number, number];
    /** Where the other hand holds it, in the weapon model's own units. */
    point: readonly [number, number, number];
    /**
     * How the other hand is turned on the weapon, in degrees in the weapon model's frame (Fit records
     * it from the weapon's own clip), so it holds the weapon the same way whatever clip plays. Without
     * it the hand keeps the clip's rotation.
     */
    handRotation?: readonly [number, number, number] | null;
}

const _gripEuler = new THREE.Euler();
const _gripQuaternion = new THREE.Quaternion();
const _gripMatrix = new THREE.Matrix4();
const _gripPosition = new THREE.Vector3();
const _gripScale = new THREE.Vector3();

const _weaponTurn = new THREE.Quaternion();

/**
 * World position of the support point on a weapon mounted on `hand`. With `rotation`, also the
 * world rotation the other hand holds the weapon with when the grip records one (else it is left as it is).
 */
export const supportGripPoint = (hand: THREE.Object3D, grip: SupportGrip, out: THREE.Vector3, rotation?: THREE.Quaternion): THREE.Vector3 => {
    _gripEuler.set(
        THREE.MathUtils.degToRad(grip.rotation[0]),
        THREE.MathUtils.degToRad(grip.rotation[1]),
        THREE.MathUtils.degToRad(grip.rotation[2]),
    );
    _gripMatrix.compose(
        _gripPosition.set(grip.position[0], grip.position[1], grip.position[2]),
        _gripQuaternion.setFromEuler(_gripEuler),
        _gripScale.set(grip.scale[0], grip.scale[1], grip.scale[2]),
    );
    hand.updateWorldMatrix(true, false);
    if (rotation && grip.handRotation) {
        // The weapon's world rotation (the hand's, then the attachment's own), then the hand's on it.
        hand.getWorldQuaternion(rotation).multiply(_gripQuaternion);
        _gripEuler.set(
            THREE.MathUtils.degToRad(grip.handRotation[0]),
            THREE.MathUtils.degToRad(grip.handRotation[1]),
            THREE.MathUtils.degToRad(grip.handRotation[2]),
        );
        rotation.multiply(_weaponTurn.setFromEuler(_gripEuler));
    }
    return out.set(grip.point[0], grip.point[1], grip.point[2]).applyMatrix4(_gripMatrix).applyMatrix4(hand.matrixWorld);
};

const _handRotation = new THREE.Quaternion();
const _handTurn = new THREE.Quaternion();
const _handParent = new THREE.Quaternion();
const _gripOffset = new THREE.Vector3();
const _wristGoal = new THREE.Vector3();
const _elbowPole = new THREE.Vector3();
const _reachMiddle = new THREE.Vector3();
const _fistSum = new THREE.Vector3();
const _arcA = new THREE.Vector3();
const _arcB = new THREE.Vector3();
const _arcC = new THREE.Vector3();
const _arcAB = new THREE.Vector3();
const _arcAC = new THREE.Vector3();
const _arcN = new THREE.Vector3();
const _arcT1 = new THREE.Vector3();
const _arcT2 = new THREE.Vector3();

/** The fingers whose curl closes around a held grip; the index finger often lies along a trigger instead. */
const GRIP_FINGERS = ['middle', 'ring', 'pinky'];

/** The joints of `hand`'s finger named `finger`, base first (`...Middle1`, `...Middle2`, ...). */
const fingerJoints = (hand: THREE.Object3D, finger: string): THREE.Object3D[] => {
    const joints: THREE.Object3D[] = [];
    let base = null as THREE.Object3D | null;
    hand.traverse(node => { if (!base && node !== hand && new RegExp(`${finger}_?0*1$`, 'i').test(node.name)) base = node; });
    for (let joint: THREE.Object3D | null = base; joint; joint = joint.children.find(child => (child as THREE.Bone).isBone) ?? null) joints.push(joint);
    return joints;
};

/** The centre of the circle through three points, or false when they are in a line. */
const circleCentre = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, out: THREE.Vector3): boolean => {
    _arcAB.subVectors(b, a);
    _arcAC.subVectors(c, a);
    _arcN.crossVectors(_arcAB, _arcAC);
    const d = 2 * _arcN.lengthSq();
    if (d < 1e-12) return false;
    _arcT1.crossVectors(_arcN, _arcAB).multiplyScalar(_arcAC.lengthSq());
    _arcT2.crossVectors(_arcAC, _arcN).multiplyScalar(_arcAB.lengthSq());
    out.copy(a).add(_arcT1.add(_arcT2).multiplyScalar(1 / d));
    return true;
};

/**
 * Where `hand` holds a grip, in world space: the centre of the hollow its curled fingers close
 * around (each of the middle, ring and little fingers' joints lie on an arc round it), as the hand
 * is posed now. A hand without curled finger joints holds at its palm: midway from the wrist to the
 * middle finger's base, or the wrist itself.
 */
export const handGripPoint = (hand: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 => {
    hand.updateWorldMatrix(true, true);
    _fistSum.set(0, 0, 0);
    let arcs = 0;
    for (const finger of GRIP_FINGERS) {
        const joints = fingerJoints(hand, finger);
        if (joints.length < 3) continue;
        joints[0].getWorldPosition(_arcA);
        joints[1].getWorldPosition(_arcB);
        joints[joints.length - 1].getWorldPosition(_arcC);
        // A finger lying straight has no hollow; its "centre" would be far off.
        if (!circleCentre(_arcA, _arcB, _arcC, out) || out.distanceTo(_arcA) > 2 * _arcA.distanceTo(_arcC)) continue;
        _fistSum.add(out);
        arcs += 1;
    }
    if (arcs) return out.copy(_fistSum).multiplyScalar(1 / arcs);
    const middle = fingerJoints(hand, 'middle')[0];
    hand.getWorldPosition(out);
    return middle ? out.lerp(middle.getWorldPosition(_arcA), 0.5) : out;
};

/**
 * Brings a hand onto `target` by two-bone IK of its arm (upper arm, forearm, hand): the point the
 * hand holds a grip at (handGripPoint) goes to `target`. The elbow bends the way the animation
 * bends it and the fingers keep the animation's curl. The hand is turned to `rotation` (world) when
 * given, else it keeps the animation's.
 */
export const reachWithHand = (
    arm: THREE.Object3D,
    forearm: THREE.Object3D,
    hand: THREE.Object3D,
    target: THREE.Vector3,
    weight = 1,
    rotation: THREE.Quaternion | null = null,
): void => {
    if (!(weight > 0) || !isFiniteVector(target)) return;
    hand.updateWorldMatrix(true, true);
    hand.getWorldQuaternion(_handRotation);
    // The grip point is held where it is on the hand, so the wrist goes that far short of the target.
    handGripPoint(hand, _gripOffset).sub(_wristGoal.setFromMatrixPosition(hand.matrixWorld));
    if (rotation) {
        // Turned to `rotation`, the grip point sits that much differently from the wrist.
        _gripOffset.applyQuaternion(_handTurn.copy(_handRotation).invert().premultiply(rotation));
        _handRotation.slerp(rotation, Math.min(1, weight));
    }
    _wristGoal.copy(target).sub(_gripOffset);
    // The pole sits out past the animated elbow, away from the line the arm reaches along.
    _reachMiddle.setFromMatrixPosition(arm.matrixWorld).add(_wristGoal).multiplyScalar(0.5);
    _elbowPole.setFromMatrixPosition(forearm.matrixWorld);
    _elbowPole.add(_b.subVectors(_elbowPole, _reachMiddle));
    solveTwoBoneIK(arm, forearm, hand, _wristGoal, _elbowPole, weight);
    // The hand keeps its rotation (the animation's, or the one asked for), now on the moved forearm.
    if (hand.parent) hand.parent.getWorldQuaternion(_handParent).invert();
    else _handParent.identity();
    hand.quaternion.copy(_handParent.multiply(_handRotation));
    hand.updateMatrixWorld(true);
};
