import * as THREE from 'three';
import { springDecay } from './springs';

/**
 * INERTIALIZATION
 *
 * A way to change animation without a crossfade. On a switch, the new animation takes over at once, and
 * what separates the pose that was on screen from the new one (and how fast the old pose was moving
 * away from it) becomes an offset on each bone, which a critically damped spring then carries to
 * nothing. The character keeps its momentum through the switch and settles into the new motion within
 * a moment, with none of the doubled, floaty look of two clips blended together, and switches can
 * follow one another as often as needed: each starts from what is on screen.
 *
 * Offsets are kept in each bone's own (parent) space: a rotation as a scaled angle-axis vector, a
 * translation as a vector. They are applied after the mixer has posed the bones and before anything
 * that reads or adjusts the pose (IK, sockets).
 */

/** Seconds (a spring half-life) a switch's offset takes to mostly fade, by default. */
export const DEFAULT_INERTIAL_HALF_LIFE = 0.1;
/** After this many half-lives an offset is a hundred-thousandth of what it was: the switch has finished. */
const SETTLED_HALF_LIVES = 10;

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _axis = new THREE.Vector3();

/** A rotation as an axis scaled by its angle (the short way round), into `out`. */
const toRotationVector = (q: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 => {
    // The short way round: q and -q are the same rotation.
    const sign = q.w < 0 ? -1 : 1;
    const w = Math.min(1, q.w * sign);
    const s = Math.sqrt(Math.max(0, 1 - w * w));
    const angle = 2 * Math.acos(w);
    if (s < 1e-6) return out.set(q.x * sign * 2, q.y * sign * 2, q.z * sign * 2);
    return out.set((q.x * sign / s) * angle, (q.y * sign / s) * angle, (q.z * sign / s) * angle);
};

/** The rotation a scaled angle-axis vector stands for, into `out`. */
const fromRotationVector = (x: number, y: number, z: number, out: THREE.Quaternion): THREE.Quaternion => {
    const angle = Math.hypot(x, y, z);
    if (angle < 1e-9) return out.set(x / 2, y / 2, z / 2, 1).normalize();
    _axis.set(x / angle, y / angle, z / angle);
    return out.setFromAxisAngle(_axis, angle);
};

/**
 * The inertialized pose of one character: what it last showed, and the offsets fading out after the
 * most recent switch.
 */
export class Inertializer {
    readonly bones: THREE.Object3D[];
    halfLife = DEFAULT_INERTIAL_HALF_LIFE;
    private readonly count: number;
    /** The pose last shown, and the one before it (rotations xyzw, positions xyz per bone). */
    private readonly shownRotation: Float32Array;
    private readonly shownPosition: Float32Array;
    private readonly earlierRotation: Float32Array;
    private readonly earlierPosition: Float32Array;
    private shownStep = 0;
    private shown = 0;
    /** Offsets fading out: rotations and translations, and how fast each is changing. */
    private readonly rotationOffset: Float32Array;
    private readonly rotationVelocity: Float32Array;
    private readonly positionOffset: Float32Array;
    private readonly positionVelocity: Float32Array;
    /** The new animation's pose a moment before the switch, to tell how fast it moves (when known). */
    private readonly beforeRotation: Float32Array;
    private readonly beforePosition: Float32Array;
    private beforeStep = 0;
    private active = false;
    /** Seconds since the last switch. */
    private elapsed = 0;
    /** The animation's own pose (before offsets) of the frame offsets were last added to. */
    private readonly ownRotation: Float32Array;
    private readonly ownPosition: Float32Array;
    private offsetsShown = false;
    /** The switch was this frame: its offsets show in full before they start to fade. */
    private justSwitched = false;

    constructor(model: THREE.Object3D) {
        const bones: THREE.Object3D[] = [];
        model.traverse((node) => { if ((node as THREE.Bone).isBone) bones.push(node); });
        this.bones = bones;
        const n = this.count = bones.length;
        this.shownRotation = new Float32Array(n * 4);
        this.shownPosition = new Float32Array(n * 3);
        this.earlierRotation = new Float32Array(n * 4);
        this.earlierPosition = new Float32Array(n * 3);
        this.rotationOffset = new Float32Array(n * 3);
        this.rotationVelocity = new Float32Array(n * 3);
        this.positionOffset = new Float32Array(n * 3);
        this.positionVelocity = new Float32Array(n * 3);
        this.beforeRotation = new Float32Array(n * 4);
        this.beforePosition = new Float32Array(n * 3);
        this.ownRotation = new Float32Array(n * 4);
        this.ownPosition = new Float32Array(n * 3);
    }

    /**
     * Before the mixer poses the bones: puts back the animation's own pose where offsets were added last
     * frame. The mixer rewrites the bones it animates anyway; this keeps an offset from building up on a
     * bone no playing clip moves.
     */
    restore(): void {
        if (!this.offsetsShown) return;
        for (let i = 0; i < this.count; i++) {
            this.bones[i].quaternion.fromArray(this.ownRotation, i * 4);
            this.bones[i].position.fromArray(this.ownPosition, i * 3);
        }
        this.offsetsShown = false;
    }

    /** Whether offsets are still fading. */
    get fading(): boolean {
        return this.active;
    }

    /**
     * Records the new animation's pose `step` seconds before the switch (the bones as posed now), so the
     * switch knows how fast the new motion moves. Optional: without it the new motion counts as still.
     */
    noteBefore(step: number): void {
        for (let i = 0; i < this.count; i++) {
            const bone = this.bones[i];
            bone.quaternion.toArray(this.beforeRotation, i * 4);
            bone.position.toArray(this.beforePosition, i * 3);
        }
        this.beforeStep = step;
    }

    /**
     * A switch this frame, `dt` seconds after the pose last shown: the bones hold the new animation's
     * pose; the offsets become whatever separates it from where the old motion would be by now (the pose
     * last shown, carried on at its speed), moving as the old motion was moving relative to the new one.
     * This frame then shows the old motion exactly, and the difference fades from the next.
     */
    switchNow(dt = 0): void {
        if (this.shown < 1) {
            this.beforeStep = 0;
            return;
        }
        const haveVelocity = this.shown >= 2 && this.shownStep > 1e-6;
        const haveBefore = this.beforeStep > 1e-6;
        const ahead = Math.max(0, dt);
        for (let i = 0; i < this.count; i++) {
            const bone = this.bones[i];
            const r = i * 4, p = i * 3;
            // How fast the shown pose was turning.
            let wx = 0, wy = 0, wz = 0;
            if (haveVelocity) {
                _q.fromArray(this.shownRotation, r);
                _q2.fromArray(this.earlierRotation, r).invert();
                toRotationVector(_q.multiply(_q2), _v);
                wx = _v.x / this.shownStep; wy = _v.y / this.shownStep; wz = _v.z / this.shownStep;
            }
            // Rotation: the offset takes the new pose to the old motion carried on to now: old = offset * new.
            fromRotationVector(wx * ahead, wy * ahead, wz * ahead, _q).multiply(_q2.fromArray(this.shownRotation, r));
            _q2.copy(bone.quaternion).invert();
            toRotationVector(_q.multiply(_q2), _v);
            this.rotationOffset[p] = _v.x;
            this.rotationOffset[p + 1] = _v.y;
            this.rotationOffset[p + 2] = _v.z;
            // Less how fast the new one turns.
            if (haveBefore) {
                _q.copy(bone.quaternion);
                _q2.fromArray(this.beforeRotation, r).invert();
                toRotationVector(_q.multiply(_q2), _v);
                wx -= _v.x / this.beforeStep; wy -= _v.y / this.beforeStep; wz -= _v.z / this.beforeStep;
            }
            this.rotationVelocity[p] = wx;
            this.rotationVelocity[p + 1] = wy;
            this.rotationVelocity[p + 2] = wz;
            // Translation the same way.
            for (let k = 0; k < 3; k++) {
                const now = bone.position.getComponent(k);
                const moving = haveVelocity ? (this.shownPosition[p + k] - this.earlierPosition[p + k]) / this.shownStep : 0;
                this.positionOffset[p + k] = this.shownPosition[p + k] + moving * ahead - now;
                this.positionVelocity[p + k] = haveBefore ? moving - (now - this.beforePosition[p + k]) / this.beforeStep : moving;
            }
        }
        this.beforeStep = 0;
        this.active = true;
        this.elapsed = 0;
        this.justSwitched = true;
    }

    /**
     * Ends a frame: fades the offsets by `dt` and adds them to the bones (posed by the mixer), then
     * records the pose as shown.
     */
    apply(frameDt: number): void {
        if (this.active) {
            const dt = this.justSwitched ? 0 : Math.max(0, frameDt);
            this.justSwitched = false;
            const y = springDecay(this.halfLife);
            const decay = Math.exp(-y * dt);
            for (let i = 0; i < this.count; i++) {
                const bone = this.bones[i];
                const p = i * 3;
                bone.quaternion.toArray(this.ownRotation, i * 4);
                bone.position.toArray(this.ownPosition, p);
                for (let k = 0; k < 3; k++) {
                    // A critically damped spring toward zero, exact for the step.
                    const x0 = this.rotationOffset[p + k], v0 = this.rotationVelocity[p + k];
                    const j1 = v0 + x0 * y;
                    this.rotationOffset[p + k] = decay * (x0 + j1 * dt);
                    this.rotationVelocity[p + k] = decay * (v0 - j1 * y * dt);
                    const px = this.positionOffset[p + k], pv = this.positionVelocity[p + k];
                    const k1 = pv + px * y;
                    this.positionOffset[p + k] = decay * (px + k1 * dt);
                    this.positionVelocity[p + k] = decay * (pv - k1 * y * dt);
                }
                fromRotationVector(this.rotationOffset[p], this.rotationOffset[p + 1], this.rotationOffset[p + 2], _q);
                bone.quaternion.premultiply(_q);
                bone.position.x += this.positionOffset[p];
                bone.position.y += this.positionOffset[p + 1];
                bone.position.z += this.positionOffset[p + 2];
            }
            this.offsetsShown = true;
            this.elapsed += dt;
            if (this.elapsed > SETTLED_HALF_LIVES * this.halfLife) {
                this.active = false;
                this.positionOffset.fill(0);
                this.positionVelocity.fill(0);
                this.rotationOffset.fill(0);
                this.rotationVelocity.fill(0);
            }
        }
        // What is on screen now, for the next switch.
        this.earlierRotation.set(this.shownRotation);
        this.earlierPosition.set(this.shownPosition);
        for (let i = 0; i < this.count; i++) {
            this.bones[i].quaternion.toArray(this.shownRotation, i * 4);
            this.bones[i].position.toArray(this.shownPosition, i * 3);
        }
        this.shownStep = Math.max(0, frameDt);
        this.shown = Math.min(2, this.shown + 1);
    }

    /** Forgets what was shown (the character was hidden, reset or posed elsewhere): the next switch starts clean. */
    reset(): void {
        this.shown = 0;
        this.active = false;
        this.rotationOffset.fill(0);
        this.rotationVelocity.fill(0);
        this.positionOffset.fill(0);
        this.positionVelocity.fill(0);
    }
}
