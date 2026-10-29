import type {
    MaterialBuiltin,
    MaterialInputDef,
    MaterialNodeDef,
    MaterialParamDef,
    MaterialValueType,
    NodeEmitContext,
} from './materialTypes';

/**
 * MATERIAL NODES
 *
 * Every node a material graph can hold. Types, port keys and params of nodes already in use never
 * change: stored graphs name them. Math nodes have 'auto' ports, so they work on numbers, UVs,
 * colours and vectors alike. Nodes that need screen-space derivatives (Normal From Height, Parallax
 * Offset) only take effect on the surface's pixels; elsewhere (vertex offset, shadows) they pass a
 * neutral value through.
 */

export const OUTPUT_NODE_TYPE = 'output';
export const REROUTE_NODE_TYPE = 'reroute';

const fromParam = (param: string) => ({ param });
const value = (number: number) => ({ value: number });
const builtin = (name: MaterialBuiltin) => ({ builtin: name });

const auto = (key: string, label: string, fallback: MaterialInputDef['fallback']): MaterialInputDef => ({ key, label, type: 'auto', fallback });
const float = (key: string, label: string, defaultValue: number, extra: Partial<MaterialParamDef> = {}): MaterialParamDef =>
    ({ key, label, kind: 'float', default: defaultValue, ...extra });
const select = (key: string, label: string, options: ReadonlyArray<[string, string]>, defaultValue = options[0][0]): MaterialParamDef =>
    ({ key, label, kind: 'select', default: defaultValue, options: options.map(([v, l]) => ({ value: v, label: l })) });

/** A node applying a GLSL expression to A and B (auto: the widest wired type). */
const binary = (
    type: string,
    label: string,
    description: string,
    glsl: (a: string, b: string, context: NodeEmitContext) => string,
    defaults: [number, number] = [0, 0],
    keywords?: string[],
): MaterialNodeDef => ({
    type,
    label,
    category: 'Math',
    description,
    keywords,
    inputs: [auto('a', 'A', fromParam('a')), auto('b', 'B', fromParam('b'))],
    outputs: [{ key: 'out', label: 'Result', type: 'auto' }],
    params: [float('a', 'A', defaults[0]), float('b', 'B', defaults[1])],
    emit: (inputs, context) => ({ outputs: { out: glsl(inputs.a, inputs.b, context) } }),
});

/** A node applying a GLSL expression to In (auto). */
const unary = (type: string, label: string, description: string, glsl: (a: string, context: NodeEmitContext) => string, keywords?: string[]): MaterialNodeDef => ({
    type,
    label,
    category: 'Math',
    description,
    keywords,
    inputs: [auto('in', 'In', value(0))],
    outputs: [{ key: 'out', label: 'Result', type: 'auto' }],
    params: [],
    emit: (inputs, context) => ({ outputs: { out: glsl(inputs.in, context) } }),
});

/** A node giving a builtin value. */
const geometry = (type: string, label: string, description: string, name: MaterialBuiltin, outputLabel: string, keywords?: string[]): MaterialNodeDef => ({
    type,
    label,
    category: 'Geometry',
    description,
    keywords,
    inputs: [],
    outputs: [{ key: 'out', label: outputLabel, type: name === 'uv' ? 'vec2' : name === 'cameraDistance' || name === 'time' ? 'float' : 'vec3' }],
    params: [],
    emit: (_inputs, context) => ({ outputs: { out: context.builtin(name) } }),
});

const SWIZZLE = /^(?:[xyzw]{1,4}|[rgba]{1,4})$/;
const CUSTOM_TYPES: ReadonlyArray<[MaterialValueType, string]> = [['float', 'Number'], ['vec2', 'Vector 2'], ['vec3', 'Vector 3 / colour'], ['vec4', 'Vector 4']];

