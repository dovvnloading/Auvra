import * as THREE from 'three';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { decodePictureOffPage } from '../../texturing/texturePipeline';
import { pictureToHalf, pictureToRgba8, type DecodedPicture } from '../../texturing/textureDecode';
import { textureSettingsOf, textureSourceAssetOf } from '../../texturing/textureSettings';
import { projectService } from '../../utils/projectService';

/**
 * PICTURES AT THEIR OWN DEPTH, FOR TEXTURE GRAPHS
 *
 * A 16-bit or floating-point picture of the project (a height map, an EXR) is read from its file at
 * its depth, off the page, and handed to texture graphs as a texture of half or full floats, so a
 * Bitmap node keeps every step of it. Until it has been read (and for 8-bit pictures, which lose
 * nothing) graphs get the project's usual texture. Each texture says its depth (userData.auvraDepth).
 */

export interface DeepUpload {
    data: Uint8Array | Uint16Array | Float32Array;
    type: THREE.TextureDataType;
    /** Bits a channel it keeps on the GPU. */
    depth: 8 | 16 | 32;
}

/** How a decoded picture goes onto the GPU at its depth: floats as full floats, 16-bit as half floats, 8-bit as bytes. */
export const deepUpload = (picture: Pick<DecodedPicture, 'depth' | 'rgba' | 'width' | 'height' | 'channels' | 'hdr'>): DeepUpload => {
    if (picture.depth === 32) return { data: picture.rgba, type: THREE.FloatType, depth: 32 };
    if (picture.depth === 16) return { data: pictureToHalf(picture as DecodedPicture), type: THREE.HalfFloatType, depth: 16 };
    return { data: pictureToRgba8(picture as DecodedPicture), type: THREE.UnsignedByteType, depth: 8 };
};

/** A texture of a decoded picture, kept at its depth, laid as the project's textures are for graphs (top row first). */
export const deepTexture = (picture: DecodedPicture): THREE.DataTexture => {
    const upload = deepUpload(picture);
    const texture = new THREE.DataTexture(upload.data, picture.width, picture.height, THREE.RGBAFormat, upload.type);
    texture.colorSpace = THREE.NoColorSpace;
    texture.flipY = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.userData.auvraDepth = upload.depth;
    texture.needsUpdate = true;
    return texture;
};

type State = THREE.DataTexture | 'reading' | 'none';

class DeepPictures {
    private readonly states = new Map<string, State>();
    private readonly listeners = new Set<() => void>();
    private version = 0;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getVersion = (): number => this.version;

    private changed(): void {
        this.version++;
        for (const listener of this.listeners) listener();
    }

    /** A texture lookup giving pictures at their depth once read, and `base`'s textures meanwhile and for 8-bit ones. */
    lookup(base: (textureId: string) => THREE.Texture | null): (textureId: string) => THREE.Texture | null {
        return (textureId) => {
            const state = this.states.get(textureId);
            if (state instanceof THREE.DataTexture) return state;
            if (state === undefined) this.read(textureId);
            return base(textureId);
        };
    }

    private read(textureId: string): void {
        const depth = textureSettingsOf(textureId)?.source?.depth;
        const assetId = textureSourceAssetOf(textureId);
        if (!depth || depth <= 8 || !assetId) { this.states.set(textureId, 'none'); return; }
        this.states.set(textureId, 'reading');
        void (async () => {
            try {
                const response = await projectService.fetchAsset(assetId);
                if (!response.ok) throw new Error('The picture could not be read.');
                const picture = await decodePictureOffPage(new Uint8Array(await response.arrayBuffer()));
                this.states.set(textureId, deepTexture(picture));
            } catch (error) {
                frontendDiagnostics.failure('texture_graph_deep_picture_failed', error);
                this.states.set(textureId, 'none');
            }
            this.changed();
        })();
    }

    /** Forgets a picture (it changed): read again when next wanted. */
    forget(textureId: string): void {
        const state = this.states.get(textureId);
        if (state instanceof THREE.DataTexture) state.dispose();
        this.states.delete(textureId);
        this.changed();
    }
}

export const deepPictures = new DeepPictures();
