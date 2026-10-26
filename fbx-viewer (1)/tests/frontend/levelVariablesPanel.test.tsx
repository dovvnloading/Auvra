import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  coerceLevelVariableValue,
  LevelVariableEdit,
  LevelVariableEntry,
  levelVariableEdits,
  levelVariableNameError,
  LevelVariablesPanel,
  renameLevelVariableReferences,
} from '../../components/LevelBlueprint/LevelVariablesPanel';
import { createLevelVariablesStore } from '../../runtime/levelVariables';
import type { LogicNode } from '../../types';

/** Holds the blueprint's variables like the editor does: every onChange is one write to blueprint.variables. */
const renderPanel = (initial: LevelVariableEntry[], onAddNode?: (type: string, name: string) => void) => {
  const writes: { variables: LevelVariableEntry[], edit: LevelVariableEdit }[] = [];
  const Harness = () => {
    const [variables, setVariables] = useState(initial);
    return (
      <LevelVariablesPanel
        variables={variables}
        onChange={(next, edit) => { writes.push({ variables: next, edit }); setVariables(next); }}
        onAddNode={onAddNode}
      />
    );
  };
  render(<Harness />);
  return {
    writes,
    latest: () => writes[writes.length - 1]?.variables ?? initial,
    row: (name: string) => within(screen.getByRole('listitem', { name })),
  };
};

const score: LevelVariableEntry = { id: 'v-score', name: 'Score', type: 'Float', value: 5 };
const doorOpen: LevelVariableEntry = { id: 'v-door', name: 'DoorOpen', type: 'Boolean', value: false };

