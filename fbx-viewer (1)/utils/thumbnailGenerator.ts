
import * as THREE from 'three';

// Stable Singleton Renderer
let _thumbnailRenderer: THREE.WebGLRenderer | null = null;

const getThumbnailRenderer = (width: number, height: number) => {
  // Check if renderer exists and context is valid
  if (_thumbnailRenderer) {
      const gl = _thumbnailRenderer.getContext();
      if (gl.isContextLost()) {
          console.warn("Thumbnail Renderer Context Lost. Recreating...");
          _thumbnailRenderer.dispose();
          _thumbnailRenderer = null;
      }
  }

  if (!_thumbnailRenderer) {
    _thumbnailRenderer = new THREE.WebGLRenderer({ 
        antialias: true, 
        alpha: false, 
        preserveDrawingBuffer: true,
        powerPreference: 'low-power',
        depth: true,
        stencil: false
    });
    _thumbnailRenderer.setPixelRatio(1);
  }
  
  const currentSize = new THREE.Vector2();
  _thumbnailRenderer.getSize(currentSize);
  
  if (currentSize.x !== width || currentSize.y !== height) {
      _thumbnailRenderer.setSize(width, height);
  }
  
  // Explicitly clear to ensure no artifacts from previous renders
  _thumbnailRenderer.clear();
  
  return _thumbnailRenderer;
};

/**
 * Generates a base64 image thumbnail for a given 3D object.
 * This runs off-screen using a shared WebGLRenderer.
 */
export const generateThumbnail = (object: THREE.Object3D, width = 256, height = 256): string => {
  // 1. Setup Scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#262626'); // Match UI Neutral Gray 800
  
  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
  scene.add(ambientLight);
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
  dirLight.position.set(2, 2, 5);
  scene.add(dirLight);

  // 2. Clone Object to avoid messing with original state
  // object.clone() is a shallow clone for resources (geometry/material are shared)
  const clone = object.clone();
  scene.add(clone);

  // 3. Normalize position/scale for snapshot
  const box = new THREE.Box3().setFromObject(clone);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  clone.position.sub(center); // Center at 0,0,0
  
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 0) {
      const scale = 2.0 / maxDim; // Fit within view (slightly tighter than 2.5)
      clone.scale.multiplyScalar(scale);
  }

  // 4. Setup Camera
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
  camera.position.set(2.5, 2.5, 4);
  camera.lookAt(0, 0, 0);

  // 5. Render using Singleton Renderer
  try {
    const renderer = getThumbnailRenderer(width, height);
    renderer.render(scene, camera);
    const dataUrl = renderer.domElement.toDataURL('image/jpeg', 0.85);
    
    // Cleanup scene refs
    scene.clear();
    
    return dataUrl;
  } catch (e) {
    console.warn("Thumbnail generation failed", e);
    // Return a placeholder or empty string if context is dead
    return '';
  }
};
