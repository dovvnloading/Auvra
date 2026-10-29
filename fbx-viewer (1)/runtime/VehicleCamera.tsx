import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { cameraDirector } from './cameraDirector';
import { PLAYER_PHYSICS_ID, usePhysicsQueries } from './physics';
import { useRuntimeServices } from './RuntimeServicesContext';
import { vehicleSession } from './vehicles';

/**
 * VEHICLE CAMERA
 *
 * The view while the player drives: behind and above the vehicle, swinging round after it as it
 * turns, kept off walls and the ground. Mouse (or touch) look swings it round for a moment, then it
 * settles back behind. The field of view widens with speed. It follows the vehicle's own frame of
 * motion, so it does not trail further behind the faster the vehicle goes. A level camera
 * (timeline, Set Active Camera, script) still takes over the view, as it does from the character's rig.
 */

/** How fast the camera closes on its place behind the vehicle, per second. */
const FOLLOW_RATE = 5;
/** How fast it swings round after the vehicle's heading, per second. */
const HEADING_RATE = 3;
/** Seconds after the last look input before the camera swings back behind. */
const LOOK_RETURN_DELAY = 1.5;
const LOOK_RETURN_RATE = 2.5;
/** Pitch above the vehicle, radians, and how far look input may tilt it. */
const PITCH = 0.2;
const PITCH_RANGE: [number, number] = [-0.25, 0.9];
/** Degrees the field of view widens by at this speed (m/s) and above. */
const FOV_BOOST = 10;
const FOV_BOOST_SPEED = 40;
/** The camera keeps this far in front of whatever it would otherwise go into, metres. */
const CLEARANCE = 0.3;

const UP = new THREE.Vector3(0, 1, 0);
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _look = new THREE.Vector3();

const wrapAngle = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

interface ChaseView {
    vehicle: string;
    heading: number;
    /** Camera position relative to the vehicle. */
    offset: THREE.Vector3;
    baseFov: number | null;
}

export const VehicleCameraRig: React.FC<{ active: boolean }> = ({ active }) => {
    const { camera, gl } = useThree();
    const { options, input } = useRuntimeServices();
    const queries = usePhysicsQueries();
    const look = useRef({ yaw: 0, pitch: 0, idle: Infinity });
    const view = useRef<ChaseView | null>(null);
    const lookOptions = useRef(options);
    lookOptions.current = options;

    const addLook = (dx: number, dy: number) => {
        const { mouseSensitivity, invertY } = lookOptions.current;
        look.current.yaw -= dx * mouseSensitivity;
        look.current.pitch = THREE.MathUtils.clamp(look.current.pitch - dy * mouseSensitivity * (invertY ? -1 : 1), PITCH_RANGE[0] - PITCH, PITCH_RANGE[1] - PITCH);
        look.current.idle = 0;
    };

    useEffect(() => {
        const domElement = gl.domElement;
        const onMouseMove = (event: MouseEvent) => {
            if (!active || vehicleSession.state().driving === null || document.pointerLockElement !== domElement) return;
            addLook(event.movementX, event.movementY);
        };
        document.addEventListener('mousemove', onMouseMove);
        return () => document.removeEventListener('mousemove', onMouseMove);
    }, [active, gl]);

    useEffect(() => () => {
        const perspective = camera as THREE.PerspectiveCamera;
        if (view.current?.baseFov != null && perspective.isPerspectiveCamera) {
            perspective.fov = view.current.baseFov;
            perspective.updateProjectionMatrix();
        }
    }, [camera]);

    useFrame((_, delta) => {
        const perspective = camera as THREE.PerspectiveCamera;
        const id = vehicleSession.state().driving;
        if (!id) {
            // Out of the vehicle: the field of view goes back to the player's own.
            if (view.current?.baseFov != null && perspective.isPerspectiveCamera) {
                perspective.fov = view.current.baseFov;
                perspective.updateProjectionMatrix();
            }
            view.current = null;
            return;
        }
        const vehicle = vehicleSession.get(id);
        if (!vehicle || cameraDirector.activeId() !== null) return;
        const dt = Math.min(delta, 0.1);

        vehicle.host.updateWorldMatrix(true, false);
        vehicle.host.matrixWorld.decompose(_position, _quaternion, _scale);
        _forward.set(0, 0, 1).applyQuaternion(_quaternion);
        const heading = Math.atan2(_forward.x, _forward.z);
        const reach = vehicle.reach();
        const distance = 2.4 * reach + 2.5;
        const height = 0.8 * reach + 1.2;

        if (!view.current || view.current.vehicle !== id) {
            // Getting in: from wherever the view is now, swinging round behind.
            view.current = {
                vehicle: id,
                heading: Math.atan2(_position.x - camera.position.x, _position.z - camera.position.z),
                offset: camera.position.clone().sub(_position),
                baseFov: perspective.isPerspectiveCamera ? perspective.fov : null,
            };
            look.current = { yaw: 0, pitch: 0, idle: Infinity };
        }
        const chase = view.current;

        if (active) {
            const touch = input.lookDelta();
            if (touch.x !== 0 || touch.y !== 0) addLook(touch.x, touch.y);
        }
        look.current.idle += dt;
        if (look.current.idle > LOOK_RETURN_DELAY) {
            const settle = 1 - Math.exp(-LOOK_RETURN_RATE * dt);
            look.current.yaw -= wrapAngle(look.current.yaw) * settle;
            look.current.pitch -= look.current.pitch * settle;
        }
        chase.heading += wrapAngle(heading - chase.heading) * (1 - Math.exp(-HEADING_RATE * dt));

        const yaw = chase.heading + look.current.yaw;
        const pitch = PITCH + look.current.pitch;
        _pivot.copy(_position).addScaledVector(UP, height * 0.55);
        _offset.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(distance);
        // Kept clear of walls, the ground and the vehicle's own surroundings (never of the vehicle or its driver).
        _direction.copy(_offset);
        const length = _direction.length();
        const hit = queries.raycast(_pivot, _direction, length + CLEARANCE, { excludeObjectIds: [id, PLAYER_PHYSICS_ID] });
        if (hit) _offset.setLength(Math.max(0.5, hit.distance - CLEARANCE));
        _offset.add(_pivot).sub(_position);
        // Eased relative to the vehicle, so the camera does not trail further behind at speed.
        chase.offset.lerp(_offset, 1 - Math.exp(-FOLLOW_RATE * dt));
        camera.position.copy(_position).add(chase.offset);
        _look.copy(_position).addScaledVector(UP, height * 0.4).addScaledVector(_forward, Math.min(3, reach));
        camera.lookAt(_look);

        if (chase.baseFov !== null && perspective.isPerspectiveCamera) {
            const fov = chase.baseFov + FOV_BOOST * Math.min(1, Math.abs(vehicle.speed()) / FOV_BOOST_SPEED);
            if (Math.abs(fov - perspective.fov) > 0.05) {
                perspective.fov = fov;
                perspective.updateProjectionMatrix();
            }
        }
    });

    return null;
};
