import * as THREE from 'three';
import type { LevelObject } from '../../types';
import { isDynamicObject } from '../levelObjectMotion';

/**
 * BAKED LIGHTING
 *
 * A level's indirect light, baked in the editor into a grid of light probes (an irradiance
 * volume). Each probe holds the light reaching it from every direction, from the sky and bounced
 * off the level's static geometry, as first-order spherical harmonics. Every lit material reads
 * the volume where it is drawn, in place of the uniform sky fill (ambient, hemisphere and the
 * environment map's diffuse light): under a roof or down a corridor it is dark where open ground
 * still sees the sky, and lit walls tint what is near them. Characters and other moving objects
 * take the light of wherever they stand. Outside the volume the unbaked fill applies again.
 *
 * The volume is stored as a level asset (LIGHT_VOLUME_MIME) and referenced from the level's
 * `bakedLighting.probes`.
 */

// ---------------------------------------------------------------------------
// Settings and the level record
// ---------------------------------------------------------------------------

export interface BakedLightingSettings {
    /** World units between probes. */
    spacing: number;
    /** Light bounces baked: 1 lights surfaces with the unoccluded sky, each more with the last bake. */
    bounces: number;
    /** Scales the baked light. */
    intensity: number;
}

export const DEFAULT_BAKED_LIGHTING_SETTINGS: BakedLightingSettings = { spacing: 2, bounces: 2, intensity: 1 };

export const BAKED_LIGHTING_LIMITS: Record<keyof BakedLightingSettings, { min: number; max: number; step: number }> = {
    spacing: { min: 0.5, max: 32, step: 0.5 },
    bounces: { min: 1, max: 4, step: 1 },
    intensity: { min: 0, max: 4, step: 0.05 },
};

/** A baked volume as the level stores it. */
export interface BakedProbeVolume {
    assetId: string;
    encoding: typeof LIGHT_VOLUME_ENCODING;
    /** World position of the first probe. */
    origin: [number, number, number];
    spacing: number;
    /** Probes along x, y and z. */
    counts: [number, number, number];
    /** ISO time of the bake. */
    bakedAt: string;
    /** What the bake saw (see bakeSignature), to tell when it is out of date. */
    signature: string;
}

/** A level's `bakedLighting`: its bake settings and, once baked, the volume. */
export interface LevelBakedLighting extends Partial<BakedLightingSettings> {
    probes?: BakedProbeVolume;
}

const finite = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

export const resolveBakedLightingSettings = (value: LevelBakedLighting | null | undefined): BakedLightingSettings => {
    const limits = BAKED_LIGHTING_LIMITS;
    const defaults = DEFAULT_BAKED_LIGHTING_SETTINGS;
    return {
        spacing: finite(value?.spacing, defaults.spacing, limits.spacing.min, limits.spacing.max),
        bounces: Math.round(finite(value?.bounces, defaults.bounces, limits.bounces.min, limits.bounces.max)),
        intensity: finite(value?.intensity, defaults.intensity, limits.intensity.min, limits.intensity.max),
    };
};

const isCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_PROBES_PER_AXIS;

/** A stored volume made safe, or null when it is not one. */
export const readBakedProbeVolume = (value: unknown): BakedProbeVolume | null => {
    if (!value || typeof value !== 'object') return null;
    const volume = value as Partial<BakedProbeVolume>;
    const origin = volume.origin;
    const counts = volume.counts;
    if (typeof volume.assetId !== 'string' || !volume.assetId) return null;
    if (!Array.isArray(origin) || origin.length !== 3 || !origin.every(Number.isFinite)) return null;
    if (!Array.isArray(counts) || counts.length !== 3 || !counts.every(isCount)) return null;
    if (counts[0] * counts[1] * counts[2] > MAX_PROBES) return null;
    if (typeof volume.spacing !== 'number' || !(volume.spacing > 0) || !Number.isFinite(volume.spacing)) return null;
    return {
        assetId: volume.assetId,
        encoding: LIGHT_VOLUME_ENCODING,
        origin: [origin[0], origin[1], origin[2]],
        spacing: volume.spacing,
        counts: [counts[0], counts[1], counts[2]],
        bakedAt: typeof volume.bakedAt === 'string' ? volume.bakedAt : '',
        signature: typeof volume.signature === 'string' ? volume.signature : '',
    };
};

