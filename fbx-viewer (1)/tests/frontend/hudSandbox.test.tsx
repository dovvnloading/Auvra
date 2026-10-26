import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { compileHUDCode } from '../../components/HUDEditor/DynamicHUDComponent';
import { createExecutionGuard } from '../../components/HUDEditor/hudExecutionGuard';

const BUDGET_ERROR = 'HUD execution exceeded the sandbox budget';

// Mirrors hud-frame.tsx: the sandbox evaluates the compiled expression with React and one guard in scope.
const instantiate = (code: string) => {
  const getComponent = new Function('React', '__auvraHudGuard', `return (${compileHUDCode(code)});`);
  return getComponent(React, createExecutionGuard({ maxSteps: 100_000, maxMs: 50 })) as (props: Record<string, unknown>) => React.ReactElement;
};

const later = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

describe('HUD sandbox execution budget', () => {
  it('keeps the return value of concise arrow functions', () => {
    const Component = instantiate('const label = (n) => <b>{n}</b>; return <div>{[1, 2].map(n => label(n))}</div>;');

    const { container } = render(<Component />);

    expect(container.querySelectorAll('b')).toHaveLength(2);
    expect(container).toHaveTextContent('12');
  });

  it('runs a handler invoked well after the render slice', async () => {
    const Component = instantiate('const [count, setCount] = React.useState(0); return <button onClick={() => setCount(count + 1)}>{count}</button>;');
    render(<Component />);

    await later(80);
    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByRole('button')).toHaveTextContent('1');
  });

  it('still stops infinite loops, in render and in later handlers', async () => {
    expect(() => instantiate('while (true) {} return <div />;')({})).toThrow(BUDGET_ERROR);

    const element = instantiate('const spin = () => { while (true) {} }; return <button onClick={spin} />;')({});
    await later(80);
    expect(() => (element.props as { onClick: () => void }).onClick()).toThrow(BUDGET_ERROR);
  });

  it('budgets steps per slice rather than over the component lifetime', async () => {
    const guard = createExecutionGuard({ maxSteps: 10, maxMs: 50 });
    for (let i = 0; i < 8; i += 1) guard.tick();
    await later(5);
    for (let i = 0; i < 8; i += 1) guard.tick();

    expect(() => { for (let i = 0; i < 3; i += 1) guard.tick(); }).toThrow(BUDGET_ERROR);
  });

  it('stops a promise chain that never yields to the event loop', async () => {
    const guard = createExecutionGuard({ maxSteps: 1_000, maxMs: 50 });
    const spin = (): Promise<void> => Promise.resolve().then(() => { guard.tick(); return spin(); });

    await expect(spin()).rejects.toThrow(BUDGET_ERROR);
  });
});
