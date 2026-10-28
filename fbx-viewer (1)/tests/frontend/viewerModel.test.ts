import { describe, expect, it } from 'vitest';
import { viewerModel } from '../../utils/viewerModel';

const models = [
  { id: 'remy', isPlacedInScene: true },
  { id: 'raider', isPlacedInScene: true },
  { id: 'crate', isPlacedInScene: false },
];

describe('the Scene viewer', () => {
  it('shows the selected model when it is in the viewer, else the first one put there', () => {
    expect(viewerModel(models, 'raider')?.id).toBe('raider');
    expect(viewerModel(models, 'crate')?.id).toBe('remy');
    expect(viewerModel(models, null)?.id).toBe('remy');
  });

  it('shows nothing when no model is in the viewer', () => {
    expect(viewerModel(models.map(model => ({ ...model, isPlacedInScene: false })), 'remy')).toBeNull();
  });
});
