import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ClipRangeEditor, type ClipRangeResult } from '../../components/UI/Properties/ClipRangeEditor';
import type { ClipTake, ClipTakeSource } from '../../utils/clipTakes';
import type { ClipRange } from '../../types';

vi.mock('../../components/UI/Properties/ClipRangePreview', () => ({ ClipRangePreview: () => <div data-testid="preview" /> }));

beforeAll(() => {
  // The timeline measures itself, which a test's page has no layout for.
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});

const clip = (name: string, seconds: number): THREE.AnimationClip => new THREE.AnimationClip(name, seconds, [
  new THREE.VectorKeyframeTrack('Hips.position', [0, seconds], [0, 1, 0, 0, 1, seconds]),
]);

const take = (id: string, seconds = 10, fields: Partial<ClipTake> = {}): ClipTake => ({
  id, attached: false, label: id, clip: clip(id, seconds), start: 0, framesPerSecond: 30, clipName: id, ...fields,
});

const open = async (takes: ClipTake[], props: Partial<React.ComponentProps<typeof ClipRangeEditor>> = {}) => {
  const dispose = vi.fn();
  const source: ClipTakeSource = { object: new THREE.Group(), takes, dispose };
  const onConfirm = vi.fn<(result: ClipRangeResult) => void>();
  const onCancel = vi.fn();
  const view = render(<ClipRangeEditor name="kit.fbx" load={async () => source} ranges={[]} excludedClips={[]} confirmLabel="Done" onConfirm={onConfirm} onCancel={onCancel} {...props} />);
  await waitFor(() => expect(screen.queryByText(/Reading the file/)).toBeNull());
  return { onConfirm, onCancel, dispose, view };
};

const done = () => fireEvent.click(screen.getByRole('button', { name: 'Done' }));

const stored = (fields: Partial<ClipRange> = {}): ClipRange => ({ take: 'Long', name: 'Idle', start: 1, end: 3, loop: true, ...fields });