// ---------------------------------------------------------------------------
// The volume asset
// ---------------------------------------------------------------------------

/** A 20-byte header (magic, uint32 x, y and z counts), then 12 float32 per probe, little-endian. */
export const LIGHT_VOLUME_MIME = 'application/vnd.auvra.lightvolume';
export const LIGHT_VOLUME_ENCODING = 'sh1-float32le' as const;
export const LIGHT_VOLUME_FILE_NAME = 'light-volume.bin';
const LIGHT_VOLUME_MAGIC = 'AUVRALV1';
export const LIGHT_VOLUME_HEADER_BYTES = 20;
/** First-order spherical harmonics: four RGB coefficients per probe. */
export const SH_FLOATS_PER_PROBE = 12;
export const MAX_PROBES_PER_AXIS = 256;
export const MAX_PROBES = 65536;

export const encodeLightVolume = (sh: Float32Array, counts: readonly [number, number, number]): Uint8Array<ArrayBuffer> => {
    const probes = counts[0] * counts[1] * counts[2];
    if (!counts.every(isCount) || probes > MAX_PROBES) throw new Error('light volume dimensions are out of range');
    if (sh.length !== probes * SH_FLOATS_PER_PROBE) throw new Error('light volume data does not match its dimensions');
    const bytes = new Uint8Array(LIGHT_VOLUME_HEADER_BYTES + sh.length * 4);
    for (let index = 0; index < LIGHT_VOLUME_MAGIC.length; index++) bytes[index] = LIGHT_VOLUME_MAGIC.charCodeAt(index);
    const view = new DataView(bytes.buffer);
    counts.forEach((count, axis) => view.setUint32(8 + axis * 4, count, true));
    for (let index = 0; index < sh.length; index++) {
        const value = sh[index];
        view.setFloat32(LIGHT_VOLUME_HEADER_BYTES + index * 4, Number.isFinite(value) ? value : 0, true);
    }
    return bytes;
};

export const decodeLightVolume = (buffer: ArrayBuffer): { counts: [number, number, number]; sh: Float32Array } => {
    if (buffer.byteLength < LIGHT_VOLUME_HEADER_BYTES) throw new Error('light volume asset is truncated');
    const bytes = new Uint8Array(buffer, 0, LIGHT_VOLUME_MAGIC.length);
    if (String.fromCharCode(...bytes) !== LIGHT_VOLUME_MAGIC) throw new Error('light volume asset has an unknown format');
    const view = new DataView(buffer);
    const counts: [number, number, number] = [view.getUint32(8, true), view.getUint32(12, true), view.getUint32(16, true)];
    const probes = counts[0] * counts[1] * counts[2];
    if (!counts.every(isCount) || probes > MAX_PROBES) throw new Error('light volume dimensions are out of range');
    if (buffer.byteLength !== LIGHT_VOLUME_HEADER_BYTES + probes * SH_FLOATS_PER_PROBE * 4) {
        throw new Error('light volume asset size does not match its dimensions');
    }
    const sh = new Float32Array(probes * SH_FLOATS_PER_PROBE);
    for (let index = 0; index < sh.length; index++) {
        const value = view.getFloat32(LIGHT_VOLUME_HEADER_BYTES + index * 4, true);
        sh[index] = Number.isFinite(value) ? value : 0;
    }
    return { counts, sh };
};

// ---------------------------------------------------------------------------
// Probe grid
// ---------------------------------------------------------------------------

export interface ProbeGrid {
    origin: THREE.Vector3;
    spacing: number;
    counts: [number, number, number];
}

/** How many probes a bake places at most; a level larger than that gets wider spacing. */
export const MAX_BAKE_PROBES = 16384;

