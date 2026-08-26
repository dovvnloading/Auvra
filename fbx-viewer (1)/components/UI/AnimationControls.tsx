import React, { useMemo } from 'react';
import * as THREE from 'three';
import { Play, Pause, Film, StopCircle, Plus, CornerDownRight } from 'lucide-react';
import { LoadedModelData } from '../../types';
import { useScene } from '../../context/SceneContext';

interface AnimationControlsProps {
  model: LoadedModelData | null;
  activeClip: THREE.AnimationClip | null;
  isPlaying: boolean;
  timeScale: number;
  onAnimationSelect: (clip: THREE.AnimationClip | null) => void;
  onPlayPause: () => void;
  onSpeedChange: (speed: number) => void;
}

export const AnimationControls: React.FC<AnimationControlsProps> = ({
  model,
  activeClip,
  isPlaying,
  timeScale,
  onAnimationSelect,
  onPlayPause,
  onSpeedChange
}) => {
  const { models, addAnimations, isLoading } = useScene();

  if (!model) return null;

  // Aggregate animations from the current model and all other models in the scene
  const allClips = useMemo(() => {
    const list: { clip: THREE.AnimationClip; sourceModelId: string; sourceModelName: string }[] = [];
    
    // 1. Current Model Animations
    if (model.animations) {
        model.animations.forEach(clip => {
            list.push({ clip, sourceModelId: model.id, sourceModelName: 'This Model' });
        });
    }

    // 2. Animations from other loaded models
    models.forEach(m => {
        if (m.id !== model.id && m.animations) {
            m.animations.forEach(clip => {
                list.push({ clip, sourceModelId: m.id, sourceModelName: m.name });
            });
        }
    });

    return list;
  }, [models, model]);

  const hasAnimations = allClips.length > 0;

  const handleAnimationUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0 && model) {
      addAnimations(Array.from(e.target.files), model.id);
    }
    e.target.value = ''; 
  };

  return (
    <div className="bg-gray-900 border-t border-gray-800">
      <div className="p-4 space-y-4">
        
        {/* Header & Playback */}
        <div className="flex items-center justify-between">
           <div className="flex items-center gap-2 text-gray-400">
             <Film size={14} />
             <span className="text-xs font-semibold tracking-wider">ANIMATION</span>
           </div>
           
           <div className="flex items-center bg-gray-800 rounded-lg p-0.5 border border-gray-700">
             <button 
                onClick={() => onSpeedChange(0.5)}
                disabled={!hasAnimations}
                className={`text-[10px] px-2 py-1 rounded transition-colors ${timeScale === 0.5 ? 'bg-white text-black shadow-sm' : 'text-gray-400 hover:text-gray-200'}`}
             >0.5x</button>
             <div className="w-px h-3 bg-gray-700 mx-0.5"></div>
             <button 
                onClick={() => onSpeedChange(1.5)}
                disabled={!hasAnimations}
                className={`text-[10px] px-2 py-1 rounded transition-colors ${timeScale === 1.5 ? 'bg-white text-black shadow-sm' : 'text-gray-400 hover:text-gray-200'}`}
             >1.5x</button>
           </div>
        </div>

        {/* Play Button Big */}
        <button 
            onClick={onPlayPause}
            disabled={!hasAnimations || !activeClip}
            className={`
                w-full py-2.5 flex items-center justify-center gap-2 rounded-md font-medium text-sm transition-all
                ${isPlaying 
                    ? 'bg-gray-800 text-white border border-gray-700 hover:bg-gray-700' 
                    : 'bg-white text-black shadow-lg shadow-gray-900/20 hover:bg-gray-200'
                }
                ${(!hasAnimations || !activeClip) && 'opacity-50 cursor-not-allowed grayscale'}
            `}
        >
            {isPlaying ? (
                <><Pause size={16} /> Pause</>
            ) : (
                <><Play size={16} /> Play</>
            )}
        </button>

        {/* Animation List - Fixed Height Container */}
        <div className="space-y-2">
            <div className="flex items-center justify-between px-1">
                <div className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">
                    Clips ({allClips.length})
                </div>
                
                {/* Import Animation Button */}
                <label className={`
                    flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 
                    text-gray-400 hover:text-white cursor-pointer transition-colors border border-gray-700
                    ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}
                `}>
                    <Plus size={10} />
                    <span>Import Clips</span>
                    <input 
                        type="file" 
                        accept=".fbx" 
                        multiple
                        className="hidden" 
                        onChange={handleAnimationUpload}
                        disabled={isLoading}
                    />
                </label>
            </div>
            
            <div className="h-48 overflow-y-auto pr-1 space-y-1 custom-scrollbar bg-gray-950/50 rounded-lg p-1.5 border border-gray-800/50 inner-shadow">
                {/* T-Pose / Reset Option */}
                <button
                    onClick={() => onAnimationSelect(null)}
                    className={`
                    w-full text-left px-3 py-2 rounded-md text-xs transition-all flex items-center justify-between group border
                    ${!activeClip
                        ? 'bg-gray-800 text-white border-gray-600'
                        : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200 border-transparent hover:border-gray-700'
                    }
                    `}
                >
                    <span className="truncate flex-1 mr-2 flex items-center gap-2">
                        <StopCircle size={12} />
                        T-Pose / Reset
                    </span>
                    {!activeClip && <div className="w-1.5 h-1.5 rounded-full bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)]"></div>}
                </button>

                {allClips.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-gray-600 text-xs italic gap-1 mt-4">
                        <Film size={20} className="opacity-20" />
                        No animations found
                    </div>
                ) : (
                    allClips.map((item, idx) => {
                        const isActive = activeClip === item.clip;
                        const isExternal = item.sourceModelId !== model.id;
                        
                        return (
                            <button
                                key={`${item.sourceModelId}-${idx}`}
                                onClick={() => onAnimationSelect(item.clip)}
                                className={`
                                    w-full text-left px-3 py-2 rounded-md text-xs transition-all flex flex-col gap-0.5 group border
                                    ${isActive
                                    ? 'bg-gray-800 text-white border-gray-600'
                                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200 border-transparent hover:border-gray-700'
                                    }
                                `}
                            >
                                <div className="flex items-center justify-between w-full">
                                    <span className="truncate flex-1 font-medium" title={item.clip.name}>
                                        {item.clip.name}
                                    </span>
                                    {isActive && <div className="w-1.5 h-1.5 rounded-full bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)] shrink-0 ml-2"></div>}
                                </div>
                                
                                {isExternal && (
                                    <div className="flex items-center gap-1 text-[9px] text-gray-500 group-hover:text-gray-400">
                                        <CornerDownRight size={10} />
                                        <span className="truncate">From: {item.sourceModelName}</span>
                                    </div>
                                )}
                            </button>
                        );
                    })
                )}
            </div>
        </div>
      </div>
    </div>
  );
};