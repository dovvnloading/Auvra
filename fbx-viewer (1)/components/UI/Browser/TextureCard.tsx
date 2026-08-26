
import React from 'react';
import { Palette, Trash2, Maximize2 } from 'lucide-react';
import { TextureData } from '../../../types';

interface TextureCardProps {
    texture: TextureData;
    onDelete: () => void;
}

export const TextureCard: React.FC<TextureCardProps> = ({ texture, onDelete }) => {
    return (
        <div className="group relative flex flex-col gap-1 cursor-pointer">
            <div className="aspect-square bg-gray-800 rounded-md border border-gray-700 overflow-hidden group-hover:border-white transition-all shadow-sm relative">
                
                {/* Texture Image */}
                <div className="w-full h-full bg-[url('https://transparenttextures.com/patterns/dark-matter.png')]">
                    <img
                        src={texture.url}
                        alt={texture.name}
                        className="w-full h-full object-contain"
                    />
                </div>

                {/* Type Badge */}
                <div className="absolute top-1 right-1 p-1 bg-gray-900/80 backdrop-blur rounded text-gray-400">
                    <Palette size={10} />
                </div>

                {/* Resolution Badge */}
                <div className="absolute bottom-1 left-1 px-1.5 py-0.5 bg-black/60 backdrop-blur rounded text-[8px] text-gray-300 font-mono">
                    {texture.dimensions.width}x{texture.dimensions.height}
                </div>

                {/* Actions Overlay */}
                <div className="absolute inset-0 bg-black/60 backdrop-blur-[1px] opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-2">
                    <a 
                        href={texture.url} 
                        target="_blank" 
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="p-2 bg-gray-700 hover:bg-gray-600 text-white rounded-full transition-colors"
                        title="View Full Size"
                    >
                        <Maximize2 size={14} />
                    </a>
                    <button
                        onClick={(e) => { e.stopPropagation(); onDelete(); }}
                        className="p-2 bg-red-600 hover:bg-red-500 text-white rounded-full transition-colors"
                        title="Delete Texture"
                    >
                        <Trash2 size={14} />
                    </button>
                </div>
            </div>
            <span className="text-[11px] truncate px-0.5 text-center text-gray-400 group-hover:text-white">
                {texture.name}
            </span>
        </div>
    );
};
