import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, HardDrive, Trash2 } from 'lucide-react';
import {
    ROOT_FOLDER,
    ROOT_FOLDER_LABEL,
    childFolderPaths,
    folderAncestors,
    folderLeafName,
    hasAssetDrag,
} from './browserFolders';
import { InlineNameInput, type InlineNameCommitSource } from './InlineNameInput';

interface FolderTreeProps {
    folders: string[];
    currentFolder: string;
    onNavigate: (path: string) => void;
    /** Called with the target folder when an asset card is dropped on a row. */
    onDropAsset: (event: React.DragEvent, folder: string) => void;
    /** Parent folder of the inline "new folder" input, or null when not creating. */
    creatingIn: string | null;
    createError: string | null;
    onCreateCommit: (name: string, source: InlineNameCommitSource) => boolean;
    onCreateCancel: () => void;
    canRemoveFolder: (path: string) => boolean;
    onRemoveFolder: (path: string) => void;
}

export const FolderTree: React.FC<FolderTreeProps> = ({
    folders,
    currentFolder,
    onNavigate,
    onDropAsset,
    creatingIn,
    createError,
    onCreateCommit,
    onCreateCancel,
    canRemoveFolder,
    onRemoveFolder,
}) => {
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
    const [dropTarget, setDropTarget] = useState<string | null>(null);

    // Reveal the open folder, and the parent of a folder being created, when
    // either changes; the user may collapse them again afterwards.
    useEffect(() => {
        const reveal = [
            ...(currentFolder === ROOT_FOLDER ? [] : [ROOT_FOLDER, ...folderAncestors(currentFolder).slice(0, -1)]),
            ...(creatingIn === null ? [] : [ROOT_FOLDER, ...folderAncestors(creatingIn)]),
        ];
        setCollapsed((previous) => {
            if (!reveal.some((path) => previous.has(path))) return previous;
            const next = new Set(previous);
            reveal.forEach((path) => next.delete(path));
            return next;
        });
    }, [creatingIn, currentFolder]);

    const childrenOf = useMemo(() => {
        const map = new Map<string, string[]>();
        map.set(ROOT_FOLDER, childFolderPaths(folders, ROOT_FOLDER));
        folders.forEach((path) => map.set(path, childFolderPaths(folders, path)));
        return map;
    }, [folders]);

    const toggle = (path: string) => setCollapsed((previous) => {
        const next = new Set(previous);
        if (next.has(path)) next.delete(path); else next.add(path);
        return next;
    });

    const dropHandlers = (path: string) => ({
        onDragOver: (event: React.DragEvent) => {
            if (!hasAssetDrag(event.dataTransfer.types)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            if (dropTarget !== path) setDropTarget(path);
        },
        onDragLeave: (event: React.DragEvent) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setDropTarget((current) => (current === path ? null : current));
        },
        onDrop: (event: React.DragEvent) => {
            setDropTarget(null);
            if (!hasAssetDrag(event.dataTransfer.types)) return;
            event.preventDefault();
            onDropAsset(event, path);
        },
    });

    const renderRow = (path: string, depth: number): React.ReactNode => {
        const children = childrenOf.get(path) || [];
        const isRoot = path === ROOT_FOLDER;
        const isOpen = !collapsed.has(path);
        const isCurrent = path === currentFolder;
        const isDropTarget = dropTarget === path;
        const removable = !isRoot && canRemoveFolder(path);
        const hasChildren = children.length > 0 || creatingIn === path;
        return (
            <li key={path || '<root>'}>
                <div
                    {...dropHandlers(path)}
                    onClick={() => onNavigate(path)}
                    title={isRoot ? ROOT_FOLDER_LABEL : path}
                    className={`group flex items-center gap-1 pr-1 h-6 rounded cursor-pointer text-2xs select-none transition-colors ${
                        isDropTarget ? 'bg-blue-600/40 text-white ring-1 ring-blue-400'
                            : isCurrent ? 'bg-gray-700 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                    }`}
                    style={{ paddingLeft: 4 + depth * 12 }}
                >
                    <button
                        type="button"
                        aria-label={isOpen ? `Collapse ${folderLeafName(path)}` : `Expand ${folderLeafName(path)}`}
                        onClick={(event) => { event.stopPropagation(); toggle(path); }}
                        className={`w-3.5 h-3.5 flex items-center justify-center shrink-0 text-gray-500 hover:text-white ${hasChildren ? '' : 'invisible'}`}
                    >
                        {isOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                    </button>
                    {isRoot
                        ? <HardDrive size={12} className="shrink-0" />
                        : isCurrent ? <FolderOpen size={12} className="shrink-0 text-amber-300/80" /> : <Folder size={12} className="shrink-0 text-amber-300/60" />}
                    <span className="truncate flex-1">{isRoot ? ROOT_FOLDER_LABEL : folderLeafName(path)}</span>
                    {removable && (
                        <button
                            type="button"
                            aria-label={`Delete empty folder ${folderLeafName(path)}`}
                            title="Delete empty folder"
                            onClick={(event) => { event.stopPropagation(); onRemoveFolder(path); }}
                            className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-gray-500 hover:text-red-400 transition-opacity"
                        >
                            <Trash2 size={10} />
                        </button>
                    )}
                </div>
                {isOpen && hasChildren && (
                    <ul>
                        {children.map((child) => renderRow(child, depth + 1))}
                        {creatingIn === path && (
                            <li className="py-0.5" style={{ paddingLeft: 4 + (depth + 1) * 12 + 18 }}>
                                <InlineNameInput ariaLabel="New folder name" placeholder="New Folder" error={createError} onCommit={onCreateCommit} onCancel={onCreateCancel} />
                            </li>
                        )}
                    </ul>
                )}
            </li>
        );
    };

    return (
        <nav aria-label="Content folders" className="w-44 shrink-0 border-r border-white/10 overflow-y-auto custom-scrollbar py-1 px-1 bg-gray-950/30">
            <ul>{renderRow(ROOT_FOLDER, 0)}</ul>
        </nav>
    );
};
