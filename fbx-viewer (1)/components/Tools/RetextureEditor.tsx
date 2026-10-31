
import React, { useState, useMemo, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { AuvraCanvas } from '../../renderer/AuvraCanvas';
import { Bounds, Center, OrbitControls, Grid, ContactShadows } from '@react-three/drei';
import { Brush, RefreshCw, Check, Undo2, ArrowRight, AlertTriangle, Search, Box, Layers, Image as ImageIcon, Edit3, Trash2, RotateCcw, Repeat, Wand2, Sparkles, Save, Link, Download } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import { useTextureGeneration } from '../../hooks/useTextureGeneration';
import { listModelTextures, textureToDataUrl } from '../../utils/textureUtils';
import { LoadedModelData } from '../../types';
import { loadFBXFile } from '../../utils/modelLoader';
import { disposeObject } from '../../utils/processing/ModelLifecycle';
import { useNotification } from '../../context/NotificationContext';
import { LocalEnvironment } from '../Scene/LocalEnvironment';
import { AiRouteBar } from '../Settings/AiRouteBar';

const isRenderablePreview = (value: string | null): value is string => Boolean(value?.startsWith('blob:'));
// The map a model carries comes out as a data URL, and is only ever shown, not applied.
const isShowable = (value: string | null): value is string => Boolean(value && (value.startsWith('data:image/') || isRenderablePreview(value)));

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
    const { models, previewTexture } = useScene();
    const { addNotification } = useNotification();
    
    const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
    const [previewModelId, setPreviewModelId] = useState<string | null>(null);
    const [prompt, setPrompt] = useState('');
    // Restyle the texture map the model has, or paint a new one from the description alone.
    const [fromPromptOnly, setFromPromptOnly] = useState(false);
    const canvasRef = useRef<HTMLCanvasElement>(null); // For future mask painting

    const selectedModel = useMemo(() => models.find(m => m.id === selectedModelId), [models, selectedModelId]);

    // A model can draw with several maps (a character's skin, clothes and shoes): which one is being worked on.
    const [mapChoice, setMapChoice] = useState<string | null>(null);
    const [mapsRevision, setMapsRevision] = useState(0);
    const maps = useMemo(() => (selectedModel ? listModelTextures(selectedModel.object) : []), [selectedModel, mapsRevision]); // eslint-disable-line react-hooks/exhaustive-deps
    const chosenMap = maps.find(map => map.uuid === mapChoice) ?? maps[0] ?? null;
    // The map a preview goes on. Each preview makes it a new texture, so it is followed from one to the next.
    const previewTarget = useRef<string | undefined>(undefined);
    const previewQueue = useRef<Promise<unknown>>(Promise.resolve());
    /** Puts a picture on the map, one at a time: a large preview still loading must not land on top of what replaces it. */
    const putOnMap = (modelId: string, url: string) => {
        const done = previewQueue.current.catch(() => undefined).then(() => previewTexture(modelId, url, previewTarget.current)).then((uuid) => {
            previewTarget.current = uuid;
            setMapChoice(uuid);
            setMapsRevision(revision => revision + 1);
        });
        previewQueue.current = done;
        return done;
    };

    useEffect(() => { setMapChoice(null); }, [selectedModelId]);

    const {
        currentTextureBase64,
        generatedTextureUrl,
        isGenerating,
        progress,
        error,
        setCurrentTexture,
        generate,
        commit,
        discard,
        cancel,
        retry
    } = useTextureGeneration();

    // 1. Sync Selection -> Current Texture
    useEffect(() => {
        // If we are previewing or generating, DO NOT update the current texture from the model,
        // as the model currently displays the dirty/preview state.
        if (generatedTextureUrl || isGenerating) return;

        setCurrentTexture(chosenMap ? textureToDataUrl(chosenMap.texture) : null);
        // Only when the map changes: this also clears any error, which a job that just failed has only now set.
    }, [selectedModel, chosenMap?.uuid, setCurrentTexture]); // eslint-disable-line react-hooks/exhaustive-deps

    // 2. Auto-Preview Logic
    useEffect(() => {
        if (!selectedModel) return;

        if (generatedTextureUrl) {
            // Preview is an in-memory material mutation; no project/DB write occurs.
            if (selectedModel.id === previewModelId && isRenderablePreview(generatedTextureUrl)) void putOnMap(selectedModel.id, generatedTextureUrl);
        }
    }, [generatedTextureUrl, selectedModel?.id, previewModelId, previewTexture]);

    // Generation restyles the model's own texture map; a model drawn with plain colours has none.
    const noSourceTexture = Boolean(selectedModel) && !currentTextureBase64 && !generatedTextureUrl && !isGenerating;
    const canGenerate = Boolean(selectedModel && prompt && (fromPromptOnly || currentTextureBase64)) && !isGenerating;

    const handleGenerate = () => {
        if (canGenerate) {
            previewTarget.current = chosenMap?.uuid;
            setPreviewModelId(selectedModelId);
            generate(prompt, fromPromptOnly ? null : currentTextureBase64);
        }
    };

    const handleSave = async () => {
        if (selectedModel && generatedTextureUrl && selectedModel.id === previewModelId) {
            const committed = await commit({ name: `AI_${selectedModel.name}_${Date.now().toString().slice(-4)}` });
            if (committed) addNotification({ message: 'Texture committed to the library.', type: 'info' });
        }
    };

    const handleApply = async () => {
        if (!selectedModel || selectedModel.id !== previewModelId) return;
        const committed = await commit({ targetModelId: selectedModel.id });
        if (committed) {
            await putOnMap(selectedModel.id, committed);
            addNotification({ message: "Texture committed to the model.", type: 'info' });
        }
    };

    const handleDiscard = async () => {
        await discard();
        if (selectedModel && selectedModel.id === previewModelId && currentTextureBase64) await putOnMap(selectedModel.id, currentTextureBase64);
        setPreviewModelId(null);
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
                        <AuvraCanvas surfaceId="preview-retexture-editor" role="preview" shadows camera={{ position: [2, 2, 4], fov: 45 }} className="flex-1">
                            <color attach="background" args={['#0a0a0a']} />
                            <LocalEnvironment />
                            {/* The environment map lights only standard materials; imported models are often Phong. */}
                            <ambientLight intensity={0.5} />
                            <directionalLight position={[10, 10, 5]} intensity={1.5} castShadow shadow-bias={-0.0001} />

                            {/* Framed to the model, however large it is, so the whole of what is being painted shows. */}
                            <Bounds key={selectedModel.id} fit clip observe margin={1.15}>
                                <Center>
                                    <primitive object={selectedModel.object} />
                                </Center>
                            </Bounds>

                            <OrbitControls makeDefault minPolarAngle={0} maxPolarAngle={Math.PI / 1.8} />
                        </AuvraCanvas>
                        
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
                        {maps.length > 1 && (
                            <select
                                aria-label="Which texture map"
                                value={chosenMap?.uuid ?? ''}
                                disabled={isGenerating || Boolean(generatedTextureUrl)}
                                onChange={(event) => setMapChoice(event.target.value)}
                                className="w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-[11px] text-gray-200 disabled:opacity-50"
                            >
                                {maps.map(map => <option key={map.uuid} value={map.uuid}>{map.name}</option>)}
                            </select>
                        )}
                        <div className="aspect-square w-full bg-gray-950 rounded-lg border border-gray-700 relative overflow-hidden group">
                            {isShowable(generatedTextureUrl || currentTextureBase64) ? (
                                <img 
                                    src={generatedTextureUrl || currentTextureBase64 || ''} 
                                    className="w-full h-full object-contain" 
                                />
                            ) : generatedTextureUrl ? (
                                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-[10px] text-blue-300"><ImageIcon size={24} /><span>Preview asset ready in host memory</span><span className="text-gray-600">Commit or discard to finish.</span></div>
                            ) : noSourceTexture ? (
                                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-[10px] text-gray-500">
                                    <ImageIcon size={24} />
                                    <span>This model has no texture map to restyle.</span>
                                    <span className="text-gray-600">Choose New from description to paint one.</span>
                                </div>
                            ) : (
                                <div className="absolute inset-0 flex items-center justify-center text-gray-600">
                                    <ImageIcon size={24} />
                                </div>
                            )}
                            
                            {isGenerating && (
                                <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-2 z-10 backdrop-blur-sm">
                                    <RefreshCw size={24} className="animate-spin text-blue-400" />
                                    <span className="text-xs text-blue-200 animate-pulse">Generating… {Math.round(progress * 100)}%</span>
                                    <button type="button" onClick={() => void cancel()} className="rounded border border-gray-600 px-2 py-1 text-[10px] text-gray-300 hover:bg-gray-800">Cancel job</button>
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
                                <span className="flex-1">{error}</span><button type="button" onClick={() => void retry()} className="text-red-200 underline">Retry</button>
                            </div>
                        )}
                    </div>

                    {/* What to start from, and the model that does it */}
                    <div className="space-y-2">
                        <div className="grid grid-cols-2 gap-1 rounded border border-gray-700 bg-gray-950 p-0.5" role="radiogroup" aria-label="What to start from">
                            {([[false, 'Restyle texture'], [true, 'New from description']] as const).map(([value, label]) => (
                                <button
                                    key={label}
                                    type="button"
                                    role="radio"
                                    aria-checked={fromPromptOnly === value}
                                    onClick={() => setFromPromptOnly(value)}
                                    className={`rounded px-2 py-1 text-[10px] font-bold transition-colors ${fromPromptOnly === value ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                        <AiRouteBar capability={fromPromptOnly ? 'media.generate' : 'media.edit'} label={fromPromptOnly ? 'Image model' : 'Retexture model'} />
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
                                     disabled={selectedModel?.id !== previewModelId}
                                     className="w-full py-2.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white font-bold text-xs flex items-center justify-center gap-2 transition-colors border border-gray-700"
                                >
                                    <Save size={14} /> Save to Library
                                </button>
                                
                                <div className="grid grid-cols-2 gap-2">
                                    <button
                                        onClick={() => void handleDiscard()}
                                        className="py-2.5 rounded-lg bg-red-900/20 hover:bg-red-900/40 text-red-400 border border-red-900/50 font-bold text-xs flex items-center justify-center gap-2 transition-colors"
                                    >
                                        <Undo2 size={14} /> Discard
                                    </button>
                                     <button
                                         onClick={handleApply}
                                         disabled={selectedModel?.id !== previewModelId}
                                         className="py-2.5 rounded-lg bg-green-600 hover:bg-green-500 text-white font-bold text-xs flex items-center justify-center gap-2 transition-colors shadow-lg shadow-green-900/20"
                                    >
                                        <Check size={14} /> Apply Only
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <button
                                onClick={handleGenerate}
                                disabled={!canGenerate}
                                title={noSourceTexture && !fromPromptOnly ? 'This model has no texture map to restyle.' : undefined}
                                className={`
                                    w-full py-3 rounded-lg font-bold text-xs flex items-center justify-center gap-2 transition-all
                                    ${!canGenerate 
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
