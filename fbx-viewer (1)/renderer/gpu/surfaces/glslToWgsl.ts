/**
 * GLSL TO WGSL
 *
 * Material graph nodes write their code in GLSL, and so do people in a Custom GLSL node. This turns that code into WGSL,
 * so a node has one definition whichever renderer draws it. It takes the GLSL a function body can hold: declarations,
 * assignment, if, for, while, do, return, the operators, constructors, swizzles and the built-in functions, with what
 * differs between the languages made up here: a number meeting a vector in a call, a mask on the left of an assignment
 * (WGSL only takes one component at a time), `?:` as `select`, the names that changed.
 *
 * It follows the types of everything it reads, so anything it does not know (a name, a function, a preprocessor line)
 * is an error here, with a message, rather than a shader that fails later.
 *
 * WGSL works out what it can while compiling and refuses what comes to nothing, where GLSL gives infinity or NaN and
 * carries on: an unconnected input can make a `1.0 / 0.0` or a `log(0.0)`. Such a calculation has one input passed through
 * a function, which makes it happen as the shader runs, as it does in GLSL.
 */

export class GlslError extends Error {}

export interface GlslFunction {
  /** Its name in WGSL, when that is not the name it goes by in GLSL. */
  code?: string;
  returns: string;
  /** Its parameters' types, which arguments are made to fit. */
  params?: readonly string[];
  /** Which parameters it writes through, as `out` does. */
  outs?: readonly number[];
  /** Other functions of the same name taking other types (GLSL overloads, each its own name in WGSL). */
  overloads?: readonly GlslFunction[];
}

export interface GlslContext {
  stage: "fragment" | "vertex";
  /** What the code reads from around it: by GLSL name, its WGSL and its type. */
  variables: Readonly<Record<string, { code: string; type: string }>>;
  /** Textures by GLSL name, and what they are bound as. */
  textures: Readonly<Record<string, { texture: string; sampler: string }>>;
  /** Functions beyond the built-in ones. Translated functions are added here. */
  functions: Record<string, GlslFunction>;
  /** Told of every function of `functions` or of the support code called. */
  called?: (name: string) => void;
  /** Put before the WGSL name of every function translated (so one never meets a WGSL built-in of its name). */
  functionPrefix?: string;
}

/** Functions the translated code may call, by what `GlslContext.called` is told. */
export const GLSL_SUPPORT_WGSL: Readonly<Record<string, string>> = {
  mgKeep1: "fn mgKeep1(v: f32) -> f32 { return v; }",
  mgKeep2: "fn mgKeep2(v: vec2f) -> vec2f { return v; }",
  mgKeep3: "fn mgKeep3(v: vec3f) -> vec3f { return v; }",
  mgKeep4: "fn mgKeep4(v: vec4f) -> vec4f { return v; }",
  mgInverse2: `fn mgInverse2(m: mat2x2f) -> mat2x2f {
  return mat2x2f(m[1][1], -m[0][1], -m[1][0], m[0][0]) * (1.0 / determinant(m));
}`,
  mgInverse3: `fn mgInverse3(m: mat3x3f) -> mat3x3f {
  let a = m[0];
  let b = m[1];
  let c = m[2];
  return transpose(mat3x3f(cross(b, c), cross(c, a), cross(a, b))) * (1.0 / determinant(m));
}`,
  mgPow2: "fn mgPow2(v: f32) -> f32 { return v * v; }",
  mgPow3: "fn mgPow3(v: f32) -> f32 { return v * v * v; }",
  mgPow4: "fn mgPow4(v: f32) -> f32 { let s = v * v; return s * s; }",
  mgRand: `fn mgRand(uv: vec2f) -> f32 {
  let dt = dot(uv, vec2f(12.9898, 78.233));
  let sn = dt % 3.141592653589793;
  return fract(sin(sn) * 43758.5453);
}`,
};

const VECTOR_SIZES: Readonly<Record<string, number>> = {
  float: 1, int: 1, uint: 1, bool: 1,
  vec2: 2, vec3: 3, vec4: 4,
  ivec2: 2, ivec3: 3, ivec4: 4,
  uvec2: 2, uvec3: 3, uvec4: 4,
  bvec2: 2, bvec3: 3, bvec4: 4,
};
const MATRIX_SIZES: Readonly<Record<string, number>> = { mat2: 2, mat3: 3, mat4: 4, mat2x2: 2, mat3x3: 3, mat4x4: 4 };
const ELEMENT_PREFIX: Readonly<Record<string, string>> = { float: "", int: "i", uint: "u", bool: "b" };
const CONSTANTS: Readonly<Record<string, string>> = {
  PI: "3.141592653589793",
  PI2: "6.283185307179586",
  PI_HALF: "1.5707963267948966",
  RECIPROCAL_PI: "0.3183098861837907",
  RECIPROCAL_PI2: "0.15915494309189535",
  EPSILON: "1e-6",
};

/** Names WGSL keeps for itself or that the translation writes: a local called one of these is renamed. */
export const RESERVED = new Set(`
  alias break case const const_assert continue continuing default diagnostic discard else enable false fn for if let loop
  override requires return struct switch true var while NULL Self abstract active alignas alignof as asm asm_fragment async
  attribute auto await become cast catch class co_await co_return co_yield coherent column_major common compile
  compile_fragment concept const_cast consteval constexpr constinit crate debugger decltype delete demote
  demote_to_helper do dynamic_cast enum explicit export extends extern external fallthrough filter final finally friend
  from fxgroup get goto groupshared highp impl implements import inline instanceof interface layout lowp macro macro_rules
  match mediump meta mod module move mut mutable namespace new nil noexcept noinline nointerpolation non_coherent noncoherent
  noperspective null nullptr of operator package packoffset partition pass patch pixelfragment precise precision premerge
  priv protected pub public readonly ref regardless register reinterpret_cast require resource restrict self set shared
  sizeof smooth snorm static static_assert static_cast std subroutine super target template this thread_local throw
  trait try type typedef typeid typename typeof union unless unorm unsafe unsized use using varying virtual volatile wgsl
  where with writeonly yield
  f32 i32 u32 bool array mat2x2f mat3x3f mat4x4f vec2f vec3f vec4f vec2i vec3i vec4i vec2u vec3u vec4u select atan2 dpdx dpdy
  textureSample textureSampleLevel material view surfaceWorld out in mgIn
`.trim().split(/\s+/));

