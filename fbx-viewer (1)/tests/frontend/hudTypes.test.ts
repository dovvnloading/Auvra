import { describe, expect, it } from 'vitest';
import { clampHUDPosition, HUD_REFERENCE_SIZE, normalizeHUDLayout } from '../../components/HUDEditor/types';

describe('HUD logical layout helpers', () => {
  it('falls back to the reference stage for invalid layouts', () => {
    expect(normalizeHUDLayout({ width: 0, height: Number.NaN })).toEqual(HUD_REFERENCE_SIZE);
  });

  it('clamps an element so its full rectangle remains reachable', () => {
    expect(clampHUDPosition({ x: -40, y: 2000 }, { width: 400, height: 200 }, HUD_REFERENCE_SIZE))
      .toEqual({ x: 0, y: 880 });
  });
});
