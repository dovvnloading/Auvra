import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LevelBlueprintInspector } from '../../components/LevelBlueprint/LevelBlueprintInspector';
import { WORLD_NODE_DEFINITIONS } from '../../hooks/levelBlueprintNodes/world';
import type { LogicNode } from '../../types';

/** A Set Level Variable node as the palette places it, writing `name`. */
const setVariableNode = (name: string, value: unknown = ''): LogicNode => {
  const definition = WORLD_NODE_DEFINITIONS.find(item => item.type === 'SetLevelVariable')!;
  return {
    id: 'set-1',
    type: definition.type,
    name: definition.title,
    position: { x: 0, y: 0 },
    inputs: definition.inputs.map(pin => ({ ...pin, id: `set-1:in:${pin.name}` })),
    outputs: definition.outputs.map(pin => ({ ...pin, id: `set-1:out:${pin.name}` })),
    data: { ...definition.data, default_Name: name, default_Value: value },
  };
};

const renderValueField = (node: LogicNode, levelVariables: { name: string, type: string }[] = []) => {
  const onUpdate = vi.fn();
  render(<LevelBlueprintInspector node={node} onUpdate={onUpdate} levelObjects={[]} globalVariables={[]} levelVariables={levelVariables} onDelete={() => undefined} />);
  const storedValue = () => onUpdate.mock.calls.at(-1)?.[0].data.default_Value;
  return { field: screen.getByLabelText('Value'), storedValue };
};

describe('Set Level Variable value field', () => {
  it('types an undeclared variable by the literal, so false is a real Boolean', () => {
    const { field, storedValue } = renderValueField(setVariableNode('DoorOpen'));
    const typed = (text: string) => {
      fireEvent.change(field, { target: { value: text } });
      return storedValue();
    };
    expect(typed('false')).toBe(false);
    expect(typed(' true ')).toBe(true);
    expect(typed('12')).toBe(12);
    expect(typed('-0.5')).toBe(-0.5);
    // Partial numbers stay text while typing, so '1.' can become '1.5'.
    expect(typed('1.')).toBe('1.');
    expect(typed('-')).toBe('-');
    expect(typed('open')).toBe('open');
  });

  it('shows a stored Boolean in the text field and says which type it creates', () => {
    renderValueField(setVariableNode('DoorOpen', false));
    expect(screen.getByLabelText('Value')).toHaveValue('false');
    expect(screen.getByText('Creates a Boolean variable.')).toBeInTheDocument();
  });

  it('offers True/False for a declared Boolean and stores a real boolean', () => {
    const { field, storedValue } = renderValueField(setVariableNode('DoorOpen', 'true'), [{ name: 'DoorOpen', type: 'Boolean' }]);
    expect(field.tagName).toBe('SELECT');
    expect(field).toHaveValue('true');
    fireEvent.change(field, { target: { value: 'false' } });
    expect(storedValue()).toBe(false);
  });

  it('uses a number field for a declared Float and keeps a declared String as typed', () => {
    const float = renderValueField(setVariableNode('Score'), [{ name: 'Score', type: 'Float' }]);
    expect(float.field).toHaveAttribute('type', 'number');
    fireEvent.change(float.field, { target: { value: '2.5' } });
    expect(float.storedValue()).toBe(2.5);
  });

  it('keeps a declared String value as text', () => {
    const text = renderValueField(setVariableNode('Label'), [{ name: 'Label', type: 'String' }]);
    fireEvent.change(text.field, { target: { value: 'true' } });
    expect(text.storedValue()).toBe('true');
  });
});
