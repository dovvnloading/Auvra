import * as THREE from 'three';

/**
 * SHARPER TEXTURES FOR A SMALLER PICTURE
 *
 * A picture drawn smaller chooses blurrier mip levels, and gathering frames can only rebuild the detail that
 * was sampled in the first place. So while the lit scene draws, three's materials read their maps a little
 * sharper, through one value they all share. It is left at zero the rest of the time, so nothing else that
 * draws with these materials is affected.
 */

/** A value every material's copy of the uniforms shares: three copies uniform values per material. */
class SharedVector2 extends THREE.Vector2 {
    override clone(): this { return this; }
}

const bias = new SharedVector2();

const MARK = '// auvra mip bias';
const SINGLE_LOOKUPS: ReadonlyArray<[string, string]> = [
    ['map_fragment', 'texture2D( map, vMapUv )'],
    ['roughnessmap_fragment', 'texture2D( roughnessMap, vRoughnessMapUv )'],
    ['metalnessmap_fragment', 'texture2D( metalnessMap, vMetalnessMapUv )'],
    ['emissivemap_fragment', 'texture2D( emissiveMap, vEmissiveMapUv )'],
    ['alphamap_fragment', 'texture2D( alphaMap, vAlphaMapUv )'],
];

/** Mip levels to shift map lookups by; 0 leaves them as they were. */
export const setTextureMipBias = (levels: number): void => {
    bias.x = levels;
};

/** Teaches three's materials to read their maps sharper. Runs once, before any of them compiles. */
export const installMipBias = (): void => {
    const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
    if (!chunks.uv_pars_fragment.includes(MARK)) {
        chunks.uv_pars_fragment += `\n${MARK}\nuniform vec2 auvraMipBias;\n`;
        for (const [chunk, lookup] of SINGLE_LOOKUPS) {
            chunks[chunk] = chunks[chunk].split(lookup).join(lookup.replace(' )', ', auvraMipBias.x )'));
        }
        // Compressed normal maps and the material graph patch this chunk by the exact text of its lookup, so that
        // text stays as it is: for the length of the chunk its coordinate brings the bias along with it.
        chunks.normal_fragment_maps = `#define vNormalMapUv vNormalMapUv, auvraMipBias.x\n${chunks.normal_fragment_maps}\n#undef vNormalMapUv\n`;
    }
    for (const name of ['basic', 'standard', 'physical', 'lambert', 'phong', 'toon'] as const) {
        Object.assign(THREE.ShaderLib[name].uniforms, { auvraMipBias: { value: bias } });
    }
};

installMipBias();
