import { describe, expect, it } from 'vitest';
import {
  OUTPUT_NODE_TYPE,
  REROUTE_NODE_TYPE,
  compileMaterialGraph,
  defaultParams,
  normalizeMaterialGraph,
  type MaterialGraph,
} from '../../runtime/materials/materialGraph';
import {
  GraphHistory,
  addNode,
  commentNodes,
  connect,
  copyNodes,
  createComment,
  insertReroute,
  matchingPort,
  moveNodes,
  nodeRect,
  nodesInRect,
  pasteNodes,
  readClipboard,
  removeNodes,
  searchNodes,
} from '../../components/Materials/materialGraphEditing';
import { getMaterialNodeDefinition } from '../../runtime/materials/materialGraph';

const node = (id: string, type: string, x = 0, y = 0) => ({ id, type, x, y, params: defaultParams(type) });
const link = (fromNode: string, fromOutput: string, toNode: string, toInput: string) => ({ fromNode, fromOutput, toNode, toInput });

/** Noise into a ramp into the base colour. */
const chain = (): MaterialGraph => normalizeMaterialGraph({
  nodes: [node('out', OUTPUT_NODE_TYPE, 600, 0), node('noise', 'fractalNoise', 0, 0), node('ramp', 'colorRamp', 300, 0)],
  links: [link('noise', 'out', 'ramp', 'fac'), link('ramp', 'out', 'out', 'baseColor')],
});

