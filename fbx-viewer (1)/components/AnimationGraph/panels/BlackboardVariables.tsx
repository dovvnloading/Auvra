import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2, Database } from 'lucide-react';
import { AnimationGraphData, GraphVariable } from '../../../types';
import type { GraphRuntimeAPI } from '../GraphRuntime';

/** How often the live watch reads the preview runtime's variables. */
export const LIVE_VARIABLE_POLL_MS = 250;

type VariableValues = Record<string, number | boolean>;

const sameValues = (a: VariableValues | null, b: VariableValues | null): boolean => {
    if (a === b) return true;
    if (!a || !b) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.is(a[key], b[key]));
};

/**
 * The preview runtime's variable values keyed by variable id, read every LIVE_VARIABLE_POLL_MS
 * while `active` (React state only changes when a value does), and `poke`, which writes one
 * value into the running preview. `values` is null while there is no runtime to read.
 */
export const useLiveVariables = (
    runtime: React.MutableRefObject<GraphRuntimeAPI | undefined> | undefined,
    active: boolean
) => {
    const [values, setValues] = useState<VariableValues | null>(null);

    useEffect(() => {
        if (!runtime || !active) {
            setValues(null);
            return;
        }
        const read = () => {
            const next = runtime.current ? runtime.current.getVariables() : null;
            setValues(previous => (sameValues(previous, next) ? previous : next));
        };
        read();
        const timer = window.setInterval(read, LIVE_VARIABLE_POLL_MS);
        return () => window.clearInterval(timer);
    }, [runtime, active]);

    const poke = useCallback((variableId: string, value: number | boolean) => {
        const api = runtime?.current;
        if (!api) return;
        api.setVariable(variableId, value);
        setValues(previous => (previous ? { ...previous, [variableId]: value } : previous));
    }, [runtime]);

    return { values, poke };
};

const formatLiveNumber = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(3));

interface LiveValueRowProps {
    variable: GraphVariable;
    value: number | boolean | undefined;
    onPoke: (value: number | boolean) => void;
}

/** One variable's value in the running preview; editing it writes straight into the runtime. */
const LiveValueRow: React.FC<LiveValueRowProps> = ({ variable, value, onPoke }) => {
    // While the field is being edited the poll must not overwrite what the user is typing.
    const [draft, setDraft] = useState<string | null>(null);
    const focusTextRef = useRef('');
    const cancelRef = useRef(false);
    const label = `Live value of ${variable.name}`;
    const changed = value !== undefined && value !== variable.value;

    const commit = () => {
        const text = draft;
        setDraft(null);
        if (cancelRef.current) {
            cancelRef.current = false;
            return;
        }
        // Focusing and leaving without an edit must not write back the rounded display value.
        if (text === null || text === focusTextRef.current) return;
        const parsed = parseFloat(text);
        if (Number.isFinite(parsed)) onPoke(parsed);
    };

    let field: React.ReactNode;
    if (value === undefined) {
        field = <span className="font-mono text-gray-600" aria-label={label}>-</span>;
    } else if (variable.type === 'Boolean') {
        field = (
            <input
                type="checkbox"
                checked={value === true}
                onChange={(e) => onPoke(e.target.checked)}
                className="cursor-pointer"
                aria-label={label}
            />
        );
    } else {
        field = (
            <input
                type="number"
                step="0.1"
                value={draft ?? (typeof value === 'number' ? formatLiveNumber(value) : String(value))}
                onFocus={(e) => {
                    focusTextRef.current = e.target.value;
                    setDraft(e.target.value);
                }}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') {
                        cancelRef.current = true;
                        e.currentTarget.blur();
                    }
                }}
                className="bg-transparent text-right font-mono w-16 focus:outline-none focus:text-white focus:border-b border-gray-600"
                aria-label={label}
                title="Writes into the running preview (Enter to apply, Escape to cancel)"
            />
        );
    }

    return (
        <div className={`flex items-center justify-between text-2xs px-2 py-1 rounded border ${changed ? 'bg-green-950/30 border-green-900/60 text-green-300' : 'bg-gray-900 border-gray-800 text-gray-500'}`}>
            <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>
                Live Value
            </span>
            {field}
        </div>
    );
};

