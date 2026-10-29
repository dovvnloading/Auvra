
import React, { useRef, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { AnimationGraphData, DEFAULT_MODEL_IMPORT_SETTINGS } from '../../types';
import { useRuntimeServices } from '../../runtime/RuntimeServicesContext';
import { cameraDirector } from '../../runtime/cameraDirector';
import { vehicleSession } from '../../runtime/vehicles';
import { measureCharacterHeight } from './hooks/usePlayerPhysics';

interface CharacterCameraRigProps {
    target: THREE.Object3D;
    graph?: AnimationGraphData;
    offset?: [number, number, number]; // Standard 3rd person pivot offset
    active: boolean;
    isAiming: boolean;
    aimOffset?: [number, number, number]; // Offset for Scope Mode
    /** How far the orbit sits to the camera's right (default-size units), so the character stands beside the crosshair, not under it. */
    shoulderOffset?: number;
    /** Radians per pixel of mouse movement; defaults to the player's options. */
    mouseSensitivity?: number;
    /** Mouse up looks down; defaults to the player's options. */
    invertY?: boolean;
    /** The target's starting yaw (radians, facing along +Z at 0): the camera starts behind it. */
    initialYaw?: number;
}

// Reusable math objects
const _targetWorldPos = new THREE.Vector3();
const _finalPos = new THREE.Vector3();
const _lookAtPos = new THREE.Vector3();
const _blendQuaternion = new THREE.Quaternion();

/** Seconds the rig takes to blend back from a vehicle's chase camera once the player is out. */
const VEHICLE_HANDBACK_SECONDS = 0.6;

/**
 * The rig's lengths (pivot and aim offsets, distance, zoom range) are authored for a character of the
 * default import size; a taller or shorter character scales them, so a human-sized character is
 * framed as the default one is.
 */
export const cameraRigScale = (target: THREE.Object3D): number =>
    measureCharacterHeight(target) / DEFAULT_MODEL_IMPORT_SETTINGS.targetSize;
const smoothStep = (t: number) => t * t * (3 - 2 * t);

export const CharacterCameraRig: React.FC<CharacterCameraRigProps> = ({ 
    target, 
    graph,
    offset = [0, 4.5, 0], 
    active,
    isAiming,
    aimOffset = [0.5, 4.5, 1.0],
    shoulderOffset = 1.0,
    mouseSensitivity,
    invertY,
    initialYaw = 0
}) => {
    const { camera, gl } = useThree();

    // Look settings: explicit props, else the player's options (the game's defaults outside a runtime).
    // Kept in a ref so changing them in the options menu applies without re-binding the listeners.
    const { options, input } = useRuntimeServices();
    const look = useRef({ sensitivity: 0, invertY: false });
    look.current.sensitivity = mouseSensitivity ?? options.mouseSensitivity;
    look.current.invertY = invertY ?? options.invertY;

    // Config
    const minPitch = 0.1;
    const maxPitch = Math.PI - 0.2;

    const scale = useMemo(() => cameraRigScale(target), [target]);
    const scaleRef = useRef(scale);
    scaleRef.current = scale;

    // Resolve Camera Distance from Graph
    const defaultDistance = useMemo(() => {
        const variable = graph?.variables.find(v => v.name === 'CameraDistance');
        return ((variable && typeof variable.value === 'number') ? variable.value : 6.0) * scale;
    }, [graph, scale]);

    // Internal State
    const state = useRef({
        theta: initialYaw + Math.PI,    // Yaw: the camera sits behind the target, looking the way it faces
        phi: Math.PI / 2.5,  // Pitch
        aimFactor: 0,      // 0 to 1 blending
        currentDistance: defaultDistance
    });

    // Input Handling
    useEffect(() => {
        const domElement = gl.domElement;

        const onMouseMove = (e: MouseEvent) => {
            if (!active || document.pointerLockElement !== domElement) return;

            // Dampen sensitivity when aiming for precision
            const sensitivity = isAiming ? look.current.sensitivity * 0.3 : look.current.sensitivity;
            const pitchSign = look.current.invertY ? -1 : 1;

            state.current.theta -= e.movementX * sensitivity;
            state.current.phi -= e.movementY * sensitivity * pitchSign;

            // Clamp vertical rotation
            state.current.phi = Math.max(minPitch, Math.min(maxPitch, state.current.phi));
        };

        const onClick = () => {
            if (active) Promise.resolve(domElement.requestPointerLock()).catch(() => undefined);
        };

        const onWheel = (e: WheelEvent) => {
            if (!active || isAiming) return;
            const zoom = scaleRef.current;
            state.current.currentDistance += e.deltaY * 0.005 * zoom;
            state.current.currentDistance = Math.max(2.0 * zoom, Math.min(15.0 * zoom, state.current.currentDistance));
        };

        // Right mouse is the default Aim binding; keep the browser menu from opening over the game.
        const onContextMenu = (e: MouseEvent) => {
            if (active) e.preventDefault();
        };

        document.addEventListener('mousemove', onMouseMove);
        domElement.addEventListener('click', onClick);
        domElement.addEventListener('wheel', onWheel, { passive: true });
        domElement.addEventListener('contextmenu', onContextMenu);

        return () => {
            document.removeEventListener('mousemove', onMouseMove);
            domElement.removeEventListener('click', onClick);
            domElement.removeEventListener('wheel', onWheel);
            domElement.removeEventListener('contextmenu', onContextMenu);
        };
    }, [active, gl, isAiming]);

    // Sync distance when graph changes (optional)
    useEffect(() => {
        state.current.currentDistance = defaultDistance;
    }, [defaultDistance]);

    // Frame Loop - Standard Priority
    // While the player drives, the vehicle's chase camera has the view; on the way out the rig blends back from it.
    const handback = useRef<{ driving: boolean; from: { position: THREE.Vector3; quaternion: THREE.Quaternion } | null; elapsed: number }>({ driving: false, from: null, elapsed: 0 });

    useFrame((_, delta) => {
        if (vehicleSession.state().driving !== null) {
            handback.current.driving = true;
            return;
        }
        if (handback.current.driving) {
            // Out of the vehicle: start behind the character, blending from where the chase camera left the view.
            handback.current = { driving: false, from: { position: camera.position.clone(), quaternion: camera.quaternion.clone() }, elapsed: 0 };
            state.current.theta = target.rotation.y + Math.PI;
        }
        if (!target) return;
        // A level camera (timeline, Set Active Camera, script) owns the view; the rig resumes when it is released.
        if (cameraDirector.activeId() !== null) return;

        // Touch look (the right-hand drag area); devices without pointer lock have no mouse look.
        if (active) {
            const touchLook = input.lookDelta();
            if (touchLook.x !== 0 || touchLook.y !== 0) {
                const sensitivity = isAiming ? look.current.sensitivity * 0.3 : look.current.sensitivity;
                const pitchSign = look.current.invertY ? -1 : 1;
                state.current.theta -= touchLook.x * sensitivity;
                state.current.phi = Math.max(minPitch, Math.min(maxPitch, state.current.phi - touchLook.y * sensitivity * pitchSign));
            }
        }

        // 1. Interpolate Aim Factor (Smooth transition between modes)
        const targetAimFactor = isAiming ? 1.0 : 0.0;
        state.current.aimFactor = THREE.MathUtils.lerp(state.current.aimFactor, targetAimFactor, delta * 15);

        // 2. Get Stable Target Position
        target.getWorldPosition(_targetWorldPos);
        
        // 3. Calculate 3rd Person View (Orbit)
        // Pivot is centered on character + offset
        const pivotY = _targetWorldPos.y + offset[1] * scale;
        const pivotX = _targetWorldPos.x;
        const pivotZ = _targetWorldPos.z;

        const sinPhi = Math.sin(state.current.phi);
        const cosPhi = Math.cos(state.current.phi);
        const sinTheta = Math.sin(state.current.theta);
        const cosTheta = Math.cos(state.current.theta);

        // Forward vector based on camera angles
        const fwdX = sinTheta; // Using theta directly for simplified forward direction on XZ
        const fwdZ = cosTheta;
        const rightX = cosTheta;
        const rightZ = -sinTheta;

        // Standard Orbit Position, moved over the shoulder: the camera and the point it looks at both
        // sit to the right, so the view keeps its direction and the head is beside the crosshair.
        const shoulderX = rightX * shoulderOffset * scale;
        const shoulderZ = rightZ * shoulderOffset * scale;
        const orbitDist = state.current.currentDistance;
        const orbitX = pivotX + shoulderX + orbitDist * sinPhi * sinTheta;
        const orbitY = pivotY + orbitDist * cosPhi;
        const orbitZ = pivotZ + shoulderZ + orbitDist * sinPhi * cosTheta;

        // 4. Calculate Aim View (Scope)
        // Position is offset relative to character, rotated by camera angle
        // Essentially placing the camera "at the shoulder" looking forward

        // Aim Position: Start at Head
        const aimX = pivotX 
            + (rightX * aimOffset[0] * scale) // Shift Right
            - (fwdX * aimOffset[2] * scale);  // Shift Forward/Back
        
        const aimY = _targetWorldPos.y + aimOffset[1] * scale; // Height
        
        const aimZ = pivotZ 
            + (rightZ * aimOffset[0] * scale) // Shift Right
            - (fwdZ * aimOffset[2] * scale);  // Shift Forward/Back

        // 5. Blend Positions
        // If aimFactor is 0, use orbit. If 1, use aim.
        _finalPos.set(orbitX, orbitY, orbitZ).lerp(new THREE.Vector3(aimX, aimY, aimZ), state.current.aimFactor);

        // 6. Look At Point
        // In 3rd person: Look at Pivot
        // In Aim: Look forward from camera position (infinite target) OR keep looking at pivot offset
        // To prevent disorientation, we look at a point projected forward from the pivot
        
        // Look Pivot
        _lookAtPos.set(pivotX, pivotY, pivotZ);
        
        // When aiming, we want the camera orientation to be controlled purely by theta/phi
        // We can simulate this by looking at a point on the sphere surface defined by theta/phi
        const lookTargetDist = 100;
        const lookX = _finalPos.x - (lookTargetDist * sinPhi * sinTheta);
        const lookY = _finalPos.y - (lookTargetDist * cosPhi);
        const lookZ = _finalPos.z - (lookTargetDist * sinPhi * cosTheta);
        
        // Blend look targets? 
        // Actually, standard Orbit lookAt is center.
        // FPS lookAt is "forward".
        // Let's blend the lookAt target.
        
        const orbitLookAt = new THREE.Vector3(pivotX + shoulderX, pivotY, pivotZ + shoulderZ);
        const aimLookAt = new THREE.Vector3(lookX, lookY, lookZ);
        
        // Critical: As we transition to Aim, we switch from "Looking AT character" to "Looking OUT from character"
        _lookAtPos.copy(orbitLookAt).lerp(aimLookAt, state.current.aimFactor);

        // 7. Apply to Camera
        camera.position.copy(_finalPos);
        camera.lookAt(_lookAtPos);

        const from = handback.current.from;
        if (from) {
            handback.current.elapsed += delta;
            const t = smoothStep(Math.min(1, handback.current.elapsed / VEHICLE_HANDBACK_SECONDS));
            _blendQuaternion.copy(camera.quaternion);
            camera.position.lerpVectors(from.position, _finalPos, t);
            camera.quaternion.slerpQuaternions(from.quaternion, _blendQuaternion, t);
            if (t >= 1) handback.current.from = null;
        }
    });

    return null;
};
