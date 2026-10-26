import React, { useState } from 'react';
import { Folder } from 'lucide-react';
import { folderLeafName, hasAssetDrag } from './browserFolders';

interface FolderCardProps {
    path: string;
    itemCount: number;
    onOpen: () => void;
    onDropAsset: (event: React.DragEvent) => void;
}

export const FolderCard: React.FC<FolderCardProps> = ({ path, itemCount, onOpen, onDropAsset }) => {
    const [isDropTarget, setIsDropTarget] = useState(false);
    const name = folderLeafName(path);
    return (
        <button
            type="button"
            onClick={onOpen}
            title={`${path} (${itemCount} ${itemCount === 1 ? 'item' : 'items'})`}
            aria-label={`Open folder ${name}`}
            onDragOver={(event) => {
                if (!hasAssetDrag(event.dataTransfer.types)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setIsDropTarget(true);
            }}
            onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                setIsDropTarget(false);
            }}
            onDrop={(event) => {
                setIsDropTarget(false);
                if (!hasAssetDrag(event.dataTransfer.types)) return;
                event.preventDefault();
                onDropAsset(event);
            }}
            className="group relative flex flex-col gap-1 text-left"
        >
            <div className={`aspect-square w-full rounded-md border flex items-center justify-center transition-all shadow-sm ${
                isDropTarget ? 'bg-blue-600/30 border-blue-400' : 'bg-gray-800/60 border-gray-700 group-hover:border-white'
            }`}>
                <Folder size={40} className={`transition-colors ${isDropTarget ? 'text-blue-200' : 'text-amber-300/60 group-hover:text-amber-200'}`} />
                <span className="absolute bottom-6 right-1.5 px-1.5 py-0.5 bg-black/60 rounded text-[8px] text-gray-300 font-mono">{itemCount}</span>
            </div>
            <span className="text-[11px] truncate px-0.5 text-center text-gray-400 group-hover:text-white">{name}</span>
        </button>
    );
};