/** Probes from a little above the bottom of `bounds` to a spacing above its top, `spacing` apart. */
export const planProbeGrid = (bounds: THREE.Box3, spacing: number, maxProbes = MAX_BAKE_PROBES): ProbeGrid => {
    const min = bounds.min.clone();
    const max = bounds.max.clone();
    if (bounds.isEmpty()) {
        min.set(0, 0, 0);
        max.set(0, 0, 0);
    }
    const limit = Math.min(maxProbes, MAX_PROBES);
    let step = Math.max(spacing, 1e-3);
    for (;;) {
        const lift = Math.min(0.25, step / 4);
        const size = new THREE.Vector3(max.x - min.x, max.y + step - (min.y + lift), max.z - min.z).max(new THREE.Vector3());
        const counts = [size.x, size.y, size.z].map(extent => Math.floor(extent / step + 1e-6) + 1) as [number, number, number];
        // Centre the probes over the bounds on each axis they do not fill exactly.
        const origin = new THREE.Vector3(
            (min.x + max.x - (counts[0] - 1) * step) / 2,
            min.y + lift,
            (min.z + max.z - (counts[2] - 1) * step) / 2,
        );
        if (counts.every(count => count <= MAX_PROBES_PER_AXIS) && counts[0] * counts[1] * counts[2] <= limit) {
            return { origin, spacing: step, counts };
        }
        step *= Math.max(1.05, Math.cbrt((counts[0] * counts[1] * counts[2]) / limit));
    }
};

/** World position of probe (x, y, z). */
export const probePosition = (grid: ProbeGrid, x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 =>
    out.set(grid.origin.x + x * grid.spacing, grid.origin.y + y * grid.spacing, grid.origin.z + z * grid.spacing);

/**
 * Gives every probe that sat inside geometry (`valid` 0) the average of its valid neighbours,
 * spreading outward until all are filled, so surfaces next to a wall do not read the dark inside
 * of it. Leaves the data alone when no probe is valid.
 */
export const fillInvalidProbes = (sh: Float32Array, valid: Uint8Array, counts: readonly [number, number, number]): void => {
    const [nx, ny, nz] = counts;
    const filled = Uint8Array.from(valid);
    if (!filled.some(Boolean)) return;
    const sum = new Float64Array(SH_FLOATS_PER_PROBE);
    let pending = filled.reduce((count, value) => count + (value ? 0 : 1), 0);
    while (pending > 0) {
        const next = Uint8Array.from(filled);
        for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
            const index = x + nx * (y + ny * z);
            if (filled[index]) continue;
            sum.fill(0);
            let neighbours = 0;
            for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const ox = x + dx, oy = y + dy, oz = z + dz;
                if (ox < 0 || oy < 0 || oz < 0 || ox >= nx || oy >= ny || oz >= nz) continue;
                const other = ox + nx * (oy + ny * oz);
                if (!filled[other]) continue;
                neighbours++;
                for (let k = 0; k < SH_FLOATS_PER_PROBE; k++) sum[k] += sh[other * SH_FLOATS_PER_PROBE + k];
            }
            if (!neighbours) continue;
            for (let k = 0; k < SH_FLOATS_PER_PROBE; k++) sh[index * SH_FLOATS_PER_PROBE + k] = sum[k] / neighbours;
            next[index] = 1;
            pending--;
        }
        filled.set(next);
    }
};

// ---------------------------------------------------------------------------
// What a bake sees
// ---------------------------------------------------------------------------

/** Level objects that can stand in the bake: the rest are markers, sounds and spawns. */
const BAKED_OBJECT_TYPES = new Set<LevelObject['type']>(['prop', 'foliage', 'terrain']);

/** The level objects that never move, whose geometry and lights the bake sees. */
export const staticLightingObjectIds = (levelObjects: readonly LevelObject[]): Set<string> => {
    const index = new Map(levelObjects.map(object => [object.id, object]));
    return new Set(levelObjects
        .filter(object => BAKED_OBJECT_TYPES.has(object.type) && !isDynamicObject(object, index))
        .map(object => object.id));
};

