import * as THREE from 'three';
import { paintViewTarget } from '../../texturing/paint/paintViewTarget';

/** The viewport mixes tone-mapped materials and raw diagnostic shaders on a multisampled target. */
export function verifyPaintViewTarget() {
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 1);
    const gl = renderer.getContext();
    const camera = new THREE.Camera();
    const scene = new THREE.Scene();
    const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 0.45, 0.7), toneMapped: true });
    const raw = new THREE.ShaderMaterial({
        vertexShader: 'void main(){gl_Position=vec4(position,1.0);}',
        fragmentShader: 'void main(){gl_FragColor=vec4(0.2,0.45,0.7,1.0);}', toneMapped: false,
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-0.86, -0.8, 0, 0.91, -0.7, 0, -0.04, 0.87, 0], 3));
    const mesh = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(geometry, material);
    mesh.frustumCulled = false;
    scene.add(mesh);
    const baselineTextures = renderer.info.memory.textures;
    let samples = 0;
    let edgePixels = 0;
    try {
        for (const size of [32, 61]) {
            renderer.setSize(size, size, false);
            const target = paintViewTarget(renderer, size, size);
            try {
                samples = target.samples;
                if (samples < 2) throw new Error('The preview fixture requires a multisample-capable adapter.');
                for (const surface of [material, raw]) {
                    mesh.material = surface;
                    const reference = new Uint8Array(4);
                    const middle = Math.floor(size / 2);
                    renderer.setRenderTarget(null);
                    renderer.render(scene, camera);
                    gl.readPixels(middle, middle, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, reference);
                    renderer.setRenderTarget(target);
                    renderer.render(scene, camera);
                    renderer.setRenderTarget(null);
                    const pixels = new Uint8Array(size * size * 4);
                    renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
                    const at = (middle * size + middle) * 4;
                    if (reference[0] < 30 || reference.some((value, c) => Math.abs(value - pixels[at + c]) > 2)) {
                        throw new Error('Paint preview changed screen colour: ' + pixels.slice(at, at + 4) + ' vs ' + reference);
                    }
                    if (surface === raw && [51, 115, 179].some((v, c) => Math.abs(reference[c] - v) > 1)) {
                        throw new Error('A raw Paint diagnostic was tone mapped.');
                    }
                    let partial = 0;
                    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 2 && pixels[i] < reference[0] - 2) partial++;
                    if (partial < 3) throw new Error('The sloping paint preview edge has no resolved multisample coverage.');
                    edgePixels += partial;
                }
            } finally {
                renderer.setRenderTarget(null);
                target.dispose();
            }
            if (renderer.info.memory.textures !== baselineTextures) throw new Error('A replaced paint preview target leaked its texture.');
        }
        return { samples, edgePixels };
    } finally {
        geometry.dispose();
        raw.dispose();
        material.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
    }
}
