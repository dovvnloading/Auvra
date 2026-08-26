
import React, { useEffect, useRef, useMemo } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { SocketData } from '../../types';
import { useScene } from '../../context/SceneContext';

interface SocketControllerProps {
    data: SocketData;
    parentObject: THREE.Group;
    onMount?: (obj: THREE.Object3D) => void;
}

// --- SHADERS FOR SOFT FALLOFF ---
const softFlashVertexShader = `
varying vec3 vNormal;
varying vec3 vViewPosition;
void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    vNormal = normalize(normalMatrix * normal);
    vViewPosition = -mvPosition.xyz;
}
`;

const softFlashFragmentShader = `
uniform vec3 uColor;
uniform float uOpacity;
varying vec3 vNormal;
varying vec3 vViewPosition;

void main() {
    vec3 normal = normalize(vNormal);
    vec3 viewDir = normalize(vViewPosition);
    
    // Calculate Fresnel effect (1.0 at center facing cam, 0.0 at grazing edges)
    float dotProduct = dot(normal, viewDir);
    float fresnel = max(0.0, dotProduct);
    
    // Non-linear falloff for "gaseous" look
    // Higher power = sharper core, softer edges
    float alpha = pow(fresnel, 2.5); 
    
    // Boost brightness at the very center for "hot core" effect
    vec3 finalColor = uColor * (1.0 + alpha * 0.5);
    
    gl_FragColor = vec4(finalColor, alpha * uOpacity);
}
`;

