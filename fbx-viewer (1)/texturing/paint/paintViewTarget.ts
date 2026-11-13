import * as THREE from 'three';

/**
 * Where the view is drawn before it reaches the screen: several samples per pixel, smoothed as it is
 * read. Three r164 selects per-material tone mapping and sRGB output for screen and XR targets.
 * The viewport needs the screen path for lit materials and raw bytes for diagnostic shaders.
 * The paint preview browser fixture checks both paths against the default framebuffer.
 */
export const paintViewTarget = (renderer: THREE.WebGLRenderer, width: number, height: number): THREE.WebGLRenderTarget => {
    const samples = Math.min(width * height > 4_000_000 ? 2 : 4, renderer.capabilities.maxSamples);
    const target = new THREE.WebGLRenderTarget(width, height, {
        samples,
        type: THREE.UnsignedByteType,
        colorSpace: THREE.SRGBColorSpace,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
        depthBuffer: true,
    });
    target.texture.internalFormat = 'RGBA8';
    (target as THREE.WebGLRenderTarget & { isXRRenderTarget?: boolean }).isXRRenderTarget = true;
    return target;
};
