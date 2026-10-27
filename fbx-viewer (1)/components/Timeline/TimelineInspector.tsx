import React, { useMemo, useState } from 'react';
import { Film } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import { normalizeTimeline } from '../../runtime/timeline/evaluate';
import type { TimelineData } from '../../runtime/timeline/types';
import type { ComponentInspectorProps } from '../../runtime/components/types';
import { TimelineEditorModal } from './TimelineEditorModal';

const countKeys = (timeline: TimelineData) => timeline.tracks.reduce((count, track) => count + (track.kind === 'transform'
    ? (track.position?.length ?? 0) + (track.rotation?.length ?? 0) + (track.scale?.length ?? 0)
    : track.keys.length), 0);

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Inspector section of the timeline component: a summary of the stored timeline (props.timeline) and
 * the button that opens the dope-sheet editor. Saving the editor commits the whole timeline as one edit.
 */
export const TimelineInspector: React.FC<ComponentInspectorProps> = ({ object, component, onChangeProps }) => {
    const { levelObjects, activeLevelBlueprint } = useScene();
    const [editing, setEditing] = useState(false);
    const timeline = useMemo(() => normalizeTimeline(component.props.timeline), [component.props.timeline]);
    const objects = useMemo(() => levelObjects.filter(candidate => candidate.levelId === object.levelId), [levelObjects, object.levelId]);
    const variableNames = useMemo(
        () => [...new Set((activeLevelBlueprint?.variables ?? []).map(variable => variable.name.trim()).filter(Boolean))],
        [activeLevelBlueprint],
    );
    const keyCount = countKeys(timeline);
    const mutedCount = timeline.tracks.filter(track => track.muted).length;

    return (
        <div className="space-y-2 rounded border border-gray-700/60 bg-gray-950/40 p-2">
            <div className="flex items-center justify-between text-[10px]">
                <span className="text-gray-400">Duration</span>
                <span className="font-mono text-gray-200">{timeline.duration.toFixed(2)} s</span>
            </div>
            <div className="flex items-center justify-between text-[10px]">
                <span className="text-gray-400">Tracks</span>
                <span className="text-gray-200">
                    {plural(timeline.tracks.length, 'track')} · {plural(keyCount, 'key')}{mutedCount > 0 ? ` · ${mutedCount} muted` : ''}
                </span>
            </div>
            <button
                type="button"
                onClick={() => setEditing(true)}
                className="w-full py-1.5 text-xs bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/40 rounded text-blue-200 flex items-center justify-center gap-2 transition-colors"
            >
                <Film size={12} /> Edit Timeline
            </button>
            {editing && (
                <TimelineEditorModal
                    timeline={timeline}
                    objects={objects}
                    variableNames={variableNames}
                    ownerId={object.id}
                    subtitle={object.name || object.type}
                    onSave={(next) => onChangeProps({ timeline: next })}
                    onClose={() => setEditing(false)}
                />
            )}
        </div>
    );
};
