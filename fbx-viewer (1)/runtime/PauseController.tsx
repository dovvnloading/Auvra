import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useRapier } from '@react-three/rapier';
import { frontendDiagnostics } from '../diagnostics/runtime';
import { usePhysicsAvailable } from './physicsQueries';
import { useRuntimeServices } from './RuntimeServicesContext';

interface PauseControllerProps {
    paused: boolean;
    /** False while a pause makes no sense, e.g. on the game-over screen. */
    canPause: boolean;
    /** Changing this captures the pointer again for the fresh session. */
    sessionKey: number;
    onRequestPause: () => void;
}

const POINTER_LOCK_DELAY_MS = 100;

const lockPointer = (canvas: HTMLCanvasElement) => {
    if (typeof canvas.requestPointerLock !== 'function' || document.pointerLockElement === canvas) return;
    try {
        // Without a recent user gesture the browser refuses; the camera rig locks again on the next canvas click.
        Promise.resolve(canvas.requestPointerLock()).catch(() => undefined);
    } catch {
        // Older browsers throw instead of rejecting.
    }
};

/**
 * Owns pausing for the level runtime. Renders inside the runtime canvas.
 *
 * Paused: the frame loop stops (all gameplay runs in useFrame), the level's audio context is
 * suspended and the pointer is released. Losing the pointer lock asks the host to pause; the Pause
 * input action does too, through PauseActionWatcher.
 */
export const PauseController: React.FC<PauseControllerProps> = ({ paused, canPause, sessionKey, onRequestPause }) => {
    const setFrameloop = useThree(state => state.setFrameloop);
    const clock = useThree(state => state.clock);
    const camera = useThree(state => state.camera);
    const gl = useThree(state => state.gl);

    useEffect(() => {
        // Reading the clock on resume drops the paused time, so the first frame back is not one huge step.
        if (!paused) clock.getDelta();
        setFrameloop(paused ? 'never' : 'always');
    }, [clock, paused, setFrameloop]);

    // Every level sound plays through the camera's AudioListener, so suspending its context freezes them in place.
    useEffect(() => {
        if (!paused) return undefined;
        const listener = camera.children.find(child => child.type === 'AudioListener') as THREE.AudioListener | undefined;
        const context = listener?.context;
        if (!context || context.state !== 'running') return undefined;
        context.suspend().catch(() => frontendDiagnostics.warning('runtime_audio_suspend_failed'));
        return () => {
            context.resume().catch(() => frontendDiagnostics.warning('runtime_audio_resume_failed'));
        };
    }, [camera, paused]);

    useEffect(() => {
        const canvas = gl.domElement;
        const active = !paused && canPause;
        let requested = false;
        let held = document.pointerLockElement === canvas;

        const requestPause = () => {
            if (!active || requested) return;
            requested = true;
            onRequestPause();
        };
        const handleLockChange = () => {
            const nowHeld = document.pointerLockElement === canvas;
            if (held && !nowHeld) requestPause();
            held = nowHeld;
        };

        document.addEventListener('pointerlockchange', handleLockChange);
        let timer: ReturnType<typeof setTimeout> | null = null;
        if (active) timer = setTimeout(() => lockPointer(canvas), POINTER_LOCK_DELAY_MS);
        else if (held) document.exitPointerLock();

        return () => {
            if (timer) clearTimeout(timer);
            document.removeEventListener('pointerlockchange', handleLockChange);
        };
    }, [canPause, gl, onRequestPause, paused, sessionKey]);

    // Leaving the level always gives the pointer back.
    useEffect(() => () => {
        if (document.pointerLockElement === gl.domElement) document.exitPointerLock();
    }, [gl]);

    return null;
};

/**
 * Requests a pause when the player presses the Pause action (Escape or gamepad Start unless
 * rebound). Mount inside RuntimeServicesProvider; frames stop while paused, so it only fires in play.
 */
export const PauseActionWatcher: React.FC<{ enabled: boolean; onRequestPause: () => void }> = ({ enabled, onRequestPause }) => {
    const { input } = useRuntimeServices();
    useFrame(() => {
        if (enabled && input.wasPressed('Pause')) onRequestPause();
    });
    return null;
};

/** Seconds of game time one stepped frame advances. */
export const STEP_SECONDS = 1 / 60;

const PhysicsStepRegistrar: React.FC<{ stepRef: React.MutableRefObject<((delta: number) => void) | null> }> = ({ stepRef }) => {
    const { step } = useRapier();
    useEffect(() => {
        stepRef.current = step;
        return () => { stepRef.current = null; };
    }, [step, stepRef]);
    return null;
};

/**
 * Runs exactly one frame of the paused game each time `stepRequest` changes: one physics tick, then
 * every frame callback with a delta of STEP_SECONDS. Does nothing while the game runs. Mount inside
 * PhysicsWorld.
 */
export const FrameStepper: React.FC<{ paused: boolean; stepRequest: number }> = ({ paused, stepRequest }) => {
    const advance = useThree(state => state.advance);
    const clock = useThree(state => state.clock);
    const physicsAvailable = usePhysicsAvailable();
    const stepPhysics = useRef<((delta: number) => void) | null>(null);
    const lastRequest = useRef(stepRequest);

    useEffect(() => {
        if (stepRequest === lastRequest.current) return;
        lastRequest.current = stepRequest;
        if (!paused) return;
        stepPhysics.current?.(STEP_SECONDS);
        // In frameloop 'never' the timestamp sets the clock, so the frame's delta is exactly one step.
        advance(clock.elapsedTime + STEP_SECONDS);
    }, [advance, clock, paused, stepRequest]);

    return physicsAvailable ? <PhysicsStepRegistrar stepRef={stepPhysics} /> : null;
};

/** One level object as it is in the running game. Rotation is world Euler XYZ in degrees. */
export interface InspectedObject {
    id: string;
    position: [number, number, number];
    rotation: [number, number, number];
    visible: boolean;
}

export type RuntimeInspector = () => InspectedObject[];

const effectivelyVisible = (object: THREE.Object3D): boolean => {
    for (let node: THREE.Object3D | null = object; node; node = node.parent) if (!node.visible) return false;
    return true;
};

/** Every drawn level object (tagged with userData.levelObjectId) with its live world transform, outermost group per id. */
export const inspectScene = (scene: THREE.Object3D): InspectedObject[] => {
    const found = new Map<string, InspectedObject>();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const euler = new THREE.Euler();
    scene.updateMatrixWorld(true);
    scene.traverse(node => {
        const id = node.userData?.levelObjectId;
        if (typeof id !== 'string' || found.has(id)) return;
        node.matrixWorld.decompose(position, quaternion, scale);
        euler.setFromQuaternion(quaternion);
        const degrees = (value: number) => Math.round(THREE.MathUtils.radToDeg(value) * 10) / 10;
        found.set(id, {
            id,
            position: [position.x, position.y, position.z],
            rotation: [degrees(euler.x), degrees(euler.y), degrees(euler.z)],
            visible: effectivelyVisible(node),
        });
    });
    return [...found.values()];
};

/** Lets code outside the canvas (the play toolbar) read the running scene through `inspectRef`. */
export const SceneInspector: React.FC<{ inspectRef?: React.MutableRefObject<RuntimeInspector | null> }> = ({ inspectRef }) => {
    const scene = useThree(state => state.scene);
    useEffect(() => {
        if (!inspectRef) return;
        inspectRef.current = () => inspectScene(scene);
        return () => { inspectRef.current = null; };
    }, [inspectRef, scene]);
    return null;
};
