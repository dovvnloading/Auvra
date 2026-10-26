import type { LogicNode, LogicPin } from '../../types';

/**
 * FLOW CONTROL NODES
 *
 * Pure executors for the Level Blueprint's flow-control nodes (Sequence, For Loop, Delay,
 * Do Once, Flip Flop, Gate). They hold no graph or clock of their own: the runtime hands each
 * one a context that evaluates data inputs, fires exec outputs, schedules timed continuations
 * and keeps the node's per-session state, so the same executor runs in play and in tests.
 */

export type FlowNodeType = 'Sequence' | 'ForLoop' | 'Delay' | 'DoOnce' | 'FlipFlop' | 'Gate';

/** The parts of a graph node an executor reads. A LogicNode satisfies it. */
export type FlowNode = Pick<LogicNode, 'id' | 'inputs' | 'outputs' | 'data'> & { type: string };

/** A pin as the editor palette declares it; the editor assigns the id when it places the node. */
export type FlowPinDefinition = Pick<LogicPin, 'name' | 'dataType' | 'direction'>;

export interface FlowNodeDefinition {
    type: FlowNodeType;
    title: string;
    inputs: FlowPinDefinition[];
    outputs: FlowPinDefinition[];
    /** Initial node.data, including `default_<pin name>` values for unconnected data inputs. */
    data?: Record<string, unknown>;
}

export interface FlowExecutionContext {
    /** Value of the named data input: its connection when wired, else the node's `default_<pin>` value. */
    evaluate(pinName: string): any;
    /**
     * Runs the chain wired to the named exec output before returning. `data` carries this node's
     * data outputs by pin name (e.g. ForLoop `Index`) for nodes evaluated during that chain.
     */
    fire(pinName: string, data?: Record<string, unknown>): void;
    /** Runs `fn` once after `seconds` of play time. The runtime drops it if the session ends first. */
    schedule(seconds: number, fn: () => void): void;
    /** State kept for this node for the rest of the play session. Starts empty. */
    nodeState: Record<string, unknown>;
    /** Name of the exec input that triggered this run. Omitted means the node's main input. */
    entryPin?: string;
}

export type FlowNodeExecutor = (node: FlowNode, ctx: FlowExecutionContext) => void;

/** Upper bound on one ForLoop run, so a huge or runaway index range cannot hang the frame. */
export const MAX_FOR_LOOP_ITERATIONS = 10000;

const exec = (name: string, direction: LogicPin['direction']): FlowPinDefinition =>
    ({ name, dataType: 'Exec', direction });

/** The `Then <index>` exec output a Sequence node fires in pin order. */
export const sequenceThenPin = (index: number): FlowPinDefinition => exec(`Then ${index}`, 'Output');

export const FLOW_NODE_DEFINITIONS: readonly FlowNodeDefinition[] = [
    {
        type: 'Sequence',
        title: 'Sequence',
        inputs: [exec('Exec', 'Input')],
        outputs: [sequenceThenPin(0), sequenceThenPin(1)],
    },
    {
        type: 'ForLoop',
        title: 'For Loop',
        inputs: [
            exec('Exec', 'Input'),
            { name: 'First Index', dataType: 'Integer', direction: 'Input' },
            { name: 'Last Index', dataType: 'Integer', direction: 'Input' },
        ],
        outputs: [
            exec('Loop Body', 'Output'),
            { name: 'Index', dataType: 'Integer', direction: 'Output' },
            exec('Completed', 'Output'),
        ],
        data: { 'default_First Index': 0, 'default_Last Index': 0 },
    },
    {
        type: 'Delay',
        title: 'Delay',
        inputs: [exec('Exec', 'Input'), { name: 'Duration', dataType: 'Float', direction: 'Input' }],
        outputs: [exec('Out', 'Output')],
        data: { default_Duration: 1 },
    },
    {
        type: 'DoOnce',
        title: 'Do Once',
        inputs: [
            exec('Exec', 'Input'),
            exec('Reset', 'Input'),
            { name: 'Start Closed', dataType: 'Boolean', direction: 'Input' },
        ],
        outputs: [exec('Completed', 'Output')],
        data: { 'default_Start Closed': false },
    },
    {
        type: 'FlipFlop',
        title: 'Flip Flop',
        inputs: [exec('Exec', 'Input')],
        outputs: [
            exec('A', 'Output'),
            exec('B', 'Output'),
            { name: 'Is A', dataType: 'Boolean', direction: 'Output' },
        ],
    },
    {
        type: 'Gate',
        title: 'Gate',
        inputs: [
            exec('Enter', 'Input'),
            exec('Open', 'Input'),
            exec('Close', 'Input'),
            exec('Toggle', 'Input'),
            { name: 'Start Closed', dataType: 'Boolean', direction: 'Input' },
        ],
        outputs: [exec('Exit', 'Output')],
        data: { 'default_Start Closed': false },
    },
];