interface BlackboardVariablesProps {
    graph: AnimationGraphData;
    modelId: string;
    updateGraph: (modelId: string, data: Partial<AnimationGraphData>) => void;
    /** The preview's runtime API; its values are shown beside the initial values while `live`. */
    runtime?: React.MutableRefObject<GraphRuntimeAPI | undefined>;
    /** The preview is running, so live values are watched. */
    live?: boolean;
}

export const BlackboardVariables: React.FC<BlackboardVariablesProps> = ({ graph, modelId, updateGraph, runtime, live = false }) => {
    const { values: liveValues, poke } = useLiveVariables(runtime, live);

    const addVariable = (type: 'Float' | 'Boolean') => {
        const newVar: GraphVariable = {
            id: crypto.randomUUID(),
            name: `New${type}`,
            type,
            value: type === 'Float' ? 0 : false
        };
        updateGraph(modelId, { variables: [...graph.variables, newVar] });
    };

    return (
        <div>
            <div className="flex items-center justify-between mb-2 pb-1 border-b border-gray-800">
                <span className="text-xs font-bold text-gray-200 flex items-center gap-2">
                    <Database size={12} className="text-gray-400" /> Graph Variables
                    {liveValues && (
                        <span className="px-1.5 py-0.5 rounded bg-green-950/50 border border-green-900/60 text-2xs font-bold text-green-400" title="Live values from the running preview">
                            Watching
                        </span>
                    )}
                </span>
                <div className="flex gap-1">
                    <button onClick={() => addVariable('Float')} className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded border border-gray-700 text-2xs text-gray-400 hover:text-white transition-colors">
                    + Float
                    </button>
                    <button onClick={() => addVariable('Boolean')} className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded border border-gray-700 text-2xs text-gray-400 hover:text-white transition-colors">
                    + Bool
                    </button>
                </div>
            </div>
            <div className="space-y-2">
                {graph.variables.length === 0 && (
                    <div className="text-center py-4 border border-dashed border-gray-800 rounded bg-gray-900/50">
                        <p className="text-2xs text-gray-600">No variables defined.</p>
                    </div>
                )}
                {graph.variables.map(v => (
                <div key={v.id} className="bg-gray-800 px-2 py-2 rounded border border-gray-700 flex flex-col gap-1 hover:border-gray-600 transition-colors">
                    <div className="flex justify-between items-center">
                        <input 
                            value={v.name} 
                            onChange={(e) => {
                                const updated = graph.variables.map(x => x.id === v.id ? { ...x, name: e.target.value } : x);
                                updateGraph(modelId, { variables: updated });
                            }}
                            className="bg-transparent text-xs font-mono text-gray-200 w-24 focus:outline-none focus:border-b border-gray-600 placeholder-gray-600"
                        />
                        <span className="text-2xs text-gray-500 font-bold ">{v.type}</span>
                        <button onClick={() => updateGraph(modelId, { variables: graph.variables.filter(x => x.id !== v.id) })} className="text-gray-600 hover:text-gray-400">
                            <Trash2 size={10} />
                        </button>
                    </div>
                    <div className="flex items-center justify-between text-2xs text-gray-500 bg-gray-900 px-2 py-1 rounded border border-gray-800">
                        <span>Initial Value</span>
                        {v.type === 'Boolean' ? (
                            <input 
                                type="checkbox"
                                checked={v.value as boolean}
                                onChange={(e) => {
                                    const updated = graph.variables.map(x => x.id === v.id ? { ...x, value: e.target.checked } : x);
                                    updateGraph(modelId, { variables: updated });
                                }}
                                className="cursor-pointer"
                                aria-label={`Initial value of ${v.name}`}
                            />
                        ) : (
                            <input 
                                type="number"
                                step="0.1"
                                value={v.value as number}
                                onChange={(e) => {
                                    const val = parseFloat(e.target.value);
                                    if (!isNaN(val)) {
                                        const updated = graph.variables.map(x => x.id === v.id ? { ...x, value: val } : x);
                                        updateGraph(modelId, { variables: updated });
                                    }
                                }}
                                className="bg-transparent text-right font-mono text-gray-300 w-16 focus:outline-none focus:text-white focus:border-b border-gray-600"
                                aria-label={`Initial value of ${v.name}`}
                            />
                        )}
                    </div>
                    {liveValues && (
                        <LiveValueRow variable={v} value={liveValues[v.id]} onPoke={(value) => poke(v.id, value)} />
                    )}
                </div>
                ))}
            </div>
        </div>
    );
};