describe('cutting a take in the editor', () => {
  it('starts from the whole take under its own name, which then stands in for the take', async () => {
    const { onConfirm } = await open([take('Long', 10, { clipName: 'Kit' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Add clip' }));
    expect((screen.getByLabelText('Clip name') as HTMLInputElement).value).toBe('Kit');
    done();
    expect(onConfirm).toHaveBeenCalledWith({
      clipRanges: [{ take: 'Long', name: 'Kit', start: 0, end: 10, loop: true }],
      excludedClips: ['Long'],
    });
  });

  it('takes a range typed in frames, on the timeline of the file', async () => {
    const { onConfirm } = await open([take('Long', 10, { start: 2 })]);
    fireEvent.click(screen.getByRole('button', { name: 'Add clip' }));
    const start = screen.getByLabelText('Start') as HTMLInputElement;
    const end = screen.getByLabelText('End') as HTMLInputElement;
    expect(start.value).toBe('60');
    expect(end.value).toBe('360');
    fireEvent.change(start, { target: { value: '90' } });
    fireEvent.blur(start);
    fireEvent.change(end, { target: { value: '150' } });
    fireEvent.blur(end);
    done();
    const [range] = onConfirm.mock.calls[0][0].clipRanges;
    expect(range.start).toBeCloseTo(1, 5);
    expect(range.end).toBeCloseTo(3, 5);
  });

  it('takes a range typed in seconds', async () => {
    const { onConfirm } = await open([take('Long')]);
    fireEvent.click(screen.getByRole('radio', { name: 'Seconds' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add clip' }));
    const end = screen.getByLabelText('End') as HTMLInputElement;
    expect(end.value).toBe('10.000');
    fireEvent.change(end, { target: { value: '2.5' } });
    fireEvent.keyDown(end, { key: 'Enter' });
    done();
    expect(onConfirm.mock.calls[0][0].clipRanges[0].end).toBeCloseTo(2.5, 5);
  });

  it('keeps a range on the take and at least a frame long', async () => {
    const { onConfirm } = await open([take('Long')]);
    fireEvent.click(screen.getByRole('button', { name: 'Add clip' }));
    const start = screen.getByLabelText('Start') as HTMLInputElement;
    const end = screen.getByLabelText('End') as HTMLInputElement;
    fireEvent.change(end, { target: { value: '99999' } });
    fireEvent.blur(end);
    fireEvent.change(start, { target: { value: '-5' } });
    fireEvent.blur(start);
    done();
    let [range] = onConfirm.mock.calls[0][0].clipRanges;
    expect(range.start).toBe(0);
    expect(range.end).toBe(10);
    fireEvent.change(end, { target: { value: '30' } });
    fireEvent.blur(end);
    fireEvent.change(start, { target: { value: '60' } });
    fireEvent.blur(start);
    done();
    [range] = onConfirm.mock.calls[1][0].clipRanges;
    expect(range.start).toBeCloseTo(2, 5);
    expect(range.end).toBeCloseTo(2 + 1 / 30, 5);
  });

  it('names a clip and sets whether it loops', async () => {
    const { onConfirm } = await open([take('Long')]);
    fireEvent.click(screen.getByRole('button', { name: 'Add clip' }));
    fireEvent.change(screen.getByLabelText('Clip name'), { target: { value: 'Attack' } });
    fireEvent.click(screen.getByLabelText('Loops'));
    done();
    expect(onConfirm.mock.calls[0][0].clipRanges[0]).toMatchObject({ name: 'Attack', loop: false });
  });

  it('asks for names that differ, from each other and from whole takes', async () => {
    const { onConfirm } = await open([take('Long'), take('Walk')], { initialTake: 'Long', ranges: [stored()], excludedClips: ['Long'], initialClip: 'Idle' });
    fireEvent.change(screen.getByLabelText('Clip name'), { target: { value: 'Walk' } });
    expect(screen.getByRole('alert').textContent).toContain('Walk');
    expect((screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Clip name'), { target: { value: '' } });
    expect(screen.getByRole('alert').textContent).toContain('needs a name');
    fireEvent.change(screen.getByLabelText('Clip name'), { target: { value: 'Stretch' } });
    done();
    expect(onConfirm.mock.calls[0][0].clipRanges[0].name).toBe('Stretch');
  });

  it('brings a take back when its last clip goes', async () => {
    const { onConfirm } = await open([take('Long')], { ranges: [stored()], excludedClips: ['Long'], initialClip: 'Idle' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove this clip' }));
    done();
    expect(onConfirm).toHaveBeenCalledWith({ clipRanges: [], excludedClips: [] });
  });

  it('can keep the whole take as well', async () => {
    const { onConfirm } = await open([take('Long', 10, { clipName: 'Kit' })], { ranges: [stored()], excludedClips: ['Long'] });
    fireEvent.click(screen.getByLabelText(/Also keep the whole take as "Kit"/));
    done();
    expect(onConfirm.mock.calls[0][0].excludedClips).toEqual([]);
  });

  it('splits a clip at the playhead, and both halves say what it said', async () => {
    const { onConfirm } = await open([take('Long')], { ranges: [stored({ start: 0, end: 4, loop: false, recentre: true })], excludedClips: ['Long'], initialClip: 'Idle' });
    fireEvent.click(screen.getByRole('button', { name: 'A frame on' }));
    fireEvent.click(screen.getByRole('button', { name: /Split at playhead/ }));
    done();
    const { clipRanges } = onConfirm.mock.calls[0][0];
    expect(clipRanges.map((range) => range.name)).toEqual(['Idle', 'Idle 2']);
    expect(clipRanges[0].end).toBeCloseTo(1 / 30, 5);
    expect(clipRanges[1]).toMatchObject({ start: expect.closeTo(1 / 30, 5), end: 4, loop: false, recentre: true });
  });

  it('splits on S without the key landing in a name, and leaves the keyboard on the timeline', async () => {
    const { onConfirm } = await open([take('Long')], { ranges: [stored({ start: 0, end: 4 })], excludedClips: ['Long'], initialClip: 'Idle' });
    fireEvent.click(screen.getByRole('button', { name: 'A frame on' }));
    const typed = fireEvent.keyDown(document.body, { key: 's' });
    expect(typed).toBe(false);
    expect(document.activeElement?.getAttribute('aria-label')).not.toBe('Clip name');
    done();
    expect(onConfirm.mock.calls[0][0].clipRanges.map((range) => range.name)).toEqual(['Idle', 'Idle 2']);
  });

  it('puts the name in reach of typing when a clip is added', async () => {
    await open([take('Long')]);
    fireEvent.click(screen.getByRole('button', { name: 'Add clip' }));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Clip name');
  });

  it('takes ranges saved under the old name of a take in a file with one take', async () => {
    const { onConfirm } = await open([take('New name')], { ranges: [stored({ take: 'Old name' })], excludedClips: ['Old name'] });
    expect(screen.getByRole('button', { name: /Idle/ })).toBeTruthy();
    done();
    expect(onConfirm).toHaveBeenCalledWith({ clipRanges: [stored({ take: 'New name' })], excludedClips: ['New name'] });
  });

  it('opens on the clip it was asked for, in its own take', async () => {
    await open([take('Walk'), take('Long')], { ranges: [stored()], excludedClips: ['Long'], initialClip: 'Idle' });
    expect((screen.getByLabelText('Clip name') as HTMLInputElement).value).toBe('Idle');
    expect(screen.getByRole('combobox').textContent).toContain('Long');
  });

  it('marks ranges on a clip imported onto the model as such', async () => {
    const { onConfirm } = await open([take('Mocap', 10, { attached: true })]);
    fireEvent.click(screen.getByRole('button', { name: 'Add clip' }));
    done();
    expect(onConfirm.mock.calls[0][0].clipRanges[0]).toMatchObject({ take: 'Mocap', attached: true });
  });

  it('leaves ranges on takes it was not given alone', async () => {
    const other = stored({ take: 'Mocap', name: 'Wave', attached: true });
    const { onConfirm } = await open([take('Long')], { ranges: [other] });
    done();
    expect(onConfirm.mock.calls[0][0].clipRanges).toEqual([other]);
  });

  it('says when there is nothing to cut, and when reading fails', async () => {
    await open([]);
    expect(screen.getByText('This file has no animation to cut.')).toBeTruthy();
    render(<ClipRangeEditor name="bad.fbx" load={async () => { throw new Error('It is broken.'); }} ranges={[]} excludedClips={[]} confirmLabel="Done" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('It is broken.')).toBeTruthy());
  });

  it('shuts on Escape without touching what is behind it, and lets go of what it read', async () => {
    const behind = vi.fn();
    window.addEventListener('keydown', behind);
    const { onCancel, dispose, view } = await open([take('Long')]);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(behind).not.toHaveBeenCalled();
    window.removeEventListener('keydown', behind);
    view.unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
