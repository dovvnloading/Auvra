import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { readReachIKSettings, resolveReachChain } from '../../runtime/components/ikComponents';
import { solveTwoBoneIK } from '../../runtime/ik';
import type { LevelComponent } from '../../types';

const component = (props: Record<string, unknown>): LevelComponent => ({ id: 'r', type: 'twoBoneIK', enabled: true, props });

describe('reach IK', () => {
  it('reads its settings with defaults', () => {
    const defaults = readReachIKSettings(component({}));
    expect([defaults.endBone, defaults.target, defaults.weight]).toEqual(['RightHand', '', 1]);
    expect(defaults.offset.toArray()).toEqual([0, 0, 0]);
    const set = readReachIKSettings(component({ endBone: 'LeftFoot', target: ' lever ', offset: [0, 0.5, 0], weight: 3 }));
    expect([set.endBone, set.target, set.weight, set.offset.y]).toEqual(['LeftFoot', 'lever', 1, 0.5]);
  });

  it('bends the bone and the two above it so the bone reaches the target', () => {
    const root = new THREE.Group();
    const bone = (name: string, parent: THREE.Object3D, y: number) => {
      const created = new THREE.Bone();
      created.name = name;
      created.position.set(0, y, 0);
      parent.add(created);
      return created;
    };
    const shoulder = bone('RightArm', root, 1.5);
    const elbow = bone('RightForeArm', shoulder, -0.3);
    elbow.rotation.x = 0.2; // a slight bend, so the solver knows which way the elbow folds
    const hand = bone('RightHand', elbow, -0.3);
    root.updateMatrixWorld(true);

    const chain = resolveReachChain(hand)!;
    expect(chain.map(node => node.name)).toEqual(['RightArm', 'RightForeArm', 'RightHand']);
    expect(resolveReachChain(elbow)).toBeNull();

    const target = new THREE.Vector3(0, 1.3, 0.35);
    solveTwoBoneIK(chain[0], chain[1], chain[2], target, null, 1);
    root.updateMatrixWorld(true);
    expect(hand.getWorldPosition(new THREE.Vector3()).distanceTo(target)).toBeLessThan(1e-3);
  });
});