const isVector = (type: string): boolean => (VECTOR_SIZES[type] ?? 0) > 1;
const isMatrix = (type: string): boolean => type in MATRIX_SIZES;
const isArray = (type: string): boolean => type.endsWith("]");
const sizeOf = (type: string): number => VECTOR_SIZES[type] ?? 0;

const elementOf = (type: string): string => {
  if (type === "float" || type === "int" || type === "uint" || type === "bool") return type;
  if (type.startsWith("vec") || type.startsWith("mat")) return "float";
  if (type.startsWith("ivec")) return "int";
  if (type.startsWith("uvec")) return "uint";
  if (type.startsWith("bvec")) return "bool";
  throw new GlslError(`${type} has no components`);
};

const vectorOf = (element: string, size: number): string => (size === 1 ? element : `${ELEMENT_PREFIX[element]}vec${size}`);

/** A GLSL type's name in WGSL. */
export const wgslType = (type: string): string => {
  if (isArray(type)) {
    const open = type.indexOf("[");
    return `array<${wgslType(type.slice(0, open))}, ${type.slice(open + 1, -1)}>`;
  }
  if (isMatrix(type)) return `mat${MATRIX_SIZES[type]}x${MATRIX_SIZES[type]}f`;
  switch (type) {
    case "float": return "f32";
    case "int": return "i32";
    case "uint": return "u32";
    case "bool": return "bool";
    default: break;
  }
  if (!isVector(type)) throw new GlslError(`Unknown type ${type}`);
  if (elementOf(type) === "bool") return `vec${sizeOf(type)}<bool>`;
  return `vec${sizeOf(type)}${{ float: "f", int: "i", uint: "u" }[elementOf(type) as "float" | "int" | "uint"]}`;
};

interface Token {
  kind: "number" | "name" | "symbol" | "end";
  text: string;
  /** For a number: a whole number with no decimal point. */
  whole?: boolean;
  line: number;
}

const TOKEN = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|(0[xX][0-9a-fA-F]+[uU]?|\d+\.\d*(?:[eE][+-]?\d+)?[fF]?|\.\d+(?:[eE][+-]?\d+)?[fF]?|\d+[eE][+-]?\d+[fF]?|\d+[uU]?)|([A-Za-z_][A-Za-z0-9_]*)|(<<=|>>=|\+\+|--|<=|>=|==|!=|&&|\|\||\^\^|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<|>>|[-+*/%<>=!~&|^?:;,.(){}[\]])/y;

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  let line = 1;
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < source.length) {
    const at = TOKEN.lastIndex;
    const match = TOKEN.exec(source);
    if (!match) throw new GlslError(`Line ${line}: cannot read "${source.slice(at, at + 12)}"`);
    if (match[1] !== undefined) {
      const whole = /^(?:0[xX][0-9a-fA-F]+|\d+)[uU]?$/.test(match[1]);
      tokens.push({ kind: "number", text: match[1].replace(/[fF]$/, ""), whole, line });
    } else if (match[2] !== undefined) {
      tokens.push({ kind: "name", text: match[2], line });
    } else if (match[3] !== undefined) {
      tokens.push({ kind: "symbol", text: match[3], line });
    }
    for (const character of match[0]) if (character === "\n") line++;
  }
  tokens.push({ kind: "end", text: "end of code", line });
  return tokens;
};

interface Value {
  code: string;
  type: string;
  /** Nothing in it varies, so WGSL will work it out while compiling. */
  constant: boolean;
  /** A whole-number literal, which fits any number type. */
  literal?: boolean;
  /** Set when a mask of an assignable value: what it masks and how. */
  mask?: { base: Value; letters: string };
  texture?: { texture: string; sampler: string };
}

interface Local {
  code: string;
  type: string;
}

const BINARY_LEVELS: Readonly<Record<string, number>> = {
  "||": 1, "^^": 2, "&&": 3, "|": 4, "^": 5, "&": 6, "==": 7, "!=": 7, "<": 8, ">": 8, "<=": 8, ">=": 8, "<<": 9, ">>": 9, "+": 10, "-": 10, "*": 11, "/": 11, "%": 11,
};
const ASSIGNMENTS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="]);

/** Functions of one number or vector of numbers giving the same type back. */
const SAME_TYPE: Readonly<Record<string, string>> = {
  sin: "sin", cos: "cos", tan: "tan", asin: "asin", acos: "acos", sinh: "sinh", cosh: "cosh", tanh: "tanh", asinh: "asinh", acosh: "acosh", atanh: "atanh",
  exp: "exp", log: "log", exp2: "exp2", log2: "log2", sqrt: "sqrt", inversesqrt: "inverseSqrt", floor: "floor", ceil: "ceil", fract: "fract", trunc: "trunc",
  round: "round", roundEven: "round", radians: "radians", degrees: "degrees", normalize: "normalize", saturate: "saturate",
  dFdx: "dpdx", dFdy: "dpdy", fwidth: "fwidth", dFdxCoarse: "dpdxCoarse", dFdyCoarse: "dpdyCoarse",
};
const DERIVATIVES = new Set(["dFdx", "dFdy", "fwidth", "dFdxCoarse", "dFdyCoarse"]);
const COMPARES: Readonly<Record<string, string>> = { lessThan: "<", lessThanEqual: "<=", greaterThan: ">", greaterThanEqual: ">=", equal: "==", notEqual: "!=" };

export class GlslTranslator {
  private tokens: Token[] = [];
  private at = 0;
  private readonly scopes: Map<string, Local>[] = [new Map()];
  private returnType = "void";
  private temporaries = 0;
  /** The function being translated: its by-value parameters (code to GLSL name), the scope they live in, and those its body assigns to. */
  private parameters: { codes: Map<string, string>; scope: number; assigned: Set<string> } | null = null;

  constructor(private readonly context: GlslContext) {}

  /** Statements as WGSL; what they declare stays known to later calls. */
  statements(source: string): string {
    this.begin(source);
    const lines: string[] = [];
    while (this.peek().kind !== "end") lines.push(this.statement());
    return lines.join("\n");
  }

  /** An expression as WGSL, made to fit `type`. */
  expression(source: string, type: string): string {
    this.begin(source);
    const value = this.ternary();
    this.expectEnd();
    return this.fit(value, type);
  }

