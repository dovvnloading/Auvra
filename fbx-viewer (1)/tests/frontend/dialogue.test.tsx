import * as THREE from 'three';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addChoice, addLine, lineLabel, moveLine, removeChoice, removeLine, updateChoice, updateLine } from '../../components/Dialogue/dialogueEditing';
import { dialogueEventMatches, useLevelBlueprintRuntime, type UseLevelBlueprintRuntimeProps } from '../../hooks/useLevelBlueprintRuntime';
import { DIALOGUE_DEFAULTS, interactKeyLabel, nearestSpeaker, resolveDialogueSettings } from '../../runtime/components/dialogueComponent';
import {
  createDialogueStore, dialogueProblems, dialogueSpeakers, dialogueStore, normalizeDialogue,
  type DialogueData, type DialogueEvent, type DialogueSpeaker,
} from '../../runtime/dialogue';
import { DialogueOverlay, dialogueTextKey } from '../../runtime/DialogueOverlay';
import { DEFAULT_INPUT_MAP, InputState } from '../../runtime/input';
import { createScriptHost } from '../../runtime/scripting/scriptApi';
import { parseScriptCommand } from '../../runtime/scripting/ScriptRuntime';
import type { ScriptSnapshot } from '../../runtime/scripting/protocol';
import type { LevelBlueprintData, LogicNode, LogicPin } from '../../types';

vi.mock('@react-three/fiber', () => ({ useFrame: () => undefined }));

const innkeeper: DialogueData = {
  startId: 'hello',
  lines: [
    { id: 'hello', speaker: 'Innkeeper', text: 'Welcome. Need a room?', next: null, setVariable: 'metInnkeeper', event: 'greeted', choices: [
      { id: 'yes', text: 'Yes, please.', next: 'room', setVariable: 'rentedRoom', event: 'rented' },
      { id: 'quest', text: 'About the wolves...', next: 'wolves', requires: 'heardRumour' },
      { id: 'no', text: 'No thanks.', next: null },
    ] },
    { id: 'room', speaker: 'Innkeeper', text: 'Up the stairs.', next: 'bye' },
    { id: 'wolves', speaker: 'Innkeeper', text: 'Ask the hunter.', next: null },
    { id: 'bye', speaker: 'Innkeeper', text: 'Sleep well.', next: null },
  ],
};

const variableHooks = (initial: Record<string, boolean> = {}) => {
  const values: Record<string, unknown> = { ...initial };
  return {
    values,
    hooks: {
      readVariable: (name: string) => values[name] as boolean | undefined,
      setVariable: (name: string, value: unknown) => { values[name] = value; },
    },
  };
};

describe('dialogue data', () => {
  it('normalizes stored dialogue, dropping what it cannot use', () => {
    const data = normalizeDialogue({
      startId: 'missing',
      lines: [
        { id: 'a', speaker: 'Guard', text: 'Halt.', next: 'b', setVariable: '  seen  ', event: '' },
        { id: 'a', text: 'duplicate' },
        { text: 'no id' },
        'junk',
        { id: 'b', choices: [{ id: 'c1', text: 'Fine', next: '' }, { text: 'no id' }, { id: 'c1', text: 'again' }] },
      ],
    });
    expect(data).toEqual({
      startId: 'a',
      lines: [
        { id: 'a', speaker: 'Guard', text: 'Halt.', next: 'b', setVariable: 'seen' },
        { id: 'b', speaker: '', text: '', next: null, choices: [{ id: 'c1', text: 'Fine', next: null }] },
      ],
    });
    expect(normalizeDialogue(undefined)).toEqual({ startId: '', lines: [] });
    expect(normalizeDialogue(innkeeper)).toEqual(innkeeper);
  });

  it('reports links to missing lines and lines nothing reaches', () => {
    expect(dialogueProblems(innkeeper)).toEqual([]);
    const broken: DialogueData = {
      startId: 'a',
      lines: [
        { id: 'a', speaker: '', text: '', next: 'gone', choices: [{ id: 'c', text: '', next: 'nowhere' }] },
        { id: 'island', speaker: '', text: '', next: null },
      ],
    };
    expect(dialogueProblems(broken)).toEqual([
      'Line 1 continues to a line that no longer exists.',
      'Choice 1 on line 1 leads to a line that no longer exists.',
      'Line 2 is never reached from the start line.',
    ]);
  });
});

