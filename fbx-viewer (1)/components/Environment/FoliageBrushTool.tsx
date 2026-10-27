import React, { useRef, useState, useMemo, useEffect } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { LoadedModelData, LevelObject } from '../../types';
import { createPlacementQuery } from '../../utils/surfacePlacement';
import { InstancedLevelLayer } from './InstancedLevelLayer';

/** One instance a paint stroke placed: world transform of the brush's model. */
export interface FoliagePlacement {
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
}

interface FoliageBrushToolProps {
    activeModel: LoadedModelData | null;
    mode: 'add' | 'erase';
    existingObjects: LevelObject[];
    /** Every object in the level; lets the brush skip marker objects and sample unrendered terrain. Defaults to existingObjects. */
    levelObjects?: LevelObject[];
    settings: {
        radius: number;
        density: number;
        scaleMin: number;
        scaleMax: number;
        rotationVariation: number;
        alignToNormal: boolean;
    };
    /**
     * A stroke ended: everything it placed, saved as one undo step. Until the returned promise
     * settles the brush keeps drawing the placements, so they do not blink out before the level has them.
     */
    onPaint: (placements: FoliagePlacement[]) => Promise<unknown> | void;
    /** A stroke ended: every object it erased, removed as one undo step. */
    onErase: (ids: string[]) => Promise<unknown> | void;
    /** Objects the current erase stroke has taken; the scene hides them until the stroke is saved. */
    onPendingEraseChange?: (ids: ReadonlySet<string>) => void;
}

const NO_IDS: ReadonlySet<string> = new Set();

// Lift the cursor ring off the surface so it does not z-fight with it.
const CURSOR_LIFT = 0.05;

