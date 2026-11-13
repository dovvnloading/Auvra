import React, { useState } from 'react';
import type { TextureParameterRenamePlan } from '../../texturing/graph/renameProjectParameter';
import { Button } from '../UI/kit';

export interface ProjectRenamePreview {
    projectId: string;
    revision: number;
    libraryVersion: number;
    presetsVersion: number;
    impact: TextureParameterRenamePlan['impact'];
    documents: Array<{ domain: string; id: string; name?: string }>;
}

export const projectRenamePreview = (
    plan: TextureParameterRenamePlan, projectId: string, revision: number, libraryVersion: number, presetsVersion: number,
): ProjectRenamePreview => ({
    projectId, revision, libraryVersion, presetsVersion, impact: plan.impact,
    documents: plan.changes.map(change => {
        const doc = change.value as { id: string; name?: unknown };
        return { domain: change.domain, id: doc.id, ...(typeof doc.name === 'string' ? { name: doc.name } : {}) };
    }),
});

/** Keep ordinary folder paths readable. Encode exotic argument characters (including
 * typographic quotes interpreted by PowerShell) without inserting them into shell text. */
const powershellArgument = (value: string): string => {
    if (/^[a-z0-9 ._:'\\/-]+$/i.test(value)) return `'${value.replaceAll("'", "''")}'`;
    const bytes = new TextEncoder().encode(value);
    const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
    return `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))`;
};

export const ParameterRenamePreview: React.FC<{
    preview: ProjectRenamePreview;
    stale: boolean;
    onRefresh: () => void;
    onDismiss: () => void;
}> = ({ preview, stale, onRefresh, onDismiss }) => {
    const [folder, setFolder] = useState('');
    const [copyMessage, setCopyMessage] = useState('');
    const { impact, documents } = preview;
    const counts = [[impact.nestedNodes, 'Subgraph or Iterate nodes'], [impact.paintReferences, 'Paint fills or masks'],
        [impact.modelOverrides, 'Model overrides'], [impact.objectOverrides, 'Placed object overrides'],
        [impact.prefabOverrides, 'Prefab member overrides'], [impact.sharedPresets, 'Shared presets']] as const;
    const cli = 'python -m Auvra.project.material_commands';
    const command = [cli, powershellArgument(folder.trim()), 'rename-parameter', '--',
        ...[impact.sourceMaterialId, impact.from, impact.to].map(powershellArgument)].join(' ');

    return <section aria-label="Project parameter rename preview" className="mb-3 space-y-2 rounded border border-line bg-ground p-2 text-xs text-ink">
        <div className="flex items-center justify-between">
            <strong>Project rename preview</strong>
            <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>
        </div>
        <p className="break-words"><strong>{impact.from}</strong> → <strong>{impact.to}</strong></p>
        <p className="text-2xs text-ink-3">Saved project revision {preview.revision}</p>
        {stale ? <>
            <p role="status">The project or its editor state has changed. Refresh the references before continuing.</p>
            <Button size="sm" onClick={onRefresh}>Refresh preview</Button>
        </> : <>
            <dl className="grid grid-cols-[1fr_auto] gap-x-2">
                {counts.filter(([count]) => count > 0).map(([count, name]) => <React.Fragment key={name}>
                    <dt>{name}</dt><dd>{count}</dd>
                </React.Fragment>)}
            </dl>
            <details>
                <summary className="cursor-pointer">{documents.length} affected project documents</summary>
                <ul className="mt-1 max-h-36 space-y-1 overflow-auto">
                    {documents.map(doc => <li className="break-words" key={JSON.stringify([doc.domain, doc.id])}>
                        {doc.domain} / {doc.name && doc.name !== doc.id ? `${doc.name} (${doc.id})` : doc.id}
                    </li>)}
                </ul>
            </details>
            <p>Save and close the project. From the Auvra checkout, run the preview in PowerShell to get the saved revision.</p>
            <label className="block">Project folder
                <input className="mt-1 block w-full rounded bg-panel p-1" value={folder}
                    placeholder="Folder containing the .auvra file" onChange={event => { setFolder(event.target.value); setCopyMessage(''); }} />
            </label>
            {folder.trim() && <textarea aria-label="PowerShell preview command" className="block w-full bg-panel p-1 font-mono text-2xs" rows={4}
                readOnly value={command} onFocus={event => event.target.select()} />}
            <Button size="sm" disabled={!folder.trim()} onClick={async () => {
                try { await navigator.clipboard.writeText(command); setCopyMessage('Preview command copied.'); }
                catch { setCopyMessage('Select the command and copy it manually.'); }
            }}>Copy preview command</Button>
            {copyMessage && <p role="status">{copyMessage}</p>}
            <p className="text-2xs text-ink-3">To apply, place <code>--apply-revision REV --receipt FILE</code> before <code>--</code>.
                Use the revision from the command and a new receipt outside the project. The same receipt supports <code>undo-rename</code> and <code>redo-rename</code>.</p>
        </>}
    </section>;
};