export const isFlowNodeType = (type: string): type is FlowNodeType =>
    FLOW_NODE_DEFINITIONS.some(definition => definition.type === type);

/** Integer input, truncated toward zero; blank or non-numeric values give `fallback`. */
const toInteger = (value: unknown, fallback: number): number => {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : fallback;
};

const toSeconds = (value: unknown): number => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
};

/** Latches a data output so reads after the fired chain still see it (UE keeps ForLoop's last Index). */
const publish = (ctx: FlowExecutionContext, outputs: Record<string, unknown>) => {
    ctx.nodeState.outputs = { ...(ctx.nodeState.outputs as Record<string, unknown> | undefined), ...outputs };
};

/** Last value a flow node published on a data output (ForLoop `Index`, FlipFlop `Is A`), or null. */
export const flowNodeOutputValue = (nodeState: Record<string, unknown> | undefined, pinName: string): unknown =>
    (nodeState?.outputs as Record<string, unknown> | undefined)?.[pinName] ?? null;

/** Open/closed state shared by DoOnce and Gate; `Start Closed` is read on first use only. */
const isOpen = (ctx: FlowExecutionContext): boolean => {
    if (typeof ctx.nodeState.open !== 'boolean') ctx.nodeState.open = !ctx.evaluate('Start Closed');
    return ctx.nodeState.open as boolean;
};

const runSequence: FlowNodeExecutor = (node, ctx) => {
    node.outputs
        .filter(pin => pin.dataType === 'Exec')
        .forEach(pin => ctx.fire(pin.name));
};

const runForLoop: FlowNodeExecutor = (_node, ctx) => {
    const first = toInteger(ctx.evaluate('First Index'), 0);
    const last = toInteger(ctx.evaluate('Last Index'), 0);
    // Counting iterations (not incrementing the index) stays bounded even where index + 1 === index.
    const count = Math.min(last - first + 1, MAX_FOR_LOOP_ITERATIONS);
    for (let step = 0; step < count; step++) {
        const index = first + step;
        publish(ctx, { Index: index });
        ctx.fire('Loop Body', { Index: index });
    }
    ctx.fire('Completed');
};

// Like UE's Delay (not Retriggerable Delay): entering while a delay is pending does nothing.
const runDelay: FlowNodeExecutor = (_node, ctx) => {
    if (ctx.nodeState.pending === true) return;
    ctx.nodeState.pending = true;
    ctx.schedule(toSeconds(ctx.evaluate('Duration')), () => {
        ctx.nodeState.pending = false;
        ctx.fire('Out');
    });
};

const runDoOnce: FlowNodeExecutor = (_node, ctx) => {
    if (ctx.entryPin === 'Reset') {
        ctx.nodeState.open = true;
        return;
    }
    if (!isOpen(ctx)) return;
    ctx.nodeState.open = false;
    ctx.fire('Completed');
};

const runFlipFlop: FlowNodeExecutor = (_node, ctx) => {
    const isA = ctx.nodeState.isA !== true;
    ctx.nodeState.isA = isA;
    publish(ctx, { 'Is A': isA });
    ctx.fire(isA ? 'A' : 'B', { 'Is A': isA });
};

const runGate: FlowNodeExecutor = (_node, ctx) => {
    const open = isOpen(ctx);
    switch (ctx.entryPin) {
        case 'Open': ctx.nodeState.open = true; return;
        case 'Close': ctx.nodeState.open = false; return;
        case 'Toggle': ctx.nodeState.open = !open; return;
        default: if (open) ctx.fire('Exit');
    }
};

const executors = {
    Sequence: runSequence,
    ForLoop: runForLoop,
    Delay: runDelay,
    DoOnce: runDoOnce,
    FlipFlop: runFlipFlop,
    Gate: runGate,
} satisfies Record<FlowNodeType, FlowNodeExecutor>;

/** Executor per flow node type; look up by `node.type` and treat a miss as "not a flow node". */
export const FLOW_NODE_EXECUTORS: Readonly<Record<string, FlowNodeExecutor | undefined>> = executors;