describe('dialogue store', () => {
  it('runs a conversation: effects on show, choices gated by variables, then the end', () => {
    const store = createDialogueStore();
    const { values, hooks } = variableHooks();
    store.setHooks(hooks);
    const events: DialogueEvent[] = [];
    store.onEvent(event => events.push(event));

    expect(store.start('inn', innkeeper)).toBe(true);
    expect(store.state().active?.line.id).toBe('hello');
    expect(store.state().active?.choices.map(choice => choice.id)).toEqual(['yes', 'no']);
    expect(values.metInnkeeper).toBe(true);
    expect(store.start('inn', innkeeper)).toBe(false);

    store.advance();
    expect(store.state().active?.line.id).toBe('room');
    expect(values.rentedRoom).toBe(true);
    expect(events).toEqual([{ objectId: 'inn', name: 'greeted' }, { objectId: 'inn', name: 'rented' }]);

    store.advance();
    expect(store.state().active?.line.id).toBe('bye');
    store.advance();
    expect(store.state().active).toBeNull();
  });

  it('offers a choice once its variable is on, and takes choices by id or selection', () => {
    const store = createDialogueStore();
    store.setHooks(variableHooks({ heardRumour: true }).hooks);
    store.start('inn', innkeeper);
    expect(store.state().active?.choices.map(choice => choice.id)).toEqual(['yes', 'quest', 'no']);

    store.select(-1);
    expect(store.state().selected).toBe(2);
    store.select(4);
    expect(store.state().selected).toBe(1);
    store.advance();
    expect(store.state().active?.line.id).toBe('wolves');

    store.close();
    store.start('inn', innkeeper);
    store.advance('missing');
    expect(store.state().active?.line.id).toBe('hello');
    store.advance('no');
    expect(store.state().active).toBeNull();
  });

  it('continues past a line whose choices are all unavailable', () => {
    const store = createDialogueStore();
    store.start('npc', {
      startId: 'a',
      lines: [
        { id: 'a', speaker: '', text: '', next: 'b', choices: [{ id: 'c', text: '', next: null, requires: 'never' }] },
        { id: 'b', speaker: '', text: '', next: null },
      ],
    });
    expect(store.state().active?.choices).toEqual([]);
    store.advance();
    expect(store.state().active?.line.id).toBe('b');
  });

  it('lets an event listener close the conversation or open another', () => {
    const store = createDialogueStore();
    store.onEvent(event => { if (event.name === 'rented') store.close(); });
    store.start('inn', innkeeper);
    store.advance('yes');
    expect(store.state().active).toBeNull();

    const other: DialogueData = { startId: 'x', lines: [{ id: 'x', speaker: 'Hunter', text: 'Yes?', next: null }] };
    const handover = createDialogueStore();
    handover.onEvent(event => {
      if (event.name !== 'greeted') return;
      handover.close();
      handover.start('hunter', other);
    });
    handover.start('inn', innkeeper);
    expect(handover.state().active?.objectId).toBe('hunter');
  });

  it('keeps one prompt until it changes, and reset clears everything', () => {
    const store = createDialogueStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setPrompt({ objectId: 'inn', text: 'Talk', key: 'F' });
    store.setPrompt({ objectId: 'inn', text: 'Talk', key: 'F' });
    expect(listener).toHaveBeenCalledTimes(1);
    store.start('inn', innkeeper);
    store.reset();
    expect(store.state()).toEqual({ active: null, selected: 0, prompt: null });
    expect(store.start('inn', { startId: '', lines: [] })).toBe(false);
  });
});

describe('dialogue editing', () => {
  it('adds, moves and removes lines, unlinking what pointed at a removed one', () => {
    let data: DialogueData = { startId: '', lines: [] };
    const first = addLine(data);
    data = updateLine(first.data, first.id, { speaker: 'Guard', text: 'Halt.' });
    const second = addLine(data);
    expect(second.data.lines[1]).toEqual({ id: 'line2', speaker: 'Guard', text: '', next: null });
    data = updateLine(second.data, 'line1', { next: 'line2', event: '' });
    data = addChoice(data, 'line1');
    data = updateChoice(data, 'line1', 'choice1', { text: 'Why?', next: 'line2', requires: '' });
    expect(data.startId).toBe('line1');
    expect(data.lines[0].choices).toEqual([{ id: 'choice1', text: 'Why?', next: 'line2' }]);
    expect(lineLabel(data, 'line1')).toBe('1. Guard: Halt.');
    expect(moveLine(data, 'line2', -1).lines.map(line => line.id)).toEqual(['line2', 'line1']);

    const removed = removeLine(data, 'line2');
    expect(removed.lines).toEqual([{ id: 'line1', speaker: 'Guard', text: 'Halt.', next: null, choices: [{ id: 'choice1', text: 'Why?', next: null }] }]);
    expect(removeChoice(removed, 'line1', 'choice1').lines[0].choices).toBeUndefined();
    expect(removeLine(removed, 'line1')).toEqual({ startId: '', lines: [] });
  });
});

