import { describe, expect, it } from 'vitest';
import { curveVariableValue, sampleCurve } from '../../components/AnimationGraph/utils/curves';

describe('animation curves', () => {
  it('runs straight between keys and holds the ends', () => {
    const keys = [{ time: 0.5, value: 1 }, { time: 0, value: 0 }, { time: 1, value: 0.5 }];
    expect(sampleCurve(keys, -1)).toBe(0);
    expect(sampleCurve(keys, 0.25)).toBeCloseTo(0.5, 6);
    expect(sampleCurve(keys, 0.75)).toBeCloseTo(0.75, 6);
    expect(sampleCurve(keys, 3)).toBe(0.5);
    expect(sampleCurve([], 0.3)).toBe(0);
  });

  it('turns a Boolean variable on above 0.5', () => {
    // A combo window: open between 0.4 s and 0.6 s of the attack.
    const window = { id: 'c', variableId: 'CanCombo', keys: [{ time: 0.39, value: 0 }, { time: 0.4, value: 1 }, { time: 0.6, value: 1 }, { time: 0.61, value: 0 }] };
    expect(curveVariableValue(window, 0.2, 'Boolean')).toBe(false);
    expect(curveVariableValue(window, 0.5, 'Boolean')).toBe(true);
    expect(curveVariableValue(window, 0.8, 'Boolean')).toBe(false);
    expect(curveVariableValue(window, 0.5, 'Float')).toBe(1);
  });
});
