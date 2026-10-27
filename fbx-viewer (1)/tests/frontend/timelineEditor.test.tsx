import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimelineInspector } from '../../components/Timeline/TimelineInspector';
import type { LevelComponent, LevelObject } from '../../types';
import type { TimelineData } from '../../runtime/timeline/types';

const makeObject = (id: string, name: string, patch: Partial<LevelObject> = {}): LevelObject => ({
    id,
    levelId: 'level-1',
    modelId: '',
    name,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    type: 'prop',
    ...patch,
});

const door = makeObject('door', 'Door', { position: [1, 2, 3], rotation: [0, Math.PI / 2, 0], scale: [2, 2, 2] });
const lamp = makeObject('lamp', 'Lamp');
const elsewhere = makeObject('far', 'Elsewhere', { levelId: 'level-2' });

const { scene } = vi.hoisted(() => ({
    scene: {
        levelObjects: [] as LevelObject[],
        activeLevelBlueprint: { nodes: [], connections: [], variables: [{ id: 'var-1', name: 'score', type: 'Float', value: 0 }] },
    },
}));

vi.mock('../../context/SceneContext', () => ({ useScene: () => scene }));

const renderInspector = (timeline?: unknown) => {
    const onChangeProps = vi.fn();
    const component: LevelComponent = { id: 'timeline-1', type: 'timeline', enabled: true, props: timeline === undefined ? {} : { timeline } };
    render(<TimelineInspector object={door} component={component} onChangeProps={onChangeProps} />);
    return onChangeProps;
};

const openEditor = () => {
    fireEvent.click(screen.getByRole('button', { name: /Edit Timeline/ }));
    const dialog = screen.getByRole('dialog', { name: 'Timeline editor' });
    // 100 px per second, so pointer moves of 100 px are 1 s (jsdom lays every element out at 0).
    fireEvent.change(screen.getByLabelText('Zoom'), { target: { value: '100' } });
    return dialog;
};

/** Clicks the ruler at `seconds`; time 0 sits 10 px into the ruler, so a key there clears the track headers. */
const setPlayhead = (seconds: number) => {
    const ruler = screen.getByRole('slider', { name: 'Playhead' });
    fireEvent.pointerDown(ruler, { pointerId: 9, clientX: 10 + seconds * 100 });
    fireEvent.pointerUp(ruler, { pointerId: 9, clientX: 10 + seconds * 100 });
};

const keyButton = (name: string) => screen.getByRole('button', { name });

/** The single committed timeline. */
const savedTimeline = (onChangeProps: ReturnType<typeof vi.fn>): TimelineData => {
    expect(onChangeProps).toHaveBeenCalledTimes(1);
    return (onChangeProps.mock.calls[0][0] as { timeline: TimelineData }).timeline;
};

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));