export const SocketController: React.FC<SocketControllerProps> = ({ data, parentObject, onMount }) => {
    const objRef = useRef<THREE.Group>(null);
    const flashRef = useRef<THREE.Object3D>(null);
    const gizmoRef = useRef<THREE.Group>(null);
    const { flashTriggers, textures } = useScene();
    
    // Internal state for flash animation
    const flashState = useRef({
        active: false,
        timeLeft: 0
    });
    
    // Persist random rotation between renders
    const randomRoll = useRef(0);

    // Notify parent about the object ref (for physics/projectile spawning)
    useEffect(() => {
        if (objRef.current && onMount) {
            onMount(objRef.current);
        }
    }, [onMount]);

    // Texture Loader
    const textureUrl = useMemo(() => {
        if (!data.flashConfig?.textureId) return null;
        const tex = textures.find(t => t.id === data.flashConfig?.textureId);
        return tex ? tex.url : null;
    }, [data.flashConfig?.textureId, textures]);

    const flashTexture = useMemo(() => {
        if (!textureUrl) return null;
        const tex = new THREE.TextureLoader().load(textureUrl);
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
    }, [textureUrl]);

    // Create the Soft Material instance once
    const softMaterial = useMemo(() => {
        return new THREE.ShaderMaterial({
            uniforms: {
                uColor: { value: new THREE.Color(1, 1, 1) },
                uOpacity: { value: 1.0 }
            },
            vertexShader: softFlashVertexShader,
            fragmentShader: softFlashFragmentShader,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false, // Important for overlapping soft transparency
            depthTest: true
        });
    }, []);

    // Attach to Bone Logic
    useEffect(() => {
        let targetBone: THREE.Object3D | undefined;
        
        if (data.boneName) {
            targetBone = parentObject.getObjectByName(data.boneName);
        }
        
        if (!targetBone) {
             targetBone = parentObject;
        }
        
        if (targetBone && objRef.current) {
            objRef.current.name = `Socket_${data.id}`;
            if (objRef.current.parent !== targetBone) {
                targetBone.add(objRef.current);
            }
        }
        
        return () => {
            if (objRef.current?.parent) {
                objRef.current.parent.remove(objRef.current);
            }
        };
    }, [data.boneName, parentObject, data.id]);

    // Update Transform
    useEffect(() => {
        if (objRef.current) {
            objRef.current.position.set(...data.position);
            objRef.current.rotation.set(
                THREE.MathUtils.degToRad(data.rotation[0]),
                THREE.MathUtils.degToRad(data.rotation[1]),
                THREE.MathUtils.degToRad(data.rotation[2])
            );
            objRef.current.scale.set(...data.scale);
            objRef.current.updateMatrix();
        }
    }, [data.position, data.rotation, data.scale]);

    // --- TRIGGER LOGIC ---
    const lastTrigger = flashTriggers[data.id];
    useEffect(() => {
        if (lastTrigger && data.flashConfig?.enabled) {
            flashState.current.active = true;
            flashState.current.timeLeft = data.flashConfig.duration;
            
            // Randomize ONLY on trigger
            randomRoll.current = Math.random() * Math.PI * 2;
            
            if (flashRef.current) {
                flashRef.current.visible = true;
            }
        }
    }, [lastTrigger]);

    // --- PREVIEW MODE LOGIC ---
    useEffect(() => {
        if (data.flashConfig?.preview) {
            flashState.current.active = true;
            flashState.current.timeLeft = Infinity;
            if (flashRef.current) flashRef.current.visible = true;
        } else {
            if (flashState.current.timeLeft === Infinity) {
                flashState.current.active = false;
                flashState.current.timeLeft = 0;
            }
        }
    }, [data.flashConfig?.preview]);

    // Animation & Compensation Loop
    useFrame((_, delta) => {
        if (!objRef.current) return;

        // --- 1. SCALE COMPENSATION ---
        const parentWorldScale = new THREE.Vector3();
        if (objRef.current.parent) {
            objRef.current.parent.getWorldScale(parentWorldScale);
        } else {
            parentWorldScale.set(1, 1, 1);
        }

        const maxScale = Math.max(parentWorldScale.x, parentWorldScale.y, parentWorldScale.z, 0.0001);
        const invScale = 1.0 / maxScale;

        if (gizmoRef.current) {
            gizmoRef.current.scale.setScalar(invScale);
        }

        // --- 2. FLASH RENDERING ---
        if (flashRef.current) {
            
            if (flashState.current.active) {
                if (flashState.current.timeLeft !== Infinity) {
                    flashState.current.timeLeft -= delta;
                }
                
                if (flashState.current.timeLeft <= 0) {
                    flashState.current.active = false;
                    flashRef.current.visible = false;
                } else {
                    flashRef.current.visible = true;
                    
                    const baseScale = data.flashConfig?.scale || 1.0;
                    let animScale = baseScale;
                    let opacity = 1.0;

                    if (flashState.current.timeLeft !== Infinity) {
                        const duration = data.flashConfig?.duration || 0.1;
                        const progress = 1 - (flashState.current.timeLeft / duration);
                        // Fast pop in, slower fade out curve
                        animScale = baseScale * (0.8 + Math.sin(progress * Math.PI) * 0.4); 
                        opacity = progress > 0.7 ? (1 - progress) * 3 : 1.0; 
                    }

                    const targetColor = new THREE.Color(data.flashConfig?.color || '#ffffff');
                    
                    // Update Material Properties (Supports both Basic and Shader)
                    flashRef.current.traverse((child) => {
                        if ((child as THREE.Mesh).isMesh) {
                            const m = (child as THREE.Mesh).material;
                            
                            // Handle Custom Shader
                            if ((m as THREE.ShaderMaterial).uniforms) {
                                const sm = m as THREE.ShaderMaterial;
                                sm.uniforms.uOpacity.value = opacity;
                                sm.uniforms.uColor.value.copy(targetColor);
                            } 
                            // Handle Standard Basic Material (Texture Mode)
                            else if ((m as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
                                const bm = m as THREE.MeshBasicMaterial;
                                bm.opacity = opacity;
                                bm.color.copy(targetColor);
                            }
                        }
                    });

                    // --- TRANSFORM LOGIC ---
                    if (flashTexture) {
                        // TEXTURE MODE
                        flashRef.current.rotation.set(0, 0, 0); 
                        flashRef.current.rotateX(-Math.PI / 2); 
                        flashRef.current.rotateY(randomRoll.current);
                        flashRef.current.position.set(0, 0, 0.5 * animScale * invScale);
                        flashRef.current.scale.setScalar(animScale * invScale);
                    } else {
                        // SYNTHETIC MODE (3D Group)
                        flashRef.current.rotation.set(0, 0, 0);
                        flashRef.current.rotateZ(randomRoll.current);
                        flashRef.current.position.set(0, 0, 0);
                        flashRef.current.scale.setScalar(animScale * invScale);
                    }
                }
            } else {
                flashRef.current.visible = false;
            }
        }
    });

    return (
        <group ref={objRef}>
            {/* Visual Debug Gizmo (Only visible in Editor/Preview if needed, currently transparent) */}
            <group ref={gizmoRef} visible={false}>
                <mesh>
                    <sphereGeometry args={[0.05, 8, 8]} />
                    <meshBasicMaterial color="#ef4444" wireframe depthTest={false} transparent opacity={0.5} />
                </mesh>
                <arrowHelper args={[new THREE.Vector3(0,0,1), new THREE.Vector3(0,0,0), 0.2, 0xef4444]} />
            </group>

            {/* Render Flash */}
            {data.flashConfig?.enabled && (
                flashTexture ? (
                    <mesh 
                        ref={flashRef as React.RefObject<THREE.Mesh>}
                        visible={false}
                        frustumCulled={false} 
                        renderOrder={1000} 
                    >
                        <planeGeometry args={[1, 1]} />
                        <meshBasicMaterial 
                            map={flashTexture} 
                            transparent 
                            depthWrite={false} 
                            depthTest={true}
                            blending={THREE.AdditiveBlending}
                            side={THREE.DoubleSide}
                            toneMapped={false}
                        />
                    </mesh>
                ) : (
                    // SYNTHETIC FLASH GROUP (Using Soft Shader Spheres)
                    <group 
                        ref={flashRef as React.RefObject<THREE.Group>}
                        visible={false}
                        renderOrder={1000}
                    >
                        {/* 1. Core Jet (Stretched Sphere) - Pointing +Z */}
                        <mesh 
                            position={[0, 0, 0.3]} 
                            rotation={[Math.PI / 2, 0, 0]}
                            scale={[0.6, 2.0, 0.6]}
                            material={softMaterial}
                        >
                            <sphereGeometry args={[0.3, 16, 16]} />
                        </mesh>

                        {/* 2. Side Star Burst (3 Crossing Stretched Spheres) */}
                        {/* Ray A */}
                        <mesh 
                            rotation={[0, 0, 0]}
                            scale={[4.0, 0.3, 0.3]}
                            material={softMaterial}
                        >
                             <sphereGeometry args={[0.15, 16, 16]} />
                        </mesh>
                        {/* Ray B (60 deg) */}
                        <mesh 
                            rotation={[0, 0, Math.PI / 3]}
                            scale={[4.0, 0.3, 0.3]}
                            material={softMaterial}
                        >
                             <sphereGeometry args={[0.15, 16, 16]} />
                        </mesh>
                        {/* Ray C (120 deg) */}
                        <mesh 
                            rotation={[0, 0, -Math.PI / 3]}
                            scale={[4.0, 0.3, 0.3]}
                            material={softMaterial}
                        >
                             <sphereGeometry args={[0.15, 16, 16]} />
                        </mesh>
                        
                        {/* 3. Central Glow Ball */}
                        <mesh material={softMaterial} scale={[1.2, 1.2, 1.2]}>
                            <sphereGeometry args={[0.2, 16, 16]} />
                        </mesh>
                    </group>
                )
            )}
        </group>
    );
};
