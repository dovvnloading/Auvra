import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
    NAMED_RECEIVE_TYPE,
    NAMED_SEND_TYPE,
    OUTPUT_NODE_TYPE,
    compileMaterialGraph,
    defaultParams,
    materialGraphShape,
    namedMaterialLinks,
    normalizeMaterialGraph,
    type MaterialGraph,
} from '../../runtime/materials/materialGraph';
import { NodeInspector } from '../../components/Materials/MaterialNodeInspector';

const node = (id: string, type: string, params: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, params: { ...defaultParams(type), ...params } });
const link = (fromNode: string, fromOutput: string, toNode: string, toInput: string) => ({ fromNode, fromOutput, toNode, toInput });

/** A red colour sent as "Tint" and received far away into the base colour. */
const sent = (receiverName = 'Tint'): MaterialGraph => normalizeMaterialGraph({
    nodes: [
        node('out', OUTPUT_NODE_TYPE),
        node('red', 'color', { value: [1, 0, 0] }),
        node('send', NAMED_SEND_TYPE, { name: ' Tint ' }),
        node('later', NAMED_SEND_TYPE, { name: 'Tint' }),
        node('get', NAMED_RECEIVE_TYPE, { name: receiverName }),
    ],
    links: [link('red', 'out', 'send', 'in'), link('get', 'out', 'out', 'baseColor')],
});

describe('named links in a shader graph', () => {
    it('stand for a wire from the first Send of a name to each Receive of it', () => {
        expect(namedMaterialLinks(sent())).toEqual([{ fromNode: 'send', fromOutput: 'out', toNode: 'get', toInput: 'in' }]);
        expect(namedMaterialLinks(sent('Other'))).toEqual([]);
    });

    it('compile as if wired, and a Receive with no Send gives its own value', () => {
        const compiled = compileMaterialGraph(sent());
        expect(compiled.unused.sort()).toEqual(['later']);
        expect(compiled.statements.join('\n')).toMatch(/vec3 mg_get_out_out_\d+ = mg_send_out_out_\d+;/);
        const lonely = compileMaterialGraph(sent('Other'));
        expect(lonely.unused.sort()).toEqual(['later', 'red', 'send']);
    });

    it('change the shader when a name changes', () => {
        expect(materialGraphShape(sent('Other'))).not.toBe(materialGraphShape(sent()));
    });
});

describe('the node inspector', () => {
    it('marks a custom code node\'s error on its code', () => {
        const custom = { id: 'code', type: 'customGlsl', x: 0, y: 0, params: { ...defaultParams('customGlsl'), code: 'return a * wobble;' } };
        render(createElement(NodeInspector, { node: custom, textures: [], error: 'Uses “wobble”, which is not defined here.', onChangeNode: () => undefined }));
        expect(screen.getByText(/wobble”, which is not defined here/)).toBeTruthy();
    });

    it('edits a named link\'s name as text', () => {
        render(createElement(NodeInspector, { node: { id: 'send', type: NAMED_SEND_TYPE, x: 0, y: 0, params: { name: 'Tint' } }, textures: [], onChangeNode: () => undefined }));
        expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Tint');
    });
});
