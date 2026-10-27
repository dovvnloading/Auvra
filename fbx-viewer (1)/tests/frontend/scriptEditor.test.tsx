import { readFileSync } from 'node:fs';
import path from 'node:path';
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createExecutionGuard } from '../../components/HUDEditor/hudExecutionGuard';
import { ScriptInspector } from '../../components/Scripting/ScriptInspector';
import {
  countLines,
  indentSelection,
  newlineWithIndent,
  ScriptEditorModal,
  utf8ByteLength,
  type ScriptReferenceGroup,
} from '../../components/Scripting/ScriptEditorModal';
import { SCRIPT_TEMPLATES } from '../../components/Scripting/scriptTemplates';
import { SCRIPT_LIMITS, type ScriptCommand, type ScriptObjectState, type ScriptSnapshot } from '../../runtime/scripting/protocol';
import { SCRIPT_GUARD_IDENTIFIER, compileScriptSource, createScriptHost } from '../../runtime/scripting/scriptApi';
import type { LevelComponent, LevelObject } from '../../types';

const scene = { audioAssets: [] as { id: string; name: string }[], levels: [] as { id: string; name: string }[] };
vi.mock('../../context/SceneContext', () => ({ useScene: () => scene }));

const object: LevelObject = {
  id: 'obj-1', levelId: 'level-1', modelId: '', name: 'Crate', type: 'prop',
  position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
};

/** Holds the component like the inspector does: every onChangeProps merges into props. */
const renderInspector = (props: Record<string, unknown> = {}) => {
  const commits: Record<string, unknown>[] = [];
  const Harness = () => {
    const [component, setComponent] = useState<LevelComponent>({ id: 'script-1', type: 'script', enabled: true, props });
    return (
      <ScriptInspector
        object={object}
        component={component}
        onChangeProps={(changes) => {
          commits.push(changes);
          setComponent(current => ({ ...current, props: { ...current.props, ...changes } }));
        }}
      />
    );
  };
  render(<Harness />);
  return { commits };
};

/** The modal on its own, with a parent that stores what it saves. */
const renderModal = (initial: string, extra: { references?: ScriptReferenceGroup[]; onSave?: (source: string) => void } = {}) => {
  const saves: string[] = [];
  const onClose = vi.fn();
  const Harness = () => {
    const [source, setSource] = useState(initial);
    return (
      <ScriptEditorModal
        title="Crate"
        source={source}
        references={extra.references}
        onSave={extra.onSave ?? ((next) => { saves.push(next); setSource(next); })}
        onClose={onClose}
      />
    );
  };
  render(<Harness />);
  return { saves, onClose };
};

const editor = () => screen.getByRole('textbox', { name: 'Script source' }) as HTMLTextAreaElement;
const dialog = () => screen.getByRole('dialog', { name: 'Edit Script' });
const type = (text: string) => fireEvent.change(editor(), { target: { value: text } });

