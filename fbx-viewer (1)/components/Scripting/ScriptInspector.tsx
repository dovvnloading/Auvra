import React, { useEffect, useMemo, useState } from 'react';
import { FileCode2, FilePlus2 } from 'lucide-react';
import type { ComponentInspectorProps } from '../../runtime/components/types';
import { SCRIPT_LIMITS } from '../../runtime/scripting/protocol';
import type { PrefabData } from '../../types';
import { useScene } from '../../context/SceneContext';
import { projectService } from '../../utils/projectService';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { formatScriptSize, ScriptEditorModal, utf8ByteLength, type ScriptReferenceGroup } from './ScriptEditorModal';
import { SCRIPT_TEMPLATES } from './scriptTemplates';

const PREVIEW_LINES = 6;

/**
 * Ids a script refers to that the editor cannot otherwise show: prefabs for ctx.spawn, sounds for
 * ctx.playSound and levels for ctx.openLevel. Prefabs live in their own project domain, so they are
 * loaded only while the editor is open and a project is.
 */
const useScriptReferences = (active: boolean): ScriptReferenceGroup[] => {
    const { audioAssets, levels } = useScene();
    const [prefabs, setPrefabs] = useState<PrefabData[]>([]);

    useEffect(() => {
        if (!active || !projectService.getStatus().projectId) return;
        let cancelled = false;
        import('../../utils/db')
            .then(({ dbOperations }) => dbOperations.getAllPrefabs())
            .then(loaded => {
                if (!cancelled) setPrefabs([...loaded].sort((a, b) => a.name.localeCompare(b.name)));
            })
            .catch(error => {
                if (!cancelled) frontendDiagnostics.failure('script_editor_prefab_list_failed', error);
            });
        return () => { cancelled = true; };
    }, [active]);

    return useMemo(() => [
        { label: 'Prefabs', usage: 'ctx.spawn', items: prefabs.map(prefab => ({ id: prefab.id, name: prefab.name })) },
        { label: 'Sounds', usage: 'ctx.playSound', items: audioAssets.map(audio => ({ id: audio.id, name: audio.name })) },
        { label: 'Levels', usage: 'ctx.openLevel', items: levels.map(level => ({ id: level.id, name: level.name })) },
    ], [prefabs, audioAssets, levels]);
};

/**
 * Inspector for a Script component: a preview of the first lines of its source, an Edit Script
 * button that opens the full editor, and a template picker that opens the editor on a template.
 * Nothing is written until the editor saves, which commits { source } through onChangeProps.
 */
export const ScriptInspector: React.FC<ComponentInspectorProps> = ({ object, component, onChangeProps }) => {
    // Read here rather than through scriptComponent's readScriptSource, which imports this inspector.
    const source = typeof component.props.source === 'string' ? component.props.source : '';
    const [editor, setEditor] = useState<{ draft: string } | null>(null);
    const [templateId, setTemplateId] = useState(SCRIPT_TEMPLATES[0].id);
    const references = useScriptReferences(editor !== null);

    const hasScript = source.trim().length > 0;
    const lines = source.split('\n');
    const preview = lines.slice(0, PREVIEW_LINES).join('\n');
    const hiddenLines = lines.length - PREVIEW_LINES;
    const bytes = utf8ByteLength(source);
    const template = SCRIPT_TEMPLATES.find(item => item.id === templateId) ?? SCRIPT_TEMPLATES[0];

    return (
        <div className="space-y-2">
            {hasScript ? (
                <div className="rounded border border-gray-800 bg-gray-950">
                    <pre className="m-0 max-h-32 overflow-hidden whitespace-pre px-2 py-1.5 font-mono text-2xs leading-snug text-blue-300" aria-label="Script preview">{preview}</pre>
                    <div className="flex justify-between border-t border-gray-800 px-2 py-1 text-2xs text-gray-500">
                        <span>{hiddenLines > 0 ? `+${hiddenLines} more ${hiddenLines === 1 ? 'line' : 'lines'}` : `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`}</span>
                        <span>{formatScriptSize(bytes)}</span>
                    </div>
                </div>
            ) : (
                <div className="rounded border border-dashed border-gray-700 px-2 py-3 text-center text-2xs italic text-gray-500">No script yet</div>
            )}
            {bytes > SCRIPT_LIMITS.maxSourceBytes && (
                <div className="text-2xs text-amber-400">
                    Over the {formatScriptSize(SCRIPT_LIMITS.maxSourceBytes)} limit, so it will not run. Shorten it in the editor.
                </div>
            )}

            <button
                type="button"
                onClick={() => setEditor({ draft: source })}
                className="flex w-full items-center justify-center gap-2 rounded border border-gray-700 bg-gray-800 py-1.5 text-xs text-gray-200 transition-colors hover:bg-gray-700"
            >
                <FileCode2 size={12} /> Edit Script
            </button>

            <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                    <select
                        value={template.id}
                        onChange={(event) => setTemplateId(event.target.value)}
                        className="h-7 min-w-0 flex-1 rounded border border-gray-800 bg-gray-950 px-1 text-2xs text-white focus:border-blue-500 focus:outline-none"
                        aria-label="Script template"
                    >
                        {SCRIPT_TEMPLATES.map(item => (
                            <option key={item.id} value={item.id}>{item.label}</option>
                        ))}
                    </select>
                    <button
                        type="button"
                        onClick={() => setEditor({ draft: template.source })}
                        className="flex h-7 shrink-0 items-center gap-1 rounded border border-gray-700 bg-gray-800 px-2 text-2xs text-gray-200 transition-colors hover:bg-gray-700"
                        title={hasScript ? 'Open this template in the editor; the current script is replaced only when you save' : 'Open this template in the editor'}
                    >
                        <FilePlus2 size={12} /> New from Template
                    </button>
                </div>
                <div className="text-2xs leading-snug text-gray-500">
                    {template.description}{hasScript ? ' Replaces the current script only when you save.' : ''}
                </div>
            </div>

            {editor && (
                <ScriptEditorModal
                    title={object.name || 'Unnamed object'}
                    source={source}
                    initialDraft={editor.draft}
                    references={references}
                    onSave={(next) => onChangeProps({ source: next })}
                    onClose={() => setEditor(null)}
                />
            )}
        </div>
    );
};

export default ScriptInspector;
