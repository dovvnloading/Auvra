import { ComponentProps } from 'react';
import { render } from '@testing-library/react';
import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvironmentScene } from '../../components/Environment/EnvironmentScene';
import { LevelObjectRenderer } from '../../components/Environment/LevelObjectRenderer';
import type { InteractionMode } from '../../components/Environment/types';
import type { LevelObject, LoadedModelData } from '../../types';

const terrain = vi.hoisted(() => ({ onClick: null as ((event: { stopPropagation: () => void }) => void) | null }));

vi.mock('@react-three/fiber', () => ({
  useThree: () => ({ camera: {}, controls: null, raycaster: {}, pointer: {} }),
}));
vi.mock('@react-three/drei', () => ({
  Billboard: () => null,
  Grid: () => null,
  Html: () => null,
  TransformControls: () => null,
}));
vi.mock('../../context/AssetContext', () => ({ useAssets: () => ({ audioAssets: [] }) }));
vi.mock('../../context/LevelContext', () => ({ useLevel: () => ({ levels: [], currentLevelId: null }) }));
vi.mock('../../components/Environment/Terrain/TerrainObject', () => ({
  TerrainObject: (props: { onClick: (event: { stopPropagation: () => void }) => void }) => {
    terrain.onClick = props.onClick;
    return null;
  },
}));
vi.mock('../../components/Environment/Terrain/TerrainSculptor', () => ({ TerrainSculptor: () => null }));
vi.mock('../../components/Environment/InstancedLevelLayer', () => ({ InstancedLevelLayer: () => null }));
vi.mock('../../components/Environment/AudioSystem', () => ({ AudioSystem: () => null }));
vi.mock('../../components/Environment/SkySystem', () => ({ SkySystem: () => null }));
vi.mock('../../runtime/lighting/LevelLightVolume', () => ({ LevelLightVolume: () => null, LightBakeRunner: () => null }));
vi.mock('../../components/Environment/FoliageBrushTool', () => ({ FoliageBrushTool: () => null }));

const levelObject = (id: string, type: LevelObject['type']): LevelObject => ({
  id, levelId: 'level-1', modelId: 'model-1', name: id, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], type,
});

const noop = () => undefined;

const sceneProps = (interactionMode: InteractionMode, viewId: string, onSelectObject: (id: string | null) => void): ComponentProps<typeof EnvironmentScene> => ({
  activeModel: null,
  interactionMode,
  paintMode: 'add',
  onPlace: noop,
  onPaint: noop,
  onErase: noop,
  onSelectObject,
  models: [],
  levelObjects: [levelObject('terrain-1', 'terrain')],
  updateLevelObject: noop,
  transformSettings: { tool: 'translate', space: 'world', snapEnabled: false, snapGrid: 1, snapAngle: 15 },
  onSnapshot: noop,
  selectedId: null,
  viewId,
  activeViewId: 'main',
  isMuted: true,
  enableAudio: false,
});

const clickTerrain = (interactionMode: InteractionMode, viewId: string) => {
  const onSelectObject = vi.fn();
  const stopPropagation = vi.fn();
  render(<EnvironmentScene {...sceneProps(interactionMode, viewId, onSelectObject)} />);
  terrain.onClick?.({ stopPropagation });
  return { onSelectObject, stopPropagation };
};

beforeEach(() => {
  // react-dom does not know three.js intrinsic elements such as <group>; that noise is not under test.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('environment terrain selection', () => {
  it('selects terrain from the active view in select and sculpt modes', () => {
    expect(clickTerrain('select', 'main').onSelectObject).toHaveBeenCalledWith('terrain-1');
    expect(clickTerrain('sculpt', 'main').onSelectObject).toHaveBeenCalledWith('terrain-1');
  });

  it('leaves terrain clicks in inactive views alone, including in sculpt mode', () => {
    for (const mode of ['select', 'sculpt'] as const) {
      const { onSelectObject, stopPropagation } = clickTerrain(mode, 'left');
      expect(onSelectObject).not.toHaveBeenCalled();
      expect(stopPropagation).not.toHaveBeenCalled();
    }
  });
});

describe('level object renderer', () => {
  it('renders a prop whose model arrives after the first render', () => {
    const prop = levelObject('prop-1', 'prop');
    const { container, rerender } = render(<LevelObjectRenderer data={prop} />);
    expect(container).toBeEmptyDOMElement();

    const object = new THREE.Group();
    object.add(new THREE.Mesh());
    rerender(<LevelObjectRenderer data={prop} model={{ object } as unknown as LoadedModelData} />);

    expect(container.querySelector('primitive')).not.toBeNull();
  });

  it('drops the mesh when the model goes away again', () => {
    const prop = levelObject('prop-1', 'prop');
    const model = { object: new THREE.Group() } as unknown as LoadedModelData;
    const { container, rerender } = render(<LevelObjectRenderer data={prop} model={model} />);
    expect(container.querySelector('primitive')).not.toBeNull();

    rerender(<LevelObjectRenderer data={prop} />);

    expect(container).toBeEmptyDOMElement();
  });
});
