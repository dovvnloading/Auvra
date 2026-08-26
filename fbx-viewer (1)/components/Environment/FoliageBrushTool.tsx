
import React, { useRef, useState, useMemo, useEffect } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { LoadedModelData, LevelObject } from '../../types';

interface FoliageBrushToolProps {
    activeModel: LoadedModelData | null;
    mode: 'add' | 'erase';
    existingObjects: LevelObject[];
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

export const FoliageBrushTool: React.FC<FoliageBrushToolProps> = ({ 
    activeModel, 
    mode,
    existingObjects,
    settings,
    onPaint,
    onErase,
    onStrokeStart
}) => {
    const { camera, raycaster, pointer, gl } = useThree();
    const brushMeshRef = useRef<THREE.Mesh>(null);
    const [isPainting, setIsPainting] = useState(false);
    
    // Raycasting Plane (Ground)
    const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
    const planeIntersect = new THREE.Vector3();
    const cursorPosition = useRef(new THREE.Vector3());
    const isCursorValid = useRef(false);

    // Reusable math
    const _up = useMemo(() => new THREE.Vector3(0, 1, 0), []);
    const _dummyQ = useMemo(() => new THREE.Quaternion(), []);
    const _alignQ = useMemo(() => new THREE.Quaternion(), []);
    const _euler = useMemo(() => new THREE.Euler(), []);

    // Color logic
    const brushColor = mode === 'add' ? '#4ade80' : '#ef4444';

    // Painting Loop
    useFrame(() => {
        // 1. Update Cursor Position
        raycaster.setFromCamera(pointer, camera);
        
        // Raycast against infinite plane for cursor
        if (raycaster.ray.intersectPlane(plane, planeIntersect)) {
            cursorPosition.current.copy(planeIntersect);
            isCursorValid.current = true;
            
            if (brushMeshRef.current) {
                brushMeshRef.current.position.copy(planeIntersect);
                brushMeshRef.current.visible = true;
                brushMeshRef.current.position.y += 0.05;
                
                // Update radius visually if it changed
                brushMeshRef.current.scale.setScalar(1); // Reset scale
            }
        } else {
            isCursorValid.current = false;
            if (brushMeshRef.current) brushMeshRef.current.visible = false;
        }

        // 2. Action Logic
        if (isPainting && isCursorValid.current) {
            
            if (mode === 'add' && activeModel) {
                // --- ADD MODE ---
                const attempts = Math.ceil(settings.density * 5); 
                
                for (let i = 0; i < attempts; i++) {
                    if (Math.random() > 0.5) continue;

                    // Generate Random Point in Circle
                    const r = settings.radius * Math.sqrt(Math.random());
                    const theta = Math.random() * 2 * Math.PI;
                    
                    const offsetX = r * Math.cos(theta);
                    const offsetZ = r * Math.sin(theta);
                    
                    const spawnPos = new THREE.Vector3(
                        cursorPosition.current.x + offsetX,
                        cursorPosition.current.y,
                        cursorPosition.current.z + offsetZ
                    );

                    // --- ROTATION LOGIC ---
                    const normal = _up; // Assuming flat plane for now
                    
                    if (settings.alignToNormal) {
                        _alignQ.setFromUnitVectors(_up, normal);
                    } else {
                        _alignQ.identity();
                    }

                    // Calculate random rotation based on variation range (0 to 360)
                    const randomYaw = Math.random() * settings.rotationVariation * (Math.PI / 180);
                    _dummyQ.setFromAxisAngle(normal, randomYaw);

                    _alignQ.multiply(_dummyQ);
                    _euler.setFromQuaternion(_alignQ);

                    // --- SCALE LOGIC ---
                    // Random scale between min and max
                    const s = settings.scaleMin + Math.random() * (settings.scaleMax - settings.scaleMin);
                    const scale = new THREE.Vector3(s, s, s);

                    onPaint(spawnPos, _euler.clone(), scale);
                }
            } else if (mode === 'erase') {
                // --- ERASE MODE ---
                const radiusSq = settings.radius * settings.radius;
                const idsToRemove: string[] = [];

                // Iterate through existing objects to find candidates
                // If activeModel is selected, ONLY erase that type. Otherwise erase nothing (safe default).
                if (activeModel) {
                    existingObjects.forEach(obj => {
                        // Filter by type
                        if (obj.modelId !== activeModel.id) return;

                        // Distance check (2D XZ plane)
                        const dx = obj.position[0] - cursorPosition.current.x;
                        const dz = obj.position[2] - cursorPosition.current.z;
                        
                        if ((dx * dx + dz * dz) < radiusSq) {
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
        <group>
            {/* The Visual Ring */}
            <mesh ref={brushMeshRef} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
                <ringGeometry args={[settings.radius - 0.1, settings.radius, 64]} />
                <meshBasicMaterial color={brushColor} transparent opacity={0.5} side={THREE.DoubleSide} />
            </mesh>
            
            {/* Center Dot */}
            {brushMeshRef.current?.visible && (
                <mesh position={cursorPosition.current}>
                    <sphereGeometry args={[0.1]} />
                    <meshBasicMaterial color={brushColor} />
                </mesh>
            )}
        </group>
    );
};
