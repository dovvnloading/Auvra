
import React, { useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Center } from '@react-three/drei';
import { LoadedModelData } from '../../types';
import { LocalEnvironment } from '../Scene/LocalEnvironment';

interface ThumbnailTooltipProps {
    model: LoadedModelData;
    position: { x: number; y: number };
}

const AutoFramingScene = ({ object }: { object: THREE.Object3D }) => {
    const groupRef = useRef<THREE.Group>(null);
    const { camera } = useThree();

    useFrame((_, delta) => {
        if (groupRef.current) {
            groupRef.current.rotation.y += delta * 1.0;
        }
    });

    useEffect(() => {
        // Calculate the bounding box of the object to determine proper camera distance
        const box = new THREE.Box3().setFromObject(object);
        const size = new THREE.Vector3();
        box.getSize(size);
        
        // Since we use <Center>, the object will be centered at (0,0,0)
        // We just need to fit the max dimension into the view
        const maxDim = Math.max(size.x, size.y, size.z);
        const effectiveSize = maxDim || 2; // Fallback size if calculation fails
        
        const fov = 50;
        const fovRad = (fov * Math.PI) / 180;
        
        // Calculate distance required to fit object height/width
        // dist = size / (2 * tan(fov/2))
        let dist = effectiveSize / (2 * Math.tan(fovRad / 2));
        
        // Add padding factor (1.5x) to ensure breathing room
        dist *= 1.5;
        
        // Position camera: 
        // Z = calculated distance
        // Y = slight elevation for better 3D perspective
        const elevation = effectiveSize * 0.2;
        
        camera.position.set(0, elevation, dist);
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
        
    }, [camera, object]);

    return (
        <group ref={groupRef}>
            <Center>
                <primitive object={object} />
            </Center>
        </group>
    );
};

export const ThumbnailTooltip: React.FC<ThumbnailTooltipProps> = ({ model, position }) => {
    // Clone the object so we can render it in a separate scene without removing it from the main scene
    const clonedObject = useMemo(() => model.object.clone(), [model.object]);

    // Portal to body to ensure it floats above everything
    return createPortal(
        <div 
            className="fixed z-[9999] pointer-events-none rounded-xl overflow-hidden border border-gray-600 bg-gray-900 shadow-2xl animate-in fade-in zoom-in-95 duration-200"
            style={{ 
                left: position.x, 
                top: position.y,
                width: 240, // Slightly wider for better presentation
                height: 240,
                transform: 'translate(-50%, -115%)' // Position above cursor
            }}
        >
            <div className="absolute top-2 left-0 right-0 text-center z-10">
                <span className="bg-black/60 backdrop-blur-md text-[10px] text-white px-2 py-0.5 rounded-full border border-white/10 font-medium">
                    {model.category}
                </span>
            </div>
            
            <Canvas camera={{ fov: 50 }}>
                <color attach="background" args={['#171717']} />
                
                {/* Enhanced Lighting Setup for Better Visibility */}
                <ambientLight intensity={1.5} />
                <directionalLight position={[5, 10, 7]} intensity={2} />
                <directionalLight position={[-5, 5, -5]} intensity={1} />
                <LocalEnvironment />
                
                <AutoFramingScene object={clonedObject} />
            </Canvas>
            
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-3 pt-8">
                <div className="text-xs font-bold text-white text-center truncate tracking-wide">{model.name}</div>
            </div>
        </div>,
        document.body
    );
};