const LIT_MATERIAL_KEYS = ['isMeshStandardMaterial', 'isMeshLambertMaterial', 'isMeshPhongMaterial', 'isMeshToonMaterial'] as const;

const isLitMaterial = (material: THREE.Material): boolean =>
    LIT_MATERIAL_KEYS.some(key => (material as unknown as Record<string, unknown>)[key] === true) && !(material as THREE.MeshStandardMaterial).wireframe;

/**
 * Whether `node` belongs to static level geometry: the nearest level object above it is one of
 * `staticIds`, or an ancestor is marked `userData.staticLighting` (instanced props and foliage).
 * `undefined` when it belongs to no level object (the scene's own sun, sky and editor helpers).
 */
export const belongsToStaticObject = (node: THREE.Object3D, staticIds: ReadonlySet<string>): boolean | undefined => {
    for (let current: THREE.Object3D | null = node; current; current = current.parent) {
        if (current.userData?.staticLighting === true) return true;
        const id = current.userData?.levelObjectId;
        if (typeof id === 'string') return staticIds.has(id);
    }
    return undefined;
};

/** A mesh the bake draws: unskinned, lit, and part of static level geometry. */
export const isStaticLightingMesh = (object: THREE.Object3D, staticIds: ReadonlySet<string>): object is THREE.Mesh => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return false;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    return materials.some(isLitMaterial) && belongsToStaticObject(mesh, staticIds) === true;
};

/** A light the bake uses: the scene's own, or one on a static object (a lamp carried around is not baked). */
export const isStaticLightingLight = (light: THREE.Light, staticIds: ReadonlySet<string>): boolean =>
    belongsToStaticObject(light, staticIds) !== false;

const fnv = (text: string, seed: number): string => {
    let hash = seed >>> 0;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
};

