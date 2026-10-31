import * as THREE from 'three';
import { EffectComposer, Pass, RenderPass } from 'postprocessing';
import { DepthCopy } from '../keptDepth';
import { FullscreenPass } from '../postEffects';
import { setTextureMipBias } from './mipBias';
import { OUTPUT_FRAGMENT, RESOLVE_FRAGMENT } from './temporalShaders';
import {
    cameraStillnessFor, clampRenderScale, contrastFadeFor, isCameraCut, mipBiasFor, renderSizeOf, temporalJitter,
} from './temporalSettings';
import { VelocityBuffer } from './velocityBuffer';

/**
 * TEMPORAL STAGE
 *
 * Draws the lit scene at the render scale, each frame from a slightly different spot inside the pixel, and
 * gathers those frames into a history at the display's size. What follows (bloom, exposure, tone mapping and
 * the rest) runs on that steady picture, as if the scene had been drawn at full size without aliasing.
 *
 * The scene's own chain lives in a composer of its own: scene, a capture of what only holds just after the
 * scene (its depth, and what moved), the screen effects that belong to the lit surface (bounced light,
 * reflections, haze, occlusion), then the resolve. Those all see the jittered projection, so their depth and
 * surface buffers line up with the picture. The stage's output pass is the first pass of the display-sized
 * composer, and hands it the resolved colour and the depth.
 */

/** A new frame's least share of a pixel once it has settled, at the nearest sample: at rest, and in motion. */
const BLEND_FLOOR = new THREE.Vector2(0.05, 0.12);
/** How far history may stray from the colours around it, in standard deviations: at rest, and in motion. */
const CLIP_SPREAD = new THREE.Vector2(1.5, 1);

/** The gathered picture and what is kept beside it; see temporalShaders. */
const historyTarget = (): THREE.WebGLRenderTarget => {
    const target = new THREE.WebGLRenderTarget(1, 1, {
        count: 2, type: THREE.HalfFloatType, format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false,
    });
    target.textures[1].format = THREE.RGFormat;
    return target;
};

/** Right after the scene: the later passes draw into the buffer that owns the depth, which clears it. */
class CapturePass extends Pass {
    constructor(private readonly stage: TemporalStage) {
        super('TemporalCapturePass');
        this.needsDepthTexture = true;
        this.needsSwap = false;
    }

    override setDepthTexture(depthTexture: THREE.Texture): void {
        this.stage.setDepth(depthTexture as THREE.DepthTexture);
    }

    override render(renderer: THREE.WebGLRenderer): void {
        this.stage.capture(renderer);
    }
}

/** The last pass of the scene's chain: gathers its picture into history. */
class ResolvePass extends Pass {
    constructor(private readonly stage: TemporalStage) {
        super('TemporalResolvePass');
        this.needsSwap = false;
    }

    override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget): void {
        this.stage.resolve(renderer, inputBuffer);
    }
}

const _drawingBuffer = new THREE.Vector2();

/** Stands where a composer's scene pass would: draws the scene's chain and gives its result to what follows. */
export class TemporalOutputPass extends Pass {
    constructor(private readonly stage: TemporalStage) {
        super('TemporalOutputPass');
        this.needsSwap = false;
    }

    override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget, _outputBuffer: THREE.WebGLRenderTarget, deltaTime?: number): void {
        const target = this.renderToScreen ? null : inputBuffer;
        // Sized from what it draws into, not from what it is told: a composer tells its passes the drawing
        // buffer's size, which after a change of pixel ratio need not be the size of its own buffers.
        if (target) {
            this.stage.setDisplaySize(target.width, target.height);
        } else {
            renderer.getDrawingBufferSize(_drawingBuffer);
            this.stage.setDisplaySize(_drawingBuffer.x, _drawingBuffer.y);
        }
        this.stage.renderScene(renderer, deltaTime ?? 0);
        this.stage.present(renderer, target);
    }
}

export class TemporalStage {
    readonly id = THREE.MathUtils.generateUUID();
    readonly output: TemporalOutputPass;
    private readonly composer: EffectComposer;
    private readonly velocity = new VelocityBuffer();
    private readonly resolver: FullscreenPass;
    private readonly presenter: FullscreenPass;
    private readonly depthCopy = new DepthCopy();
    private history: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
    private chain: Pass[] = [];

    private scale = 1;
    private displayWidth = 1;
    private displayHeight = 1;
    private inputWidth = 1;
    private inputHeight = 1;
    private frame = 0;
    private hasHistory = false;
    private carryOn = false;

