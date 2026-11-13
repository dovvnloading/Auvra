import * as THREE from 'three';
import { compileMaterialGraph, normalizeMaterialGraph } from '../../runtime/materials/materialGraph';
import { textureGpu } from '../../texturing/gpu/textureGpu';
import { materialGraphForTextures } from '../../texturing/materialOutput';

/** Draw a triangle spanning U=1. Its adjacent UDIMs occupy opposite rows of the atlas. */
export async function checkUdimMip() {
    const gpu = textureGpu();
    const layout = { tiles: [1001, 1011, 1002], columns: 2, rows: 2, cell: 64, gutter: 0, width: 128, height: 128 };
    const graph = normalizeMaterialGraph(materialGraphForTextures({ baseColor: 'levels' }, { tiles: layout }));
    const compiled = compileMaterialGraph(graph, { outputs: ['baseColor'] });
    // A manual pyramid: the red byte identifies the level without relying on downsampling heuristics.
    const mipmaps = Array.from({ length: 8 }, (_, level) => {
        const width = 128 >> level;
        const data = new Uint8Array(width * width * 4);
        for (let i = 0; i < data.length; i += 4) {
            data[i] = 16 + level * 30;
            data[i + 3] = 255;
        }
        return { width, height: width, data };
    });
    const atlas = new THREE.DataTexture(mipmaps[0].data, 128, 128);
    atlas.mipmaps = mipmaps;
    atlas.generateMipmaps = false;
    atlas.minFilter = THREE.NearestMipmapNearestFilter;
    atlas.magFilter = THREE.NearestFilter;
    atlas.needsUpdate = true;
    const image = gpu.image(16, 8, 'color', 8);
    try {
        const samples = [];
        for (const [label, texels, expected] of [['near', 0.25, 16], ['far', 4, 76]] as const) {
            // Pixel centres x=8.5 and 9.5 share a derivative quad but land either side of U=1.
            // Green is the old implicit lookup, red uses the emitted production material graph.
            const fragment = `uniform float mg_udimTiles_columns, mg_udimTiles_tileSize, mg_udimTiles_gutter, texels;
                void main() {
                  vec2 original = vec2(1.0 + (gl_FragCoord.x - 9.0) * texels / 64.0, 0.25);
                  #define vUv original
                  ${compiled.statements.join('\n')}
                  #undef vUv
                  vec2 oldUv = (vec2(0.0, step(1.0, original.x)) + clamp(fract(original), 0.5/64.0, 63.5/64.0)) * 0.5;
                  outColor = vec4((${compiled.outputs.baseColor}).r, texture(mg_baseColor_texture, oldUv).r, 0.0, 1.0);
                }`;
            gpu.passNow(image, { fragment, inputs: { mg_baseColor_texture: atlas }, uniforms: {
                mg_udimTiles_columns: 2, mg_udimTiles_tileSize: 64, mg_udimTiles_gutter: 0, texels,
            } });
            const pixels = await gpu.readRgba8Later(image);
            if (!pixels) throw new Error(`UDIM ${label} probe did not return pixels`);
            const at = (x: number, channel: number) => pixels[(4 * 16 + x) * 4 + channel];
            const seam = [at(8, 0), at(9, 0)];
            const control = [at(8, 1), at(9, 1)];
            if ([...seam, at(7, 0), at(10, 0)].some(value => Math.abs(value - expected) > 1)) {
                throw new Error(`UDIM ${label} probe expected mip byte ${expected}, found ${seam.join('/')}`);
            }
            samples.push({ label, texelsPerPixel: texels, expected, seam, implicitControl: control });
        }
        return samples;
    } finally {
        gpu.release(image);
        atlas.dispose();
    }
}
