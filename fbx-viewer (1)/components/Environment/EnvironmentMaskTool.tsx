
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Pipette, Check, RefreshCw, AlertTriangle, Layers, Image as ImageIcon, Box } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import { extractAllTexturesFromModel, ExtractedTexture } from '../../utils/textureUtils';
import { Select } from '../UI/Select';

interface EnvironmentMaskToolProps {
    modelId: string | null;
}

export const EnvironmentMaskTool: React.FC<EnvironmentMaskToolProps> = ({ modelId }) => {
    const { models, retextureModel } = useScene();
    
    // Internal state for selected model if props.modelId is null (fallback to manual select)
    const [internalModelId, setInternalModelId] = useState<string | null>(modelId);

    // Sync prop changes
    useEffect(() => {
        if (modelId) setInternalModelId(modelId);
    }, [modelId]);

    const activeModel = useMemo(() => models.find(m => m.id === internalModelId), [models, internalModelId]);

    // Available Textures State
    const [availableTextures, setAvailableTextures] = useState<ExtractedTexture[]>([]);
    const [selectedTextureUuid, setSelectedTextureUuid] = useState<string | null>(null);

    // Masking State
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    
    // Settings
    const [keyColor, setKeyColor] = useState('#000000'); 
    const [threshold, setThreshold] = useState(0.1);
    const [smoothness, setSmoothness] = useState(0.05);
    const [inverted, setInverted] = useState(false);
    const [isPicking, setIsPicking] = useState(false);

    const canvasRef = useRef<HTMLCanvasElement>(null);

    // Extract Textures when Model Changes (or updates via retextureModel)
    useEffect(() => {
        if (!activeModel) {
            setAvailableTextures([]);
            setSelectedTextureUuid(null);
            return;
        }
        
        const textures = extractAllTexturesFromModel(activeModel.object);
        
        // Intelligent Selection Preservation:
        // When a texture is updated, its UUID changes. 
        // We try to find the new texture by matching the material name of the old selection.
        let nextSelection = textures.length > 0 ? textures[0].uuid : null;
        
        if (selectedTextureUuid) {
             // 1. Try exact UUID match (e.g. model didn't change this texture)
             const exactMatch = textures.find(t => t.uuid === selectedTextureUuid);
             if (exactMatch) {
                 nextSelection = exactMatch.uuid;
             } else {
                 // 2. Try Name match (recover from replacement)
                 // We use the stale closure 'availableTextures' (from previous render) to find the old name
                 const oldSelection = availableTextures.find(t => t.uuid === selectedTextureUuid);
                 if (oldSelection) {
                     const nameMatch = textures.find(t => t.name === oldSelection.name);
                     if (nameMatch) {
                         nextSelection = nameMatch.uuid;
                     }
                 }
             }
        }
        
        setAvailableTextures(textures);
        setSelectedTextureUuid(nextSelection);
        
        // Reset preview since the main mesh is now updated
        setPreviewUrl(null);
        
    }, [activeModel]); // Intentionally omitting availableTextures to use stale value for diffing

    const activeTexture = useMemo(() => 
        availableTextures.find(t => t.uuid === selectedTextureUuid), 
    [availableTextures, selectedTextureUuid]);

    // Processing Logic (Runs on activeTexture)
    const processMask = useCallback(() => {
        if (!activeTexture) return;

        const canvas = document.createElement('canvas');
        canvas.width = activeTexture.image.width;
        canvas.height = activeTexture.image.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.drawImage(activeTexture.image, 0, 0);
        
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;

        const rKey = parseInt(keyColor.slice(1, 3), 16);
        const gKey = parseInt(keyColor.slice(3, 5), 16);
        const bKey = parseInt(keyColor.slice(5, 7), 16);

        const maxDist = 441.67; 
        const threshVal = threshold * maxDist;
        const smoothVal = smoothness * maxDist;

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];

            const dist = Math.sqrt(
                Math.pow(r - rKey, 2) +
                Math.pow(g - gKey, 2) +
                Math.pow(b - bKey, 2)
            );

            let alpha = 255;

            if (dist < threshVal) {
                alpha = 0;
            } else if (dist < threshVal + smoothVal) {
                alpha = ((dist - threshVal) / smoothVal) * 255;
            }

            if (inverted) alpha = 255 - alpha;

            data[i + 3] = alpha;
        }

        ctx.putImageData(imageData, 0, 0);
        setPreviewUrl(canvas.toDataURL());
    }, [activeTexture, keyColor, threshold, smoothness, inverted]);

    // Auto-update preview
    useEffect(() => {
        if (activeTexture) {
            const timer = setTimeout(processMask, 50); 
            return () => clearTimeout(timer);
        }
    }, [processMask, activeTexture]);

    // Picker Logic
    const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
        if (!isPicking || !activeTexture || !canvasRef.current) return;

        const rect = canvasRef.current.getBoundingClientRect();
        const scaleX = activeTexture.image.width / rect.width;
        const scaleY = activeTexture.image.height / rect.height;

        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;

        const tempC = document.createElement('canvas');
        tempC.width = 1; tempC.height = 1;
        const tempCtx = tempC.getContext('2d');
        if(tempCtx) {
            tempCtx.drawImage(activeTexture.image, x, y, 1, 1, 0, 0, 1, 1);
            const p = tempCtx.getImageData(0, 0, 1, 1).data;
            const hex = "#" + 
                ("00" + p[0].toString(16)).slice(-2) + 
                ("00" + p[1].toString(16)).slice(-2) + 
                ("00" + p[2].toString(16)).slice(-2);
            setKeyColor(hex);
            setIsPicking(false);
        }
    };

    const handleApply = () => {
        if (previewUrl && activeModel && selectedTextureUuid) {
            setIsProcessing(true);
            // Apply targeted texture update
            retextureModel(activeModel.id, previewUrl, selectedTextureUuid);
            setTimeout(() => setIsProcessing(false), 500);
        }
    };

    // --- RENDER ---

    const modelOptions = models
        .filter(m => m.category === 'Prop' || m.category === 'Environment')
        .map(m => ({ label: m.name, value: m.id }));

    return (
        <div className="flex flex-col h-full bg-gray-900 border-l border-gray-800 w-80 shadow-xl shrink-0 z-30">
            {/* Header / Model Select */}
            <div className="p-4 border-b border-gray-800 bg-gray-950">
                <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-2" title="Select the object to mask">
                    <Box size={12} /> Target Mesh
                </div>
                <Select 
                    value={internalModelId || ''}
                    onChange={setInternalModelId}
                    options={[{ label: '-- Select Model --', value: '' }, ...modelOptions]}
                    disabled={!!modelId} // Lock if passed via prop
                />
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-6">
                {!activeModel ? (
                    <div className="text-center py-10 text-gray-600 text-xs italic">
                        Select a model to begin masking.
                    </div>
                ) : (
                    <>
                        {/* Texture Selector */}
                        <div className="space-y-2">
                            <label className="text-[10px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                                <Layers size={12} /> Select Texture Map
                            </label>
                            
                            {availableTextures.length === 0 ? (
                                <div className="bg-red-900/20 border border-red-900/50 rounded p-3 text-center">
                                    <AlertTriangle size={16} className="mx-auto text-red-400 mb-1" />
                                    <p className="text-[10px] text-red-300">No diffuse maps found on this model.</p>
                                </div>
                            ) : (
                                <div className="grid grid-cols-3 gap-2">
                                    {availableTextures.map(tex => (
                                        <div 
                                            key={tex.uuid}
                                            onClick={() => setSelectedTextureUuid(tex.uuid)}
                                            className={`
                                                cursor-pointer rounded border overflow-hidden relative aspect-square group
                                                ${selectedTextureUuid === tex.uuid ? 'border-blue-500 ring-1 ring-blue-500/50' : 'border-gray-700 hover:border-gray-500'}
                                            `}
                                            title={`Select ${tex.name || 'Texture'}`}
                                        >
                                            <img src={tex.base64} className="w-full h-full object-cover" />
                                            <div className="absolute bottom-0 left-0 right-0 bg-black/60 p-1 truncate text-[8px] text-center text-gray-300">
                                                {tex.name}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {activeTexture && (
                            <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
                                <div className="h-px bg-gray-800 w-full" />

                                {/* Preview Area */}
                                <div className="relative aspect-square bg-[#1a1a1a] rounded-lg border border-gray-700 overflow-hidden group">
                                    <div className="absolute inset-0 opacity-20" 
                                         style={{ 
                                             backgroundImage: 'linear-gradient(45deg, #333 25%, transparent 25%), linear-gradient(-45deg, #333 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #333 75%), linear-gradient(-45deg, transparent 75%, #333 75%)',
                                             backgroundSize: '20px 20px',
                                             backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px' 
                                         }} 
                                    />
                                    
                                    <canvas
                                        ref={canvasRef}
                                        className={`relative w-full h-full object-contain ${isPicking ? 'cursor-crosshair' : 'cursor-default'}`}
                                        onClick={handleCanvasClick}
                                    />
                                    
                                    <img 
                                        src={previewUrl || activeTexture.base64} 
                                        className={`absolute inset-0 w-full h-full object-contain pointer-events-none ${isPicking ? 'opacity-50' : 'opacity-100'}`}
                                    />

                                    {isPicking && (
                                        <div className="absolute top-2 left-2 bg-blue-600 text-white text-[10px] px-2 py-1 rounded shadow animate-pulse pointer-events-none">
                                            Pick Key Color
                                        </div>
                                    )}
                                </div>

                                {/* Controls */}
                                <div className="bg-gray-800/50 p-3 rounded border border-gray-800 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <label className="text-[10px] font-bold text-gray-400 uppercase">Key Color</label>
                                        <div className="flex items-center gap-2">
                                            <button 
                                                onClick={() => setIsPicking(!isPicking)}
                                                className={`p-1.5 rounded border transition-colors ${isPicking ? 'bg-blue-600 border-blue-500 text-white' : 'bg-gray-700 border-gray-600 text-gray-300 hover:text-white'}`}
                                                title="Pick color from image"
                                            >
                                                <Pipette size={12} />
                                            </button>
                                            <input 
                                                type="color" 
                                                value={keyColor}
                                                onChange={(e) => setKeyColor(e.target.value)}
                                                className="w-8 h-6 bg-transparent border-0 rounded cursor-pointer"
                                                title="Select Key Color manually"
                                            />
                                        </div>
                                    </div>

                                    <div className="space-y-1">
                                        <div className="flex justify-between text-[10px] text-gray-400">
                                            <span>Threshold</span> <span>{threshold.toFixed(2)}</span>
                                        </div>
                                        <input 
                                            type="range" min="0" max="1" step="0.01" 
                                            value={threshold} 
                                            onChange={(e) => setThreshold(parseFloat(e.target.value))}
                                            className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                                            title="Color matching tolerance"
                                        />
                                    </div>

                                    <div className="space-y-1">
                                        <div className="flex justify-between text-[10px] text-gray-400">
                                            <span>Smoothness</span> <span>{smoothness.toFixed(2)}</span>
                                        </div>
                                        <input 
                                            type="range" min="0" max="0.5" step="0.01" 
                                            value={smoothness} 
                                            onChange={(e) => setSmoothness(parseFloat(e.target.value))}
                                            className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                                            title="Edge softness"
                                        />
                                    </div>

                                    <label className="flex items-center gap-2 text-[10px] text-gray-300 cursor-pointer select-none pt-1">
                                        <input 
                                            type="checkbox" 
                                            checked={inverted} 
                                            onChange={(e) => setInverted(e.target.checked)}
                                            className="rounded bg-gray-700 border-gray-600 text-blue-500 focus:ring-0"
                                        />
                                        Invert Mask
                                    </label>
                                </div>

                                <button
                                    onClick={handleApply}
                                    disabled={isProcessing}
                                    className="w-full py-2.5 rounded text-xs font-bold flex items-center justify-center gap-2 transition-all bg-green-600 hover:bg-green-500 text-white shadow-lg shadow-green-900/20"
                                    title="Generate new material texture"
                                >
                                    {isProcessing ? <RefreshCw size={12} className="animate-spin" /> : <Check size={12} />}
                                    Update Material
                                </button>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};
