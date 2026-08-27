
import React, { useRef, useMemo, useEffect, useState } from 'react';
import * as THREE from 'three';
import { AuvraCanvas } from '../../renderer/AuvraCanvas';
import { View, PerspectiveCamera, OrthographicCamera, OrbitControls } from '@react-three/drei';
import { useAssets, useLevel } from '../../context/SceneContext';
import { LoadedModelData } from '../../types';
import { InteractionMode, PaintMode, PaintSettings, TransformSettings, ViewportLayout, SculptSettings } from './types';
import { EnvironmentScene } from './EnvironmentScene';

interface EnvironmentViewportProps {
    activeModelId: string | null;
    onSelectObject: (id: string | null) => void;
    interactionMode: InteractionMode;
    paintMode?: PaintMode;
    transformSettings: TransformSettings;
    paintSettings?: PaintSettings;
    sculptSettings?: SculptSettings;
    layout?: ViewportLayout;
    cameraSpeed?: number;
    isMuted: boolean;
}

// Internal component to handle view-specific scene rendering
const ViewportSceneContent: React.FC<{
    viewId: string;
    activeViewId: string;
    gridRotation?: [number, number, number];
    isOrthographic?: boolean;
    sceneProps: any;
}> = ({ viewId, activeViewId, gridRotation, isOrthographic, sceneProps }) => {
    return (
        <EnvironmentScene 
            {...sceneProps}
            viewId={viewId}
            activeViewId={activeViewId}
            gridRotation={gridRotation}
            isOrthographic={isOrthographic}
        />
    );
};

