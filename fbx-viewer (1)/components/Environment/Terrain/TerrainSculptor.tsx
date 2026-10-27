
import React, { useRef, useEffect } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { SculptSettings, SculptTool } from '../types';
import { paintTerrainSplat, TERRAIN_SPLAT_CHANNELS } from './terrainSplatCodec';

/** Sculpt tools plus 'paint', which blends a texture layer into the splat map. */
export type TerrainBrushTool = SculptTool | 'paint';

export interface TerrainBrushSettings extends Omit<SculptSettings, 'tool'> {
    tool: TerrainBrushTool;
    /** Texture layer (0-3) the paint tool blends in. */
    paintLayer?: number;
}

/**
 * What a TerrainObject exposes on its mesh (userData.terrainPaint) for the
 * paint brush: the live splat weights backing its layer material.
 */
export interface TerrainPaintTarget {
    columns: number;
    rows: number;
    width: number;
    depth: number;
    /** RGBA weights, (columns * rows * 4), row-major in PlaneGeometry order. */
    weights: Uint8Array;
    layerCount: number;
    /** The stored weights are still loading; painting would overwrite them. */
    pending: boolean;
    /** Upload the edited weights to the GPU. */
    markDirty(): void;
}

// Fraction of the way a sample at the brush centre moves towards the layer per
// frame at full strength. Painting runs every frame while the button is held.
const PAINT_RATE = 0.25;
export const TERRAIN_PAINT_CURSOR_COLOR = '#a855f7';

export const getTerrainPaintTarget = (mesh: THREE.Object3D | null | undefined): TerrainPaintTarget | null => {
    const target = mesh?.userData.terrainPaint as TerrainPaintTarget | undefined;
    return target && target.weights instanceof Uint8Array ? target : null;
};

const canPaint = (target: TerrainPaintTarget | null, layer: number): target is TerrainPaintTarget => (
    Boolean(target && !target.pending && layer >= 0 && layer < Math.min(target.layerCount, TERRAIN_SPLAT_CHANNELS))
);

interface TerrainSculptorProps {
    settings: TerrainBrushSettings;
    /** A paint stroke ended: the terrain's full splat weights (0-255 RGBA per sample). */
    onPaintStrokeEnd?: (objectId: string, splat: number[]) => void;
    /** The first edit of a paint stroke, before it is committed (take an undo snapshot). */
    onStrokeStart?: () => void;
    enabled: boolean;
}

