import * as THREE from 'three';

/**
 * SPATIAL AUDIO
 *
 * three's AudioListener and PositionalAudio ramp their Web Audio position and orientation params on
 * every matrix update (several times a frame), whether or not anything moved. A context that is not
 * running (the editor before its first click, a paused game) never plays those ramps out, so the
 * browser keeps every one of them: about 1,600 a second for the camera's listener alone, gigabytes
 * of native memory overnight, until the page runs out and dies.
 *
 * The engine's listener and positional sound write a param only when its value changes, and only
 * while the context runs; after the context resumes (or after a long still spell) the first write
 * snaps to the current pose instead of gliding from a stale one. The listener's up also turns with
 * it (three's stays world up), so a rolled camera hears rolled.
 */

/** Changes smaller than this (metres, or unit-vector components) are not rescheduled. */
export const SPATIAL_EPSILON = 1e-4;
/** Shortest and longest glide to a new value, seconds: about a frame. */
export const MIN_SPATIAL_RAMP = 1 / 240;
export const MAX_SPATIAL_RAMP = 1 / 20;
/** After this long without a write the params snap to the next pose instead of gliding to it. */
export const SPATIAL_SNAP_AFTER = 0.25;

type ParamContext = Pick<BaseAudioContext, 'state' | 'currentTime'>;
interface Param {
    setValueAtTime(value: number, time: number): unknown;
    linearRampToValueAtTime(value: number, time: number): unknown;
    cancelScheduledValues(time: number): unknown;
}

/** Schedules a fixed set of AudioParams towards new values, only when they change and the context runs. */
export class SpatialParamWriter {
    private readonly written: Float64Array;
    /** When each param's last scheduled event ends. */
    private readonly endAt: Float64Array;
    private lastWrite = -Infinity;
    /** The context was not running when last asked: the next write snaps. */
    private stale = true;

    constructor(private readonly params: readonly Param[]) {
        this.written = new Float64Array(params.length).fill(Number.NaN);
        this.endAt = new Float64Array(params.length).fill(-Infinity);
    }

    /** Moves the params towards `values`; returns how many it scheduled. */
    write(context: ParamContext, values: ArrayLike<number>): number {
        if (context.state !== 'running') {
            this.stale = true;
            return 0;
        }
        const now = context.currentTime;
        const snap = this.stale || now - this.lastWrite > SPATIAL_SNAP_AFTER;
        const ramp = Math.min(MAX_SPATIAL_RAMP, Math.max(MIN_SPATIAL_RAMP, now - this.lastWrite));
        let scheduled = 0;
        for (let i = 0; i < this.params.length; i++) {
            const value = values[i];
            if (!Number.isFinite(value)) continue;
            const written = this.written[i];
            const changed = Number.isNaN(written) || Math.abs(value - written) > SPATIAL_EPSILON;
            if (!changed && !this.stale) continue;
            const param = this.params[i];
            if (snap || Number.isNaN(written)) {
                // Drops ramps scheduled before a suspend, which would otherwise carry it back to an old pose.
                param.cancelScheduledValues(now);
                param.setValueAtTime(value, now);
                this.endAt[i] = now;
            } else {
                // A finished glide holds its value until now, then glides on from there.
                if (this.endAt[i] < now) param.setValueAtTime(written, now);
                const end = Math.max(now + ramp, this.endAt[i]);
                param.linearRampToValueAtTime(value, end);
                this.endAt[i] = end;
            }
            this.written[i] = value;
            scheduled++;
        }
        this.stale = false;
        if (scheduled > 0) this.lastWrite = now;
        return scheduled;
    }
}

const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _up = new THREE.Vector3();
const _values = new Float64Array(9);

/** True when `values` differs from `last` (and copies it in); for browsers without AudioParam positions. */
const changedSince = (last: Float64Array, values: Float64Array, count: number): boolean => {
    let changed = false;
    for (let i = 0; i < count; i++) {
        if (!(Math.abs(values[i] - last[i]) <= SPATIAL_EPSILON)) changed = true;
        last[i] = values[i];
    }
    return changed;
};

/** The engine's AudioListener: the camera's ears. */
export class SpatialAudioListener extends THREE.AudioListener {
    private writer: SpatialParamWriter | null = null;
    private legacy: Float64Array | null = null;
    private readonly clock = new THREE.Clock();

    override updateMatrixWorld(force?: boolean): void {
        THREE.Object3D.prototype.updateMatrixWorld.call(this, force);
        // Read by three's own PositionalAudio, should one be attached.
        (this as { timeDelta: number }).timeDelta = this.clock.getDelta();
        this.matrixWorld.decompose(_position, _quaternion, _scale);
        _forward.set(0, 0, -1).applyQuaternion(_quaternion);
        _up.set(0, 1, 0).applyQuaternion(_quaternion);
        _values[0] = _position.x; _values[1] = _position.y; _values[2] = _position.z;
        _values[3] = _forward.x; _values[4] = _forward.y; _values[5] = _forward.z;
        _values[6] = _up.x; _values[7] = _up.y; _values[8] = _up.z;
        const listener = this.context.listener;
        if (listener.positionX) {
            this.writer ??= new SpatialParamWriter([
                listener.positionX, listener.positionY, listener.positionZ,
                listener.forwardX, listener.forwardY, listener.forwardZ,
                listener.upX, listener.upY, listener.upZ,
            ]);
            this.writer.write(this.context, _values);
        } else if (changedSince(this.legacy ??= new Float64Array(9).fill(Number.NaN), _values, 9)) {
            listener.setPosition(_values[0], _values[1], _values[2]);
            listener.setOrientation(_values[3], _values[4], _values[5], _values[6], _values[7], _values[8]);
        }
    }
}

/** The engine's PositionalAudio: a sound in the world, heard from where it is and the way it faces. */
export class SpatialPositionalAudio extends THREE.PositionalAudio {
    private writer: SpatialParamWriter | null = null;
    private legacy: Float64Array | null = null;

    override updateMatrixWorld(force?: boolean): void {
        THREE.Object3D.prototype.updateMatrixWorld.call(this, force);
        if (this.hasPlaybackControl === true && this.isPlaying === false) return;
        this.matrixWorld.decompose(_position, _quaternion, _scale);
        _forward.set(0, 0, 1).applyQuaternion(_quaternion);
        _values[0] = _position.x; _values[1] = _position.y; _values[2] = _position.z;
        _values[3] = _forward.x; _values[4] = _forward.y; _values[5] = _forward.z;
        const panner = this.panner;
        if (panner.positionX) {
            this.writer ??= new SpatialParamWriter([
                panner.positionX, panner.positionY, panner.positionZ,
                panner.orientationX, panner.orientationY, panner.orientationZ,
            ]);
            this.writer.write(this.context, _values);
        } else if (changedSince(this.legacy ??= new Float64Array(6).fill(Number.NaN), _values, 6)) {
            panner.setPosition(_values[0], _values[1], _values[2]);
            panner.setOrientation(_values[3], _values[4], _values[5]);
        }
    }
}
