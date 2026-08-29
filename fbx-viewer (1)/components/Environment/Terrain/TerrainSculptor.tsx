
import React, { useRef, useMemo, useEffect } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { SculptSettings } from '../types';

interface TerrainSculptorProps {
    settings: SculptSettings;
    onStrokeEnd: (objectId: string, newHeights: number[]) => void;
    enabled: boolean;
}

export const TerrainSculptor: React.FC<TerrainSculptorProps> = ({ 
    settings, 
    onStrokeEnd,
    enabled
}) => {
    const { camera, raycaster, pointer, scene, gl } = useThree();
    const cursorRef = useRef<THREE.Mesh>(null);
    const isSculpting = useRef(false);
    
    // Track the currently hovered/active terrain mesh
    const activeMeshRef = useRef<THREE.Mesh | null>(null);
    const terrainMeshesRef = useRef<THREE.Mesh[]>([]);

    // Scan scene for terrain meshes
    // We do this every few frames or on specific triggers to ensure we catch new terrains
    useFrame((state) => {
        if (!enabled) return;
        
        // Refresh cache periodically (every 60 frames -> 1s) to handle dynamic adds without spamming traverse
        // Or if list is empty
        if (state.clock.elapsedTime % 1 < 0.05 || terrainMeshesRef.current.length === 0) {
            const meshes: THREE.Mesh[] = [];
            scene.traverse((child) => {
                // Check specifically for the flag we set in TerrainObject
                if ((child as THREE.Mesh).isMesh && child.userData.isTerrain) {
                    meshes.push(child as THREE.Mesh);
                }
            });
            terrainMeshesRef.current = meshes;
        }
    });

    // --- SCULPT LOGIC ---
    const applySculpt = (point: THREE.Vector3, mesh: THREE.Mesh) => {
        const geom = mesh.geometry as THREE.PlaneGeometry;
        if (!geom) return;

        const posAttr = geom.attributes.position;
        const count = posAttr.count;
        
        // 1. Ensure Matrices are current to perform accurate World->Local transform
        mesh.updateMatrixWorld();

        // 2. Transform Hit Point to Mesh Local Space
        // Note: PlaneGeometry is flat on XY. TerrainObject rotates it -90 on X.
        // So Local Z is World Y (Up).
        const localPoint = mesh.worldToLocal(point.clone());
        
        // 3. Calculate Local Radius
        // We must account for the parent scale. `mesh.worldToLocal` handles scaling logic for the point,
        // but for the radius distance check, we need to know how many local units = 1 world unit.
        // We get World Scale of the mesh.
        const worldScale = new THREE.Vector3();
        mesh.getWorldScale(worldScale);
        
        // Average X/Z scale to normalize the brush circle
        const scaleFactor = (worldScale.x + worldScale.z) / 2;
        
        // Local Radius = World Radius / Scale
        const localRadius = settings.radius / scaleFactor;
        const radiusSq = localRadius * localRadius;
        
        const strength = settings.strength * 0.5;
        let modified = false;

        for (let i = 0; i < count; i++) {
            const x = posAttr.getX(i);
            const y = posAttr.getY(i); 
            
            // Distance on the flat plane (XY local)
            const dx = x - localPoint.x;
            const dy = y - localPoint.y;
            const distSq = dx*dx + dy*dy;

            if (distSq < radiusSq) {
                const dist = Math.sqrt(distSq);
                const falloff = Math.max(0, 1 - (dist / localRadius));
                // Cubic ease for smoother mountains
                const influence = Math.pow(falloff, 2) * strength;

                const currentHeight = posAttr.getZ(i);
                let newHeight = currentHeight;

                switch (settings.tool) {
                    case 'raise':
                        newHeight += influence;
                        break;
                    case 'lower':
                        newHeight -= influence;
                        break;
                    case 'flatten':
                        // Lerp towards target local height
                        // Note: flattenHeight is likely World Height. We need to transform it?
                        // Usually terrains are at Y=0. So World Height = Local Height.
                        newHeight = THREE.MathUtils.lerp(currentHeight, settings.flattenHeight, influence * 0.5);
                        break;
                    case 'smooth':
                        // Simple erosion: Average with current
                        newHeight = THREE.MathUtils.lerp(currentHeight, currentHeight * 0.9, influence * 0.5);
                        break;
                }

                if (newHeight !== currentHeight) {
                    posAttr.setZ(i, newHeight);
                    modified = true;
                }
            }
        }

        if (modified) {
            posAttr.needsUpdate = true;
            // Recompute normals for lighting updates (can be expensive, consider throttling)
            geom.computeVertexNormals();
            geom.computeBoundingSphere();
        }
    };

    useFrame(() => {
        if (!enabled) {
            if (cursorRef.current) cursorRef.current.visible = false;
            return;
        }

        raycaster.setFromCamera(pointer, camera);
        
        // Raycast against terrain meshes
        const intersects = raycaster.intersectObjects(terrainMeshesRef.current, false);
        
        if (intersects.length > 0) {
            const hit = intersects[0];
            const hitMesh = hit.object as THREE.Mesh;
            
            activeMeshRef.current = hitMesh;

            if (cursorRef.current) {
                cursorRef.current.position.copy(hit.point);
                cursorRef.current.position.y += 0.1; // Bias up slightly
                cursorRef.current.visible = true;
                
                // Scale cursor visual to World Radius
                cursorRef.current.scale.set(settings.radius, settings.radius, settings.radius);
                
                // VISUAL FEEDBACK: Green = Hit
                (cursorRef.current.material as THREE.MeshBasicMaterial).color.set(isSculpting.current ? '#ffff00' : '#4ade80');
            }

            if (isSculpting.current) {
                applySculpt(hit.point, hitMesh);
            }
        } else {
            // Missed terrain
            activeMeshRef.current = null;
            if (cursorRef.current) {
                // Keep cursor visible at last known depth or pointer projection? 
                // Better to hide or turn red to indicate "Off Terrain"
                cursorRef.current.visible = true; 
                (cursorRef.current.material as THREE.MeshBasicMaterial).color.set('#ef4444');
                
                // Fallback projection to ground plane for cursor continuity
                const plane = new THREE.Plane(new THREE.Vector3(0,1,0), 0);
                const target = new THREE.Vector3();
                if (raycaster.ray.intersectPlane(plane, target)) {
                    cursorRef.current.position.copy(target);
                }
            }
        }
    });

    // Input Handlers
    useEffect(() => {
        const domElement = gl.domElement;

        const handleDown = (e: MouseEvent) => {
            if (enabled && e.button === 0 && !e.altKey && !e.ctrlKey) {
                isSculpting.current = true;
            }
        };
        
        const handleUp = () => {
            if (isSculpting.current) {
                isSculpting.current = false;
                
                // Commit changes if we have a valid mesh
                const mesh = activeMeshRef.current;
                if (mesh) {
                    const geom = mesh.geometry as THREE.PlaneGeometry;
                    const objectId = mesh.userData.levelObjectId;
                    
                    if (objectId && geom) {
                        const heights: number[] = [];
                        const posAttr = geom.attributes.position;
                        for(let i=0; i<posAttr.count; i++) {
                            heights.push(posAttr.getZ(i));
                        }
                        onStrokeEnd(objectId, heights);
                    }
                }
            }
        };

        const handleLeave = () => {
             if (isSculpting.current) handleUp();
        };

        domElement.addEventListener('mousedown', handleDown);
        window.addEventListener('mouseup', handleUp); 
        domElement.addEventListener('mouseleave', handleLeave);

        return () => {
            domElement.removeEventListener('mousedown', handleDown);
            window.removeEventListener('mouseup', handleUp);
            domElement.removeEventListener('mouseleave', handleLeave);
        };
    }, [enabled, onStrokeEnd, gl]);

    return (
        <group>
            {/* Visual Cursor Ring */}
            <mesh ref={cursorRef} rotation={[-Math.PI / 2, 0, 0]} visible={false} raycast={() => undefined} renderOrder={999}>
                <ringGeometry args={[0.9, 1.0, 64]} />
                <meshBasicMaterial transparent opacity={0.8} depthTest={false} depthWrite={false} />
            </mesh>
        </group>
    );
};
