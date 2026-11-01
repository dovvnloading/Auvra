import React, { useState } from 'react';
import { ChevronRight, HardDrive } from 'lucide-react';
import { ROOT_FOLDER, ROOT_FOLDER_LABEL, folderAncestors, folderLeafName, hasAssetDrag } from './browserFolders';

interface BreadcrumbBarProps {
    currentFolder: string;
    isSearching: boolean;
    onNavigate: (path: string) => void;
    onDropAsset: (event: React.DragEvent, folder: string) => void;
}

export const BreadcrumbBar: React.FC<BreadcrumbBarProps> = ({ currentFolder, isSearching, onNavigate, onDropAsset }) => {
    const [dropTarget, setDropTarget] = useState<string | null>(null);
    const crumbs = [ROOT_FOLDER, ...folderAncestors(currentFolder)];
    return (
        <div className="h-7 shrink-0 flex items-center gap-0.5 px-3 border-b border-white/5 text-2xs text-gray-400 overflow-x-auto custom-scrollbar">
            {crumbs.map((path, index) => {
                const isLast = index === crumbs.length - 1;
                return (
                    <React.Fragment key={path || '<root>'}>
                        {index > 0 && <ChevronRight size={11} className="shrink-0 text-gray-600" />}
                        <button
                            type="button"
                            onClick={() => onNavigate(path)}
                            onDragOver={(event) => {
                                if (!hasAssetDrag(event.dataTransfer.types)) return;
                                event.preventDefault();
                                event.dataTransfer.dropEffect = 'move';
                                setDropTarget(path);
                            }}
                            onDragLeave={() => setDropTarget((current) => (current === path ? null : current))}
                            onDrop={(event) => {
                                setDropTarget(null);
                                if (!hasAssetDrag(event.dataTransfer.types)) return;
                                event.preventDefault();
                                onDropAsset(event, path);
                            }}
                            className={`flex items-center gap-1 px-1.5 py-0.5 rounded whitespace-nowrap transition-colors ${
                                dropTarget === path ? 'bg-blue-600/40 text-white'
                                    : isLast ? 'text-white font-medium' : 'hover:bg-gray-800 hover:text-gray-200'
                            }`}
                        >
                            {path === ROOT_FOLDER && <HardDrive size={11} />}
                            {path === ROOT_FOLDER ? ROOT_FOLDER_LABEL : folderLeafName(path)}
                        </button>
                    </React.Fragment>
                );
            })}
            {isSearching && <span className="ml-2 text-2xs text-gray-500 whitespace-nowrap">Searching this folder and its subfolders</span>}
        </div>
    );
};
