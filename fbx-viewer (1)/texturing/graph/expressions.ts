/**
 * VALUE EXPRESSIONS
 *
 * A node setting can follow the graph's exposed parameters through a small formula, such as
 * `wear * 0.8 + 0.1` or `clamp(scale * 2, 1, 32)`. Formulas are parsed here, never run as script:
 * numbers, parameter names, `$size`, `$seed`, + - * / % ^, comparisons, `cond ? a : b`, and a fixed
 * set of functions. Vectors are written `vec2(a, b)`, `vec3(...)` or `vec4(...)` and work component
 * by component.
 */

export type ExprValue = number | number[];

type Node =
    | { kind: 'number'; value: number }
    | { kind: 'name'; name: string }
    | { kind: 'unary'; op: '-' | '!'; value: Node }
    | { kind: 'binary'; op: string; left: Node; right: Node }
    | { kind: 'ternary'; test: Node; then: Node; otherwise: Node }
    | { kind: 'call'; name: string; args: Node[] };

const MAX_LENGTH = 512;

interface Token { kind: 'number' | 'name' | 'op'; text: string }

const tokenize = (source: string): Token[] => {
    const tokens: Token[] = [];
    let at = 0;
    while (at < source.length) {
        const char = source[at];
        if (/\s/.test(char)) { at++; continue; }
        const number = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(source.slice(at));
        if (number) { tokens.push({ kind: 'number', text: number[0] }); at += number[0].length; continue; }
        const name = /^\$?[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(at));
        if (name) { tokens.push({ kind: 'name', text: name[0] }); at += name[0].length; continue; }
        const op = /^(?:<=|>=|==|!=|&&|\|\||[-+*/%^(),?:<>!])/.exec(source.slice(at));
        if (op) { tokens.push({ kind: 'op', text: op[0] }); at += op[0].length; continue; }
        throw new Error(`Unexpected "${char}"`);
    }
    return tokens;
};

const PRECEDENCE: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6, '^': 8 };

const parse = (source: string): Node => {
    if (source.length > MAX_LENGTH) throw new Error('The formula is too long');
    const tokens = tokenize(source);
    let at = 0;
    const peek = () => tokens[at];
    const expect = (text: string) => {
        if (peek()?.text !== text) throw new Error(`Expected "${text}"`);
        at++;
    };
    const primary = (): Node => {
        const token = tokens[at++];
        if (!token) throw new Error('The formula ends too soon');
        if (token.kind === 'number') return { kind: 'number', value: Number(token.text) };
        if (token.kind === 'name') {
            if (peek()?.text === '(') {
                at++;
                const args: Node[] = [];
                if (peek()?.text !== ')') {
                    for (;;) {
                        args.push(expression(0));
                        if (peek()?.text === ',') { at++; continue; }
                        break;
                    }
                }
                expect(')');
                return { kind: 'call', name: token.text, args };
            }
            return { kind: 'name', name: token.text };
        }
        if (token.text === '(') {
            const inner = expression(0);
            expect(')');
            return inner;
        }
        if (token.text === '-' || token.text === '!') return { kind: 'unary', op: token.text, value: unary() };
        if (token.text === '+') return unary();
        throw new Error(`Unexpected "${token.text}"`);
    };
    const unary = (): Node => primary();
    const expression = (minimum: number): Node => {
        let left = unary();
        for (;;) {
            const token = peek();
            if (!token || token.kind !== 'op') break;
            if (token.text === '?' && minimum === 0) {
                at++;
                const then = expression(0);
                expect(':');
                const otherwise = expression(0);
                left = { kind: 'ternary', test: left, then, otherwise };
                continue;
            }
            const precedence = PRECEDENCE[token.text];
            if (precedence === undefined || precedence < minimum) break;
            at++;
            // ^ groups to the right, the rest to the left.
            const right = expression(token.text === '^' ? precedence : precedence + 1);
            left = { kind: 'binary', op: token.text, left, right };
        }
        return left;
    };
    const tree = expression(0);
    if (at < tokens.length) throw new Error(`Unexpected "${tokens[at].text}"`);
    return tree;
};

