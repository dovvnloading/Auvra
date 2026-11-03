
import React, { useId, useState } from 'react';
import { GitCommit, ArrowRight, ToggleLeft, Plus, Trash2 } from 'lucide-react';
import { GraphTransition, GraphCondition, GraphVariable, AnimationGraphData, ConditionOperator } from '../../../types';
import { Select } from '../../UI/Select';

const OPERATORS: ConditionOperator[] = ['>', '<', '==', '!=', '>=', '<='];
// Ordered comparisons never pass against a boolean variable, so only equality is offered for one.
const BOOLEAN_OPERATORS: ConditionOperator[] = ['==', '!='];
const MATCH_OPTIONS = [
    { label: 'All', value: 'all' },
    { label: 'Any', value: 'any' },
];

const LABEL_CLASS = 'text-2xs text-gray-500 font-bold flex items-center gap-1.5';
const FIELD_CLASS = 'w-full bg-gray-900 border border-gray-700 rounded text-xs text-gray-200 p-2 focus:outline-none focus:border-gray-500';

const defaultConditionValue = (variable: GraphVariable | undefined): number | boolean =>
    variable?.type === 'Boolean' ? true : 1;

type NumberFieldProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
    value: number | undefined;
    /** Called with each finite number typed, or null when the field is cleared; never with NaN. */
    onValue: (value: number | null) => void;
};

/**
 * Number input that keeps the typed text while it has focus (so it can be cleared and retyped)
 * and shows the stored value again on blur.
 */
const NumberField: React.FC<NumberFieldProps> = ({ value, onValue, onBlur, ...rest }) => {
    const [draft, setDraft] = useState<string | null>(null);
    return (
        <input
            {...rest}
            type="number"
            value={draft ?? (value === undefined ? '' : String(value))}
            onChange={(e) => {
                const raw = e.target.value;
                setDraft(raw);
                if (raw.trim() === '') {
                    // Partial input such as "-" also reads as empty; only a really empty field reports null.
                    if (!e.target.validity.badInput) onValue(null);
                    return;
                }
                const parsed = parseFloat(raw);
                if (Number.isFinite(parsed)) onValue(parsed);
            }}
            onBlur={(e) => {
                setDraft(null);
                onBlur?.(e);
            }}
        />
    );
};

interface TransitionInspectorProps {
    transition: GraphTransition;
    graph: AnimationGraphData;
    updateTransition: (updates: Partial<GraphTransition>) => void;
    onDelete: (id: string) => void;
}

