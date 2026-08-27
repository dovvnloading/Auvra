
import React, { useState, useEffect } from 'react';
import { X, RefreshCw, AlertTriangle, ArrowRight, Check, Undo2, Save } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import { extractTextureFromModel } from '../../utils/textureUtils';
import { useTextureGeneration } from '../../hooks/useTextureGeneration';
import { useNotification } from '../../context/NotificationContext';

interface RetextureToolProps {
  onClose: () => void;
}

export const RetextureTool: React.FC<RetextureToolProps> = ({ onClose }) => {
  const { models, selectedModelId, retextureModel, saveTextureToLibrary } = useScene();
  const { addNotification } = useNotification();
  const selectedModel = models.find(m => m.id === selectedModelId);
  
  // Custom Hook manages all async logic and state
  const {
    currentTextureBase64,
    generatedTextureUrl,
    isGenerating,
    error,
    setCurrentTexture,
    generate,
    apply,
    discard
  } = useTextureGeneration();

  const [prompt, setPrompt] = useState('');

  // 1. Sync hook state with scene selection
  useEffect(() => {
    if (isGenerating || generatedTextureUrl) return;

    if (selectedModel) {
       const b64 = extractTextureFromModel(selectedModel.object);
       setCurrentTexture(b64);
    } else {
       setCurrentTexture(null);
    }
  }, [selectedModel, setCurrentTexture, isGenerating, generatedTextureUrl]);

  // 2. Auto-Preview Effect
  useEffect(() => {
    if (!selectedModel) return;

    if (generatedTextureUrl) {
        retextureModel(selectedModel.id, generatedTextureUrl);
    } else if (currentTextureBase64) {
        retextureModel(selectedModel.id, currentTextureBase64);
    }
  }, [generatedTextureUrl, selectedModel?.id, retextureModel]);

  const handleApply = () => {
    if (selectedModel) {
        apply();
        addNotification({ message: "Texture applied.", type: 'info' });
    }
  };

  const handleSave = async () => {
    if (selectedModel && generatedTextureUrl) {
        await saveTextureToLibrary(generatedTextureUrl, `AI_${selectedModel.name}_${Date.now().toString().slice(-4)}`);
    }
  };

  if (!selectedModel) return null;

  // Determine what image to show: generated preview or current
  const displayImage = generatedTextureUrl || currentTextureBase64;
  const isPreviewing = !!generatedTextureUrl;

  return (
    <div className="absolute top-14 right-4 w-80 bg-gray-900 border border-gray-700 shadow-2xl rounded-lg flex flex-col z-40 overflow-hidden animate-in fade-in slide-in-from-top-4 duration-200">
        
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-gray-850">
            <span className="text-xs font-bold text-gray-200 tracking-wide flex items-center gap-2">
                GENERATIVE RETEXTURE
            </span>
            <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
                <X size={14} />
            </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
            
            {/* Preview Area */}
            <div className="texture-preview-surface aspect-square bg-gray-950 rounded border border-gray-800 relative group overflow-hidden">
                {displayImage ? (
                    <img 
                        src={displayImage} 
                        alt="Texture Map" 
                        className="w-full h-full object-contain"
                    />
                ) : (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-600 p-4 text-center gap-2">
                         <AlertTriangle size={24} />
                         <span className="text-xs">No texture map found on selected model.</span>
                    </div>
                )}
                
                {isPreviewing && (
                    <div className="absolute top-2 left-2 bg-blue-500 text-white text-[10px] font-bold px-2 py-0.5 rounded shadow-lg">
                        PREVIEW
                    </div>
                )}

                {isGenerating && (
                    <div className="absolute inset-0 bg-gray-900/80 backdrop-blur-sm flex items-center justify-center z-10">
                        <div className="flex flex-col items-center gap-2">
                            <RefreshCw size={24} className="animate-spin text-blue-400" />
                            <span className="text-xs font-mono text-blue-200">Processing...</span>
                        </div>
                    </div>
                )}
            </div>

            {/* Controls */}
            {isPreviewing ? (
                 <div className="space-y-2 animate-in fade-in slide-in-from-bottom-2 duration-200">
                     <button
                        onClick={handleSave}
                        className="w-full py-2 px-3 rounded text-xs font-bold flex items-center justify-center gap-2 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors border border-gray-700"
                     >
                         <Save size={12} /> Save to Library
                     </button>
                     <div className="grid grid-cols-2 gap-2">
                        <button
                            onClick={discard}
                            className="py-2 px-3 rounded text-xs font-bold flex items-center justify-center gap-2 bg-red-900/20 text-red-400 border border-red-900/50 hover:bg-red-900/40 transition-colors"
                        >
                            <Undo2 size={12} /> Discard
                        </button>
                        <button
                            onClick={handleApply}
                            className="py-2 px-3 rounded text-xs font-bold flex items-center justify-center gap-2 bg-green-600 text-white hover:bg-green-500 shadow-lg shadow-green-900/20 transition-colors"
                        >
                            <Check size={12} /> Apply
                        </button>
                     </div>
                 </div>
            ) : (
                <div className="space-y-3">
                    <div className="space-y-1">
                        <label className="text-[10px] uppercase font-bold text-gray-500 tracking-wider">
                            Material Prompt
                        </label>
                        <textarea 
                            className="w-full bg-gray-950 border border-gray-700 rounded p-2 text-xs text-gray-200 focus:outline-none focus:border-blue-500/50 resize-none h-20 placeholder:text-gray-600"
                            placeholder="e.g. Rusted iron with scratches, Mossy stone brick..."
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            disabled={!currentTextureBase64 || isGenerating}
                        />
                    </div>

                    {error && (
                        <div className="text-[10px] text-red-400 bg-red-900/20 p-2 rounded border border-red-900/50">
                            {error}
                        </div>
                    )}

                    <button
                        onClick={() => {
                            if (currentTextureBase64) {
                                generate(prompt, currentTextureBase64);
                            }
                        }}
                        disabled={!currentTextureBase64 || !prompt || isGenerating}
                        className={`
                            w-full py-2 px-4 rounded text-xs font-bold flex items-center justify-center gap-2 transition-all
                            ${!currentTextureBase64 || !prompt || isGenerating 
                                ? 'bg-gray-800 text-gray-500 cursor-not-allowed' 
                                : 'bg-white text-black hover:bg-gray-200 shadow-lg shadow-white/5'
                            }
                        `}
                    >
                        <span>Generate Material</span>
                        {!isGenerating && <ArrowRight size={12} />}
                    </button>
                </div>
            )}
            
            <p className="text-[9px] text-gray-600 text-center leading-relaxed">
                Texture is previewed on model immediately. <br/>Save to Library to use in Blueprints.
            </p>
        </div>
    </div>
  );
};
