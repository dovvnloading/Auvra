import { describe, expect, it } from 'vitest';
import {
  FLOW_NODE_DEFINITIONS,
  FLOW_NODE_EXECUTORS,
  FlowNode,
  FlowNodeType,
  MAX_FOR_LOOP_ITERATIONS,
  flowNodeOutputValue,
  isFlowNodeType,
  sequenceThenPin,
} from '../../hooks/levelBlueprintNodes/flow';

type Fired = { pin: string; data?: Record<string, unknown> };

/** Places a palette node and runs it the way the runtime would, recording what it fires. */
const harness = (type: FlowNodeType, inputs: Record<string, unknown> = {}, extraOutputs = 0) => {
  const definition = FLOW_NODE_DEFINITIONS.find(d => d.type === type)!;
  const outputs = [...definition.outputs];
  for (let i = 0; i < extraOutputs; i++) outputs.push(sequenceThenPin(outputs.length));
  const node: FlowNode = {
    id: `${type}-1`,
    type,
    inputs: definition.inputs.map((pin, i) => ({ ...pin, id: `in-${i}` })),
    outputs: outputs.map((pin, i) => ({ ...pin, id: `out-${i}` })),
    data: { ...definition.data },
  };
  const fired: Fired[] = [];
  const scheduled: { seconds: number; fn: () => void }[] = [];
  const nodeState: Record<string, unknown> = {};
  const values = { ...inputs };
  const run = (entryPin?: string) => FLOW_NODE_EXECUTORS[type]!(node, {
    evaluate: pinName => {
      expect(node.inputs.some(p => p.name === pinName && p.dataType !== 'Exec')).toBe(true);
      return pinName in values ? values[pinName] : node.data?.[`default_${pinName}`] ?? null;
    },
    fire: (pin, data) => {
      expect(node.outputs.some(p => p.name === pin && p.dataType === 'Exec')).toBe(true);
      fired.push(data === undefined ? { pin } : { pin, data });
    },
    schedule: (seconds, fn) => { scheduled.push({ seconds, fn }); },
    nodeState,
    entryPin,
  });
  const pins = () => fired.map(f => f.pin);
  return { node, run, fired, pins, scheduled, nodeState, values };
};

