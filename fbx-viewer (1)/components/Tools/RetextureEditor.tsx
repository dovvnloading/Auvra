
import React, { useState, useMemo, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { Environment, Center, OrbitControls, Grid, ContactShadows } from '@react-three/drei';
import { Brush, RefreshCw, Check, Undo2, ArrowRight, AlertTriangle, Search, Box, Layers, Image as ImageIcon, Edit3, Trash2, RotateCcw, Repeat, Wand2, Sparkles, Save, Link, Download } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import { useTextureGeneration } from '../../hooks/useTextureGeneration';
import { extractTextureFromModel } from '../../utils/textureUtils';
import { LoadedModelData } from '../../types';
import { loadFBXFile } from '../../utils/modelLoader';
import { disposeObject } from '../../utils/processing/ModelLifecycle';
import { useNotification } from '../../context/NotificationContext';

const ModelList: React.FC<{
    models: LoadedModelData[];
    selectedId: string | null;
    onSelect: (id: string) => void;
}> = ({ models, selectedId, onSelect }) => {
    const [search, setSearch] = useState('');
    
    // Filter only valid meshes (exclude animations)
    const filtered = models.filter(m => 
        m.category !== 'Animation' && 
        m.name.toLowerCase().includes(search.toLowerCase())
    );

    return (
        <div className="w-80 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0 z-20 shadow-xl">
            <div className="p-4 border-b border-gray-800 shrink-0">
                <h1 className="text-sm font-bold text-gray-200 tracking-wide flex items-center gap-2">
                    <Layers size={14} className="text-gray-400" /> ASSETS
                </h1>
            </div>
            
            <div className="p-2 border-b border-gray-800 bg-gray-900">
                <div className="relative">
                    <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
                    <input 
                        type="text" 
                        placeholder="Filter models..." 
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="w-full bg-gray-900 border border-gray-700 rounded-md py-1.5 pl-8 pr-4 text-xs text-gray-300 focus:outline-none focus:border-blue-500 transition-colors placeholder-gray-600"
                    />
                </div>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
                {filtered.length === 0 && (
                    <div className="text-center py-8 text-gray-600 text-xs italic">No models found.</div>
                )}
                {filtered.map(m => (
                    <div 
                        key={m.id}
                        onClick={() => onSelect(m.id)}
                        className={`
                            flex items-center gap-3 px-2 py-2 rounded-md cursor-pointer transition-all border
                            ${selectedId === m.id 
                                ? 'bg-blue-900/20 border-blue-500/30' 
                                : 'hover:bg-gray-800 border-transparent'
                            }
                        `}
                    >
                        <div className="w-10 h-10 rounded bg-gray-800 overflow-hidden border border-gray-700 flex items-center justify-center shrink-0">
                            {m.thumbnail ? (
                                <img src={m.thumbnail} className="w-full h-full object-cover" />
                            ) : (
                                <Box size={16} className="text-gray-600" />
                            )}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className={`text-xs font-bold truncate ${selectedId === m.id ? 'text-white' : 'text-gray-400'}`}>{m.name}</div>
                            <div className="text-[9px] text-gray-600 uppercase">{m.category}</div>
                        </div>
                        {selectedId === m.id && <Edit3 size={12} className="text-blue-400" />}
                    </div>
                ))}
            </div>
        </div>
    );
};

export const RetextureEditor: React.FC = () => {
    const { models, retextureModel, saveTextureToLibrary } = useScene();
    const { addNotification } = useNotification();
    
    const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
    const [prompt, setPrompt] = useState('');
    const canvasRef = useRef<HTMLCanvasElement>(null); // For future mask painting

    const selectedModel = useMemo(() => models.find(m => m.id === selectedModelId), [models, selectedModelId]);

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

    // 1. Sync Selection -> Current Texture
    useEffect(() => {
        // If we are previewing or generating, DO NOT update the current texture from the model,
        // as the model currently displays the dirty/preview state.
        if (generatedTextureUrl || isGenerating) return;

        if (selectedModel) {
            const b64 = extractTextureFromModel(selectedModel.object);
            setCurrentTexture(b64);
        } else {
            setCurrentTexture(null);
        }
    }, [selectedModel, setCurrentTexture, generatedTextureUrl, isGenerating]);

    // 2. Auto-Preview Logic
    useEffect(() => {
        if (!selectedModel) return;

        if (generatedTextureUrl) {
            // Apply preview immediately to mesh
            retextureModel(selectedModel.id, generatedTextureUrl);
        } else if (currentTextureBase64) {
            // Revert to original if preview is cleared (discarded)
            // If we just Applied, currentTextureBase64 is updated to the new one, so this effectively commits it visually too
            retextureModel(selectedModel.id, currentTextureBase64);
        }
    }, [generatedTextureUrl, selectedModel?.id, retextureModel]);

    const handleGenerate = () => {
        if (currentTextureBase64 && prompt) {
            generate(prompt, currentTextureBase64);
        }
    };

    const handleSave = async () => {
        if (selectedModel && generatedTextureUrl) {
            await saveTextureToLibrary(generatedTextureUrl, `AI_${selectedModel.name}_${Date.now().toString().slice(-4)}`);
        }
    };

    const handleApply = () => {
        // Promote generated texture to "current", clearing the preview flag
        apply();
        // We do NOT auto-save to library here, respecting user preference for decoupling.
        addNotification({ message: "Texture applied to session model.", type: 'info' });
    };

    return (
        <div className="flex h-full w-full bg-gray-950 text-white font-sans overflow-hidden">
            
            {/* Left: Models */}
            <ModelList 
                models={models} 
                selectedId={selectedModelId}
                onSelect={setSelectedModelId}
            />

            {/* Center: Viewport */}
            <div className="flex-1 bg-[#0a0a0a] relative flex flex-col min-w-0">
                {selectedModel ? (
                    <>
                        <Canvas shadows camera={{ position: [2, 2, 4], fov: 45 }} className="flex-1">
                            <color attach="background" args={['#0a0a0a']} />
                            <Environment preset="city" blur={0.8} />
                            
                            <group>
                                <Center>
                                    <primitive object={selectedModel.object} />
                                </Center>
                                <ContactShadows opacity={0.4} scale={10} blur={2} far={4} color="#000000" />
                            </group>

                            <OrbitControls makeDefault minPolarAngle={0} maxPolarAngle={Math.PI / 1.8} />
                        </Canvas>
                        
                        {/* Overlay Controls */}
                        <div className="absolute top-4 left-4 z-10 flex gap-2">
                            <div className="bg-black/60 backdrop-blur rounded-full px-3 py-1 text-xs text-gray-300 border border-white/10 flex items-center gap-2">
                                <Box size={12} />
                                {selectedModel.name}
                            </div>
                            {generatedTextureUrl && (
                                <div className="bg-blue-600/80 backdrop-blur rounded-full px-3 py-1 text-xs text-white border border-blue-400/50 animate-in fade-in slide-in-from-top-2">
                                    Previewing...
                                </div>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-gray-600 gap-2">
                        <Brush size={48} className="opacity-20" />
                        <p>Select a model to start retexturing.</p>
                    </div>
                )}
            </div>

            {/* Right: Controls */}
            <div className="w-80 bg-gray-900 border-l border-gray-800 flex flex-col shrink-0 z-20 shadow-xl">
                <div className="p-4 border-b border-gray-800 shrink-0">
                    <h1 className="text-sm font-bold text-gray-200 tracking-wide flex items-center gap-2">
                        <Sparkles size={14} className="text-blue-400" /> GENERATOR
                    </h1>
                </div>

                <div className="flex-1 p-4 space-y-6 overflow-y-auto">
                    {/* Texture Preview */}
                    <div className="space-y-2">
                        <label className="text-[10px] uppercase font-bold text-gray-500">Texture Map</label>
                        <div className="aspect-square w-full bg-gray-950 rounded-lg border border-gray-700 relative overflow-hidden group">
                            {(generatedTextureUrl || currentTextureBase64) ? (
                                <img 
                                    src={generatedTextureUrl || currentTextureBase64 || ''} 
                                    className="w-full h-full object-contain" 
                                />
                            ) : (
                                <div className="absolute inset-0 flex items-center justify-center text-gray-600">
                                    <ImageIcon size={24} />
                                </div>
                            )}
                            
                            {isGenerating && (
                                <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-2 z-10 backdrop-blur-sm">
                                    <RefreshCw size={24} className="animate-spin text-blue-400" />
                                    <span className="text-xs text-blue-200 animate-pulse">Generating...</span>
                                </div>
                            )}

                            {generatedTextureUrl && (
                                <div className="absolute top-2 left-2 bg-blue-600 text-white text-[9px] font-bold px-2 py-0.5 rounded shadow">
                                    PREVIEW
                                </div>
                            )}
                        </div>
                        {error && (
                            <div className="text-[10px] text-red-400 bg-red-900/20 p-2 rounded border border-red-900/50 flex gap-2">
                                <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                                {error}
                            </div>
                        )}
                    </div>

                    {/* Prompt Input */}
                    <div className="space-y-2">
                        <label className="text-[10px] uppercase font-bold text-gray-500 flex items-center gap-2">
                            <Wand2 size={10} /> Description
                        </label>
                        <textarea 
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            disabled={!selectedModel || isGenerating}
                            placeholder="Describe the material (e.g. 'Rusty metal with scratches', 'Alien organic skin')..."
                            className="w-full h-32 bg-gray-950 border border-gray-700 rounded-lg p-3 text-xs text-gray-200 focus:outline-none focus:border-blue-500 resize-none transition-colors"
                        />
                    </div>

                    {/* Action Buttons */}
                    <div className="space-y-2 pt-2">
                        {generatedTextureUrl ? (
                            <div className="space-y-2 animate-in fade-in slide-in-from-bottom-2">
                                {/* Primary Actions */}
                                <button
                                    onClick={handleSave}
                                    className="w-full py-2.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white font-bold text-xs flex items-center justify-center gap-2 transition-colors border border-gray-700"
                                >
                                    <Save size={14} /> Save to Library
                                </button>
                                
                                <div className="grid grid-cols-2 gap-2">
                                    <button
                                        onClick={discard}
                                        className="py-2.5 rounded-lg bg-red-900/20 hover:bg-red-900/40 text-red-400 border border-red-900/50 font-bold text-xs flex items-center justify-center gap-2 transition-colors"
                                    >
                                        <Undo2 size={14} /> Discard
                                    </button>
                                    <button
                                        onClick={handleApply}
                                        className="py-2.5 rounded-lg bg-green-600 hover:bg-green-500 text-white font-bold text-xs flex items-center justify-center gap-2 transition-colors shadow-lg shadow-green-900/20"
                                    >
                                        <Check size={14} /> Apply Only
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <button
                                onClick={handleGenerate}
                                disabled={!selectedModel || !prompt || isGenerating}
                                className={`
                                    w-full py-3 rounded-lg font-bold text-xs flex items-center justify-center gap-2 transition-all
                                    ${(!selectedModel || !prompt || isGenerating) 
                                        ? 'bg-gray-800 text-gray-500 cursor-not-allowed border border-gray-700' 
                                        : 'bg-white text-black hover:bg-gray-200 shadow-xl'
                                    }
                                `}
                            >
                                <Sparkles size={14} /> Generate Texture
                            </button>
                        )}
                    </div>
                    
                    <div className="pt-4 border-t border-gray-800">
                        <div className="bg-blue-900/10 rounded p-3 border border-blue-900/30">
                            <h4 className="text-[10px] font-bold text-blue-400 mb-1 flex items-center gap-1.5">
                                <Link size={10} /> Workflow Tip
                            </h4>
                            <p className="text-[9px] text-gray-500 leading-relaxed">
                                <strong>Apply Only</strong> keeps the texture on the model for this session.<br/>
                                <strong>Save to Library</strong> stores it permanently for use in Blueprints.
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
