
import React, { useRef, useMemo, useImperativeHandle, forwardRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';

export interface BloodSystemHandle {
    spawn: (position: THREE.Vector3, direction?: THREE.Vector3) => void;
}

const PARTICLE_COUNT = 400;
const GRAVITY = 18;
const DRAG = 2.0;

export const BloodSystem = forwardRef<BloodSystemHandle, {}>((_, ref) => {
    const meshRef = useRef<THREE.InstancedMesh>(null);
    // Use a ref for particle state to avoid React render cycles for physics
    const particles = useRef<{
        position: THREE.Vector3;
        velocity: THREE.Vector3;
        life: number;
        maxLife: number;
        scale: number;
        rotation: THREE.Vector3;
        rotSpeed: THREE.Vector3;
    }[]>([]);
    
    const dummy = useMemo(() => new THREE.Object3D(), []);

    useImperativeHandle(ref, () => ({
        spawn: (position: THREE.Vector3, direction?: THREE.Vector3) => {
            // Spawn burst of particles
            const count = 12 + Math.floor(Math.random() * 8); // 12-20 particles
            
            for (let i = 0; i < count; i++) {
                // Recycle slot if limit reached (simple FIFO ish behavior by array push/splice)
                if (particles.current.length >= PARTICLE_COUNT) {
                    particles.current.shift();
                }

                // Random Spread
                const velocity = new THREE.Vector3(
                    (Math.random() - 0.5) * 4,
                    (Math.random() * 3) + 1, // Bias upwards initially
                    (Math.random() - 0.5) * 4
                );
                
                // If we have an incoming projectile direction (or normal), bias recoil away/along it
                if (direction) {
                    // Slight splatter in direction of impact (exit wound style) or reflection
                    velocity.add(direction.clone().multiplyScalar(2.0));
                }

                particles.current.push({
                    position: position.clone(),
                    velocity: velocity,
                    life: 1.0,
                    maxLife: 1.0 + Math.random() * 0.5,
                    scale: Math.random() * 0.08 + 0.04,
                    rotation: new THREE.Vector3(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI),
                    rotSpeed: new THREE.Vector3((Math.random()-0.5)*10, (Math.random()-0.5)*10, (Math.random()-0.5)*10)
                });
            }
        }
    }));

    useFrame((_, delta) => {
        if (!meshRef.current) return;

        // Physics Update
        // Iterate backwards to allow safe removal
        for (let i = particles.current.length - 1; i >= 0; i--) {
            const p = particles.current[i];
            p.life -= delta;
            
            if (p.life <= 0) {
                particles.current.splice(i, 1);
                continue;
            }

            // Gravity
            p.velocity.y -= GRAVITY * delta;
            
            // Floor Collision (Simple y=0 check)
            if (p.position.y <= 0) {
                p.position.y = 0.01;
                p.velocity.y = 0;
                p.velocity.x *= 0.5; // Friction
                p.velocity.z *= 0.5; // Friction
            }

            p.position.addScaledVector(p.velocity, delta);
            
            // Rotate cubes for dynamic look
            p.rotation.x += p.rotSpeed.x * delta;
            p.rotation.y += p.rotSpeed.y * delta;
            p.rotation.z += p.rotSpeed.z * delta;
        }

        // Render Update
        for (let i = 0; i < particles.current.length; i++) {
            const p = particles.current[i];
            dummy.position.copy(p.position);
            dummy.rotation.set(p.rotation.x, p.rotation.y, p.rotation.z);
            
            // Shrink over life
            const scale = p.scale * Math.max(0, (p.life / p.maxLife));
            dummy.scale.setScalar(scale);
            
            dummy.updateMatrix();
            meshRef.current.setMatrixAt(i, dummy.matrix);
        }
        
        // Hide unused instances by scaling them to 0
        // We set count to full buffer size to avoid reallocation, but we could also manage .count
        // Using setMatrixAt for unused items is robust.
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        for (let i = particles.current.length; i < PARTICLE_COUNT; i++) {
            meshRef.current.setMatrixAt(i, dummy.matrix);
        }

        meshRef.current.count = PARTICLE_COUNT; 
        meshRef.current.instanceMatrix.needsUpdate = true;
    });

    return (
        <instancedMesh ref={meshRef} args={[undefined, undefined, PARTICLE_COUNT]} frustumCulled={false}>
            <boxGeometry args={[1, 1, 1]} />
            {/* Deep red blood color */}
            <meshStandardMaterial color="#8a0303" roughness={0.1} metalness={0.2} />
        </instancedMesh>
    );
});
