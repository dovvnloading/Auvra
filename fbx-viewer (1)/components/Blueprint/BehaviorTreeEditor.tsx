import React, { useMemo, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Brain, Plus, Trash2 } from 'lucide-react';
import type { BehaviorAction, BehaviorCondition, BehaviorNode, BehaviorNodeType, BehaviorTreeData } from '../../types';
import { behaviorTreeProblems, defaultBehaviorTree, gunnerBehaviorTree } from '../../runtime/behaviorTree';

/** What each node type is called and whether it takes children (and how many). */
export const NODE_TYPES: Record<BehaviorNodeType, { label: string; hint: string; children: 'many' | 'one' | 'none' }> = {
    selector: { label: 'Selector', hint: 'Tries each child in order; succeeds with the first that does not fail', children: 'many' },
    sequence: { label: 'Sequence', hint: 'Runs each child in order; stops at the first that does not succeed', children: 'many' },
    inverter: { label: 'Inverter', hint: 'Swaps its child\'s success and failure', children: 'one' },
    succeeder: { label: 'Succeeder', hint: 'Succeeds even when its child fails', children: 'one' },
    cooldown: { label: 'Cooldown', hint: 'Lets its child succeed at most once per Value seconds', children: 'one' },
    condition: { label: 'Condition', hint: 'Succeeds when its test is true', children: 'none' },
    action: { label: 'Action', hint: 'Does something; runs until done', children: 'none' },
};

/** Field meanings per condition and action: which of value / text they read, and how to label them. */
export const CONDITIONS: Record<BehaviorCondition, { label: string; value?: string; text?: string }> = {
    canSeePlayer: { label: 'Can see the player' },
    remembersPlayer: { label: 'Saw the player recently' },
    playerWithin: { label: 'Player within', value: 'Distance (m)' },
    healthBelow: { label: 'Health below', value: 'Percent' },
    chance: { label: 'Random chance (rolled each second)', value: 'Chance 0-1' },
    variableTrue: { label: 'Graph variable is on', text: 'Variable' },
};

export const ACTIONS: Record<BehaviorAction, { label: string; value?: string; text?: string }> = {
    chase: { label: 'Chase the player (until in attack range)' },
    attack: { label: 'Attack the player' },
    shoot: { label: 'Shoot at the player (in attack range)', value: 'Seconds' },
    strafe: { label: 'Strafe around the player', value: 'Seconds' },
    search: { label: 'Search where the player was last seen' },
    patrol: { label: 'Patrol to a random point', value: 'Radius (m)' },
    wait: { label: 'Wait', value: 'Seconds' },
    moveTo: { label: 'Move to an object', text: 'Object id' },
    flee: { label: 'Flee from the player', value: 'Safe distance (m)' },
    returnHome: { label: 'Return to the spawn point' },
    setVariable: { label: 'Set a graph variable', text: 'Variable', value: 'Value' },
    playAnimation: { label: 'Play an animation', text: 'Clip' },
};

