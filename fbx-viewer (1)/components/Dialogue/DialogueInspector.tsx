import React, { useMemo, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import { dialogueProblems, normalizeDialogue } from '../../runtime/dialogue';
import type { ComponentInspectorProps } from '../../runtime/components/types';
import { DialogueEditorModal } from './DialogueEditorModal';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Inspector section of the Dialogue component: a summary of the stored conversation (props.dialogue)
 * and the button that opens its editor. Saving the editor commits the whole conversation as one edit.
 */
export const DialogueInspector: React.FC<ComponentInspectorProps> = ({ object, component, onChangeProps }) => {
    const { activeLevelBlueprint } = useScene();
    const [editing, setEditing] = useState(false);
    const dialogue = useMemo(() => normalizeDialogue(component.props.dialogue), [component.props.dialogue]);
    const problems = useMemo(() => dialogueProblems(dialogue), [dialogue]);
    const variableNames = useMemo(
        () => [...new Set((activeLevelBlueprint?.variables ?? []).map(variable => variable.name.trim()).filter(Boolean))],
        [activeLevelBlueprint],
    );
    const choiceCount = dialogue.lines.reduce((count, line) => count + (line.choices?.length ?? 0), 0);

    return (
        <div className="space-y-2 rounded border border-gray-700/60 bg-gray-950/40 p-2">
            <div className="flex items-center justify-between text-[10px]">
                <span className="text-gray-400">Conversation</span>
                <span className="text-gray-200">{plural(dialogue.lines.length, 'line')} · {plural(choiceCount, 'choice')}</span>
            </div>
            {!dialogue.lines.length && <p className="text-[10px] text-amber-400">Add lines for the player to hear.</p>}
            {problems.length > 0 && <p className="text-[10px] text-amber-400">{problems[0]}{problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}</p>}
            <button
                type="button"
                onClick={() => setEditing(true)}
                className="w-full py-1.5 text-xs bg-sky-600/20 hover:bg-sky-600/30 border border-sky-500/40 rounded text-sky-200 flex items-center justify-center gap-2 transition-colors"
            >
                <MessageSquare size={12} /> Edit Dialogue
            </button>
            {editing && (
                <DialogueEditorModal
                    dialogue={dialogue}
                    variableNames={variableNames}
                    subtitle={object.name || object.type}
                    onSave={(next) => onChangeProps({ dialogue: next })}
                    onClose={() => setEditing(false)}
                />
            )}
        </div>
    );
};
