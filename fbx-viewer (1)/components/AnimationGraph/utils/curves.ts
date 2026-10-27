import type { AnimCurve, AnimCurveKey, VariableType } from '../../../types';

/**
 * A curve's value at `time` (seconds into the state's clip): straight lines between keys, held at
 * the first key's value before it and the last key's after it. Keys need not be sorted. 0 with no
 * keys.
 */
export const sampleCurve = (keys: readonly AnimCurveKey[], time: number): number => {
    if (!keys.length) return 0;
    const sorted = keys.length > 1 && keys.some((key, index) => index > 0 && key.time < keys[index - 1].time)
        ? [...keys].sort((a, b) => a.time - b.time)
        : keys;
    if (time <= sorted[0].time) return sorted[0].value;
    for (let index = 1; index < sorted.length; index++) {
        const next = sorted[index];
        if (time <= next.time) {
            const previous = sorted[index - 1];
            const span = next.time - previous.time;
            return span > 0 ? previous.value + ((time - previous.time) / span) * (next.value - previous.value) : next.value;
        }
    }
    return sorted[sorted.length - 1].value;
};

/** What a curve writes into its variable at `time`: the value, or for a Boolean whether it is above 0.5. */
export const curveVariableValue = (curve: AnimCurve, time: number, type: VariableType | undefined): number | boolean => {
    const value = sampleCurve(curve.keys, time);
    return type === 'Boolean' ? value > 0.5 : value;
};
