import * as THREE from 'three';
import { captureRenderer } from '../../renderer/capture';
import { bindMaterialGraph, unbindMaterialGraph } from '../../runtime/materials/graphMaterial';
import { withMaterialPictures } from '../../runtime/materials/materialGraph';
import { graphTextures, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import { textureRole, type TextureSettings } from '../../texturing/textureSettings';
import type { LibraryPicture } from '../../utils/userMaterialLibrary';
import { captureLighting, previewBackdrop } from './previewLighting';

/**
 * MATERIAL BALLS
 *
 * A material's picture for My library: a ball drawn on the engine's own material path (the graph bound to
 * a standard material, as on a model) under the material preview's studio lighting, in front of its soft
 * backdrop, with the engine's tone mapping. Drawn by the shared capture renderer, from the pictures the
 * library keeps or the open project's textures (an 8-bit preview where a deep picture has one).
 */

/** Where a picture a ball draws with is read: its URL (and whether it is ours to let go of after), and its settings. */
export type BallPictureSource = (textureId: string) => { url: string; settings?: TextureSettings; owned?: boolean } | null;

/** Pictures kept by My library, as a ball reads them. */
export const libraryPictureSource = (pictures: readonly LibraryPicture[]): BallPictureSource => (textureId) => {
    const picture = pictures.find(candidate => candidate.id === textureId);
    return picture ? { url: URL.createObjectURL(picture.preview ?? picture.file), settings: picture.settings, owned: true } : null;
};

/** Pixels across a ball. */
export const BALL_SIZE = 160;

const environments = new WeakMap<THREE.WebGLRenderer, THREE.WebGLRenderTarget>();
const sphere = new THREE.SphereGeometry(1, 64, 32);

/** The pictures a graph samples, loaded as textures by slot and id; what cannot be read is left out. */
const loadPictures = async (source: BallPictureSource, needed: ReadonlyArray<{ textureId: string; slot: 'map' | 'normal' | 'data' }>): Promise<Map<string, THREE.Texture>> => {
    const loaded = new Map<string, THREE.Texture>();
    const loader = new THREE.TextureLoader();
    await Promise.all(needed.map(async ({ textureId, slot }) => {
        const picture = source(textureId);
        if (!picture) return;
        const { url } = picture;
        try {
            const texture = await loader.loadAsync(url);
            texture.colorSpace = textureRole(slot, picture.settings) === 'colour' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.RepeatWrapping;
            texture.anisotropy = 4;
            loaded.set(`${slot}:${textureId}`, texture);
        } catch {
            // Drawn without it.
        } finally {
            if (picture.owned) URL.revokeObjectURL(url);
        }
    }));
    return loaded;
};

const pngBlob = (dataUrl: string): Blob => {
    const bytes = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
    const data = new Uint8Array(bytes.length);
    for (let index = 0; index < bytes.length; index++) data[index] = bytes.charCodeAt(index);
    return new Blob([data], { type: 'image/png' });
};

/** The material's ball as a PNG, or null where nothing can be drawn (no graphics). */
export const renderMaterialBall = async (asset: MaterialAsset, pictures: readonly LibraryPicture[] | BallPictureSource, size = BALL_SIZE): Promise<Blob | null> => {
    const graph = withMaterialPictures(asset.graph, asset.pictures);
    const textures = await loadPictures(typeof pictures === 'function' ? pictures : libraryPictureSource(pictures), graphTextures(graph));
    try {
        const dataUrl = captureRenderer.drawWith(size, size, (renderer) => {
            let environment = environments.get(renderer);
            if (!environment) environments.set(renderer, environment = captureLighting(renderer, 'studio'));
            const scene = new THREE.Scene();
            const backdrop = previewBackdrop('studio');
            scene.background = backdrop;
            scene.environment = environment.texture;
            // The preview's own lights: a soft sky, a key light and a cool rim.
            scene.add(new THREE.HemisphereLight('#dfe9ff', '#2a2420', 0.35));
            const key = new THREE.DirectionalLight('#ffffff', 2.2);
            key.position.set(3, 5, 2.5);
            const rim = new THREE.DirectionalLight('#9fb4ff', 0.45);
            rim.position.set(-3, 1, -2);
            scene.add(key, rim);
            const material = new THREE.MeshStandardMaterial();
            bindMaterialGraph(material, graph, (textureId, slot) => textures.get(`${slot ?? 'map'}:${textureId}`) ?? null);
            scene.add(new THREE.Mesh(sphere, material));
            const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
            camera.position.set(0, 0.6, 4.1);
            camera.lookAt(0, 0, 0);
            renderer.render(scene, camera);
            const drawn = renderer.domElement.toDataURL('image/png');
            unbindMaterialGraph(material);
            material.dispose();
            backdrop?.dispose();
            return drawn;
        });
        return pngBlob(dataUrl);
    } catch {
        return null;
    } finally {
        for (const texture of textures.values()) texture.dispose();
    }
};
