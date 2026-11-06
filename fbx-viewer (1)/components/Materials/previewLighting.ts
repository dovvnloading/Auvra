import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { captureLocalEnvironment } from '../Scene/localEnvironmentCapture';

/**
 * Lighting for the material preview. Glass, coats and sheen read by what they reflect and what is seen
 * through them, so a few surroundings are offered, all made here with no images to load:
 * - studio: the editor's soft panels (localEnvironmentCapture), as before;
 * - room: a bright interior with windows and lamps;
 * - outdoor: open sky overhead, a pale horizon, a warm sun and the ground below;
 * - night: the editor's cool, dim night panels.
 */

export type PreviewLighting = 'studio' | 'room' | 'outdoor' | 'night';

export const PREVIEW_LIGHTINGS: ReadonlyArray<{ value: PreviewLighting; label: string }> = [
    { value: 'studio', label: 'Studio' },
    { value: 'room', label: 'Room' },
    { value: 'outdoor', label: 'Outdoor' },
    { value: 'night', label: 'Night' },
];

/** Whether a stored choice is one of the lightings. */
export const isPreviewLighting = (value: unknown): value is PreviewLighting => PREVIEW_LIGHTINGS.some(option => option.value === value);

const SKY_FRAGMENT = /* glsl */ `
varying vec3 vDirection;
void main() {
    float up = normalize(vDirection).y;
    vec3 zenith = vec3(0.16, 0.34, 0.85);
    vec3 horizon = vec3(0.85, 0.9, 1.0);
    vec3 ground = vec3(0.2, 0.17, 0.13);
    vec3 colour = up >= 0.0 ? mix(horizon, zenith, sqrt(up)) : mix(horizon * 0.5, ground, min(-up * 6.0, 1.0));
    gl_FragColor = vec4(colour, 1.0);
}`;

const SKY_VERTEX = /* glsl */ `
varying vec3 vDirection;
void main() {
    vDirection = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** The outdoor surroundings: a sky dome and a sun far brighter than it, so metals and coats catch a highlight. */
const outdoorScene = (): THREE.Scene => {
    const scene = new THREE.Scene();
    const sky = new THREE.Mesh(
        new THREE.SphereGeometry(50, 32, 16),
        new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false, vertexShader: SKY_VERTEX, fragmentShader: SKY_FRAGMENT }),
    );
    const sun = new THREE.Mesh(new THREE.SphereGeometry(2.5, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.94, 0.82).multiplyScalar(40) }));
    sun.position.set(20, 30, 15);
    scene.add(sky, sun);
    return scene;
};

const disposeScene = (scene: THREE.Scene): void => {
    scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
    });
};

/** The chosen surroundings captured and prefiltered for materials of every roughness; the map belongs to the caller. */
export const captureLighting = (renderer: THREE.WebGLRenderer, lighting: PreviewLighting): THREE.WebGLRenderTarget => {
    if (lighting === 'studio' || lighting === 'night') return captureLocalEnvironment(renderer, lighting === 'night');
    const pmrem = new THREE.PMREMGenerator(renderer);
    const scene = lighting === 'room' ? new RoomEnvironment() : outdoorScene();
    const target = pmrem.fromScene(scene, lighting === 'room' ? 0.04 : 0);
    pmrem.dispose();
    disposeScene(scene);
    return target;
};
