import { expect, it } from 'vitest';
import { NO_WEATHER, WorldClock } from '../../runtime/weather';
import { stepWind, windTime, windUniforms } from '../../runtime/wind';

it('keeps the wind phase in step with world time across slow and invalid frames', () => {
    const clock = new WorldClock();
    // A 24-minute day advances one world hour per real minute.
    clock.reset(0, 24, NO_WEATHER, null);
    const start = windTime();
    for (let frame = 0; frame < 300; frame++) {
        clock.step(0.2);
        stepWind(0.2, NO_WEATHER);
    }
    expect(clock.hours).toBeCloseTo(1, 8);
    expect(windTime() - start).toBeCloseTo(clock.hours * 60, 8);
    expect(windUniforms.uWindTime.value).toBe(windTime());

    const phase = windTime();
    for (const delta of [0, -1, NaN, Infinity]) {
        stepWind(delta, NO_WEATHER);
        expect(windTime()).toBe(phase);
        expect(windUniforms.uWindTime.value).toBe(phase);
    }
});
