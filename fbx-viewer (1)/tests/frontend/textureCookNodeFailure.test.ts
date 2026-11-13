import { describe, expect, it } from 'vitest';
import { textureCookNodeFailure } from '../../runtime/materials/graphCooker';

describe('texture graph backend fallback diagnostics', () => {
    it('identifies the precise stored node, including type, name and stable ID', () => {
        const text = textureCookNodeFailure(
            { id: 'node-200', type: 'paintStack', name: 'Dirt on steel' },
            'No WebGPU translation for fragment struct',
        );
        expect(text).toContain('node-200');
        expect(text).toContain('paintStack');
        expect(text).toContain('Dirt on steel');
        expect(text).toContain('No WebGPU translation for fragment struct');
        expect(text).not.toContain('undefined');
    });

    it('does not depend on user names to distinguish repeated nodes', () => {
        const a = textureCookNodeFailure({ id: 'a', type: 'blur' }, 'device rejected the shader');
        const b = textureCookNodeFailure({ id: 'b', type: 'blur' }, 'device rejected the shader');
        expect(a).not.toBe(b);
        expect(a).toContain('id: a');
        expect(b).toContain('id: b');
    });

    it('is informative when the node was removed or could not be resolved', () => {
        expect(textureCookNodeFailure(undefined, 'unknown node')).toBe('A texture graph node could not be drawn: unknown node');
    });
});
