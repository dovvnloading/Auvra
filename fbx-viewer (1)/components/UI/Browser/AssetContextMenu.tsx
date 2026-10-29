import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronLeft, FolderInput, HardDrive, Pencil, RefreshCw, Folder, Scaling } from 'lucide-react';
import { ROOT_FOLDER, ROOT_FOLDER_LABEL, depthFirstFolderOrder, folderDepth, folderLeafName, normalizeFolderPath } from './browserFolders';

export interface AssetMenuAction {
    available: boolean;
    /** Shown as the item tooltip when the action is unavailable. */
    unavailableReason?: string;
}

interface AssetContextMenuProps {
    position: { x: number; y: number };
    assetName: string;
    assetFolder: string;
    folders: string[];
    rename: AssetMenuAction;
    move: AssetMenuAction;
    /** Omitted for assets that cannot be reimported (textures, audio). */
    reimport?: AssetMenuAction;
    /** Changing an imported model's size; omitted for other assets. */
    importSize?: AssetMenuAction;
    onRename: () => void;
    onMove: (folder: string) => void;
    onReimport: () => void;
    onImportSize?: () => void;
    onClose: () => void;
}

const MENU_WIDTH = 208;

export const AssetContextMenu: React.FC<AssetContextMenuProps> = ({
    position,
    assetName,
    assetFolder,
    folders,
    rename,
    move,
    reimport,
    importSize,
    onRename,
    onMove,
    onReimport,
    onImportSize,
    onClose,
}) => {
    const [mode, setMode] = useState<'main' | 'move'>('main');
    const current = normalizeFolderPath(assetFolder);

    useEffect(() => {
        const handleKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKey);
        window.addEventListener('blur', onClose);
        return () => {
            window.removeEventListener('keydown', handleKey);
            window.removeEventListener('blur', onClose);
        };
    }, [onClose]);

    // The browser docks at the bottom of the window, so open upward from low clicks.
    const opensUp = position.y > window.innerHeight / 2;
    const style: React.CSSProperties = {
        left: Math.max(4, Math.min(position.x, window.innerWidth - MENU_WIDTH - 4)),
        width: MENU_WIDTH,
        ...(opensUp ? { bottom: Math.max(4, window.innerHeight - position.y) } : { top: position.y }),
    };

    const item = (label: string, icon: React.ReactNode, action: AssetMenuAction, onClick: () => void) => (
        <button
            type="button"
            role="menuitem"
            disabled={!action.available}
            title={action.available ? undefined : action.unavailableReason}
            onClick={onClick}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-700 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
        >
            {icon}
            <span className="flex-1">{label}</span>
        </button>
    );

    return createPortal(
        <>
            <div className="fixed inset-0 z-[9990]" onClick={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }} />
            <div
                role="menu"
                aria-label={`${assetName} actions`}
                className="fixed z-[9991] bg-gray-800 border border-gray-700 rounded-lg shadow-xl overflow-hidden py-1"
                style={style}
                onContextMenu={(event) => event.preventDefault()}
            >
                <div className="px-3 py-1.5 text-[10px] uppercase text-gray-500 font-bold tracking-wider border-b border-gray-700/50 mb-1 truncate" title={assetName}>
                    {assetName}
                </div>
                {mode === 'main' ? (
                    <>
                        {item('Rename', <Pencil size={12} />, rename, onRename)}
                        {item('Move to Folder', <FolderInput size={12} />, move, () => setMode('move'))}
                        {reimport && item('Reimport...', <RefreshCw size={12} />, reimport, onReimport)}
                        {importSize && onImportSize && item('Import Size...', <Scaling size={12} />, importSize, onImportSize)}
                    </>
                ) : (
                    <>
                        <button
                            type="button"
                            onClick={() => setMode('main')}
                            className="w-full flex items-center gap-1 px-2 py-1 text-[10px] text-gray-400 hover:text-white"
                        >
                            <ChevronLeft size={12} /> Back
                        </button>
                        <div className="max-h-48 overflow-y-auto custom-scrollbar">
                            {[ROOT_FOLDER, ...depthFirstFolderOrder(folders)].map((folder) => {
                                const isCurrent = folder === current;
                                return (
                                    <button
                                        key={folder || '<root>'}
                                        type="button"
                                        role="menuitem"
                                        disabled={isCurrent}
                                        onClick={() => onMove(folder)}
                                        title={folder || ROOT_FOLDER_LABEL}
                                        className="w-full flex items-center gap-2 pr-3 py-1 text-left text-xs text-gray-300 hover:bg-gray-700 hover:text-white disabled:text-gray-500 disabled:hover:bg-transparent"
                                        style={{ paddingLeft: 12 + folderDepth(folder) * 10 }}
                                    >
                                        {folder === ROOT_FOLDER ? <HardDrive size={11} /> : <Folder size={11} className="text-amber-300/60" />}
                                        <span className="truncate flex-1">{folderLeafName(folder)}</span>
                                        {isCurrent && <Check size={11} />}
                                    </button>
                                );
                            })}
                        </div>
                    </>
                )}
            </div>
        </>,
        document.body,
    );
};
