import * as THREE from 'three';

/**
 * Asks a material's own shader what it works out, for whatever cannot run that shader, such as a renderer of another kind. A
 * material may be a graph, or patched by hand as terrain and water are, and worked out anywhere else it would be another
 * material. This runs the shader as it is, and writes out what it arrived at where it would have gone on to light it.
 */

/** What a shader can be asked for. A surface's own values are in linear light but for `baseColor`, written as a picture holds it. */
export type CapturedValue = 'baseColor' | 'roughness' | 'metalness' | 'normal' | 'emissive' | 'opacity' | 'worldPosition' | 'worldNormal';

/** An attribute that says where each corner lies on a map made for baking, where a mesh's own UVs would not do. */
export const BAKE_PLACE_ATTRIBUTE = 'bakePlace';

/** Where each corner is drawn: on the mesh's own map, on one made for baking, or as a point in a grid with one pixel for each vertex. */
export type CapturePlace = 'uv' | typeof BAKE_PLACE_ATTRIBUTE | { columns: number; rows: number };

/** Values that can go past what a byte holds. */
export const isUnboundedValue = (value: CapturedValue): boolean => value === 'emissive' || value === 'worldPosition' || value === 'worldNormal';

const FRAGMENT_OUTPUT: Record<CapturedValue, string> = {
    baseColor: 'gl_FragColor = vec4(sRGBTransferOETF(vec4(clamp(diffuseColor.rgb, 0.0, 1.0), 1.0)).rgb, 1.0);',
    roughness: 'gl_FragColor = vec4(vec3(clamp(roughnessFactor, 0.0, 1.0)), 1.0);',
    metalness: 'gl_FragColor = vec4(vec3(clamp(metalnessFactor, 0.0, 1.0)), 1.0);',
    // Only a material with a normal has this to give, as its stand-in normal map is what declares it.
    normal: 'gl_FragColor = vec4(clamp(mapN * 0.5 + 0.5, 0.0, 1.0), 1.0);',
    emissive: 'gl_FragColor = vec4(max(totalEmissiveRadiance, vec3(0.0)), 1.0);',
    opacity: 'gl_FragColor = vec4(vec3(clamp(diffuseColor.a, 0.0, 1.0)), 1.0);',
    worldPosition: 'gl_FragColor = vec4(vCaptured, 1.0);',
    worldNormal: 'gl_FragColor = vec4(vCaptured, 1.0);',
};

const VERTEX_VALUE: Partial<Record<CapturedValue, string>> = {
    // Where it ends up: wind is added once it is in the camera's space.
    worldPosition: 'vCaptured = (inverse(viewMatrix) * vec4(mvPosition.xyz, 1.0)).xyz;',
    worldNormal: 'vec3 capturedNormal = objectNormal;\n#ifdef USE_INSTANCING\ncapturedNormal = mat3(instanceMatrix) * capturedNormal;\n#endif\nvCaptured = normalize(transpose(inverse(mat3(modelMatrix))) * capturedNormal);',
};

const placeCode = (place: CapturePlace): string => {
    if (place === 'uv') return 'gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);';
    if (place === BAKE_PLACE_ATTRIBUTE) return `gl_Position = vec4(${BAKE_PLACE_ATTRIBUTE} * 2.0 - 1.0, 0.0, 1.0);`;
    return `vec2 capturedCell = vec2(float(gl_VertexID % ${place.columns}), float(gl_VertexID / ${place.columns}));
gl_Position = vec4((capturedCell + 0.5) / vec2(${place.columns}.0, ${place.rows}.0) * 2.0 - 1.0, 0.0, 1.0);
gl_PointSize = 1.0;`;
};

const placeKey = (place: CapturePlace): string => (typeof place === 'string' ? place : `grid${place.columns}x${place.rows}`);

/** Puts code just before the end of a shader's main: everything there is to read has been worked out by then, whatever was patched in. */
const atEndOfMain = (source: string, code: string): string => {
    const end = source.lastIndexOf('}');
    if (end < 0) throw new Error('The shader has no main to add to.');
    return `${source.slice(0, end)}\n${code}\n}${source.slice(end + 1)}`;
};

const blankLike = (material: THREE.Material): THREE.Material => {
    const kind = material as THREE.MeshPhysicalMaterial & { isMeshPhongMaterial?: boolean; isMeshLambertMaterial?: boolean };
    if (kind.isMeshPhysicalMaterial) return new THREE.MeshPhysicalMaterial().copy(kind);
    if (kind.isMeshStandardMaterial) return new THREE.MeshStandardMaterial().copy(kind);
    if (kind.isMeshPhongMaterial) return new THREE.MeshPhongMaterial().copy(kind as unknown as THREE.MeshPhongMaterial);
    return new THREE.MeshLambertMaterial().copy(kind as unknown as THREE.MeshLambertMaterial);
};

/**
 * A material that draws what `material` works out for one value, flat, each corner where `place` says. Everything it reads
 * still comes from where a surface stands, so a noise over the world or a look at the camera comes out as it does on screen.
 * The caller draws with it and disposes of it.
 */
export const captureMaterial = (material: THREE.Material, value: CapturedValue, place: CapturePlace): THREE.Material => {
    const capture = blankLike(material);
    // A material's defines say what its own shader needs. Copying one keeps only what three itself knows of.
    capture.defines = { ...(material.defines ?? {}) };
    capture.side = THREE.DoubleSide;
    // Not opaque, or what it is cut out by would be set to 1 before it could be read, and not tested, or the holes would stay holes.
    capture.transparent = true;
    capture.blending = THREE.NoBlending;
    capture.alphaTest = 0;
    capture.alphaHash = false;
    capture.depthTest = false;
    capture.depthWrite = false;
    capture.toneMapped = false;
    capture.polygonOffset = false;
    (capture as THREE.Material & { fog?: boolean }).fog = false;
    const carriesValue = VERTEX_VALUE[value] !== undefined;
    capture.onBeforeCompile = (shader, renderer) => {
        material.onBeforeCompile.call(material, shader, renderer);
        const declared = `${carriesValue ? 'varying vec3 vCaptured;\n' : ''}`;
        const placeAttribute = place === BAKE_PLACE_ATTRIBUTE ? `attribute vec2 ${BAKE_PLACE_ATTRIBUTE};\n` : '';
        shader.vertexShader = atEndOfMain(`${declared}${placeAttribute}${shader.vertexShader}`, `${VERTEX_VALUE[value] ?? ''}\n${placeCode(place)}`);
        // Which way round a triangle lies on the map says nothing about which way it faces.
        shader.fragmentShader = atEndOfMain(`#undef DOUBLE_SIDED\n${declared}${shader.fragmentShader}`, FRAGMENT_OUTPUT[value]);
    };
    capture.customProgramCacheKey = () => `capture:${value}:${placeKey(place)}:${material.customProgramCacheKey()}`;
    capture.needsUpdate = true;
    return capture;
};
