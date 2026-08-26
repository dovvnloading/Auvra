
import React from 'react';
import { Component, User, Image, Swords, Film, Eye } from 'lucide-react';
import { LoadedModelData, AssetCategory } from '../../../types';

interface ModelCardProps {
    model: LoadedModelData;
    onSelect: () => void;
    onPlaceInScene: () => void;
    onHoverStart: (model: LoadedModelData) => void;
    onHoverEnd: () => void;
}

export const ModelCard: React.FC<ModelCardProps> = ({
    model,
    onSelect,
    onPlaceInScene,
    onHoverStart,
    onHoverEnd
}) => {
    // Helper to render correct icon
    const getIcon = (category: AssetCategory) => {
        switch (category) {
            case 'Character': return <User size={10} />;
            case 'Prop': return <Component size={10} />;
            case 'Environment': return <Image size={10} />;
            case 'Weapon': return <Swords size={10} />;
            case 'Animation': return <Film size={10} />;
            default: return <Component size={10} />;
        }
    };

    return (
        <div
            onMouseEnter={() => onHoverStart(model)}
            onMouseLeave={onHoverEnd}
            className="group relative flex flex-col gap-1 cursor-default"
        >
            <div className={`
                aspect-square bg-gray-800 rounded-md border overflow-hidden transition-all shadow-sm relative
                ${model.isPlacedInScene ? 'border-blue-500/50' : 'border-gray-700 group-hover:border-white'}
            `}>
                {model.thumbnail ? (
                    <img
                        src={model.thumbnail}
                        alt={model.name}
                        className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity grayscale"
                    />
                ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-600 group-hover:text-gray-500 transition-colors">
                        {model.category === 'Animation' ? <Film size={32} /> : <Component size={32} />}
                    </div>
                )}

                {/* Type Badge */}
                <div className="absolute top-1 right-1 p-1 bg-gray-900/80 backdrop-blur rounded text-gray-400">
                    {getIcon(model.category)}
                </div>

                {/* Placed Indicator */}
                {model.isPlacedInScene && (
                    <div className="absolute top-1 left-1 p-1 bg-blue-900/80 backdrop-blur rounded text-blue-400 border border-blue-800">
                        <Eye size={10} />
                    </div>
                )}

                {/* Add To Scene Overlay (Hidden for Animations) */}
                {model.category !== 'Animation' && (
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-[1px] opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-2">
                        {!model.isPlacedInScene ? (
                            <button
                                onClick={(e) => { e.stopPropagation(); onPlaceInScene(); }}
                                className="px-3 py-1.5 bg-white hover:bg-blue-500 hover:text-white text-black text-[10px] font-bold rounded shadow-lg transition-all transform hover:scale-105"
                            >
                                Add to Scene
                            </button>
                        ) : (
                            <button
                                onClick={(e) => { e.stopPropagation(); onSelect(); }}
                                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-bold rounded shadow-lg transition-all"
                            >
                                Select
                            </button>
                        )}
                    </div>
                )}
            </div>
            <span className={`text-[11px] truncate px-0.5 text-center ${model.isPlacedInScene ? 'text-blue-400 font-medium' : 'text-gray-400 group-hover:text-white'}`}>
                {model.name}
            </span>
        </div>
    );
};