describe('level variables panel', () => {
  it('adds variables with unique names and a Float default, one write each', () => {
    const panel = renderPanel([]);
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add variable' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add variable' }));

    expect(panel.writes.map(write => write.edit)).toEqual([{ kind: 'add', index: 0 }, { kind: 'add', index: 1 }]);
    expect(panel.latest()).toEqual([
      { id: expect.any(String), name: 'NewVar', type: 'Float', value: 0 },
      { id: expect.any(String), name: 'NewVar1', type: 'Float', value: 0 },
    ]);
    expect(panel.latest()[0].id).not.toBe(panel.latest()[1].id);
    expect(panel.row('NewVar1').getByRole('textbox', { name: 'Name' })).toHaveFocus();
  });

  it('renames on blur with the trimmed name and leaves the other variables untouched', () => {
    const panel = renderPanel([score, doorOpen]);
    const name = panel.row('Score').getByRole('textbox', { name: 'Name' });

    fireEvent.change(name, { target: { value: '  Points ' } });
    expect(panel.writes).toHaveLength(0);
    fireEvent.blur(name);

    expect(panel.writes).toHaveLength(1);
    expect(panel.writes[0].edit).toEqual({ kind: 'rename', index: 0, from: 'Score', to: 'Points' });
    expect(panel.latest()).toEqual([{ id: 'v-score', name: 'Points', type: 'Float', value: 5 }, doorOpen]);
    expect(panel.latest()[1]).toBe(doorOpen);
    expect(screen.getByRole('listitem', { name: 'Points' })).toBeInTheDocument();
  });

  it('refuses duplicate and blank names and restores the saved name', () => {
    const panel = renderPanel([score, doorOpen]);
    const name = panel.row('DoorOpen').getByRole('textbox', { name: 'Name' });

    fireEvent.change(name, { target: { value: ' Score' } });
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('A variable named "Score" already exists.');
    fireEvent.blur(name);
    expect(name).toHaveValue('DoorOpen');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.change(name, { target: { value: '   ' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Name cannot be blank.');
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(name).toHaveValue('DoorOpen');

    expect(panel.writes).toHaveLength(0);
    expect(levelVariableEdits.rename([score, doorOpen], 1, 'Score')).toBeNull();
    expect(levelVariableEdits.rename([score, doorOpen], 1, '')).toBeNull();
    expect(levelVariableNameError('DoorOpen', [score, doorOpen], 1)).toBeNull();
    expect(levelVariableNameError('Score', [score, doorOpen])).toMatch(/already exists/);
  });

  it('coerces the default when the type changes', () => {
    const panel = renderPanel([{ id: 'v-ratio', name: 'Ratio', type: 'Float', value: 2.5 }]);
    const type = () => panel.row('Ratio').getByRole('combobox', { name: 'Type' });

    fireEvent.change(type(), { target: { value: 'Boolean' } });
    expect(panel.latest()).toEqual([{ id: 'v-ratio', name: 'Ratio', type: 'Boolean', value: true }]);
    expect(panel.row('Ratio').getByRole('checkbox', { name: 'Default value' })).toBeChecked();

    fireEvent.change(type(), { target: { value: 'String' } });
    expect(panel.latest()[0]).toMatchObject({ type: 'String', value: 'true' });

    fireEvent.change(type(), { target: { value: 'Float' } });
    expect(panel.latest()[0]).toMatchObject({ type: 'Float', value: 0 });
    expect(panel.writes.map(write => write.edit.kind)).toEqual(['type', 'type', 'type']);

    expect(coerceLevelVariableValue('Float', true)).toBe(1);
    expect(coerceLevelVariableValue('Float', '42')).toBe(42);
    expect(coerceLevelVariableValue('Boolean', 0)).toBe(false);
    expect(coerceLevelVariableValue('Boolean', 'false')).toBe(false);
    expect(coerceLevelVariableValue('String', 7.5)).toBe('7.5');
  });

  it('edits number, boolean and text defaults', () => {
    const panel = renderPanel([score, doorOpen, { id: 'v-label', name: 'Label', type: 'String', value: 'hi' }]);
    const number = panel.row('Score').getByRole('spinbutton', { name: 'Default value' });

    fireEvent.change(number, { target: { value: '' } });
    expect(panel.writes).toHaveLength(0);
    fireEvent.change(number, { target: { value: '-3.5' } });
    fireEvent.click(panel.row('DoorOpen').getByRole('checkbox', { name: 'Default value' }));
    fireEvent.change(panel.row('Label').getByRole('textbox', { name: 'Default value' }), { target: { value: 'Ready' } });

    expect(panel.writes.map(write => write.edit)).toEqual([{ kind: 'value', index: 0 }, { kind: 'value', index: 1 }, { kind: 'value', index: 2 }]);
    expect(panel.latest()).toEqual([
      { id: 'v-score', name: 'Score', type: 'Float', value: -3.5 },
      { id: 'v-door', name: 'DoorOpen', type: 'Boolean', value: true },
      { id: 'v-label', name: 'Label', type: 'String', value: 'Ready' },
    ]);
  });

  it('deletes a variable', () => {
    const panel = renderPanel([score, doorOpen]);

    fireEvent.click(panel.row('Score').getByRole('button', { name: 'Delete variable' }));

    expect(panel.writes).toEqual([{ variables: [doorOpen], edit: { kind: 'remove', index: 0 } }]);
    expect(screen.queryByRole('listitem', { name: 'Score' })).not.toBeInTheDocument();
  });

  it('writes declarations that play start seeds with the values shown', () => {
    const legacy: LevelVariableEntry = { name: 'Lives', type: 'Integer', value: 3 };
    const panel = renderPanel([legacy, doorOpen]);
    expect(panel.row('Lives').getByRole('combobox', { name: 'Type' })).toHaveValue('Float');

    fireEvent.change(panel.row('Lives').getByRole('combobox', { name: 'Type' }), { target: { value: 'String' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add variable' }));
    expect(panel.latest()[0]).toEqual({ id: expect.any(String), name: 'Lives', type: 'String', value: '3' });

    const store = createLevelVariablesStore(() => undefined);
    store.reset(panel.latest());
    expect(store.all()).toEqual({ Lives: '3', DoorOpen: false, NewVar: 0 });
  });

  it('offers Get and Set nodes for a variable', () => {
    const onAddNode = vi.fn();
    const panel = renderPanel([score], onAddNode);

    fireEvent.click(panel.row('Score').getByRole('button', { name: 'Get' }));
    fireEvent.click(panel.row('Score').getByRole('button', { name: 'Set' }));

    expect(onAddNode.mock.calls).toEqual([['GetLevelVariable', 'Score'], ['SetLevelVariable', 'Score']]);
  });
});

describe('level variable rename references', () => {
  const variableNode = (id: string, type: LogicNode['type'], name: string, variable: string): LogicNode => ({
    id, type, name, position: { x: 0, y: 0 }, inputs: [], outputs: [], data: { default_Name: variable },
  });

  it('points Get/Set nodes at the new name and retitles nodes named after the variable', () => {
    const nodes = [
      variableNode('get', 'GetLevelVariable', 'Get Level Variable (Score)', 'Score'),
      variableNode('set', 'SetLevelVariable', 'Award points', ' Score'),
      variableNode('other', 'GetLevelVariable', 'Get Level Variable (Lives)', 'Lives'),
      variableNode('print', 'PrintString', 'Print String', 'Score'),
    ];

    const renamed = renameLevelVariableReferences(nodes, 'Score', 'Points');

    expect(renamed[0]).toMatchObject({ name: 'Get Level Variable (Points)', data: { default_Name: 'Points' } });
    expect(renamed[1]).toMatchObject({ name: 'Award points', data: { default_Name: 'Points' } });
    expect(renamed[2]).toBe(nodes[2]);
    expect(renamed[3]).toBe(nodes[3]);
    expect(renameLevelVariableReferences(nodes, 'Missing', 'Other')).toBe(nodes);
  });
});