  /** A function's definition as WGSL. It becomes known to code translated after it. */
  fn(source: string): string {
    this.begin(source);
    const returns = this.typeName();
    const name = this.name();
    this.expect("(");
    const params: { name: string; type: string; out?: boolean }[] = [];
    if (!this.accept(")")) {
      do {
        // `out` and `inout` parameters are written through (pointers in WGSL); `in` and `const` change nothing.
        let out = false;
        while (["in", "out", "inout", "const", "highp", "mediump", "lowp"].includes(this.peek().text)) {
          const qualifier = this.next().text;
          if (qualifier === "out" || qualifier === "inout") out = true;
        }
        // A texture parameter (sampler2D) and arrays (float values[16]) as well as numbers and vectors.
        const type = this.peek().text === "sampler2D" ? (this.next(), "sampler2D") : this.typeName();
        const name = this.name();
        let full = type;
        if (this.accept("[")) {
          const size = this.next();
          this.expect("]");
          full = `${type}[${size.text}]`;
        }
        params.push({ name, type: full, ...(out ? { out } : {}) });
      } while (this.accept(","));
      this.expect(")");
    }
    this.scopes.push(new Map());
    const codes = new Map<string, string>();
    // A texture is handed over as WGSL keeps it: the texture and the sampler it is read with.
    const declared = params.map((param) => {
      const code = this.declare(param.name, param.type);
      if (param.out) {
        // Read and written through the pointer it is.
        this.scopes[this.scopes.length - 1].set(param.name, { code: `(*${code})`, type: param.type });
        return `${code}: ptr<function, ${wgslType(param.type)}>`;
      }
      if (param.type === "sampler2D") return `${code}_t: texture_2d<f32>, ${code}_s: sampler`;
      codes.set(code, param.name);
      return `${code}: ${wgslType(param.type)}`;
    });
    const outs = params.flatMap((param, index) => (param.out ? [index] : []));
    const previous = this.returnType;
    this.returnType = returns;
    this.parameters = { codes, scope: this.scopes.length - 1, assigned: new Set() };
    this.expect("{");
    const lines: string[] = [];
    while (!this.accept("}")) lines.push(this.statement());
    this.expectEnd();
    this.returnType = previous;
    this.scopes.pop();
    // GLSL lets a function change its own (by-value) parameters; WGSL does not. Each one the body assigns to comes
    // in under another name and is copied into a variable of its own name, which the body then reads and changes.
    const assigned = this.parameters.assigned;
    this.parameters = null;
    if (assigned.size) {
      const taken = new Set([...(lines.join("\n").match(/[A-Za-z_]\w*/g) ?? []), ...codes.keys()]);
      const copies: string[] = [];
      params.forEach((param, index) => {
        const code = [...codes].find(([, name]) => name === param.name)?.[0];
        if (!code || !assigned.has(code)) return;
        let held = `${code}_in`;
        while (taken.has(held)) held = `${held}_`;
        taken.add(held);
        declared[index] = `${held}: ${wgslType(param.type)}`;
        copies.push(`var ${code} = ${held};`);
      });
      lines.unshift(...copies);
    }
    // A path WGSL cannot see the end of gets a value, as GLSL leaves it to chance.
    if (returns !== "void" && !/^\s*return\b[^;]*;\s*$/.test(lines[lines.length - 1] ?? "")) lines.push(`return ${wgslType(returns)}();`);
    // A second function of a name taking other types is an overload: WGSL has none, so it gets a name of its own.
    const types = params.map((param) => param.type);
    const existing = this.context.functions[name];
    const prefix = this.context.functionPrefix ?? "";
    let code = `${prefix}${name}`;
    if (existing && (existing.params ?? []).join(",") !== types.join(",")) {
      const list: GlslFunction[] = existing.overloads ? [...existing.overloads] : [{ ...existing, code: existing.code ?? name }];
      code = `${prefix}${name}_${list.length}`;
      list.push({ code, returns, params: types, ...(outs.length ? { outs } : {}) });
      this.context.functions[name] = { ...existing, overloads: list };
    } else {
      this.context.functions[name] = { returns, params: types, ...(prefix ? { code } : {}), ...(outs.length ? { outs } : {}) };
    }
    const signature = `fn ${code}(${declared.join(", ")})${returns === "void" ? "" : ` -> ${wgslType(returns)}`}`;
    return `@diagnostic(off, derivative_uniformity)\n${signature} {\n${lines.join("\n")}\n}`;
  }

  private begin(source: string): void {
    this.tokens = tokenize(source);
    this.at = 0;
  }

  private peek(ahead = 0): Token {
    return this.tokens[Math.min(this.at + ahead, this.tokens.length - 1)];
  }

  private next(): Token {
    const token = this.peek();
    if (token.kind !== "end") this.at++;
    return token;
  }

  private fail(message: string): never {
    throw new GlslError(`Line ${this.peek().line}: ${message}`);
  }

  private accept(text: string): boolean {
    const token = this.peek();
    if ((token.kind === "symbol" || token.kind === "name") && token.text === text) {
      this.at++;
      return true;
    }
    return false;
  }

  private expect(text: string): void {
    if (!this.accept(text)) this.fail(`expected "${text}", found "${this.peek().text}"`);
  }

  private expectEnd(): void {
    if (this.peek().kind !== "end") this.fail(`unexpected "${this.peek().text}"`);
  }

  private name(): string {
    const token = this.next();
    if (token.kind !== "name") this.fail(`expected a name, found "${token.text}"`);
    return token.text;
  }

  private isTypeName(text: string): boolean {
    return text in VECTOR_SIZES || text in MATRIX_SIZES;
  }

  private typeName(): string {
    const name = this.name();
    if (name === "void") return name;
    if (!this.isTypeName(name)) this.fail(`unknown type ${name}`);
    return name;
  }

  // ---------------------------------------------------------------- Names

  private declare(name: string, type: string): string {
    const code = RESERVED.has(name) ? `${name}_` : name;
    this.scopes[this.scopes.length - 1].set(name, { code, type });
    return code;
  }

  private lookup(name: string): Value {
    for (let index = this.scopes.length - 1; index >= 0; index--) {
      const local = this.scopes[index].get(name);
      if (local?.type === "sampler2D") return { code: local.code, type: "sampler2D", constant: false, texture: { texture: `${local.code}_t`, sampler: `${local.code}_s` } };
      if (local) return { code: local.code, type: local.type, constant: false };
    }
    const outside = this.context.variables[name];
    if (outside) return { code: outside.code, type: outside.type, constant: false };
    const texture = this.context.textures[name];
    if (texture) return { code: name, type: "sampler2D", constant: false, texture };
    if (name in CONSTANTS) return { code: CONSTANTS[name], type: "float", constant: true };
    if (name === "true" || name === "false") return { code: name, type: "bool", constant: true };
    return this.fail(`unknown name ${name}`);
  }

  // ---------------------------------------------------------------- Statements