export const EnvironmentViewport: React.FC<EnvironmentViewportProps> = ({ 
    activeModelId, 
    onSelectObject,
    interactionMode,
    paintMode = 'add',
    transformSettings,
    paintSettings,
    sculptSettings,
    layout = 'single',
    cameraSpeed = 1.0,
    isMuted
}) => {
    const { models } = useAssets();
    const { levelObjects, addLevelObject, removeLevelObjects, updateLevelObject, snapshotHistory } = useLevel();
    const containerRef = useRef<HTMLDivElement>(null);
    
    // Selection and Active View State
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [activeView, setActiveView] = useState<string>('main');

    // Refs for View tracking
    const viewMain = useRef<HTMLDivElement>(null);
    const viewTop = useRef<HTMLDivElement>(null);
    const viewBottom = useRef<HTMLDivElement>(null);
    const viewLeft = useRef<HTMLDivElement>(null);
    const viewRight = useRef<HTMLDivElement>(null);

    const activeModel = useMemo(() => 
        activeModelId ? models.find(m => m.id === activeModelId) || null : null, 
    [models, activeModelId]);

    useEffect(() => {
        if (interactionMode !== 'select' && interactionMode !== 'sculpt') {
            setSelectedId(null);
        }
    }, [interactionMode]);

    const handleViewSelect = (id: string | null, viewId: string) => {
        setActiveView(viewId);
        setSelectedId(id);
        onSelectObject(id);
    };

    const handlePlace = (pos: THREE.Vector3, rotY: number) => {
        if (!activeModelId) return;
        addLevelObject(activeModelId, pos.toArray(), [0, rotY, 0], [1, 1, 1], 'prop');
    };

    const handlePaint = (pos: THREE.Vector3, rot: THREE.Euler, scale: THREE.Vector3) => {
        if (!activeModelId) return;
        addLevelObject(activeModelId, pos.toArray(), [rot.x, rot.y, rot.z], scale.toArray(), 'foliage');
    };

    const handleErase = (ids: string[]) => {
        removeLevelObjects(ids);
    };

    // Bundle props for the scene
    const baseSceneProps = {
        activeModel,
        interactionMode,
        paintMode,
        onPlace: handlePlace,
        onPaint: handlePaint,
        onErase: handleErase,
        models,
        levelObjects,
        updateLevelObject,
        transformSettings,
        paintSettings,
        sculptSettings,
        onSnapshot: snapshotHistory,
        selectedId,
        isMuted
    };

    // --- Control Configuration ---
    // UX Decision: Left Click is ALWAYS for Tools (Select, Paint, Sculpt).
    // Right Click is ALWAYS for Camera Rotation.
    const controlConfig = {
        mouseButtons: {
            LEFT: undefined as any, // Disable Left Click Rotation
            MIDDLE: THREE.MOUSE.PAN,
            RIGHT: THREE.MOUSE.ROTATE
        }
    };

    return (
        <div ref={containerRef} className="relative w-full h-full bg-[#111]">
            
            {/* HTML Layout Grid for View Tracking */}
            <div className="absolute inset-0 w-full h-full flex flex-col pointer-events-none">
                {layout === 'single' ? (
                    <div className="relative w-full h-full bg-[#111] pointer-events-auto border-b border-gray-800">
                        <div ref={viewMain} className="w-full h-full" onMouseDown={() => setActiveView('main')} />
                        <div className={`absolute top-2 left-2 text-[10px] font-bold px-2 py-0.5 rounded pointer-events-none z-10 ${activeView === 'main' ? 'bg-blue-600 text-white' : 'bg-black/50 text-gray-500'}`}>
                            PERSPECTIVE
                        </div>
                    </div>
                ) : (
                    <div className="w-full h-full grid grid-cols-2 grid-rows-2 gap-0.5 bg-gray-800 pointer-events-auto">
                        {/* 1. TOP LEFT -> LEFT View */}
                        <div className="relative bg-[#111]">
                            <div ref={viewLeft} className="w-full h-full" onMouseDown={() => setActiveView('left')} />
                            <div className={`absolute top-2 left-2 text-[10px] font-bold px-2 py-0.5 rounded pointer-events-none z-10 ${activeView === 'left' ? 'bg-blue-600 text-white' : 'bg-black/50 text-gray-500'}`}>
                                LEFT
                            </div>
                        </div>
                        {/* 2. TOP RIGHT -> RIGHT View */}
                        <div className="relative bg-[#111]">
                            <div ref={viewRight} className="w-full h-full" onMouseDown={() => setActiveView('right')} />
                            <div className={`absolute top-2 left-2 text-[10px] font-bold px-2 py-0.5 rounded pointer-events-none z-10 ${activeView === 'right' ? 'bg-blue-600 text-white' : 'bg-black/50 text-gray-500'}`}>
                                RIGHT
                            </div>
                        </div>
                        {/* 3. BOTTOM LEFT -> TOP View */}
                        <div className="relative bg-[#111]">
                            <div ref={viewTop} className="w-full h-full" onMouseDown={() => setActiveView('top')} />
                            <div className={`absolute top-2 left-2 text-[10px] font-bold px-2 py-0.5 rounded pointer-events-none z-10 ${activeView === 'top' ? 'bg-blue-600 text-white' : 'bg-black/50 text-gray-500'}`}>
                                TOP
                            </div>
                        </div>
                        {/* 4. BOTTOM RIGHT -> BOTTOM View */}
                        <div className="relative bg-[#111]">
                            <div ref={viewBottom} className="w-full h-full" onMouseDown={() => setActiveView('bottom')} />
                            <div className={`absolute top-2 left-2 text-[10px] font-bold px-2 py-0.5 rounded pointer-events-none z-10 ${activeView === 'bottom' ? 'bg-blue-600 text-white' : 'bg-black/50 text-gray-500'}`}>
                                BOTTOM
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Shared Canvas */}
            <AuvraCanvas
                surfaceId="editor-environment-viewport"
                role="editor"
                className="absolute inset-0 pointer-events-none"
                eventSource={containerRef}
                shadows
            >
                {layout === 'single' && (
                    <View track={viewMain}>
                        <PerspectiveCamera makeDefault position={[10, 10, 10]} fov={45} />
                        <OrbitControls 
                            makeDefault 
                            panSpeed={cameraSpeed} 
                            zoomSpeed={cameraSpeed}
                            mouseButtons={controlConfig.mouseButtons}
                        />
                        <ViewportSceneContent 
                            viewId="main" 
                            activeViewId={activeView}
                            sceneProps={{...baseSceneProps, onSelectObject: (id: string | null) => handleViewSelect(id, 'main')}}
                        />
                    </View>
                )}

                {layout === 'quad' && (
                    <>
                        <View track={viewLeft}>
                            <ambientLight intensity={0.8} />
                            <OrthographicCamera makeDefault position={[50, 0, 0]} zoom={20} near={-100} far={100} />
                            <OrbitControls makeDefault enableRotate={false} panSpeed={cameraSpeed} zoomSpeed={cameraSpeed} mouseButtons={controlConfig.mouseButtons} />
                            <ViewportSceneContent 
                                viewId="left" 
                                activeViewId={activeView}
                                gridRotation={[0, 0, -Math.PI / 2]} 
                                isOrthographic 
                                sceneProps={{...baseSceneProps, onSelectObject: (id: string | null) => handleViewSelect(id, 'left')}}
                            />
                        </View>

                        <View track={viewRight}>
                            <ambientLight intensity={0.8} />
                            <OrthographicCamera makeDefault position={[-50, 0, 0]} zoom={20} near={-100} far={100} />
                            <OrbitControls makeDefault enableRotate={false} panSpeed={cameraSpeed} zoomSpeed={cameraSpeed} mouseButtons={controlConfig.mouseButtons} />
                            <ViewportSceneContent 
                                viewId="right" 
                                activeViewId={activeView}
                                gridRotation={[0, 0, Math.PI / 2]} 
                                isOrthographic 
                                sceneProps={{...baseSceneProps, onSelectObject: (id: string | null) => handleViewSelect(id, 'right')}}
                            />
                        </View>

                        <View track={viewTop}>
                            <ambientLight intensity={0.8} />
                            <OrthographicCamera makeDefault position={[0, 50, 0]} zoom={20} near={-100} far={100} />
                            <OrbitControls makeDefault enableRotate={false} panSpeed={cameraSpeed} zoomSpeed={cameraSpeed} mouseButtons={controlConfig.mouseButtons} />
                            <ViewportSceneContent 
                                viewId="top" 
                                activeViewId={activeView}
                                isOrthographic 
                                sceneProps={{...baseSceneProps, onSelectObject: (id: string | null) => handleViewSelect(id, 'top')}}
                            />
                        </View>

                        <View track={viewBottom}>
                            <ambientLight intensity={0.8} />
                            <OrthographicCamera makeDefault position={[0, -50, 0]} zoom={20} near={-100} far={100} />
                            <OrbitControls makeDefault enableRotate={false} panSpeed={cameraSpeed} zoomSpeed={cameraSpeed} mouseButtons={controlConfig.mouseButtons} />
                            <ViewportSceneContent 
                                viewId="bottom" 
                                activeViewId={activeView}
                                gridRotation={[Math.PI, 0, 0]} 
                                isOrthographic 
                                sceneProps={{...baseSceneProps, onSelectObject: (id: string | null) => handleViewSelect(id, 'bottom')}}
                            />
                        </View>
                    </>
                )}
            </AuvraCanvas>
        </div>
    );
};
