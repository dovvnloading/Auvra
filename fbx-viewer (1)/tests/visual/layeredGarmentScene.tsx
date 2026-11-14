import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { unzipSync } from 'three/addons/libs/fflate.module.js';
import type { LevelComponent, LevelObject } from '../../types';
import { cookComponentGarment, GarmentInstance, readGarmentSettings } from '../../runtime/components/garmentComponent';
import { readFabricOverrides } from '../../runtime/garments/fitting';
import { GARMENT_STEP } from '../../runtime/garments/solver';
import type { GarmentPanelRange } from '../../runtime/garments/pattern';
import exampleUrl from '../../../docs/examples/Auvra-Layered-Cloth.auvrapack?url';
import type { SceneSteps, VisualScene } from './scenes';

type ProjectSwatch = { position: LevelObject['position']; component: LevelComponent };
interface SwatchReport {
    initialPixels: number; finalPixels: number; motionPixels: number;
    initialOverlayPixels: number; finalOverlayPixels: number;
    layerProjections: number; upperY: number;
}
let setup: ProjectSwatch[] = [];
let active: { garment: GarmentInstance; sample: ProjectSwatch; overlay: GarmentPanelRange }[] = [];
export let layeredPixelReport: SwatchReport[] = [];

function Scene() {
    const camera = useThree(state => state.camera);
    const swatches = useMemo(() => setup.map(sample => {
        const settings = readGarmentSettings(sample.component);
        const cooked = cookComponentGarment(sample.component.props.pattern);
        const overlay = cooked.panelRanges.find(panel => panel.id === 'overlay');
        if (!overlay) throw new Error('Missing overlay in ' + sample.component.id);
        const garment = new GarmentInstance(cooked, settings.fabric, settings.selfCollision,
            readFabricOverrides(settings.fabric, sample.component.props.fabricProperties));
        garment.root.position.fromArray(sample.position);
        garment.advance(0, settings, sample.component.id);
        return { garment, sample, overlay };
    }), []);
    useEffect(() => {
        camera.lookAt(0, .98, 0);
        camera.updateMatrixWorld();
        active = swatches;
        return () => { active = []; for (const s of swatches) s.garment.dispose(); };
    }, [camera, swatches]);
    return <>
        <color attach="background" args={['#11171a']} />
        <ambientLight intensity={1.2} /><directionalLight position={[2, 4, 3]} intensity={2} />
        {swatches.map(s => <primitive key={s.sample.component.id} object={s.garment.root} />)}
    </>;
}

async function prepare() {
    const response = await fetch(exampleUrl);
    if (!response.ok) throw new Error('Layered garment example could not be loaded');
    const bytes = new Uint8Array(await response.arrayBuffer());
    const file = unzipSync(bytes, { filter: e => e.name === 'Project/objects.json' });
    const objects = JSON.parse(new TextDecoder().decode(file['Project/objects.json'])).documents as LevelObject[];
    setup = ['ranked-swatch', 'freefall-control'].map(id => {
        const obj = objects.find(o => o.id === id);
        const component = obj?.components?.find(c => c.enabled && c.type === 'garment');
        if (!obj || !component) throw new Error('Missing garment study ' + id);
        return { component, position: obj.position };
    });
    layeredPixelReport = [];
}

async function check(steps: SceneSteps) {
    await steps.until(() => active.length === 2);
    const { gl, scene, camera } = steps.state();
    const canvas = document.createElement('canvas');
    canvas.width = gl.domElement.width; canvas.height = gl.domElement.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    async function pixels() {
        await steps.frames(2);
        gl.render(scene, camera);
        ctx.drawImage(gl.domElement, 0, 0);
        return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    }
    async function overlayPixels() {
        const ranges = active.map(({ garment }) => ({ ...garment.mesh.geometry.drawRange }));
        try {
            for (const { garment, overlay } of active) garment.mesh.geometry.setDrawRange(overlay.indexStart, overlay.indexCount);
            return await pixels();
        } finally {
            active.forEach(({ garment }, i) => garment.mesh.geometry.setDrawRange(ranges[i].start, ranges[i].count));
        }
    }
    const wasVisible = active.map(({ garment }) => garment.root.visible);
    let background: Uint8ClampedArray;
    try {
        for (const { garment } of active) garment.root.visible = false;
        background = await pixels();
    } finally {
        active.forEach(({ garment }, i) => { garment.root.visible = wasVisible[i]; });
    }
    const initial = await pixels();
    const initialOverlay = await overlayPixels();
    const corrections = [0, 0];
    for (const [index, s] of active.entries()) {
        const settings = readGarmentSettings(s.sample.component);
        for (let tick = 0; tick < 120; tick++) {
            s.garment.advance(GARMENT_STEP, settings, s.sample.component.id);
            corrections[index] += s.garment.simulation.selfContactStats?.layerProjections ?? 0;
        }
    }
    const final = await pixels();
    const finalOverlay = await overlayPixels();
    const [before, after, overlayBefore, overlayAfter] = [initial, final, initialOverlay, finalOverlay].map(image => {
        const mask = new Uint8Array(canvas.width * canvas.height);
        for (let i = 0; i < mask.length; i++) {
            const k = 4*i;
            mask[i] = Number(Math.max(Math.abs(image[k] - background[k]), Math.abs(image[k+1] - background[k+1]),
                Math.abs(image[k+2] - background[k+2])) > 20);
        }
        return mask;
    });
    for (const [index, s] of active.entries()) {
        let initialPixels = 0, finalPixels = 0, motionPixels = 0;
        let initialOverlayPixels = 0, finalOverlayPixels = 0;
        for (let i = 0; i < before.length; i++) {
            if (Number(i % canvas.width >= canvas.width / 2) !== index) continue;
            initialPixels += before[i]; finalPixels += after[i];
            motionPixels += Number(before[i] !== after[i]);
            initialOverlayPixels += overlayBefore[i];
            finalOverlayPixels += overlayAfter[i];
        }
        const report = { initialPixels, finalPixels, motionPixels, initialOverlayPixels, finalOverlayPixels,
            layerProjections: corrections[index], upperY: s.garment.simulation.positions[3*s.overlay.vertexStart+1] };
        const ranked = index === 0;
        // Both overlays start inside the camera. Only the supported one remains after a second.
        const overlayVisibleAsExpected = initialOverlayPixels >= 128 && (ranked ? finalOverlayPixels >= 128 : finalOverlayPixels <= 4);
        if (!overlayVisibleAsExpected || Math.min(initialPixels, finalPixels) < 128 || motionPixels < 12 ||
            (ranked ? corrections[index] <= 0 || report.upperY < .8 : corrections[index] !== 0 || report.upperY > -1))
            throw new Error('Layer study ' + index + ' failed: ' + JSON.stringify(report));
        layeredPixelReport.push(report);
    }
}

export const layeredGarmentScene: VisualScene = {
    camera: { position: [0, 1.83, 1.52], fov: 33, near: .05, far: 30 }, Scene, settle: check,
    prepare,
};
