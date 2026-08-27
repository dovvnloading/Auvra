
import React, { useEffect, useRef, useMemo } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { AuvraCanvas } from '../../renderer/AuvraCanvas';
import { Grid, OrbitControls, ContactShadows } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useScene } from '../../context/SceneContext';
import { AnimationGraphData, LoadedModelData } from '../../types';
import { GraphRuntime } from './GraphRuntime';
import { AttachmentController } from '../Scene/AttachmentController';
import { SocketController } from '../Scene/SocketController';
import { LocalEnvironment } from '../Scene/LocalEnvironment';

// Helper component to handle camera persistence and tracking
const PreviewCamera: React.FC<{ targetObject?: THREE.Object3D }> = ({ targetObject }) => {
    const { cameraState, setCameraState } = useScene();
    const { camera } = useThree();
    const controlsRef = useRef<OrbitControlsImpl>(null);
    const targetRef = useRef(new THREE.Vector3(0, 1, 0));

    // Frame loop to update controls target to follow the character
    useFrame(() => {
        if (targetObject && controlsRef.current) {
            const newTarget = new THREE.Vector3().copy(targetObject.position);
            newTarget.y += 1; 
            
            targetRef.current.lerp(newTarget, 0.1);
            controlsRef.current.target.copy(targetRef.current);
        }
    });

    // We disable full persistence in the preview window to avoid fighting with the main view persistence
    // But we use it for initial positioning
    useEffect(() => {
        camera.position.set(cameraState.position[0], cameraState.position[1], cameraState.position[2]);
        // We don't save back from preview to avoid overwriting main view state constantly
    }, []);

    return (
        <OrbitControls 
            ref={controlsRef}
            makeDefault 
            target={cameraState.target}
            enableDamping={true}
            dampingFactor={0.1}
        />
    );
};

export const GraphPreview: React.FC<{ 
    graph?: AnimationGraphData;
    allClips: THREE.AnimationClip[];
    model?: LoadedModelData | undefined; // Optional explicit model
    scale?: number; // Optional scaling multiplier
    textureUrl?: string | null; // Optional texture override
}> = ({ graph: propGraph, allClips, model, scale = 1.0, textureUrl }) => {
    const { models, selectedModelId, graphData, updateGraph, attachments, sockets } = useScene();
    
    // Determine which model to show. 
    // Priority: Explicit prop (from BlueprintEditor) > Global Selection (from GraphEditor context)
    const targetModel = model || models.find(m => m.id === selectedModelId);
    
    // If graph is provided as prop (e.g. from Blueprint Editor), use it. 
    // Otherwise fall back to global context graphData (legacy).
    const graph = propGraph || (targetModel && graphData[targetModel.id]);
    const displayObject = targetModel?.object;

    // Filter attachments for this specific model
    const modelAttachments = useMemo(() => 
        targetModel ? attachments.filter(a => a.parentModelId === targetModel.id) : [], 
    [targetModel, attachments]);

    // Filter sockets for this specific model
    const modelSockets = useMemo(() => 
        targetModel ? sockets.filter(s => s.parentModelId === targetModel.id) : [], 
    [targetModel, sockets]);

    const finalScale = useMemo(() => {
        const base = targetModel?.initialScale || [1, 1, 1];
        return [base[0] * scale, base[1] * scale, base[2] * scale] as [number, number, number];
    }, [targetModel, scale]);

    // Handle Texture Override
    useEffect(() => {
        if (!displayObject) return;

        if (textureUrl) {
            const loader = new THREE.TextureLoader();
            loader.load(textureUrl, (tex) => {
                tex.colorSpace = THREE.SRGBColorSpace;
                tex.flipY = true;
                
                displayObject.traverse((child) => {
                    if ((child as THREE.Mesh).isMesh) {
                        const mesh = child as THREE.Mesh;
                        const mat = mesh.material;
                        // Apply to all standard materials found on mesh
                        if (Array.isArray(mat)) {
                            mat.forEach(m => { 
                                if ((m as any).map !== undefined) { 
                                    (m as any).map = tex; 
                                    m.needsUpdate = true;
                                } 
                            });
                        } else {
                            if ((mat as any).map !== undefined) {
                                (mat as any).map = tex;
                                mat.needsUpdate = true;
                            }
                        }
                    }
                });
            });
        } 
        // Note: Reverting to original texture is complex without deep cloning. 
        // In this editor context, reloading the model or clearing the selection handles reset naturally.
    }, [displayObject, textureUrl]);

    if (!targetModel || !displayObject || !graph) return null;

    return (
        <AuvraCanvas
            surfaceId="preview-animation-graph"
            role="preview"
            shadows
            camera={{ position: [4, 4, 8], fov: 45 }}
            dpr={[1, 2]}
            gl={{ 
                toneMapping: THREE.ACESFilmicToneMapping,
                toneMappingExposure: 1.0, 
                antialias: true
            }}
        >
            <color attach="background" args={['#0a0a0a']} />
            <fog attach="fog" args={['#0a0a0a', 10, 50]} />
            
            <LocalEnvironment />

            <ambientLight intensity={0.5} />
            <directionalLight 
                position={[10, 10, 5]} 
                intensity={1.5} 
                castShadow 
                shadow-bias={-0.0001}
            />
            
            <group position={[0, -0.2, 0]}>
                <Grid 
                    infiniteGrid 
                    cellSize={1} 
                    sectionSize={5} 
                    fadeDistance={30} 
                    sectionColor="#525252" 
                    cellColor="#171717" 
                />
                
                <primitive object={displayObject} scale={finalScale} />

                {/* Render Attachments */}
                {modelAttachments.map(att => (
                    <AttachmentController 
                        key={att.id} 
                        data={att} 
                        parentObject={displayObject} 
                    />
                ))}

                {/* Render Sockets (Always visible in Graph Preview for debugging) */}
                {modelSockets.map(sock => (
                    <SocketController
                        key={sock.id}
                        data={sock}
                        parentObject={displayObject}
                    />
                ))}
                
                <ContactShadows opacity={0.4} scale={20} blur={2} far={4} resolution={256} color="#000000" />
            </group>
            
            <GraphRuntime 
                modelObject={displayObject}
                graph={graph}
                allClips={allClips}
                enableInputs={true}
                onActiveStateChange={(id) => {
                    // Update external state if needed (mainly for visualization)
                    if (!propGraph && targetModel) {
                        updateGraph(targetModel.id, { activeStateId: id });
                    }
                }}
            />

            <PreviewCamera targetObject={displayObject} />
        </AuvraCanvas>
    );
};
