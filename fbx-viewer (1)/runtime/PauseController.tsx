import React, { useEffect } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { frontendDiagnostics } from '../diagnostics/runtime';

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
 * suspended and the pointer is released. Escape or losing the pointer lock asks the host to pause.
 */
export const PauseController: React.FC<PauseControllerProps> = ({ paused, canPause, sessionKey, onRequestPause }) => {
    const setFrameloop = useThree(state => state.setFrameloop);
    const camera = useThree(state => state.camera);
    const gl = useThree(state => state.gl);

    useEffect(() => {
        setFrameloop(paused ? 'never' : 'always');
    }, [paused, setFrameloop]);

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
        const handleKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') requestPause();
        };
        const handleLockChange = () => {
            const nowHeld = document.pointerLockElement === canvas;
            if (held && !nowHeld) requestPause();
            held = nowHeld;
        };

        window.addEventListener('keydown', handleKey);
        document.addEventListener('pointerlockchange', handleLockChange);
        let timer: ReturnType<typeof setTimeout> | null = null;
        if (active) timer = setTimeout(() => lockPointer(canvas), POINTER_LOCK_DELAY_MS);
        else if (held) document.exitPointerLock();

        return () => {
            if (timer) clearTimeout(timer);
            window.removeEventListener('keydown', handleKey);
            document.removeEventListener('pointerlockchange', handleLockChange);
        };
    }, [canPause, gl, onRequestPause, paused, sessionKey]);

    // Leaving the level always gives the pointer back.
    useEffect(() => () => {
        if (document.pointerLockElement === gl.domElement) document.exitPointerLock();
    }, [gl]);

    return null;
};
