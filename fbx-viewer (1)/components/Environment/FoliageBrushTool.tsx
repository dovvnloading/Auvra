import React, { useRef, useState, useMemo, useEffect } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { LoadedModelData, LevelObject } from '../../types';
import { createPlacementQuery } from '../../utils/surfacePlacement';

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
    onPaint: (pos: THREE.Vector3, rot: THREE.Euler, scale: THREE.Vector3) => void;
    onErase: (ids: string[]) => void;
    onStrokeStart?: () => void;
}

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
    onStrokeStart
}) => {
    const { camera, raycaster, pointer, gl, scene } = useThree();
    const cursorRef = useRef<THREE.Group>(null);
    const [isPainting, setIsPainting] = useState(false);

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
        if (isPainting && isCursorValid.current) {

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
                    const scale = new THREE.Vector3(s, s, s);

                    onPaint(sample.point.clone(), _euler.clone(), scale);
                }
            } else if (mode === 'erase') {
                // --- ERASE MODE ---
                const radiusSq = settings.radius * settings.radius;
                const idsToRemove: string[] = [];
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

                        if ((_offset.lengthSq() - along * along) < radiusSq) {
                            idsToRemove.push(obj.id);
                        }
                    });
                }

                if (idsToRemove.length > 0) {
                    onErase(idsToRemove);
                }
            }
        }
    });

    // Input Handlers
    useEffect(() => {
        const domElement = gl.domElement;

        const handleDown = (e: MouseEvent) => {
            if (e.button === 0 && !e.shiftKey && !e.ctrlKey && !e.altKey) {
                if (onStrokeStart) onStrokeStart();
                setIsPainting(true);
            }
        };
        const handleUp = () => setIsPainting(false);
        const handleLeave = () => setIsPainting(false);

        domElement.addEventListener('mousedown', handleDown);
        window.addEventListener('mouseup', handleUp); // Listen on window for mouseup to catch drags outside
        domElement.addEventListener('mouseleave', handleLeave);

        return () => {
            domElement.removeEventListener('mousedown', handleDown);
            window.removeEventListener('mouseup', handleUp);
            domElement.removeEventListener('mouseleave', handleLeave);
        };
    }, [onStrokeStart, gl]);

    return (
        // The cursor sits on the surface, tilted to its normal; it is ignored by the surface raycast.
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
    );
};
