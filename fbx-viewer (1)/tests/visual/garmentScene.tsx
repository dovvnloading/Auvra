import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GarmentInstance, readGarmentSettings } from '../../runtime/components/garmentComponent';
import { bakeFitting } from '../../runtime/garments/bake';
import { decodeGarmentCache, sampleGarmentCache } from '../../runtime/garments/cache';
import { cookGarment, createSleevelessTop } from '../../runtime/garments/pattern';
import type { SceneSteps, VisualScene } from './scenes';

const settings = readGarmentSettings({ id: 'top', type: 'garment', enabled: true,
    props: { animateTorso: true, wind: 0, showTorso: false, color: '#f74445' } });
const input = { pattern: createSleevelessTop(), fabric: 'cotton' as const, animateTorso: true, selfCollision: false };
let active: GarmentInstance | null = null;
interface PixelReport { initialPixels: number; livePixels: number; playbackPixels: number; motionPixels: number; silhouetteIoU: number }
export let garmentPixelReport: PixelReport | null = null;

function Scene() {
    const camera = useThree(s => s.camera);
    const live = useMemo(() => new GarmentInstance(cookGarment(input.pattern), input.fabric), []);
    useEffect(() => {
        camera.lookAt(0, 1.30, 0);
        camera.updateMatrixWorld();
        live.advance(0, settings, 'top');
        active = live;
        return () => { active = null; live.dispose(); };
    }, [live, camera]);
    return <>
        <color attach="background" args={['#080808']} />
        <ambientLight intensity={1.3} />
        <directionalLight position={[2, 4, 3]} intensity={2.5} />
        <primitive object={live.root} />
    </>;
}

async function verify(steps: SceneSteps) {
    await steps.until(() => active !== null);
    const live = active!, { gl, scene, camera } = steps.state();
    const canvas = document.createElement('canvas');
    canvas.width = gl.domElement.width;
    canvas.height = gl.domElement.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const pixels = async () => {
        await steps.frames(4);
        // WebGPU presents this canvas only for the current task. Capture in the draw's task.
        gl.render(scene, camera);
        ctx.drawImage(gl.domElement, 0, 0);
        return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const cook = cookGarment(input.pattern);
    const cached = new GarmentInstance(cook, input.fabric);
    const targetFrame = 15, fps = 30, time = targetFrame / fps;
    try {
        live.root.visible = false;
        const background = await pixels();
        live.root.visible = true;
        const initial = await pixels();
        for (let i = 0; i < targetFrame; i++) live.advance(1 / fps, settings, 'top');
        const fitted = await pixels();

        const cache = decodeGarmentCache(bakeFitting(input, 1, () => {}), cook.positions.length / 3);
        const positions = new Float32Array(cook.positions.length), center: [number, number, number] = [0, 0, 0];
        sampleGarmentCache(cache, time, positions, center);
        cached.presentCachedPose(positions, new THREE.Vector3(...center), settings);
        live.root.visible = false;
        scene.add(cached.root);
        const replay = await pixels();
        let initialPixels = 0, livePixels = 0, playbackPixels = 0, motionPixels = 0, intersection = 0, union = 0;
        for (let i = 0; i < background.length; i += 4) {
            const foreground = (image: Uint8ClampedArray) => Math.max(
                Math.abs(image[i] - background[i]), Math.abs(image[i + 1] - background[i + 1]), Math.abs(image[i + 2] - background[i + 2])) > 24;
            const a = foreground(initial), b = foreground(fitted), c = foreground(replay);
            if (a) initialPixels++;
            if (b) livePixels++;
            if (c) playbackPixels++;
            if (a !== b) motionPixels++;
            if (b || c) union++;
            if (b && c) intersection++;
        }
        const silhouetteIoU = intersection / Math.max(1, union);
        const report = { initialPixels, livePixels, playbackPixels, motionPixels, silhouetteIoU };
        const minVisible = canvas.width * canvas.height * .005;
        if (Math.min(initialPixels, livePixels, playbackPixels) < minVisible || motionPixels < Math.max(20, livePixels * .02) || silhouetteIoU < .97)
            throw new Error('Garment pixel verification failed: ' + JSON.stringify(report));
        garmentPixelReport = report;
    } finally {
        scene.remove(cached.root);
        cached.dispose();
        live.root.visible = true;
    }
}

export const garmentScene: VisualScene = {
    camera: { position: [.55, 1.48, 1.13], fov: 35, near: .05, far: 20 }, Scene, settle: verify,
};
