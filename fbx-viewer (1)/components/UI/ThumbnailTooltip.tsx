
import React from 'react';
import { createPortal } from 'react-dom';
import { LoadedModelData } from '../../types';

interface ThumbnailTooltipProps {
    model: LoadedModelData;
    position: { x: number; y: number };
}

export const ThumbnailTooltip: React.FC<ThumbnailTooltipProps> = ({ model, position }) => {
    // Portal to body to ensure it floats above everything
    return createPortal(
        <div 
            className="fixed z-[9999] pointer-events-none rounded-xl overflow-hidden border border-gray-600 bg-gray-900 shadow-2xl animate-in fade-in zoom-in-95 duration-200"
            style={{ 
                left: position.x, 
                top: position.y,
                width: 240, // Slightly wider for better presentation
                height: 240,
                transform: 'translate(-50%, -115%)' // Position above cursor
            }}
        >
            <div className="absolute top-2 left-0 right-0 text-center z-10">
                <span className="bg-black/60 backdrop-blur-md text-[10px] text-white px-2 py-0.5 rounded-full border border-white/10 font-medium">
                    {model.category}
                </span>
            </div>
            
            <div className="h-full w-full bg-[#171717] flex items-center justify-center">
                {model.thumbnail ? (
                    <img src={model.thumbnail} alt={`${model.name} thumbnail`} className="h-full w-full object-contain" />
                ) : (
                    <div className="text-[10px] uppercase tracking-widest text-gray-500">No preview available</div>
                )}
            </div>
            
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-3 pt-8">
                <div className="text-xs font-bold text-white text-center truncate tracking-wide">{model.name}</div>
            </div>
        </div>,
        document.body
    );
};
