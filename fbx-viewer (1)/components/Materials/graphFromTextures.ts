import { createMaterialGraph, defaultParams, type MaterialGraph } from '../../runtime/materials/materialGraph';
import { OUTPUT_NODE_TYPE } from '../../runtime/materials/materialNodes';

/** The textures a material was painted with, by what each one is. */
export interface PaintedTextures {
  color: string;
  normal?: string;
  roughness?: string;
  metalness?: string;
}

/** A node graph that draws with a painted set of textures: each wired to the input it is for. */
export const graphFromTextures = (textures: PaintedTextures): MaterialGraph => {
  const graph = createMaterialGraph();
  const output = graph.nodes.find((node) => node.type === OUTPUT_NODE_TYPE)!;
  const add = (id: string, type: string, y: number, params: Record<string, unknown>) => {
    graph.nodes.push({ id, type, x: output.x - 320, y, params: { ...defaultParams(type), ...params } });
  };
  add('color', 'texture', -120, { texture: textures.color, space: 'color' });
  graph.links.push({ fromNode: 'color', fromOutput: 'rgb', toNode: output.id, toInput: 'baseColor' });
  if (textures.metalness) {
    add('metalness', 'texture', 220, { texture: textures.metalness, space: 'data' });
    graph.links.push({ fromNode: 'metalness', fromOutput: 'r', toNode: output.id, toInput: 'metalness' });
  }
  if (textures.roughness) {
    add('roughness', 'texture', 560, { texture: textures.roughness, space: 'data' });
    graph.links.push({ fromNode: 'roughness', fromOutput: 'r', toNode: output.id, toInput: 'roughness' });
  }
  if (textures.normal) {
    add('normal', 'normalMap', 900, { texture: textures.normal });
    graph.links.push({ fromNode: 'normal', fromOutput: 'out', toNode: output.id, toInput: 'normal' });
  }
  return graph;
};
