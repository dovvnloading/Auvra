import { Children, isValidElement, type MutableRefObject, type ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { _roots, createRoot, useFrame } from '@react-three/fiber';
import {
  advancePreviewClock,
  clonePreviewResources,
  createPreviewClock,
  entryStateId,
  findFiredTransition,
  GraphPreview,
  PREVIEW_STATUS_TEXT,
  PREVIEW_STEP_SECONDS,
  PreviewClockDriver,
  previewStatus,
  PreviewTimeScope,
  restorePreviewPose,
  type PreviewStatus,
} from '../../components/AnimationGraph/GraphPreview';
import { FIRED_TRANSITION_HIGHLIGHT_MS, GraphCanvas, type FiredTransition } from '../../components/AnimationGraph/GraphCanvas';
import { GraphEditor } from '../../components/AnimationGraph/GraphEditor';
import { BlackboardVariables, LIVE_VARIABLE_POLL_MS } from '../../components/AnimationGraph/panels/BlackboardVariables';
import type { GraphRuntimeAPI } from '../../components/AnimationGraph/GraphRuntime';
import type { GraphContextState } from '../../components/AnimationGraph/hooks/useGraphContext';
import type { AnimationGraphData, GraphState, GraphTransition, LoadedModelData } from '../../types';

const harness = vi.hoisted(() => ({
  canvasChildren: null as unknown,
  scene: null as unknown,
  context: null as unknown,
}));

// The preview canvas needs WebGL; the stand-in keeps what GraphPreview puts inside it so a test
// can drive the preview session the way the runtime would.
vi.mock('../../renderer/AuvraCanvas', () => ({
  AuvraCanvas: (props: { children?: unknown }) => {
    harness.canvasChildren = props.children;
    return <div data-testid="preview-canvas" />;
  },
}));
vi.mock('../../context/SceneContext', () => ({ useScene: () => harness.scene }));
vi.mock('../../components/AnimationGraph/hooks/useGraphContext', () => ({
  useGraphContext: () => harness.context,
}));

const sceneWith = (models: LoadedModelData[] = []) => ({
  models,
  selectedModelId: models[0]?.id ?? null,
  graphData: {},
  attachments: [],
  sockets: [],
  flashTriggers: {},
  textures: [],
  cameraState: { position: [4, 4, 8], target: [0, 1, 0] },
});

const idleClip = new THREE.AnimationClip('Breathe', 1, []);

const makeModel = (animations: THREE.AnimationClip[]): LoadedModelData => {
  const object = new THREE.Group();
  object.name = 'Hero';
  const hips = new THREE.Bone();
  hips.name = 'Hips';
  object.add(hips);
  return { id: 'm1', name: 'Hero', url: '', object, animations, category: 'Character', isPlacedInScene: true };
};

const makeState = (id: string, name: string, x: number, isRoot = false): GraphState => ({
  id,
  name,
  position: { x, y: 0 },
  loop: true,
  isRoot,
  stateType: 'Single',
  clipName: 'Breathe',
  blendSamples: [],
  blendParamX: '',
  blendParamY: '',
});

const toRun: GraphTransition = { id: 't-run', fromStateId: 'idle', toStateId: 'run', duration: 0.2, conditions: [{ variableId: 'v-speed', operator: '>', value: 0.5 }] };
const toIdle: GraphTransition = { id: 't-idle', fromStateId: 'run', toStateId: 'idle', duration: 0.2, conditions: [{ variableId: 'v-speed', operator: '<=', value: 0.5 }] };

// The persisted activeStateId points at Run on purpose: the canvas must follow the runtime, not it.
const makeGraph = (): AnimationGraphData => ({
  variables: [
    { id: 'v-speed', name: 'Speed', type: 'Float', value: 0 },
    { id: 'v-grounded', name: 'Grounded', type: 'Boolean', value: true },
  ],
  inputs: [],
  states: [makeState('idle', 'Idle', 0, true), makeState('run', 'Run', 300)],
  transitions: [toRun, toIdle],
  activeStateId: 'run',
});

/** A stand-in for the preview runtime's API, backed by a plain value map. */
const fakeRuntime = (initial: Record<string, number | boolean>) => {
  const values: Record<string, number | boolean> = { ...initial };
  const setVariable = vi.fn((name: string, value: number | boolean) => { values[name] = value; });
  const api: GraphRuntimeAPI = {
    setVariable,
    getVariable: (name: string) => values[name],
    getVariables: () => ({ ...values }),
    getActiveState: () => null,
  };
  return { api, values, setVariable };
};

interface SessionProps {
  onStart: () => void;
  onActiveStateChange: (id: string) => void;
  apiRef: MutableRefObject<GraphRuntimeAPI | undefined>;
}

/** The preview session GraphPreview last rendered into its canvas, with its React key. */
const previewSession = (): { key: string | null; props: SessionProps } => {
  for (const child of Children.toArray(harness.canvasChildren as ReactNode)) {
    if (isValidElement<SessionProps>(child) && typeof child.props.onStart === 'function') {
      return { key: child.key === null ? null : String(child.key), props: child.props };
    }
  }
  throw new Error('the preview canvas has no session');
};

const nodeElement = (name: string): HTMLElement => {
  const node = screen.getByText(name).closest('[data-state-id]');
  if (!(node instanceof HTMLElement)) throw new Error(`no graph node named ${name}`);
  return node;
};

const firedPath = (): Element | null => document.querySelector('[data-fired-transition]');

afterEach(() => {
  vi.useRealTimers();
  harness.canvasChildren = null;
  harness.scene = null;
  harness.context = null;
});

describe('preview status badge', () => {
  it('derives the status from the model, its clips and the transport', () => {
    expect(previewStatus(false, 3, false)).toBe('no-mesh');
    expect(previewStatus(false, 0, true)).toBe('no-mesh');
    expect(previewStatus(true, 0, false)).toBe('no-clips');
    expect(previewStatus(true, 2, true)).toBe('paused');
    expect(previewStatus(true, 2, false)).toBe('live');
  });

  it('says No mesh linked, with a hint, when the graph has no model', () => {
    harness.scene = sceneWith([makeModel([idleClip])]);
    const statuses: PreviewStatus[] = [];
    render(<GraphPreview graph={makeGraph()} model={null} allClips={[idleClip]} controls onStatusChange={status => statuses.push(status)} />);

    expect(screen.getByRole('status')).toHaveTextContent('No mesh linked');
    expect(screen.getByText(PREVIEW_STATUS_TEXT['no-mesh'].hint as string)).toBeInTheDocument();
    // An explicit null never borrows the scene's selected model.
    expect(screen.queryByTestId('preview-canvas')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause preview' })).not.toBeInTheDocument();
    expect(statuses).toEqual(['no-mesh']);
  });

  it('says No clips when there is a model but nothing to play', () => {
    harness.scene = sceneWith();
    render(<GraphPreview graph={makeGraph()} model={makeModel([])} allClips={[]} controls />);

    expect(screen.getByRole('status')).toHaveTextContent('No clips');
    expect(screen.getByText(PREVIEW_STATUS_TEXT['no-clips'].hint as string)).toBeInTheDocument();
    expect(screen.getByTestId('preview-canvas')).toBeInTheDocument();
  });

  it('says Live while playing and Paused while paused', () => {
    harness.scene = sceneWith();
    const statuses: PreviewStatus[] = [];
    render(<GraphPreview graph={makeGraph()} model={makeModel([idleClip])} allClips={[idleClip]} controls onStatusChange={status => statuses.push(status)} />);

    expect(screen.getByRole('status')).toHaveTextContent('Live');
    expect(screen.getByRole('status')).toHaveTextContent('Hero');

    fireEvent.click(screen.getByRole('button', { name: 'Pause preview' }));
    expect(screen.getByRole('status')).toHaveTextContent('Paused');
    expect(screen.getByRole('status')).not.toHaveTextContent('Live');

    fireEvent.click(screen.getByRole('button', { name: 'Play preview' }));
    expect(screen.getByRole('status')).toHaveTextContent('Live');
    expect(statuses).toEqual(['live', 'paused', 'live']);
  });

  it('shows no badge or transport without controls', () => {
    harness.scene = sceneWith();
    render(<GraphPreview graph={makeGraph()} model={makeModel([idleClip])} allClips={[idleClip]} />);

    expect(screen.getByTestId('preview-canvas')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart preview' })).not.toBeInTheDocument();
  });
});

describe('preview transport', () => {
  it('starts with the camera free, steps only while paused and keeps speed within 0.1x-2x', () => {
    harness.scene = sceneWith();
    render(<GraphPreview graph={makeGraph()} model={makeModel([idleClip])} allClips={[idleClip]} controls />);

    const follow = screen.getByRole('button', { name: 'Follow model' });
    expect(follow).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(follow);
    expect(follow).toHaveAttribute('aria-pressed', 'true');

    expect(screen.getByRole('button', { name: 'Step one frame' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Pause preview' }));
    expect(screen.getByRole('button', { name: 'Step one frame' })).toBeEnabled();

    const speed = screen.getByRole('slider', { name: 'Playback speed' });
    expect(speed).toHaveAttribute('min', '0.1');
    expect(speed).toHaveAttribute('max', '2');
    fireEvent.change(speed, { target: { value: '0.5' } });
    expect(screen.getByRole('button', { name: 'Reset playback speed' })).toHaveTextContent('0.50x');
    fireEvent.click(screen.getByRole('button', { name: 'Reset playback speed' }));
    expect(screen.getByRole('button', { name: 'Reset playback speed' })).toHaveTextContent('1.00x');
  });

  it('runs the runtime on scaled time, holds it while paused and advances one step at a time', () => {
    const clock = createPreviewClock();
    expect(advancePreviewClock(clock, 0.016)).toBeCloseTo(0.016);

    clock.rate = 0.5;
    expect(advancePreviewClock(clock, 0.02)).toBeCloseTo(0.01);
    clock.rate = 2;
    expect(advancePreviewClock(clock, 0.02)).toBeCloseTo(0.04);
    expect(advancePreviewClock(clock, Number.NaN)).toBe(0);

    clock.paused = true;
    expect(advancePreviewClock(clock, 0.02)).toBe(0);
    clock.pendingStep = PREVIEW_STEP_SECONDS;
    expect(advancePreviewClock(clock, 0.02)).toBeCloseTo(PREVIEW_STEP_SECONDS);
    expect(advancePreviewClock(clock, 0.02)).toBe(0);

    // A run restarted while paused advances a hair for a few frames so its entry state blends in.
    clock.settleFrames = 2;
    const settle = advancePreviewClock(clock, 0.02);
    expect(settle).toBeGreaterThan(0);
    expect(settle).toBeLessThan(0.001);
    advancePreviewClock(clock, 0.02);
    expect(advancePreviewClock(clock, 0.02)).toBe(0);
  });

  it('feeds preview time to frame callbacks inside the time scope and real time to the rest', async () => {
    const canvas = document.createElement('canvas');
    const gl = { render: vi.fn(), setSize: vi.fn(), setPixelRatio: vi.fn(), domElement: canvas };
    const root = createRoot(canvas);
    root.configure({ gl: gl as unknown as THREE.WebGLRenderer, frameloop: 'never', size: { width: 64, height: 64, top: 0, left: 0 } });
    const clock = createPreviewClock();
    const scoped: number[] = [];
    const real: number[] = [];
    const FrameProbe = ({ deltas }: { deltas: number[] }) => {
      useFrame((_state, delta) => { deltas.push(delta); });
      return null;
    };
    const scene = (withScope: boolean) => (
      <>
        <PreviewClockDriver clock={clock} />
        {withScope && <PreviewTimeScope clock={clock}><FrameProbe deltas={scoped} /></PreviewTimeScope>}
        <FrameProbe deltas={real} />
      </>
    );
    // One R3F frame: every subscriber in priority order with the real delta, as R3F's loop does.
    const frame = (delta: number) => {
      const root3 = _roots.get(canvas);
      if (!root3) throw new Error('no R3F root');
      for (const subscription of root3.store.getState().internal.subscribers) {
        subscription.ref.current(subscription.store.getState(), delta);
      }
    };

    await act(async () => { root.render(scene(true)); });
    clock.rate = 0.5;
    frame(0.1);
    // The clock driver runs first, so a rate change applies to the very next frame.
    clock.rate = 2;
    frame(0.1);
    clock.paused = true;
    frame(0.1);
    clock.pendingStep = PREVIEW_STEP_SECONDS;
    frame(0.1);
    expect(scoped).toHaveLength(4);
    expect(scoped[0]).toBeCloseTo(0.05);
    expect(scoped[1]).toBeCloseTo(0.2);
    expect(scoped[2]).toBe(0);
    expect(scoped[3]).toBeCloseTo(PREVIEW_STEP_SECONDS);
    expect(real).toEqual([0.1, 0.1, 0.1, 0.1]);

    // Leaving the scope unsubscribes what ran inside it.
    await act(async () => { root.render(scene(false)); });
    frame(0.1);
    expect(scoped).toHaveLength(4);
    expect(real).toHaveLength(5);
    await act(async () => { root.unmount(); });
  });

  it('restart starts a new run that reports the entry state again', () => {
    harness.scene = sceneWith();
    const reported: string[] = [];
    render(<GraphPreview graph={makeGraph()} model={makeModel([idleClip])} allClips={[idleClip]} controls onActiveStateChange={id => reported.push(id)} />);

    const first = previewSession();
    act(() => first.props.onStart());
    act(() => first.props.onActiveStateChange('run'));
    expect(reported).toEqual(['idle', 'run']);

    fireEvent.click(screen.getByRole('button', { name: 'Restart preview' }));
    const second = previewSession();
    expect(second.key).not.toBe(first.key);
    act(() => second.props.onStart());
    expect(reported).toEqual(['idle', 'run', 'idle']);
  });

  it('puts the preview model back where it was cloned, leaving the source alone', () => {
    const model = makeModel([idleClip]);
    model.object.position.set(1, 0, 2);
    const resources = clonePreviewResources(model.object);
    const clone = resources.object;
    const hips = clone.getObjectByName('Hips');
    if (!hips) throw new Error('clone lost its bone');

    clone.translateZ(5);
    clone.rotation.y = 1;
    clone.scale.setScalar(3);
    hips.position.set(0, 2, 0);
    hips.rotation.x = 0.5;
    expect(model.object.position.toArray()).toEqual([1, 0, 2]);

    restorePreviewPose(resources);
    expect(clone.position.toArray()).toEqual([1, 0, 2]);
    expect(clone.quaternion.equals(new THREE.Quaternion())).toBe(true);
    expect(hips.position.toArray()).toEqual([0, 0, 0]);
    expect(hips.quaternion.equals(new THREE.Quaternion())).toBe(true);
    // The root's scale belongs to the preview's scale prop.
    expect(clone.scale.toArray()).toEqual([3, 3, 3]);
  });
});

describe('live active state', () => {
  it('finds the transition the runtime took', () => {
    const anyToIdle: GraphTransition = { id: 't-any', fromStateId: 'run', toStateId: 'idle', duration: 0.1, conditions: [], anyState: true, exitTime: 1 };
    expect(findFiredTransition([toRun, toIdle], 'idle', 'run')).toBe(toRun);
    expect(findFiredTransition([toRun], 'run', 'idle')).toBeNull();
    expect(findFiredTransition([toRun, anyToIdle], 'jump', 'idle')).toBe(anyToIdle);
    // With two candidates, the one whose conditions pass wins over list order.
    expect(findFiredTransition([anyToIdle, toIdle], 'run', 'idle', { 'v-speed': 0 })).toBe(anyToIdle);
    const strictIdle: GraphTransition = { ...toIdle, id: 't-strict', conditions: [{ variableId: 'v-speed', operator: '<', value: -1 }] };
    expect(findFiredTransition([strictIdle, toIdle], 'run', 'idle', { 'v-speed': 0 })).toBe(toIdle);
    expect(entryStateId(makeGraph())).toBe('idle');
  });

  it('highlights the state the runtime reports, not the persisted activeStateId, and flashes the fired transition', () => {
    vi.useFakeTimers();
    const graph = makeGraph();
    const props = {
      graph,
      modelId: 'm1',
      updateGraph: vi.fn(),
      selectedNodeId: null,
      onSelectNode: vi.fn(),
      availableClips: [],
    };
    const { rerender } = render(<GraphCanvas {...props} />);
    expect(nodeElement('Run')).not.toHaveAttribute('data-active');
    expect(nodeElement('Idle')).not.toHaveAttribute('data-active');

    rerender(<GraphCanvas {...props} activeStateId="idle" />);
    expect(nodeElement('Idle')).toHaveAttribute('data-active', 'true');
    expect(nodeElement('Run')).not.toHaveAttribute('data-active');

    const fired: FiredTransition = { id: 't-run', seq: 1 };
    rerender(<GraphCanvas {...props} activeStateId="run" firedTransition={fired} />);
    expect(nodeElement('Run')).toHaveAttribute('data-active', 'true');
    expect(firedPath()).toHaveAttribute('data-fired-transition', 't-run');

    act(() => { vi.advanceTimersByTime(FIRED_TRANSITION_HIGHLIGHT_MS); });
    expect(firedPath()).toBeNull();
    expect(nodeElement('Run')).toHaveAttribute('data-active', 'true');
  });

  it('follows the preview runtime in the editor: entry state, transitions and live variables', () => {
    vi.useFakeTimers();
    const graph = makeGraph();
    const model = makeModel([idleClip]);
    harness.scene = sceneWith([model]);
    const context: GraphContextState = {
      contextType: 'model',
      setContextType: vi.fn(),
      selectedContextId: 'm1',
      setSelectedContextId: vi.fn(),
      currentGraph: graph,
      previewModel: model,
      handleUpdateGraph: vi.fn(),
      allSceneClips: [{ name: 'Breathe', source: 'Hero', clip: idleClip }],
      contextOptions: [{ label: 'Hero', value: 'm1' }],
    };
    harness.context = context;
    render(<GraphEditor visible={true} />);

    expect(screen.getByRole('status')).toHaveTextContent('Live');
    expect(nodeElement('Run')).not.toHaveAttribute('data-active');

    // The runtime publishes its API and starts in the entry state.
    const runtime = fakeRuntime({ 'v-speed': 0, 'v-grounded': true });
    const session = previewSession();
    session.props.apiRef.current = runtime.api;
    act(() => session.props.onStart());
    expect(nodeElement('Idle')).toHaveAttribute('data-active', 'true');

    // Speed goes up and the state machine takes Idle -> Run.
    runtime.values['v-speed'] = 0.75;
    act(() => session.props.onActiveStateChange('run'));
    expect(nodeElement('Run')).toHaveAttribute('data-active', 'true');
    expect(nodeElement('Idle')).not.toHaveAttribute('data-active');
    expect(firedPath()).toHaveAttribute('data-fired-transition', 't-run');

    // The blackboard watches the runtime's values next to the initial ones.
    act(() => { vi.advanceTimersByTime(LIVE_VARIABLE_POLL_MS); });
    expect(screen.getByRole('spinbutton', { name: 'Initial value of Speed' })).toHaveValue(0);
    expect(screen.getByRole('spinbutton', { name: 'Live value of Speed' })).toHaveValue(0.75);
    expect(screen.getByRole('checkbox', { name: 'Live value of Grounded' })).toBeChecked();

    act(() => { vi.advanceTimersByTime(FIRED_TRANSITION_HIGHLIGHT_MS); });
    expect(firedPath()).toBeNull();
  });
});

describe('live variable watch', () => {
  const renderWatch = (live: boolean) => {
    const runtime = fakeRuntime({ 'v-speed': 0.5, 'v-grounded': false });
    const apiRef: MutableRefObject<GraphRuntimeAPI | undefined> = { current: runtime.api };
    render(<BlackboardVariables graph={makeGraph()} modelId="m1" updateGraph={vi.fn()} runtime={apiRef} live={live} />);
    return runtime;
  };

  it('shows the runtime value beside the initial value and keeps it current', () => {
    vi.useFakeTimers();
    const runtime = renderWatch(true);

    expect(screen.getByRole('spinbutton', { name: 'Initial value of Speed' })).toHaveValue(0);
    expect(screen.getByRole('spinbutton', { name: 'Live value of Speed' })).toHaveValue(0.5);
    expect(screen.getByRole('checkbox', { name: 'Initial value of Grounded' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Live value of Grounded' })).not.toBeChecked();

    runtime.values['v-speed'] = 1.25;
    act(() => { vi.advanceTimersByTime(LIVE_VARIABLE_POLL_MS); });
    expect(screen.getByRole('spinbutton', { name: 'Live value of Speed' })).toHaveValue(1.25);
  });

  it('pokes values into the running preview', () => {
    vi.useFakeTimers();
    const runtime = renderWatch(true);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Live value of Grounded' }));
    expect(runtime.setVariable).toHaveBeenCalledWith('v-grounded', true);
    expect(screen.getByRole('checkbox', { name: 'Live value of Grounded' })).toBeChecked();

    const speed = screen.getByRole('spinbutton', { name: 'Live value of Speed' });
    fireEvent.focus(speed);
    fireEvent.change(speed, { target: { value: '2' } });
    // A poll while typing leaves the draft alone.
    runtime.values['v-speed'] = 0.9;
    act(() => { vi.advanceTimersByTime(LIVE_VARIABLE_POLL_MS); });
    expect(speed).toHaveValue(2);
    expect(runtime.setVariable).not.toHaveBeenCalledWith('v-speed', expect.anything());

    fireEvent.blur(speed);
    expect(runtime.setVariable).toHaveBeenCalledWith('v-speed', 2);
    expect(speed).toHaveValue(2);

    // Escape drops the edit.
    fireEvent.focus(speed);
    fireEvent.change(speed, { target: { value: '7' } });
    fireEvent.keyDown(speed, { key: 'Escape' });
    fireEvent.blur(speed);
    expect(runtime.setVariable).not.toHaveBeenCalledWith('v-speed', 7);
  });

  it('shows only initial values while no preview runs', () => {
    renderWatch(false);
    expect(screen.getByRole('spinbutton', { name: 'Initial value of Speed' })).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Live value of Speed' })).not.toBeInTheDocument();
    expect(screen.queryByText('Watching')).not.toBeInTheDocument();
  });
});
