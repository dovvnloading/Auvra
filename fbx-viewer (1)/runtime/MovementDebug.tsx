import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { findCharacterMotion, type TrajectoryPoint } from './locomotion/characterMotion';

/**
 * MOVEMENT DEBUG VIEW (F4 in play)
 *
 * Draws on the ground where the player's movement says it will be over the next second (and which way it
 * will face), and where it has been over the last, and shows what it is doing in a corner: its speed and
 * the speed asked for, its facing, the clip motion matching plays, and whether it stands on the ground.
 */

/** Toggles the view with F4. */
export const useMovementDebugToggle = (initial = false): boolean => {
    const [visible, setVisible] = useState(initial);
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => { if (event.code === 'F4') { event.preventDefault(); setVisible(value => !value); } };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);
    return visible;
};

export interface MovementDebugInfo {
    speed: number;
    goalSpeed: number;
    facing: number;
    goalFacing: number | null;
    matched: string | null;
    grounded: boolean;
    strafing: boolean;
}

let latest: MovementDebugInfo | null = null;
const listeners = new Set<() => void>();
const publish = (info: MovementDebugInfo | null) => { latest = info; listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const read = () => latest;

/** Points along the path ahead and behind, a twentieth of a second apart over a second. */
const POINTS = 21;
const STEP = 0.05;
/** Ticks show the facing at these seconds ahead. */
const TICK_TIMES = [0.2, 0.5, 1];
const TICK_LENGTH = 0.3;
/** Drawn just above the feet, so the ground does not hide it. */
const LIFT = 0.03;

/** Discs mark the path at these seconds ahead and behind, as lines one pixel wide are easily lost. */
const DOT_TIMES = [0.2, 0.5, 1];
const DOT_RADIUS = 0.07;

const dotOf = (geometry: THREE.CircleGeometry, color: string): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.frustumCulled = false;
    mesh.renderOrder = 999;
    return mesh;
};

const lineOf = (points: number, color: string, segments = false): THREE.Line => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(points * 3), 3));
    const material = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
    const line = segments ? new THREE.LineSegments(geometry, material) : new THREE.Line(geometry, material);
    line.frustumCulled = false;
    line.renderOrder = 999;
    return line;
};

/** Draws the player's path while `enabled`; mount inside the canvas, render <MovementDebugPanel> outside it. */
export const MovementDebugProbe: React.FC<{ enabled: boolean; target: THREE.Object3D | null }> = ({ enabled, target }) => {
    const lines = useMemo(() => ({
        ahead: lineOf(POINTS, '#38bdf8'),
        behind: lineOf(POINTS, '#a3a3a3'),
        ticks: lineOf(TICK_TIMES.length * 2, '#f59e0b', true),
    }), []);
    const dots = useMemo(() => {
        const geometry = new THREE.CircleGeometry(DOT_RADIUS, 16);
        return { geometry, ahead: DOT_TIMES.map(() => dotOf(geometry, '#38bdf8')), behind: DOT_TIMES.map(() => dotOf(geometry, '#a3a3a3')) };
    }, []);
    useEffect(() => () => {
        for (const line of Object.values(lines)) {
            line.geometry.dispose();
            (line.material as THREE.Material).dispose();
        }
        dots.geometry.dispose();
        for (const dot of [...dots.ahead, ...dots.behind]) (dot.material as THREE.Material).dispose();
    }, [lines, dots]);
    useEffect(() => () => publish(null), []);
    const point = useRef<TrajectoryPoint>({ x: 0, z: 0, facing: 0 });
    const sincePublish = useRef(0);

    useFrame((_, delta) => {
        if (!enabled || !target) return;
        const motion = findCharacterMotion(target);
        if (!motion) return;
        const y = target.position.y + LIFT;
        const fill = (line: THREE.Line, at: (i: number) => TrajectoryPoint) => {
            const positions = line.geometry.getAttribute('position') as THREE.BufferAttribute;
            for (let i = 0; i < POINTS; i++) {
                const p = at(i);
                positions.setXYZ(i, p.x, y, p.z);
            }
            positions.needsUpdate = true;
        };
        fill(lines.ahead, i => motion.predict(i * STEP, point.current));
        fill(lines.behind, i => motion.past(i * STEP, point.current));
        const ticks = lines.ticks.geometry.getAttribute('position') as THREE.BufferAttribute;
        TICK_TIMES.forEach((time, i) => {
            const p = motion.predict(time, point.current);
            ticks.setXYZ(i * 2, p.x, y, p.z);
            ticks.setXYZ(i * 2 + 1, p.x + Math.sin(p.facing) * TICK_LENGTH, y, p.z + Math.cos(p.facing) * TICK_LENGTH);
        });
        ticks.needsUpdate = true;
        DOT_TIMES.forEach((time, i) => {
            const ahead = motion.predict(time, point.current);
            dots.ahead[i].position.set(ahead.x, y, ahead.z);
            const behind = motion.past(time, point.current);
            dots.behind[i].position.set(behind.x, y, behind.z);
        });
        sincePublish.current += delta;
        if (sincePublish.current >= 0.1) {
            sincePublish.current = 0;
            publish({
                speed: motion.speed,
                goalSpeed: Math.hypot(motion.goal.vx, motion.goal.vz),
                facing: motion.facing.x,
                goalFacing: motion.goal.facing,
                matched: motion.matched,
                grounded: motion.grounded,
                strafing: motion.strafing,
            });
        }
    });

    if (!enabled) return null;
    return (
        <group>
            <primitive object={lines.ahead} />
            <primitive object={lines.behind} />
            <primitive object={lines.ticks} />
            {[...dots.ahead, ...dots.behind].map((dot) => <primitive key={dot.uuid} object={dot} />)}
        </group>
    );
};

const degrees = (radians: number) => Math.round((radians * 180) / Math.PI);

/** What the player's movement is doing, in a corner of the screen while the view is on. */
export const MovementDebugPanel: React.FC<{ visible: boolean }> = ({ visible }) => {
    const info = useSyncExternalStore(subscribe, read, read);
    if (!visible) return null;
    return (
        <div className="pointer-events-none absolute right-3 top-12 z-30 w-60 rounded border border-gray-700 bg-gray-950/85 p-2 font-mono text-2xs leading-relaxed text-gray-300">
            <div className="mb-1 font-bold text-gray-100">Movement (F4)</div>
            {info ? (
                <>
                    <div>Speed {info.speed.toFixed(2)} → {info.goalSpeed.toFixed(2)} m/s</div>
                    <div>Facing {degrees(info.facing)}°{info.goalFacing !== null ? ` → ${degrees(info.goalFacing)}°` : ''}</div>
                    <div>Clip {info.matched ?? '— (no matching)'}</div>
                    <div>{info.grounded ? 'On the ground' : 'In the air'}{info.strafing ? ', strafing' : ''}</div>
                </>
            ) : <div>No moving character.</div>}
            <div className="mt-1 flex flex-wrap gap-x-2 text-gray-500">
                <span><span className="text-sky-400">━</span> ahead 1 s</span>
                <span><span className="text-neutral-400">━</span> behind 1 s</span>
                <span><span className="text-amber-500">━</span> facing</span>
            </div>
        </div>
    );
};
