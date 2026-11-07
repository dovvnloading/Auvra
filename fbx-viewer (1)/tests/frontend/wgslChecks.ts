/**
 * A CHECK OF TRANSLATED WGSL, WITHOUT A GPU
 *
 * Reads WGSL as text and finds what translation from GLSL most often gets wrong, which a device would refuse:
 * - a function assigning to one of its own parameters (GLSL allows it; WGSL parameters are values);
 * - a `let` assigned to after it is made (or a part of one);
 * - several components of a vector assigned at once (`v.xy = ...`), which WGSL has no form for;
 * - a binary operation mixing whole and real numbers (or signed and unsigned) with no conversion;
 * - constructors in GLSL's form (`float(x)`, `mat3(...)`, `ivec2(...)`, `float[3](...)`) and GLSL built-ins left as they were;
 * - `%` on real numbers (GLSL has none, so it means a `mod` translated wrongly).
 *
 * It types only what it can see for sure (declared names, literals, constructors, functions' results, members,
 * swizzles and elements of them) and says nothing about the rest: what it finds is wrong, what it passes may still be.
 */

export type WgslRule = 'parameter assigned' | 'let reassigned' | 'swizzle assigned' | 'number types mixed' | 'GLSL constructor' | 'GLSL built-in' | 'real remainder';

export interface WgslFinding {
    rule: WgslRule;
    line: number;
    /** The function it is in. */
    fn: string;
    text: string;
}

interface Token { text: string; kind: 'name' | 'number' | 'symbol'; line: number }

const TOKEN = /\s+|([A-Za-z_][A-Za-z0-9_]*)|(0[xX][0-9a-fA-F]+[iu]?|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?[fhiu]?)|(<<=|>>=|->|&&|\|\||==|!=|<=|>=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|\+\+|--|<<|>>|[{}()[\];,.:=<>+\-*/%&|^!~@?])/g;

const tokenize = (source: string): Token[] => {
    const text = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
    const tokens: Token[] = [];
    let line = 1;
    for (const match of text.matchAll(TOKEN)) {
        if (match[1] !== undefined) tokens.push({ text: match[1], kind: 'name', line });
        else if (match[2] !== undefined) tokens.push({ text: match[2], kind: 'number', line });
        else if (match[3] !== undefined) tokens.push({ text: match[3], kind: 'symbol', line });
        for (const character of match[0]) if (character === '\n') line++;
    }
    return tokens;
};

const GENERIC = new Set(['vec2', 'vec3', 'vec4', 'mat2x2', 'mat2x3', 'mat2x4', 'mat3x2', 'mat3x3', 'mat3x4', 'mat4x2', 'mat4x3', 'mat4x4', 'array', 'ptr', 'atomic', 'var', 'bitcast',
    'texture_1d', 'texture_2d', 'texture_2d_array', 'texture_3d', 'texture_cube', 'texture_cube_array', 'texture_multisampled_2d', 'texture_storage_2d']);
const TYPE_NAMES = /^(?:f32|i32|u32|bool|f16|vec[234][fiuh]?|mat[234]x[234][fh]?|array)$/;
const GLSL_CONSTRUCTORS = new Set(['float', 'int', 'uint', 'double', 'mat2', 'mat3', 'mat4', 'ivec2', 'ivec3', 'ivec4', 'uvec2', 'uvec3', 'uvec4', 'bvec2', 'bvec3', 'bvec4', 'dvec2', 'dvec3', 'dvec4']);
const GLSL_BUILTINS = new Set(['mod', 'texture', 'texture2D', 'texelFetch', 'textureSize', 'textureLod', 'inversesqrt', 'dFdx', 'dFdy', 'lessThan', 'lessThanEqual', 'greaterThan',
    'greaterThanEqual', 'equal', 'notEqual', 'floatBitsToUint', 'floatBitsToInt', 'uintBitsToFloat', 'intBitsToFloat', 'roundEven']);
/** Built-ins whose result type does not follow their arguments. */
const BUILTIN_RESULTS: Readonly<Record<string, string>> = {
    textureSample: 'vec4<f32>', textureSampleLevel: 'vec4<f32>', textureSampleGrad: 'vec4<f32>', textureLoad: 'vec4<f32>', textureDimensions: 'vec2<u32>', arrayLength: 'u32',
    length: 'f32', distance: 'f32', dot: 'f32', all: 'bool', any: 'bool',
};
const BINARY = new Set(['+', '-', '*', '/', '%', '<', '>', '<=', '>=', '==', '!=']);
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);

