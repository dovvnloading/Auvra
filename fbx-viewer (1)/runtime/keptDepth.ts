import * as THREE from 'three';
import { Pass } from 'postprocessing';
import { FullscreenPass } from './postEffects';

/**
 * KEPT DEPTH
 *
 * A composer's depth texture belongs to one of the two buffers it swaps between. The first pass that draws into
 * that buffer clears it, and until then a pass drawing there would be reading the texture it is writing to. So
 * only the first effects after the scene could trust it: with ambient occlusion on, everything later (depth of
 * field, light shafts, motion blur) was working from blank depth. The depth is copied straight after the
 * scene into a target nothing draws to, and every later pass reads that.
 */

const COPY_FRAGMENT = /* glsl */ `
precision highp float;
precision highp sampler2D;
layout( location = 0 ) out vec4 copied;
uniform sampler2D depthMap;
void main() {
    copied = vec4( texelFetch( depthMap, ivec2( gl_FragCoord.xy ), 0 ).r, 0.0, 0.0, 1.0 );
}`;

/** The copy is a float target, which a device must be able to draw into. */
export const canDrawFloat = (gl: unknown): boolean =>
    (gl as { extensions?: { has?: (name: string) => boolean } }).extensions?.has?.('EXT_color_buffer_float') !== false;

export class DepthCopy {
    private readonly target = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.FloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        depthBuffer: false, generateMipmaps: false,
    });
    private readonly copier = new FullscreenPass(COPY_FRAGMENT, { depthMap: { value: null } }, THREE.GLSL3);

    get texture(): THREE.Texture { return this.target.texture; }

    setSource(depth: THREE.Texture | null): void {
        this.copier.material.uniforms.depthMap.value = depth;
    }

    setSize(width: number, height: number): void {
        this.target.setSize(Math.max(1, width), Math.max(1, height));
    }

    render(renderer: THREE.WebGLRenderer): void {
        this.copier.render(renderer, this.target);
    }

    dispose(): void {
        this.target.dispose();
        this.copier.dispose();
    }
}

/** Keeps a composer's depth: sits right after what draws it, and the passes after it read `copy.texture`. */
export class KeepDepthPass extends Pass {
    readonly copy = new DepthCopy();

    constructor() {
        super('KeepDepthPass');
        this.needsDepthTexture = true;
        this.needsSwap = false;
    }

    override setDepthTexture(depthTexture: THREE.Texture): void {
        this.copy.setSource(depthTexture);
    }

    override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget): void {
        this.copy.setSize(inputBuffer.width, inputBuffer.height);
        this.copy.render(renderer);
    }

    override dispose(): void {
        this.copy.dispose();
    }
}
