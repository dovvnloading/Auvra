import * as THREE from 'three';
import type { WindVec } from './wind';

/**
 * SPRING BONES
 *
 * Secondary motion for loose parts of a model: hair, a ponytail, a tail, a cape's bones, straps,
 * a rope, a tassel. Each bone in such a chain follows a point at its tip that keeps its momentum,
 * springs back toward where the bone points at rest, sags under gravity and streams in the wind,
 * while staying the bone's length from its root. So the chain swings as the model moves and
 * settles when it stops. Bones an animation drives keep their animated pose underneath.
 */

/** Bone names that are loose parts, by default. */
export const DEFAULT_SPRING_BONES = 'hair, ponytail, braid, tail, cape, skirt, strap, rope, chain, tassel, ear, antenna, tie';

export interface SpringSettings {
    /** How firmly each bone springs back to its rest direction, per second. */
    stiffness: number;
    /** 0-1: how much of its swing it loses each second. */
    damping: number;
    /** Pull downward, m/s² (9.8 is full gravity). */
    gravity: number;
    /** How much the wind carries it: 1 moves at the wind's speed. */
    wind: number;
}

/** Whether a bone's name is one of the comma-separated words (any case, anywhere in the name). */
export const springBoneMatcher = (words: string): ((name: string) => boolean) => {
    const parts = words.split(',').map(word => word.trim().toLowerCase()).filter(Boolean);
    return name => {
        const lower = name.toLowerCase();
        return parts.some(part => lower.includes(part));
    };
};

interface Joint {
    bone: THREE.Bone;
    /** The simulated bone above it in its chain (null for the first). */
    above: THREE.Bone | null;
    /** What the chain hangs from (not simulated), and which way this bone points at rest in its space. */
    anchor: THREE.Object3D | null;
    restDirection: THREE.Vector3;
    /** Its local rotation at rest, and the last one this wrote (to tell an animation's from its own). */
    rest: THREE.Quaternion;
    written: THREE.Quaternion | null;
    /** Where its tip sits in its own space, and how long it is in the world. */
    tip: THREE.Vector3;
    length: number;
    current: THREE.Vector3;
    previous: THREE.Vector3;
    placed: boolean;
}

/** How hard the wind drags a bone's tip toward its own speed, per unit of Wind. */
const WIND_DRAG = 1.5;

/** The sharpest bend, radians, a bone may make from the one above it. */
const MAX_BEND = (40 * Math.PI) / 180;

const _head = new THREE.Vector3();
const _bend = new THREE.Vector3();
const _above = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _target = new THREE.Vector3();
const _anchor = new THREE.Quaternion();
const _restTip = new THREE.Vector3();
const _next = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _turn = new THREE.Quaternion();
const _world = new THREE.Quaternion();
const _parent = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _wind: WindVec = { x: 0, y: 0, z: 0 };

/** A joint's tip in its own space: toward its first child, or on along its parent's line for the last bone. */
const tipOf = (bone: THREE.Bone): THREE.Vector3 => {
    const child = bone.children.find(node => (node as THREE.Bone).isBone);
    if (child) return child.position.clone();
    // The last bone: as long as it is from its parent, pointing on the same way.
    return bone.position.lengthSq() > 1e-12 ? bone.position.clone().normalize().multiplyScalar(bone.position.length() * 0.7) : new THREE.Vector3(0, 0.05, 0);
};

export class SpringBones {
    readonly joints: Joint[] = [];

    /** Finds the chains under `root`: bones whose names match, with their descendants, top down. */
    constructor(root: THREE.Object3D, matches: (name: string) => boolean) {
        const found = new Set<THREE.Bone>();
        root.traverse(node => {
            const bone = node as THREE.Bone;
            if (!bone.isBone || found.has(bone)) return;
            if (!matches(bone.name)) return;
            // The chain from here down, in order from the root.
            bone.traverse(inner => {
                const b = inner as THREE.Bone;
                if (b.isBone && !found.has(b)) found.add(b);
            });
        });
        root.updateWorldMatrix(true, true);
        root.traverse(node => {
            const bone = node as THREE.Bone;
            if (!found.has(bone)) return;
            let anchor: THREE.Object3D | null = bone.parent;
            while (anchor && found.has(anchor as THREE.Bone)) anchor = anchor.parent;
            const tip = tipOf(bone);
            // Its rest direction in the anchor's space: a bone springs back toward the chain's rest shape
            // as the anchor holds it, not toward its parent's swing (which would curl the chain over).
            const head = bone.getWorldPosition(new THREE.Vector3());
            const restDirection = tip.clone().applyMatrix4(bone.matrixWorld).sub(head).normalize();
            if (anchor) restDirection.applyQuaternion(anchor.getWorldQuaternion(new THREE.Quaternion()).invert());
            this.joints.push({
                bone, anchor, restDirection, above: found.has(bone.parent as THREE.Bone) ? bone.parent as THREE.Bone : null, rest: bone.quaternion.clone(), written: null, tip, length: 0,
                current: new THREE.Vector3(), previous: new THREE.Vector3(), placed: false,
            });
        });
    }

