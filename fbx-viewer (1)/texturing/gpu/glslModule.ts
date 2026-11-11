import { GLSL_SUPPORT_WGSL, GlslError, GlslTranslator, RESERVED, wgslType, type GlslContext } from '../../renderer/gpu/surfaces/glslToWgsl';
import { wgslFunctionLibrary } from '../graph/functionGraph';
import { GLSL_LIBRARY } from './glslLibrary';
import type { UniformField } from './uniformLayout';

/**
 * A TEXTURING PASS IN WGSL
 *
 * A texturing pass is a whole GLSL fragment shader: the shared library, the kit's declarations (its
 * inputs' readers, settings and seeds) and the node's own functions and main. The renderer's
 * translator (glslToWgsl.ts) takes function bodies; this reads the shader's top level around it:
 * #define lines, uniforms (gathered into one struct in a storage buffer), samplers (each a texture and
 * a sampler binding), constants and functions (overloads given names of their own), and writes a
 * WGSL module with a full-screen vertex stage and a fragment stage that calls the translated main.
 * Library functions that do not translate are left out, so only a pass that calls one fails, and
 * says which and why. A pass made by a function graph brings its own WGSL (functionGraph.ts' writer)
 * in place of its translated function and main.
 */

/** A pass's own WGSL from a function graph: its functions, and the expression giving the pixel's colour. */
export interface WgslBody {
    functions: string;
    result: string;
}

export interface PassModuleInput {
    /** The fragment as the WebGL path compiles it after the prelude: kit declarations, then the node's code. */
    fragment: string;
    /** The textures bound to the pass, by name (samplers the code does not declare are declared for it). */
    inputs: readonly string[];
    /** The pass's own WGSL (a function graph's), replacing its GLSL function `fn_result` and main. */
    wgsl?: WgslBody;
    /** An instanced square/point pass using the same uniforms, textures and GLSL helper library. */
    instances?: {
        vertex: string;
        varyings: readonly string[];
        points: boolean;
        /** The height-winning pass writes a hardware depth value. */
        depth: boolean;
    };
}

export interface PassModule {
    code: string;
    /** The uniform struct's fields, in order (uSize first). */
    uniforms: UniformField[];
    /** Textures in binding order: texture at 1 + 2i, its sampler at 2 + 2i. */
    textures: string[];
}

/** Names of the WGSL helpers the library writes, by the GLSL function they stand in for. */
const PRELUDE_UNIFORMS: UniformField[] = [{ name: 'uSize', type: 'vec2' }];

/** A uniform's (or constant's) name in the WGSL: as in GLSL, unless WGSL keeps the word. */
export const wgslName = (name: string): string => (RESERVED.has(name) ? `${name}_` : name);

const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');

/** #define lines taken out and their names replaced; any other preprocessor line is refused. */
const preprocess = (source: string): string => {
    const defines = new Map<string, string>();
    const lines = source.split('\n').filter((line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('#')) return true;
        const define = /^#\s*define\s+([A-Za-z_]\w*)\s+(.+)$/.exec(trimmed);
        if (!define) throw new GlslError(`the preprocessor line "${trimmed}" is not translated`);
        defines.set(define[1], define[2].trim());
        return false;
    });
    let text = lines.join('\n');
    for (let round = 0; round < 4 && defines.size; round++) {
        for (const [name, value] of defines) text = text.replace(new RegExp(`\\b${name}\\b`, 'g'), `(${value})`);
    }
    return text;
};

interface TopItem { text: string; braces: boolean }

/** The shader's top level: statements ending in ";" and functions (or structs) ending in "}". */
const topLevel = (source: string): TopItem[] => {
    const items: TopItem[] = [];
    let depth = 0;
    let start = 0;
    let braces = false;
    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        if (char === '{') { depth++; braces = true; }
        else if (char === '}') {
            depth--;
            if (depth === 0) {
                // A struct ends at its ";"; a function at its "}".
                const text = source.slice(start, index + 1).trim();
                if (!/^struct\b/.test(text)) { items.push({ text, braces: true }); start = index + 1; braces = false; }
            }
        } else if (char === ';' && depth === 0) {
            const text = source.slice(start, index + 1).trim();
            if (text !== ';') items.push({ text, braces });
            start = index + 1;
            braces = false;
        }
    }
    if (source.slice(start).trim()) throw new GlslError('the shader ends part way through a statement');
    return items;
};

