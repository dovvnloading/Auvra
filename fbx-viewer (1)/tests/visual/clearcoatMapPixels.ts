import * as THREE from 'three';
import type { RootState } from '@react-three/fiber';

/** Compare the same physical sphere and lighting on one renderer with only the coat source changed. */
export async function clearcoatMapPixels(state: RootState, settle: () => Promise<void>) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x080808);
    const camera = new THREE.PerspectiveCamera(40, state.gl.domElement.width / state.gl.domElement.height, 0.1, 20);
    camera.position.z = 3;
    const light = new THREE.DirectionalLight(0xffffff, 4);
    light.position.set(1, 1, 2);
    scene.add(light, new THREE.AmbientLight(0xffffff, 0.25));
    const material = new THREE.MeshPhysicalMaterial({
        color: 0x674330, metalness: 0, roughness: 0.85, clearcoatRoughness: 0.06,
    });
    const shape = new THREE.SphereGeometry(0.9, 48, 32);
    scene.add(new THREE.Mesh(shape, material));

    // G and B deliberately oppose R: sampling the wrong component interchanges the two controls.
    const zero = new THREE.DataTexture(new Uint8Array([0, 255, 255, 255]), 1, 1);
    const one = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
    zero.needsUpdate = one.needsUpdate = true;
    const scratch = document.createElement('canvas');
    scratch.width = state.gl.domElement.width;
    scratch.height = state.gl.domElement.height;
    const context = scratch.getContext('2d', { willReadFrequently: true })!;
    const sample = async (amount: number, map: THREE.Texture | null) => {
        material.clearcoat = amount;
        material.clearcoatMap = map;
        material.needsUpdate = true;
        for (let i = 0; i < 4; i++) {
            state.gl.render(scene, camera);
            await settle();
        }
        state.gl.render(scene, camera);
        // Read in the draw's task, while a WebGPU canvas still presents its current texture.
        context.drawImage(state.gl.domElement, 0, 0);
        const size = Math.floor(scratch.height / 3);
        return context.getImageData((scratch.width - size) >> 1, (scratch.height - size) >> 1, size, size).data;
    };
    try {
        const off = await sample(0, null);
        const on = await sample(1, null);
        const mappedOff = await sample(1, zero);
        const mappedOn = await sample(1, one);
        // Only include pixels where the two scalar controls have measurable lighting contrast.
        // This excludes background pixels and ensures that ignoring a map cannot yield a pass.
        let responsive = 0;
        let controlSignal = 0;
        let offError = 0;
        let onError = 0;
        for (let i = 0; i < off.length; i += 4) {
            let contrast = 0;
            for (let c = 0; c < 3; c++) contrast = Math.max(contrast, Math.abs(off[i + c] - on[i + c]));
            if (contrast < 8) continue;
            responsive++;
            for (let c = 0; c < 3; c++) {
                controlSignal += Math.abs(off[i + c] - on[i + c]);
                offError += Math.abs(mappedOff[i + c] - off[i + c]);
                onError += Math.abs(mappedOn[i + c] - on[i + c]);
            }
        }
        if (responsive < 32) throw new Error(`Clearcoat scalar controls differ at only ${responsive} pixels`);
        const samples = responsive * 3;
        const scalarDelta = controlSignal / samples;
        const zeroMapError = offError / samples;
        const oneMapError = onError / samples;
        // Each endpoint should be at least four times closer to its matched scalar than the two controls are.
        if (Math.max(zeroMapError, oneMapError) > scalarDelta / 4) {
            throw new Error(`Clearcoat map differs from scalar controls: zero ${zeroMapError}, one ${oneMapError}, signal ${scalarDelta}`);
        }
        return { status: 'verified', responsivePixels: responsive, scalarDelta, zeroMapError, oneMapError };
    } finally {
        shape.dispose();
        material.dispose();
        zero.dispose();
        one.dispose();
    }
}
