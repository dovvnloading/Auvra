
import { useEffect, useRef, useImperativeHandle, forwardRef, useMemo } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Hittable } from '../../types';
import { combat, destructibles, explosionFalloff, provideCombat } from '../../runtime/destructibles';
import { PLAYER_PHYSICS_ID, usePhysicsQueries } from '../../runtime/physics';

/** Push a round gives what it hits, N·s per point of damage. */
const IMPULSE_PER_DAMAGE = 0.25;
/** Damage that makes a full-sized impact effect. */
const FULL_IMPACT_DAMAGE = 40;

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

export const ProjectileManager = forwardRef<ProjectileManagerHandle, {}>((_props, ref) => {
    const meshRef = useRef<THREE.InstancedMesh>(null);
    const projectilesRef = useRef<ProjectileData[]>([]);
    const targetsRef = useRef<Hittable[]>([]);
    
    const dummy = useMemo(() => new THREE.Object3D(), []);
    const rayStart = useMemo(() => new THREE.Vector3(), []);
    const rayEnd = useMemo(() => new THREE.Vector3(), []);
    const rayDirection = useMemo(() => new THREE.Vector3(), []);
    const physics = usePhysicsQueries();

    // Explosions hurt every character in reach, the player included, less further out.
    useEffect(() => provideCombat({
        characterCapsules: () => targetsRef.current
            .filter(target => !target.isDead())
            .map(target => {
                const box = target.getHitbox();
                return { x: box.center.x, y: box.center.y, z: box.center.z, height: box.height, radius: box.radius };
            }),
        damageCharacters: (centre, radius, damage) => {
            let hit = 0;
            for (const target of [...targetsRef.current]) {
                if (target.isDead() || target.isHittable?.() === false) continue;
                const box = target.getHitbox();
                const y = Math.min(box.center.y + box.height, Math.max(box.center.y, centre.y));
                const dx = box.center.x - centre.x, dz = box.center.z - centre.z;
                const across = Math.max(0, Math.hypot(dx, dz) - box.radius);
                const distance = Math.hypot(across, y - centre.y);
                const share = explosionFalloff(distance, radius);
                if (share <= 0) continue;
                target.takeDamage(damage * share, new THREE.Vector3(box.center.x, y, box.center.z));
                hit++;
            }
            return hit;
        },
    }), []);
    

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
        const travel = rayStart.distanceTo(rayEnd);

        // The world first (walls, the ground, props and loose bodies; characters are tested below):
        // a character behind a wall is not hit.
        rayDirection.subVectors(rayEnd, rayStart);
        const wall = travel > 1e-6
            ? physics.raycast(rayStart, rayDirection, travel, { excludeKinematic: true, excludeObjectIds: p.team === 'Player' ? [PLAYER_PHYSICS_ID] : [] })
            : null;
        const wallAt = wall ? wall.distance / travel : Infinity;
        if (wall) rayEnd.copy(wall.point);

        for (const target of targetsRef.current) {
            if (target.team === p.team || target.isDead() || target.isHittable?.() === false) continue;

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
        if (!wall || wallAt > 1) return false;
        // It struck the world: the impact, a push for a loose body, damage for something breakable.
        const direction = rayDirection.clone().normalize();
        combat().impact(wall.surface ?? 'default', wall.point, wall.normal, p.damage / FULL_IMPACT_DAMAGE);
        if (wall.objectId && wall.objectId !== PLAYER_PHYSICS_ID) {
            physics.applyImpulse(wall.objectId, direction.clone().multiplyScalar(p.damage * IMPULSE_PER_DAMAGE));
            destructibles.get(wall.objectId)?.damage(p.damage, wall.point, direction);
        }
        return true;
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
            
            // Fallen out of the world.
            if (p.position.y < -500) projectiles.splice(i, 1);
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
