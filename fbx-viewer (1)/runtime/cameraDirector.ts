import * as THREE from 'three';

/**
 * CAMERA DIRECTOR
 *
 * Decides which camera the player sees: the gameplay camera (the character's camera rig) or one of
 * the level's camera components, chosen by a timeline camera track, a Set Active Camera node or a
 * script. Switching blends position, rotation and field of view over the requested time. The rig
 * stops steering the view while a level camera is active and takes over again when it is released.
 */

export interface CameraDirector {
    /** Makes a camera component's camera available under its object id; returns the unregister function. */
    register(objectId: string, camera: THREE.PerspectiveCamera): () => void;
    /** Shows camera `objectId` (null: the gameplay camera), blending over `blendSeconds`. Unknown ids are ignored. */
    setActive(objectId: string | null, blendSeconds?: number): void;
    /** The level camera shown now, or null for the gameplay camera. */
    activeId(): string | null;
    /** True while a level camera drives the view or a blend toward the gameplay camera is still running. */
    overridesView(): boolean;
    /** Puts the active camera's view on `view` (the rendered camera), after the gameplay rig has run. */
    apply(view: THREE.PerspectiveCamera, delta: number): void;
    /** Forgets every camera and request, for a new play session. */
    reset(): void;
}

interface Blend {
    fromPosition: THREE.Vector3;
    fromQuaternion: THREE.Quaternion;
    fromFov: number;
    elapsed: number;
    duration: number;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

export const createCameraDirector = (): CameraDirector => {
    const cameras = new Map<string, THREE.PerspectiveCamera>();
    let active: string | null = null;
    let blend: Blend | null = null;
    // The rendered view as last applied, so a new blend starts from what the player saw.
    const lastPosition = new THREE.Vector3();
    const lastQuaternion = new THREE.Quaternion();
    let lastFov = 60;
    let hasLast = false;
    let gameplayFov: number | null = null;
    const targetPosition = new THREE.Vector3();
    const targetQuaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    const director: CameraDirector = {
        register(objectId, camera) {
            cameras.set(objectId, camera);
            return () => {
                if (cameras.get(objectId) !== camera) return;
                cameras.delete(objectId);
                if (active === objectId) director.setActive(null, 0);
            };
        },
        setActive(objectId, blendSeconds = 0) {
            const next = objectId && cameras.has(objectId) ? objectId : null;
            if (next === active) return;
            if (objectId && !next) return;
            active = next;
            const duration = Number.isFinite(blendSeconds) && blendSeconds > 0 ? blendSeconds : 0;
            blend = duration > 0 && hasLast
                ? { fromPosition: lastPosition.clone(), fromQuaternion: lastQuaternion.clone(), fromFov: lastFov, elapsed: 0, duration }
                : null;
        },
        activeId: () => active,
        overridesView: () => active !== null || blend !== null,
        apply(view, delta) {
            const target = active ? cameras.get(active) : null;
            if (target) {
                if (gameplayFov === null) gameplayFov = view.fov;
                target.updateWorldMatrix(true, false);
                target.matrixWorld.decompose(targetPosition, targetQuaternion, scale);
            } else {
                // The rig has already placed the view for this frame; only a blend needs to change it.
                if (!blend) {
                    if (gameplayFov !== null) {
                        view.fov = gameplayFov;
                        view.updateProjectionMatrix();
                        gameplayFov = null;
                    }
                    lastPosition.copy(view.position);
                    lastQuaternion.copy(view.quaternion);
                    lastFov = view.fov;
                    hasLast = true;
                    return;
                }
                targetPosition.copy(view.position);
                targetQuaternion.copy(view.quaternion);
            }
            const targetFov = target ? target.fov : gameplayFov ?? view.fov;
            let t = 1;
            if (blend) {
                blend.elapsed += Math.max(0, Math.min(delta, 0.1));
                t = Math.min(1, blend.elapsed / blend.duration);
            }
            if (blend && t < 1) {
                const k = smooth(t);
                view.position.copy(blend.fromPosition).lerp(targetPosition, k);
                view.quaternion.copy(blend.fromQuaternion).slerp(targetQuaternion, k);
                view.fov = blend.fromFov + (targetFov - blend.fromFov) * k;
            } else {
                blend = null;
                view.position.copy(targetPosition);
                view.quaternion.copy(targetQuaternion);
                view.fov = targetFov;
                if (!target && gameplayFov !== null) gameplayFov = null;
            }
            view.updateProjectionMatrix();
            view.updateMatrixWorld();
            lastPosition.copy(view.position);
            lastQuaternion.copy(view.quaternion);
            lastFov = view.fov;
            hasLast = true;
        },
        reset() {
            cameras.clear();
            active = null;
            blend = null;
            hasLast = false;
            gameplayFov = null;
        },
    };
    return director;
};

/** The play session's camera director. */
export const cameraDirector = createCameraDirector();
