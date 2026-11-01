import React from 'react';
import { Layers } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import type { ComponentInspectorProps } from '../../runtime/components/types';

/** Picks the level a Level Streaming volume loads: any level but the one being edited. */
export const LevelStreamingInspector: React.FC<ComponentInspectorProps> = ({ component, onChangeProps }) => {
    const { levels, currentLevelId } = useScene();
    const levelId = typeof component.props.levelId === 'string' ? component.props.levelId : '';
    const choices = levels.filter(level => level.id !== currentLevelId);
    return (
        <div className="space-y-1">
            <label className="flex items-center gap-1 text-2xs text-gray-400"><Layers size={10} /> Level to load</label>
            <select
                aria-label="Level to load"
                value={levelId}
                onChange={(event) => onChangeProps({ levelId: event.target.value })}
                className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-violet-500"
            >
                <option value="">Choose a level</option>
                {levelId && !choices.some(level => level.id === levelId) && <option value={levelId}>Missing level</option>}
                {choices.map(level => <option key={level.id} value={level.id}>{level.name}</option>)}
            </select>
            {!levelId && <p className="text-2xs text-amber-400">Pick the level whose objects this volume loads.</p>}
        </div>
    );
};
