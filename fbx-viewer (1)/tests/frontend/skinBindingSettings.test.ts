import { BoxGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import type { RigJoint } from '../../utils/autoRig/bodySkeleton';
import { bindSkin, DEFAULT_SKIN_BINDING, type SkinBindingSettings } from '../../utils/autoRig/skinWeights';

// A segmented limb with three close joints in its middle exercises the influence cap.
const geometry = new BoxGeometry(4, 0.32, 0.32, 80, 2, 2).toNonIndexed();
const positions = Float32Array.from(geometry.attributes.position.array);
const joints: RigJoint[] = [-1.9, -0.12, 0, 0.12, 1.9].map((x, index) => ({
  name: `joint${index}`,
  parent: index - 1,
  position: [x, 0, 0],
  rotation: [0, 0, 0, 1],
  skins: index < 4,
}));
const bind = (settings?: SkinBindingSettings) => bindSkin(positions, joints, [{ positions }], undefined, settings)[0];

describe('geodesic skin binding settings', () => {
  it('retains the existing four-influence balanced bind when no settings are supplied', () => {
    const previous = bind();
    const explicit = bind(DEFAULT_SKIN_BINDING);
    expect(explicit.weights).toEqual(previous.weights);
    expect(explicit.joints).toEqual(previous.joints);
  });

  it.each([1, 2, 4] as const)('caps each vertex at %i influences and normalizes the retained weights', (maxInfluences) => {
    const result = bind({ maxInfluences, falloff: 'soft' });
    let most = 0;
    let largestError = 0;
    let valid = true;
    for (let start = 0; start < result.weights.length; start += 4) {
      let nonzero = 0;
      let sum = 0;
      for (let slot = 0; slot < 4; slot += 1) {
        const weight = result.weights[start + slot];
        const joint = result.joints[start + slot];
        if (weight > 0) nonzero++;
        valid &&= Number.isFinite(weight) && weight >= 0 && joint < joints.length && (weight > 0 || joint === 0);
        sum += weight;
      }
      most = Math.max(most, nonzero);
      largestError = Math.max(largestError, Math.abs(sum - 1));
    }
    expect(valid).toBe(true);
    expect(largestError).toBeLessThan(1e-6);
    expect(most).toBe(maxInfluences);
  });

  it('concentrates weights more strongly with each increase in falloff', () => {
    const dominantShare = (falloff: SkinBindingSettings['falloff']): number => {
      const { weights } = bind({ maxInfluences: 4, falloff });
      let sum = 0;
      for (let index = 0; index < weights.length; index += 4) sum += weights[index];
      return sum / (weights.length / 4);
    };
    const balanced = dominantShare('balanced');
    expect(dominantShare('soft')).toBeLessThan(balanced);
    expect(dominantShare('firm')).toBeGreaterThan(balanced);
  });
});
