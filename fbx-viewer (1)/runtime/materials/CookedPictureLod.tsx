import React, { useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { PICTURE_SIZE, bakedSizeLog2, cookable, steppedPictureSize } from './materialCooking';
import { materialCookPlanner } from './materialCookingSetup';
import { materialLibrary } from './materialLibrary';

/**
 * COOKED PICTURES FOLLOW LEVEL OF DETAIL
 *
 * Every so often, each material cooking its pictures (materialCooking.ts) is measured by the largest it shows on the
 * screen among the meshes wearing it, and its pictures' size steps to suit (steppedPictureSize: up at once, down only
 * well below, so it does not flicker), from 128 pixels to its baked size. A new size cooks a new set; the old one is let
 * go of once nothing wears it.
 */

/** The smallest cooked pictures, as a power of two. */
const SMALLEST_LOG2 = 7;

const sphere = new THREE.Sphere();
const scale = new THREE.Vector3();

/** The pixels across the screen a mesh's bounds take, from this camera. */
const shownPixels = (mesh: THREE.Mesh, camera: THREE.Camera, height: number): number => {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    if (!geometry.boundingSphere) return 0;
    sphere.copy(geometry.boundingSphere).applyMatrix4(mesh.matrixWorld);
    mesh.getWorldScale(scale);
    const distance = Math.max(sphere.center.distanceTo(camera.position) - sphere.radius, 0.01);
    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
        const fov = THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov);
        return (sphere.radius / (distance * Math.tan(fov / 2))) * height;
    }
    const orthographic = camera as THREE.OrthographicCamera;
    return (sphere.radius * 2 / Math.max(1e-6, (orthographic.top - orthographic.bottom) / orthographic.zoom)) * height;
};

export const CookedPictureLod: React.FC<{ every?: number }> = ({ every = 30 }) => {
    const scene = useThree(state => state.scene);
    const frames = useRef(0);
    useFrame(({ camera, size }) => {
        if (++frames.current % every !== 0 || !materialCookPlanner()) return;
        const largest = new Map<THREE.Material, number>();
        scene.traverseVisible((object) => {
            const mesh = object as THREE.Mesh;
            if (!mesh.isMesh) return;
            for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
                const binding = material ? materialLibrary.bindingOf(material) : undefined;
                const asset = binding ? materialLibrary.get(binding.materialId) : undefined;
                if (!asset || !cookable(asset)) continue;
                // The pictures repeat across the bounds about once: twice the bounds' pixels keeps them sharp.
                largest.set(material, Math.max(largest.get(material) ?? 0, shownPixels(mesh, camera, size.height) * 2));
            }
        });
        for (const [material, pixels] of largest) {
            const binding = materialLibrary.bindingOf(material);
            const asset = binding ? materialLibrary.get(binding.materialId) : undefined;
            if (!binding || !asset) continue;
            const current = binding.parameters?.[PICTURE_SIZE];
            const next = steppedPictureSize(typeof current === 'number' ? current : undefined, pixels, SMALLEST_LOG2, bakedSizeLog2(asset));
            if (next !== current) materialLibrary.assign(material, binding.materialId, binding.flipY, { ...(binding.parameters ?? {}), [PICTURE_SIZE]: next });
        }
    });
    return null;
};
