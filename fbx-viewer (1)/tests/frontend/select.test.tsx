import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Select } from '../../components/UI/Select';

describe('Select', () => {
  it('exposes listbox semantics and selects with keyboard navigation', () => {
    const onChange = vi.fn();
    render(<Select value="one" onChange={onChange} options={[{ label: 'One', value: 'one' }, { label: 'Two', value: 'two' }]} placeholder="Choose" />);

    const trigger = screen.getByRole('combobox', { name: 'Choose' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const options = screen.getAllByRole('option');
    expect(trigger).toHaveAttribute('aria-activedescendant', options[1].id);

    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('two');
  });
});
