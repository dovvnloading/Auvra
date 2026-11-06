import * as THREE from 'three';
import { captureMaterial } from './captureMaterial';
import { graphColourSource, graphRenderer } from './graphMaterial';

/**
 * BOUNCED LIGHT OFF GRAPH-SHADED MATERIALS
 *
 * Bounced light needs one colour for each surface it meets. A graph-shaded material's own colour and
 * map are not what it shows, so its colour comes from its graph:
 * - a constant base colour, or a texture times a constant, is read straight off the graph, the texture
 *   averaged as any other map is;
 * - a base colour the graph works out some other way is drawn once, flat over the graph's UV square,
 *   on the renderer that compiled the material, and averaged. It is drawn again only when what the
 *   graph works out may have changed. Until it is ready the material's own colour stands in.
 */

/** Pixels a side of the drawing a worked-out base colour is averaged from. */
const CAPTURE_SIZE = 16;

interface Capture {
    /** What the graph worked out when it was drawn (GraphColourSource 'worked'). */
    look: string;
    colour: [number, number, number] | null;
    scene: THREE.Scene;
    material: THREE.Material;
    ready: boolean;
    failed: boolean;
}

const captures = new WeakMap<THREE.Material, Capture>();
const targets = new WeakMap<THREE.WebGLRenderer, THREE.WebGLRenderTarget>();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const plane = new THREE.PlaneGeometry(2, 2);

const srgbToLinear = (value: number): number => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

const targetFor = (renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget => {
    let target = targets.get(renderer);
    if (!target) targets.set(renderer, target = new THREE.WebGLRenderTarget(CAPTURE_SIZE, CAPTURE_SIZE, { depthBuffer: false }));
    return target;
};

/** Draws a ready capture and averages it, in linear light. */
const drawCapture = (renderer: THREE.WebGLRenderer, capture: Capture): [number, number, number] => {
    const target = targetFor(renderer);
    const previous = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    renderer.autoClear = true;
    renderer.setRenderTarget(target);
    renderer.render(capture.scene, camera);
    const pixels = new Uint8Array(CAPTURE_SIZE * CAPTURE_SIZE * 4);
    renderer.readRenderTargetPixels(target, 0, 0, CAPTURE_SIZE, CAPTURE_SIZE, pixels);
    renderer.setRenderTarget(previous);
    renderer.autoClear = autoClear;
    const sum: [number, number, number] = [0, 0, 0];
    let shown = 0;
    for (let at = 0; at < pixels.length; at += 4) {
        if (pixels[at + 3] === 0) continue;
        // The capture writes base colour as a picture holds it.
        sum[0] += srgbToLinear(pixels[at] / 255);
        sum[1] += srgbToLinear(pixels[at + 1] / 255);
        sum[2] += srgbToLinear(pixels[at + 2] / 255);
        shown++;
    }
    return shown ? [sum[0] / shown, sum[1] / shown, sum[2] / shown] : [0.5, 0.5, 0.5];
};

const dropCapture = (capture: Capture): void => {
    capture.material.dispose();
    capture.scene.clear();
};

/** A worked-out base colour's average: drawn when its shader has compiled, again when the look changes; null until then. */
const workedColour = (material: THREE.Material, look: string): [number, number, number] | null => {
    const renderer = graphRenderer(material);
    if (!renderer) return captures.get(material)?.colour ?? null;
    let capture = captures.get(material);
    if (!capture || (capture.look !== look && (capture.ready || capture.failed))) {
        const previous = capture?.colour ?? null;
        if (capture) dropCapture(capture);
        const flat = captureMaterial(material, 'baseColor', 'uv');
        const scene = new THREE.Scene();
        const mesh = new THREE.Mesh(plane, flat);
        mesh.frustumCulled = false;
        scene.add(mesh);
        const made: Capture = { look, colour: previous, scene, material: flat, ready: false, failed: false };
        capture = made;
        captures.set(material, made);
        // Compiled for the target it is drawn into, without holding the frame up where the GPU allows; drawn on a later look.
        const previousTarget = renderer.getRenderTarget();
        renderer.setRenderTarget(targetFor(renderer));
        renderer.compileAsync(scene, camera).then(() => { made.ready = true; }, () => { made.failed = true; });
        renderer.setRenderTarget(previousTarget);
        return made.colour;
    }
    if (capture.ready && capture.look === look && capture.scene.children.length) {
        try {
            capture.colour = drawCapture(renderer, capture);
        } catch {
            capture.failed = true;
        }
        dropCapture(capture);
    }
    return capture.colour;
};

/**
 * The average colour a graph-shaded material shows, in linear light, for bounced light; null for a
 * material no graph shades, or while its colour is not known yet (the material's own then stands in).
 * `mean` averages a texture, as the ray scene does for any map.
 */
export const graphBounceColour = (material: THREE.Material, mean: (texture: THREE.Texture) => [number, number, number]): [number, number, number] | null => {
    const source = graphColourSource(material);
    if (!source) return null;
    if (source.kind === 'constant') return source.colour;
    if (source.kind === 'texture') {
        if (!source.texture) return null;
        const average = mean(source.texture);
        return [average[0] * source.tint[0], average[1] * source.tint[1], average[2] * source.tint[2]];
    }
    return workedColour(material, source.look);
};