describe('dialogue component', () => {
  afterEach(() => dialogueSpeakers.clear());

  it('defaults and clamps its settings', () => {
    const component = (props: Record<string, unknown>) => ({ id: 'd', type: 'dialogue', enabled: true, props });
    expect(resolveDialogueSettings(component({}))).toEqual({ ...DIALOGUE_DEFAULTS, data: { startId: '', lines: [] } });
    expect(resolveDialogueSettings(component({ radius: 500, prompt: '  Ask  ' }))).toMatchObject({ radius: 100, prompt: 'Ask' });
    expect(resolveDialogueSettings(component({ radius: -2, prompt: ' ' }))).toMatchObject({ radius: 0, prompt: 'Talk' });
  });

  it('finds the nearest speaker in reach that has something to say', () => {
    const at = (x: number) => {
      const object = new THREE.Object3D();
      object.position.set(x, 0, 0);
      object.updateMatrixWorld(true);
      return { current: object };
    };
    const speaker = (x: number, radius: number, data = innkeeper): DialogueSpeaker => ({ data, radius, prompt: 'Talk', host: at(x) });
    const speakers = new Map([
      ['far', speaker(10, 3)],
      ['near', speaker(2, 3)],
      ['closest-but-silent', speaker(1, 3, { startId: '', lines: [] })],
      ['script-only', speaker(0.5, 0)],
    ]);
    expect(nearestSpeaker(speakers, new THREE.Vector3(0, 0, 0))?.objectId).toBe('near');
    expect(nearestSpeaker(speakers, new THREE.Vector3(-5, 0, 0))).toBeNull();
  });

  it('labels the prompt with the keyboard binding of Interact', () => {
    expect(interactKeyLabel(new InputState(DEFAULT_INPUT_MAP))).toBe('F');
    expect(interactKeyLabel(new InputState([]))).toBe('');
  });
});

describe('dialogue overlay', () => {
  it('shows the line and its choices, taking them by click or number key', () => {
    const store = createDialogueStore();
    store.setHooks(variableHooks({ heardRumour: true }).hooks);
    store.start('inn', innkeeper);
    render(<DialogueOverlay input={null} store={store} />);
    expect(screen.getByText('Innkeeper')).toBeTruthy();
    expect(screen.getByText('Welcome. Need a room?')).toBeTruthy();
    fireEvent.keyDown(window, { code: 'Digit2' });
    expect(screen.getByText('Ask the hunter.')).toBeTruthy();
    fireEvent.click(screen.getByRole('dialog'));
    expect(store.state().active).toBeNull();
  });

  it('opens the conversation from the prompt', () => {
    dialogueSpeakers.set('inn', { data: innkeeper, radius: 3, prompt: 'Talk', host: { current: null } });
    const store = createDialogueStore();
    store.setPrompt({ objectId: 'inn', text: 'Talk', key: 'F' });
    render(<DialogueOverlay input={new InputState(DEFAULT_INPUT_MAP)} store={store} />);
    fireEvent.click(screen.getByRole('button', { name: /Talk/ }));
    expect(store.state().active?.line.id).toBe('hello');
    dialogueSpeakers.clear();
  });

  it('scopes translation keys to the speaking object', () => {
    expect(dialogueTextKey('inn', 'hello', 'text')).toBe('dialogue.inn.hello.text');
  });
});

const pin = (node: string, name: string, dataType: LogicPin['dataType'], direction: LogicPin['direction']): LogicPin =>
  ({ id: `${node}:${direction}:${name}`, name, dataType, direction });
const node = (id: string, type: LogicNode['type'], name: string, inputs: LogicPin[], outputs: LogicPin[], data?: Record<string, unknown>): LogicNode =>
  ({ id, type, name, position: { x: 0, y: 0 }, inputs, outputs, data });
const wire = (from: LogicNode, fromPin: string, to: LogicNode, toPin: string) => ({
  id: `${from.id}->${to.id}`,
  fromNodeId: from.id, fromPinId: from.outputs.find(item => item.name === fromPin)!.id,
  toNodeId: to.id, toPinId: to.inputs.find(item => item.name === toPin)!.id,
});