    get count(): number {
        return this.joints.length;
    }

    /** Puts every bone back as it was. */
    restore(): void {
        for (const joint of this.joints) {
            joint.bone.quaternion.copy(joint.rest);
            joint.written = null;
            joint.placed = false;
        }
    }

    /** Moves the chains on by `dt` seconds; `wind` gives the wind at a point (null: none). */
    update(dt: number, settings: SpringSettings, wind: ((x: number, y: number, z: number, out: WindVec) => WindVec) | null): void {
        const h = Math.min(0.05, Math.max(0, dt));
        if (h <= 0) return;
        // Damping 1 stops a swing almost at once; 0.5 loses most of it within a second.
        const keep = Math.exp(-Math.min(1, Math.max(0, settings.damping)) * 8 * h);
        for (const joint of this.joints) {
            const bone = joint.bone;
            // Its pose underneath: its rest, or what an animation set since this last wrote it.
            if (joint.written && bone.quaternion.equals(joint.written)) bone.quaternion.copy(joint.rest);
            bone.updateWorldMatrix(true, false);
            bone.getWorldPosition(_head);
            _restTip.copy(joint.tip).applyMatrix4(bone.matrixWorld);
            const length = _restTip.distanceTo(_head);
            if (!joint.placed || joint.length <= 0) {
                joint.current.copy(_restTip);
                joint.previous.copy(_restTip);
                joint.length = length;
                joint.placed = true;
            }
            joint.length = length;
            // On with its own motion, back toward its rest direction (as its anchor holds it), down and with the wind.
            _next.copy(joint.current).sub(joint.previous).multiplyScalar(keep).add(joint.current);
            _target.copy(joint.restDirection);
            if (joint.anchor) _target.applyQuaternion(joint.anchor.getWorldQuaternion(_anchor));
            _next.addScaledVector(_target, settings.stiffness * h * length);
            _from.subVectors(_restTip, _head).normalize();
            _next.y -= settings.gravity * h * h;
            if (wind && settings.wind > 0) {
                wind(_head.x, _head.y, _head.z, _wind);
                _to.subVectors(joint.current, joint.previous).divideScalar(h);
                _next.x += (_wind.x - _to.x) * settings.wind * h * h * WIND_DRAG;
                _next.y += (_wind.y - _to.y) * settings.wind * h * h * WIND_DRAG;
                _next.z += (_wind.z - _to.z) * settings.wind * h * h * WIND_DRAG;
            }
            // Its length from the root, and no sharper a bend from the bone above than a rope or a lock of hair makes.
            _to.subVectors(_next, _head);
            const reach = _to.length();
            if (reach > 1e-9) _to.divideScalar(reach);
            else _to.copy(_target);
            const above = joint.above ? _bend.subVectors(_head, joint.above.getWorldPosition(_above)) : _bend.copy(_target);
            if (above.lengthSq() > 1e-12) {
                above.normalize();
                const angle = above.angleTo(_to);
                if (angle > MAX_BEND) {
                    // Turn it back toward the bone above, in the plane they share.
                    _axis.crossVectors(above, _to);
                    if (_axis.lengthSq() < 1e-12) _axis.set(1, 0, 0).cross(above);
                    _to.copy(above).applyAxisAngle(_axis.normalize(), MAX_BEND);
                }
            }
            _next.copy(_head).addScaledVector(_to, length);
            joint.previous.copy(joint.current);
            joint.current.copy(_next);
            // Turn the bone from pointing at its rest tip to pointing at the new one.
            _to.subVectors(_next, _head).normalize();
            _turn.setFromUnitVectors(_from, _to);
            bone.matrixWorld.decompose(_head, _world, _scale);
            _world.premultiply(_turn);
            if (bone.parent) {
                bone.parent.matrixWorld.decompose(_head, _parent, _scale);
                bone.quaternion.copy(_parent.invert().multiply(_world));
            } else bone.quaternion.copy(_world);
            bone.updateMatrixWorld(true);
            joint.written = (joint.written ?? new THREE.Quaternion()).copy(bone.quaternion);
        }
    }
}