  private statement(): string {
    const token = this.peek();
    if (token.text === "{" && token.kind === "symbol") return this.block();
    if (token.kind === "symbol" && token.text === ";") {
      this.next();
      return "";
    }
    if (token.kind === "name") {
      switch (token.text) {
        case "if": return this.ifStatement();
        case "for": return this.forStatement();
        case "while": return this.whileStatement();
        case "do": return this.doStatement();
        case "break":
        case "continue":
        case "discard":
          this.next();
          this.expect(";");
          return `${token.text};`;
        case "return": {
          this.next();
          if (this.accept(";")) return "return;";
          const value = this.ternary();
          this.expect(";");
          return `return ${this.fit(value, this.returnType)};`;
        }
        default: break;
      }
    }
    const lines = this.simpleStatement();
    this.expect(";");
    return lines.map((line) => `${line}${line.endsWith("}") ? "" : ";"}`).join("\n");
  }

  private block(): string {
    this.expect("{");
    this.scopes.push(new Map());
    const lines: string[] = [];
    while (!this.accept("}")) {
      if (this.peek().kind === "end") this.fail("a block is not closed");
      lines.push(this.statement());
    }
    this.scopes.pop();
    return `{\n${lines.join("\n")}\n}`;
  }

  /** A statement as the body of a branch or loop: WGSL always wants braces. */
  private body(): string {
    if (this.peek().kind === "symbol" && this.peek().text === "{") return this.block();
    this.scopes.push(new Map());
    const line = this.statement();
    this.scopes.pop();
    return `{\n${line}\n}`;
  }

  private ifStatement(): string {
    this.expect("if");
    this.expect("(");
    const condition = this.fit(this.ternary(), "bool");
    this.expect(")");
    const whenTrue = this.body();
    if (!this.accept("else")) return `if (${condition}) ${whenTrue}`;
    if (this.peek().text === "if") return `if (${condition}) ${whenTrue} else ${this.ifStatement()}`;
    return `if (${condition}) ${whenTrue} else ${this.body()}`;
  }

  private forStatement(): string {
    this.expect("for");
    this.expect("(");
    this.scopes.push(new Map());
    const first = this.accept(";") ? [] : this.simpleStatement();
    if (first.length) this.expect(";");
    const condition = this.peek().text === ";" ? "" : this.fit(this.ternary(), "bool");
    this.expect(";");
    const update = this.peek().text === ")" ? [] : this.simpleStatement();
    this.expect(")");
    const body = this.body();
    this.scopes.pop();
    if (update.length > 1 || update.some((line) => line.endsWith("}"))) this.fail("a for loop's update is too complicated");
    if (first.length <= 1) return `for (${first[0] ?? ""}; ${condition}; ${update[0] ?? ""}) ${body}`;
    return `{\n${first.map((line) => `${line};`).join("\n")}\nfor (; ${condition}; ${update[0] ?? ""}) ${body}\n}`;
  }

  private whileStatement(): string {
    this.expect("while");
    this.expect("(");
    const condition = this.fit(this.ternary(), "bool");
    this.expect(")");
    return `while (${condition}) ${this.body()}`;
  }

  private doStatement(): string {
    this.expect("do");
    const body = this.body();
    this.expect("while");
    this.expect("(");
    const condition = this.fit(this.ternary(), "bool");
    this.expect(")");
    this.expect(";");
    return `loop {\n${body}\ncontinuing {\nbreak if !(${condition});\n}\n}`;
  }

  private isDeclaration(): boolean {
    const token = this.peek();
    if (token.kind !== "name") return false;
    if (token.text === "const" || token.text === "highp" || token.text === "mediump" || token.text === "lowp") return true;
    return this.isTypeName(token.text) && this.peek(1).kind === "name";
  }

  /** A declaration, an assignment or a call, without the semicolon: one WGSL statement per entry, also without it. */
  private simpleStatement(): string[] {
    if (this.isDeclaration()) return this.declaration();
    if (this.peek().text === "++" || this.peek().text === "--") {
      const operator = this.next().text;
      return [this.assign(this.unary(), operator === "++" ? "+=" : "-=", { code: "1", type: "int", constant: true, literal: true })];
    }
    const left = this.ternary();
    const token = this.peek();
    if (token.kind === "symbol" && ASSIGNMENTS.has(token.text)) {
      this.next();
      return [this.assign(left, token.text, this.ternary())];
    }
    if (token.text === "++" || token.text === "--") {
      this.next();
      return [this.assign(left, token.text === "++" ? "+=" : "-=", { code: "1", type: "int", constant: true, literal: true })];
    }
    return [left.type === "void" ? left.code : `_ = ${left.code}`];
  }

  private declaration(): string[] {
    let constant = false;
    while (this.peek().text === "const" || this.peek().text === "highp" || this.peek().text === "mediump" || this.peek().text === "lowp") {
      if (this.next().text === "const") constant = true;
    }
    const type = this.typeName();
    const lines: string[] = [];
    do {
      const name = this.name();
      let declared = type;
      if (this.accept("[")) {
        const size = this.next();
        if (size.kind !== "number" || !size.whole) this.fail("an array needs a whole number for its size");
        this.expect("]");
        declared = `${type}[${size.text}]`;
      }
      // The name is known only after its value, which may read an outer one of the same name.
      const value = this.accept("=") ? this.fit(this.ternary(), declared) : null;
      const code = this.declare(name, declared);
      if (value !== null) lines.push(`${constant ? "let" : "var"} ${code}: ${wgslType(declared)} = ${value}`);
      else lines.push(`var ${code}: ${wgslType(declared)}`);
    } while (this.accept(","));
    return lines;
  }

  /** Notes a by-value parameter of the function an assignment changes (directly, or a component or element of it). */
  private noteAssigned(left: Value): void {
    if (!this.parameters) return;
    const root = /^[A-Za-z_]\w*/.exec((left.mask?.base ?? left).code)?.[0];
    const name = root ? this.parameters.codes.get(root) : undefined;
    if (!root || name === undefined) return;
    // Only when the name is the parameter here, not a local of the same name in a block inside.
    for (let index = this.scopes.length - 1; index >= 0; index--) {
      if (!this.scopes[index].has(name)) continue;
      if (index === this.parameters.scope) this.parameters.assigned.add(root);
      return;
    }
  }

