import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { cameraDirector } from './cameraDirector';
import { PLAYER_PHYSICS_ID, usePhysicsQueries } from './physics';
import { useRuntimeServices } from './RuntimeServicesContext';
import { SURFACES } from './surfaces';
import { vehicleSession, type VehicleHandle } from './vehicles';

/**
 * VEHICLE CAMERA
 *
 * The view while the player drives. Change view (V) cycles a chase camera behind and above the
 * vehicle, a farther one, one on the bonnet and one at the front bumper; Look back (B) turns any of
 * them round while held. The chase cameras swing round after the vehicle as it turns, are kept off
 * walls and the ground, and mouse (or touch) look swings them round for a moment before they settle
 * back behind. The view shakes a little at speed, more on rough ground and hard with impacts and
 * landings, and its field of view widens with speed. A level camera (timeline, Set Active Camera,
 * script) still takes over the view, as it does from the character's rig.
 */

export type VehicleView = 'chase' | 'far' | 'hood' | 'bumper';
export const VEHICLE_VIEWS: readonly VehicleView[] = ['chase', 'far', 'hood', 'bumper'];

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
/** Shake: metres and radians at full strength, from speed, rough ground and knocks. */
const SHAKE_POSITION = 0.06;
const SHAKE_ANGLE = 0.012;

const UP = new THREE.Vector3(0, 1, 0);
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _up = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _look = new THREE.Vector3();
const _frame = new THREE.Matrix4();
const _shake = new THREE.Euler();
const _shakeQuaternion = new THREE.Quaternion();

const wrapAngle = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

/** The next view in the cycle. */
export const nextVehicleView = (view: VehicleView): VehicleView => VEHICLE_VIEWS[(VEHICLE_VIEWS.indexOf(view) + 1) % VEHICLE_VIEWS.length];

/**
 * How hard the view shakes, 0-1: a hum growing with speed, more over loose ground, and the vehicle's
 * last knock (an impact or landing) on top.
 */
export const vehicleShake = (vehicle: Pick<VehicleHandle, 'telemetry'>): number => {
    const telemetry = vehicle.telemetry();
    if (!telemetry) return 0;
    const speed = Math.abs(telemetry.speed);
    let loose = 0;
    let rolling = 0;
    for (const wheel of telemetry.wheels) {
        if (!wheel.contact) continue;
        rolling++;
        if (SURFACES[wheel.surface].loose) loose++;
    }
    const hum = 0.12 * Math.min(1, (speed / 50) ** 2);
    const rough = rolling ? 0.35 * (loose / rolling) * Math.min(1, speed / 15) : 0;
    return Math.min(1, hum + rough + telemetry.impact);
};

/** Smooth noise in about -1..1 from a few sines, distinct per `seed`. */
const wobble = (time: number, seed: number): number =>
    0.5 * Math.sin(time * 17.3 + seed * 1.7) + 0.3 * Math.sin(time * 29.1 + seed * 4.1) + 0.2 * Math.sin(time * 47.7 + seed * 2.3);

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
    const mode = useRef<VehicleView>('chase');
    const clock = useRef(0);
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
        clock.current += dt;

        // The vehicle's own frame: its front, left and up whichever way its model was built.
        vehicle.frame(_frame).decompose(_position, _quaternion, _scale);
        _forward.set(0, 0, 1).applyQuaternion(_quaternion);
        _up.set(0, 1, 0).applyQuaternion(_quaternion);
        const heading = Math.atan2(_forward.x, _forward.z);
        const reach = vehicle.reach();

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
            if (input.wasPressed('CameraView')) mode.current = nextVehicleView(mode.current);
            const touch = input.lookDelta();
            if (touch.x !== 0 || touch.y !== 0) addLook(touch.x, touch.y);
        }
        const back = active && input.isDown('LookBack');
        look.current.idle += dt;
        if (look.current.idle > LOOK_RETURN_DELAY) {
            const settle = 1 - Math.exp(-LOOK_RETURN_RATE * dt);
            look.current.yaw -= wrapAngle(look.current.yaw) * settle;
            look.current.pitch -= look.current.pitch * settle;
        }
        chase.heading += wrapAngle(heading - chase.heading) * (1 - Math.exp(-HEADING_RATE * dt));

        const current = mode.current;
        if (current === 'hood' || current === 'bumper') {
            // Mounted on the vehicle: on the bonnet above the windscreen's foot, or low at the front bumper.
            const box = vehicle.chassis();
            const size = box ? box.getSize(_scale) : _scale.set(1.8, 1.4, 4);
            const centreX = box ? (box.min.x + box.max.x) / 2 : 0;
            const local = current === 'hood'
                ? _offset.set(centreX, (box?.min.y ?? 0) + size.y * 0.72, (box?.max.z ?? 2) - size.z * 0.32)
                : _offset.set(centreX, (box?.min.y ?? 0) + size.y * 0.28, (box?.max.z ?? 2) + 0.05);
            camera.position.copy(local).applyMatrix4(_frame);
            chase.offset.copy(camera.position).sub(_position);
            const yaw = look.current.yaw + (back ? Math.PI : 0);
            _direction.copy(_forward).applyAxisAngle(_up, yaw).addScaledVector(_up, Math.tan(look.current.pitch - 0.04));
            _look.copy(camera.position).add(_direction);
            camera.up.copy(_up);
            camera.lookAt(_look);
            camera.up.copy(UP);
        } else {
            const far = current === 'far';
            const distance = (far ? 3.4 : 2.4) * reach + (far ? 3.5 : 2.5);
            const height = (far ? 1.1 : 0.8) * reach + (far ? 1.6 : 1.2);
            const yaw = chase.heading + look.current.yaw + (back ? Math.PI : 0);
            const pitch = PITCH + look.current.pitch;
            _pivot.copy(_position).addScaledVector(UP, height * 0.55);
            _offset.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(distance);
            // Kept clear of walls, the ground and the vehicle's own surroundings (never of the vehicle or its driver).
            _direction.copy(_offset);
            const length = _direction.length();
            const hit = queries.raycast(_pivot, _direction, length + CLEARANCE, { excludeObjectIds: [id, PLAYER_PHYSICS_ID] });
            if (hit) _offset.setLength(Math.max(0.5, hit.distance - CLEARANCE));
            _offset.add(_pivot).sub(_position);
            // Eased relative to the vehicle, so the camera does not trail further behind at speed; a look back snaps.
            chase.offset.lerp(_offset, back ? 1 : 1 - Math.exp(-FOLLOW_RATE * dt));
            camera.position.copy(_position).add(chase.offset);
            _look.copy(_position).addScaledVector(UP, height * 0.4).addScaledVector(_forward, (back ? -1 : 1) * Math.min(3, reach));
            camera.lookAt(_look);
        }

        // Shake: stronger mounted on the vehicle than chasing it.
        const shake = vehicleShake(vehicle) * (current === 'hood' || current === 'bumper' ? 1.4 : 1);
        if (shake > 0.001) {
            const t = clock.current;
            camera.position.x += wobble(t, 1) * SHAKE_POSITION * shake;
            camera.position.y += wobble(t, 2) * SHAKE_POSITION * shake;
            camera.position.z += wobble(t, 3) * SHAKE_POSITION * shake;
            _shake.set(wobble(t, 4) * SHAKE_ANGLE * shake, wobble(t, 5) * SHAKE_ANGLE * shake, wobble(t, 6) * SHAKE_ANGLE * shake);
            camera.quaternion.multiply(_shakeQuaternion.setFromEuler(_shake));
        }

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