export const TerrainSculptor: React.FC<TerrainSculptorProps> = ({ 
    settings, 
    onPaintStrokeEnd,
    onStrokeStart,
    enabled
}) => {
    const { camera, raycaster, pointer, scene, gl, events } = useThree();
    const cursorRef = useRef<THREE.Mesh>(null);
    const isSculpting = useRef(false);
    
    const terrainMeshesRef = useRef<THREE.Mesh[]>([]);
    // Terrains whose splat weights the current paint stroke changed.
    const paintedMeshesRef = useRef<Set<THREE.Mesh>>(new Set());
    // Set once the current stroke has changed a terrain (and taken its undo snapshot).
    const strokeChangedRef = useRef(false);

    // Input handlers are bound once per canvas; they read the latest props here.
    const latest = useRef({ settings, onPaintStrokeEnd, onStrokeStart });
    latest.current = { settings, onPaintStrokeEnd, onStrokeStart };

    const paintLayer = Math.max(0, Math.floor(settings.paintLayer ?? 0));

    // The level state does not change until the stroke ends, so a snapshot taken
    // at the first edit of the stroke still records the terrain before it.
    const noteStrokeChange = () => {
        if (strokeChangedRef.current) return;
        strokeChangedRef.current = true;
        latest.current.onStrokeStart?.();
    };

    // Scan scene for terrain meshes
    // We do this every few frames or on specific triggers to ensure we catch new terrains
    useFrame((state) => {
        if (!enabled) return;
        
        // Refresh cache periodically (every 60 frames -> 1s) to handle dynamic adds without spamming traverse
        // Or if list is empty
        if (state.clock.elapsedTime % 1 < 0.05 || terrainMeshesRef.current.length === 0) {
            const meshes: THREE.Mesh[] = [];
            scene.traverse((child) => {
                // Check specifically for the flag we set in TerrainObject.
                // A terrain whose heightfield is still loading is not sculptable.
                if ((child as THREE.Mesh).isMesh && child.userData.isTerrain && !child.userData.heightsPending) {
                    meshes.push(child as THREE.Mesh);
                }
            });
            terrainMeshesRef.current = meshes;
        }
    });

    // --- PAINT LOGIC ---
    const applyPaint = (point: THREE.Vector3, mesh: THREE.Mesh) => {
        const target = getTerrainPaintTarget(mesh);
        if (!canPaint(target, paintLayer)) return;

        mesh.updateMatrixWorld();
        const localPoint = mesh.worldToLocal(point.clone());
        const worldScale = new THREE.Vector3();
        mesh.getWorldScale(worldScale);
        // The plane's own X/Y axes are the ground axes; its Z is the height.
        const scaleFactor = (worldScale.x + worldScale.y) / 2 || 1;

        const modified = paintTerrainSplat(target.weights, target, {
            x: localPoint.x,
            y: localPoint.y,
            radius: settings.radius / scaleFactor,
            strength: settings.strength * PAINT_RATE,
            layer: paintLayer,
        });
        if (modified) {
            noteStrokeChange();
            target.markDirty();
            paintedMeshesRef.current.add(mesh);
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
        const painting = settings.tool === 'paint';
        
        if (intersects.length > 0) {
            const hit = intersects[0];
            const hitMesh = hit.object as THREE.Mesh;

            if (cursorRef.current) {
                cursorRef.current.position.copy(hit.point);
                cursorRef.current.position.y += 0.1; // Bias up slightly
                cursorRef.current.visible = true;
                
                // Scale cursor visual to World Radius
                cursorRef.current.scale.set(settings.radius, settings.radius, settings.radius);
                
                // VISUAL FEEDBACK: Green = Hit (purple when painting), yellow while stroking,
                // grey when this terrain cannot take the selected layer.
                const idle = painting
                    ? (canPaint(getTerrainPaintTarget(hitMesh), paintLayer) ? TERRAIN_PAINT_CURSOR_COLOR : '#6b7280')
                    : '#4ade80';
                (cursorRef.current.material as THREE.MeshBasicMaterial).color.set(isSculpting.current ? '#ffff00' : idle);
            }

            if (isSculpting.current && painting && !hitMesh.userData.heightsPending) {
                applyPaint(hit.point, hitMesh);
            }
        } else {
            // Missed terrain
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
        // The editor's canvas takes no pointer events (pointer-events: none); input arrives on the
        // element R3F's events are connected to, the viewport's event source.
        const domElement: HTMLElement = events.connected ?? gl.domElement;

        // Only paint strokes start here: height strokes belong to the selected terrain's own mesh
        // (TerrainObject), so they are not applied twice.
        const handleDown = (e: MouseEvent) => {
            if (enabled && e.button === 0 && !e.altKey && !e.ctrlKey && latest.current.settings.tool === 'paint') {
                strokeChangedRef.current = false;
                paintedMeshesRef.current.clear();
                isSculpting.current = true;
            }
        };
        
        const handleUp = () => {
            if (isSculpting.current) {
                isSculpting.current = false;
                const endPaint = latest.current.onPaintStrokeEnd;
                for (const mesh of paintedMeshesRef.current) {
                    const target = getTerrainPaintTarget(mesh);
                    const objectId = mesh.userData.levelObjectId;
                    if (target && !target.pending && objectId && endPaint) {
                        endPaint(objectId, Array.from(target.weights));
                    }
                }
                paintedMeshesRef.current.clear();
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
    }, [enabled, gl, events.connected]);

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