  private assign(left: Value, operator: string, right: Value): string {
    this.noteAssigned(left);
    const value = operator === "=" ? right : this.combine(operator.slice(0, -1), left, right);
    const fitted = this.fit(value, left.type);
    if (!left.mask || left.mask.letters.length === 1) return `${left.code} = ${fitted}`;
    const held = `mgHeld${this.temporaries++}`;
    const { base, letters } = left.mask;
    const parts = [...letters].map((letter, index) => `${base.code}.${letter} = ${held}.${"xyzw"[index]};`);
    return `{\nlet ${held} = ${fitted};\n${parts.join("\n")}\n}`;
  }

  // ---------------------------------------------------------------- Expressions

  private ternary(): Value {
    const condition = this.binary(1);
    if (!this.accept("?")) return condition;
    const whenTrue = this.ternary();
    this.expect(":");
    const whenFalse = this.ternary();
    const type = this.meeting(whenTrue, whenFalse);
    return { code: `select(${this.fit(whenFalse, type)}, ${this.fit(whenTrue, type)}, ${this.fit(condition, "bool")})`, type, constant: false };
  }

  private binary(level: number): Value {
    let left = this.unary();
    for (;;) {
      const token = this.peek();
      const precedence = token.kind === "symbol" ? BINARY_LEVELS[token.text] : undefined;
      if (precedence === undefined || precedence < level) return left;
      this.next();
      const right = this.binary(precedence + 1);
      left = this.combine(token.text, left, right);
    }
  }

  /** The type two values come to when they meet: the wider, on the side of real numbers. */
  private meeting(a: Value, b: Value): string {
    if (a.type === b.type) return a.type;
    if (isMatrix(a.type) || isMatrix(b.type) || isArray(a.type) || isArray(b.type)) this.fail(`${a.type} and ${b.type} do not go together`);
    if (a.type === "void" || b.type === "void") this.fail("a call with no value is used as one");
    const elementA = elementOf(a.type);
    const elementB = elementOf(b.type);
    let element = elementA;
    if (elementA !== elementB) {
      if (a.literal) element = elementB;
      else if (b.literal) element = elementA;
      else if (elementA === "float" || elementB === "float") element = "float";
      else if (elementA === "bool" || elementB === "bool") this.fail(`${a.type} and ${b.type} do not go together`);
      else element = "uint";
    }
    const size = Math.max(sizeOf(a.type), sizeOf(b.type));
    if (sizeOf(a.type) > 1 && sizeOf(b.type) > 1 && sizeOf(a.type) !== sizeOf(b.type)) this.fail(`${a.type} and ${b.type} are different sizes`);
    return vectorOf(element, size);
  }

  private combine(operator: string, a: Value, b: Value): Value {
    const constant = a.constant && b.constant;
    switch (operator) {
      case "&&":
      case "||":
        return { code: `(${this.fit(a, "bool")} ${operator} ${this.fit(b, "bool")})`, type: "bool", constant };
      case "^^":
        return { code: `(${this.fit(a, "bool")} != ${this.fit(b, "bool")})`, type: "bool", constant };
      case "<<":
      case ">>":
        return { code: `(${a.code} ${operator} ${b.literal ? b.code : `u32(${b.code})`})`, type: a.type, constant };
      case "==":
      case "!=": {
        const type = this.meeting(a, b);
        const compared = `(${this.fit(a, type)} ${operator} ${this.fit(b, type)})`;
        if (isVector(type)) return { code: `${operator === "==" ? "all" : "any"}${compared}`, type: "bool", constant };
        return { code: compared, type: "bool", constant };
      }
      case "<":
      case ">":
      case "<=":
      case ">=": {
        const type = this.meeting(a, b);
        if (sizeOf(type) !== 1) this.fail(`${operator} only compares single numbers`);
        return { code: `(${this.fit(a, type)} ${operator} ${this.fit(b, type)})`, type: "bool", constant };
      }
      default:
        break;
    }
    if (isMatrix(a.type) || isMatrix(b.type)) return this.matrixArithmetic(operator, a, b);
    if (isArray(a.type) || isArray(b.type) || a.type === "sampler2D" || b.type === "sampler2D") this.fail(`${operator} on ${a.type} and ${b.type}`);
    // Vector with number is the same in both languages, once they agree what kind of number it is.
    const meeting = this.meeting(a, b);
    const element = elementOf(meeting);
    const left = this.fit(a, sizeOf(a.type) > 1 ? vectorOf(element, sizeOf(a.type)) : element);
    let right = this.fit(b, sizeOf(b.type) > 1 ? vectorOf(element, sizeOf(b.type)) : element);
    // Worked out while compiling, a division can come to nothing: this leaves it until the shader runs.
    if ((operator === "/" || operator === "%") && constant && element === "float") right = this.kept(right, sizeOf(b.type));
    return { code: `(${left} ${operator} ${right})`, type: meeting, constant: constant && operator !== "/" && operator !== "%" };
  }

  private matrixArithmetic(operator: string, a: Value, b: Value): Value {
    const constant = false;
    if (operator === "*") {
      if (isMatrix(a.type) && isMatrix(b.type)) {
        if (a.type !== b.type) this.fail("matrices of different sizes");
        return { code: `(${a.code} * ${b.code})`, type: a.type, constant };
      }
      if (isMatrix(a.type) && isVector(b.type)) return { code: `(${a.code} * ${this.fit(b, b.type)})`, type: b.type, constant };
      if (isVector(a.type) && isMatrix(b.type)) return { code: `(${this.fit(a, a.type)} * ${b.code})`, type: a.type, constant };
      if (isMatrix(a.type)) return { code: `(${a.code} * ${this.fit(b, "float")})`, type: a.type, constant };
      return { code: `(${this.fit(a, "float")} * ${b.code})`, type: b.type, constant };
    }
    if (operator === "/" && isMatrix(a.type) && !isMatrix(b.type)) return { code: `(${a.code} * (1.0 / ${this.fit(b, "float")}))`, type: a.type, constant };
    if ((operator === "+" || operator === "-") && a.type === b.type) return { code: `(${a.code} ${operator} ${b.code})`, type: a.type, constant };
    return this.fail(`${operator} on ${a.type} and ${b.type}`);
  }

  private kept(code: string, size: number): string {
    const name = `mgKeep${Math.max(size, 1)}`;
    this.context.called?.(name);
    return `${name}(${code})`;
  }

  private unary(): Value {
    const token = this.peek();
    if (token.kind === "symbol") {
      if (token.text === "-") {
        this.next();
        const value = this.unary();
        return { code: `(-${value.code})`, type: value.type, constant: value.constant, literal: value.literal };
      }
      if (token.text === "+") {
        this.next();
        return this.unary();
      }
      if (token.text === "!") {
        this.next();
        const value = this.unary();
        return { code: `(!${this.fit(value, "bool")})`, type: "bool", constant: value.constant };
      }
      if (token.text === "~") {
        this.next();
        const value = this.unary();
        return { code: `(~${value.code})`, type: value.type, constant: value.constant };
      }
    }
    return this.postfix(this.primary());
  }