const UNIFORM = /^uniform\s+(?:(?:highp|mediump|lowp)\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(?:\[\s*(\d+)\s*\])?\s*;$/;
const FUNCTION = /^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(/;
const CONSTANT = /^const\s+([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(?:\[\s*(\d+)\s*\])?\s*=\s*([\s\S]+);$/;

/** The GLSL type of a uniform field as the storage struct holds it (no booleans in shared buffers). */
const storedType = (type: string): string => type.replace(/^bool/, 'uint').replace(/^bvec/, 'uvec');

/**
 * The pass as a WGSL module. Throws GlslError (with the reason in words) when something in it the
 * pass needs does not translate.
 */
export const translatePass = (input: PassModuleInput): PassModule => {
    const instances = input.instances;
    const varyings = (instances?.varyings ?? []).map((entry) => {
        const found = /^(flat\s+)?(float|int|uint|vec[234]|ivec[234]|uvec[234])\s+([A-Za-z_]\w*)$/.exec(entry.trim());
        if (!found) throw new GlslError(`unknown instanced varying "${entry}"`);
        return { name: found[3], type: found[2], flat: Boolean(found[1]) || found[2] === 'int' || found[2] === 'uint' };
    });
    const source = preprocess(stripComments(`${GLSL_LIBRARY}\n${instances?.vertex ?? ''}\n${input.fragment}`));
    const items = topLevel(source);
    const uniforms: UniformField[] = [...PRELUDE_UNIFORMS, ...(instances ? [{ name: 'uWrap', type: 'ivec2' }] : [])];
    const samplers: string[] = [];
    const constants: Array<{ name: string; type: string; value: string }> = [];
    const functions: Array<{ name: string; text: string; library: boolean }> = [];
    const librarySize = topLevel(preprocess(stripComments(GLSL_LIBRARY))).length;
    items.forEach((item, index) => {
        const text = item.text;
        if (/^(?:in|out|precision|layout)\b/.test(text)) return;
        const uniform = UNIFORM.exec(text);
        if (uniform) {
            const [, type, name, size] = uniform;
            if (type === 'sampler2D') { if (!samplers.includes(name)) samplers.push(name); return; }
            if (!uniforms.some((field) => field.name === name)) uniforms.push({ name, type: size ? `${type}[${size}]` : type });
            return;
        }
        if (/^struct\b/.test(text)) throw new GlslError('a struct is not translated yet');
        const constant = CONSTANT.exec(text);
        if (constant) {
            const [, type, name, size, value] = constant;
            constants.push({ name, type: size ? `${type}[${size}]` : type, value });
            return;
        }
        const fn = FUNCTION.exec(text);
        if (fn && item.braces) { functions.push({ name: fn[2], text, library: index < librarySize }); return; }
        if (fn && text.endsWith(');')) return;
        throw new GlslError(`"${text.slice(0, 60)}" is not translated`);
    });
    for (const name of input.inputs) if (!samplers.includes(name)) samplers.push(name);

    const called = new Set<string>();
    const context: GlslContext = {
        stage: 'fragment',
        variables: {
            vUv: { code: 'vUv_', type: 'vec2' },
            outColor: { code: 'outColor_', type: 'vec4' },
            gl_FragCoord: { code: 'fragCoord_', type: 'vec4' },
            ...(instances ? {
                gl_Position: { code: 'glPosition_', type: 'vec4' },
                gl_FragDepth: { code: 'fragDepth_', type: 'float' },
                ...Object.fromEntries(varyings.map((varying) => [varying.name, { code: `v_${varying.name}`, type: varying.type }])),
            } : {}),
            ...Object.fromEntries(uniforms.map((field) => [field.name, { code: wgslName(field.name), type: field.type }])),
            ...Object.fromEntries(constants.map((constant) => [constant.name, { code: wgslName(constant.name), type: constant.type }])),
        },
        textures: Object.fromEntries(samplers.map((name) => [name, { texture: `T_${name}`, sampler: `S_${name}` }])),
        functions: {},
        functionPrefix: 'gf_',
        called: (name) => called.add(name),
    };
    const translator = new GlslTranslator(context);
    const written: string[] = [];
    const failed = new Map<string, string>();
    const skipped = new Set(input.wgsl ? ['fn_result', 'main'] : []);
    for (const fn of functions) {
        if (skipped.has(fn.name)) continue;
        const text = fn.name === 'main' ? fn.text.replace(/^void\s+main\s*\(/, 'void glsl_main(') : fn.text;
        try {
            written.push(translator.fn(text));
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            // A library function that does not translate is left out; the pass fails only if it calls it.
            if (fn.library) { failed.set(fn.name, reason); continue; }
            const missing = /unknown function (\w+)\(\)/.exec(reason)?.[1];
            throw new GlslError(missing && failed.has(missing) ? `${fn.name}() calls ${missing}(), which did not translate: ${failed.get(missing)}` : `${fn.name}(): ${reason}`);
        }
    }
    const constantLines = constants.map((constant) => `    ${wgslName(constant.name)} = ${translator.expression(constant.value, constant.type)};`);

    // The pass's own WGSL: the kit's picture readers under the names it calls them by, and the writer's helpers.
    const ownWgsl = input.wgsl ? [
        wgslFunctionLibrary({ tiles: 'uTiles' }),
        ...samplers.filter((name) => name.startsWith('t_')).flatMap((name) => {
            const key = name.slice(2);
            const out: string[] = [];
            if (context.functions[`c_${key}`]) out.push(`fn c_${key}(at: vec2f) -> vec4f { return gf_c_${key}(at); }`);
            if (context.functions[`g_${key}`]) out.push(`fn g_${key}(at: vec2f) -> f32 { return gf_g_${key}(at); }`);
            return out;
        }),
        input.wgsl.functions,
    ] : [];

    const struct = uniforms.map((field) => `    ${wgslName(field.name)}: ${wgslType(storedType(field.type))},`).join('\n');
    const bindings = samplers.map((name, index) => `@group(0) @binding(${1 + index * 2}) var T_${name}: texture_2d<f32>;\n@group(0) @binding(${2 + index * 2}) var S_${name}: sampler;`).join('\n');
    const privates = [
        ...uniforms.map((field) => `var<private> ${wgslName(field.name)}: ${wgslType(field.type)};`),
        ...constants.map((constant) => `var<private> ${wgslName(constant.name)}: ${wgslType(constant.type)};`),
        ...(instances ? [
            'var<private> glPosition_: vec4f;',
            'var<private> fragDepth_: f32;',
            ...varyings.map((varying) => `var<private> v_${varying.name}: ${wgslType(varying.type)};`),
        ] : []),
    ].join('\n');
    const copies = uniforms.map((field) => {
        const name = wgslName(field.name);
        if (field.type === 'bool') return `    ${name} = u.${name} != 0u;`;
        if (field.type.startsWith('bvec')) return `    ${name} = ${wgslType(field.type)}(u.${name});`;
        return `    ${name} = u.${name};`;
    }).join('\n');
    const support = [...called].filter((name) => GLSL_SUPPORT_WGSL[name]).map((name) => GLSL_SUPPORT_WGSL[name]);
    const run = input.wgsl ? `    outColor_ = ${input.wgsl.result};` : `    gf_glsl_main();`;
    if (!input.wgsl && !context.functions.glsl_main) throw new GlslError('the pass has no main()');

    // Instanced passes pass their vertex-written values through explicit WGSL locations. Private
    // variables let GLSL functions keep the same names inside each shader stage.
    const stageStructs = instances ? `struct InstanceVaryings {
    @builtin(position) position: vec4f,
${varyings.map((varying, index) => `    @location(${index}) ${varying.flat ? '@interpolate(flat) ' : ''}${varying.name}: ${wgslType(varying.type)},`).join('\n')}
};
${instances.depth ? 'struct InstancePixel { @location(0) color: vec4f, @builtin(frag_depth) depth: f32, };' : ''}` : '';
    const instanceVertex = instances ? `@vertex fn vs_main(@builtin(vertex_index) index: u32, @builtin(instance_index) instance: u32) -> InstanceVaryings {
${copies}
${constantLines.join('\n')}
    glPosition_ = vec4f(2.0, 2.0, 2.0, 1.0);
${varyings.map((varying) => `    v_${varying.name} = ${wgslType(varying.type)}();`).join('\n')}
    let across = select(1, 3, uWrap.x == 1);
    let wraps = across * select(1, 3, uWrap.y == 1);
    let copy = i32(instance) / wraps;
    let w = i32(instance) - copy * wraps;
    let shift = vec2f(select(0.0, f32(w % across) - 1.0, uWrap.x == 1),
                      select(0.0, f32(w / across) - 1.0, uWrap.y == 1));
    let corners = array<vec2f, 6>(
        vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
        vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
    gf_placeCopy(copy, ${instances.points ? 'vec2f(0.0)' : 'corners[index]'}, shift);
    return InstanceVaryings(glPosition_${varyings.map((varying) => `, v_${varying.name}`).join('')});
}` : `@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
    var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    return vec4f(corners[index], 0.0, 1.0);
}`;
    const instanceFragment = instances ? `@fragment fn fs_main(input: InstanceVaryings) -> ${instances.depth ? 'InstancePixel' : '@location(0) vec4f'} {
${copies}
    fragCoord_ = input.position;
${varyings.map((varying) => `    v_${varying.name} = input.${varying.name};`).join('\n')}
    outColor_ = vec4f(0.0);
    fragDepth_ = 1.0;
${constantLines.join('\n')}
${run}
    return ${instances.depth ? 'InstancePixel(outColor_, fragDepth_)' : 'outColor_'};
}` : `@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
${copies}
    fragCoord_ = position;
    vUv_ = position.xy / uSize;
    outColor_ = vec4f(0.0);
${constantLines.join('\n')}
${run}
    return outColor_;
}`;
    const code = `struct Uniforms {
${struct}
};
@group(0) @binding(0) var<storage, read> u: Uniforms;
${bindings}
${privates}
var<private> vUv_: vec2f;
var<private> outColor_: vec4f;
var<private> fragCoord_: vec4f;
${stageStructs}
${support.join('\n')}
${written.join('\n\n')}
${ownWgsl.join('\n\n')}
${instanceVertex}
${instanceFragment}
`;
    return { code, uniforms, textures: samplers };
};
