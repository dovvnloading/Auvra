import * as THREE from "three";
import { rendererCoordinator } from "./registry";
import { diagnosticErrorType, frontendDiagnostics } from "../diagnostics/runtime";

export interface CaptureOptions { mime?: string; quality?: number; }

class CaptureRenderer {
  private renderer: THREE.WebGLRenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private onContextLost: ((event: Event) => void) | null = null;
  private onContextRestored: (() => void) | null = null;
  private busy = false;

  captureThumbnail(object: THREE.Object3D, width = 256, height = 256, options: CaptureOptions = {}): string {
    if (this.busy) throw new Error("Capture renderer is busy; captures are serialized");
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192) throw new Error("Capture dimensions are invalid");
    this.busy = true;
    let scene: THREE.Scene | null = null;
    try {
      const renderer = this.ensureRenderer();
      renderer.setSize(width, height, false);
      renderer.clear();
      scene = new THREE.Scene();
      scene.background = new THREE.Color("#262626");
      scene.add(new THREE.AmbientLight(0xffffff, 0.8));
      const light = new THREE.DirectionalLight(0xffffff, 1.5);
      light.position.set(2, 2, 5);
      scene.add(light);
      const clone = object.clone(true);
      scene.add(clone);
      const box = new THREE.Box3().setFromObject(clone);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size); box.getCenter(center);
      clone.position.sub(center);
      const maxDimension = Math.max(size.x, size.y, size.z);
      if (maxDimension > 0) clone.scale.multiplyScalar(2 / maxDimension);
      const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
      camera.position.set(2.5, 2.5, 4);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      const dataUrl = renderer.domElement.toDataURL(options.mime ?? "image/png", options.quality);
      return dataUrl;
    } catch (error) {
      frontendDiagnostics.record("renderer", "renderer.capture_failed", {
        code: "thumbnail_capture_failed", errorType: diagnosticErrorType(error),
      }, {}, true);
      throw error;
    } finally {
      scene?.clear();
      this.busy = false;
    }
  }

  dispose(): void {
    if (this.renderer) {
      if (this.canvas && this.onContextLost) this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
      if (this.canvas && this.onContextRestored) this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
      this.renderer.dispose();
      this.renderer.forceContextLoss();
    }
    this.renderer = null;
    this.canvas = null;
    this.onContextLost = null;
    this.onContextRestored = null;
    rendererCoordinator.unregisterSurface("capture.thumbnail");
  }

  private ensureRenderer(): THREE.WebGLRenderer {
    if (this.renderer) {
      const context = this.renderer.getContext();
      if (!context.isContextLost()) return this.renderer;
      this.dispose();
    }
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      depth: true,
      stencil: false,
      // preserveDrawingBuffer is intentionally true only for this lazy
      // offscreen capture surface.
      preserveDrawingBuffer: true,
      powerPreference: "low-power",
    });
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    this.renderer = renderer;
    this.canvas = renderer.domElement;
    const context = renderer.getContext();
    const isWebGL2 = typeof WebGL2RenderingContext !== "undefined" && context instanceof WebGL2RenderingContext;
    this.onContextLost = (event) => { event.preventDefault(); rendererCoordinator.markContextLost("capture.thumbnail"); };
    this.onContextRestored = () => { rendererCoordinator.markContextRestoring("capture.thumbnail"); rendererCoordinator.markContextRestored("capture.thumbnail"); };
    renderer.domElement.addEventListener("webglcontextlost", this.onContextLost, { passive: false });
    renderer.domElement.addEventListener("webglcontextrestored", this.onContextRestored);
    rendererCoordinator.registerSurface({ id: "capture.thumbnail", role: "capture", canvas: renderer.domElement, selectedBackend: isWebGL2 ? "webgl2" : "unknown", tier: "compatibility", fallbackReason: isWebGL2 ? null : "WebGL2 context unavailable" });
    rendererCoordinator.markReady("capture.thumbnail");
    return renderer;
  }
}

frontendDiagnostics.instrumentClass(CaptureRenderer, 'capture_renderer', ['captureThumbnail', 'dispose']);

export const captureRenderer = new CaptureRenderer();
export const captureThumbnail = (object: THREE.Object3D, width?: number, height?: number, options?: CaptureOptions): string => captureRenderer.captureThumbnail(object, width, height, options);