  private primary(): Value {
    const token = this.next();
    if (token.kind === "number") {
      if (!token.whole) return { code: token.text, type: "float", constant: true };
      if (/[uU]$/.test(token.text)) return { code: token.text, type: "uint", constant: true, literal: true };
      return { code: token.text, type: "int", constant: true, literal: true };
    }
    if (token.kind === "symbol" && token.text === "(") {
      const value = this.ternary();
      this.expect(")");
      // The mask of a value in brackets stays assignable, as in GLSL.
      return { ...value, code: /^[\w.]+$/.test(value.code) ? value.code : `(${value.code})` };
    }
    if (token.kind === "name") {
      // float[3](...) is an array's constructor.
      if (this.isTypeName(token.text) && this.peek().text === "[") {
        this.expect("[");
        const size = this.next();
        this.expect("]");
        this.expect("(");
        const type = `${token.text}[${size.text}]`;
        const items = this.argumentList().map((item) => this.fit(item, token.text));
        return { code: `array<${wgslType(token.text)}, ${size.text}>(${items.join(", ")})`, type, constant: false };
      }
      if (this.peek().kind === "symbol" && this.peek().text === "(") {
        this.next();
        return this.call(token.text, this.argumentList());
      }
      return this.lookup(token.text);
    }
    this.at--;
    return this.fail(`unexpected "${token.text}"`);
  }

  private argumentList(): Value[] {
    const items: Value[] = [];
    if (this.accept(")")) return items;
    do items.push(this.ternary());
    while (this.accept(","));
    this.expect(")");
    return items;
  }

  private postfix(start: Value): Value {
    let value = start;
    for (;;) {
      if (this.accept(".")) {
        value = this.member(value, this.name());
      } else if (this.accept("[")) {
        const index = this.ternary();
        this.expect("]");
        value = this.indexed(value, index);
      } else {
        return value;
      }
    }
  }

  private member(base: Value, name: string): Value {
    if (!isVector(base.type)) this.fail(`.${name} on ${base.type}`);
    if (!/^(?:[xyzw]{1,4}|[rgba]{1,4}|[stpq]{1,4})$/.test(name)) this.fail(`.${name} is not a mask`);
    const letters = name.replace(/[rgba]/g, (letter) => ({ r: "x", g: "y", b: "z", a: "w" }[letter] as string))
      .replace(/[stpq]/g, (letter) => ({ s: "x", t: "y", p: "z", q: "w" }[letter] as string));
    const size = sizeOf(base.type);
    if ([...letters].some((letter) => "xyzw".indexOf(letter) >= size)) this.fail(`.${name} on ${base.type}`);
    return { code: `${base.code}.${letters}`, type: vectorOf(elementOf(base.type), letters.length), constant: base.constant, mask: { base, letters } };
  }

  private indexed(base: Value, index: Value): Value {
    const at = this.fit(index, elementOf(index.type) === "uint" ? "uint" : "int");
    if (isArray(base.type)) return { code: `${base.code}[${at}]`, type: base.type.slice(0, base.type.indexOf("[")), constant: false };
    if (isMatrix(base.type)) return { code: `${base.code}[${at}]`, type: `vec${MATRIX_SIZES[base.type]}`, constant: false };
    if (isVector(base.type)) return { code: `${base.code}[${at}]`, type: elementOf(base.type), constant: false };
    return this.fail(`[] on ${base.type}`);
  }

  /** `value` as `type`, as GLSL would have it fit or by the widening and narrowing nodes rely on. */
  private fit(value: Value, type: string): string {
    if (value.type === type || type === "void") return value.code;
    if (value.type === "void") this.fail("a call with no value is used as one");
    if (isArray(type) || isMatrix(type) || isArray(value.type) || isMatrix(value.type) || value.type === "sampler2D") this.fail(`${value.type} used as ${type}`);
    const fromSize = sizeOf(value.type);
    const toSize = sizeOf(type);
    const toElement = elementOf(type);
    if (fromSize === 1 && toSize === 1) {
      if (value.literal && toElement === "float") return value.code.startsWith("(-") ? `(-${value.code.slice(2, -1)}.0)` : `${value.code}.0`;
      if (value.literal && toElement !== "bool") return value.code;
      return `${wgslType(type)}(${value.code})`;
    }
    if (fromSize === 1) return `${wgslType(type)}(${this.fit(value, toElement)})`;
    if (fromSize < toSize) this.fail(`${value.type} used as ${type}`);
    const narrowed = fromSize > toSize ? `${value.code}.${"xyzw".slice(0, toSize)}` : value.code;
    return elementOf(value.type) === toElement ? narrowed : `${wgslType(type)}(${narrowed})`;
  }

  // ---------------------------------------------------------------- Calls

  private construct(type: string, args: Value[]): Value {
    const constant = args.every((arg) => arg.constant);
    if (type in VECTOR_SIZES) {
      const size = sizeOf(type);
      const element = elementOf(type);
      if (size === 1) {
        if (args.length !== 1) this.fail(`${type}() takes one value`);
        const arg = args[0];
        if (arg.literal && element !== "bool") return { code: this.fit(arg, type), type, constant };
        const single = sizeOf(arg.type) > 1 ? `${arg.code}.x` : arg.code;
        return { code: elementOf(arg.type) === element ? single : `${wgslType(type)}(${single})`, type, constant };
      }
      if (args.length === 1) {
        const arg = args[0];
        if (sizeOf(arg.type) === 1) return { code: `${wgslType(type)}(${this.fit(arg, element)})`, type, constant };
        return { code: this.fit(arg, type), type, constant };
      }
      const parts = args.map((arg) => this.fit(arg, sizeOf(arg.type) === 1 ? element : vectorOf(element, sizeOf(arg.type))));
      const count = args.reduce((sum, arg) => sum + sizeOf(arg.type), 0);
      if (count !== size) this.fail(`${type}() given ${count} components`);
      return { code: `${wgslType(type)}(${parts.join(", ")})`, type, constant };
    }
    const size = MATRIX_SIZES[type];
    const name = wgslType(type);
    if (args.length === 1 && isMatrix(args[0].type)) {
      if (MATRIX_SIZES[args[0].type] < size) this.fail(`${args[0].type} used as ${type}`);
      if (MATRIX_SIZES[args[0].type] === size) return { code: args[0].code, type, constant };
      const columns = Array.from({ length: size }, (_, index) => `${args[0].code}[${index}].${"xyzw".slice(0, size)}`);
      return { code: `${name}(${columns.join(", ")})`, type, constant };
    }
    if (args.length === 1) {
      const diagonal = this.fit(args[0], "float");
      const cells = Array.from({ length: size * size }, (_, index) => (index % (size + 1) === 0 ? diagonal : "0.0"));
      return { code: `${name}(${cells.join(", ")})`, type, constant };
    }
    if (args.length === size && args.every((arg) => sizeOf(arg.type) === size)) {
      return { code: `${name}(${args.map((arg) => this.fit(arg, `vec${size}`)).join(", ")})`, type, constant };
    }
    if (args.length === size * size) return { code: `${name}(${args.map((arg) => this.fit(arg, "float")).join(", ")})`, type, constant };
    return this.fail(`${type}() given ${args.length} values`);
  }

