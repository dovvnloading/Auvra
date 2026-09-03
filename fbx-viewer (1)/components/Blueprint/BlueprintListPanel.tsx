import React from 'react';
import { FileCode, Shield, Skull, Trash2 } from 'lucide-react';
import { Blueprint, BlueprintType } from '../../types';

interface BlueprintListPanelProps {
    blueprints: Blueprint[];
    selectedId: string | null;
    onSelect: (id: string) => void;
    onAdd: (type: BlueprintType) => void;
    isCreatingPlayer: boolean;
    onRemove: (id: string) => void;
}

export const BlueprintListPanel: React.FC<BlueprintListPanelProps> = ({
    blueprints,
    selectedId,
    onSelect,
    onAdd,
    isCreatingPlayer,
    onRemove
}) => {
    const hasPlayerCharacter = blueprints.some(bp => bp.type === 'Player Character');

    return (
        <div className="w-64 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0 z-20">
            <div className="p-3 border-b border-gray-800 shrink-0 flex items-center justify-between bg-gray-950">
                <span className="text-xs font-bold text-gray-400 tracking-wider flex items-center gap-2">
                    <FileCode size={12} /> FILE MANAGER
                </span>
                <div className="flex gap-1">
                    {!hasPlayerCharacter && (
                        <button 
                            onClick={() => onAdd('Player Character')} 
                            disabled={isCreatingPlayer}
                            className="p-1 hover:bg-gray-800 rounded text-blue-400 hover:text-white transition-colors" 
                            title="New Player"
                        >
                            <Shield size={12} />
                        </button>
                    )}
                    <button 
                        onClick={() => onAdd('Enemy Controller')} 
                        className="p-1 hover:bg-gray-800 rounded text-red-400 hover:text-white transition-colors" 
                        title="New Enemy"
                    >
                        <Skull size={12} />
                    </button>
                </div>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
                {blueprints.map(bp => (
                    <div 
                        key={bp.id}
                        onClick={() => onSelect(bp.id)}
                        className={`
                            group flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-all border relative
                            ${selectedId === bp.id 
                                ? 'bg-gray-800 text-white border-gray-700 shadow-lg' 
                                : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200 border-transparent'
                            }
                        `}
                    >
                        {bp.type === 'Player Character' 
                            ? <Shield size={16} className={selectedId === bp.id ? "text-blue-400" : "text-gray-600"} /> 
                            : <Skull size={16} className={selectedId === bp.id ? "text-red-400" : "text-gray-600"} />
                        }
                        <div className="flex-1 min-w-0">
                            <div className="text-xs font-bold truncate">{bp.name}</div>
                            <div className="text-[9px] text-gray-500 truncate">{bp.type.replace(' Controller', '').replace(' Character', '')}</div>
                        </div>

                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                onRemove(bp.id);
                            }}
                            className="opacity-0 group-hover:opacity-100 p-1.5 text-gray-500 hover:text-red-400 hover:bg-gray-900 rounded transition-all"
                            title="Delete Blueprint"
                        >
                            <Trash2 size={12} />
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
};
