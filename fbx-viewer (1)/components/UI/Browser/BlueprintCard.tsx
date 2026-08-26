
import React from 'react';
import { Shield, Skull } from 'lucide-react';
import { Blueprint } from '../../../types';

interface BlueprintCardProps {
    blueprint: Blueprint;
    onSelect: () => void;
}

export const BlueprintCard: React.FC<BlueprintCardProps> = ({ blueprint, onSelect }) => {
    return (
        <div
            onClick={onSelect}
            className="group relative flex flex-col gap-1 cursor-pointer"
        >
            <div className="aspect-[4/3] bg-gray-800 rounded-md border border-gray-700 overflow-hidden group-hover:border-blue-500 transition-colors shadow-sm relative flex flex-col items-center justify-center p-4">
                {blueprint.type === 'Player Character'
                    ? <Shield size={32} className="text-gray-600 group-hover:text-blue-400 transition-colors" />
                    : <Skull size={32} className="text-gray-600 group-hover:text-red-400 transition-colors" />
                }
                <div className="absolute top-2 right-2 flex flex-col gap-1">
                    <span className="text-[8px] uppercase font-bold text-gray-500 bg-gray-900/80 px-1 rounded border border-gray-700">
                        {blueprint.type === 'Player Character' ? 'PLAYER' : 'AI'}
                    </span>
                </div>
            </div>
            <span className="text-[11px] font-bold text-gray-300 group-hover:text-white truncate px-0.5 text-center">
                {blueprint.name}
            </span>
        </div>
    );
};
