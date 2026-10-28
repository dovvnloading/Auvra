import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { chooseLodLevel, lodPixelsPerUnit, meshLodChain, meshLodReady } from '../../utils/meshLod';

/** Whether meshes below draw their detail levels (the game's Mesh detail levels quality setting); on by default. */
export const MeshLodContext = createContext(true);

/** Detail levels are chosen again every this many frames. */
export const LOD_UPDATE_INTERVAL = 4;

const _camera = new THREE.Vector3();
const _centre = new THREE.Vector3();

/** True once the simplifier has loaded, so components can build their detail levels. */
export const useMeshLodReady = (): boolean => {
    const [ready, setReady] = useState(false);
    useEffect(() => {
        let live = true;
        void meshLodReady.then(() => { if (live) setReady(true); });
        return () => { live = false; };
    }, []);
    return ready;
};

/**
 * Keeps every mesh under `root` (skinned or not, attachments included; instanced meshes are left to
 * their own instancer) on the detail level its size on the screen calls for. Each mesh is given
 * back its full geometry when the hook stops.
 */
export const useMeshLod = (root: THREE.Object3D | null | undefined, requested = true): void => {
    const ready = useMeshLodReady();
    const allowed = useContext(MeshLodContext);
    const enabled = requested && allowed;
    // Each mesh's own geometry, the full level its chain is built from.
    const fullGeometry = useMemo(() => new Map<THREE.Mesh, THREE.BufferGeometry>(), []);
    const frame = useRef(0);

    useEffect(() => () => {
        fullGeometry.forEach((geometry, mesh) => { mesh.geometry = geometry; });
        fullGeometry.clear();
    }, [root, enabled, fullGeometry]);

    useFrame(({ camera, size }) => {
        if (!enabled || !ready || !root || frame.current++ % LOD_UPDATE_INTERVAL !== 0) return;
        const pixelsPerUnit = lodPixelsPerUnit(camera, size.height);
        camera.getWorldPosition(_camera);
        root.traverse((node) => {
            const mesh = node as THREE.Mesh;
            if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) return;
            let full = fullGeometry.get(mesh);
            if (!full) {
                full = mesh.geometry;
                fullGeometry.set(mesh, full);
            }
            const levels = meshLodChain(full);
            if (levels.length < 2) return;
            const base = levels[0].geometry;
            if (!base.boundingSphere) base.computeBoundingSphere();
            _centre.copy(base.boundingSphere!.center).applyMatrix4(mesh.matrixWorld);
            const level = chooseLodLevel(levels, mesh.matrixWorld.getMaxScaleOnAxis(), _centre.distanceTo(_camera), pixelsPerUnit);
            if (mesh.geometry !== levels[level].geometry) mesh.geometry = levels[level].geometry;
        });
    });
};
