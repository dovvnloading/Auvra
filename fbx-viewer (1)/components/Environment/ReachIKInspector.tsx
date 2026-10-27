import React from 'react';
import { Crosshair } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import type { ComponentInspectorProps } from '../../runtime/components/types';

/** Picks what a Reach IK component reaches for: the player or another object in the level. */
export const ReachIKInspector: React.FC<ComponentInspectorProps> = ({ object, component, onChangeProps }) => {
    const { levelObjects } = useScene();
    const target = typeof component.props.target === 'string' ? component.props.target : '';
    const choices = levelObjects.filter(candidate => candidate.id !== object.id);
    const known = target === 'player' || choices.some(candidate => candidate.id === target);
    return (
        <div className="space-y-1">
            <label className="flex items-center gap-1 text-[10px] text-gray-400"><Crosshair size={10} /> Reach for</label>
            <select
                aria-label="Reach for"
                value={target}
                onChange={(event) => onChangeProps({ target: event.target.value })}
                className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-violet-500"
            >
                <option value="">Nothing</option>
                <option value="player">The player</option>
                {target && !known && <option value={target}>Missing object</option>}
                {choices.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </select>
            {!target && <p className="text-[10px] text-amber-400">Pick the object the bone reaches for.</p>}
        </div>
    );
};
