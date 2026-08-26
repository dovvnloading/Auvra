import React from 'react';
import { RotateCcw, Move3d, MousePointer2, Gamepad2 } from 'lucide-react';

interface ViewControlsProps {
  mode: 'orbit' | 'free';
  setMode: (mode: 'orbit' | 'free') => void;
  onReset: () => void;
}

export const ViewControls: React.FC<ViewControlsProps> = ({ mode, setMode, onReset }) => {
  return (
    <div className="absolute top-6 right-6 flex flex-col items-end gap-3 z-30 pointer-events-auto">
        
        {/* Mode Switcher */}
        <div className="bg-gray-900/90 backdrop-blur-sm border border-gray-700 rounded-lg p-1 flex gap-1 shadow-xl">
            <button
                onClick={() => setMode('orbit')}
                className={`
                    flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-all
                    ${mode === 'orbit' ? 'bg-gray-700 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'}
                `}
            >
                <Move3d size={14} />
                Orbit
            </button>
            <button
                onClick={() => setMode('free')}
                className={`
                    flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-all
                    ${mode === 'free' ? 'bg-gray-700 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'}
                `}
            >
                <Gamepad2 size={14} />
                Free Cam
            </button>
        </div>

        {/* Controls / Info */}
        {mode === 'free' && (
            <div className="bg-gray-900/80 backdrop-blur-sm border border-gray-700 rounded-lg p-3 text-[10px] text-gray-400 space-y-1 shadow-xl max-w-[200px]">
                <div className="flex items-center gap-2 text-white font-semibold mb-1">
                    <MousePointer2 size={12} />
                    <span>Controls</span>
                </div>
                <div className="flex justify-between"><span>Hold Right Click</span> <span className="text-gray-200">Look</span></div>
                <div className="flex justify-between"><span>W A S D</span> <span className="text-gray-200">Move</span></div>
                <div className="flex justify-between"><span>Q / E</span> <span className="text-gray-200">Up / Down</span></div>
                <div className="flex justify-between"><span>Shift</span> <span className="text-gray-200">Fast</span></div>
            </div>
        )}

        {/* Reset View */}
        <button 
            onClick={onReset}
            className="flex items-center gap-2 px-3 py-1.5 bg-gray-900/90 hover:bg-gray-800 text-gray-400 hover:text-white rounded-lg text-xs font-medium transition-colors border border-gray-700 shadow-xl"
            title="Reset Camera Position"
        >
            <RotateCcw size={14} />
            Reset View
        </button>
    </div>
  );
};