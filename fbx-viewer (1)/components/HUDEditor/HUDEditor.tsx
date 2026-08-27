
import React, { useCallback, useEffect, useState } from 'react';
import { HUDCanvas } from './HUDCanvas';
import { HUDLibrary } from './HUDLibrary';
import { AIChatPanel } from './AIChatPanel';
import { HUDElement } from './types';
import { AVAILABLE_COMPONENTS } from './componentRegistry';
import { Code, Settings2, Sliders, Palette, Type, Move, Scaling } from 'lucide-react';
import { ScrubbableInput } from '../UI/Properties/ScrubbableInput';
import { useNativeProjectDocument } from '../../utils/useNativeProjectDocument';

interface HUDDocument {
    id: string;
    name: string;
    elements: HUDElement[];
    layout: { width: number; height: number };
    commands: unknown[];
}

const HUD_DOCUMENT_ID = 'hud-main';
const createDefaultHUDDocument = (): HUDDocument => ({
    id: HUD_DOCUMENT_ID,
    name: 'Main HUD',
    elements: [],
    layout: { width: 1920, height: 1080 },
    commands: [],
});

// Helper to render dynamic inputs based on prop type
const PropertyInput: React.FC<{ 
    label: string; 
    value: any; 
    onChange: (val: any) => void;
    isMultiline?: boolean;
}> = ({ label, value, onChange, isMultiline }) => {
    const type = typeof value;
    const isColor = label.toLowerCase().includes('color');

    if (isMultiline) {
        return (
            <div className="space-y-1">
                <span className="text-[10px] text-gray-500 font-bold uppercase">{label}</span>
                <textarea 
                    value={value} 
                    onChange={(e) => onChange(e.target.value)} 
                    className="w-full bg-gray-950 border border-gray-700 rounded p-2 text-[10px] font-mono text-blue-300 focus:outline-none focus:border-blue-500 h-48 resize-y leading-tight"
                    spellCheck={false}
                />
            </div>
        );
    }

    if (isColor) {
        return (
            <div className="flex items-center justify-between bg-gray-800 p-2 rounded border border-gray-700">
                <span className="text-[10px] text-gray-400 font-medium uppercase truncate mr-2">{label}</span>
                <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-gray-500 uppercase">{value}</span>
                    <input 
                        type="color" 
                        value={value} 
                        onChange={(e) => onChange(e.target.value)}
                        className="w-6 h-6 rounded cursor-pointer bg-transparent border-0 p-0"
                    />
                </div>
            </div>
        );
    }

    if (type === 'boolean') {
        return (
            <label className="flex items-center justify-between bg-gray-800 p-2 rounded border border-gray-700 cursor-pointer hover:border-gray-600 transition-colors">
                <span className="text-[10px] text-gray-400 font-medium uppercase">{label}</span>
                <div className={`w-8 h-4 rounded-full relative transition-colors ${value ? 'bg-blue-500' : 'bg-gray-600'}`}>
                    <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${value ? 'left-4.5' : 'left-0.5'}`} style={{ left: value ? 'calc(100% - 14px)' : '2px' }} />
                </div>
                <input 
                    type="checkbox" 
                    checked={value} 
                    onChange={(e) => onChange(e.target.checked)} 
                    className="hidden" 
                />
            </label>
        );
    }

    if (type === 'number') {
        return (
            <div className="flex items-center justify-between bg-gray-800 p-1 pl-2 rounded border border-gray-700">
                <span className="text-[10px] text-gray-400 font-medium uppercase mr-2">{label}</span>
                <div className="w-20">
                    <ScrubbableInput 
                        label="" 
                        value={value} 
                        onChange={onChange} 
                        step={label.toLowerCase().includes('opacity') ? 0.05 : 1}
                        labelWidth="w-0" 
                    />
                </div>
            </div>
        );
    }

    // Default String/Text
    return (
        <div className="space-y-1">
            <span className="text-[10px] text-gray-500 font-bold uppercase">{label}</span>
            <input 
                type="text" 
                value={value} 
                onChange={(e) => onChange(e.target.value)} 
                className="w-full bg-gray-800 border border-gray-700 rounded p-1.5 text-xs text-white focus:outline-none focus:border-blue-500"
            />
        </div>
    );
};

export const HUDEditor: React.FC = () => {
    const { document, hydrated, error, replace, refresh } = useNativeProjectDocument<HUDDocument>(
        'hud', HUD_DOCUMENT_ID, createDefaultHUDDocument,
    );
    const elements = document.elements;
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [rightPanelTab, setRightPanelTab] = useState<'ai' | 'props'>('props');

    const commitElements = useCallback((nextElements: HUDElement[]) => {
        return replace({ ...document, elements: nextElements });
    }, [document, replace]);

    // Selection and editor-only tabs are transient and must not survive a
    // project switch or point at a document that was not restored.
    useEffect(() => {
        if (selectedId && !elements.some((element) => element.id === selectedId)) setSelectedId(null);
    }, [elements, selectedId]);

    const selectedElement = elements.find(el => el.id === selectedId) || null;

    const handleAddElement = (type: string, overrides: Partial<HUDElement> = {}) => {
        const def = AVAILABLE_COMPONENTS.find(c => c.type === type);
        if (!def) return;

        const newEl: HUDElement = {
            id: crypto.randomUUID(),
            name: `${def.label} ${elements.length + 1}`,
            type: def.type,
            props: { ...def.defaultProps, ...(overrides.props || {}) },
            position: overrides.position || { x: 960 - (def.defaultSize.width / 2), y: 540 - (def.defaultSize.height / 2) }, // Center spawn
            size: overrides.size || { ...def.defaultSize },
            zIndex: elements.length + 1,
            isVisible: true,
            isLocked: false
        };

        void commitElements([...elements, newEl]).catch((cause) => console.error('[HUD] Could not save element', cause));
        
        // Only select and switch tabs if triggered manually, OR if AI created it we might want to select it
        // The override ID 'ai' is a hack to detect source, but we can just check overrides
        const isAiGenerated = overrides.id === 'ai';
        
        if (!isAiGenerated) {
             setSelectedId(newEl.id);
             setRightPanelTab('props'); 
        } else {
             // If AI created it, select it but stay on AI tab
             setSelectedId(newEl.id);
        }
    };

    const handleUpdateElement = (id: string, updates: Partial<HUDElement>) => {
        void commitElements(elements.map(el => el.id === id ? { ...el, ...updates } : el))
            .catch((cause) => console.error('[HUD] Could not save element update', cause));
    };

    const handlePropChange = (key: string, value: any) => {
        if (!selectedElement) return;
        handleUpdateElement(selectedElement.id, {
            props: { ...selectedElement.props, [key]: value }
        });
    };

    const handleDelete = (id: string) => {
        void commitElements(elements.filter(el => el.id !== id))
            .catch((cause) => console.error('[HUD] Could not delete element', cause));
        if (selectedId === id) setSelectedId(null);
    };

    const handleToggleVisibility = (id: string) => {
        const el = elements.find(e => e.id === id);
        if (el) handleUpdateElement(id, { isVisible: !el.isVisible });
    };

    const handleToggleLock = (id: string) => {
        const el = elements.find(e => e.id === id);
        if (el) handleUpdateElement(id, { isLocked: !el.isLocked });
    };

    return (
        <div className="flex h-full w-full bg-gray-950 text-white font-sans overflow-hidden">
            {error && (
                <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 rounded border border-red-800 bg-red-950/90 px-3 py-2 text-xs text-red-200 shadow-lg">
                    {error.message}
                </div>
            )}
            {!hydrated && (
                <div className="absolute inset-0 z-40 flex items-center justify-center bg-gray-950/70 text-xs text-gray-400">
                    Loading HUD…
                </div>
            )}
            {/* Left Sidebar: Library & Layers */}
            <HUDLibrary 
                elements={elements}
                onAdd={handleAddElement}
                onSelect={setSelectedId}
                selectedId={selectedId}
                onDelete={handleDelete}
                onToggleVisibility={handleToggleVisibility}
                onToggleLock={handleToggleLock}
            />

            {/* Center: Canvas */}
            <div className="flex-1 flex flex-col min-w-0 bg-[#111111]">
                <div className="h-8 bg-[#1a1a1a] border-b border-gray-800 flex items-center px-4 justify-between shrink-0">
                    <span className="text-[10px] text-gray-500 font-bold uppercase tracking-wider">Canvas: 1920 x 1080</span>
                    <div className="text-[10px] text-gray-600">Zoom: 100%</div>
                </div>
                <HUDCanvas 
                    elements={elements}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onUpdate={handleUpdateElement}
                />
            </div>

            {/* Right Sidebar: AI & Properties */}
            <div className="w-80 bg-gray-900 border-l border-gray-800 flex flex-col shrink-0 z-20">
                <div className="flex border-b border-gray-800 bg-gray-950 shrink-0">
                    <button 
                        onClick={() => setRightPanelTab('props')}
                        className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-2 border-b-2 transition-colors ${rightPanelTab === 'props' ? 'border-blue-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                    >
                        <Settings2 size={12} /> Properties
                    </button>
                    <button 
                        onClick={() => setRightPanelTab('ai')}
                        className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-2 border-b-2 transition-colors ${rightPanelTab === 'ai' ? 'border-blue-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                    >
                        <Code size={12} /> AI Coder
                    </button>
                </div>

                <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                    {rightPanelTab === 'ai' ? (
                        <AIChatPanel 
                            elements={elements}
                            selectedElementId={selectedId}
                            onSelectElement={setSelectedId}
                            onRefresh={refresh}
                            onUpdateElement={handleUpdateElement}
                            onAgentCreate={(type, overrides) => handleAddElement(type, { ...overrides, id: 'ai' })}
                        />
                    ) : (
                        <div className="p-4 space-y-6 overflow-y-auto custom-scrollbar flex-1">
                            {selectedElement ? (
                                <>
                                    {/* 1. Identity */}
                                    <div className="space-y-2">
                                        <div className="flex items-center gap-2 mb-2">
                                            <div className="p-1.5 bg-blue-600/20 rounded text-blue-400">
                                                <Sliders size={14} />
                                            </div>
                                            <input 
                                                value={selectedElement.name}
                                                onChange={(e) => handleUpdateElement(selectedElement.id, { name: e.target.value })}
                                                className="bg-transparent border-b border-transparent hover:border-gray-600 focus:border-blue-500 text-sm font-bold text-white w-full focus:outline-none"
                                            />
                                        </div>
                                    </div>
                                    
                                    {/* 2. Transform */}
                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between pb-1 border-b border-gray-800">
                                            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1">
                                                <Move size={10} /> Position
                                            </span>
                                        </div>
                                        <div className="grid grid-cols-2 gap-2">
                                            <ScrubbableInput 
                                                label="X" 
                                                value={selectedElement.position.x} 
                                                onChange={(v) => handleUpdateElement(selectedElement.id, { position: { ...selectedElement.position, x: Math.round(v) } })} 
                                                step={1} 
                                            />
                                            <ScrubbableInput 
                                                label="Y" 
                                                value={selectedElement.position.y} 
                                                onChange={(v) => handleUpdateElement(selectedElement.id, { position: { ...selectedElement.position, y: Math.round(v) } })} 
                                                step={1} 
                                            />
                                        </div>

                                        <div className="flex items-center justify-between pb-1 border-b border-gray-800 mt-2">
                                            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1">
                                                <Scaling size={10} /> Dimensions
                                            </span>
                                        </div>
                                        <div className="grid grid-cols-2 gap-2">
                                            <ScrubbableInput 
                                                label="W" 
                                                value={selectedElement.size.width} 
                                                onChange={(v) => handleUpdateElement(selectedElement.id, { size: { ...selectedElement.size, width: Math.round(v) } })} 
                                                step={1} 
                                            />
                                            <ScrubbableInput 
                                                label="H" 
                                                value={selectedElement.size.height} 
                                                onChange={(v) => handleUpdateElement(selectedElement.id, { size: { ...selectedElement.size, height: Math.round(v) } })} 
                                                step={1} 
                                            />
                                        </div>
                                    </div>

                                    {/* 3. Component Props */}
                                    <div className="space-y-3 pt-2">
                                        <div className="flex items-center justify-between pb-1 border-b border-gray-800">
                                            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1">
                                                {selectedElement.type === 'Text' ? <Type size={10} /> : <Palette size={10} />} 
                                                {selectedElement.type === 'Custom' ? 'Source Code' : 'Attributes'}
                                            </span>
                                        </div>
                                        
                                        <div className="grid grid-cols-1 gap-3">
                                            {Object.keys(selectedElement.props).map((key) => (
                                                <PropertyInput 
                                                    key={key} 
                                                    label={key === 'code' ? 'React JSX Body' : key.replace(/([A-Z])/g, ' $1').trim()} 
                                                    value={selectedElement.props[key]} 
                                                    onChange={(val) => handlePropChange(key, val)}
                                                    isMultiline={key === 'code'} 
                                                />
                                            ))}
                                        </div>
                                    </div>
                                </>
                            ) : (
                                <div className="flex flex-col items-center justify-center h-full text-gray-500 gap-2">
                                    <Sliders size={32} className="opacity-20" />
                                    <p className="text-xs italic">Select an element to edit properties.</p>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