describe('Timeline editor', () => {
    const windowKeys = vi.fn();

    beforeEach(() => {
        scene.levelObjects = [door, lamp, elsewhere];
        window.addEventListener('keydown', windowKeys);
    });

    afterEach(() => {
        window.removeEventListener('keydown', windowKeys);
    });

    it('summarises the stored timeline and offers the level objects as targets', () => {
        renderInspector({
            duration: 4,
            tracks: [
                { id: 't1', kind: 'transform', objectId: 'lamp', position: [{ time: 0, value: [0, 0, 0] }, { time: 2, value: [0, 1, 0] }] },
                { id: 't2', kind: 'event', muted: true, keys: [{ time: 1, value: 'Boom' }] },
            ],
        });
        expect(screen.getByText('4.00 s')).toBeInTheDocument();
        expect(screen.getByText('2 tracks · 3 keys · 1 muted')).toBeInTheDocument();

        openEditor();
        const track = screen.getByRole('group', { name: 'Lamp track' });
        const target = within(track).getByLabelText('Target object') as HTMLSelectElement;
        expect(target.value).toBe('lamp');
        expect([...target.options].map(option => option.textContent)).toEqual(['Door', 'Lamp']);
        expect(within(screen.getByRole('group', { name: 'Events track' })).getByRole('button', { name: 'Unmute track' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('adds a transform track, keys it at the playhead and records the object', () => {
        const onChangeProps = renderInspector();
        expect(screen.getByText('0 tracks · 0 keys')).toBeInTheDocument();
        openEditor();

        fireEvent.click(screen.getByRole('button', { name: 'Add Transform track' }));
        const track = screen.getByRole('group', { name: 'Door track' });
        expect((within(track).getByLabelText('Target object') as HTMLSelectElement).value).toBe('door');

        setPlayhead(1);
        expect(screen.getByRole('slider', { name: 'Playhead' })).toHaveAttribute('aria-valuenow', '1');
        fireEvent.doubleClick(screen.getByRole('group', { name: 'Door Position keys' }));
        expect(keyButton('Door Position key at 1.00 s')).toHaveAttribute('aria-pressed', 'true');
        // With no keys yet the new key starts from the target's current position.
        expect(screen.getByLabelText('Position X')).toHaveValue('1');
        expect(screen.getByLabelText('Position Z')).toHaveValue('3');

        // Double-clicking at a time that already has a key selects it instead of stacking another.
        fireEvent.doubleClick(screen.getByRole('group', { name: 'Door Position keys' }));
        expect(screen.getAllByRole('button', { name: /Door Position key at/ })).toHaveLength(1);

        setPlayhead(2.02);
        fireEvent.click(within(track).getByRole('button', { name: 'Add key from object' }));
        expect(keyButton('Door Position key at 2.00 s')).toHaveAttribute('aria-pressed', 'true');
        expect(keyButton('Door Rotation key at 2.00 s')).toBeInTheDocument();
        expect(keyButton('Door Scale key at 2.00 s')).toBeInTheDocument();

        save();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        const saved = savedTimeline(onChangeProps);
        expect(saved).toEqual({
            duration: 5,
            tracks: [{
                id: expect.any(String),
                kind: 'transform',
                objectId: 'door',
                position: [{ time: 1, value: [1, 2, 3] }, { time: 2, value: [1, 2, 3] }],
                rotation: [{ time: 2, value: [0, 90, 0] }],
                scale: [{ time: 2, value: [2, 2, 2] }],
            }],
        });
        expect(saved.tracks[0].id).not.toBe('');
    });

    it('moves a key by dragging, snapping to 0.05 s unless Shift is held', () => {
        const onChangeProps = renderInspector({
            duration: 4,
            tracks: [{ id: 'v1', kind: 'variable', name: 'speed', keys: [{ time: 1, value: 0 }, { time: 2, value: 10 }] }],
        });
        openEditor();

        const key = keyButton('speed Value key at 1.00 s');
        fireEvent.pointerDown(key, { pointerId: 1, clientX: 100 });
        expect(key).toHaveAttribute('aria-pressed', 'true');
        fireEvent.pointerMove(key, { pointerId: 1, clientX: 133 });
        expect(keyButton('speed Value key at 1.35 s')).toHaveAttribute('aria-pressed', 'true');

        // Free timing, past the other key: the moved key re-sorts and stays selected.
        fireEvent.pointerMove(key, { pointerId: 1, clientX: 212, shiftKey: true });
        expect(keyButton('speed Value key at 2.12 s')).toHaveAttribute('aria-pressed', 'true');
        expect(keyButton('speed Value key at 2.00 s')).toHaveAttribute('aria-pressed', 'false');

        // Dragging stops at the end of the timeline.
        fireEvent.pointerMove(key, { pointerId: 1, clientX: 900 });
        expect(keyButton('speed Value key at 4.00 s')).toBeInTheDocument();
        fireEvent.pointerMove(key, { pointerId: 1, clientX: 252 });
        fireEvent.pointerUp(key, { pointerId: 1, clientX: 252 });
        expect(screen.getByLabelText('Key time')).toHaveValue('2.5');

        // Moves after the pointer is released do nothing.
        fireEvent.pointerMove(key, { pointerId: 1, clientX: 400 });
        expect(keyButton('speed Value key at 2.50 s')).toBeInTheDocument();

        save();
        expect(savedTimeline(onChangeProps).tracks[0]).toEqual({
            id: 'v1', kind: 'variable', name: 'speed', keys: [{ time: 2, value: 10 }, { time: 2.5, value: 0 }],
        });
    });

    it('deletes the selected key and tracks without reaching the world editor hotkeys', () => {
        const onChangeProps = renderInspector({
            duration: 3,
            tracks: [
                { id: 'vis', kind: 'visibility', objectId: 'lamp', keys: [{ time: 0.5, value: false }, { time: 1.5, value: true }] },
                { id: 'ev', kind: 'event', keys: [{ time: 1, value: 'Boom' }] },
            ],
        });
        const dialog = openEditor();

        const key = keyButton('Lamp Visible key at 0.50 s');
        fireEvent.pointerDown(key, { pointerId: 2, clientX: 50 });
        fireEvent.pointerUp(key, { pointerId: 2, clientX: 50 });
        fireEvent.keyDown(key, { key: 'Delete' });
        expect(screen.queryByRole('button', { name: 'Lamp Visible key at 0.50 s' })).not.toBeInTheDocument();
        expect(dialog).toHaveFocus();

        // A key typed while focus sits outside the editor is kept from the level's Delete/Undo hotkeys.
        fireEvent.pointerDown(keyButton('Lamp Visible key at 1.50 s'), { pointerId: 3, clientX: 150 });
        fireEvent.keyDown(document.body, { key: 'Backspace' });
        expect(screen.queryByRole('button', { name: 'Lamp Visible key at 1.50 s' })).not.toBeInTheDocument();
        fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
        expect(windowKeys).not.toHaveBeenCalled();

        // Typing in a field never deletes the selected key.
        fireEvent.pointerDown(keyButton('Events Events key at 1.00 s'), { pointerId: 4, clientX: 100 });
        const eventName = screen.getByLabelText('Event name');
        fireEvent.keyDown(eventName, { key: 'Backspace' });
        expect(keyButton('Events Events key at 1.00 s')).toBeInTheDocument();

        fireEvent.click(within(screen.getByRole('group', { name: 'Events track' })).getByRole('button', { name: 'Delete track' }));
        expect(screen.queryByRole('group', { name: 'Events track' })).not.toBeInTheDocument();
        expect(screen.getByText('No key selected')).toBeInTheDocument();

        save();
        expect(savedTimeline(onChangeProps)).toEqual({
            duration: 3,
            tracks: [{ id: 'vis', kind: 'visibility', objectId: 'lamp', keys: [] }],
        });
    });

    it('changes interpolation on blending keys only', () => {
        const onChangeProps = renderInspector({
            duration: 2,
            tracks: [
                { id: 'move', kind: 'transform', objectId: 'lamp', position: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [0, 5, 0] }] },
                { id: 'vis', kind: 'visibility', objectId: 'lamp', keys: [{ time: 1, value: true }] },
            ],
        });
        openEditor();

        fireEvent.pointerDown(keyButton('Lamp Visible key at 1.00 s'), { pointerId: 1, clientX: 100 });
        expect(screen.queryByLabelText('Interpolation')).not.toBeInTheDocument();
        expect(screen.getByText(/Visibility keys always step/)).toBeInTheDocument();

        fireEvent.pointerDown(keyButton('Lamp Position key at 0.00 s'), { pointerId: 2, clientX: 0 });
        const interpolation = screen.getByLabelText('Interpolation') as HTMLSelectElement;
        expect(interpolation.value).toBe('linear');
        fireEvent.change(interpolation, { target: { value: 'smooth' } });
        expect(interpolation.value).toBe('smooth');
        fireEvent.change(screen.getByLabelText('Position Y'), { target: { value: '2.5' } });

        save();
        expect(savedTimeline(onChangeProps).tracks[0]).toEqual({
            id: 'move',
            kind: 'transform',
            objectId: 'lamp',
            position: [{ time: 0, value: [0, 2.5, 0], interpolation: 'smooth' }, { time: 1, value: [0, 5, 0] }],
        });
    });

    it('authors variable and event tracks, renames, mutes and changes the duration', () => {
        const onChangeProps = renderInspector();
        openEditor();
        expect(document.querySelector('datalist option[value="score"]')).not.toBeNull();

        fireEvent.change(screen.getByLabelText('Duration'), { target: { value: '8' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add Variable track' }));
        fireEvent.change(screen.getByLabelText('Variable name'), { target: { value: 'score' } });
        setPlayhead(0.5);
        fireEvent.doubleClick(screen.getByRole('group', { name: 'score Value keys' }));
        fireEvent.change(screen.getByLabelText('Value'), { target: { value: '5' } });

        fireEvent.click(screen.getByRole('button', { name: 'Add Event track' }));
        setPlayhead(6);
        fireEvent.doubleClick(screen.getByRole('group', { name: 'Events Events keys' }));
        fireEvent.change(screen.getByLabelText('Event name'), { target: { value: 'Explode' } });
        const events = screen.getByRole('group', { name: 'Events track' });
        fireEvent.change(within(events).getByLabelText('Track name'), { target: { value: 'Cues' } });
        const cues = screen.getByRole('group', { name: 'Cues track' });
        fireEvent.click(within(cues).getByRole('button', { name: 'Mute track' }));
        expect(within(cues).getByRole('button', { name: 'Unmute track' })).toHaveAttribute('aria-pressed', 'true');

        save();
        const saved = savedTimeline(onChangeProps);
        expect(saved.duration).toBe(8);
        expect(saved.tracks).toEqual([
            { id: expect.any(String), kind: 'variable', name: 'score', keys: [{ time: 0.5, value: 5 }] },
            { id: expect.any(String), kind: 'event', label: 'Cues', muted: true, keys: [{ time: 6, value: 'Explode' }] },
        ]);
        expect(saved.tracks[0].id).not.toBe(saved.tracks[1].id);
    });

    it('asks before discarding unsaved changes and commits nothing on cancel', () => {
        const onChangeProps = renderInspector({ duration: 5, tracks: [] });

        openEditor();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        openEditor();
        fireEvent.click(screen.getByRole('button', { name: 'Add Event track' }));
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.getByRole('alertdialog', { name: 'Discard changes' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Keep Editing' }));
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        expect(screen.getByRole('group', { name: 'Events track' })).toBeInTheDocument();

        fireEvent.keyDown(screen.getByRole('dialog', { name: 'Timeline editor' }), { key: 'Escape' });
        expect(screen.getByRole('alertdialog', { name: 'Discard changes' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(onChangeProps).not.toHaveBeenCalled();
        expect(windowKeys).not.toHaveBeenCalled();

        // Saving with nothing changed closes without an edit.
        openEditor();
        save();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(onChangeProps).not.toHaveBeenCalled();
    });
});
