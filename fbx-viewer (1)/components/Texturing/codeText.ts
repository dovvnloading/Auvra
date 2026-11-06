/**
 * Code in settings (a pixel processor's, a custom node's): GLSL split into coloured words, and a
 * compile log read into errors on the lines of the code typed (the code is compiled after a #line 1,
 * so the log counts its lines from 1).
 */

export type TokenKind = 'plain' | 'keyword' | 'type' | 'function' | 'number' | 'comment' | 'name';
export interface CodeToken { text: string; kind: TokenKind }

const KEYWORDS = new Set(['if', 'else', 'for', 'while', 'do', 'return', 'break', 'continue', 'discard', 'const', 'uniform', 'in', 'out', 'inout', 'struct', 'true', 'false']);
const TYPES = new Set(['void', 'bool', 'int', 'uint', 'float', 'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4', 'bvec2', 'bvec3', 'bvec4', 'mat2', 'mat3', 'mat4', 'sampler2D']);
const FUNCTIONS = new Set([
    'texture', 'texelFetch', 'mix', 'clamp', 'smoothstep', 'step', 'min', 'max', 'abs', 'sign', 'floor', 'ceil', 'fract', 'mod', 'pow', 'exp', 'exp2', 'log', 'log2',
    'sqrt', 'inversesqrt', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'length', 'distance', 'dot', 'cross', 'normalize', 'reflect', 'refract', 'dFdx', 'dFdy',
    'fwidth', 'radians', 'degrees', 'saturate', 'luma', 'rotate2', 'hash1', 'hash2', 'srgbToLinear', 'rgbToHsl', 'hslToRgb',
]);

/** One line of GLSL as coloured words: keywords, types, functions, numbers, comments, and the node's own names (c_a, p_x, uv...). */
export const tokenizeLine = (line: string, names: ReadonlySet<string> = new Set()): CodeToken[] => {
    const tokens: CodeToken[] = [];
    const push = (text: string, kind: TokenKind) => {
        const last = tokens[tokens.length - 1];
        if (last && last.kind === kind && kind === 'plain') last.text += text;
        else if (text) tokens.push({ text, kind });
    };
    let at = 0;
    while (at < line.length) {
        const rest = line.slice(at);
        if (rest.startsWith('//')) { push(rest, 'comment'); break; }
        const word = /^[A-Za-z_]\w*/.exec(rest);
        if (word) {
            const text = word[0];
            push(text, KEYWORDS.has(text) ? 'keyword' : TYPES.has(text) ? 'type' : FUNCTIONS.has(text) ? 'function' : names.has(text) || /^[cgpw]_\w+$/.test(text) ? 'name' : 'plain');
            at += text.length;
            continue;
        }
        const number = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(rest);
        if (number) { push(number[0], 'number'); at += number[0].length; continue; }
        push(line[at], 'plain');
        at++;
    }
    return tokens;
};

export interface CodeError {
    /** The line of the typed code (from 1), when the log says. */
    line: number | null;
    message: string;
}

/** A shader compile log's errors, each on its line of the typed code where the log gives one. */
export const parseShaderErrors = (log: string | null | undefined): CodeError[] => {
    if (!log) return [];
    const errors: CodeError[] = [];
    for (const raw of log.split('\n')) {
        const text = raw.trim();
        if (!text || /^\d+\s+compilation errors?/i.test(text)) continue;
        const match = /^(?:ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/.exec(text);
        if (match) errors.push({ line: Number(match[1]), message: match[2].replace(/^''\s*:\s*/, '').replace(/^'([^']*)'\s*:\s*/, '$1: ').trim() });
        else errors.push({ line: null, message: text });
    }
    return errors;
};
