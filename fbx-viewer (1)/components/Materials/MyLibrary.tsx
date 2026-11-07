import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BookIcon, CopyIcon, CrossIcon, DownloadIcon, FolderIcon, PackageIcon, PackagePlusIcon, SearchIcon, TagIcon, TrashIcon } from '../UI/Icons';
import { Button, IconButton, TextInput } from '../UI/kit';
import { useAssets } from '../../context/AssetContext';
import { useScene } from '../../context/SceneContext';
import { useNotification } from '../../context/NotificationContext';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { materialLibrary, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import { textureSettingsOf } from '../../texturing/textureSettings';
import { projectService } from '../../utils/projectService';
import {
    filterLibrary, libraryFolders, libraryMaterial, libraryNodeGraphs, libraryTags, userMaterialLibrary,
    type LibraryEntry, type RemovedLibraryEntry,
} from '../../utils/userMaterialLibrary';
import { addToLibrary, bringIntoProject, usesInWords } from '../../utils/userMaterialLibraryActions';
import { renderMaterialBall } from './materialBalls';
import { useProjectTarget } from './projectTarget';
import { MaterialPackageImport, useExportLibraryPackage, type MaterialPackageImportHandle } from './MaterialPackageFiles';

/**
 * MY LIBRARY (in the Materials tab)
 *
 * The user's materials across projects (utils/userMaterialLibrary.ts): a grid of rendered balls with plain
 * names, found by search, folder and tag. The chosen one's page renames, files and tags it, says where it
 * was used, and brings it into the project (its button, or dragging its ball onto the project's list), makes
 * a copy, or deletes it with a way back.
 */

/** What a ball dragged from the library carries: the entry's id. */
export const LIBRARY_DRAG_TYPE = 'application/x-auvra-library-material';

/** The library, read once and followed as it changes. */
export const useUserLibrary = () => {
    const library = userMaterialLibrary();
    useEffect(() => {
        library.load().catch((failure: unknown) => frontendDiagnostics.failure('material_library_load_failed', failure));
    }, [library]);
    const version = useSyncExternalStore((listener) => library.subscribe(listener), () => library.version);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const entries = useMemo(() => [...library.entries()], [library, version]);
    return { library, entries };
};

const ballUrls = new WeakMap<Blob, string>();
const ballUrl = (blob: Blob): string => {
    let url = ballUrls.get(blob);
    if (!url) ballUrls.set(blob, url = URL.createObjectURL(blob));
    return url;
};

/** Entries without a ball get one drawn, one at a time. */
const drawing = new Set<string>();
let drawQueue: Promise<void> = Promise.resolve();
const drawMissingBall = (entry: LibraryEntry): void => {
    if (drawing.has(entry.id)) return;
    drawing.add(entry.id);
    const library = userMaterialLibrary();
    drawQueue = drawQueue.then(async () => {
        const asset = libraryMaterial(entry);
        if (!asset) return;
        const ball = await renderMaterialBall(asset, await library.pictures(entry.id));
        if (ball && library.get(entry.id)) await library.change(entry.id, { thumbnail: ball });
    }).catch((failure: unknown) => frontendDiagnostics.failure('material_ball_failed', failure));
};

/** An entry's rendered ball (drawn now if it has none yet). */
export const LibraryBall: React.FC<{ entry: LibraryEntry; size: number }> = ({ entry, size }) => {
    useEffect(() => { if (!entry.thumbnail) drawMissingBall(entry); }, [entry]);
    return entry.thumbnail
        ? <img src={ballUrl(entry.thumbnail)} alt="" width={size} height={size} draggable={false} className="block rounded" style={{ width: size, height: size }} />
        : <span aria-hidden className="block animate-pulse rounded bg-gray-800" style={{ width: size, height: size }} />;
};

/** Brings a library material into the open project (its own copy, with its pictures); null when it could not. */
export const useBringIn = () => {
    const projectTarget = useProjectTarget();
    const { addNotification } = useNotification();
    return useCallback(async (entryId: string): Promise<MaterialAsset | null> => {
        const library = userMaterialLibrary();
        const entry = library.get(entryId);
        const target = projectTarget();
        if (!target || !entry) return null;
        try {
            projectService.assertWritable();
            const asset = await bringIntoProject(library, entryId, target);
            addNotification({ message: `"${asset.name}" is now in this project.`, type: 'success' });
            return asset;
        } catch (failure) {
            frontendDiagnostics.failure('material_library_bring_in_failed', failure);
            addNotification({ message: failure instanceof Error && failure.message.includes('read-only') ? 'This project is read-only.' : `"${entry.name}" could not be brought into this project.`, type: 'error' });
            return null;
        }
    }, [addNotification, projectTarget]);
};

/** Adds a project material to My library (or updates the entry it became before). */
export const useAddToLibrary = () => {
    const { textures } = useAssets();
    const { projectStatus } = useScene();
    const { addNotification } = useNotification();
    return useCallback(async (asset: MaterialAsset): Promise<void> => {
        try {
            const { updated } = await addToLibrary(userMaterialLibrary(), asset, {
                projectId: projectStatus.projectId ?? '',
                textures,
                settingsOf: textureSettingsOf,
                read: async (url) => (await fetch(url)).blob(),
                materialOf: (id) => materialLibrary.get(id),
            }, renderMaterialBall);
            addNotification({ message: updated ? `"${asset.name}" is updated in your library.` : `"${asset.name}" is in your library, for every project.`, type: 'success' });
        } catch (failure) {
            frontendDiagnostics.failure('material_library_add_failed', failure);
            addNotification({ message: `"${asset.name}" could not be added to your library.`, type: 'error' });
        }
    }, [addNotification, projectStatus.projectId, textures]);
};

const Chip: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode; title?: string }> = ({ active, onClick, children, title }) => (
    <button type="button" onClick={onClick} title={title} aria-pressed={active}
        className={`inline-flex h-6 max-w-[11rem] shrink-0 items-center gap-1 truncate rounded px-2 text-2xs ${active ? 'bg-accent/20 text-accent' : 'bg-well text-ink-2 hover:text-ink'}`}>
        {children}
    </button>
);