const newId = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `bt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

/** A new node of `type`, with a sensible first choice for leaves. */
export const createBehaviorNode = (type: BehaviorNodeType): BehaviorNode => {
    if (type === 'condition') return { id: newId(), type, condition: 'canSeePlayer' };
    if (type === 'action') return { id: newId(), type, action: 'wait', value: 2 };
    if (type === 'cooldown') return { id: newId(), type, value: 5, children: [] };
    return { id: newId(), type, children: [] };
};

/** Every id in the subtree under `id`, `id` included. */
export const subtreeIds = (tree: BehaviorTreeData, id: string): Set<string> => {
    const byId = new Map(tree.behaviorNodes.map(node => [node.id, node]));
    const ids = new Set<string>();
    const stack = [id];
    while (stack.length) {
        const current = stack.pop()!;
        if (ids.has(current)) continue;
        ids.add(current);
        stack.push(...(byId.get(current)?.children ?? []));
    }
    return ids;
};

/** The tree without `id` and everything under it. */
export const removeBehaviorNode = (tree: BehaviorTreeData, id: string): BehaviorTreeData => {
    const doomed = subtreeIds(tree, id);
    return {
        ...tree,
        behaviorNodes: tree.behaviorNodes
            .filter(node => !doomed.has(node.id))
            .map(node => (node.children ? { ...node, children: node.children.filter(child => !doomed.has(child)) } : node)),
    };
};

/** The tree with `child` added as the last child of `parentId`. */
export const addBehaviorChild = (tree: BehaviorTreeData, parentId: string, child: BehaviorNode): BehaviorTreeData => ({
    ...tree,
    behaviorNodes: [...tree.behaviorNodes.map(node => (node.id === parentId ? { ...node, children: [...(node.children ?? []), child.id] } : node)), child],
});

/** The tree with `id` moved one place up (-1) or down (+1) among its siblings. */
export const moveBehaviorNode = (tree: BehaviorTreeData, id: string, step: -1 | 1): BehaviorTreeData => ({
    ...tree,
    behaviorNodes: tree.behaviorNodes.map(node => {
        const children = node.children ?? [];
        const index = children.indexOf(id);
        if (index < 0) return node;
        const target = index + step;
        if (target < 0 || target >= children.length) return node;
        const next = [...children];
        [next[index], next[target]] = [next[target], next[index]];
        return { ...node, children: next };
    }),
});

const FIELD = 'bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-2xs text-gray-200 focus:outline-none focus:border-blue-500';

interface BehaviorTreeEditorProps {
    tree: BehaviorTreeData | undefined;
    onChange: (tree: BehaviorTreeData | undefined, coalesce?: string) => void;
}

/** An outline editor for an enemy blueprint's behavior tree. */
export const BehaviorTreeEditor: React.FC<BehaviorTreeEditorProps> = ({ tree, onChange }) => {
    const [adding, setAdding] = useState<string | null>(null);
    const problems = useMemo(() => (tree ? behaviorTreeProblems(tree) : []), [tree]);

    if (!tree) {
        return (
            <div className="space-y-3">
                <p className="text-xs text-gray-400">This enemy uses the built-in AI: it attacks the player in range, chases what it sees, searches where it last saw the player and otherwise patrols.</p>
                <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => onChange(defaultBehaviorTree())} className="py-1.5 rounded text-2xs font-bold bg-blue-700 hover:bg-blue-600 text-white">Start from the built-in AI</button>
                    <button type="button" onClick={() => onChange(gunnerBehaviorTree())} title="Shoots with the blueprint's first weapon from attack range" className="py-1.5 rounded text-2xs font-bold bg-blue-900 hover:bg-blue-800 text-white">Start from a gunner</button>
                    <button type="button" onClick={() => onChange({ rootId: 'root', behaviorNodes: [{ id: 'root', type: 'selector', children: [] }] })} className="py-1.5 rounded text-2xs font-bold bg-gray-800 hover:bg-gray-700 text-gray-200">Start empty</button>
                </div>
            </div>
        );
    }

    const byId = new Map(tree.behaviorNodes.map(node => [node.id, node]));
    const update = (id: string, changes: Partial<BehaviorNode>, coalesce?: string) =>
        onChange({ ...tree, behaviorNodes: tree.behaviorNodes.map(node => (node.id === id ? { ...node, ...changes } : node)) }, coalesce);

    const renderNode = (id: string, depth: number, siblings: string[], seen: Set<string>): React.ReactNode => {
        const node = byId.get(id);
        if (!node || seen.has(id)) return null;
        const path = new Set(seen).add(id);
        const info = NODE_TYPES[node.type];
        const leaf = node.type === 'condition' ? (node.condition ? CONDITIONS[node.condition] : undefined)
            : node.type === 'action' ? (node.action ? ACTIONS[node.action] : undefined) : undefined;
        const valueLabel = node.type === 'cooldown' ? 'Seconds' : leaf?.value;
        const canAdd = info.children === 'many' || (info.children === 'one' && (node.children?.length ?? 0) === 0);
        const index = siblings.indexOf(id);
        // Buttons name the node they act on, so a screen reader (or a test) can tell the rows apart.
        const name = leaf?.label ?? info.label;
        return (
            <div key={id}>
                <div className="flex items-start gap-1.5 py-1 group" style={{ paddingLeft: depth * 14 }} data-behavior-node={node.type}>
                    <div className="flex-1 min-w-0 space-y-1 rounded border border-gray-800 bg-gray-900/60 p-1.5">
                        <div className="flex items-center gap-1.5">
                            <span className="text-2xs font-bold text-sky-300 shrink-0" title={info.hint}>{info.label}</span>
                            {node.type === 'condition' && (
                                <select aria-label="Condition" value={node.condition ?? ''} onChange={(e) => update(id, { condition: e.target.value as BehaviorCondition })} className={`flex-1 min-w-0 ${FIELD}`}>
                                    {(Object.keys(CONDITIONS) as BehaviorCondition[]).map(key => <option key={key} value={key}>{CONDITIONS[key].label}</option>)}
                                </select>
                            )}
                            {node.type === 'action' && (
                                <select aria-label="Action" value={node.action ?? ''} onChange={(e) => update(id, { action: e.target.value as BehaviorAction })} className={`flex-1 min-w-0 ${FIELD}`}>
                                    {(Object.keys(ACTIONS) as BehaviorAction[]).map(key => <option key={key} value={key}>{ACTIONS[key].label}</option>)}
                                </select>
                            )}
                        </div>
                        {(valueLabel || leaf?.text) && (
                            <div className="flex items-center gap-1.5">
                                {leaf?.text && (
                                    <input aria-label={leaf.text} placeholder={leaf.text} value={node.text ?? ''} onChange={(e) => update(id, { text: e.target.value }, `bt-text-${id}`)} className={`flex-1 min-w-0 ${FIELD}`} />
                                )}
                                {valueLabel && (
                                    <label className="flex items-center gap-1 text-2xs text-gray-500">
                                        {valueLabel}
                                        <input
                                            type="number"
                                            aria-label={valueLabel}
                                            value={node.value ?? ''}
                                            onChange={(e) => {
                                                const value = Number(e.target.value);
                                                if (e.target.value !== '' && Number.isFinite(value)) update(id, { value }, `bt-value-${id}`);
                                            }}
                                            className={`w-16 ${FIELD}`}
                                        />
                                    </label>
                                )}
                            </div>
                        )}
                    </div>
                    <div className="flex flex-col gap-0.5 opacity-60 group-hover:opacity-100">
                        {canAdd && (
                            <button type="button" onClick={() => setAdding(adding === id ? null : id)} title="Add a child" aria-label={`Add a child to ${name}`} className="text-gray-400 hover:text-white"><Plus size={12} /></button>
                        )}
                        {index > 0 && <button type="button" onClick={() => onChange(moveBehaviorNode(tree, id, -1))} title="Move up" aria-label={`Move ${name} up`} className="text-gray-400 hover:text-white"><ArrowUp size={12} /></button>}
                        {index >= 0 && index < siblings.length - 1 && <button type="button" onClick={() => onChange(moveBehaviorNode(tree, id, 1))} title="Move down" aria-label={`Move ${name} down`} className="text-gray-400 hover:text-white"><ArrowDown size={12} /></button>}
                        <button
                            type="button"
                            onClick={() => onChange(id === tree.rootId ? undefined : removeBehaviorNode(tree, id))}
                            title={id === tree.rootId ? 'Remove the tree and use the built-in AI' : 'Delete this node and everything under it'}
                            aria-label={`Delete ${name}`}
                            className="text-gray-500 hover:text-red-400"
                        >
                            <Trash2 size={12} />
                        </button>
                    </div>
                </div>
                {adding === id && (
                    <div className="flex flex-wrap gap-1 py-1" style={{ paddingLeft: (depth + 1) * 14 }} role="menu" aria-label="Add a child">
                        {(Object.keys(NODE_TYPES) as BehaviorNodeType[]).map(type => (
                            <button
                                key={type}
                                type="button"
                                role="menuitem"
                                onClick={() => { onChange(addBehaviorChild(tree, id, createBehaviorNode(type))); setAdding(null); }}
                                className="px-1.5 py-0.5 rounded text-2xs bg-gray-800 hover:bg-gray-700 text-gray-200"
                                title={NODE_TYPES[type].hint}
                            >
                                {NODE_TYPES[type].label}
                            </button>
                        ))}
                    </div>
                )}
                {(node.children ?? []).map(child => renderNode(child, depth + 1, node.children ?? [], path))}
            </div>
        );
    };

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-2xs text-gray-500"><Brain size={12} className="text-sky-400" /> Evaluated from the top every frame; the first branch that is not failing decides.</div>
            {renderNode(tree.rootId, 0, [], new Set())}
            {problems.length > 0 && (
                <div className="rounded border border-amber-700/50 bg-amber-950/30 p-2 space-y-0.5">
                    {problems.map(problem => <div key={problem} className="flex items-center gap-1 text-2xs text-amber-300"><AlertTriangle size={10} /> {problem}</div>)}
                </div>
            )}
        </div>
    );
};
