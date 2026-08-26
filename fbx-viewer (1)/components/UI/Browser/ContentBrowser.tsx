
import React, { useState, useRef, useMemo } from 'react';
import { Filter, FileCode } from 'lucide-react';
import { useScene } from '../../../context/SceneContext';
import { AssetCategory, LoadedModelData } from '../../../types';
import { ThumbnailTooltip } from '../ThumbnailTooltip';
import { BrowserToolbar } from './BrowserToolbar';
import { ModelCard } from './ModelCard';
import { BlueprintCard } from './BlueprintCard';
import { TextureCard } from './TextureCard';
import { AudioCard } from './AudioCard';

export const ContentBrowser: React.FC = () => {
    const { 
        models, 
        addModel, 
        selectModel, 
        placeInScene, 
        isLoading, 
        blueprints, 
        selectBlueprint, 
        addBlueprint,
        textures,
        addTexture,
        removeTexture,
        audioAssets,
        addAudio,
        removeAudio
    } = useScene();

    const [activeTab, setActiveTab] = useState<'models' | 'blueprints'>('models');
    const [filter, setFilter] = useState<AssetCategory | 'All'>('All');
    const [searchQuery, setSearchQuery] = useState('');

    // --- Hover Logic for Live Preview ---
    const [hoveredModel, setHoveredModel] = useState<LoadedModelData | null>(null);
    const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 });
    const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const latestCursorPos = useRef({ x: 0, y: 0 });

    const handleMouseMove = (e: React.MouseEvent) => {
        latestCursorPos.current = { x: e.clientX, y: e.clientY };
        if (hoveredModel) {
            setCursorPos({ x: e.clientX, y: e.clientY });
        }
    };

    const handleHoverStart = (model: LoadedModelData) => {
        if (model.category === 'Animation') return;
        if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
        hoverTimeoutRef.current = setTimeout(() => {
            setHoveredModel(model);
            setCursorPos(latestCursorPos.current);
        }, 400);
    };

    const handleHoverEnd = () => {
        if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
        setHoveredModel(null);
    };

    // --- Import Handlers ---
    const handleImport = async (files: File[], category: AssetCategory) => {
        for (const file of files) {
            await addModel(file, category);
        }
    };

    const handleTextureImport = async (files: File[]) => {
        for (const file of files) {
            await addTexture(file);
        }
    };

    const handleAudioImport = async (files: File[]) => {
        for (const file of files) {
            await addAudio(file);
        }
    };

    // --- Filtering Logic ---
    const filteredLibraryItems = useMemo(() => {
        const items: any[] = [];
        
        // 1. Models
        models.forEach(m => items.push({ ...m, itemType: 'model' }));
        // 2. Textures
        textures.forEach(t => items.push({ ...t, itemType: 'texture', category: 'Texture' }));
        // 3. Audio
        audioAssets.forEach(a => items.push({ ...a, itemType: 'audio', category: 'Audio' }));

        return items.filter(item => {
            const matchesFilter = filter === 'All' || item.category === filter;
            const matchesSearch = item.name.toLowerCase().includes(searchQuery.toLowerCase());
            return matchesFilter && matchesSearch;
        });
    }, [models, textures, audioAssets, filter, searchQuery]);

    const filteredBlueprints = useMemo(() => blueprints.filter(bp =>
        bp.name.toLowerCase().includes(searchQuery.toLowerCase())
    ), [blueprints, searchQuery]);

    const hasPlayerCharacter = useMemo(() => blueprints.some(bp => bp.type === 'Player Character'), [blueprints]);

    return (
        <div
            className="h-64 bg-gray-900/95 backdrop-blur-md border-t border-white/10 flex flex-col shadow-[0_-4px_16px_rgba(0,0,0,0.5)] z-10"
            onMouseMove={handleMouseMove}
        >
            <BrowserToolbar 
                activeTab={activeTab}
                onTabChange={setActiveTab}
                filter={filter}
                onFilterChange={setFilter}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                onImport={handleImport}
                onImportTexture={handleTextureImport}
                onImportAudio={handleAudioImport}
                onAddBlueprint={addBlueprint}
                isLoading={isLoading}
                hasPlayerCharacter={hasPlayerCharacter}
            />

            {/* Grid Content */}
            <div className="flex-1 overflow-y-auto p-4 bg-transparent custom-scrollbar">
                {activeTab === 'models' && (
                    (filteredLibraryItems.length === 0) ? (
                        <div className="h-full flex flex-col items-center justify-center text-gray-600 gap-2">
                            <Filter size={32} className="opacity-20" />
                            <p className="text-sm">No items found.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-4">
                            {filteredLibraryItems.map(item => {
                                if (item.itemType === 'model') {
                                    return (
                                        <ModelCard
                                            key={item.id}
                                            model={item}
                                            onSelect={() => selectModel(item.id)}
                                            onPlaceInScene={() => placeInScene(item.id)}
                                            onHoverStart={handleHoverStart}
                                            onHoverEnd={handleHoverEnd}
                                        />
                                    );
                                } else if (item.itemType === 'texture') {
                                    return (
                                        <TextureCard
                                            key={item.id}
                                            texture={item}
                                            onDelete={() => removeTexture(item.id)}
                                        />
                                    );
                                } else if (item.itemType === 'audio') {
                                    return (
                                        <AudioCard
                                            key={item.id}
                                            audio={item}
                                            onDelete={() => removeAudio(item.id)}
                                        />
                                    );
                                }
                                return null;
                            })}
                        </div>
                    )
                )}

                {activeTab === 'blueprints' && (
                    filteredBlueprints.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-gray-600 gap-2">
                            <FileCode size={32} className="opacity-20" />
                            <p className="text-sm">No blueprints created.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-4">
                            {filteredBlueprints.map(bp => (
                                <BlueprintCard
                                    key={bp.id}
                                    blueprint={bp}
                                    onSelect={() => selectBlueprint(bp.id)}
                                />
                            ))}
                        </div>
                    )
                )}
            </div>

            {/* Status Bar */}
            <div className="h-6 bg-gray-950/80 border-t border-white/10 flex items-center px-3 justify-between shrink-0">
                <div className="text-[10px] text-gray-500">
                    {activeTab === 'models'
                        ? `${filteredLibraryItems.length} Items`
                        : `${blueprints.length} Blueprints`
                    }
                </div>
                {isLoading && (
                    <div className="flex items-center gap-2 text-[10px] text-white">
                        <span className="w-2 h-2 rounded-full bg-white animate-pulse"></span>
                        Processing...
                    </div>
                )}
            </div>

            {/* Render Live 3D Tooltip (Portal) */}
            {hoveredModel && activeTab === 'models' && (
                <ThumbnailTooltip model={hoveredModel} position={cursorPos} />
            )}
        </div>
    );
};