/** A field that keeps what is typed and hands it on when left or Enter is pressed. */
const CommitField: React.FC<{ value: string; onCommit: (value: string) => void; label: string; placeholder?: string }> = ({ value, onCommit, label, placeholder }) => {
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);
    const commit = () => { if (draft !== value) onCommit(draft); };
    return (
        <TextInput aria-label={label} value={draft} placeholder={placeholder} className="w-full"
            onChange={(event) => setDraft(event.target.value)} onBlur={commit}
            onKeyDown={(event) => { if (event.key === 'Enter') commit(); if (event.key === 'Escape') setDraft(value); }} />
    );
};

const folderWords = (folder: string): string => folder.split('/').join(' › ');

/** The chosen entry's page. */
const EntryPage: React.FC<{
    entry: LibraryEntry;
    folders: readonly string[];
    projectOpen: boolean;
    projectId: string | null;
    onUse: () => void;
    onDuplicate: () => void;
    onDelete: () => void;
    using: boolean;
}> = ({ entry, folders, projectOpen, projectId, onUse, onDuplicate, onDelete, using }) => {
    const library = userMaterialLibrary();
    const exportPackage = useExportLibraryPackage();
    const [tag, setTag] = useState('');
    const change = (changes: Parameters<typeof library.change>[1]) => {
        library.change(entry.id, changes).catch((failure: unknown) => frontendDiagnostics.failure('material_library_change_failed', failure));
    };
    const addTag = () => {
        if (!tag.trim()) return;
        change({ tags: [...entry.tags, tag] });
        setTag('');
    };
    const uses = usesInWords(entry, projectId, (materialId) => !!materialLibrary.get(materialId));
    const nodeGraphs = libraryNodeGraphs(entry);
    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div className="flex justify-center border-b border-line p-3"><LibraryBall entry={entry} size={176} /></div>
            <div className="space-y-3 p-3">
                <label className="block space-y-1">
                    <span className="text-2xs text-ink-3">Name</span>
                    <CommitField label="Name" value={entry.name} onCommit={(name) => change({ name })} />
                </label>
                <label className="block space-y-1">
                    <span className="text-2xs text-ink-3">Folder</span>
                    <CommitField label="Folder" value={entry.folder} placeholder="At the top (type a folder, such as Metals/Painted)" onCommit={(folder) => change({ folder })} />
                    {folders.length > 0 && (
                        <span className="flex flex-wrap gap-1 pt-1">
                            {entry.folder && <Chip active={false} onClick={() => change({ folder: '' })}>At the top</Chip>}
                            {folders.filter(folder => folder !== entry.folder).slice(0, 8).map(folder => (
                                <Chip key={folder} active={false} onClick={() => change({ folder })} title={`Move into ${folderWords(folder)}`}><FolderIcon size={11} />{folderWords(folder)}</Chip>
                            ))}
                        </span>
                    )}
                </label>
                <div className="space-y-1">
                    <span className="text-2xs text-ink-3">Tags</span>
                    <div className="flex flex-wrap gap-1">
                        {entry.tags.map(name => (
                            <span key={name} className="inline-flex h-6 items-center gap-1 rounded bg-well pl-2 pr-1 text-2xs text-ink-2">
                                {name}
                                <button type="button" aria-label={`Remove the tag ${name}`} onClick={() => change({ tags: entry.tags.filter(other => other !== name) })} className="text-ink-3 hover:text-ink"><CrossIcon size={10} /></button>
                            </span>
                        ))}
                    </div>
                    <TextInput aria-label="Add a tag" value={tag} placeholder="Add a tag, then press Enter" className="w-full"
                        onChange={(event) => setTag(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addTag(); }} onBlur={addTag} />
                </div>
                <div className="space-y-1">
                    <span className="text-2xs text-ink-3">Used in</span>
                    {uses.length === 0
                        ? <p className="text-2xs text-ink-3">Not brought into any project yet.</p>
                        : <ul className="space-y-0.5 text-xs text-ink-2">{uses.map((use, index) => <li key={index} className="truncate">{use}</li>)}</ul>}
                </div>
                {nodeGraphs.length > 0 && (
                    <div className="space-y-1">
                        <span className="text-2xs text-ink-3">Graphs it uses as nodes, which come with it</span>
                        <ul className="space-y-0.5 text-xs text-ink-2">{nodeGraphs.map(graph => <li key={graph.id} className="truncate">{graph.name}</li>)}</ul>
                    </div>
                )}
                <div className="space-y-2 border-t border-line pt-3">
                    <Button variant="primary" size="md" className="w-full" icon={<DownloadIcon size={13} />} disabled={!projectOpen || using} onClick={onUse}>
                        {using ? 'Bringing it in…' : 'Use in this project'}
                    </Button>
                    <p className="text-2xs leading-snug text-ink-3">
                        {projectOpen ? 'The project gets its own copy, with its pictures. You can also drag the ball onto the project\'s materials.' : 'Open a project to bring materials into it.'}
                    </p>
                    <div className="flex gap-1">
                        <Button size="sm" icon={<CopyIcon size={12} />} onClick={onDuplicate}>Duplicate</Button>
                        <Button size="sm" icon={<PackageIcon size={12} />} title="Publish it as one .auvramat file, with its pictures and the graphs it uses as nodes" onClick={() => void exportPackage(entry)}>Publish</Button>
                        <span className="flex-1" />
                        <Button size="sm" variant="danger" icon={<TrashIcon size={12} />} onClick={onDelete}>Delete</Button>
                    </div>
                </div>
            </div>
        </div>
    );
};