  private countArguments(name: string, args: Value[], ...counts: number[]): void {
    if (!counts.includes(args.length)) this.fail(`${name}() does not take ${args.length} values`);
  }

  /** Makes every argument real numbers of the widest type among them, the way `max(v, 0.0)` wants it in WGSL. */
  private widened(args: Value[]): { type: string; codes: string[] } {
    let held = args[0];
    for (const arg of args.slice(1)) held = { ...arg, type: this.meeting(held, arg), literal: held.literal && arg.literal };
    const type = held.literal ? vectorOf("float", sizeOf(held.type)) : held.type;
    return { type, codes: args.map((arg) => this.fit(arg, type)) };
  }

  /**
   * A call to one of WGSL's functions, whose first input is of `firstType`: when every input is known while compiling,
   * it is left until the shader runs.
   */
  private builtin(name: string, type: string, codes: string[], args: Value[], firstType = type): Value {
    const keep = args.every((arg) => arg.constant) && firstType in VECTOR_SIZES && elementOf(firstType) === "float";
    const first = keep ? [this.kept(codes[0], sizeOf(firstType)), ...codes.slice(1)] : codes;
    return { code: `${name}(${first.join(", ")})`, type, constant: false };
  }

  /** The overload of a function whose parameters the arguments fit best: exactly, else by the widening GLSL allows. */
  private overloadFor(name: string, overloads: readonly GlslFunction[], args: Value[]): GlslFunction {
    const score = (candidate: GlslFunction): number => {
      const params = candidate.params ?? [];
      if (params.length !== args.length) return -1;
      let total = 0;
      for (let index = 0; index < params.length; index++) {
        const arg = args[index];
        const param = params[index];
        if (arg.type === param) total += 2;
        else if (arg.literal && sizeOf(param) === 1 && param !== "bool") total += 1;
        else if (sizeOf(arg.type) === sizeOf(param) && sizeOf(param) > 0 && elementOf(param) === "float" && elementOf(arg.type) !== "bool") total += 0;
        else return -1;
      }
      return total;
    };
    let best: GlslFunction | null = null;
    let bestScore = -1;
    for (const candidate of overloads) {
      const value = score(candidate);
      if (value > bestScore) { best = candidate; bestScore = value; }
    }
    return best ?? this.fail(`no ${name}() takes ${args.map((arg) => arg.type).join(", ")}`);
  }

