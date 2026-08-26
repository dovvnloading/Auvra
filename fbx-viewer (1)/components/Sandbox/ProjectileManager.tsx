
import React, { useRef, useImperativeHandle, forwardRef, useMemo, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Hittable } from '../../types';

interface ProjectileData {
    id: number;
    position: THREE.Vector3;
    velocity: THREE.Vector3;
    life: number;
    team: 'Player' | 'Enemy';
    damage: number;
}

export interface ProjectileManagerHandle {
    fire: (origin: THREE.Vector3, direction: THREE.Vector3, speed: number, team: 'Player' | 'Enemy', damage: number) => void;
    registerTarget: (target: Hittable) => void;
    unregisterTarget: (id: string) => void;
}

export const ProjectileManager = forwardRef<ProjectileManagerHandle, {}>((props, ref) => {
    const meshRef = useRef<THREE.InstancedMesh>(null);
    const projectilesRef = useRef<ProjectileData[]>([]);
    const targetsRef = useRef<Hittable[]>([]);
    
    const dummy = useMemo(() => new THREE.Object3D(), []);
    const rayStart = useMemo(() => new THREE.Vector3(), []);
    const rayEnd = useMemo(() => new THREE.Vector3(), []);
    
    // Force re-renders for React logic if needed
    const [, setTick] = useState(0);

    useImperativeHandle(ref, () => ({
        fire: (origin: THREE.Vector3, direction: THREE.Vector3, speed: number, team: 'Player' | 'Enemy', damage: number) => {
            const newProj: ProjectileData = {
                id: Math.random(),
                position: origin.clone(),
                velocity: direction.clone().normalize().multiplyScalar(speed),
                life: 3.0,
                team,
                damage
            };
            projectilesRef.current.push(newProj);
        },
        registerTarget: (target: Hittable) => {
            if (!targetsRef.current.find(t => t.id === target.id)) {
                targetsRef.current.push(target);
            }
        },
        unregisterTarget: (id: string) => {
            targetsRef.current = targetsRef.current.filter(t => t.id !== id);
        }
    }));

    const checkCollision = (p: ProjectileData, delta: number): boolean => {
        rayStart.copy(p.position);
        rayEnd.copy(p.position).addScaledVector(p.velocity, delta);

        for (const target of targetsRef.current) {
            if (target.team === p.team || target.isDead()) continue;

            const hitbox = target.getHitbox();
            
            // Height Check
            const bottom = hitbox.center.y;
            const top = bottom + hitbox.height;
            if (rayStart.y > top && rayEnd.y > top) continue;
            if (rayStart.y < bottom && rayEnd.y < bottom) continue;

            // Radius Check (XZ)
            const A = { x: rayStart.x, y: rayStart.z };
            const B = { x: rayEnd.x, y: rayEnd.z };
            const P = { x: hitbox.center.x, y: hitbox.center.z };

            const dx = B.x - A.x;
            const dy = B.y - A.y;
            let t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / (dx * dx + dy * dy);
            t = Math.max(0, Math.min(1, t));

            const closestX = A.x + t * dx;
            const closestY = A.y + t * dy;
            const distSq = (P.x - closestX) ** 2 + (P.y - closestY) ** 2;

            if (distSq <= hitbox.radius * hitbox.radius) {
                const impactPoint = new THREE.Vector3().lerpVectors(rayStart, rayEnd, t);
                if (impactPoint.y >= bottom && impactPoint.y <= top) {
                    target.takeDamage(p.damage, impactPoint);
                    return true;
                }
            }
        }
        return false;
    };

    useFrame((_, delta) => {
        if (!meshRef.current) return;

        const projectiles = projectilesRef.current;
        
        // Physics Loop
        for (let i = projectiles.length - 1; i >= 0; i--) {
            const p = projectiles[i];
            p.life -= delta;

            if (p.life <= 0) {
                projectiles.splice(i, 1);
                continue;
            }

            if (checkCollision(p, delta)) {
                projectiles.splice(i, 1);
                continue;
            }

            p.position.addScaledVector(p.velocity, delta);
            
            if (p.position.y < 0) projectiles.splice(i, 1);
        }

        // Render Loop
        for (let i = 0; i < projectiles.length; i++) {
             const p = projectiles[i];
             dummy.position.copy(p.position);
             dummy.lookAt(dummy.position.clone().add(p.velocity));
             
             // Uniform scale for sphere (2x base size = 10cm radius)
             dummy.scale.set(2, 2, 2); 
             
             dummy.updateMatrix();
             meshRef.current.setMatrixAt(i, dummy.matrix);
             
             // High contrast emissive-style colors
             const color = p.team === 'Enemy' ? new THREE.Color(10, 0, 0) : new THREE.Color(0, 5, 20); 
             meshRef.current.setColorAt(i, color);
        }
        
        meshRef.current.count = projectiles.length;
        meshRef.current.instanceMatrix.needsUpdate = true;
        if (meshRef.current.instanceColor) meshRef.current.instanceColor.needsUpdate = true;
    });

    return (
        <instancedMesh ref={meshRef} args={[undefined, undefined, 200]} frustumCulled={false}>
            <sphereGeometry args={[0.05, 8, 8]} />
            <meshBasicMaterial toneMapped={false} />
        </instancedMesh>
    );
});
ProjectileManager.displayName = 'ProjectileManager';