/** The element a type holds; AF and AI for literals that become any real number, or any number. */
type Element = 'f32' | 'i32' | 'u32' | 'bool' | 'f16' | 'AF' | 'AI';
const ELEMENTS = new Set<string>(['f32', 'i32', 'u32', 'bool', 'f16', 'AF', 'AI']);

const elementOf = (type: string): Element | null => {
    if (ELEMENTS.has(type)) return type as Element;
    const generic = /^(?:vec[234]|mat[234]x[234])<\s*(f32|i32|u32|bool|f16)\s*>$/.exec(type);
    if (generic) return generic[1] as Element;
    const short = /^(?:vec[234]|mat[234]x[234])([fiuh])$/.exec(type);
    if (short) return ({ f: 'f32', i: 'i32', u: 'u32', h: 'f16' } as const)[short[1] as 'f' | 'i' | 'u' | 'h'];
    return null;
};

const literalElement = (text: string): Element => {
    if (/^0[xX][0-9a-fA-F]+[iu]$/.test(text)) return text.endsWith('i') ? 'i32' : 'u32';
    if (/^0[xX]/.test(text)) return 'AI';
    if (text.endsWith('i')) return 'i32';
    if (text.endsWith('u')) return 'u32';
    if (text.endsWith('f')) return 'f32';
    if (text.endsWith('h')) return 'f16';
    return /[.eE]/.test(text) ? 'AF' : 'AI';
};

interface Name { type: string | null; kind: 'param' | 'pointer' | 'let' | 'var' | 'global'; ambiguous?: boolean }