export const TransitionInspector: React.FC<TransitionInspectorProps> = ({
    transition,
    graph,
    updateTransition,
    onDelete
}) => {
    const fieldId = useId();
    const fromState = graph.states.find(s => s.id === transition.fromStateId);
    const toState = graph.states.find(s => s.id === transition.toStateId);

    const variableOptions = graph.variables.map(v => ({ label: v.name, value: v.id }));
    const operatorOptions = OPERATORS.map(op => ({ label: op, value: op }));
    const booleanOperatorOptions = BOOLEAN_OPERATORS.map(op => ({ label: op, value: op }));

    const updateCondition = (index: number, updates: Partial<GraphCondition>) => {
        updateTransition({ conditions: transition.conditions.map((c, i) => i === index ? { ...c, ...updates } : c) });
    };

    return (
        <div className="flex flex-col h-full bg-gray-900">
            {/* Context Header */}
            <div className="p-4 border-b border-gray-800 bg-gray-800/30 shrink-0">
                <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded bg-gray-900 border border-gray-700 flex items-center justify-center shrink-0">
                         <GitCommit size={20} className="text-gray-400" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-bold text-white truncate">Transition</h3>
                        <div className="flex items-center gap-2 mt-1 text-2xs text-gray-400">
                            <span className="truncate max-w-[60px]">{transition.anyState ? 'Any State' : fromState?.name}</span>
                            <ArrowRight size={10} />
                            <span className="truncate max-w-[60px]">{toState?.name}</span>
                        </div>
                    </div>
                </div>
            </div>

            <div className="p-4 space-y-6 overflow-y-auto custom-scrollbar flex-1">
                 <div className="space-y-1.5">
                    <label htmlFor={`${fieldId}-duration`} className={LABEL_CLASS}>
                        <ToggleLeft size={10} /> Blend Duration (s)
                    </label>
                    <NumberField
                        id={`${fieldId}-duration`}
                        step="0.1" min="0"
                        value={transition.duration}
                        onValue={(value) => {
                            // An emptied field keeps the current duration.
                            if (value !== null) updateTransition({ duration: Math.max(0, value) });
                        }}
                        className={FIELD_CLASS}
                    />
                </div>

                <div className="space-y-1.5">
                    <label htmlFor={`${fieldId}-exit-time`} className={LABEL_CLASS}>
                        <ToggleLeft size={10} /> Exit Time (0-1, empty = none)
                    </label>
                    <NumberField
                        id={`${fieldId}-exit-time`}
                        step="0.05" min="0" max="1"
                        value={transition.exitTime}
                        placeholder="none"
                        onValue={(value) => updateTransition({ exitTime: value === null ? undefined : Math.min(1, Math.max(0, value)) })}
                        className={FIELD_CLASS}
                    />
                    <p className="text-2xs text-gray-600">Fires once the source clip reaches this point. With no conditions, the state returns on its own (e.g. attack back to idle).</p>
                </div>

                <div className="space-y-1.5">
                    <label className="flex items-center justify-between group cursor-pointer p-2 bg-gray-900/50 rounded border border-gray-800 hover:border-gray-600 transition-colors">
                        <span className="text-xs text-gray-400 font-medium">From any state</span>
                        <div className={`w-8 h-4 rounded-full relative transition-colors ${transition.anyState ? 'bg-gray-200' : 'bg-gray-700'}`}>
                             <div className="absolute top-0.5 w-3 h-3 bg-gray-900 rounded-full transition-all" style={{ left: transition.anyState ? 'calc(100% - 14px)' : '2px' }}></div>
                        </div>
                        <input
                            type="checkbox"
                            checked={transition.anyState === true}
                            onChange={(e) => updateTransition({ anyState: e.target.checked ? true : undefined })}
                            className="sr-only"
                        />
                    </label>
                    <p className="text-2xs text-gray-600">Checked from every state except its target; the source state is ignored.</p>
                </div>

                <div className="space-y-1.5">
                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                            <span className={LABEL_CLASS}>Match</span>
                            <Select
                                value={transition.conditionMode ?? 'all'}
                                onChange={(val) => updateTransition({ conditionMode: val === 'any' ? 'any' : undefined })}
                                options={MATCH_OPTIONS}
                                placeholder="Match"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <label htmlFor={`${fieldId}-priority`} className={LABEL_CLASS}>Priority</label>
                            <NumberField
                                id={`${fieldId}-priority`}
                                step="1"
                                value={transition.priority ?? 0}
                                onValue={(value) => {
                                    if (value !== null) updateTransition({ priority: value === 0 ? undefined : value });
                                }}
                                className={FIELD_CLASS}
                            />
                        </div>
                    </div>
                    <p className="text-2xs text-gray-600">Match: whether every condition or any one must hold. Priority: the highest ready transition wins; ties go to the earlier one.</p>
                </div>

                <div className="space-y-3">
                     <div className="flex items-center justify-between px-1">
                        <label className="text-2xs text-gray-500 font-bold ">Conditions</label>
                        <button
                            onClick={() => {
                                if (graph.variables.length === 0) return;
                                const variable = graph.variables[0];
                                const newCond: GraphCondition = { variableId: variable.id, operator: '==', value: defaultConditionValue(variable) };
                                updateTransition({ conditions: [...transition.conditions, newCond] });
                            }}
                            className="text-2xs px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded border border-gray-700 text-gray-300 hover:text-white transition-colors flex items-center gap-1"
                        >
                            <Plus size={10} /> Add
                        </button>
                     </div>

                     <div className="space-y-2">
                         {transition.conditions.map((cond, idx) => {
                             const variable = graph.variables.find(v => v.id === cond.variableId);
                             const isBoolean = variable?.type === 'Boolean';
                             return (
                                 <div key={idx} className="bg-gray-800 rounded-lg border border-gray-700 p-2 flex items-center gap-2">
                                     {/* Variable Select */}
                                     <Select
                                        value={cond.variableId}
                                        onChange={(val) => {
                                            const next = graph.variables.find(v => v.id === val);
                                            const nextIsBoolean = next?.type === 'Boolean';
                                            updateCondition(idx, {
                                                variableId: val,
                                                // Switching between a boolean and a number variable resets what no longer fits.
                                                operator: nextIsBoolean && !BOOLEAN_OPERATORS.includes(cond.operator) ? '==' : cond.operator,
                                                value: (typeof cond.value === 'boolean') === nextIsBoolean ? cond.value : defaultConditionValue(next),
                                            });
                                        }}
                                        options={variableOptions}
                                        className="w-24"
                                    />

                                     {/* Operator */}
                                     <Select
                                        value={cond.operator}
                                        onChange={(val) => updateCondition(idx, { operator: val as ConditionOperator })}
                                        options={isBoolean ? booleanOperatorOptions : operatorOptions}
                                        className="w-16"
                                     />

                                     {/* Value */}
                                     {isBoolean ? (
                                         <input
                                            type="checkbox"
                                            aria-label="Condition value"
                                            checked={cond.value === true}
                                            onChange={(e) => updateCondition(idx, { value: e.target.checked })}
                                            className="cursor-pointer ml-2"
                                         />
                                     ) : (
                                         <NumberField
                                            aria-label="Condition value"
                                            value={typeof cond.value === 'number' ? cond.value : undefined}
                                            onValue={(value) => {
                                                if (value !== null) updateCondition(idx, { value });
                                            }}
                                            className="bg-gray-900 border border-gray-600 rounded text-2xs text-gray-200 w-16 px-1.5 py-1 focus:outline-none"
                                         />
                                     )}

                                     <button
                                        onClick={() => {
                                            const newConds = transition.conditions.filter((_, i) => i !== idx);
                                            updateTransition({ conditions: newConds });
                                        }}
                                        className="ml-auto text-gray-500 hover:text-red-400 p-1"
                                    >
                                        <Trash2 size={12} />
                                    </button>
                                 </div>
                             );
                         })}
                         {transition.conditions.length === 0 && (
                            <div className="text-center py-4 border border-dashed border-gray-800 rounded bg-gray-900/50">
                                <p className="text-2xs text-gray-600 italic">
                                    {typeof transition.exitTime === 'number'
                                        ? 'No conditions: fires when the clip reaches its exit time'
                                        : 'No conditions: add a condition or an exit time, or this transition never fires'}
                                </p>
                            </div>
                         )}
                     </div>
                </div>

                <div className="pt-4 border-t border-gray-800 mt-auto">
                    <button
                        onClick={() => onDelete(transition.id)}
                        className="w-full py-2.5 rounded text-xs font-bold border border-gray-700 hover:border-red-900/50 bg-gray-900 hover:bg-red-950/50 text-gray-400 hover:text-red-400 transition-all flex items-center justify-center gap-2"
                    >
                        <Trash2 size={14} /> Delete Transition
                    </button>
                </div>
            </div>
        </div>
    );
};
