import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { resolveParticleEffect, type Curve } from '../../runtime/particleEffect';
import { ParticleCurveEditor } from '../../components/Environment/ParticleCurveEditor';
import { ParticlesInspector } from '../../components/Environment/ParticlesInspector';
import type { LevelObject } from '../../types';

vi.mock('../../context/SceneContext', () => ({ useScene: () => ({ textures: [] }) }));

const original: Curve = { points: [[0, 1], [0.5, 2], [1, 0.5]] };
function renderEditor(initial: Curve = original, maximum = 10) {
    const save = vi.fn();
    function Harness() {
        const [value, set] = useState(initial);
        return <>
            <ParticleCurveEditor label="Speed" maximum={maximum} domain="Lifetime" value={value}
                onCommit={curve => { save(curve); set(curve); }} />
            <button onClick={() => set({ points: [[0, 1], [1, 3]] })}>External edit</button>
        </>;
    }
    render(<Harness />);
    const plot = screen.getByRole('group', { name: 'Speed plot' });
    vi.spyOn(plot, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 220, 104));
    return { save, plot };
}
const second = () => screen.getByRole('button', { name: /^Speed key 2,/ });
const drag = (plot: Element) => {
    fireEvent.pointerDown(second(), { button: 0, pointerId: 7, clientX: 110, clientY: 32 });
    fireEvent.pointerMove(plot, { pointerId: 7, clientX: 148, clientY: 57 });
};
describe('particle curve authoring', () => {
    it('writes each inspector curve to its own effect module without replacing the others', () => {
        const object: LevelObject = { id: 'object', levelId: 'level', modelId: '', name: 'Smoke', type: 'prop', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
        const save = vi.fn();
        const props = { preset: 'smoke', rate: 31 };
        const original = resolveParticleEffect(props);
        render(<ParticlesInspector object={object} component={{ id: 'smoke', type: 'particles', enabled: true, props }} onChangeProps={save} />);
        for (const [label, module] of [['Rate multiplier', 'rateOverCycle'], ['Size', 'sizeOverLife'], ['Speed', 'speedOverLife']] as const) {
            const field = screen.getByText(label, { selector: 'legend' }).parentElement!;
            fireEvent.change(within(field).getByLabelText('Interpolation'), { target: { value: 'smooth' } });
            expect(resolveParticleEffect(save.mock.lastCall![0])).toEqual({ ...original, [module]: { ...original[module], interpolation: 'smooth' } });
        }
    });
    it('previews drags locally, dismisses cancel and Escape, commits once on release', () => {
        const { save, plot } = renderEditor();
        const start = second().getAttribute('cx');
        drag(plot);
        expect(second().getAttribute('cx')).not.toBe(start);
        expect(save).not.toHaveBeenCalled();
        fireEvent.pointerCancel(plot, { pointerId: 7 });
        expect(second().getAttribute('cx')).toBe(start);
        drag(plot);
        fireEvent.keyDown(second(), { key: 'Escape' });
        fireEvent.pointerUp(plot, { pointerId: 7 });
        expect(second().getAttribute('cx')).toBe(start);
        expect(save).not.toHaveBeenCalled();
        drag(plot);
        fireEvent.pointerMove(plot, { pointerId: 7, clientX: 161, clientY: 52 });
        fireEvent.pointerUp(plot, { pointerId: 7 });
        expect(save).toHaveBeenCalledTimes(1);
        expect(save.mock.lastCall![0].points[1]).toEqual([0.75, 1.5]);
    });
    it('abandons a drag superseded by an outside edit and keeps the refreshed keys', () => {
        const { plot, save } = renderEditor();
        drag(plot);
        fireEvent.click(screen.getByRole('button', { name: 'External edit' }));
        fireEvent.pointerUp(plot, { pointerId: 7 });
        expect(second()).toHaveAccessibleName('Speed key 2, 100%, 3 times');
        expect(save).not.toHaveBeenCalled();
    });
    it('renders the stored interpolation and retains it across keyboard, number and key edits', () => {
        const { save, plot } = renderEditor();
        const select = screen.getByLabelText('Interpolation');
        const path = () => plot.querySelector('path[pointer-events="none"]')?.getAttribute('d');
        fireEvent.change(select, { target: { value: 'smooth' } });
        expect(path()).toContain(' C ');
        fireEvent.change(select, { target: { value: 'step' } });
        expect(path()).toContain(' V ');
        fireEvent.click(screen.getByRole('button', { name: 'Add key' }));
        expect(save.mock.lastCall![0]).toMatchObject({ interpolation: 'step', points: [[0, 1], [0.25, 1], [0.5, 2], [1, 0.5]] });
        fireEvent.keyDown(second(), { key: 'ArrowRight' });
        fireEvent.keyDown(second(), { key: 'ArrowUp', shiftKey: true });
        expect(save.mock.lastCall![0].points[1]).toEqual([0.26, 2]);
        const amount = screen.getByLabelText('Value (×)');
        fireEvent.change(amount, { target: { value: '17.34567' } });
        fireEvent.blur(amount);
        expect(save.mock.lastCall![0].points[1][1]).toBe(10);
        fireEvent.change(amount, { target: { value: '1.34567' } });
        fireEvent.blur(amount);
        expect(save.mock.lastCall![0].points[1][1]).toBe(1.34567);
        fireEvent.keyDown(second(), { key: 'Delete' });
        expect(save.mock.lastCall![0]).toEqual({ ...original, interpolation: 'step' });
    });
    it('adds at the cursor and in empty intervals, respects the limits on keys and values', () => {
        const { save, plot } = renderEditor({ points: [[0, 1]] }, 50);
        expect(screen.getByRole('button', { name: 'Delete key' })).toBeDisabled();
        fireEvent.doubleClick(plot, { clientX: 110, clientY: 8 });
        expect(save.mock.lastCall![0].points[1]).toEqual([0.5, 2]);
        fireEvent.doubleClick(plot, { clientX: 110, clientY: 62 });
        expect(save).toHaveBeenCalledTimes(1);
        const amount = screen.getByLabelText('Value (×)');
        for (const [typed, effective] of [['54', 50], ['-2', 0]] as const) {
            fireEvent.change(amount, { target: { value: typed } });
            fireEvent.blur(amount);
            expect(save.mock.lastCall![0].points[1][1]).toBe(effective);
        }
        const add = screen.getByRole('button', { name: 'Add key' });
        for (let i = 2; i < 8; i++) fireEvent.click(add);
        expect(add).toBeDisabled();
        const times = save.mock.lastCall![0].points.map((p: number[]) => p[0]);
        expect(new Set(times).size).toBe(8);
    });
});