const map2 = (a: ExprValue, b: ExprValue, f: (x: number, y: number) => number): ExprValue => {
    if (typeof a === 'number' && typeof b === 'number') return f(a, b);
    const length = Math.max(typeof a === 'number' ? 1 : a.length, typeof b === 'number' ? 1 : b.length);
    return Array.from({ length }, (_, i) => f(typeof a === 'number' ? a : a[i] ?? 0, typeof b === 'number' ? b : b[i] ?? 0));
};
const map1 = (a: ExprValue, f: (x: number) => number): ExprValue => (typeof a === 'number' ? f(a) : a.map(f));
const scalar = (a: ExprValue): number => (typeof a === 'number' ? a : a[0] ?? 0);

/** Deterministic random in 0..1 from a number, for `rand(x)`. */
const rand = (x: number): number => {
    let h = Math.imul(Math.floor(x * 1000003) ^ 0x9e3779b9, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
};

const FUNCTIONS: Record<string, (args: ExprValue[]) => ExprValue> = {
    min: ([a, b]) => map2(a, b, Math.min),
    max: ([a, b]) => map2(a, b, Math.max),
    clamp: ([a, lo, hi]) => map2(map2(a, lo, Math.max), hi, Math.min),
    saturate: ([a]) => map1(a, (x) => Math.min(1, Math.max(0, x))),
    abs: ([a]) => map1(a, Math.abs),
    floor: ([a]) => map1(a, Math.floor),
    ceil: ([a]) => map1(a, Math.ceil),
    round: ([a]) => map1(a, Math.round),
    fract: ([a]) => map1(a, (x) => x - Math.floor(x)),
    sqrt: ([a]) => map1(a, (x) => Math.sqrt(Math.max(0, x))),
    sin: ([a]) => map1(a, Math.sin),
    cos: ([a]) => map1(a, Math.cos),
    tan: ([a]) => map1(a, Math.tan),
    pow: ([a, b]) => map2(a, b, Math.pow),
    exp: ([a]) => map1(a, Math.exp),
    log: ([a]) => map1(a, (x) => Math.log(Math.max(1e-12, x))),
    log2: ([a]) => map1(a, (x) => Math.log2(Math.max(1e-12, x))),
    lerp: ([a, b, t]) => map2(a, map2(map2(b, a, (x, y) => x - y), t, (d, s) => d * s), (x, y) => x + y),
    step: ([edge, x]) => map2(edge, x, (e, v) => (v < e ? 0 : 1)),
    smoothstep: ([a, b, x]) => map2(map2(map2(x, a, (v, lo) => v - lo), map2(b, a, (hi, lo) => hi - lo), (n, d) => Math.min(1, Math.max(0, d ? n / d : 0))), 0, (t) => t * t * (3 - 2 * t)),
    rand: ([a]) => map1(a, rand),
    vec2: (args) => [scalar(args[0] ?? 0), scalar(args[1] ?? args[0] ?? 0)],
    vec3: (args) => [scalar(args[0] ?? 0), scalar(args[1] ?? args[0] ?? 0), scalar(args[2] ?? args[0] ?? 0)],
    vec4: (args) => [scalar(args[0] ?? 0), scalar(args[1] ?? args[0] ?? 0), scalar(args[2] ?? args[0] ?? 0), scalar(args[3] ?? 1)],
    x: ([a]) => (typeof a === 'number' ? a : a[0] ?? 0),
    y: ([a]) => (typeof a === 'number' ? a : a[1] ?? 0),
    z: ([a]) => (typeof a === 'number' ? a : a[2] ?? 0),
    w: ([a]) => (typeof a === 'number' ? a : a[3] ?? 0),
    length: ([a]) => (typeof a === 'number' ? Math.abs(a) : Math.hypot(...a)),
};

export const EXPRESSION_FUNCTIONS = Object.keys(FUNCTIONS);

const evaluateNode = (node: Node, scope: Readonly<Record<string, ExprValue>>, depth: number): ExprValue => {
    if (depth > 64) throw new Error('The formula nests too deeply');
    switch (node.kind) {
        case 'number': return node.value;
        case 'name': {
            if (node.name === 'pi') return Math.PI;
            const value = scope[node.name];
            if (value === undefined) throw new Error(`No parameter called "${node.name}"`);
            return value;
        }
        case 'unary': {
            const value = evaluateNode(node.value, scope, depth + 1);
            return node.op === '-' ? map1(value, (x) => -x) : map1(value, (x) => (x ? 0 : 1));
        }
        case 'ternary': return scalar(evaluateNode(node.test, scope, depth + 1)) ? evaluateNode(node.then, scope, depth + 1) : evaluateNode(node.otherwise, scope, depth + 1);
        case 'call': {
            const fn = FUNCTIONS[node.name];
            if (!fn) throw new Error(`No function called "${node.name}"`);
            return fn(node.args.map((arg) => evaluateNode(arg, scope, depth + 1)));
        }
        case 'binary': {
            const a = evaluateNode(node.left, scope, depth + 1);
            const b = evaluateNode(node.right, scope, depth + 1);
            switch (node.op) {
                case '+': return map2(a, b, (x, y) => x + y);
                case '-': return map2(a, b, (x, y) => x - y);
                case '*': return map2(a, b, (x, y) => x * y);
                case '/': return map2(a, b, (x, y) => (y === 0 ? 0 : x / y));
                case '%': return map2(a, b, (x, y) => (y === 0 ? 0 : x - y * Math.floor(x / y)));
                case '^': return map2(a, b, Math.pow);
                case '<': return map2(a, b, (x, y) => Number(x < y));
                case '>': return map2(a, b, (x, y) => Number(x > y));
                case '<=': return map2(a, b, (x, y) => Number(x <= y));
                case '>=': return map2(a, b, (x, y) => Number(x >= y));
                case '==': return map2(a, b, (x, y) => Number(Math.abs(x - y) < 1e-9));
                case '!=': return map2(a, b, (x, y) => Number(Math.abs(x - y) >= 1e-9));
                case '&&': return Number(Boolean(scalar(a)) && Boolean(scalar(b)));
                case '||': return Number(Boolean(scalar(a)) || Boolean(scalar(b)));
            }
        }
    }
    throw new Error('The formula could not be read');
};

const cache = new Map<string, Node | Error>();

/** Checks a formula; null when it reads, else what is wrong with it in words. */
export const expressionError = (source: string, names: readonly string[]): string | null => {
    try {
        const scope = Object.fromEntries([...names, '$size', '$seed', '$width', '$height'].map((name) => [name, 1]));
        evaluateExpression(source, scope);
        return null;
    } catch (error) {
        return error instanceof Error ? error.message : 'The formula could not be read';
    }
};

/** The formula's value with `scope` holding each parameter's value. Throws on a formula that does not read. */
export const evaluateExpression = (source: string, scope: Readonly<Record<string, ExprValue>>): ExprValue => {
    let tree = cache.get(source);
    if (!tree) {
        try { tree = parse(source); } catch (error) { tree = error instanceof Error ? error : new Error('The formula could not be read'); }
        if (cache.size > 2000) cache.clear();
        cache.set(source, tree);
    }
    if (tree instanceof Error) throw tree;
    const value = evaluateNode(tree, scope, 0);
    if (typeof value === 'number' ? !Number.isFinite(value) : value.some((x) => !Number.isFinite(x))) return typeof value === 'number' ? 0 : value.map((x) => (Number.isFinite(x) ? x : 0));
    return value;
};
