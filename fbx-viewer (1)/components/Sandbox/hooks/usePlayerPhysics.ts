
import { useRef } from 'react';
import * as THREE from 'three';
import { PlayerInputState } from './usePlayerControls';
import { LevelObject } from '../../../types';

interface PhysicsConfig {
    ROTATION_SPEED: number;
    MOVE_SPEED_WALK: number;
    MOVE_SPEED_RUN: number;
    STAMINA_DRAIN: number;
    STAMINA_REGEN: number;
    MAX_STAMINA: number;
    EXHAUSTION_RECOVERY: number;
    COLLISION_RADIUS: number;
}

const DEFAULT_CONFIG: PhysicsConfig = {
    ROTATION_SPEED: 15.0, 
    MOVE_SPEED_WALK: 4.0,
    MOVE_SPEED_RUN: 7.5,
    STAMINA_DRAIN: 20,
    STAMINA_REGEN: 10,
    MAX_STAMINA: 100,
    EXHAUSTION_RECOVERY: 25,
    COLLISION_RADIUS: 0.5 // Player radius
};

// --- TERRAIN HEIGHT SAMPLER ---
const getTerrainHeight = (worldX: number, worldZ: number, terrain: LevelObject): number => {
    if (!terrain.terrainData || !terrain.terrainData.heights) return 0;
    
    const { position } = terrain;
    const { width, depth, resolution, heights } = terrain.terrainData;

    // Convert World Position to Local Terrain UV Space
    // Terrain is rotated -90 deg on X axis.
    // Local X aligns with World X.
    // Local Y (Plane Height, mapped to World -Z) aligns with World -Z.
    // Therefore: Local Y = Terrain.Z - World.Z
    
    const lx = worldX - position[0];
    const ly = position[2] - worldZ; 

    const halfW = width / 2;
    const halfD = depth / 2;

    // 1. Bounds Check
    if (lx < -halfW || lx > halfW || ly < -halfD || ly > halfD) {
        return 0; // Off terrain, fallback to zero level
    }

    // 2. Normalize to 0..1 (UV Space)
    // PlaneGeometry local coords range from -half to +half
    const u = (lx + halfW) / width;
    const v = (ly + halfD) / depth; 

    // 3. Map to Grid Coordinates
    // Rows start at Top (+D/2 which corresponds to v=1).
    // Note: Standard PlaneGeometry builds vertices top-to-bottom.
    // row 0 is v=1 (Top/Back in Local). row max is v=0 (Bottom/Front).
    const gridX = u * resolution;
    const gridY = (1 - v) * resolution;
    
    const c0 = Math.floor(gridX);
    const r0 = Math.floor(gridY);
    const c1 = Math.min(c0 + 1, resolution);
    const r1 = Math.min(r0 + 1, resolution);
    
    // Clamp indices to be safe
    if (c0 < 0 || c0 > resolution || r0 < 0 || r0 > resolution) return 0;

    const tx = gridX - c0;
    const ty = gridY - r0;
    
    const stride = resolution + 1;
    
    // 4. Sample Heights (Bilinear Interpolation)
    const h00 = heights[r0 * stride + c0] || 0;
    const h10 = heights[r0 * stride + c1] || 0;
    const h01 = heights[r1 * stride + c0] || 0;
    const h11 = heights[r1 * stride + c1] || 0;
    
    // Interpolate X
    const h0 = h00 * (1 - tx) + h10 * tx;
    const h1 = h01 * (1 - tx) + h11 * tx;
    
    // Interpolate Y
    const height = h0 * (1 - ty) + h1 * ty;
    
    // Add terrain world Y position
    return height + position[1];
};