const BLEND_MODES: ReadonlyArray<[string, string]> = [
    ['normal', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['softLight', 'Soft Light'],
    ['hardLight', 'Hard Light'], ['add', 'Add'], ['subtract', 'Subtract'], ['difference', 'Difference'], ['darken', 'Darken'],
    ['lighten', 'Lighten'], ['colorDodge', 'Color Dodge'], ['colorBurn', 'Color Burn'], ['linearLight', 'Linear Light'],
];

const blendExpression = (mode: string, base: string, blend: string, context: NodeEmitContext): string => {
    switch (mode) {
        case 'multiply': return `${base} * ${blend}`;
        case 'screen': return `1.0 - (1.0 - ${base}) * (1.0 - ${blend})`;
        case 'overlay': context.helper('mgOverlay'); return `mgOverlay(${base}, ${blend})`;
        case 'softLight': context.helper('mgSoftLight'); return `mgSoftLight(${base}, ${blend})`;
        case 'hardLight': context.helper('mgOverlay'); return `mgOverlay(${blend}, ${base})`;
        case 'add': return `${base} + ${blend}`;
        case 'subtract': return `max(${base} - ${blend}, vec3(0.0))`;
        case 'difference': return `abs(${base} - ${blend})`;
        case 'darken': return `min(${base}, ${blend})`;
        case 'lighten': return `max(${base}, ${blend})`;
        case 'colorDodge': return `min(${base} / max(1.0 - ${blend}, vec3(1e-4)), vec3(1.0))`;
        case 'colorBurn': return `1.0 - min((1.0 - ${base}) / max(${blend}, vec3(1e-4)), vec3(1.0))`;
        case 'linearLight': return `clamp(${base} + 2.0 * ${blend} - 1.0, 0.0, 1.0)`;
        default: return blend;
    }
};

const COMPARISONS: ReadonlyArray<[string, string]> = [['>', 'A > B'], ['>=', 'A ≥ B'], ['<', 'A < B'], ['<=', 'A ≤ B'], ['==', 'A = B'], ['!=', 'A ≠ B']];

export const MATERIAL_NODE_DEFINITIONS: MaterialNodeDef[] = [
    // ------------------------------------------------------------------ Output
    {
        type: OUTPUT_NODE_TYPE,
        label: 'Material Output',
        category: 'Output',
        description: 'How the surface shades. Unconnected inputs take the values set here; the settings choose how it blends, clips and lights.',
        inputs: [
            { key: 'baseColor', label: 'Base Color', type: 'vec3', fallback: fromParam('baseColor') },
            { key: 'opacity', label: 'Opacity', type: 'float', fallback: fromParam('opacity') },
            { key: 'metalness', label: 'Metalness', type: 'float', fallback: fromParam('metalness') },
            { key: 'roughness', label: 'Roughness', type: 'float', fallback: fromParam('roughness') },
            { key: 'normal', label: 'Normal (tangent space)', type: 'vec3', fallback: 'vec3(0.0, 0.0, 1.0)' },
            { key: 'emissive', label: 'Emissive', type: 'vec3', fallback: fromParam('emissive') },
            { key: 'occlusion', label: 'Ambient Occlusion', type: 'float', fallback: '1.0' },
            { key: 'worldPositionOffset', label: 'World Position Offset', type: 'vec3', fallback: 'vec3(0.0)' },
        ],
        outputs: [],
        params: [
            { key: 'baseColor', label: 'Base Color', kind: 'color', default: [0.8, 0.8, 0.8] },
            float('opacity', 'Opacity', 1, { min: 0, max: 1, step: 0.01 }),
            float('metalness', 'Metalness', 0, { min: 0, max: 1, step: 0.01 }),
            float('roughness', 'Roughness', 0.6, { min: 0, max: 1, step: 0.01 }),
            { key: 'emissive', label: 'Emissive', kind: 'color', default: [0, 0, 0] },
            select('blendMode', 'Blend Mode', [['opaque', 'Opaque'], ['masked', 'Masked (cut-out)'], ['translucent', 'Translucent'], ['additive', 'Additive']]),
            float('alphaClip', 'Alpha Clip', 0.5, { min: 0, max: 1, step: 0.01 }),
            { key: 'twoSided', label: 'Two Sided', kind: 'boolean', default: false },
            select('shading', 'Shading', [['lit', 'Lit'], ['unlit', 'Unlit']]),
        ],
        emit: () => ({ outputs: {} }),
    },

    // ------------------------------------------------------------------ Input
    {
        type: 'float',
        label: 'Number',
        category: 'Input',
        description: 'A constant number.',
        keywords: ['scalar', 'constant', 'value'],
        inputs: [],
        outputs: [{ key: 'out', label: 'Value', type: 'float' }],
        params: [float('value', 'Value', 1)],
        emit: (_inputs, context) => ({ outputs: { out: context.param('value') } }),
    },
    {
        type: 'color',
        label: 'Color',
        category: 'Input',
        description: 'A constant colour.',
        keywords: ['rgb', 'constant'],
        inputs: [],
        outputs: [{ key: 'out', label: 'Color', type: 'vec3' }],
        params: [{ key: 'value', label: 'Color', kind: 'color', default: [1, 1, 1] }],
        emit: (_inputs, context) => ({ outputs: { out: context.param('value') } }),
    },
    {
        type: 'vector2',
        label: 'Vector 2',
        category: 'Input',
        description: 'A constant two-component vector.',
        inputs: [],
        outputs: [{ key: 'out', label: 'Vector', type: 'vec2' }],
        params: [{ key: 'value', label: 'Value', kind: 'vec2', default: [0, 0] }],
        emit: (_inputs, context) => ({ outputs: { out: context.param('value') } }),
    },
    {
        type: 'vector',
        label: 'Vector',
        category: 'Input',
        description: 'A constant three-component vector.',
        keywords: ['vector 3'],
        inputs: [],
        outputs: [{ key: 'out', label: 'Vector', type: 'vec3' }],
        params: [{ key: 'value', label: 'Value', kind: 'vec3', default: [0, 0, 0] }],
        emit: (_inputs, context) => ({ outputs: { out: context.param('value') } }),
    },
    {
        type: 'time',
        label: 'Time',
        category: 'Input',
        description: 'Seconds since play started, for animated materials.',
        inputs: [],
        outputs: [{ key: 'out', label: 'Seconds', type: 'float' }],
        params: [],
        emit: (_inputs, context) => ({ outputs: { out: context.builtin('time') } }),
    },

    // ------------------------------------------------------------------ Geometry
    {
        type: 'uv',
        label: 'UV',
        category: 'UV',
        description: "The mesh's texture coordinates.",
        keywords: ['texcoord', 'coordinates'],
        inputs: [],
        outputs: [{ key: 'out', label: 'UV', type: 'vec2' }],
        params: [],
        emit: (_inputs, context) => ({ outputs: { out: context.builtin('uv') } }),
    },
    geometry('worldPosition', 'World Position', "The surface point's position in the world.", 'worldPosition', 'Position', ['absolute world position']),
    geometry('localPosition', 'Local Position', "The surface point's position on the model, before it is placed (moves with the object).", 'localPosition', 'Position', ['object position', 'vertex position']),
    geometry('objectPosition', 'Object Position', "Where the object's origin is in the world (each instance its own).", 'objectPosition', 'Position', ['pivot', 'origin']),
    geometry('worldNormal', 'World Normal', "The surface's facing direction in the world.", 'worldNormal', 'Normal', ['vertex normal']),
    geometry('localNormal', 'Local Normal', "The surface's facing direction on the model, before it is placed.", 'localNormal', 'Normal', ['object normal']),
    geometry('viewDirection', 'View Direction', 'From the surface towards the camera, in the world.', 'viewDirection', 'Direction', ['camera vector', 'eye']),
    geometry('cameraPosition', 'Camera Position', "The camera's position in the world.", 'cameraPosition', 'Position'),
    geometry('cameraDistance', 'Camera Distance', 'How far the surface is from the camera (fading things out with distance).', 'cameraDistance', 'Distance', ['depth', 'fade']),
    {
        type: 'vertexColor',
        label: 'Vertex Color',
        category: 'Geometry',
        description: "The mesh's vertex colours (white where it has none).",
        inputs: [],
        outputs: [{ key: 'out', label: 'Color', type: 'vec3' }],
        params: [],
        emit: (_inputs, context) => ({ outputs: { out: context.builtin('vertexColor') } }),
    },
    {
        type: 'fresnel',
        label: 'Fresnel',
        category: 'Geometry',
        description: 'Brighter where the surface turns away from the camera: rims, glass edges, force fields.',
        keywords: ['rim', 'edge glow'],
        inputs: [],
        outputs: [{ key: 'out', label: 'Fresnel', type: 'float' }],
        params: [float('power', 'Power', 3, { min: 0.1, max: 16, step: 0.1 })],
        emit: (_inputs, context) => ({
            outputs: { out: `pow(1.0 - clamp(dot(${context.builtin('worldNormal')}, ${context.builtin('viewDirection')}), 0.0, 1.0), ${context.param('power')})` },
        }),
    },

    // ------------------------------------------------------------------ UV
    {
        type: 'tilingOffset',
        label: 'Tiling and Offset',
        category: 'UV',
        description: 'Repeats and shifts texture coordinates.',
        keywords: ['scale uv', 'repeat'],
        inputs: [{ key: 'uv', label: 'UV', type: 'vec2', fallback: builtin('uv') }],
        outputs: [{ key: 'out', label: 'UV', type: 'vec2' }],
        params: [
            { key: 'tiling', label: 'Tiling', kind: 'vec2', default: [1, 1] },
            { key: 'offset', label: 'Offset', kind: 'vec2', default: [0, 0] },
        ],
        emit: (inputs, context) => ({ outputs: { out: `(${inputs.uv} * ${context.param('tiling')} + ${context.param('offset')})` } }),
    },
    {
        type: 'panner',
        label: 'Panner',
        category: 'UV',
        description: 'Scrolls texture coordinates over time (flowing water, conveyor belts).',
        keywords: ['scroll', 'move uv'],
        inputs: [{ key: 'uv', label: 'UV', type: 'vec2', fallback: builtin('uv') }],
        outputs: [{ key: 'out', label: 'UV', type: 'vec2' }],
        params: [{ key: 'speed', label: 'Speed (per second)', kind: 'vec2', default: [0.1, 0] }],
        emit: (inputs, context) => ({ outputs: { out: `(${inputs.uv} + ${context.param('speed')} * ${context.builtin('time')})` } }),
    },
    {
        type: 'rotateUv',
        label: 'Rotate UV',
        category: 'UV',
        description: 'Turns texture coordinates about a centre, by Angle degrees.',
        keywords: ['rotator', 'spin'],
        inputs: [
            { key: 'uv', label: 'UV', type: 'vec2', fallback: builtin('uv') },
            { key: 'angle', label: 'Angle (degrees)', type: 'float', fallback: fromParam('angle') },
        ],
        outputs: [{ key: 'out', label: 'UV', type: 'vec2' }],
        params: [float('angle', 'Angle (degrees)', 0, { step: 1 }), { key: 'center', label: 'Center', kind: 'vec2', default: [0.5, 0.5] }],
        emit: (inputs, context) => {
            const angle = context.local('angle');
            const center = context.param('center');
            return {
                statements: [`float ${angle} = radians(${inputs.angle});`],
                outputs: { out: `(mat2(cos(${angle}), sin(${angle}), -sin(${angle}), cos(${angle})) * (${inputs.uv} - ${center}) + ${center})` },
            };
        },
    },
    {
        type: 'polarCoordinates',
        label: 'Polar Coordinates',
        category: 'UV',
        description: 'Distance from the centre (X) and angle around it (Y, 0 to 1): radial patterns, rings, swirls.',
        keywords: ['radial', 'angle'],
        inputs: [{ key: 'uv', label: 'UV', type: 'vec2', fallback: builtin('uv') }],
        outputs: [{ key: 'out', label: 'Polar', type: 'vec2' }],
        params: [{ key: 'center', label: 'Center', kind: 'vec2', default: [0.5, 0.5] }],
        emit: (inputs, context) => {
            const delta = context.local('delta');
            return {
                statements: [`vec2 ${delta} = ${inputs.uv} - ${context.param('center')};`],
                outputs: { out: `vec2(length(${delta}) * 2.0, atan(${delta}.y, ${delta}.x) / 6.28318530718 + 0.5)` },
            };
        },
    },
    {
        type: 'flipbook',
        label: 'Flipbook',
        category: 'UV',
        description: 'The UV of one frame of a sprite sheet of Columns × Rows frames, played at Frames per second (or the Frame input when wired).',
        keywords: ['sprite sheet', 'animation', 'atlas'],
        inputs: [
            { key: 'uv', label: 'UV', type: 'vec2', fallback: builtin('uv') },
            { key: 'frame', label: 'Frame', type: 'float', fallback: '-1.0' },
        ],
        outputs: [{ key: 'out', label: 'UV', type: 'vec2' }],
        params: [
            float('columns', 'Columns', 4, { min: 1, max: 64, step: 1 }),
            float('rows', 'Rows', 4, { min: 1, max: 64, step: 1 }),
            float('fps', 'Frames per second', 12, { min: 0, max: 120, step: 1 }),
        ],
        emit: (inputs, context) => {
            const columns = context.param('columns');
            const rows = context.param('rows');
            const frame = context.local('frame');
            const cell = context.local('cell');
            return {
                statements: [
                    `float ${frame} = ${inputs.frame} < 0.0 ? floor(${context.builtin('time')} * ${context.param('fps')}) : floor(${inputs.frame});`,
                    `${frame} = mod(${frame}, max(${columns} * ${rows}, 1.0));`,
                    `vec2 ${cell} = vec2(mod(${frame}, ${columns}), ${rows} - 1.0 - floor(${frame} / ${columns}));`,
                ],
                outputs: { out: `((fract(${inputs.uv}) + ${cell}) / vec2(${columns}, ${rows}))` },
            };
        },
    },
    {
        type: 'parallaxOffset',
        label: 'Parallax Offset',
        category: 'UV',
        description: 'Shifts UVs by a height (0 to 1) as the view tilts, so flat surfaces look deep (bump offset). Wire its UV into the textures of the surface.',
        keywords: ['bump offset', 'height', 'depth'],
        inputs: [
            { key: 'uv', label: 'UV', type: 'vec2', fallback: builtin('uv') },
            { key: 'height', label: 'Height', type: 'float', fallback: '0.5' },
        ],
        outputs: [{ key: 'out', label: 'UV', type: 'vec2' }],
        params: [float('scale', 'Depth', 0.05, { min: 0, max: 0.5, step: 0.005 })],
        emit: (inputs, context) => {
            if (!context.derivatives) return { outputs: { out: inputs.uv } };
            context.helper('mgTangentFrame');
            const frame = context.local('frame');
            const view = context.local('view');
            return {
                statements: [
                    `mat3 ${frame} = mgTangentFrame(-vViewPosition, mgViewNormal(), ${inputs.uv});`,
                    `vec3 ${view} = normalize(transpose(${frame}) * normalize(vViewPosition));`,
                ],
                outputs: { out: `(${inputs.uv} + ${view}.xy / max(${view}.z, 0.25) * (${inputs.height} - 0.5) * ${context.param('scale')})` },
            };
        },
    },

    // ------------------------------------------------------------------ Texture
    {
        type: 'texture',
        label: 'Texture Sample',
        category: 'Texture',
        description: 'Reads a texture at UV. Colour textures are decoded from sRGB to linear light; read masks, roughness, metalness and height as Data, which keeps the values as stored.',
        keywords: ['image', 'sampler', 'map', 'mask'],
        inputs: [{ key: 'uv', label: 'UV', type: 'vec2', fallback: builtin('uv') }],
        outputs: [
            { key: 'rgb', label: 'RGB', type: 'vec3' },
            { key: 'a', label: 'A', type: 'float' },
            { key: 'r', label: 'R', type: 'float' },
            { key: 'g', label: 'G', type: 'float' },
            { key: 'b', label: 'B', type: 'float' },
        ],
        params: [{ key: 'texture', label: 'Texture', kind: 'texture', default: '' }, select('space', 'Read As', [['color', 'Colour (sRGB)'], ['data', 'Data (masks, roughness, height)']])],
        emit: (inputs, context) => {
            const sample = context.local('sample');
            return {
                statements: [`vec4 ${sample} = texture(${context.param('texture')}, ${inputs.uv});`],
                outputs: { rgb: `${sample}.rgb`, a: `${sample}.a`, r: `${sample}.r`, g: `${sample}.g`, b: `${sample}.b` },
            };
        },
    },
    {
        type: 'normalMap',
        preview: 'normal',
        label: 'Normal Map',
        category: 'Texture',
        description: 'Reads a tangent-space normal map at UV, with a strength, for the Normal input. Maps baked for DirectX (green pointing down) need Flip Green.',
        inputs: [{ key: 'uv', label: 'UV', type: 'vec2', fallback: builtin('uv') }],
        outputs: [{ key: 'out', label: 'Normal', type: 'vec3' }],
        params: [
            { key: 'texture', label: 'Texture', kind: 'texture', default: '' },
            float('strength', 'Strength', 1, { min: 0, max: 4, step: 0.05 }),
            { key: 'flipGreen', label: 'Flip Green (DirectX)', kind: 'boolean', default: false },
        ],
        emit: (inputs, context) => {
            const normal = context.local('normal');
            return {
                statements: [
                    `vec3 ${normal} = texture(${context.param('texture')}, ${inputs.uv}).xyz * 2.0 - 1.0;`,
                    ...(context.static('flipGreen') === true ? [`${normal}.y = -${normal}.y;`] : []),
                    `${normal}.xy *= ${context.param('strength')};`,
                ],
                outputs: { out: `normalize(${normal})` },
            };
        },
    },
    {
        type: 'triplanar',
        label: 'Triplanar Sample',
        category: 'Texture',
        description: 'Projects a texture onto the surface from the three axes and blends them by the normal: textures cliffs, rocks and terrain without UVs or stretching.',
        keywords: ['world aligned', 'box mapping', 'projection'],
        inputs: [
            { key: 'position', label: 'Position', type: 'vec3', fallback: builtin('worldPosition') },
            { key: 'normal', label: 'Normal', type: 'vec3', fallback: builtin('worldNormal') },
        ],
        outputs: [
            { key: 'rgb', label: 'RGB', type: 'vec3' },
            { key: 'a', label: 'A', type: 'float' },
        ],
        params: [
            { key: 'texture', label: 'Texture', kind: 'texture', default: '' },
            float('tiling', 'Tiling (per unit)', 0.5, { min: 0.001, max: 100, step: 0.01 }),
            float('sharpness', 'Blend Sharpness', 4, { min: 1, max: 32, step: 0.5 }),
            select('space', 'Read As', [['color', 'Colour (sRGB)'], ['data', 'Data (masks, roughness, height)']]),
        ],
        emit: (inputs, context) => {
            const texture = context.param('texture');
            const tiling = context.param('tiling');
            const weights = context.local('weights');
            const position = context.local('position');
            const sample = context.local('sample');
            return {
                statements: [
                    `vec3 ${weights} = pow(abs(${inputs.normal}), vec3(${context.param('sharpness')}));`,
                    `${weights} /= max(${weights}.x + ${weights}.y + ${weights}.z, 1e-5);`,
                    `vec3 ${position} = ${inputs.position} * ${tiling};`,
                    `vec4 ${sample} = texture(${texture}, ${position}.zy) * ${weights}.x + texture(${texture}, ${position}.xz) * ${weights}.y + texture(${texture}, ${position}.xy) * ${weights}.z;`,
                ],
                outputs: { rgb: `${sample}.rgb`, a: `${sample}.a` },
            };
        },
    },
    {
        type: 'normalFromHeight',
        preview: 'normal',
        label: 'Normal From Height',
        category: 'Texture',
        description: 'A normal for the Normal input from a height (a noise, a texture channel): bumps without a normal map.',
        keywords: ['bump', 'height to normal'],
        inputs: [
            { key: 'height', label: 'Height', type: 'float', fallback: '0.0' },
            { key: 'uv', label: 'UV', type: 'vec2', fallback: builtin('uv') },
        ],
        outputs: [{ key: 'out', label: 'Normal', type: 'vec3' }],
        params: [float('strength', 'Strength', 1, { min: -16, max: 16, step: 0.05 })],
        emit: (inputs, context) => {
            if (!context.derivatives) return { outputs: { out: 'vec3(0.0, 0.0, 1.0)' } };
            context.helper('mgNormalFromHeight');
            return { outputs: { out: `mgNormalFromHeight(${inputs.height}, ${inputs.uv}, ${context.param('strength')})` } };
        },
    },
    {
        type: 'normalBlend',
        preview: 'normal',
        label: 'Normal Blend',
        category: 'Texture',
        description: 'Lays a detail normal on a base normal (reoriented normal mapping), both tangent space.',
        keywords: ['detail normal', 'combine normals'],
        inputs: [
            { key: 'base', label: 'Base', type: 'vec3', fallback: 'vec3(0.0, 0.0, 1.0)' },
            { key: 'detail', label: 'Detail', type: 'vec3', fallback: 'vec3(0.0, 0.0, 1.0)' },
        ],
        outputs: [{ key: 'out', label: 'Normal', type: 'vec3' }],
        params: [],
        emit: (inputs, context) => {
            context.helper('mgNormalBlend');
            return { outputs: { out: `mgNormalBlend(${inputs.base}, ${inputs.detail})` } };
        },
    },
    {
        type: 'normalStrength',
        preview: 'normal',
        label: 'Normal Strength',
        category: 'Texture',
        description: 'Flattens (below 1) or deepens (above 1) a tangent-space normal.',
        inputs: [{ key: 'in', label: 'Normal', type: 'vec3', fallback: 'vec3(0.0, 0.0, 1.0)' }],
        outputs: [{ key: 'out', label: 'Normal', type: 'vec3' }],
        params: [float('strength', 'Strength', 1, { min: 0, max: 8, step: 0.05 })],
        emit: (inputs, context) => ({ outputs: { out: `normalize(vec3(${inputs.in}.xy * ${context.param('strength')}, ${inputs.in}.z))` } }),
    },

    // ------------------------------------------------------------------ Procedural
    {
        type: 'noise',
        label: 'Noise',
        category: 'Procedural',
        description: 'Smooth value noise at UV times scale, from 0 to 1.',
        inputs: [{ key: 'uv', label: 'UV', type: 'vec2', fallback: builtin('uv') }],
        outputs: [{ key: 'out', label: 'Noise', type: 'float' }],
        params: [float('scale', 'Scale', 8, { min: 0.01, max: 1000, step: 0.1 })],
        emit: (inputs, context) => {
            context.helper('mgLegacyNoise');
            return { outputs: { out: `mgLegacyNoise(${inputs.uv} * ${context.param('scale')})` } };
        },
    },
    {
        type: 'fractalNoise',
        label: 'Fractal Noise',
        category: 'Procedural',
        description: 'Layered (fractal) gradient, simplex or value noise in 3D, from 0 to 1. Turbulence and ridged styles make clouds, marble and mountain ridges; feed World Position for seamless noise across objects.',
        keywords: ['fbm', 'perlin', 'simplex', 'gradient noise', 'clouds', 'turbulence', 'ridged'],
        inputs: [{ key: 'position', label: 'Position', type: 'vec3', fallback: builtin('uv') }],
        outputs: [{ key: 'out', label: 'Value', type: 'float' }],
        params: [
            select('noiseType', 'Noise', [['gradient', 'Gradient (Perlin)'], ['simplex', 'Simplex'], ['value', 'Value']]),
            select('style', 'Style', [['fbm', 'Fractal'], ['turbulence', 'Turbulence'], ['ridged', 'Ridged']]),
            float('scale', 'Scale', 4, { min: 0.001, max: 1000, step: 0.1 }),
            float('octaves', 'Octaves', 4, { min: 1, max: 8, step: 1 }),
            float('lacunarity', 'Lacunarity', 2, { min: 1, max: 4, step: 0.05 }),
            float('gain', 'Gain', 0.5, { min: 0, max: 1, step: 0.01 }),
            { key: 'offset', label: 'Offset', kind: 'vec3', default: [0, 0, 0] },
        ],
        emit: (inputs, context) => {
            const noise = { gradient: 'mgGradientNoise', simplex: 'mgSimplexNoise', value: 'mgValueNoise' }[String(context.static('noiseType'))] ?? 'mgGradientNoise';
            context.helper(noise);
            const style = context.static('style');
            const point = context.local('point');
            const sum = context.local('sum');
            const amplitude = context.local('amplitude');
            const total = context.local('total');
            const sample = context.local('sample');
            const term = style === 'turbulence' ? `abs(${sample} * 2.0 - 1.0)` : style === 'ridged' ? `pow(1.0 - abs(${sample} * 2.0 - 1.0), 2.0)` : sample;
            return {
                statements: [
                    `vec3 ${point} = (${inputs.position} + ${context.param('offset')}) * ${context.param('scale')};`,
                    `float ${sum} = 0.0;`,
                    `float ${amplitude} = 1.0;`,
                    `float ${total} = 0.0;`,
                    `for (int i = 0; i < 8; i++) {`,
                    `    if (float(i) >= ${context.param('octaves')}) break;`,
                    `    float ${sample} = ${noise}(${point});`,
                    `    ${sum} += ${amplitude} * ${term};`,
                    `    ${total} += ${amplitude};`,
                    `    ${amplitude} *= ${context.param('gain')};`,
                    `    ${point} = ${point} * ${context.param('lacunarity')} + vec3(17.31, 31.73, 7.13);`,
                    `}`,
                ],
                outputs: { out: `(${sum} / max(${total}, 1e-5))` },
            };
        },
    },
    {
        type: 'voronoi',
        label: 'Voronoi',
        category: 'Procedural',
        description: 'Cellular noise in 3D: the distance to the nearest cell point (spots, scales), the edge between cells (cracks, stones) and a random value and colour per cell.',
        keywords: ['worley', 'cellular', 'cells'],
        inputs: [{ key: 'position', label: 'Position', type: 'vec3', fallback: builtin('uv') }],
        outputs: [
            { key: 'distance', label: 'Distance', type: 'float' },
            { key: 'edge', label: 'Edge', type: 'float' },
            { key: 'cell', label: 'Cell', type: 'float' },
            { key: 'cellColor', label: 'Cell Color', type: 'vec3' },
        ],
        params: [
            float('scale', 'Scale', 5, { min: 0.001, max: 1000, step: 0.1 }),
            float('jitter', 'Randomness', 1, { min: 0, max: 1, step: 0.01 }),
        ],
        emit: (inputs, context) => {
            context.helper('mgVoronoi');
            const nearest = context.local('nearest');
            const second = context.local('second');
            const cell = context.local('cell');
            return {
                statements: [
                    `float ${nearest}; float ${second}; vec3 ${cell};`,
                    `mgVoronoi(${inputs.position} * ${context.param('scale')}, ${context.param('jitter')}, ${nearest}, ${second}, ${cell});`,
                ],
                outputs: { distance: nearest, edge: `(${second} - ${nearest})`, cell: `${cell}.x`, cellColor: cell },
            };
        },
    },
    {
        type: 'checker',
        label: 'Checker',
        category: 'Procedural',
        description: 'A checkerboard: 1 on one set of squares, 0 on the other.',
        keywords: ['checkerboard', 'grid'],
        inputs: [{ key: 'uv', label: 'UV', type: 'vec2', fallback: builtin('uv') }],
        outputs: [{ key: 'out', label: 'Mask', type: 'float' }],
        params: [{ key: 'frequency', label: 'Squares', kind: 'vec2', default: [8, 8] }],
        emit: (inputs, context) => {
            const cell = context.local('cell');
            return {
                statements: [`vec2 ${cell} = floor(${inputs.uv} * ${context.param('frequency')});`],
                outputs: { out: `mod(${cell}.x + ${cell}.y, 2.0)` },
            };
        },
    },
    {
        type: 'brick',
        label: 'Brick',
        category: 'Procedural',
        description: 'A brick wall: Mask is 1 on bricks and 0 in the mortar; each brick has its own random ID and its own UV.',
        keywords: ['tiles', 'masonry', 'wall'],
        inputs: [{ key: 'uv', label: 'UV', type: 'vec2', fallback: builtin('uv') }],
        outputs: [
            { key: 'mask', label: 'Mask', type: 'float' },
            { key: 'id', label: 'Brick ID', type: 'float' },
            { key: 'brickUv', label: 'Brick UV', type: 'vec2' },
        ],
        params: [
            { key: 'count', label: 'Bricks (across, up)', kind: 'vec2', default: [4, 8] },
            float('mortar', 'Mortar', 0.04, { min: 0, max: 0.45, step: 0.005 }),
            float('rowOffset', 'Row Offset', 0.5, { min: 0, max: 1, step: 0.01 }),
        ],
        emit: (inputs, context) => {
            context.helper('mgHash33');
            const grid = context.local('grid');
            const row = context.local('row');
            const cell = context.local('cell');
            const local = context.local('local');
            const mortar = context.param('mortar');
            return {
                statements: [
                    `vec2 ${grid} = ${inputs.uv} * ${context.param('count')};`,
                    `float ${row} = floor(${grid}.y);`,
                    `${grid}.x += ${row} * ${context.param('rowOffset')};`,
                    `vec2 ${cell} = floor(${grid});`,
                    `vec2 ${local} = fract(${grid});`,
                ],
                outputs: {
                    mask: `(step(${mortar}, ${local}.x) * step(${mortar}, ${local}.y) * step(${local}.x, 1.0 - ${mortar}) * step(${local}.y, 1.0 - ${mortar}))`,
                    id: `mgHash33(vec3(${cell}, 7.0)).x`,
                    brickUv: local,
                },
            };
        },
    },
    {
        type: 'gradient',
        label: 'Gradient',
        category: 'Procedural',
        description: 'A 0 to 1 ramp across the UVs: left to right, bottom to top, diagonal, or out from the centre.',
        keywords: ['ramp', 'linear', 'radial'],
        inputs: [{ key: 'uv', label: 'UV', type: 'vec2', fallback: builtin('uv') }],
        outputs: [{ key: 'out', label: 'Value', type: 'float' }],
        params: [select('shape', 'Shape', [['x', 'Left to right'], ['y', 'Bottom to top'], ['diagonal', 'Diagonal'], ['radial', 'Radial'], ['spherical', 'Spherical']])],
        emit: (inputs, context) => {
            const uv = inputs.uv;
            switch (context.static('shape')) {
                case 'y': return { outputs: { out: `clamp(${uv}.y, 0.0, 1.0)` } };
                case 'diagonal': return { outputs: { out: `clamp((${uv}.x + ${uv}.y) * 0.5, 0.0, 1.0)` } };
                case 'radial': return { outputs: { out: `clamp(length(${uv} - 0.5) * 2.0, 0.0, 1.0)` } };
                case 'spherical': return { outputs: { out: `sqrt(max(1.0 - dot((${uv} - 0.5) * 2.0, (${uv} - 0.5) * 2.0), 0.0))` } };
                default: return { outputs: { out: `clamp(${uv}.x, 0.0, 1.0)` } };
            }
        },
    },

    // ------------------------------------------------------------------ Color
    {
        type: 'colorRamp',
        label: 'Color Ramp',
        category: 'Color',
        description: 'Maps a 0 to 1 value to colours along a ramp of up to 8 stops: tints a noise, a mask or a gradient.',
        keywords: ['gradient map', 'color curve', 'lut'],
        inputs: [{ key: 'fac', label: 'Value', type: 'float', fallback: '0.5' }],
        outputs: [{ key: 'out', label: 'Color', type: 'vec3' }],
        params: [
            { key: 'ramp', label: 'Ramp', kind: 'ramp', default: { stops: [{ position: 0, color: [0, 0, 0] }, { position: 1, color: [1, 1, 1] }] } },
            select('interpolation', 'Interpolation', [['linear', 'Linear'], ['constant', 'Constant'], ['smooth', 'Smooth']]),
        ],
        emit: (inputs, context) => {
            context.helper('mgRamp');
            const mode = { constant: 1, smooth: 2 }[String(context.static('interpolation'))] ?? 0;
            return { outputs: { out: `mgRamp(${context.param('ramp')}, ${inputs.fac}, ${mode})` } };
        },
    },
    {
        type: 'blend',
        label: 'Blend',
        category: 'Color',
        description: 'Lays Blend over Base with a blend mode (multiply, screen, overlay, ...) at an opacity.',
        keywords: ['layer', 'multiply', 'screen', 'overlay', 'mix colors'],
        inputs: [
            { key: 'base', label: 'Base', type: 'vec3', fallback: fromParam('base') },
            { key: 'blend', label: 'Blend', type: 'vec3', fallback: fromParam('blend') },
            { key: 'opacity', label: 'Opacity', type: 'float', fallback: fromParam('opacity') },
        ],
        outputs: [{ key: 'out', label: 'Color', type: 'vec3' }],
        params: [
            select('mode', 'Mode', BLEND_MODES, 'multiply'),
            { key: 'base', label: 'Base', kind: 'color', default: [0.5, 0.5, 0.5] },
            { key: 'blend', label: 'Blend', kind: 'color', default: [1, 1, 1] },
            float('opacity', 'Opacity', 1, { min: 0, max: 1, step: 0.01 }),
        ],
        emit: (inputs, context) => {
            const base = context.local('base');
            const blended = blendExpression(String(context.static('mode')), base, inputs.blend, context);
            return {
                statements: [`vec3 ${base} = ${inputs.base};`],
                outputs: { out: `mix(${base}, ${blended}, clamp(${inputs.opacity}, 0.0, 1.0))` },
            };
        },
    },
    {
        type: 'hsvAdjust',
        label: 'Hue / Saturation / Value',
        category: 'Color',
        description: 'Shifts the hue and scales the saturation and brightness of a colour.',
        keywords: ['hsv', 'hue shift', 'saturation'],
        inputs: [{ key: 'color', label: 'Color', type: 'vec3', fallback: 'vec3(1.0)' }],
        outputs: [{ key: 'out', label: 'Color', type: 'vec3' }],
        params: [
            float('hue', 'Hue Shift', 0, { min: -0.5, max: 0.5, step: 0.01 }),
            float('saturation', 'Saturation', 1, { min: 0, max: 3, step: 0.01 }),
            float('brightness', 'Value', 1, { min: 0, max: 3, step: 0.01 }),
        ],
        emit: (inputs, context) => {
            context.helper('mgRgbToHsv');
            context.helper('mgHsvToRgb');
            const hsv = context.local('hsv');
            return {
                statements: [`vec3 ${hsv} = mgRgbToHsv(max(${inputs.color}, vec3(0.0)));`],
                outputs: { out: `mgHsvToRgb(vec3(fract(${hsv}.x + ${context.param('hue')}), clamp(${hsv}.y * ${context.param('saturation')}, 0.0, 1.0), ${hsv}.z * ${context.param('brightness')}))` },
            };
        },
    },
    {
        type: 'rgbToHsv',
        label: 'RGB to HSV',
        category: 'Color',
        description: 'Hue, saturation and value (each 0 to 1) of a colour.',
        inputs: [{ key: 'color', label: 'Color', type: 'vec3', fallback: 'vec3(1.0)' }],
        outputs: [{ key: 'out', label: 'HSV', type: 'vec3' }],
        params: [],
        emit: (inputs, context) => {
            context.helper('mgRgbToHsv');
            return { outputs: { out: `mgRgbToHsv(max(${inputs.color}, vec3(0.0)))` } };
        },
    },
    {
        type: 'hsvToRgb',
        label: 'HSV to RGB',
        category: 'Color',
        description: 'The colour of a hue, saturation and value (each 0 to 1).',
        inputs: [{ key: 'hsv', label: 'HSV', type: 'vec3', fallback: 'vec3(0.0, 1.0, 1.0)' }],
        outputs: [{ key: 'out', label: 'Color', type: 'vec3' }],
        params: [],
        emit: (inputs, context) => {
            context.helper('mgHsvToRgb');
            return { outputs: { out: `mgHsvToRgb(${inputs.hsv})` } };
        },
    },
    {
        type: 'desaturate',
        label: 'Desaturate',
        category: 'Color',
        description: 'Fades a colour towards grey by Amount.',
        keywords: ['grayscale', 'greyscale'],
        inputs: [{ key: 'color', label: 'Color', type: 'vec3', fallback: 'vec3(1.0)' }],
        outputs: [{ key: 'out', label: 'Color', type: 'vec3' }],
        params: [float('amount', 'Amount', 1, { min: 0, max: 1, step: 0.01 })],
        emit: (inputs, context) => {
            context.helper('mgLuminance');
            return { outputs: { out: `mix(${inputs.color}, vec3(mgLuminance(${inputs.color})), ${context.param('amount')})` } };
        },
    },
    {
        type: 'contrast',
        label: 'Contrast',
        category: 'Color',
        description: 'Pushes values away from (above 1) or towards (below 1) middle grey.',
        inputs: [auto('in', 'In', value(0.5))],
        outputs: [{ key: 'out', label: 'Result', type: 'auto' }],
        params: [float('contrast', 'Contrast', 1, { min: 0, max: 4, step: 0.01 })],
        emit: (inputs, context) => ({ outputs: { out: `max((${inputs.in} - 0.5) * ${context.param('contrast')} + 0.5, ${context.splat(0)})` } }),
    },
    {
        type: 'posterize',
        label: 'Posterize',
        category: 'Color',
        description: 'Rounds values down to a number of Steps: banded, cel-shaded and pixel looks.',
        keywords: ['quantize', 'bands', 'steps'],
        inputs: [auto('in', 'In', value(0))],
        outputs: [{ key: 'out', label: 'Result', type: 'auto' }],
        params: [float('steps', 'Steps', 4, { min: 1, max: 64, step: 1 })],
        emit: (inputs, context) => ({ outputs: { out: `(floor(${inputs.in} * ${context.param('steps')}) / ${context.param('steps')})` } }),
    },
    {
        type: 'luminance',
        label: 'Luminance',
        category: 'Color',
        description: 'How bright a colour looks, as one number.',
        keywords: ['brightness', 'luma'],
        inputs: [{ key: 'color', label: 'Color', type: 'vec3', fallback: 'vec3(1.0)' }],
        outputs: [{ key: 'out', label: 'Luminance', type: 'float' }],
        params: [],
        emit: (inputs, context) => {
            context.helper('mgLuminance');
            return { outputs: { out: `mgLuminance(${inputs.color})` } };
        },
    },

    // ------------------------------------------------------------------ Math
    binary('add', 'Add', 'A + B.', (a, b) => `(${a} + ${b})`, [0, 0], ['plus', 'sum']),
    binary('subtract', 'Subtract', 'A - B.', (a, b) => `(${a} - ${b})`, [0, 0], ['minus', 'difference']),
    binary('multiply', 'Multiply', 'A × B, component by component.', (a, b) => `(${a} * ${b})`, [1, 1], ['times', 'product']),
    binary('divide', 'Divide', 'A ÷ B, component by component.', (a, b) => `(${a} / ${b})`, [1, 1]),
    binary('min', 'Min', 'The smaller of A and B.', (a, b) => `min(${a}, ${b})`, [0, 0], ['minimum']),
    binary('max', 'Max', 'The larger of A and B.', (a, b) => `max(${a}, ${b})`, [0, 0], ['maximum']),
    binary('power', 'Power', 'A raised to B.', (a, b, context) => `pow(max(${a}, ${context.splat(0)}), ${b})`, [1, 2], ['exponent']),
    binary('step', 'Step', '1 where B is at least A, else 0.', (a, b) => `step(${a}, ${b})`, [0.5, 0], ['threshold']),
    binary('modulo', 'Modulo', 'The remainder of A ÷ B (repeating patterns).', (a, b) => `mod(${a}, ${b})`, [0, 1], ['mod', 'remainder', 'repeat']),
    binary('arctangent2', 'Arctangent 2', 'The angle (radians) of the point (B, A).', (a, b) => `atan(${a}, ${b})`, [0, 1], ['atan2', 'angle']),
    {
        type: 'lerp',
        label: 'Lerp',
        category: 'Math',
        description: 'Blends from A to B by T (0 gives A, 1 gives B).',
        keywords: ['mix', 'interpolate', 'blend'],
        inputs: [auto('a', 'A', fromParam('a')), auto('b', 'B', fromParam('b')), auto('t', 'T', fromParam('t'))],
        outputs: [{ key: 'out', label: 'Result', type: 'auto' }],
        params: [float('a', 'A', 0), float('b', 'B', 1), float('t', 'T', 0.5, { min: 0, max: 1, step: 0.01 })],
        emit: (inputs) => ({ outputs: { out: `mix(${inputs.a}, ${inputs.b}, ${inputs.t})` } }),
    },
    {
        type: 'clamp',
        label: 'Clamp',
        category: 'Math',
        description: 'Keeps the value between Min and Max.',
        inputs: [auto('in', 'In', value(0))],
        outputs: [{ key: 'out', label: 'Result', type: 'auto' }],
        params: [float('min', 'Min', 0), float('max', 'Max', 1)],
        emit: (inputs, context) => ({ outputs: { out: `clamp(${inputs.in}, ${context.splat(context.param('min'))}, ${context.splat(context.param('max'))})` } }),
    },
    {
        type: 'smoothstep',
        label: 'Smoothstep',
        category: 'Math',
        description: 'A smooth 0 to 1 ramp as the value goes from Edge 0 to Edge 1.',
        inputs: [auto('in', 'In', value(0))],
        outputs: [{ key: 'out', label: 'Result', type: 'auto' }],
        params: [float('edge0', 'Edge 0', 0), float('edge1', 'Edge 1', 1)],
        emit: (inputs, context) => ({ outputs: { out: `smoothstep(${context.splat(context.param('edge0'))}, ${context.splat(context.param('edge1'))}, ${inputs.in})` } }),
    },
    {
        type: 'remap',
        label: 'Remap',
        category: 'Math',
        description: 'Maps a value from one range to another (In Min to In Max becomes Out Min to Out Max).',
        keywords: ['range', 'map range', 'scale'],
        inputs: [auto('in', 'In', value(0))],
        outputs: [{ key: 'out', label: 'Result', type: 'auto' }],
        params: [float('inMin', 'In Min', 0), float('inMax', 'In Max', 1), float('outMin', 'Out Min', 0), float('outMax', 'Out Max', 1), { key: 'clamped', label: 'Clamp', kind: 'boolean', default: false }],
        emit: (inputs, context) => {
            const p = (key: string) => context.param(key);
            const mapped = `(${p('outMin')} + (${inputs.in} - ${p('inMin')}) * (${p('outMax')} - ${p('outMin')}) / (${p('inMax')} - ${p('inMin')}))`;
            return {
                outputs: {
                    out: context.static('clamped') === true
                        ? `clamp(${mapped}, ${context.splat(`min(${p('outMin')}, ${p('outMax')})`)}, ${context.splat(`max(${p('outMin')}, ${p('outMax')})`)})`
                        : mapped,
                },
            };
        },
    },
    {
        type: 'inverseLerp',
        label: 'Inverse Lerp',
        category: 'Math',
        description: 'Where Value lies between A (0) and B (1).',
        inputs: [auto('a', 'A', fromParam('a')), auto('b', 'B', fromParam('b')), auto('value', 'Value', value(0.5))],
        outputs: [{ key: 'out', label: 'T', type: 'auto' }],
        params: [float('a', 'A', 0), float('b', 'B', 1)],
        emit: (inputs) => ({ outputs: { out: `((${inputs.value} - ${inputs.a}) / (${inputs.b} - ${inputs.a}))` } }),
    },
    unary('oneMinus', 'One Minus', '1 - In.', (a, context) => `(${context.splat(1)} - ${a})`, ['invert']),
    unary('abs', 'Abs', 'The value without its sign.', (a) => `abs(${a})`, ['absolute']),
    unary('saturate', 'Saturate', 'Clamps between 0 and 1.', (a, context) => `clamp(${a}, ${context.splat(0)}, ${context.splat(1)})`, ['clamp01']),
    unary('negate', 'Negate', '-In.', (a) => `(-${a})`, ['minus']),
    unary('reciprocal', 'Reciprocal', '1 ÷ In.', (a, context) => `(${context.splat(1)} / ${a})`, ['inverse']),
    unary('sine', 'Sine', 'sin(In), In in radians.', (a) => `sin(${a})`, ['sin', 'wave']),
    unary('cosine', 'Cosine', 'cos(In), In in radians.', (a) => `cos(${a})`, ['cos']),
    unary('tangent', 'Tangent', 'tan(In), In in radians.', (a) => `tan(${a})`, ['tan']),
    unary('arcsine', 'Arcsine', 'asin(In), in radians.', (a, context) => `asin(clamp(${a}, ${context.splat(-1)}, ${context.splat(1)}))`, ['asin']),
    unary('arccosine', 'Arccosine', 'acos(In), in radians.', (a, context) => `acos(clamp(${a}, ${context.splat(-1)}, ${context.splat(1)}))`, ['acos']),
    unary('arctangent', 'Arctangent', 'atan(In), in radians.', (a) => `atan(${a})`, ['atan']),
    unary('fract', 'Fraction', 'The part after the decimal point.', (a) => `fract(${a})`, ['frac']),
    unary('floor', 'Floor', 'Rounds down.', (a) => `floor(${a})`),
    unary('ceil', 'Ceiling', 'Rounds up.', (a) => `ceil(${a})`, ['ceil', 'round up']),
    unary('round', 'Round', 'Rounds to the nearest whole number.', (a) => `floor(${a} + 0.5)`),
    unary('sign', 'Sign', '-1, 0 or 1 by the sign of In.', (a) => `sign(${a})`),
    unary('squareRoot', 'Square Root', 'The square root of In.', (a, context) => `sqrt(max(${a}, ${context.splat(0)}))`, ['sqrt']),
    unary('exponential', 'Exponential', 'e raised to In.', (a) => `exp(${a})`, ['exp']),
    unary('logarithm', 'Logarithm', 'The natural logarithm of In.', (a, context) => `log(max(${a}, ${context.splat(1e-8)}))`, ['log', 'ln']),

    // ------------------------------------------------------------------ Vector
    {
        type: 'split',
        label: 'Split',
        category: 'Vector',
        description: 'The components of a vector.',
        keywords: ['break', 'components', 'channels'],
        inputs: [{ key: 'in', label: 'In', type: 'vec4', fallback: 'vec4(0.0)' }],
        outputs: [
            { key: 'x', label: 'X / R', type: 'float' },
            { key: 'y', label: 'Y / G', type: 'float' },
            { key: 'z', label: 'Z / B', type: 'float' },
            { key: 'w', label: 'W / A', type: 'float' },
        ],
        params: [],
        emit: (inputs, context) => {
            const v = context.local('value');
            return { statements: [`vec4 ${v} = ${inputs.in};`], outputs: { x: `${v}.x`, y: `${v}.y`, z: `${v}.z`, w: `${v}.w` } };
        },
    },
    {
        type: 'combine',
        label: 'Combine',
        category: 'Vector',
        description: 'A vector from its components.',
        keywords: ['append', 'make vector', 'merge'],
        inputs: [
            { key: 'x', label: 'X / R', type: 'float', fallback: '0.0' },
            { key: 'y', label: 'Y / G', type: 'float', fallback: '0.0' },
            { key: 'z', label: 'Z / B', type: 'float', fallback: '0.0' },
            { key: 'w', label: 'W / A', type: 'float', fallback: '1.0' },
        ],
        outputs: [{ key: 'out', label: 'Vector', type: 'vec4' }],
        params: [],
        emit: (inputs) => ({ outputs: { out: `vec4(${inputs.x}, ${inputs.y}, ${inputs.z}, ${inputs.w})` } }),
    },
    {
        type: 'swizzle',
        label: 'Swizzle',
        category: 'Vector',
        description: 'Picks and reorders components by a mask such as zyx, xy or rrr (component mask).',
        keywords: ['component mask', 'reorder', 'channels'],
        inputs: [{ key: 'in', label: 'In', type: 'vec4', fallback: 'vec4(0.0)' }],
        outputs: [{ key: 'out', label: 'Result', type: 'auto' }],
        params: [{ key: 'mask', label: 'Mask', kind: 'code', default: 'xyz' }],
        autoType: (statics) => (['float', 'vec2', 'vec3', 'vec4'] as const)[swizzleMask(statics.mask).length - 1],
        emit: (inputs, context) => ({ outputs: { out: `(${inputs.in}).${swizzleMask(context.static('mask'))}` } }),
    },
    {
        type: 'dot',
        label: 'Dot',
        category: 'Vector',
        description: 'The dot product of A and B.',
        keywords: ['dot product'],
        inputs: [
            { key: 'a', label: 'A', type: 'vec3', fallback: 'vec3(0.0)' },
            { key: 'b', label: 'B', type: 'vec3', fallback: 'vec3(0.0)' },
        ],
        outputs: [{ key: 'out', label: 'Result', type: 'float' }],
        params: [],
        emit: (inputs) => ({ outputs: { out: `dot(${inputs.a}, ${inputs.b})` } }),
    },
    {
        type: 'cross',
        label: 'Cross',
        category: 'Vector',
        description: 'The cross product of A and B: at right angles to both.',
        keywords: ['cross product'],
        inputs: [
            { key: 'a', label: 'A', type: 'vec3', fallback: 'vec3(1.0, 0.0, 0.0)' },
            { key: 'b', label: 'B', type: 'vec3', fallback: 'vec3(0.0, 1.0, 0.0)' },
        ],
        outputs: [{ key: 'out', label: 'Result', type: 'vec3' }],
        params: [],
        emit: (inputs) => ({ outputs: { out: `cross(${inputs.a}, ${inputs.b})` } }),
    },
    {
        type: 'normalize',
        label: 'Normalize',
        category: 'Vector',
        description: 'The vector at length 1.',
        keywords: ['unit vector'],
        inputs: [{ key: 'in', label: 'In', type: 'vec3', fallback: 'vec3(0.0, 0.0, 1.0)' }],
        outputs: [{ key: 'out', label: 'Result', type: 'vec3' }],
        params: [],
        emit: (inputs) => ({ outputs: { out: `normalize(${inputs.in})` } }),
    },
    {
        type: 'length',
        label: 'Length',
        category: 'Vector',
        description: "The vector's length.",
        keywords: ['magnitude'],
        inputs: [{ key: 'in', label: 'In', type: 'vec3', fallback: 'vec3(0.0)' }],
        outputs: [{ key: 'out', label: 'Length', type: 'float' }],
        params: [],
        emit: (inputs) => ({ outputs: { out: `length(${inputs.in})` } }),
    },
    {
        type: 'distance',
        label: 'Distance',
        category: 'Vector',
        description: 'How far apart A and B are.',
        inputs: [
            { key: 'a', label: 'A', type: 'vec3', fallback: 'vec3(0.0)' },
            { key: 'b', label: 'B', type: 'vec3', fallback: 'vec3(0.0)' },
        ],
        outputs: [{ key: 'out', label: 'Distance', type: 'float' }],
        params: [],
        emit: (inputs) => ({ outputs: { out: `distance(${inputs.a}, ${inputs.b})` } }),
    },
    {
        type: 'reflect',
        label: 'Reflect',
        category: 'Vector',
        description: 'A direction bounced off a surface with normal Normal.',
        inputs: [
            { key: 'direction', label: 'Direction', type: 'vec3', fallback: 'vec3(0.0, -1.0, 0.0)' },
            { key: 'normal', label: 'Normal', type: 'vec3', fallback: 'vec3(0.0, 1.0, 0.0)' },
        ],
        outputs: [{ key: 'out', label: 'Result', type: 'vec3' }],
        params: [],
        emit: (inputs) => ({ outputs: { out: `reflect(${inputs.direction}, normalize(${inputs.normal}))` } }),
    },
    {
        type: 'rotateAboutAxis',
        label: 'Rotate About Axis',
        category: 'Vector',
        description: 'Turns a position about an axis through a pivot, by Angle degrees: swaying, spinning and bending in World Position Offset.',
        keywords: ['rotate position', 'spin', 'wind'],
        inputs: [
            { key: 'position', label: 'Position', type: 'vec3', fallback: builtin('worldPosition') },
            { key: 'angle', label: 'Angle (degrees)', type: 'float', fallback: fromParam('angle') },
        ],
        outputs: [{ key: 'out', label: 'Position', type: 'vec3' }],
        params: [
            float('angle', 'Angle (degrees)', 0, { step: 1 }),
            { key: 'axis', label: 'Axis', kind: 'vec3', default: [0, 1, 0] },
            { key: 'pivot', label: 'Pivot', kind: 'vec3', default: [0, 0, 0] },
        ],
        emit: (inputs, context) => {
            const axis = context.local('axis');
            const p = context.local('p');
            const a = context.local('a');
            return {
                statements: [
                    `vec3 ${axis} = normalize(${context.param('axis')} + vec3(0.0, 1e-6, 0.0));`,
                    `vec3 ${p} = ${inputs.position} - ${context.param('pivot')};`,
                    `float ${a} = radians(${inputs.angle});`,
                ],
                // Rodrigues' rotation formula.
                outputs: { out: `(${p} * cos(${a}) + cross(${axis}, ${p}) * sin(${a}) + ${axis} * dot(${axis}, ${p}) * (1.0 - cos(${a})) + ${context.param('pivot')})` },
            };
        },
    },

    // ------------------------------------------------------------------ Logic
    {
        type: 'branch',
        label: 'Branch',
        category: 'Logic',
        description: 'True where the comparison of A and B holds, else False (if / compare).',
        keywords: ['if', 'compare', 'condition', 'switch'],
        inputs: [
            { key: 'a', label: 'A', type: 'float', fallback: fromParam('a') },
            { key: 'b', label: 'B', type: 'float', fallback: fromParam('b') },
            auto('whenTrue', 'True', value(1)),
            auto('whenFalse', 'False', value(0)),
        ],
        outputs: [{ key: 'out', label: 'Result', type: 'auto' }],
        params: [select('comparison', 'Comparison', COMPARISONS), float('a', 'A', 0), float('b', 'B', 0.5)],
        emit: (inputs, context) => {
            const operator = COMPARISONS.some(([op]) => op === context.static('comparison')) ? String(context.static('comparison')) : '>';
            return { outputs: { out: `((${inputs.a} ${operator} ${inputs.b}) ? ${inputs.whenTrue} : ${inputs.whenFalse})` } };
        },
    },

    // ------------------------------------------------------------------ Custom
    {
        type: 'customGlsl',
        label: 'Custom GLSL',
        category: 'Custom',
        description: 'Your own GLSL: the body of a function of the vec4 inputs a, b, c and d (and uMaterialTime) returning the output type, e.g. "return a * b.x;". A single expression without return works too.',
        keywords: ['code', 'shader', 'expression', 'custom node'],
        inputs: [
            { key: 'a', label: 'a', type: 'vec4', fallback: 'vec4(0.0)' },
            { key: 'b', label: 'b', type: 'vec4', fallback: 'vec4(0.0)' },
            { key: 'c', label: 'c', type: 'vec4', fallback: 'vec4(0.0)' },
            { key: 'd', label: 'd', type: 'vec4', fallback: 'vec4(0.0)' },
        ],
        outputs: [{ key: 'out', label: 'Result', type: 'auto' }],
        params: [
            select('outputType', 'Output Type', CUSTOM_TYPES, 'vec3'),
            { key: 'code', label: 'Code', kind: 'code', default: 'return a.rgb;' },
        ],
        autoType: (statics) => customOutputType(statics.outputType),
        emit: (inputs, context) => {
            const type = customOutputType(context.static('outputType'));
            const name = context.local('fn');
            const code = String(context.static('code') ?? '');
            const body = /\breturn\b/.test(code) ? code : `return ${type}(${code.trim() || '0.0'});`;
            // Code reading the time changes every frame: say so, as a Time node would.
            if (/\buMaterialTime\b/.test(code)) context.builtin('time');
            context.global(`${type} ${name}(vec4 a, vec4 b, vec4 c, vec4 d) {\n${body}\n}`);
            return { outputs: { out: `${name}(${inputs.a}, ${inputs.b}, ${inputs.c}, ${inputs.d})` } };
        },
    },

    // ------------------------------------------------------------------ Utility
    {
        type: REROUTE_NODE_TYPE,
        label: 'Reroute',
        category: 'Utility',
        description: 'Passes its value through unchanged: a point to bend a wire around other nodes.',
        keywords: ['wire', 'knot', 'dot', 'pass through'],
        inputs: [auto('in', '', value(0))],
        outputs: [{ key: 'out', label: '', type: 'auto' }],
        params: [],
        emit: (inputs) => ({ outputs: { out: inputs.in } }),
    },
];

/** A valid swizzle mask (xyz by default), in xyzw letters. */
export const swizzleMask = (value: unknown): string => {
    const mask = typeof value === 'string' && SWIZZLE.test(value) ? value : 'xyz';
    return mask.replace(/[rgba]/g, (letter) => ({ r: 'x', g: 'y', b: 'z', a: 'w' }[letter] as string));
};

const customOutputType = (value: unknown): MaterialValueType =>
    CUSTOM_TYPES.some(([type]) => type === value) ? value as MaterialValueType : 'vec3';
