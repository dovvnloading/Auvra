import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { captureLocalEnvironment } from '../Scene/localEnvironmentCapture';
import { materialGraphFeatures, type MaterialGraph } from '../../runtime/materials/materialGraph';

/**
 * Lighting for the material preview. Glass, coats and sheen read by what they reflect and what is seen
 * through them, so a few surroundings are offered, all made here with no images to load:
 * - studio: the editor's soft panels (localEnvironmentCapture), as before;
 * - room: a bright interior with windows and lamps;
 * - outdoor: open sky overhead, a pale horizon, a warm sun and the ground below;
 * - night: the editor's cool, dim night panels.
 * Shown behind the shape, the room and the outdoors show themselves. The panel rigs would show a few
 * lights in the dark, and glass would show that darkness as black, so they stand in front of a lit
 * backdrop instead, like a photo studio's paper.
 */

export type PreviewLighting = 'studio' | 'room' | 'outdoor' | 'night';

export const PREVIEW_LIGHTINGS: ReadonlyArray<{ value: PreviewLighting; label: string }> = [
    { value: 'studio', label: 'Studio' },
    { value: 'room', label: 'Room' },
    { value: 'outdoor', label: 'Outdoor' },
    { value: 'night', label: 'Night' },
];

/** Whether a graph's material is see-through (it transmits light), so its preview needs something behind it. */
export const previewSeesThrough = (graph: MaterialGraph): boolean => materialGraphFeatures(graph).includes('transmission');

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

/** sRGB colours of a backdrop, from below up: the ground, the horizon, overhead. */
const BACKDROPS: Partial<Record<PreviewLighting, readonly [string, string, string]>> = {
    studio: ['#8a8f97', '#b9bdc4', '#dcdfe3'],
    night: ['#0b0f17', '#1d2738', '#2f4064'],
};

/** Rows of a backdrop, from straight down to straight up. */
const BACKDROP_ROWS = 64;

const bytesOf = (hex: string): [number, number, number] => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];

/**
 * What stands behind the shape under a lighting whose own surroundings are too dark to show (studio and
 * night): a soft gradient all round, lighter overhead, darker below. Null where the surroundings show
 * themselves. The texture belongs to the caller.
 */
export const previewBackdrop = (lighting: PreviewLighting): THREE.DataTexture | null => {
    const colours = BACKDROPS[lighting];
    if (!colours) return null;
    const [below, horizon, above] = colours.map(bytesOf);
    const data = new Uint8Array(2 * BACKDROP_ROWS * 4);
    for (let row = 0; row < BACKDROP_ROWS; row++) {
        // -1 straight down to 1 straight up, as an all-round picture lays its rows.
        const up = ((row + 0.5) / BACKDROP_ROWS) * 2 - 1;
        const [to, amount] = up >= 0 ? [above, Math.sqrt(up)] : [below, Math.min(1, -up * 4)];
        for (let column = 0; column < 2; column++) {
            const at = (row * 2 + column) * 4;
            for (let channel = 0; channel < 3; channel++) data[at + channel] = Math.round(horizon[channel] + (to[channel] - horizon[channel]) * amount);
            data[at + 3] = 255;
        }
    }
    const texture = new THREE.DataTexture(data, 2, BACKDROP_ROWS, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
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