    private readonly jitter = new THREE.Vector2();
    private readonly cleanProjection = new THREE.Matrix4();
    private readonly cleanInverseProjection = new THREE.Matrix4();
    private readonly cleanViewProjection = new THREE.Matrix4();
    private readonly previousViewProjection = new THREE.Matrix4();
    private readonly reprojection = new THREE.Matrix4();
    private readonly lastPosition = new THREE.Vector3();
    private readonly lastFacing = new THREE.Vector3();
    private readonly position = new THREE.Vector3();
    private readonly facing = new THREE.Vector3();

    constructor(
        renderer: THREE.WebGLRenderer,
        private readonly scene: THREE.Scene,
        private readonly camera: THREE.Camera,
    ) {
        // Making a composer turns the renderer's auto clear off, which is the display composer's to decide.
        const autoClear = renderer.autoClear;
        this.composer = new EffectComposer(renderer, { depthBuffer: true, stencilBuffer: false, multisampling: 0, frameBufferType: THREE.HalfFloatType });
        renderer.autoClear = autoClear;
        this.composer.autoRenderToScreen = false;

        this.history = [historyTarget(), historyTarget()];
        this.resolver = new FullscreenPass(RESOLVE_FRAGMENT, {
            current: { value: null },
            depthMap: { value: this.depthCopy.texture },
            objectVelocity: { value: this.velocity.texture },
            history: { value: null },
            companionHistory: { value: null },
            inputSize: { value: new THREE.Vector2(1, 1) },
            outputSize: { value: new THREE.Vector2(1, 1) },
            jitter: { value: this.jitter },
            reprojection: { value: this.reprojection },
            hasHistory: { value: 0 },
            blendFloor: { value: BLEND_FLOOR },
            clipSpread: { value: CLIP_SPREAD },
            contrastFade: { value: contrastFadeFor(1) },
            cameraStillness: { value: 1 },
            depthToDistance: { value: new THREE.Vector3(1, 1, 0) },
        }, THREE.GLSL3);
        this.presenter = new FullscreenPass(OUTPUT_FRAGMENT, {
            resolved: { value: null },
            depthMap: { value: this.depthCopy.texture },
            jitterUv: { value: new THREE.Vector2() },
            sharpness: { value: 0.25 },
        }, THREE.GLSL3);
        // Later effects read depth from the display composer's buffer, so the depth goes along with the colour.
        this.presenter.material.depthTest = true;
        this.presenter.material.depthWrite = true;
        this.presenter.material.depthFunc = THREE.AlwaysDepth;

        this.output = new TemporalOutputPass(this);
        // Last: adding the resolve hands it the depth texture, which the materials above receive.
        this.composer.addPass(new RenderPass(scene, camera));
        this.composer.addPass(new CapturePass(this));
        this.composer.addPass(new ResolvePass(this));
    }

    /** The screen effects that belong to the lit surface, in order, between the scene and the resolve. */
    setChain(passes: Pass[]): void {
        for (const pass of this.chain) this.composer.removePass(pass);
        this.chain = passes;
        passes.forEach((pass, index) => {
            this.composer.addPass(pass, index + 2);
            pass.setSize(this.inputWidth, this.inputHeight);
            pass.setDepthTexture(this.depthCopy.texture);
        });
    }

    setOptions(options: { renderScale: number; sharpness: number }): void {
        this.presenter.material.uniforms.sharpness.value = options.sharpness;
        const scale = clampRenderScale(options.renderScale);
        if (scale === this.scale) return;
        this.scale = scale;
        this.resolver.material.uniforms.contrastFade.value = contrastFadeFor(scale);
        this.applyInputSize();
    }

    setDisplaySize(width: number, height: number): void {
        if (width === this.displayWidth && height === this.displayHeight) return;
        this.displayWidth = Math.max(1, width);
        this.displayHeight = Math.max(1, height);
        for (const target of this.history) target.setSize(this.displayWidth, this.displayHeight);
        (this.resolver.material.uniforms.outputSize.value as THREE.Vector2).set(this.displayWidth, this.displayHeight);
        this.hasHistory = false;
        this.applyInputSize();
    }