describe('dialogue blueprint nodes', () => {
  afterEach(() => {
    dialogueStore.reset();
    dialogueSpeakers.clear();
  });

  const run = (blueprint: LevelBlueprintData) => {
    const addNotification = vi.fn();
    const props: UseLevelBlueprintRuntimeProps = {
      blueprint, levelObjects: [], playerEntityRef: { current: null }, playerApiRef: { current: undefined }, enemyApiRef: { current: undefined },
      destroyActor: () => undefined, addNotification,
    };
    renderHook(() => useLevelBlueprintRuntime(props));
    return () => addNotification.mock.calls.map(([notification]) => (notification as { message: string }).message);
  };
  const begin = node('begin', 'Event', 'Event BeginPlay', [], [pin('begin', 'Out', 'Exec', 'Output')]);
  const start = (target: string) => node('start', 'StartDialogue', 'Start Dialogue',
    [pin('start', 'Exec', 'Exec', 'Input')], [pin('start', 'Out', 'Exec', 'Output')], { targetObjectId: target });

  it('Start Dialogue opens the conversation on the chosen object', () => {
    dialogueSpeakers.set('inn', { data: innkeeper, radius: 0, prompt: 'Talk', host: { current: null } });
    const notes = run({ nodes: [begin, start('inn')], connections: [wire(begin, 'Out', start('inn'), 'Exec')], variables: [] });
    expect(dialogueStore.state().active?.objectId).toBe('inn');
    expect(notes()).toEqual([]);
  });

  it('Start Dialogue warns when the object has no Dialogue component', () => {
    const notes = run({ nodes: [begin, start('rock')], connections: [wire(begin, 'Out', start('rock'), 'Exec')], variables: [] });
    expect(dialogueStore.state().active).toBeNull();
    expect(notes()).toEqual(['Start Dialogue: the chosen object has no Dialogue component in this session.']);
  });

  it('Dialogue Event runs for the events it names', () => {
    const event = node('heard', 'Event', 'Event DialogueEvent', [], [pin('heard', 'Exec', 'Exec', 'Output')], { eventName: 'rented' });
    const print = node('print', 'PrintString', 'Print String', [pin('print', 'In', 'Exec', 'Input')], [pin('print', 'Out', 'Exec', 'Output')], { printMessage: 'rented' });
    const notes = run({ nodes: [begin, event, print], connections: [wire(event, 'Exec', print, 'In')], variables: [] });
    act(() => {
      dialogueStore.start('inn', innkeeper);
      dialogueStore.advance('yes');
    });
    expect(notes()).toEqual(['[Output] rented']);
    expect(dialogueEventMatches(node('n', 'Event', 'Event DialogueEvent', [], [], { eventName: '' }), { objectId: 'x', name: 'any' })).toBe(true);
  });
});

describe('dialogue in scripts', () => {
  const snapshot = (frame: number, events: ScriptSnapshot['events'] = []): ScriptSnapshot => ({
    frame, time: 0, delta: 0.1, objects: [{ id: 'npc', name: 'npc', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], parentId: null, visible: true }],
    player: null, input: {}, variables: {}, events, raycasts: {}, net: { connected: false, isHost: true, selfId: null, peers: [] },
  });

  it('ctx.startDialogue defaults to the script\'s own object', () => {
    const host = createScriptHost();
    host.load([{ id: 's', objectId: 'npc', source: "function onUpdate(ctx) { ctx.startDialogue(); ctx.startDialogue('inn'); }" }], source => source, snapshot(0));
    expect(host.frame(snapshot(1)).filter(command => command.type === 'startDialogue'))
      .toEqual([{ type: 'startDialogue', objectId: 'npc' }, { type: 'startDialogue', objectId: 'inn' }]);
    expect(parseScriptCommand({ type: 'startDialogue', objectId: 'npc' })).toEqual({ type: 'startDialogue', objectId: 'npc' });
    expect(parseScriptCommand({ type: 'startDialogue', objectId: 3 })).toBeNull();
  });

  it('onDialogueEvent hears dialogue events', () => {
    const host = createScriptHost();
    host.load([{ id: 's', objectId: 'npc', source: "function onDialogueEvent(ctx, name, objectId) { ctx.vars.set('heard', name + '@' + objectId); }" }], source => source, snapshot(0));
    expect(host.frame(snapshot(1, [{ type: 'dialogueEvent', objectId: 'inn', name: 'rented' }])).filter(command => command.type === 'setVariable'))
      .toEqual([{ type: 'setVariable', name: 'heard', value: 'rented@inn' }]);
  });
});
