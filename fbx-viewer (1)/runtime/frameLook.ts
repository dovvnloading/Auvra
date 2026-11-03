import type * as THREE from 'three';
import type { PostProcessSettings } from './components/postProcess';

/**
 * What a canvas's post-process stack is doing to the picture now, for what makes a picture of the same view by other means.
 * Set by the stack while it is the one on screen.
 */
export const frameLook: {
    settings: PostProcessSettings | null;
    /** What auto exposure has adapted to by now, as a multiplier. Null with auto exposure off. */
    adaptedExposure: ((renderer: THREE.WebGLRenderer) => number) | null;
} = { settings: null, adaptedExposure: null };
