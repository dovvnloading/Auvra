import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ScrubbableInput } from '../../components/UI/Properties/ScrubbableInput';

describe('ScrubbableInput', () => {
  it('supports keyboard adjustment on the focused scrub surface', () => {
    const onChange = vi.fn();
    render(<ScrubbableInput label="X" value={10} step={1} onChange={onChange} />);

    fireEvent.keyDown(screen.getByRole('button', { name: 'Scrub X' }), { key: 'ArrowUp' });
    expect(onChange).toHaveBeenCalledWith(11);
  });

  it('cleans up the resize cursor when pointer capture is cancelled', () => {
    render(<ScrubbableInput label="X" value={10} step={1} onChange={() => undefined} />);
    const scrub = screen.getByRole('button', { name: 'Scrub X' });
    fireEvent.pointerDown(scrub, { pointerId: 1, clientX: 20 });
    expect(document.body.style.cursor).toBe('ew-resize');
    fireEvent.pointerCancel(scrub, { pointerId: 1 });
    expect(document.body.style.cursor).toBe('');
  });
});