export const FoliageBrushTool: React.FC<FoliageBrushToolProps> = ({
    activeModel,
    mode,
    existingObjects,
    levelObjects,
    settings,
    onPaint,
    onErase,
    onPendingEraseChange
}) => {
    const { camera, raycaster, pointer, gl, scene, events } = useThree();
    const cursorRef = useRef<THREE.Group>(null);
    // A ref, not state: the frame loop must stop the moment the button is released, or the frames
    // before a re-render would start collecting the next stroke's edits.
    const isPainting = useRef(false);
    // A stroke's edits are collected and saved together when it ends: every save moves the project
    // to a new revision, so saving each instance as it was placed made the next ones fail.
    const [placements, setPlacements] = useState<FoliagePlacement[]>([]);
    const placementsRef = useRef<FoliagePlacement[]>([]);
    const erasedRef = useRef<Set<string>>(new Set());
    const latest = useRef({ onPaint, onErase, onPendingEraseChange });
    latest.current = { onPaint, onErase, onPendingEraseChange };

    const cursorPosition = useRef(new THREE.Vector3());
    const cursorNormal = useRef(new THREE.Vector3(0, 1, 0));
    const isCursorValid = useRef(false);

    // Reusable math
    const _up = useMemo(() => new THREE.Vector3(0, 1, 0), []);
    const _cursorQ = useMemo(() => new THREE.Quaternion(), []);
    const _yawQ = useMemo(() => new THREE.Quaternion(), []);
    const _alignQ = useMemo(() => new THREE.Quaternion(), []);
    const _euler = useMemo(() => new THREE.Euler(), []);
    const _offset = useMemo(() => new THREE.Vector3(), []);
    const _sampleOrigin = useMemo(() => new THREE.Vector3(), []);
    const _sampleDirection = useMemo(() => new THREE.Vector3(), []);
    const sampleRaycaster = useMemo(() => new THREE.Raycaster(), []);

    // Instances of the brush model keep this far apart (centre to centre): its footprint on the
    // ground, closer as density rises (density 1 lets neighbours overlap by half).
    const spacing = useMemo(() => {
        if (!activeModel) return 0;
        const size = new THREE.Box3().setFromObject(activeModel.object).getSize(new THREE.Vector3());
        const footprint = Math.max(size.x, size.z, 0.1) * ((settings.scaleMin + settings.scaleMax) / 2);
        return footprint * (1 - 0.5 * Math.min(Math.max(settings.density, 0), 1));
    }, [activeModel, settings.density, settings.scaleMin, settings.scaleMax]);

    const tooClose = (point: THREE.Vector3): boolean => {
        const limitSq = spacing * spacing;
        const near = ([x, y, z]: [number, number, number]) => (
            (point.x - x) ** 2 + (point.y - y) ** 2 + (point.z - z) ** 2 < limitSq
        );
        return placementsRef.current.some(placement => near(placement.position))
            || existingObjects.some(object => object.modelId === activeModel?.id
                && !erasedRef.current.has(object.id) && near(object.position));
    };

    // The stroke's placements, drawn like the level's own foliage until they are saved.
    const pendingObjects = useMemo<LevelObject[]>(() => (activeModel ? placements.map((placement, index) => ({
        id: `foliage-pending-${index}`,
        levelId: '',
        modelId: activeModel.id,
        name: '',
        type: 'foliage',
        ...placement,
    })) : []), [activeModel, placements]);

    // Color logic
    const brushColor = mode === 'add' ? '#4ade80' : '#ef4444';

    // Painting Loop
    useFrame(() => {
        // 1. Update Cursor Position on the surface under the pointer
        raycaster.setFromCamera(pointer, camera);
        const surface = createPlacementQuery(scene, levelObjects ?? existingObjects, {
            ignore: cursorRef.current ? [cursorRef.current] : [],
        });
        const hit = surface(raycaster);

        if (hit) {
            cursorPosition.current.copy(hit.point);
            cursorNormal.current.copy(hit.normal);
            _cursorQ.setFromUnitVectors(_up, hit.normal);
            isCursorValid.current = true;

            if (cursorRef.current) {
                cursorRef.current.position.copy(hit.point).addScaledVector(hit.normal, CURSOR_LIFT);
                cursorRef.current.quaternion.copy(_cursorQ);
                cursorRef.current.visible = true;
            }
        } else {
            isCursorValid.current = false;
            if (cursorRef.current) cursorRef.current.visible = false;
        }

        // 2. Action Logic
        if (isPainting.current && isCursorValid.current) {

            if (mode === 'add' && activeModel) {
                // --- ADD MODE ---
                const attempts = Math.ceil(settings.density * 5);
                // Scatter samples are projected onto the surface along the brush normal,
                // within a sphere of the brush radius around the cursor.
                const reach = Math.max(settings.radius, 0.5);
                sampleRaycaster.layers.mask = raycaster.layers.mask;
                sampleRaycaster.near = 0;
                sampleRaycaster.far = reach * 2;
                _sampleDirection.copy(cursorNormal.current).negate();

                for (let i = 0; i < attempts; i++) {
                    if (Math.random() > 0.5) continue;

                    // Generate Random Point in the brush disc (tangent to the surface)
                    const r = settings.radius * Math.sqrt(Math.random());
                    const theta = Math.random() * 2 * Math.PI;
                    _offset.set(r * Math.cos(theta), 0, r * Math.sin(theta)).applyQuaternion(_cursorQ);

                    _sampleOrigin.copy(cursorPosition.current).add(_offset).addScaledVector(cursorNormal.current, reach);
                    sampleRaycaster.set(_sampleOrigin, _sampleDirection);
                    const sample = surface(sampleRaycaster);
                    if (!sample) continue; // Brush overhangs a drop deeper than its radius
                    if (tooClose(sample.point)) continue;

                    // --- ROTATION LOGIC ---
                    // Random yaw about the model's up axis, then tilt that up axis onto the surface.
                    const normal = settings.alignToNormal ? sample.normal : _up;
                    _alignQ.setFromUnitVectors(_up, normal);

                    // Calculate random rotation based on variation range (0 to 360)
                    const randomYaw = Math.random() * settings.rotationVariation * (Math.PI / 180);
                    _yawQ.setFromAxisAngle(_up, randomYaw);

                    _alignQ.multiply(_yawQ);
                    _euler.setFromQuaternion(_alignQ);

                    // --- SCALE LOGIC ---
                    // Random scale between min and max
                    const s = settings.scaleMin + Math.random() * (settings.scaleMax - settings.scaleMin);

                    placementsRef.current = [...placementsRef.current, {
                        position: sample.point.toArray() as [number, number, number],
                        rotation: [_euler.x, _euler.y, _euler.z],
                        scale: [s, s, s],
                    }];
                    setPlacements(placementsRef.current);
                }
            } else if (mode === 'erase') {
                // --- ERASE MODE ---
                const radiusSq = settings.radius * settings.radius;
                let erased = false;
                const center = cursorPosition.current;
                const normal = cursorNormal.current;

                // Iterate through existing objects to find candidates
                // If activeModel is selected, ONLY erase that type. Otherwise erase nothing (safe default).
                if (activeModel) {
                    existingObjects.forEach(obj => {
                        // Filter by type
                        if (obj.modelId !== activeModel.id) return;

                        // Distance check: a cylinder of the brush radius along the surface normal
                        _offset.set(obj.position[0] - center.x, obj.position[1] - center.y, obj.position[2] - center.z);
                        const along = _offset.dot(normal);
                        if (Math.abs(along) > settings.radius) return;

                        if ((_offset.lengthSq() - along * along) < radiusSq && !erasedRef.current.has(obj.id)) {
                            erasedRef.current.add(obj.id);
                            erased = true;
                        }
                    });
                }

                if (erased) onPendingEraseChange?.(new Set(erasedRef.current));
            }
        }
    });

    // Input Handlers
    useEffect(() => {
        // The editor's canvas takes no pointer events (pointer-events: none); input arrives on the
        // element R3F's events are connected to, the viewport's event source.
        const domElement: HTMLElement = events.connected ?? gl.domElement;

        const handleDown = (e: MouseEvent) => {
            if (e.button === 0 && !e.shiftKey && !e.ctrlKey && !e.altKey) isPainting.current = true;
        };
        // Leaving the viewport ends the stroke like releasing the button; either saves its edits.
        const endStroke = () => {
            if (!isPainting.current) return;
            isPainting.current = false;
            const placed = placementsRef.current;
            const erased = [...erasedRef.current];
            placementsRef.current = [];
            erasedRef.current = new Set();
            const { onPaint: paint, onErase: erase, onPendingEraseChange: pendingErase } = latest.current;
            if (placed.length) void Promise.resolve(paint(placed)).finally(() => setPlacements([]));
            if (erased.length) void Promise.resolve(erase(erased)).finally(() => pendingErase?.(NO_IDS));
        };

        domElement.addEventListener('mousedown', handleDown);
        window.addEventListener('mouseup', endStroke); // Listen on window for mouseup to catch drags outside
        domElement.addEventListener('mouseleave', endStroke);

        return () => {
            domElement.removeEventListener('mousedown', handleDown);
            window.removeEventListener('mouseup', endStroke);
            domElement.removeEventListener('mouseleave', endStroke);
        };
    }, [gl, events.connected]);

    return (
        <>
        {activeModel && pendingObjects.length > 0 && (
            <InstancedLevelLayer models={[activeModel]} levelObjects={pendingObjects} interactive={false} />
        )}
        {/* The cursor sits on the surface, tilted to its normal; it is ignored by the surface raycast. */}
        <group ref={cursorRef} visible={false}>
            {/* The Visual Ring */}
            <mesh rotation={[-Math.PI / 2, 0, 0]}>
                <ringGeometry args={[Math.max(settings.radius - 0.1, 0), settings.radius, 64]} />
                <meshBasicMaterial color={brushColor} transparent opacity={0.5} side={THREE.DoubleSide} />
            </mesh>

            {/* Center Dot */}
            <mesh>
                <sphereGeometry args={[0.1]} />
                <meshBasicMaterial color={brushColor} />
            </mesh>
        </group>
        </>
    );
};
