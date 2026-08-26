
import { useRef, useMemo, useCallback } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';

export const useDamageFlash = (modelObject: THREE.Object3D) => {
    const flashTime = useRef(0);
    const originalMaterials = useRef<Map<string, THREE.Material>>(new Map());
    const flashMaterial = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff }), []);

    const triggerFlash = useCallback(() => {
        flashTime.current = 0.15; // 150ms flash duration
    }, []);

    useFrame((_, delta) => {
        if (flashTime.current > 0) {
            flashTime.current -= delta;
            modelObject.traverse((child) => {
                if ((child as THREE.Mesh).isMesh) {
                    const mesh = child as THREE.Mesh;
                    // Backup original material if not already saved
                    if (!originalMaterials.current.has(mesh.uuid)) {
                        originalMaterials.current.set(mesh.uuid, mesh.material as THREE.Material);
                    }
                    mesh.material = flashMaterial;
                }
            });
        } else {
            // Restore materials if needed
            if (originalMaterials.current.size > 0) {
                modelObject.traverse((child) => {
                    if ((child as THREE.Mesh).isMesh) {
                        const mesh = child as THREE.Mesh;
                        if (originalMaterials.current.has(mesh.uuid)) {
                            mesh.material = originalMaterials.current.get(mesh.uuid)!;
                        }
                    }
                });
                originalMaterials.current.clear();
            }
        }
    });

    return { triggerFlash };
};