/** Checks WGSL text; returns what it finds, in order. */
export const checkWgsl = (source: string): WgslFinding[] => {
    const tokens = tokenize(source);
    const findings: WgslFinding[] = [];
    // Angle brackets of types (vec3<f32>, array<f32, 4>, var<private>) are no comparisons.
    const inType = new Uint8Array(tokens.length);
    for (let i = 0; i + 1 < tokens.length; i++) {
        if (!(GENERIC.has(tokens[i].text) && tokens[i + 1].text === '<')) continue;
        let depth = 0;
        for (let j = i + 1; j < tokens.length; j++) {
            const text = tokens[j].text;
            if (text === '<') depth++;
            else if (text === '>') depth--;
            else if (text === '>>') depth -= 2;
            inType[j] = 1;
            if (depth <= 0) break;
        }
    }
    const matchForward = (at: number, open: string, close: string): number => {
        let depth = 0;
        for (let j = at; j < tokens.length; j++) {
            if (tokens[j].text === open) depth++;
            else if (tokens[j].text === close && --depth === 0) return j;
        }
        return tokens.length - 1;
    };
    const matchBack = (at: number, open: string, close: string): number => {
        let depth = 0;
        for (let j = at; j >= 0; j--) {
            if (tokens[j].text === close) depth++;
            else if (tokens[j].text === open && --depth === 0) return j;
        }
        return 0;
    };
    /** A type written from `at`: a name and its angle brackets. */
    const typeAt = (at: number): { type: string; end: number } => {
        let end = at;
        while (end + 1 < tokens.length && inType[end + 1]) end++;
        return { type: tokens.slice(at, end + 1).map((token) => token.text).join(''), end };
    };

    // Structs (for members read off them), top-level names and what functions give back.
    const structs = new Map<string, Map<string, string>>();
    const globals = new Map<string, Name>();
    const results = new Map<string, string | null>();
    for (let i = 0; i < tokens.length; i++) {
        const text = tokens[i].text;
        if (text === 'struct' && tokens[i + 1]?.kind === 'name') {
            const fields = new Map<string, string>();
            const close = matchForward(i + 2, '{', '}');
            for (let j = i + 3; j < close; j++) {
                if (tokens[j].kind === 'name' && tokens[j + 1]?.text === ':') {
                    const field = typeAt(j + 2);
                    fields.set(tokens[j].text, field.type);
                    j = field.end;
                }
            }
            structs.set(tokens[i + 1].text, fields);
            i = close;
        } else if (text === 'fn' && tokens[i + 1]?.kind === 'name') {
            const close = matchForward(i + 2, '(', ')');
            results.set(tokens[i + 1].text, tokens[close + 1]?.text === '->' ? typeAt(close + 2).type : null);
            i = matchForward(close, '{', '}');
        } else if ((text === 'var' || text === 'const' || text === 'override') && (i === 0 || [';', '}', ')'].includes(tokens[i - 1].text))) {
            let at = i + 1;
            while (inType[at]) at++;
            if (tokens[at]?.kind !== 'name') continue;
            globals.set(tokens[at].text, { type: tokens[at + 1]?.text === ':' ? typeAt(at + 2).type : null, kind: text === 'var' ? 'global' : 'let' });
        }
    }

    let names = new Map<string, Name>();
    const nameOf = (name: string): Name | undefined => names.get(name) ?? globals.get(name);
    const typeOfName = (name: string): string | null => {
        const found = nameOf(name);
        return found && !found.ambiguous ? found.type : null;
    };
    const memberType = (type: string | null, member: string): string | null => {
        if (!type) return null;
        const fields = structs.get(type);
        if (fields) return fields.get(member) ?? null;
        const element = elementOf(type);
        if (element && /^(?:[xyzw]{1,4}|[rgba]{1,4})$/.test(member)) return member.length === 1 ? element : `vec${member.length}<${element}>`;
        return null;
    };
    const indexType = (type: string | null): string | null => {
        if (!type) return null;
        const array = /^array<(.+?)(?:,\s*\w+)?>$/.exec(type);
        if (array) return array[1];
        const matrix = /^mat([234])x([234])(?:<f32>|f)$/.exec(type);
        if (matrix) return `vec${matrix[2]}<f32>`;
        return elementOf(type);
    };
    /** What a call made at the name before `open` gives: a type's constructor, a function of the module, a built-in. */
    const callResult = (open: number): string | null => {
        const before = tokens[open - 1];
        if (!before) return null;
        if (before.text === '>' && inType[open - 1]) {
            let first = open - 1;
            while (first > 0 && inType[first]) first--;
            return tokens[first].text === 'bitcast' ? typeAt(first + 2).type.replace(/^<|>$/g, '') : typeAt(first).type;
        }
        if (before.kind !== 'name') return null;
        if (TYPE_NAMES.test(before.text)) return before.text;
        if (results.has(before.text)) return results.get(before.text) ?? null;
        return BUILTIN_RESULTS[before.text] ?? null;
    };
    /** The type of the operand ending at `at`, read backwards; null when it cannot be told. */
    const back = (at: number): string | null => {
        const token = tokens[at];
        if (!token) return null;
        if (token.kind === 'number') return literalElement(token.text);
        if (token.kind === 'name') return tokens[at - 1]?.text === '.' ? memberType(back(at - 2), token.text) : typeOfName(token.text);
        if (token.text === ']') return indexType(back(matchBack(at, '[', ']') - 1));
        if (token.text === ')') return callResult(matchBack(at, '(', ')'));
        return null;
    };
    /** The type of the operand starting at `at`, read forwards; null when it cannot be told. */
    const forward = (at: number): string | null => {
        const token = tokens[at];
        if (!token) return null;
        if (token.text === '-' || token.text === '!') return forward(at + 1);
        let type: string | null;
        let end = at;
        if (token.kind === 'number') type = literalElement(token.text);
        else if (token.kind === 'name') {
            let open = at + 1;
            while (inType[open]) open++;
            if (tokens[open]?.text === '(') {
                type = callResult(open);
                end = matchForward(open, '(', ')');
            } else type = typeOfName(token.text);
        } else return null;
        for (let j = end + 1; j < tokens.length;) {
            if (tokens[j].text === '.' && tokens[j + 1]?.kind === 'name') { type = memberType(type, tokens[j + 1].text); j += 2; }
            else if (tokens[j].text === '[') { type = indexType(type); j = matchForward(j, '[', ']') + 1; }
            else break;
        }
        return type;
    };
    const operandEnd = (token: Token | undefined) => !!token && (token.kind === 'name' || token.kind === 'number' || token.text === ')' || token.text === ']');

    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].text !== 'fn' || tokens[i + 1]?.kind !== 'name') continue;
        const fnName = tokens[i + 1].text;
        const close = matchForward(i + 2, '(', ')');
        names = new Map();
        // A name declared twice in a function, differently, is not told apart.
        const declare = (name: string, entry: Name) => {
            const before = names.get(name);
            if (!before) names.set(name, entry);
            else if (before.kind !== entry.kind || before.type !== entry.type) names.set(name, { ...before, ambiguous: true });
        };
        for (let j = i + 3; j < close; j++) {
            if (tokens[j].kind === 'name' && tokens[j + 1]?.text === ':') {
                const param = typeAt(j + 2);
                declare(tokens[j].text, { type: param.type, kind: param.type.startsWith('ptr<') ? 'pointer' : 'param' });
                j = param.end;
            }
        }
        let bodyOpen = close + 1;
        while (bodyOpen < tokens.length && tokens[bodyOpen].text !== '{') bodyOpen++;
        const bodyClose = matchForward(bodyOpen, '{', '}');
        const add = (rule: WgslRule, at: number, text: string) => findings.push({ rule, line: tokens[at].line, fn: fnName, text });

        for (let j = bodyOpen + 1; j < bodyClose; j++) {
            const token = tokens[j];
            // Declarations, in order: a name without a written type takes what it is set to, where that can be told.
            if ((token.text === 'var' || token.text === 'let' || token.text === 'const') && tokens[j + 1]?.kind === 'name') {
                const written = tokens[j + 2]?.text === ':' ? typeAt(j + 3) : null;
                const type = written ? written.type : tokens[j + 2]?.text === '=' ? forward(j + 3) : null;
                declare(tokens[j + 1].text, { type, kind: token.text === 'var' ? 'var' : 'let' });
                continue;
            }
            // Constructors and built-ins in GLSL's form.
            if (token.kind === 'name' && tokens[j + 1]?.text === '(') {
                if (GLSL_CONSTRUCTORS.has(token.text)) add('GLSL constructor', j, `${token.text}(...)`);
                else if (GLSL_BUILTINS.has(token.text) && !results.has(token.text)) add('GLSL built-in', j, `${token.text}(...)`);
                else if (token.text === 'atan') {
                    // GLSL's atan of two numbers is WGSL's atan2.
                    const end = matchForward(j + 1, '(', ')');
                    let depth = 0;
                    for (let k = j + 1; k < end; k++) {
                        const text = tokens[k].text;
                        if (text === '(' || text === '[') depth++;
                        else if (text === ')' || text === ']') depth--;
                        else if (text === ',' && depth === 1) { add('GLSL built-in', j, 'atan(y, x)'); break; }
                    }
                }
            }
            if (token.kind === 'name' && TYPE_NAMES.test(token.text) && tokens[j + 1]?.text === '[' && tokens[j + 3]?.text === ']' && tokens[j + 4]?.text === '(') add('GLSL constructor', j, `${token.text}[${tokens[j + 2].text}](...)`);
            // Assignments: to a parameter, to a let, to several components at once.
            const postfix = (token.text === '++' || token.text === '--') && operandEnd(tokens[j - 1]);
            if (ASSIGN.has(token.text) || postfix) {
                let first = j - 1;
                while (first > bodyOpen + 1 && ![';', '{', '}'].includes(tokens[first - 1].text) && !(tokens[first - 1].text === '(' && tokens[first - 2]?.text === 'for')) first--;
                if (['var', 'let', 'const', '_'].includes(tokens[first].text)) continue;
                const left = tokens.slice(first, j);
                if (left[0]?.text === '(' && left[1]?.text === '*') continue;
                const root = left.find((part) => part.kind === 'name');
                const named = root ? names.get(root.text) : undefined;
                const text = `${left.map((part) => part.text).join('')} ${token.text}`;
                if (named && !named.ambiguous && named.kind === 'param') add('parameter assigned', j, text);
                if (named && !named.ambiguous && named.kind === 'let') add('let reassigned', j, text);
                if (left.length >= 3 && left[left.length - 2].text === '.' && /^(?:[xyzw]{2,4}|[rgba]{2,4})$/.test(left[left.length - 1].text)) add('swizzle assigned', j, text);
                continue;
            }
            // Binary operations: the number types of their two sides.
            if (token.kind === 'symbol' && BINARY.has(token.text) && !inType[j] && operandEnd(tokens[j - 1])) {
                const a = back(j - 1);
                const b = forward(j + 1);
                const ea = a ? elementOf(a) : null;
                const eb = b ? elementOf(b) : null;
                if (!ea || !eb) continue;
                const real = (element: Element) => element === 'f32' || element === 'f16' || element === 'AF';
                if (token.text === '%' && (real(ea) || real(eb))) add('real remainder', j, `${a} % ${b}`);
                const clash = ea !== eb && ea !== 'AI' && eb !== 'AI' && !(ea === 'AF' && real(eb)) && !(eb === 'AF' && real(ea));
                if (clash) add('number types mixed', j, `${a} ${token.text} ${b}`);
            }
        }
        i = bodyClose;
    }
    return findings;
};

/** Findings as lines, for a failing test's message. */
export const findingWords = (findings: readonly WgslFinding[]): string[] => findings.map((finding) => `${finding.rule} (line ${finding.line}, in ${finding.fn}): ${finding.text}`);