/** Sums up what a bake depends on: the static objects, their lights and the sky. Equal when nothing it saw changed. */
export const bakeSignature = (levelObjects: readonly LevelObject[], settings: BakedLightingSettings): string => {
    const staticIds = staticLightingObjectIds(levelObjects);
    const seen = levelObjects
        .filter(object => staticIds.has(object.id) || object.type === 'sky_sphere')
        .map(object => [
            object.id, object.type, object.modelId, object.parentId ?? null, object.position, object.rotation, object.scale,
            object.skyConfig ?? null, object.terrainData?.heightfield?.assetId ?? null, object.terrainData?.textureId ?? null,
            object.terrainData?.splatmap?.assetId ?? null, object.terrainData?.textureLayers ?? null,
            (object.components ?? []).filter(component => component.enabled !== false && /light/i.test(component.type))
                .map(component => [component.type, component.props]),
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const text = JSON.stringify([settings.spacing, settings.bounces, seen]);
    return fnv(text, 0x811c9dc5) + fnv(text, 0x01000193);
};

// ---------------------------------------------------------------------------
// Shading: every lit material reads the volume
// ---------------------------------------------------------------------------

/** A value every material's copy of the uniforms shares: three copies uniform values per material. */
class SharedTexture3D extends THREE.Data3DTexture {
    override clone(): this { return this; }
}
class SharedVector3 extends THREE.Vector3 {
    override clone(): this { return this; }
}
class SharedVector4 extends THREE.Vector4 {
    override clone(): this { return this; }
}

const volumeTexture = (): SharedTexture3D => {
    const texture = new SharedTexture3D(new Uint16Array(4), 1, 1, 1);
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.HalfFloatType;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = texture.wrapR = THREE.ClampToEdgeWrapping;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    return texture;
};

/** Sampling sits this far along the surface normal, in probe spacings, so a surface reads the probes in front of it. */
const NORMAL_OFFSET = 0.35;
/** Beyond the outer probes the baked light fades out over this many spacings. */
const EDGE_FADE = 0.5;

const sh = [volumeTexture(), volumeTexture(), volumeTexture()] as const;
const origin = new SharedVector3();
const extent = new SharedVector3();
/** x: intensity, y: 1 when this frame's scene has a volume, z: normal offset, w: edge fade (world units). */
const params = new SharedVector4(1, 0, 1, 1);

export const BAKED_LIGHTING_UNIFORMS = {
    bakedGiSh0: { value: sh[0] },
    bakedGiSh1: { value: sh[1] },
    bakedGiSh2: { value: sh[2] },
    bakedGiOrigin: { value: origin },
    bakedGiExtent: { value: extent },
    bakedGiParams: { value: params },
};

const PARS = /* glsl */`
#if defined( STANDARD ) || defined( LAMBERT ) || defined( PHONG ) || defined( TOON )
#define AUVRA_BAKED_GI
uniform highp sampler3D bakedGiSh0;
uniform highp sampler3D bakedGiSh1;
uniform highp sampler3D bakedGiSh2;
uniform vec3 bakedGiOrigin;
uniform vec3 bakedGiExtent;
uniform vec4 bakedGiParams;
float bakedGiWeight( const in vec3 position ) {
	vec3 outside = max( bakedGiOrigin - position, position - ( bakedGiOrigin + bakedGiExtent ) );
	return 1.0 - smoothstep( 0.0, bakedGiParams.w, max( max( outside.x, outside.y ), outside.z ) );
}
vec3 bakedGiIrradiance( const in vec3 position, const in vec3 normal ) {
	vec3 counts = vec3( textureSize( bakedGiSh0, 0 ) );
	vec3 cell = clamp( ( position + normal * bakedGiParams.z - bakedGiOrigin ) / max( bakedGiExtent, vec3( 1e-4 ) ), 0.0, 1.0 ) * ( counts - 1.0 );
	vec3 uvw = ( cell + 0.5 ) / counts;
	vec4 a = texture( bakedGiSh0, uvw );
	vec4 b = texture( bakedGiSh1, uvw );
	vec4 c = texture( bakedGiSh2, uvw );
	// three's SH order: constant, then y, z, x.
	vec3 irradiance = a.rgb * 0.886227 + 1.023328 * ( vec3( a.a, b.rg ) * normal.y + vec3( b.ba, c.r ) * normal.z + c.gba * normal.x );
	return max( irradiance, vec3( 0.0 ) ) * bakedGiParams.x;
}
#endif
`;

const BEFORE_MAPS = /* glsl */`
#if defined( RE_IndirectDiffuse ) && defined( AUVRA_BAKED_GI )
	float bakedGiBlend = 0.0;
	vec3 bakedGi = vec3( 0.0 );
	if ( bakedGiParams.y > 0.5 ) {
		vec3 bakedGiPosition = ( vec4( geometryPosition, 0.0 ) * viewMatrix ).xyz + cameraPosition;
		vec3 bakedGiNormal = inverseTransformDirection( geometryNormal, viewMatrix );
		bakedGiBlend = bakedGiWeight( bakedGiPosition );
		bakedGi = bakedGiIrradiance( bakedGiPosition, bakedGiNormal );
		// The bake holds the sky fill (ambient, hemisphere and environment) as it reaches here.
		irradiance *= 1.0 - bakedGiBlend;
		#ifndef STANDARD
			irradiance += bakedGi * bakedGiBlend;
		#endif
	}
#endif
`;

const AFTER_MAPS = /* glsl */`
#if defined( RE_IndirectDiffuse ) && defined( AUVRA_BAKED_GI ) && defined( STANDARD )
	iblIrradiance = mix( iblIrradiance, bakedGi, bakedGiBlend );
#endif
`;

/** Marks the patched chunks, so a second load of this module (a hot reload) does not patch them again. */
const INSTALLED_MARK = '// auvra baked lighting';

/**
 * Teaches three's lit materials (standard, physical, lambert, phong, toon) to read the volume.
 * Runs once, before any of them compiles: it edits the shared shader chunks and the uniforms each
 * material copies when its program is built, and has every scene set the uniforms to its own
 * volume (or none) as it starts drawing, so views and canvases with different levels, or none,
 * each draw with their own.
 */
export const installBakedLighting = (): void => {
    if (!THREE.ShaderChunk.lights_pars_begin.includes(INSTALLED_MARK)) {
        THREE.ShaderChunk.lights_pars_begin += `
${INSTALLED_MARK}
${PARS}`;
        THREE.ShaderChunk.lights_fragment_maps = BEFORE_MAPS + THREE.ShaderChunk.lights_fragment_maps + AFTER_MAPS;
    }
    for (const name of ['standard', 'physical', 'lambert', 'phong', 'toon'] as const) {
        Object.assign(THREE.ShaderLib[name].uniforms, BAKED_LIGHTING_UNIFORMS);
    }
    THREE.Scene.prototype.onBeforeRender = function onBeforeRender(this: THREE.Scene) {
        applyLightVolume(this);
    };
};

// ---------------------------------------------------------------------------
// Which volume each scene draws with
// ---------------------------------------------------------------------------

/** A volume ready to draw: the decoded probes and where they are. */
export interface LightVolume {
    origin: THREE.Vector3;
    spacing: number;
    counts: [number, number, number];
    sh: Float32Array;
    intensity: number;
}

/**
 * Per scene, the volumes given to it; the last one draws, so a bake in progress shows over the
 * level's own. null stands for none (a bake's first bounce is lit by the sky fill alone).
 */
const volumes = new Map<THREE.Object3D, Array<LightVolume | null>>();
/** The probes now in the textures; a volume that only changes intensity keeps them. */
let uploaded: Float32Array | null = null;

/** Draws `scene` with `volume` (null: without one) until the returned function is called. */
export const setSceneLightVolume = (scene: THREE.Object3D, volume: LightVolume | null): (() => void) => {
    const stack = volumes.get(scene) ?? [];
    stack.push(volume);
    volumes.set(scene, stack);
    return () => {
        const index = stack.lastIndexOf(volume);
        if (index < 0) return;
        stack.splice(index, 1);
        if (!stack.length && volumes.get(scene) === stack) volumes.delete(scene);
    };
};

/** The volume `scene` draws with, if any. */
export const lightVolumeFor = (scene: THREE.Object3D): LightVolume | null => volumes.get(scene)?.at(-1) ?? null;

const toHalf = THREE.DataUtils.toHalfFloat;

const upload = (volume: LightVolume): void => {
    const [nx, ny, nz] = volume.counts;
    const probes = nx * ny * nz;
    const packed = [new Uint16Array(probes * 4), new Uint16Array(probes * 4), new Uint16Array(probes * 4)];
    for (let probe = 0; probe < probes; probe++) {
        const from = probe * SH_FLOATS_PER_PROBE;
        for (let k = 0; k < SH_FLOATS_PER_PROBE; k++) packed[k >> 2][probe * 4 + (k & 3)] = toHalf(volume.sh[from + k]);
    }
    sh.forEach((texture, index) => {
        // A new size needs new storage: dispose frees it, and the next draw allocates afresh.
        texture.dispose();
        texture.image = { data: packed[index], width: nx, height: ny, depth: nz };
        texture.needsUpdate = true;
    });
    uploaded = volume.sh;
};

/** Points the shared uniforms at `scene`'s volume, or turns the baked light off; runs as each scene starts drawing. */
export const applyLightVolume = (scene: THREE.Object3D): void => {
    const volume = lightVolumeFor(scene);
    if (!volume) {
        params.y = 0;
        return;
    }
    if (uploaded !== volume.sh) upload(volume);
    origin.copy(volume.origin);
    extent.set(volume.counts[0] - 1, volume.counts[1] - 1, volume.counts[2] - 1).multiplyScalar(volume.spacing);
    params.set(volume.intensity, 1, NORMAL_OFFSET * volume.spacing, EDGE_FADE * volume.spacing);
};

/** Whether the volume draws (tests). */
export const lightVolumeEnabled = (): boolean => params.y > 0.5;

installBakedLighting();
