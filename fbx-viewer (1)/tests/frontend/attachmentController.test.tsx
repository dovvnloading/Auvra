import { render } from '@testing-library/react';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { AttachmentController } from '../../components/Scene/AttachmentController';
import type { AttachmentData } from '../../types';

const makeAttachment = (): AttachmentData => {
  const object = new THREE.Group();
  object.name = 'sword';
  object.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
  return {
    id: 'att-1',
    name: 'Sword',
    url: 'sword.glb',
    object,
    parentModelId: 'model-1',
    boneName: 'hand_r',
    position: [1, 2, 3],
    rotation: [0, 90, 0],
    scale: [2, 2, 2],
  };
};

const makeEntity = () => {
  const root = new THREE.Group();
  const bone = new THREE.Bone();
  bone.name = 'hand_r';
  root.add(bone);
  return { root, bone };
};

describe('AttachmentController', () => {
  it('reparents the shared object by default', () => {
    const data = makeAttachment();
    const entity = makeEntity();
    const view = render(<AttachmentController data={data} parentObject={entity.root} />);

    expect(data.object.parent).toBe(entity.bone);
    expect(data.object.position.toArray()).toEqual([1, 2, 3]);

    view.unmount();
    expect(data.object.parent).toBeNull();
  });

  it('gives each instance its own clone and removes only that clone', () => {
    const data = makeAttachment();
    const first = makeEntity();
    const second = makeEntity();
    const firstView = render(<AttachmentController data={data} parentObject={first.root} cloneForInstance />);
    const secondView = render(<AttachmentController data={data} parentObject={second.root} cloneForInstance />);

    expect(data.object.parent).toBeNull();
    expect(first.bone.children).toHaveLength(1);
    expect(second.bone.children).toHaveLength(1);
    const firstClone = first.bone.children[0];
    const secondClone = second.bone.children[0];
    expect(firstClone).not.toBe(data.object);
    expect(firstClone).not.toBe(secondClone);
    expect(firstClone.position.toArray()).toEqual([1, 2, 3]);
    expect(secondClone.scale.toArray()).toEqual([2, 2, 2]);

    firstView.unmount();
    expect(first.bone.children).toHaveLength(0);
    expect(second.bone.children).toEqual([secondClone]);

    secondView.unmount();
    expect(second.bone.children).toHaveLength(0);
    expect(data.object.children).toHaveLength(1);
  });
});
