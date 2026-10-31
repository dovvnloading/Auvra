import * as THREE from 'three';

/**
 * Deterministic editor lighting: three soft panels around the origin, captured into a small prefiltered map that
 * the caller owns and frees. It is prefiltered here rather than left to the renderer, because the renderer's own
 * conversion of a captured cube keeps its result in a private cache with no way to free it, and every view or
 * preview that mounted would leave one behind on the GPU.
 */

/** Side of each cube face, in texels: reflections of soft panels need no more. */
const CUBE_SIZE = 64;
const CAMERA_NEAR = 1;
const CAMERA_FAR = 1000;

export interface LightPanel {
    color: string;
    intensity: number;
    position: [number, number, number];
    scale: [number, number];
}

/** The panels of the day and night rigs. */
export const localLightPanels = (night: boolean): LightPanel[] => [
    { color: night ? '#5271a8' : '#fff4dc', intensity: night ? 0.6 : 1.4, position: [4, 6, 3], scale: [5, 5] },
    { color: night ? '#172a4d' : '#b9d7ff', intensity: 0.8, position: [-4, 2, 2], scale: [4, 3] },
    { color: night ? '#0b1630' : '#526b86', intensity: 0.35, position: [0, 1, -4], scale: [3, 3] },
];

const _clear = new THREE.Color();

/** Draws a rig and returns its prefiltered map, which belongs to the caller. Leaves the renderer as it found it. */
export const captureLocalEnvironment = (renderer: THREE.WebGLRenderer, night: boolean): THREE.WebGLRenderTarget => {
    const scene = new THREE.Scene();
    const geometry = new THREE.PlaneGeometry(1, 1);
    const materials = localLightPanels(night).map(panel => {
        const material = new THREE.MeshBasicMaterial({ toneMapped: false, side: THREE.DoubleSide });
        material.color.set(panel.color).multiplyScalar(panel.intensity);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(...panel.position);
        mesh.scale.set(panel.scale[0], panel.scale[1], 1);
        mesh.lookAt(0, 0, 0);
        scene.add(mesh);
        return material;
    });
    const cube = new THREE.WebGLCubeRenderTarget(CUBE_SIZE, { type: THREE.HalfFloatType });
    const camera = new THREE.CubeCamera(CAMERA_NEAR, CAMERA_FAR, cube);
    const pmrem = new THREE.PMREMGenerator(renderer);

    const autoClear = renderer.autoClear;
    const clearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(_clear);
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 1);
    camera.update(renderer, scene);
    renderer.setClearColor(_clear, clearAlpha);
    renderer.autoClear = autoClear;
    const prefiltered = pmrem.fromCubemap(cube.texture);

    pmrem.dispose();
    cube.dispose();
    geometry.dispose();
    for (const material of materials) material.dispose();
    return prefiltered;
};