describe('level blueprint flow nodes', () => {
  it('defines a palette entry for every executor with unique pin names', () => {
    expect(FLOW_NODE_DEFINITIONS.map(d => d.type).sort()).toEqual(Object.keys(FLOW_NODE_EXECUTORS).sort());
    for (const definition of FLOW_NODE_DEFINITIONS) {
      const names = [...definition.inputs, ...definition.outputs].map(p => p.name);
      expect(new Set(names).size).toBe(names.length);
      expect(definition.inputs.every(p => p.direction === 'Input')).toBe(true);
      expect(definition.outputs.every(p => p.direction === 'Output')).toBe(true);
    }
    expect(isFlowNodeType('Gate')).toBe(true);
    expect(isFlowNodeType('Branch')).toBe(false);
    expect(FLOW_NODE_EXECUTORS.Branch).toBeUndefined();
  });

  it('Sequence fires every Then pin in order, including added ones', () => {
    const two = harness('Sequence');
    two.run();
    expect(two.pins()).toEqual(['Then 0', 'Then 1']);

    const four = harness('Sequence', {}, 2);
    four.run();
    expect(four.pins()).toEqual(['Then 0', 'Then 1', 'Then 2', 'Then 3']);
  });

  it('ForLoop runs the body for each index inclusive, then completes', () => {
    const loop = harness('ForLoop', { 'First Index': 2, 'Last Index': 4 });
    loop.run();
    expect(loop.fired).toEqual([
      { pin: 'Loop Body', data: { Index: 2 } },
      { pin: 'Loop Body', data: { Index: 3 } },
      { pin: 'Loop Body', data: { Index: 4 } },
      { pin: 'Completed' },
    ]);
    expect(flowNodeOutputValue(loop.nodeState, 'Index')).toBe(4);
  });

  it('ForLoop uses pin defaults, truncates input and only completes on an empty range', () => {
    const defaults = harness('ForLoop');
    defaults.run();
    expect(defaults.fired).toEqual([{ pin: 'Loop Body', data: { Index: 0 } }, { pin: 'Completed' }]);

    const truncated = harness('ForLoop', { 'First Index': '1.9', 'Last Index': 'oops' });
    truncated.run();
    expect(truncated.pins()).toEqual(['Completed']);

    const reversed = harness('ForLoop', { 'First Index': 5, 'Last Index': 1 });
    reversed.run();
    expect(reversed.pins()).toEqual(['Completed']);
  });

  it('ForLoop stops at the iteration cap', () => {
    const huge = harness('ForLoop', { 'First Index': 0, 'Last Index': 1e9 });
    huge.run();
    expect(huge.pins().filter(p => p === 'Loop Body')).toHaveLength(MAX_FOR_LOOP_ITERATIONS);
    expect(huge.pins()[huge.pins().length - 1]).toBe('Completed');

    const unsafe = harness('ForLoop', { 'First Index': 1e20, 'Last Index': 1e20 + 5 });
    unsafe.run();
    expect(unsafe.pins().length).toBeLessThanOrEqual(MAX_FOR_LOOP_ITERATIONS + 1);
  });

  it('Delay schedules Out after the duration and ignores re-entry while pending', () => {
    const delay = harness('Delay', { Duration: 2.5 });
    delay.run();
    delay.run();
    expect(delay.fired).toEqual([]);
    expect(delay.scheduled.map(s => s.seconds)).toEqual([2.5]);

    delay.scheduled[0].fn();
    expect(delay.pins()).toEqual(['Out']);

    delay.run();
    expect(delay.scheduled).toHaveLength(2);
  });

  it('Delay defaults to one second and clamps bad durations to zero', () => {
    const defaults = harness('Delay');
    defaults.run();
    expect(defaults.scheduled[0].seconds).toBe(1);

    const negative = harness('Delay', { Duration: -3 });
    negative.run();
    expect(negative.scheduled[0].seconds).toBe(0);

    const junk = harness('Delay', { Duration: 'soon' });
    junk.run();
    expect(junk.scheduled[0].seconds).toBe(0);
  });

  it('DoOnce fires once until reset', () => {
    const once = harness('DoOnce');
    once.run();
    once.run('Exec');
    expect(once.pins()).toEqual(['Completed']);

    once.run('Reset');
    expect(once.pins()).toEqual(['Completed']);
    once.run();
    once.run();
    expect(once.pins()).toEqual(['Completed', 'Completed']);
  });

  it('DoOnce with Start Closed waits for a reset', () => {
    const closed = harness('DoOnce', { 'Start Closed': true });
    closed.run();
    expect(closed.fired).toEqual([]);
    closed.run('Reset');
    closed.run();
    expect(closed.pins()).toEqual(['Completed']);
  });

  it('FlipFlop alternates A and B, starting with A', () => {
    const flip = harness('FlipFlop');
    flip.run();
    flip.run();
    flip.run();
    expect(flip.fired).toEqual([
      { pin: 'A', data: { 'Is A': true } },
      { pin: 'B', data: { 'Is A': false } },
      { pin: 'A', data: { 'Is A': true } },
    ]);
    expect(flowNodeOutputValue(flip.nodeState, 'Is A')).toBe(true);
    expect(flowNodeOutputValue(undefined, 'Is A')).toBeNull();
  });

  it('Gate passes Enter only while open and responds to Open, Close and Toggle', () => {
    const gate = harness('Gate');
    gate.run('Enter');
    expect(gate.pins()).toEqual(['Exit']);

    gate.run('Close');
    gate.run('Enter');
    expect(gate.pins()).toEqual(['Exit']);

    gate.run('Toggle');
    gate.run();
    expect(gate.pins()).toEqual(['Exit', 'Exit']);

    gate.run('Toggle');
    gate.run('Enter');
    gate.run('Open');
    gate.run('Enter');
    expect(gate.pins()).toEqual(['Exit', 'Exit', 'Exit']);
  });

  it('Gate with Start Closed blocks until opened', () => {
    const gate = harness('Gate', { 'Start Closed': true });
    gate.run('Enter');
    expect(gate.fired).toEqual([]);
    gate.values['Start Closed'] = false;
    gate.run('Enter');
    expect(gate.fired).toEqual([]);
    gate.run('Open');
    gate.run('Enter');
    expect(gate.pins()).toEqual(['Exit']);
  });
});