describe('script inspector', () => {
  it('says there is no script yet', () => {
    renderInspector();
    expect(screen.getByText('No script yet')).toBeInTheDocument();
  });

  it('previews six lines and counts the rest', () => {
    const source = Array.from({ length: 9 }, (_, index) => `line ${index + 1}`).join('\n');
    renderInspector({ source });
    const preview = screen.getByLabelText('Script preview');
    expect(preview.textContent).toBe('line 1\nline 2\nline 3\nline 4\nline 5\nline 6');
    expect(screen.getByText('+3 more lines')).toBeInTheDocument();
    expect(screen.queryByText('No script yet')).not.toBeInTheDocument();
  });

  it('opens the editor on the stored source with Edit Script', () => {
    renderInspector({ source: 'function onStart(ctx) {}\n' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Script' }));
    expect(dialog()).toBeInTheDocument();
    expect(editor().value).toBe('function onStart(ctx) {}\n');
    expect(editor()).toHaveFocus();
    expect(within(dialog()).getByText(/Crate/)).toBeInTheDocument();
  });

  it('saves edits through onChangeProps({ source }) with the Save button', () => {
    const { commits } = renderInspector({ source: 'old' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Script' }));
    const save = screen.getByRole('button', { name: /^Save$/ });
    expect(save).toBeDisabled();

    type('function onUpdate(ctx, dt) {}');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    fireEvent.click(save);

    expect(commits).toEqual([{ source: 'function onUpdate(ctx, dt) {}' }]);
    // The saved text came back as the stored source, so nothing is unsaved and the editor stays open.
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
    expect(save).toBeDisabled();
    expect(dialog()).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Script preview').textContent).toBe('function onUpdate(ctx, dt) {}');
  });

  it('saves with Ctrl+S without the key reaching window shortcuts', () => {
    const { commits } = renderInspector();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Script' }));
    type('function onStart(ctx) { ctx.log("hi"); }');

    const windowListener = vi.fn();
    window.addEventListener('keydown', windowListener);
    try {
      fireEvent.keyDown(editor(), { key: 's', ctrlKey: true });
    } finally {
      window.removeEventListener('keydown', windowListener);
    }

    expect(commits).toEqual([{ source: 'function onStart(ctx) { ctx.log("hi"); }' }]);
    expect(windowListener).not.toHaveBeenCalled();
  });

  it('Save & Close commits and closes', () => {
    const { commits } = renderInspector({ source: 'a' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Script' }));
    type('b');
    fireEvent.click(screen.getByRole('button', { name: 'Save & Close' }));
    expect(commits).toEqual([{ source: 'b' }]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens a template from the picker and writes it only on save', () => {
    const { commits } = renderInspector({ source: 'keep me' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Script template' }), { target: { value: 'spawner' } });
    expect(screen.getByText(/Replaces the current script only when you save/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New from Template' }));

    const spawner = SCRIPT_TEMPLATES.find(template => template.id === 'spawner')!;
    expect(editor().value).toBe(spawner.source);
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(commits).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Save & Close' }));
    expect(commits).toEqual([{ source: spawner.source }]);
  });

  it("offers the project's sounds and levels as ids to insert", () => {
    scene.audioAssets = [{ id: 'audio-7', name: 'Coin Pickup' }];
    scene.levels = [{ id: 'level-2', name: 'Cave' }];
    try {
      renderInspector({ source: '' });
      fireEvent.click(screen.getByRole('button', { name: 'Edit Script' }));
      fireEvent.click(screen.getByRole('button', { name: 'Insert id of Coin Pickup (Sounds)' }));
      expect(editor().value).toBe("'audio-7'");
      expect(screen.getByRole('button', { name: 'Insert id of Cave (Levels)' })).toBeInTheDocument();
      expect(screen.getAllByText('None in this project.')).toHaveLength(1);
    } finally {
      scene.audioAssets = [];
      scene.levels = [];
    }
  });

  it('warns when the stored script is over the size limit', () => {
    renderInspector({ source: 'x'.repeat(SCRIPT_LIMITS.maxSourceBytes + 1) });
    expect(screen.getByText(/limit, so it will not run/)).toBeInTheDocument();
  });
});

describe('script editor modal', () => {
  it('indents the selected lines with Tab and outdents them with Shift+Tab', () => {
    renderModal('a\n  b\n\nc');
    const textarea = editor();
    textarea.setSelectionRange(0, textarea.value.length);
    fireEvent.keyDown(textarea, { key: 'Tab' });
    expect(textarea.value).toBe('    a\n      b\n\n    c');
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, textarea.value.length]);

    fireEvent.keyDown(textarea, { key: 'Tab', shiftKey: true });
    expect(textarea.value).toBe('a\n  b\n\nc');
    fireEvent.keyDown(textarea, { key: 'Tab', shiftKey: true });
    expect(textarea.value).toBe('a\nb\n\nc');
  });

  it('inserts spaces to the next indent stop with a bare caret, and keeps focus in the editor', () => {
    renderModal('ab');
    const textarea = editor();
    textarea.setSelectionRange(1, 1);
    fireEvent.keyDown(textarea, { key: 'Tab' });
    expect(textarea.value).toBe('a   b');
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([4, 4]);
    expect(textarea).toHaveFocus();
  });

  it('lets Ctrl+M switch Tab to moving focus', () => {
    renderModal('ab');
    const textarea = editor();
    fireEvent.keyDown(textarea, { key: 'm', ctrlKey: true });
    expect(screen.getByText('Tab moves focus')).toBeInTheDocument();
    textarea.setSelectionRange(1, 1);
    fireEvent.keyDown(textarea, { key: 'Tab' });
    expect(textarea.value).toBe('ab');
  });

  it('keeps the indentation on Enter and adds a step after an opening brace', () => {
    renderModal('    if (x) {');
    const textarea = editor();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(textarea.value).toBe('    if (x) {\n        ');
  });

  it('numbers every line in the gutter and scrolls it with the text', () => {
    renderModal('one\ntwo\nthree');
    const gutter = screen.getByTestId('script-gutter');
    expect(gutter.querySelector('pre')?.textContent).toBe('1\n2\n3');

    type('one\ntwo\nthree\nfour');
    expect(gutter.querySelector('pre')?.textContent).toBe('1\n2\n3\n4');

    Object.defineProperty(editor(), 'scrollTop', { configurable: true, value: 140 });
    fireEvent.scroll(editor());
    expect(gutter.style.transform).toBe('translateY(-140px)');
  });

  it('disables saving over the size limit and shows the size against it', () => {
    renderModal('');
    type('x'.repeat(SCRIPT_LIMITS.maxSourceBytes));
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeEnabled();
    expect(screen.getByText('128.0 KiB / 128.0 KiB')).toBeInTheDocument();

    type('x'.repeat(SCRIPT_LIMITS.maxSourceBytes + 1));
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save & Close' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Over the size limit');
  });

  it('refuses Ctrl+S over the limit', () => {
    const { saves } = renderModal('');
    // Two-byte characters: under the limit in characters, over it in bytes.
    type('é'.repeat(SCRIPT_LIMITS.maxSourceBytes / 2 + 1));
    fireEvent.keyDown(editor(), { key: 's', ctrlKey: true });
    expect(saves).toEqual([]);
  });

  it('asks before discarding unsaved changes on Escape, inside the editor', () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const { saves, onClose } = renderModal('saved');
    type('changed');

    const windowListener = vi.fn();
    window.addEventListener('keydown', windowListener);
    try {
      fireEvent.keyDown(editor(), { key: 'Escape' });
    } finally {
      window.removeEventListener('keydown', windowListener);
    }
    // World Editor shortcuts (Esc clears the selection) must not see it.
    expect(windowListener).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();

    const confirm = screen.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
    expect(within(confirm).getByRole('button', { name: 'Keep Editing' })).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    // Escape again keeps editing.
    fireEvent.keyDown(within(confirm).getByRole('button', { name: 'Keep Editing' }), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(editor().value).toBe('changed');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(saves).toEqual([]);
  });

  it('can save from the discard prompt', () => {
    const { saves, onClose } = renderModal('saved');
    type('changed');
    fireEvent.click(screen.getByRole('button', { name: 'Close script editor' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save & Close' }));
    expect(saves).toEqual(['changed']);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes at once when nothing is unsaved', () => {
    const { onClose } = renderModal('saved');
    fireEvent.keyDown(editor(), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows why a save failed and keeps the changes', () => {
    const { onClose } = renderModal('saved', { onSave: () => { throw new Error('Project is read-only'); } });
    type('changed');
    fireEvent.click(screen.getByRole('button', { name: 'Save & Close' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Not saved: Project is read-only');
    expect(onClose).not.toHaveBeenCalled();
    expect(editor().value).toBe('changed');
  });

  it('lists the callbacks and ctx API in a collapsible reference panel', () => {
    renderModal('');
    const toggle = screen.getByRole('button', { name: 'API Reference' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = screen.getByRole('complementary', { name: 'Script API reference' });
    for (const signature of ['onStart(ctx)', 'onUpdate(ctx, dt)', 'onTriggerEnter(ctx, other)', 'onSpawned(ctx, requestId, objectIds)', 'ctx.raycastResult(requestId)', 'ctx.state']) {
      expect(within(panel).getByText(signature)).toBeInTheDocument();
    }
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('complementary', { name: 'Script API reference' })).not.toBeInTheDocument();
  });

  it('inserts a quoted id from the reference panel at the cursor', () => {
    renderModal('ctx.spawn(, [0, 0, 0]);', {
      references: [{ label: 'Prefabs', usage: 'ctx.spawn', items: [{ id: 'prefab-42', name: 'Barrel' }] }],
    });
    const textarea = editor();
    textarea.setSelectionRange(10, 10);
    fireEvent.click(screen.getByRole('button', { name: 'Insert id of Barrel (Prefabs)' }));
    expect(textarea.value).toBe("ctx.spawn('prefab-42', [0, 0, 0]);");
  });
});

describe('script editor helpers', () => {
  it('measures UTF-8 bytes like TextEncoder', () => {
    for (const text of ['', 'abc', 'é', '€', '😀', 'a\u{1F600}bé', '\ud800']) {
      expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).length);
    }
  });

  it('counts lines', () => {
    expect(countLines('')).toBe(1);
    expect(countLines('a\nb\n')).toBe(3);
  });

  it('leaves a line alone when the selection ends at its start', () => {
    const edit = indentSelection('a\nb\nc', 0, 4, false)!;
    expect(edit.insert).toBe('    a\n    b');
    expect([edit.from, edit.to]).toEqual([0, 3]);
    expect([edit.selectionStart, edit.selectionEnd]).toEqual([0, 12]);
  });

  it('outdents a tab or up to four spaces and returns null when there is nothing to remove', () => {
    expect(indentSelection('\tx\n      y', 0, 10, true)?.insert).toBe('x\n  y');
    expect(indentSelection('x', 1, 1, true)).toBeNull();
  });

  it('keeps the caret on its character when outdenting', () => {
    const edit = indentSelection('      value', 8, 8, true)!;
    expect(edit.insert).toBe('  value');
    expect(edit.selectionStart).toBe(4);
  });

  it('continues the indentation of the current line on Enter', () => {
    expect(newlineWithIndent('  foo', 5, 5).insert).toBe('\n  ');
    expect(newlineWithIndent('call(', 5, 5).insert).toBe('\n    ');
  });
});

// --- Templates run against a fake ctx that only has the documented API ---

type Vec3 = [number, number, number];
const CALLBACKS = ['onStart', 'onUpdate', 'onTriggerEnter', 'onTriggerExit', 'onAnimNotify', 'onSpawned'] as const;
type Callback = typeof CALLBACKS[number];
const CTX_MEMBERS = ['self', 'find', 'get', 'all', 'player', 'input', 'vars', 'time', 'delta', 'spawn', 'raycast', 'raycastResult', 'playSound', 'playPlayerAnimation', 'openLevel', 'log', 'warn', 'error', 'state'];
const HANDLE_MEMBERS = ['id', 'name', 'position', 'rotation', 'scale', 'setPosition', 'setRotation', 'setScale', 'translate', 'setVisible', 'applyImpulse', 'destroy'];
/** Templates stick to the members above; the documentation also covers these. */
const DOC_CTX_MEMBERS = [...CTX_MEMBERS, 'frame'];
const DOC_HANDLE_MEMBERS = [...HANDLE_MEMBERS, 'exists', 'visible'];

/** Throws on any property outside `allowed`, so a template using an undocumented API fails. */
const strict = <T extends object>(target: T, allowed: string[], what: string): T => new Proxy(target, {
  get(value, key) {
    if (typeof key === 'string' && !allowed.includes(key)) throw new Error(`${what}.${key} is not part of the script API`);
    return Reflect.get(value, key);
  },
});

interface FakeObject { id: string; name: string; position: Vec3; rotation: Vec3; scale: Vec3; visible: boolean; destroyed: boolean }

const createWorld = (objects: Omit<FakeObject, 'visible' | 'destroyed' | 'rotation' | 'scale'>[], selfId: string, api: 'template' | 'docs' = 'template') => {
  const vector = (x: number | Vec3, y?: number, z?: number): Vec3 => (Array.isArray(x) ? [x[0], x[1], x[2]] : [x, y ?? 0, z ?? 0]);
  const world = new Map<string, FakeObject>(objects.map(item => [item.id, { rotation: [0, 0, 0], scale: [1, 1, 1], visible: true, destroyed: false, ...item }]));
  const vars = new Map<string, number | boolean | string>();
  const spawns: { requestId: string; prefabId: string; position: Vec3 }[] = [];
  const sounds: unknown[][] = [];
  const logs: { level: string; args: unknown[] }[] = [];
  const handle = (item: FakeObject) => strict({
    id: item.id,
    name: item.name,
    position: [...item.position] as Vec3,
    rotation: [...item.rotation] as Vec3,
    scale: [...item.scale] as Vec3,
    exists: !item.destroyed,
    visible: item.visible,
    setPosition: (x: number | Vec3, y?: number, z?: number) => { item.position = vector(x, y, z); },
    setRotation: (x: number | Vec3, y?: number, z?: number) => { item.rotation = vector(x, y, z); },
    setScale: (x: number | Vec3, y?: number, z?: number) => { item.scale = vector(x, y, z); },
    translate: (x: number | Vec3, y?: number, z?: number) => {
      const offset = vector(x, y, z);
      item.position = [item.position[0] + offset[0], item.position[1] + offset[1], item.position[2] + offset[2]];
    },
    setVisible: (visible: boolean) => { item.visible = visible; },
    applyImpulse: () => undefined,
    destroy: () => { item.destroyed = true; },
  }, api === 'docs' ? DOC_HANDLE_MEMBERS : HANDLE_MEMBERS, 'handle');
  const live = () => [...world.values()].filter(item => !item.destroyed);
  const ctx = strict({
    get self() { return handle(world.get(selfId)!); },
    find: (name: string) => { const item = live().find(candidate => candidate.name === name); return item ? handle(item) : null; },
    get: (id: string) => { const item = live().find(candidate => candidate.id === id); return item ? handle(item) : null; },
    all: () => live().map(handle),
    player: null,
    input: { isDown: () => false, wasPressed: () => false, wasReleased: () => false, value: () => 0 },
    vars: { get: (name: string) => vars.get(name), set: (name: string, value: number | boolean | string) => { vars.set(name, value); } },
    time: 0,
    delta: 0,
    frame: 0,
    spawn: (prefabId: string, position: Vec3) => { const requestId = `request-${spawns.length + 1}`; spawns.push({ requestId, prefabId, position }); return requestId; },
    raycast: () => 'ray-1',
    raycastResult: () => undefined,
    playSound: (...args: unknown[]) => { sounds.push(args); },
    playPlayerAnimation: () => undefined,
    openLevel: () => undefined,
    log: (...args: unknown[]) => { logs.push({ level: 'info', args }); },
    warn: (...args: unknown[]) => { logs.push({ level: 'warn', args }); },
    error: (...args: unknown[]) => { logs.push({ level: 'error', args }); },
    state: {} as Record<string, unknown>,
  }, api === 'docs' ? DOC_CTX_MEMBERS : CTX_MEMBERS, 'ctx');
  return { ctx, world, vars, spawns, sounds, logs };
};

/** Evaluates a template the way a script host would: its top-level callback functions. */
const loadTemplate = (source: string): Partial<Record<Callback, (...args: unknown[]) => void>> =>
  new Function(`${source}\nreturn { ${CALLBACKS.map(name => `${name}: typeof ${name} === 'function' ? ${name} : undefined`).join(', ')} };`)();

const template = (id: string) => SCRIPT_TEMPLATES.find(item => item.id === id)!.source;

describe('script templates', () => {
  it('offers the five templates, Empty first', () => {
    expect(SCRIPT_TEMPLATES.map(item => item.label)).toEqual(['Empty', 'Rotate and bob', 'Door opened by trigger', 'Collectible', 'Spawner']);
    expect(new Set(SCRIPT_TEMPLATES.map(item => item.id)).size).toBe(SCRIPT_TEMPLATES.length);
  });

  it('declare only the documented callbacks and use only the documented ctx members', () => {
    for (const { label, source } of SCRIPT_TEMPLATES) {
      const functions = [...source.matchAll(/^function (\w+)/gm)].map(match => match[1]);
      expect(functions.length, label).toBeGreaterThan(0);
      for (const name of functions) expect(CALLBACKS as readonly string[], `${label}: ${name}`).toContain(name);
      for (const [, member] of source.matchAll(/\bctx\.(\w+)/g)) expect(CTX_MEMBERS, `${label}: ctx.${member}`).toContain(member);
      expect(source, label).not.toMatch(/\bconsole\./);
      expect(utf8ByteLength(source)).toBeLessThan(SCRIPT_LIMITS.maxSourceBytes);
    }
  });

  it('Empty runs without doing anything', () => {
    const { ctx, world, logs } = createWorld([{ id: 'self', name: 'Self', position: [1, 2, 3] }], 'self');
    const script = loadTemplate(template('empty'));
    script.onStart?.(ctx);
    script.onUpdate?.(ctx, 0.016);
    expect(world.get('self')!.position).toEqual([1, 2, 3]);
    expect(logs).toEqual([]);
  });

  it('Rotate and bob spins and bobs around the start transform', () => {
    const { ctx, world } = createWorld([{ id: 'self', name: 'Coin', position: [1, 2, 3] }], 'self');
    const script = loadTemplate(template('rotate-bob'));
    ctx.time = 10;
    script.onStart?.(ctx);
    ctx.time = 11;
    script.onUpdate?.(ctx, 1);
    const self = world.get('self')!;
    expect(self.rotation[1]).toBeCloseTo(1.5);
    expect(self.position[0]).toBe(1);
    expect(self.position[1]).toBeCloseTo(2 + Math.sin(2) * 0.25);
    expect(self.position[2]).toBe(3);
  });

  it('Door opens while something is inside the trigger and closes after it leaves', () => {
    const { ctx, world } = createWorld([
      { id: 'trigger', name: 'Door Trigger', position: [0, 0, 0] },
      { id: 'door', name: 'Door', position: [5, 1, 0] },
    ], 'trigger');
    const script = loadTemplate(template('door-trigger'));
    script.onStart?.(ctx);
    script.onUpdate?.(ctx, 0.5);
    expect(world.get('door')!.position).toEqual([5, 1, 0]);

    script.onTriggerEnter?.(ctx, null);
    script.onUpdate?.(ctx, 0.5);
    expect(world.get('door')!.position[1]).toBeCloseTo(2);
    for (let frame = 0; frame < 10; frame++) script.onUpdate?.(ctx, 0.5);
    expect(world.get('door')!.position[1]).toBeCloseTo(4);

    script.onTriggerExit?.(ctx, null);
    for (let frame = 0; frame < 10; frame++) script.onUpdate?.(ctx, 0.5);
    expect(world.get('door')!.position).toEqual([5, 1, 0]);
  });

  it('Door warns when there is no door to open', () => {
    const { ctx, logs } = createWorld([{ id: 'trigger', name: 'Door Trigger', position: [0, 0, 0] }], 'trigger');
    const script = loadTemplate(template('door-trigger'));
    script.onStart?.(ctx);
    script.onTriggerEnter?.(ctx, null);
    script.onUpdate?.(ctx, 0.5);
    expect(logs.map(log => log.level)).toEqual(['warn']);
  });

  it('Collectible adds to the score and removes itself when the player enters', () => {
    const { ctx, world, vars, sounds } = createWorld([
      { id: 'coin', name: 'Coin', position: [0, 0, 0] },
      { id: 'crate', name: 'Crate', position: [0, 0, 0] },
    ], 'coin');
    vars.set('score', 4);
    const script = loadTemplate(template('collectible'));
    script.onStart?.(ctx);
    script.onUpdate?.(ctx, 0.016);
    // Another object entering (other is its handle) does not collect it.
    script.onTriggerEnter?.(ctx, ctx.get('crate'));
    expect(vars.get('score')).toBe(4);
    expect(world.get('coin')!.destroyed).toBe(false);
    script.onTriggerEnter?.(ctx, null);
    expect(vars.get('score')).toBe(5);
    expect(world.get('coin')!.destroyed).toBe(true);
    expect(sounds).toEqual([]);
  });

  it('Collectible starts the score at 0 and plays its sound when one is set', () => {
    const { ctx, vars, sounds } = createWorld([{ id: 'coin', name: 'Coin', position: [0, 0, 0] }], 'coin');
    const script = loadTemplate(template('collectible').replace("const PICKUP_SOUND = '';", "const PICKUP_SOUND = 'audio-1';"));
    script.onStart?.(ctx);
    script.onTriggerEnter?.(ctx, null);
    expect(vars.get('score')).toBe(1);
    expect(sounds).toEqual([['audio-1', 'sfx']]);
  });

  it('Spawner asks for a prefab id and spawns nothing without one', () => {
    const { ctx, spawns, logs } = createWorld([{ id: 'spawner', name: 'Spawner', position: [0, 0, 0] }], 'spawner');
    const script = loadTemplate(template('spawner'));
    script.onStart?.(ctx);
    ctx.time = 100;
    script.onUpdate?.(ctx, 0.016);
    expect(spawns).toEqual([]);
    expect(logs.map(log => log.level)).toEqual(['warn']);
  });

  it('Spawner spawns every interval up to the limit and replaces destroyed copies', () => {
    const { ctx, world, spawns } = createWorld([{ id: 'spawner', name: 'Spawner', position: [2, 0, -1] }], 'spawner');
    const script = loadTemplate(template('spawner').replace("const PREFAB_ID = '';", "const PREFAB_ID = 'crate';"));
    script.onStart?.(ctx);
    const step = (time: number) => {
      ctx.time = time;
      const before = spawns.length;
      script.onUpdate?.(ctx, 0.016);
      // Answer each new request the next frame, as the runtime does.
      for (const request of spawns.slice(before)) {
        const id = `copy-${request.requestId}`;
        world.set(id, { id, name: 'Crate', position: request.position, rotation: [0, 0, 0], scale: [1, 1, 1], visible: true, destroyed: false });
        script.onSpawned?.(ctx, request.requestId, [id, `${id}-child`]);
      }
    };

    step(2.9);
    expect(spawns).toEqual([]);
    step(3);
    expect(spawns).toEqual([{ requestId: 'request-1', prefabId: 'crate', position: [2, 1, -1] }]);
    for (let index = 2; index <= 8; index++) step(3 * index);
    expect(spawns).toHaveLength(5);

    // A request the script did not make is ignored.
    script.onSpawned?.(ctx, 'someone-else', ['stray']);
    world.get('copy-request-1')!.destroyed = true;
    step(30);
    expect(spawns).toHaveLength(6);
    step(33);
    expect(spawns).toHaveLength(6);
  });
});

describe('scripting documentation', () => {
  const docs = readFileSync(path.resolve(__dirname, '../../../docs/scripting.md'), 'utf8');
  const examples = [...docs.matchAll(/```js\n([\s\S]*?)```/g)].map(match => match[1]);

  it('lists every callback and ctx member the editor reference lists', () => {
    for (const name of [...CALLBACKS, ...DOC_CTX_MEMBERS.map(member => `ctx.${member}`), ...DOC_HANDLE_MEMBERS]) {
      expect(docs, name).toContain(`\`${name}`);
    }
  });

  it('has examples that use only the script API and run', () => {
    expect(examples.length).toBeGreaterThanOrEqual(4);
    for (const source of examples) {
      for (const [, member] of source.matchAll(/\bctx\.(\w+)/g)) expect(DOC_CTX_MEMBERS, `ctx.${member}`).toContain(member);
      const { ctx } = createWorld([{ id: 'self', name: 'Self', position: [0, 1, 0] }], 'self', 'docs');
      const script = loadTemplate(source);
      expect(Object.values(script).some(Boolean)).toBe(true);
      script.onStart?.(ctx);
      for (let frame = 1; frame <= 3; frame++) {
        ctx.time = frame;
        script.onUpdate?.(ctx, 1);
      }
      script.onAnimNotify?.(ctx, 'Footstep', 'player');
    }
  });
});

// --- Templates and documentation examples on the real script host ---

describe('templates and examples on the script host', () => {
  type Compiler = Parameters<typeof compileScriptSource>[1];
  let compiler: Compiler;
  beforeAll(async () => {
    const loaded = await import('@babel/standalone');
    compiler = typeof loaded.transform === 'function' ? loaded : (loaded as unknown as { default: Compiler }).default;
  });

  const state = (id: string, name: string, position: Vec3 = [0, 0, 0]): ScriptObjectState => ({
    id, name, position, rotation: [0, 0, 0], scale: [1, 1, 1], parentId: null, visible: true,
  });
  const snapshot = (frame: number, objects: ScriptObjectState[], overrides: Partial<ScriptSnapshot> = {}): ScriptSnapshot => ({
    frame, time: frame * 0.5, delta: 0.5, objects, player: null, input: {}, variables: {}, events: [], raycasts: {}, ...overrides,
  });
  /** Loads `source` on `objectId` with a budgeted guard, as the script frame does. */
  const load = (source: string, objectId: string, objects: ScriptObjectState[]) => {
    const budget = { maxSteps: SCRIPT_LIMITS.maxStepsPerCallback, maxMs: 1_000 };
    let active = createExecutionGuard(budget);
    const host = createScriptHost({
      scope: { [SCRIPT_GUARD_IDENTIFIER]: { tick: () => active.tick() } },
      invoke: (call) => {
        active = createExecutionGuard(budget);
        call();
      },
    });
    const errors = host.load([{ id: 'script-1', objectId, source }], (code) => compileScriptSource(code, compiler), snapshot(0, objects));
    return { host, errors, started: host.flush() };
  };
  const ofType = <T extends ScriptCommand['type']>(commands: ScriptCommand[], type: T) =>
    commands.filter((command): command is Extract<ScriptCommand, { type: T }> => command.type === type);

  it('compiles and runs every template and documentation example without errors', () => {
    const docs = readFileSync(path.resolve(__dirname, '../../../docs/scripting.md'), 'utf8');
    const examples = [...docs.matchAll(/```js\n([\s\S]*?)```/g)].map(match => match[1]);
    for (const source of [...SCRIPT_TEMPLATES.map(item => item.source), ...examples]) {
      const objects = [state('self', 'Self', [0, 1, 0]), state('door', 'Door', [4, 0, 0])];
      const { host, errors } = load(source, 'self', objects);
      expect(errors, source).toEqual([]);
      for (let frame = 1; frame <= 8; frame++) host.frame(snapshot(frame, objects));
      expect(host.errors(), source).toEqual([]);
    }
  });

  it('runs Collectible for the player only', () => {
    const objects = [state('coin', 'Coin'), state('crate', 'Crate')];
    const { host } = load(template('collectible'), 'coin', objects);
    const byCrate = host.frame(snapshot(1, objects, { variables: { score: 4 }, events: [{ type: 'triggerEnter', triggerId: 'coin', otherId: 'crate' }] }));
    expect(ofType(byCrate, 'setVariable')).toEqual([]);
    const byPlayer = host.frame(snapshot(2, objects, { variables: { score: 4 }, events: [{ type: 'triggerEnter', triggerId: 'coin', otherId: 'player' }] }));
    expect(ofType(byPlayer, 'setVariable')).toEqual([{ type: 'setVariable', name: 'score', value: 5 }]);
    expect(ofType(byPlayer, 'destroy')).toEqual([{ type: 'destroy', objectId: 'coin' }]);
  });

  it('runs Door opened by trigger against the named door', () => {
    const objects = [state('trigger', 'Door Trigger'), state('door', 'Door', [4, 0, 0])];
    const { host } = load(template('door-trigger'), 'trigger', objects);
    const commands = host.frame(snapshot(1, objects, { events: [{ type: 'triggerEnter', triggerId: 'trigger', otherId: 'player' }] }));
    expect(ofType(commands, 'setTransform')).toEqual([{ type: 'setTransform', objectId: 'door', position: [4, 1, 0] }]);
  });

  it('runs Spawner once its prefab id is set', () => {
    const objects = [state('spawner', 'Spawner', [2, 0, -1])];
    const { host } = load(template('spawner').replace("const PREFAB_ID = '';", "const PREFAB_ID = 'crate';"), 'spawner', objects);
    expect(ofType(host.frame(snapshot(1, objects)), 'spawnPrefab')).toEqual([]);
    const spawned = ofType(host.frame(snapshot(6, objects)), 'spawnPrefab');
    expect(spawned).toEqual([{ type: 'spawnPrefab', requestId: expect.any(String), prefabId: 'crate', position: [2, 1, -1] }]);
    host.frame(snapshot(7, objects, { events: [{ type: 'spawned', requestId: spawned[0].requestId, objectIds: ['copy'] }] }));
    expect(host.errors()).toEqual([]);
  });

  it('runs Rotate and bob from its start transform', () => {
    const objects = [state('coin', 'Coin', [1, 2, 3])];
    const { host } = load(template('rotate-bob'), 'coin', objects);
    const [move] = ofType(host.frame(snapshot(2, objects)), 'setTransform');
    expect(move.rotation?.[1]).toBeCloseTo(1.5);
    expect(move.position?.[1]).toBeCloseTo(2 + Math.sin(2) * 0.25);
  });
});
