import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GarmentInspector } from '../../components/Environment/GarmentInspector';
import { createSleevelessTop, readGarmentPattern } from '../../runtime/garments/pattern';
import type { LevelComponent, LevelObject } from '../../types';

const object: LevelObject = { id: 'dress-form', levelId: 'level', modelId: '', type: 'prop', name: 'Dress form',
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
function mount(props: Record<string, unknown> = {}) {
    const save = vi.fn();
    function Editor() {
        const [component, set] = useState<LevelComponent>({ id: 'garment-1', type: 'garment', enabled: true, props });
        return <GarmentInspector object={object} component={component} onChangeProps={patch => {
            save(patch); set({ ...component, props: { ...component.props, ...patch } });
        }} />;
    }
    render(<Editor />);
    return save;
}
function choose(label: string, value: string) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function editNumber(label: string, value: string) {
    choose(label, value); fireEvent.blur(screen.getByLabelText(label));
}

describe('garment pattern inspector', () => {
    it('commits one measured edit, rejects invalid mesh detail and leaves the source valid', () => {
        const save = mount();
        const source = createSleevelessTop();
        const panel = source.panels[0];
        expect(save).not.toHaveBeenCalled();
        editNumber('Grain angle (°)', '30');
        expect(save).toHaveBeenCalledTimes(1);
        expect(readGarmentPattern(save.mock.lastCall![0].pattern).panels[0].grain[0]).toBeCloseTo(Math.cos(Math.PI / 6));
        editNumber('Mesh edge (mm)', '-1');
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(save).toHaveBeenCalledTimes(1);
        choose('Point / outgoing edge', panel.boundary[0].id);
        fireEvent.click(screen.getByRole('button', { name: 'Split edge' }));
        expect(readGarmentPattern(save.mock.lastCall![0].pattern).panels[0].boundary.length).toBe(panel.boundary.length + 1);
    });
    it('unsews an existing seam and stitches the same two edges across panel selection', () => {
        const pattern = createSleevelessTop();
        const join = pattern.seams[0];
        const selectSide = (side: typeof join.a) => {
            const panel = pattern.panels.find(p => p.id === side.panelId)!;
            const index = panel.boundary.findIndex(p => p.id === side.from);
            const forward = panel.boundary[(index + 1) % panel.boundary.length].id === side.to;
            choose('Pattern panel', panel.id); choose('Point / outgoing edge', forward ? side.from : side.to);
        };
        const save = mount({ pattern });
        selectSide(join.a);
        fireEvent.click(screen.getByRole('button', { name: 'Unsew edge' }));
        expect(readGarmentPattern(save.mock.lastCall![0].pattern).seams.length).toBe(3);
        fireEvent.click(screen.getByRole('button', { name: 'Start seam' }));
        selectSide(join.b);
        fireEvent.click(screen.getByRole('button', { name: 'Sew to first edge' }));
        expect(readGarmentPattern(save.mock.lastCall![0].pattern).seams.length).toBe(4);
        expect(save).toHaveBeenCalledTimes(2);
    });
    it('preserves malformed user data until explicit replacement and lets the artist add a panel', () => {
        const save = mount({ pattern: { version: 42 } });
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(save).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Replace with starter pattern' }));
        fireEvent.click(screen.getByRole('button', { name: 'Add panel' }));
        const pattern = readGarmentPattern(save.mock.lastCall![0].pattern);
        expect(pattern.panels).toHaveLength(3);
        expect(screen.getByLabelText('Pattern panel')).toHaveValue(pattern.panels[2].id);
    });
    it('edits a layer, duplicates and selects the independent panel, and adds new pieces at the active rank', () => {
        const save = mount();
        expect(screen.getByLabelText('Contact layer')).toHaveValue('0');
        choose('Contact layer', '3');
        expect(save).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: 'Duplicate panel' }));
        expect(save).toHaveBeenCalledTimes(2);
        let pattern = readGarmentPattern(save.mock.lastCall![0].pattern);
        const copy = pattern.panels[2];
        expect(screen.getByLabelText('Pattern panel')).toHaveValue(copy.id);
        expect(screen.getByLabelText('Contact layer')).toHaveValue('4');
        expect(copy.layer).toBe(4);
        expect(pattern.seams).toEqual(createSleevelessTop().seams);
        fireEvent.click(screen.getByRole('button', { name: 'Add panel' }));
        expect(save).toHaveBeenCalledTimes(3);
        pattern = readGarmentPattern(save.mock.lastCall![0].pattern);
        expect(pattern.panels[3].layer).toBe(4);
        choose('Contact layer', '0');
        expect(save).toHaveBeenCalledTimes(4);
        expect(save.mock.lastCall![0].pattern.panels[3]).not.toHaveProperty('layer');
    });
    it('applies a signed placement rotation in one undoable patch and keeps a rejected operation out of history', () => {
        const save = mount();
        fireEvent.click(screen.getByText('Panel placement', { selector: 'summary' }));
        choose('Local rotation axis', 'v');
        choose('Rotate by (°)', '-90');
        expect(save).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Rotate panel' }));
        expect(save).toHaveBeenCalledTimes(1);
        const p = readGarmentPattern(save.mock.lastCall![0].pattern);
        expect(p.panels[0].placement.u[2]).toBeCloseTo(1);
        expect(p.panels[0].boundary).toEqual(createSleevelessTop().panels[0].boundary);
        choose('Rotate by (°)', '361');
        fireEvent.click(screen.getByRole('button', { name: 'Rotate panel' }));
        expect(screen.getByRole('alert')).toHaveTextContent(/degrees/);
        expect(save).toHaveBeenCalledTimes(1);
    });
    it('removes selected point and panel with affected stitches in single transactions, preserving selection', () => {
        const save = mount();
        choose('Point / outgoing edge', 'right_shoulder_outer');
        fireEvent.click(screen.getByRole('button', { name: 'Delete point' }));
        expect(save).toHaveBeenCalledTimes(1);
        const removedPoint = readGarmentPattern(save.mock.lastCall![0].pattern);
        expect(removedPoint.panels[0].pins).not.toContain('right_shoulder_outer');
        expect(removedPoint.seams).toHaveLength(3);
        expect(screen.getByLabelText('Point / outgoing edge')).toHaveValue('right_neck');
        fireEvent.click(screen.getByRole('button', { name: 'Delete panel' }));
        expect(save).toHaveBeenCalledTimes(2);
        const remaining = readGarmentPattern(save.mock.lastCall![0].pattern);
        expect(remaining.panels.map(p => p.id)).toEqual(['back']);
        expect(remaining.seams).toHaveLength(0);
        expect(screen.getByLabelText('Pattern panel')).toHaveValue('back');
        expect(screen.getByRole('button', { name: 'Delete panel' })).toBeDisabled();
    });

});
