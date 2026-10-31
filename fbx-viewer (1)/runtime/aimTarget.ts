import * as THREE from 'three';
import type { PhysicsQueries } from './physicsQueries';

/** How far an aim with nothing in its way reaches, in world units. */
export const AIM_REACH = 1000;

const _forward = new THREE.Vector3();
const _origin = new THREE.Vector3();

/**
 * The world point the crosshair (the middle of `camera`'s view) is on: the first thing the ray
 * from the camera hits, skipping `excludeObjectId` (the shooter's own body), else AIM_REACH ahead.
 */
export const crosshairTarget = (
    camera: THREE.Camera,
    raycast: PhysicsQueries['raycast'] | null,
    excludeObjectId: string | undefined,
    out: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 => {
    camera.updateMatrixWorld();
    camera.getWorldPosition(_origin);
    camera.getWorldDirection(_forward);
    const hit = raycast ? raycast(_origin, _forward, AIM_REACH, { excludeObjectId }) : null;
    return hit ? out.copy(hit.point) : out.copy(_origin).addScaledVector(_forward, AIM_REACH);
};
