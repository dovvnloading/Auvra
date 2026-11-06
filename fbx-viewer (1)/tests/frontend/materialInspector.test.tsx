import { createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NodeInspector } from '../../components/Materials/MaterialNodeInspector';
import { OUTPUT_NODE_TYPE, defaultParams, type MaterialGraphNode } from '../../runtime/materials/materialGraph';

const output = (): MaterialGraphNode => ({ id: 'out', type: OUTPUT_NODE_TYPE, x: 0, y: 0, params: defaultParams(OUTPUT_NODE_TYPE) });

describe('the material\'s settings in the inspector', () => {
    it('offer Alpha mode and Shading with the shared Select, not a plain browser list', () => {
        const onChangeNode = vi.fn();
        const { container } = render(createElement(NodeInspector, { node: output(), textures: [], title: 'Material', wired: new Set<string>(), onChangeNode }));
        expect(container.querySelector('select')).toBeNull();
        expect(screen.getByRole('combobox', { name: 'Shading' })).toBeTruthy();
        fireEvent.click(screen.getByRole('combobox', { name: 'Alpha mode' }));
        fireEvent.click(screen.getByRole('option', { name: 'Masked (cut-out)' }));
        expect(onChangeNode).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ blendMode: 'masked' }) }), 'out:blendMode');
    });

    it('show a node\'s own name, with its kind beside it', () => {
        const node: MaterialGraphNode = { id: 'mul', type: 'multiply', x: 0, y: 0, params: defaultParams('multiply'), name: 'Tint' };
        render(createElement(NodeInspector, { node, textures: [], onChangeNode: () => undefined }));
        expect(screen.getByText('Tint')).toBeTruthy();
        expect(screen.getByText('Multiply')).toBeTruthy();
    });
});