    /** History belongs to the display, so a new render scale keeps it: the picture only softens for a moment. */
    private applyInputSize(): void {
        const { width, height } = renderSizeOf(this.displayWidth, this.displayHeight, this.scale);
        if (width === this.inputWidth && height === this.inputHeight) return;
        this.inputWidth = width;
        this.inputHeight = height;
        this.composer.inputBuffer.setSize(width, height);
        this.composer.outputBuffer.setSize(width, height);
        this.velocity.setSize(width, height);
        this.depthCopy.setSize(width, height);
        for (const pass of this.composer.passes) pass.setSize(width, height);
        (this.resolver.material.uniforms.inputSize.value as THREE.Vector2).set(width, height);
    }

    setDepth(depth: THREE.DepthTexture): void {
        this.velocity.setDepth(depth);
        this.depthCopy.setSource(depth);
    }

    /** Runs the scene's chain with the frame's jitter in the camera, and leaves the camera as it found it. */
    renderScene(_renderer: THREE.WebGLRenderer, deltaTime: number): void {
        const camera = this.camera as THREE.PerspectiveCamera;
        temporalJitter(this.frame, this.scale, this.jitter);
        this.frame += 1;
        this.cleanProjection.copy(camera.projectionMatrix);
        this.cleanInverseProjection.copy(camera.projectionMatrixInverse);
        const offsetX = (2 * this.jitter.x) / this.inputWidth;
        const offsetY = (2 * this.jitter.y) / this.inputHeight;
        const e = camera.projectionMatrix.elements;
        if ((this.camera as THREE.OrthographicCamera).isOrthographicCamera) {
            e[12] += offsetX;
            e[13] += offsetY;
        } else {
            e[8] -= offsetX;
            e[9] -= offsetY;
        }
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        setTextureMipBias(mipBiasFor(this.scale));
        try {
            this.composer.render(deltaTime);
        } finally {
            setTextureMipBias(0);
            camera.projectionMatrix.copy(this.cleanProjection);
            camera.projectionMatrixInverse.copy(this.cleanInverseProjection);
        }
    }

    /** Called right after the scene draws, with the camera still jittered. */
    capture(renderer: THREE.WebGLRenderer): void {
        const camera = this.camera;
        camera.getWorldPosition(this.position);
        camera.getWorldDirection(this.facing);
        const moved = this.position.distanceTo(this.lastPosition);
        const cut = this.hasHistory && isCameraCut(moved, this.facing.dot(this.lastFacing));
        this.resolver.material.uniforms.cameraStillness.value = this.hasHistory ? cameraStillnessFor(moved) : 1;
        this.carryOn = this.hasHistory && !cut;
        this.cleanViewProjection.multiplyMatrices(this.cleanProjection, camera.matrixWorldInverse);
        // No past to measure from: the first frame after a cut has no motion.
        if (!this.carryOn) this.previousViewProjection.copy(this.cleanViewProjection);
        this.reprojection.copy(this.cleanViewProjection).invert().premultiply(this.previousViewProjection);

        this.velocity.render(renderer, this.scene, camera, this.cleanViewProjection, this.previousViewProjection);
        this.depthCopy.render(renderer);
    }

    /** Called from the end of the scene's chain. */
    resolve(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget): void {
        const [read, write] = this.history;
        const u = this.resolver.material.uniforms;
        u.current.value = inputBuffer.texture;
        u.history.value = read.textures[0];
        u.companionHistory.value = read.textures[1];
        u.hasHistory.value = this.carryOn ? 1 : 0;
        const e = this.cleanProjection.elements;
        // A perspective view's distance from depth; an orthographic view's depth says nothing the test can use.
        (u.depthToDistance.value as THREE.Vector3).set(e[10], e[14], e[15] === 0 ? 1 : 0);
        this.resolver.render(renderer, write);
        this.history = [write, read];

        this.previousViewProjection.copy(this.cleanViewProjection);
        this.lastPosition.copy(this.position);
        this.lastFacing.copy(this.facing);
        this.hasHistory = true;
    }

    /** Writes the resolved picture and the depth into the display composer's buffer. */
    present(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
        const u = this.presenter.material.uniforms;
        u.resolved.value = this.history[0].textures[0];
        (u.jitterUv.value as THREE.Vector2).set(this.jitter.x / this.inputWidth, this.jitter.y / this.inputHeight);
        this.presenter.render(renderer, target as THREE.WebGLRenderTarget);
    }

    dispose(): void {
        this.composer.dispose();
        this.velocity.dispose();
        this.resolver.dispose();
        this.presenter.dispose();
        this.depthCopy.dispose();
        for (const target of this.history) target.dispose();
    }
}