describe('material graph editing', () => {
  it('copies nodes with the wires among them, and pastes them under new ids at a point', () => {
    const graph = chain();
    const clipboard = copyNodes(graph, ['noise', 'ramp', 'out'])!;
    // The Material Output is never copied, nor the wire into it.
    expect(clipboard.nodes.map(n => n.id)).toEqual(['noise', 'ramp']);
    expect(clipboard.links).toEqual([link('noise', 'out', 'ramp', 'fac')]);
    const text = JSON.stringify(clipboard);
    const read = readClipboard(text)!;
    const pasted = pasteNodes(graph, read, { x: 1000, y: 500 });
    expect(pasted.graph.nodes).toHaveLength(5);
    const [a, b] = pasted.nodeIds.map(id => pasted.graph.nodes.find(n => n.id === id)!);
    expect([a.x, a.y, b.x, b.y]).toEqual([1000, 500, 1300, 500]);
    expect(pasted.graph.links).toContainEqual(link(a.id, 'out', b.id, 'fac'));
    expect(pasted.nodeIds).not.toContain('noise');
    expect(readClipboard('{"kind":"something else"}')).toBeNull();
    expect(readClipboard('not json')).toBeNull();
  });

  it('removes nodes and their wires but keeps the Material Output', () => {
    const graph = removeNodes(chain(), ['ramp', 'out']);
    expect(graph.nodes.map(n => n.id)).toEqual(['out', 'noise']);
    expect(graph.links).toEqual([]);
  });

  it('moves a set of nodes from where a drag began', () => {
    const graph = chain();
    const moved = moveNodes(graph, graph, new Set(['noise', 'ramp']), { x: 10.4, y: -20 });
    expect(moved.nodes.map(n => [n.id, n.x, n.y])).toEqual([['out', 600, 0], ['noise', 10, -20], ['ramp', 310, -20]]);
  });

  it('replaces what fed an input, and refuses a wire that closes a loop', () => {
    const graph = chain();
    expect(connect(graph, link('ramp', 'out', 'noise', 'position'))).toBeNull();
    const rewired = connect(graph, link('noise', 'out', 'out', 'baseColor'))!;
    expect(rewired.links.filter(l => l.toInput === 'baseColor')).toEqual([link('noise', 'out', 'out', 'baseColor')]);
  });

  it('wires a node made from a dragged wire to its matching port', () => {
    const multiply = getMaterialNodeDefinition('multiply')!;
    expect(matchingPort(multiply, { from: 'out', nodeId: 'x', key: 'out', type: 'vec3' })).toBe('a');
    const ramp = getMaterialNodeDefinition('colorRamp')!;
    expect(matchingPort(ramp, { from: 'in', nodeId: 'out', key: 'baseColor', type: 'vec3' })).toBe('out');
    const graph = chain();
    const fromOutput = addNode(graph, 'multiply', { x: 0, y: 300 }, { from: 'out', nodeId: 'noise', key: 'out', type: 'float' });
    expect(fromOutput.graph.links).toContainEqual(link('noise', 'out', fromOutput.node.id, 'a'));
    const intoInput = addNode(graph, 'checker', { x: 0, y: 300 }, { from: 'in', nodeId: 'out', key: 'opacity', type: 'float' });
    expect(intoInput.graph.links).toContainEqual(link(intoInput.node.id, 'out', 'out', 'opacity'));
  });

  it('bends a wire through a reroute without changing what the shader computes', () => {
    const graph = chain();
    const before = compileMaterialGraph(graph).outputs.baseColor;
    const wire = graph.links.find(l => l.toInput === 'baseColor')!;
    const rerouted = insertReroute(graph, wire, { x: 450, y: 40 });
    const reroute = rerouted.nodes.find(n => n.type === REROUTE_NODE_TYPE)!;
    expect(rerouted.links).toContainEqual(link('ramp', 'out', reroute.id, 'in'));
    expect(rerouted.links).toContainEqual(link(reroute.id, 'out', 'out', 'baseColor'));
    const compiled = compileMaterialGraph(rerouted);
    // A colour passes through as a colour.
    expect(compiled.statements.join('\n')).toMatch(/vec3 mg_\w+_out_out_\d+ = mg_ramp_out_out_\d+;/);
    expect(compiled.outputs.baseColor).not.toBe(before);
  });

  it('selects the nodes a box touches, and comments wrap them and move with them', () => {
    const graph = chain();
    expect(nodesInRect(graph, { x: -10, y: -10, width: 320, height: 40 }, true).sort()).toEqual(['noise', 'ramp']);
    const comment = createComment(['noise', 'ramp'].map(id => nodeRect(graph.nodes.find(n => n.id === id)!, true)), { x: 0, y: 0 });
    expect(commentNodes(graph, comment, true).sort()).toEqual(['noise', 'ramp']);
    // Kept through the graph's own checks, and only when there are some.
    const stored = normalizeMaterialGraph({ ...graph, comments: [comment, { id: 'bad', x: 'no' }] });
    expect(stored.comments).toEqual([comment]);
    expect('comments' in normalizeMaterialGraph({ ...graph, comments: [] })).toBe(false);
  });

  it('finds nodes by name first, then by keyword, and lists them by category with no query', () => {
    expect(searchNodes('noise')[0].type).toBe('noise');
    expect(searchNodes('bump').map(d => d.type)).toContain('normalFromHeight');
    expect(searchNodes('lerp')[0].type).toBe('lerp');
    expect(searchNodes('zzzz')).toEqual([]);
    const all = searchNodes('');
    expect(all.some(d => d.type === OUTPUT_NODE_TYPE)).toBe(false);
    const categories = all.map(d => d.category);
    // Each category in one run.
    expect(categories.filter((c, i) => i === 0 || categories[i - 1] !== c)).toHaveLength(new Set(categories).size);
  });

  it('undoes and redoes, merging quick edits of one value into one step', () => {
    const history = new GraphHistory();
    const a = chain();
    const b = { ...a, nodes: [...a.nodes] };
    const c = { ...a, nodes: [...a.nodes] };
    const d = { ...a, nodes: [...a.nodes] };
    history.record(a, 'ramp:color', 0);
    history.record(b, 'ramp:color', 300);
    history.record(c, 'other', 400);
    expect(history.undo(d)).toBe(c);
    expect(history.undo(c)).toBe(a);
    expect(history.canUndo).toBe(false);
    expect(history.redo(a)).toBe(c);
    expect(history.redo(c)).toBe(d);
    expect(history.canRedo).toBe(false);
    // A new change after undoing drops what could be redone.
    history.undo(d);
    history.record(c, undefined, 5000);
    expect(history.canRedo).toBe(false);
  });
});

describe('node previews', () => {
  it('computes each node’s first output as a colour, normals encoded like a normal map', () => {
    const graph = normalizeMaterialGraph({
      nodes: [node('out', OUTPUT_NODE_TYPE), node('uv', 'uv'), node('k', 'float'), node('n', 'normalStrength')],
      links: [],
    });
    const compiled = compileMaterialGraph(graph, { previews: ['uv', 'k', 'n', 'missing'] });
    expect(compiled.previews[0]).toMatch(/^vec3\(mg_uv_out_out_\d+, 0\.0\)$/);
    expect(compiled.previews[1]).toMatch(/^vec3\(mg_k_out_out_\d+\)$/);
    expect(compiled.previews[2]).toMatch(/^\(mg_n_out_out_\d+ \* 0\.5 \+ 0\.5\)$/);
    expect(compiled.previews[3]).toBe('vec3(0.0)');
    // Previewed nodes still count as unused by the material.
    expect(compiled.unused.sort()).toEqual(['k', 'n', 'uv']);
  });
});
