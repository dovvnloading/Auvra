import { describe, expect, it } from 'vitest';
import { parseShaderErrors, tokenizeLine } from '../../components/Texturing/codeText';

describe('code settings', () => {
    it('colours GLSL words, numbers, comments and the node\'s own names', () => {
        const tokens = tokenizeLine('vec4 v = c_a(uv) * 0.5; // half', new Set(['uv']));
        const kinds = Object.fromEntries(tokens.filter((token) => token.text.trim()).map((token) => [token.text.trim(), token.kind]));
        expect(kinds.vec4).toBe('type');
        expect(kinds.c_a).toBe('name');
        expect(kinds.uv).toBe('name');
        expect(kinds['0.5']).toBe('number');
        expect(kinds['// half']).toBe('comment');
        expect(tokens.map((token) => token.text).join('')).toBe('vec4 v = c_a(uv) * 0.5; // half');
        expect(tokenizeLine('if (x > 1.0) return mix(a, b, t);').find((token) => token.text === 'mix')?.kind).toBe('function');
    });

    it('reads a compile log into errors on the typed lines', () => {
        const errors = parseShaderErrors("ERROR: 0:3: 'foo' : undeclared identifier\nERROR: 0:3: '' : compilation terminated\n2 compilation errors.  No code generated.");
        expect(errors[0]).toEqual({ line: 3, message: 'foo: undeclared identifier' });
        expect(errors).toHaveLength(2);
        expect(parseShaderErrors('The shader did not compile.')).toEqual([{ line: null, message: 'The shader did not compile.' }]);
        expect(parseShaderErrors(null)).toEqual([]);
    });
});