  private call(name: string, args: Value[]): Value {
    if (name in VECTOR_SIZES || name in MATRIX_SIZES) return this.construct(name, args);

    const found = this.context.functions[name];
    const known = found?.overloads ? this.overloadFor(name, found.overloads, args) : found;
    if (known) {
      this.context.called?.(name);
      const parts = args.map((arg, index) => {
        if (known.outs?.includes(index)) return `&${arg.code}`;
        const type = known.params?.[index];
        // A texture handed to a function is the texture and the sampler it is read with, as WGSL keeps them apart.
        if (type === "sampler2D") {
          if (!arg.texture) this.fail(`${name}() needs a texture`);
          return `${arg.texture.texture}, ${arg.texture.sampler}`;
        }
        return type ? this.fit(arg, type) : arg.code;
      });
      if (known.params && known.params.length !== args.length) this.fail(`${name}() takes ${known.params.length} values`);
      return { code: `${known.code ?? name}(${parts.join(", ")})`, type: known.returns, constant: false };
    }

    if (name in SAME_TYPE) {
      this.countArguments(name, args, 1);
      if (DERIVATIVES.has(name) && this.context.stage !== "fragment") this.fail(`${name}() only exists on a surface's pixels`);
      const type = elementOf(args[0].type) === "float" ? args[0].type : vectorOf("float", sizeOf(args[0].type));
      const code = this.fit(args[0], type);
      if (DERIVATIVES.has(name)) return { code: `${SAME_TYPE[name]}(${code})`, type, constant: false };
      return this.builtin(SAME_TYPE[name], type, [code], args);
    }
    if (name in COMPARES) {
      this.countArguments(name, args, 2);
      const type = this.meeting(args[0], args[1]);
      return { code: `(${this.fit(args[0], type)} ${COMPARES[name]} ${this.fit(args[1], type)})`, type: vectorOf("bool", sizeOf(type)), constant: false };
    }

    switch (name) {
      case "abs":
      case "sign":
        this.countArguments(name, args, 1);
        return { code: `${name}(${this.fit(args[0], args[0].literal ? "float" : args[0].type)})`, type: args[0].literal ? "float" : args[0].type, constant: args[0].constant };
      case "atan": {
        this.countArguments(name, args, 1, 2);
        if (args.length === 1) return this.builtin("atan", args[0].type, [this.fit(args[0], args[0].literal ? "float" : args[0].type)], args);
        const { type, codes } = this.widened(args);
        return this.builtin("atan2", type, codes, args);
      }
      case "min":
      case "max": {
        this.countArguments(name, args, 2);
        const { type, codes } = this.widened(args);
        return this.builtin(name, type, codes, args);
      }
      case "pow": {
        this.countArguments(name, args, 2);
        const { type, codes } = this.widened(args);
        return this.builtin("pow", vectorOf("float", sizeOf(type)), codes, args);
      }
      case "clamp": {
        this.countArguments(name, args, 3);
        const { type, codes } = this.widened(args);
        return this.builtin("clamp", type, codes, args);
      }
      case "step": {
        this.countArguments(name, args, 2);
        const { type, codes } = this.widened(args);
        return this.builtin("step", type, codes, args);
      }
      case "smoothstep": {
        this.countArguments(name, args, 3);
        const { type, codes } = this.widened(args);
        return this.builtin("smoothstep", type, codes, args);
      }
      case "mix": {
        this.countArguments(name, args, 3);
        const { type, codes } = this.widened(args.slice(0, 2));
        if (elementOf(args[2].type) === "bool") return { code: `select(${codes[0]}, ${codes[1]}, ${args[2].code})`, type, constant: false };
        const blend = sizeOf(args[2].type) > 1 ? this.fit(args[2], type) : this.fit(args[2], "float");
        return this.builtin("mix", type, [...codes, blend], args);
      }
      case "mod": {
        this.countArguments(name, args, 2);
        const { type } = this.widened(args);
        const x = this.fit(args[0], type);
        const y = sizeOf(args[1].type) > 1 ? this.fit(args[1], type) : this.fit(args[1], "float");
        const divisor = args[1].constant ? this.kept(y, sizeOf(args[1].type)) : y;
        return { code: `(${x} - ${y} * floor(${x} / ${divisor}))`, type, constant: false };
      }
      case "length":
      case "determinant":
        this.countArguments(name, args, 1);
        return this.builtin(name, "float", [args[0].literal ? this.fit(args[0], "float") : args[0].code], args, args[0].literal ? "float" : args[0].type);
      case "distance":
      case "dot": {
        this.countArguments(name, args, 2);
        const { type, codes } = this.widened(args);
        return this.builtin(name, "float", codes, args, type);
      }
      case "cross":
        this.countArguments(name, args, 2);
        return { code: `cross(${this.fit(args[0], "vec3")}, ${this.fit(args[1], "vec3")})`, type: "vec3", constant: false };
      case "reflect": {
        this.countArguments(name, args, 2);
        const { type, codes } = this.widened(args);
        return { code: `reflect(${codes.join(", ")})`, type, constant: false };
      }
      case "refract": {
        this.countArguments(name, args, 3);
        const { type, codes } = this.widened(args.slice(0, 2));
        return { code: `refract(${codes.join(", ")}, ${this.fit(args[2], "float")})`, type, constant: false };
      }
      case "faceforward": {
        this.countArguments(name, args, 3);
        const { type, codes } = this.widened(args);
        return { code: `faceForward(${codes.join(", ")})`, type, constant: false };
      }
      case "transpose":
        this.countArguments(name, args, 1);
        return { code: `transpose(${args[0].code})`, type: args[0].type, constant: false };
      case "inverse": {
        this.countArguments(name, args, 1);
        if (args[0].type !== "mat2" && args[0].type !== "mat3") this.fail(`inverse() of ${args[0].type} is not available`);
        const helper = args[0].type === "mat2" ? "mgInverse2" : "mgInverse3";
        this.context.called?.(helper);
        return { code: `${helper}(${args[0].code})`, type: args[0].type, constant: false };
      }
      case "any":
      case "all":
        this.countArguments(name, args, 1);
        return { code: `${name}(${args[0].code})`, type: "bool", constant: false };
      case "not":
        this.countArguments(name, args, 1);
        return { code: `(!${args[0].code})`, type: args[0].type, constant: false };
      case "pow2":
      case "pow3":
      case "pow4": {
        this.countArguments(name, args, 1);
        const helper = `mgPow${name[3]}`;
        this.context.called?.(helper);
        return { code: `${helper}(${this.fit(args[0], "float")})`, type: "float", constant: false };
      }
      case "average":
        this.countArguments(name, args, 1);
        return { code: `dot(${this.fit(args[0], "vec3")}, vec3f(0.3333333))`, type: "float", constant: false };
      case "luminance":
        this.countArguments(name, args, 1);
        return { code: `dot(${this.fit(args[0], "vec3")}, vec3f(0.2126729, 0.7151522, 0.072175))`, type: "float", constant: false };
      case "rand":
        this.countArguments(name, args, 1);
        this.context.called?.("mgRand");
        return { code: `mgRand(${this.fit(args[0], "vec2")})`, type: "float", constant: false };
      case "texelFetch": {
        const texture = args[0]?.texture;
        if (!texture) this.fail(`${name}() needs a texture`);
        this.countArguments(name, args, 3);
        return { code: `textureLoad(${texture.texture}, ${this.fit(args[1], "ivec2")}, ${this.fit(args[2], "int")})`, type: "vec4", constant: false };
      }
      case "textureSize": {
        const texture = args[0]?.texture;
        if (!texture) this.fail(`${name}() needs a texture`);
        this.countArguments(name, args, 1, 2);
        return { code: `vec2i(textureDimensions(${texture.texture}, ${args.length > 1 ? this.fit(args[1], "int") : "0"}))`, type: "ivec2", constant: false };
      }
      case "floatBitsToUint":
      case "floatBitsToInt":
      case "uintBitsToFloat":
      case "intBitsToFloat": {
        this.countArguments(name, args, 1);
        const size = Math.max(1, sizeOf(args[0].type));
        const from = name.startsWith("float") ? "float" : name.startsWith("uint") ? "uint" : "int";
        const to = name.endsWith("Uint") ? "uint" : name.endsWith("Int") ? "int" : "float";
        const type = vectorOf(to, size);
        return { code: `bitcast<${wgslType(type)}>(${this.fit(args[0], vectorOf(from, size))})`, type, constant: false };
      }
      case "texture":
      case "texture2D":
      case "textureLod":
      case "texture2DLodEXT": {
        const texture = args[0]?.texture;
        if (!texture) this.fail(`${name}() needs a texture`);
        const uv = this.fit(args[1], "vec2");
        const lod = name === "textureLod" || name === "texture2DLodEXT";
        if (lod) return { code: `textureSampleLevel(${texture.texture}, ${texture.sampler}, ${uv}, ${this.fit(args[2], "float")})`, type: "vec4", constant: false };
        // Vertices have no neighbours to choose a mip level from, so GLSL reads the largest.
        if (this.context.stage !== "fragment") return { code: `textureSampleLevel(${texture.texture}, ${texture.sampler}, ${uv}, 0.0)`, type: "vec4", constant: false };
        if (args.length === 3) return { code: `textureSampleBias(${texture.texture}, ${texture.sampler}, ${uv}, ${this.fit(args[2], "float")})`, type: "vec4", constant: false };
        return { code: `textureSample(${texture.texture}, ${texture.sampler}, ${uv})`, type: "vec4", constant: false };
      }
      default:
        return this.fail(`unknown function ${name}()`);
    }
  }
}