/** The library's grid and the chosen entry's page, filling the Materials tab beside the project's list. */
export const MyLibraryPanel: React.FC<{ onBringIn: (entryId: string) => Promise<MaterialAsset | null> }> = ({ onBringIn }) => {
    const { library, entries } = useUserLibrary();
    const { projectStatus } = useScene();
    const [query, setQuery] = useState('');
    const [folder, setFolder] = useState('');
    const [tag, setTag] = useState('');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [deleted, setDeleted] = useState<RemovedLibraryEntry | null>(null);
    const [using, setUsing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const packageImport = useRef<MaterialPackageImportHandle>(null);
    const folders = useMemo(() => libraryFolders(entries), [entries]);
    const tags = useMemo(() => libraryTags(entries), [entries]);
    const shown = useMemo(() => filterLibrary(entries, { query, folder, tag }), [entries, folder, query, tag]);
    const selected = entries.find(entry => entry.id === selectedId) ?? shown[0] ?? null;

    const fail = (message: string) => (failure: unknown) => {
        frontendDiagnostics.failure('material_library_change_failed', failure);
        setError(message);
    };
    const use = async () => {
        if (!selected) return;
        setUsing(true);
        await onBringIn(selected.id);
        setUsing(false);
    };
    const duplicate = () => {
        if (!selected) return;
        library.duplicate(selected.id).then((copy) => { setError(null); setSelectedId(copy.id); }, fail('The copy could not be made.'));
    };
    const remove = () => {
        if (!selected) return;
        library.remove(selected.id).then((removed) => { setError(null); setDeleted(removed); setSelectedId(null); }, fail('It could not be deleted.'));
    };
    const undo = () => {
        if (!deleted) return;
        const kept = deleted;
        setDeleted(null);
        library.restore(kept).then(() => setSelectedId(kept.entry.id), fail('It could not be put back.'));
    };

    return (
        <div className="flex min-h-0 min-w-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
                    <BookIcon size={14} className="text-ink-2" />
                    <h2 className="text-xs font-semibold text-ink">My library</h2>
                    <span className="text-2xs text-ink-3">{entries.length === 1 ? '1 material' : `${entries.length} materials`}, kept for every project</span>
                    <span className="flex-1" />
                    <span className="relative">
                        <SearchIcon size={12} className="pointer-events-none absolute left-2 top-1.5 text-ink-3" />
                        <TextInput aria-label="Search my library" value={query} placeholder="Search names, tags and folders" className="w-60 pl-6" onChange={(event) => setQuery(event.target.value)} />
                    </span>
                    <IconButton label="Add a material package (.auvramat) to my library" onClick={() => packageImport.current?.pick()}><PackagePlusIcon size={14} /></IconButton>
                    <MaterialPackageImport ref={packageImport} into="library" onLibraryEntry={(entry) => { setError(null); setQuery(''); setFolder(''); setTag(''); setSelectedId(entry.id); }} />
                </div>
                {(folders.length > 0 || tags.length > 0) && (
                    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-3 py-1.5">
                        <Chip active={!folder && !tag} onClick={() => { setFolder(''); setTag(''); }}>All</Chip>
                        {folders.map(name => (
                            <Chip key={name} active={folder === name} onClick={() => setFolder(folder === name ? '' : name)} title={`Only what is in ${folderWords(name)}`}><FolderIcon size={11} />{folderWords(name)}</Chip>
                        ))}
                        {tags.map(name => (
                            <Chip key={`#${name}`} active={tag === name} onClick={() => setTag(tag === name ? '' : name)} title={`Only what is tagged ${name}`}><TagIcon size={11} />{name}</Chip>
                        ))}
                    </div>
                )}
                {deleted && (
                    <div role="status" className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-2xs text-ink-2">
                        <span className="min-w-0 flex-1 truncate">Deleted "{deleted.entry.name}" from your library.{deleted.entry.uses.length > 0 ? ' Projects that use it keep their own copies.' : ''}</span>
                        <Button size="sm" onClick={undo}>Undo</Button>
                        <IconButton label="Dismiss" onClick={() => setDeleted(null)}><CrossIcon size={11} /></IconButton>
                    </div>
                )}
                {error && <p role="alert" className="shrink-0 border-b border-line px-3 py-1.5 text-2xs text-warn">{error}</p>}
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                    {entries.length === 0 ? (
                        <div className="mx-auto mt-10 max-w-sm space-y-2 text-center">
                            <BookIcon size={22} className="mx-auto text-ink-3" />
                            <p className="text-xs text-ink-2">Your library is empty.</p>
                            <p className="text-2xs leading-snug text-ink-3">Open one of this project's materials and choose Add to my library, or add a material package (.auvramat) someone published. It is kept here with its pictures, ready for any project.</p>
                        </div>
                    ) : shown.length === 0 ? (
                        <p className="mt-10 text-center text-2xs text-ink-3">Nothing in your library matches.</p>
                    ) : (
                        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))' }}>
                            {shown.map(entry => (
                                <button key={entry.id} type="button" draggable
                                    onDragStart={(event) => { event.dataTransfer.setData(LIBRARY_DRAG_TYPE, entry.id); event.dataTransfer.effectAllowed = 'copy'; }}
                                    onClick={() => setSelectedId(entry.id)}
                                    onDoubleClick={() => { setSelectedId(entry.id); void onBringIn(entry.id); }}
                                    title={`${entry.name}: drag onto the project's materials, or double-click, to use it`}
                                    className={`flex min-w-0 flex-col items-center gap-1 rounded p-1.5 ${entry.id === selected?.id ? 'bg-accent/15 ring-1 ring-accent/60' : 'hover:bg-white/5'}`}>
                                    <LibraryBall entry={entry} size={96} />
                                    <span className="w-full truncate text-center text-2xs text-ink">{entry.name}</span>
                                    {entry.folder && <span className="-mt-1 w-full truncate text-center text-[10px] text-ink-3">{folderWords(entry.folder)}</span>}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>
            <aside className="flex w-72 shrink-0 flex-col border-l border-line">
                {selected
                    ? <EntryPage key={selected.id} entry={selected} folders={folders} projectOpen={!!projectStatus.projectId && !projectStatus.readOnly} projectId={projectStatus.projectId}
                        onUse={() => void use()} onDuplicate={duplicate} onDelete={remove} using={using} />
                    : <p className="p-3 text-2xs text-ink-3">Pick a material to see it here.</p>}
            </aside>
        </div>
    );
};