export const usePlayerPhysics = (
    modelObject: THREE.Object3D, 
    camera: THREE.Camera,
    onStaminaChange?: (val: number) => void,
    obstacles: LevelObject[] = [] // New: Level collision data
) => {
    const stamina = useRef(DEFAULT_CONFIG.MAX_STAMINA);
    const isExhausted = useRef(false); 

    // Cache the terrain object reference to avoid searching every frame
    const activeTerrain = useRef<LevelObject | null>(null);
    
    // Update terrain ref occasionally or when obstacles change
    if (!activeTerrain.current || !obstacles.includes(activeTerrain.current)) {
        activeTerrain.current = obstacles.find(o => o.type === 'terrain') || null;
    }

    const updatePhysics = (input: PlayerInputState, delta: number) => {
        const { 
            ROTATION_SPEED, MOVE_SPEED_WALK, MOVE_SPEED_RUN, 
            STAMINA_DRAIN, STAMINA_REGEN, MAX_STAMINA, EXHAUSTION_RECOVERY,
            COLLISION_RADIUS
        } = DEFAULT_CONFIG;

        // --- 1. Camera Basis ---
        const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        camForward.y = 0;
        camForward.normalize();

        const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        camRight.y = 0;
        camRight.normalize();

        // --- 2. Calculate World Movement Vector ---
        const worldMoveVec = new THREE.Vector3();
        if (input.moveX !== 0 || input.moveY !== 0) {
            worldMoveVec.addScaledVector(camForward, input.moveY);
            worldMoveVec.addScaledVector(camRight, input.moveX);
            worldMoveVec.normalize();
        }
        const isMoving = worldMoveVec.lengthSq() > 0.001;

        // --- 3. Handle Rotation ---
        let targetRotation = modelObject.rotation.y;

        if (input.isAiming) {
            targetRotation = Math.atan2(camForward.x, camForward.z);
        } else if (isMoving) {
            targetRotation = Math.atan2(worldMoveVec.x, worldMoveVec.z);
        }

        let rotDiff = targetRotation - modelObject.rotation.y;
        while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
        while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
        
        const effectiveRotSpeed = input.isAiming ? ROTATION_SPEED * 2.0 : ROTATION_SPEED;
        modelObject.rotation.y += rotDiff * effectiveRotSpeed * delta;

        // --- 4. Stamina & Hysteresis Logic ---
        let effectiveSprint = false;

        if (isExhausted.current) {
            if (stamina.current > EXHAUSTION_RECOVERY) {
                isExhausted.current = false;
            }
        }

        if (input.isSprinting && isMoving && !input.isAiming && !isExhausted.current) {
            effectiveSprint = true;
            stamina.current = Math.max(0, stamina.current - STAMINA_DRAIN * delta);
            if (stamina.current <= 0) {
                stamina.current = 0;
                isExhausted.current = true;
                effectiveSprint = false;
            }
        } else {
            stamina.current = Math.min(MAX_STAMINA, stamina.current + STAMINA_REGEN * delta);
        }

        if (onStaminaChange) onStaminaChange(stamina.current);

        // --- 5. Apply Movement & Collision ---
        let currentSpeed = effectiveSprint ? MOVE_SPEED_RUN : MOVE_SPEED_WALK;
        if (input.isAiming) currentSpeed *= 0.5;

        // Clone current pos to calculate next
        const nextPos = modelObject.position.clone();

        if (isMoving) {
            // Predict next position (XZ)
            const displacement = worldMoveVec.clone().multiplyScalar(currentSpeed * delta);
            nextPos.add(displacement);

            // Simple Circle-Circle Collision against Props
            // Iterate obstacles to push back
            obstacles.forEach(obj => {
                if (obj.type === 'foliage' || obj.type === 'terrain') return; 

                // Calculate object radius based on scale
                const objRadius = Math.max(obj.scale[0], obj.scale[2]) * 0.5;
                const minDist = COLLISION_RADIUS + objRadius;

                const dx = nextPos.x - obj.position[0];
                const dz = nextPos.z - obj.position[2];
                const distSq = dx*dx + dz*dz;

                if (distSq < minDist * minDist) {
                    const dist = Math.sqrt(distSq);
                    if (dist > 0.001) {
                        const pushX = dx / dist;
                        const pushZ = dz / dist;
                        const pushFactor = minDist - dist;
                        nextPos.x += pushX * pushFactor;
                        nextPos.z += pushZ * pushFactor;
                    }
                }
            });

            // Boundary Clamp (World Bounds +/- 100)
            nextPos.x = Math.max(-100, Math.min(100, nextPos.x));
            nextPos.z = Math.max(-100, Math.min(100, nextPos.z));
        }

        // --- 6. Terrain Ground Snapping ---
        // Always run this, even if not moving, to ensure we stay on ground if terrain changes 
        // or if we spawned in air.
        if (activeTerrain.current) {
            const groundY = getTerrainHeight(nextPos.x, nextPos.z, activeTerrain.current);
            // Instant snap for now. Smooth lerp could be added for polish.
            nextPos.y = groundY;
        } else {
            nextPos.y = 0; // Default floor
        }

        // Apply final position
        modelObject.position.copy(nextPos);

        // --- 7. Calculate Animation Inputs ---
        const charForward = new THREE.Vector3(0, 0, 1).applyQuaternion(modelObject.quaternion);
        const charRight = new THREE.Vector3(1, 0, 0).applyQuaternion(modelObject.quaternion);

        let localX = worldMoveVec.dot(charRight);
        let localY = worldMoveVec.dot(charForward);

        if (Math.abs(localX) < 0.05) localX = 0;
        if (Math.abs(localY) < 0.05) localY = 0;

        return {
            isMoving,
            effectiveSprint,
            localInputX: localX,
            localInputY: localY
        };
    };

    return { updatePhysics };
};
