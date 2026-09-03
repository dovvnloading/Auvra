
import React, { useRef, useState, useMemo, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { Grid, TransformControls } from '@react-three/drei';
import { LoadedModelData, LevelObject } from '../../types';
import { InteractionMode, PaintMode, PaintSettings, TransformSettings, SculptSettings } from './types';
import { LevelObjectRenderer } from './LevelObjectRenderer';
import { FoliageBrushTool } from './FoliageBrushTool';
import { TerrainObject } from './Terrain/TerrainObject';
import { TerrainSculptor } from './Terrain/TerrainSculptor';
import { InstancedLevelLayer } from './InstancedLevelLayer';
import { AudioSystem } from './AudioSystem';
import { SkySystem } from './SkySystem';
import { useAssets } from '../../context/AssetContext';

// --- INTERACTION LAYER ---
interface InteractionLayerProps {
    activeModel: LoadedModelData | null;
    onPlace: (position: THREE.Vector3, rotationY: number) => void;
    onSelectObject: (id: string | null) => void;
    isTransforming: boolean;
    enabled: boolean; 
    snapEnabled: boolean;
    snapGrid: number;
    viewId: string;
    interactionMode: InteractionMode;
}

const InteractionLayer: React.FC<InteractionLayerProps> = ({ 
    activeModel, 
    onPlace, 
    onSelectObject, 
    isTransforming, 
    enabled,
    snapEnabled,
    snapGrid,
    viewId,
    interactionMode
}) => {
    const { camera, raycaster, pointer } = useThree();
    const ghostRef = useRef<THREE.Group>(null);
    const [ghostRotation, setGhostRotation] = useState(0);
    
    const planeConfig = useMemo(() => {
        const isPlaceMode = interactionMode === 'place' || interactionMode === 'paint';
        const bgOffset = 2000; 
        
        switch (viewId) {
            case 'left': 
                return {
                    position: new THREE.Vector3(isPlaceMode ? 0 : -bgOffset, 0, 0),
                    rotation: new THREE.Euler(0, Math.PI / 2, 0),
                    normal: new THREE.Vector3(1, 0, 0)
                };
            case 'right': 
                return {
                    position: new THREE.Vector3(isPlaceMode ? 0 : bgOffset, 0, 0),
                    rotation: new THREE.Euler(0, Math.PI / 2, 0),
                    normal: new THREE.Vector3(1, 0, 0)
                };
            case 'bottom': 
                return {
                    position: new THREE.Vector3(0, isPlaceMode ? 0 : bgOffset, 0),
                    rotation: new THREE.Euler(-Math.PI / 2, 0, 0),
                    normal: new THREE.Vector3(0, 1, 0)
                };
            case 'top': 
            case 'main':
            default:
                return {
                    position: new THREE.Vector3(0, isPlaceMode ? -0.01 : -bgOffset, 0),
                    rotation: new THREE.Euler(-Math.PI / 2, 0, 0),
                    normal: new THREE.Vector3(0, 1, 0)
                };
        }
    }, [viewId, interactionMode]);

    const raycastPlane = useMemo(() => new THREE.Plane(planeConfig.normal, 0), [planeConfig.normal]);
    const planeIntersect = new THREE.Vector3();

    const handlePointerMove = () => {
        if (!enabled || isTransforming) {
            if (ghostRef.current) ghostRef.current.visible = false;
            return;
        }

        raycaster.setFromCamera(pointer, camera);
        
        if (raycaster.ray.intersectPlane(raycastPlane, planeIntersect)) {
            if (ghostRef.current && activeModel) {
                let x = planeIntersect.x;
                let y = planeIntersect.y;
                let z = planeIntersect.z;

                if (snapEnabled && snapGrid > 0) {
                    if (planeConfig.normal.y > 0.5) { 
                        x = Math.round(x / snapGrid) * snapGrid;
                        z = Math.round(z / snapGrid) * snapGrid;
                        y = 0; 
                    } else if (planeConfig.normal.x > 0.5) { 
                        y = Math.round(y / snapGrid) * snapGrid;
                        z = Math.round(z / snapGrid) * snapGrid;
                        x = 0;
                    }
                }
                
                ghostRef.current.position.set(x, y, z);
                ghostRef.current.rotation.set(0, ghostRotation, 0); 
                
                ghostRef.current.visible = true;
            }
        } else {
            if (ghostRef.current) ghostRef.current.visible = false;
        }
    };

    const handleClick = (e: any) => {
        if (isTransforming) return;
        
        if (enabled && activeModel && ghostRef.current && ghostRef.current.visible) {
            e.stopPropagation();
            onPlace(ghostRef.current.position.clone(), ghostRotation);
        } else {
            onSelectObject(null);
        }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
        if (!activeModel || !enabled) return;
        if (e.key === 'r' || e.key === 'R') {
            setGhostRotation(prev => prev + (Math.PI / 4));
        }
    };

    useEffect(() => {
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [activeModel, enabled]);

    return (
        <>
            <mesh 
                visible={enabled}
                onPointerMove={handlePointerMove} 
                onClick={handleClick}
                rotation={planeConfig.rotation}
                position={planeConfig.position}
            >
                <planeGeometry args={[10000, 10000]} />
                <meshBasicMaterial visible={false} />
            </mesh>

            {activeModel && enabled && (
                <group ref={ghostRef}>
                    <primitive 
                        object={activeModel.object.clone()} 
                        opacity={0.5} 
                        transparent 
                    />
                    <mesh position={[0, 2.5, 0]}>
                        <boxGeometry args={[1, 5, 1]} />
                        <meshBasicMaterial color="#4ade80" wireframe transparent opacity={0.3} />
                    </mesh>
                </group>
            )}
        </>
    );
};

// --- STABLE WRAPPER FOR SPAWNERS ---
const SpawnerInstance = React.memo(({ 
    obj, 
    isSelected, 
    isActiveView, 
    onRegister, 
    onSelect 
}: { 
    obj: LevelObject, 
    isSelected: boolean, 
    isActiveView: boolean,
    onRegister: (id: string, node: THREE.Group | null) => void,
    onSelect: (id: string) => void
}) => {
    const ref = useRef<THREE.Group>(null);

    useEffect(() => {
        if (ref.current) {
            onRegister(obj.id, ref.current);
        }
        return () => {
            onRegister(obj.id, null);
        };
    }, []); 

    return (
        <LevelObjectRenderer 
            ref={ref}
            data={obj}
            isSelected={isSelected && isActiveView}
            onClick={(e) => {
                e.stopPropagation();
                onSelect(obj.id);
            }}
            visible={true}
        />
    );
}, (prev, next) => {
    return (
        prev.obj === next.obj && 
        prev.isSelected === next.isSelected && 
        prev.isActiveView === next.isActiveView &&
        prev.onSelect === next.onSelect
    );
});

SpawnerInstance.displayName = 'SpawnerInstance';

// --- MAIN SCENE CONTENT ---
interface EnvironmentSceneProps {
    activeModel: LoadedModelData | null;
    interactionMode: InteractionMode;
    paintMode: PaintMode;
    onPlace: (pos: THREE.Vector3, rotY: number) => void;
    onPaint: (pos: THREE.Vector3, rot: THREE.Euler, scale: THREE.Vector3) => void;
    onErase: (ids: string[]) => void;
    onSelectObject: (id: string | null) => void;
    models: LoadedModelData[];
    levelObjects: any[];
    updateLevelObject: (id: string, updates: any) => void;
    transformSettings: TransformSettings;
    paintSettings?: PaintSettings;
    sculptSettings?: SculptSettings;
    onSnapshot: () => void;
    selectedId: string | null;
    gridRotation?: [number, number, number];
    viewId: string;
    activeViewId: string;
    isOrthographic?: boolean;
    isMuted: boolean;
}

export const EnvironmentScene: React.FC<EnvironmentSceneProps> = ({ 
    activeModel, 
    interactionMode,
    paintMode,
    onPlace, 
    onPaint, 
    onErase,
    onSelectObject, 
    models, 
    levelObjects, 
    updateLevelObject,
    transformSettings,
    paintSettings,
    sculptSettings,
    onSnapshot,
    selectedId,
    gridRotation = [0, 0, 0],
    viewId,
    activeViewId,
    isOrthographic = false,
    isMuted
}) => {
    const { camera, controls } = useThree(); 
    const { audioAssets } = useAssets();
    const [isTransforming, setIsTransforming] = useState(false);
    const [transformTarget, setTransformTarget] = useState<THREE.Group | null>(null);
    
    const spawnerRefs = useRef<Record<string, THREE.Group>>({});

    const isShiftDown = useRef(false);
    const lastObjPos = useRef(new THREE.Vector3());
    const activeAxis = useRef<string | null>(null);

    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => isShiftDown.current = e.shiftKey;
        window.addEventListener('keydown', handleKey);
        window.addEventListener('keyup', handleKey);
        return () => {
            window.removeEventListener('keydown', handleKey);
            window.removeEventListener('keyup', handleKey);
        };
    }, []);

    const onTransformMouseDown = (e: any) => {
        onSnapshot();
        setIsTransforming(true);
        if (transformTarget) {
            lastObjPos.current.copy(transformTarget.position);
        }
        if (e.target) {
            activeAxis.current = e.target.axis;
        }
    };

    const onTransformChange = () => {
        if (!transformTarget) return;

        if (transformSettings.snapEnabled && isShiftDown.current && transformSettings.snapGrid > 0) {
            const grid = transformSettings.snapGrid;
            transformTarget.position.x = Math.round(transformTarget.position.x / grid) * grid;
            transformTarget.position.y = Math.round(transformTarget.position.y / grid) * grid;
            transformTarget.position.z = Math.round(transformTarget.position.z / grid) * grid;
        }

        const currentPos = transformTarget.position;
        const delta = new THREE.Vector3().subVectors(currentPos, lastObjPos.current);

        if (isTransforming && isShiftDown.current && controls) {
            const axis = activeAxis.current;
            if (axis === 'X' || axis === 'Y' || axis === 'Z') {
                if (delta.lengthSq() > 0.000001) {
                    camera.position.add(delta);
                    if ((controls as any).target) {
                        (controls as any).target.add(delta);
                    }
                }
            }
        }
        lastObjPos.current.copy(currentPos);
    };

    const onTransformEnd = () => {
        setIsTransforming(false);
        activeAxis.current = null;
        
        if (transformTarget && selectedId) {
            const o = transformTarget;
            updateLevelObject(selectedId, {
                position: o.position.toArray(),
                // LevelObject.rotation is authored as a Three.js XYZ Euler in radians.
                // Keep the degree conversion at presentation boundaries only.
                rotation: [o.rotation.x, o.rotation.y, o.rotation.z],
                scale: o.scale.toArray()
            });
        }
    };

    // Filter objects by type
    const { foliageObjects, propObjects, spawners, terrainObjects } = useMemo(() => {
        const foliage: any[] = [];
        const props: any[] = [];
        const spawns: any[] = [];
        const terrains: any[] = [];
        levelObjects.forEach(obj => {
            if (obj.type === 'foliage') foliage.push(obj);
            else if (obj.type === 'spawn_point' || obj.type === 'audio_emitter' || obj.type === 'sky_sphere') spawns.push(obj);
            else if (obj.type === 'terrain') terrains.push(obj);
            else props.push(obj);
        });
        return { foliageObjects: foliage, propObjects: props, spawners: spawns, terrainObjects: terrains };
    }, [levelObjects]);

    // Handle Transform Control target
    useEffect(() => {
        if (selectedId) {
            // Check spawner refs first
            if (spawnerRefs.current[selectedId]) {
                setTransformTarget(spawnerRefs.current[selectedId]);
            } else {
                // If it's a regular scene object, we don't hold refs in this component
                // This logic is simplified; for instanced meshes we can't easily transform single instances with Drei's TransformControls
                // unless we render a dummy object.
                // For this demo, we only support transforming Spawners/Unique objects fully with gizmo.
                setTransformTarget(null);
            }
        } else {
            setTransformTarget(null);
        }
    }, [selectedId]);

    const registerSpawner = useCallback((id: string, node: THREE.Group | null) => {
        if (node) {
            spawnerRefs.current[id] = node;
            if (selectedId === id) setTransformTarget(node);
        } else {
            delete spawnerRefs.current[id];
        }
    }, [selectedId]);

    // Check if current view is active for interaction
    const isActiveView = viewId === activeViewId;

    return (
        <>
            {/* Dynamic Sky System */}
            <SkySystem levelObjects={levelObjects} />

            {/* Grid */}
            <Grid 
                position={[0, -0.01, 0]} 
                rotation={gridRotation}
                infiniteGrid 
                cellSize={1} 
                sectionSize={5} 
                fadeDistance={50} 
                sectionColor="#444" 
                cellColor="#222" 
            />

            {/* Audio System */}
            <AudioSystem 
                levelObjects={levelObjects} 
                audioAssets={audioAssets} 
                isMuted={isMuted} 
            />

            {/* Render Terrain */}
            {terrainObjects.map(terrain => (
                <TerrainObject 
                    key={terrain.id} 
                    data={terrain} 
                    isSelected={selectedId === terrain.id && isActiveView} 
                    visible={true}
                    receiveShadow
                    castShadow
                    onClick={(e) => { 
                        if (isActiveView && interactionMode === 'select' || interactionMode === 'sculpt') {
                            e.stopPropagation(); 
                            onSelectObject(terrain.id);
                        }
                    }}
                    sculptingEnabled={interactionMode === 'sculpt' && selectedId === terrain.id && isActiveView}
                    sculptSettings={sculptSettings}
                    onHeightUpdate={(id, heights) => updateLevelObject(id, { terrainData: { ...terrain.terrainData!, heights } })}
                />
            ))}

            {/* Terrain Sculptor (Global Overlay Logic) */}
            {interactionMode === 'sculpt' && sculptSettings && (
                <TerrainSculptor 
                    settings={sculptSettings}
                    onStrokeEnd={(id, heights) => {
                        const terr = terrainObjects.find(t => t.id === id);
                        if(terr) updateLevelObject(id, { terrainData: { ...terr.terrainData!, heights } });
                    }}
                    enabled={isActiveView}
                />
            )}

            {/* Render Foliage (Instanced) */}
            <InstancedLevelLayer 
                models={models} 
                levelObjects={foliageObjects} 
                onSelect={(id) => isActiveView && onSelectObject(id)}
                interactive={isActiveView && interactionMode !== 'place' && interactionMode !== 'paint'}
            />

            {/* Render Props (Instanced) */}
            <InstancedLevelLayer 
                models={models} 
                levelObjects={propObjects} 
                onSelect={(id) => isActiveView && onSelectObject(id)}
                interactive={isActiveView && interactionMode !== 'place' && interactionMode !== 'paint'}
            />

            {/* Render Unique Objects (Spawners, Audio, Sky) */}
            {spawners.map(obj => (
                <SpawnerInstance 
                    key={obj.id}
                    obj={obj}
                    isSelected={selectedId === obj.id}
                    isActiveView={isActiveView}
                    onRegister={registerSpawner}
                    onSelect={onSelectObject}
                />
            ))}

            {/* Interaction Planes & Tools */}
            {isActiveView && (
                <>
                    <InteractionLayer 
                        activeModel={activeModel}
                        onPlace={onPlace}
                        onSelectObject={onSelectObject}
                        isTransforming={isTransforming}
                        enabled={interactionMode === 'place' || interactionMode === 'select'}
                        snapEnabled={transformSettings.snapEnabled}
                        snapGrid={transformSettings.snapGrid}
                        viewId={viewId}
                        interactionMode={interactionMode}
                    />

                    {interactionMode === 'paint' && paintSettings && (
                        <FoliageBrushTool 
                            activeModel={activeModel}
                            mode={paintMode}
                            existingObjects={[...foliageObjects, ...propObjects]}
                            settings={paintSettings}
                            onPaint={onPaint}
                            onErase={onErase}
                            onStrokeStart={onSnapshot}
                        />
                    )}

                    {/* Transform Gizmo */}
                    {selectedId && transformTarget && interactionMode === 'select' && (
                        <TransformControls 
                            object={transformTarget} 
                            mode={transformSettings.tool} 
                            space={transformSettings.space}
                            onMouseDown={onTransformMouseDown}
                            onChange={onTransformChange}
                            onMouseUp={onTransformEnd}
                            translationSnap={transformSettings.snapEnabled && transformSettings.tool === 'translate' ? transformSettings.snapGrid : null}
                            rotationSnap={transformSettings.snapEnabled && transformSettings.tool === 'rotate' ? THREE.MathUtils.degToRad(transformSettings.snapAngle) : null}
                            scaleSnap={transformSettings.snapEnabled && transformSettings.tool === 'scale' ? transformSettings.snapGrid : null}
                            size={0.8}
                        />
                    )}
                </>
            )}
        </>
    );
};
