import React, { useMemo, useState, useEffect, useRef } from 'react';
import { Paperclip, Upload, Trash2, Crosshair, Component, Swords, X, Search } from 'lucide-react';
import { useScene } from '../../../context/SceneContext';
import { LoadedModelData } from '../../../types';
import { Select } from '../Select';
import { TransformInputGroup } from './TransformInputGroup';

interface AttachmentPanelProps {
  selectedModel: LoadedModelData | null;
}

export const AttachmentPanel: React.FC<AttachmentPanelProps> = ({ selectedModel }) => {
  const { models, attachments, addAttachment, addAttachmentFromLibrary, updateAttachment, removeAttachment, isLoading } = useScene();
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [librarySearch, setLibrarySearch] = useState('');
  
  // Filter attachments for current model
  const modelAttachments = useMemo(() => 
    selectedModel ? attachments.filter(a => a.parentModelId === selectedModel.id) : [], 
  [selectedModel, attachments]);

  // Available weapons/props from the scene
  const availableAssets = useMemo(() => {
     if (!selectedModel) return [];
     return models.filter(m => 
        m.id !== selectedModel.id && // Don't attach self
        (m.category === 'Weapon' || m.category === 'Prop' || m.category === 'Environment') && // Filter suitable types
        m.name.toLowerCase().includes(librarySearch.toLowerCase())
     );
  }, [models, selectedModel, librarySearch]);

  // Extract bone names from the model
  const boneNames = useMemo(() => {
    if (!selectedModel) return [];
    const names: string[] = [];
    selectedModel.object.traverse((child) => {
      if ((child as any).isBone) {
        names.push(child.name);
      }
    });
    return names.sort();
  }, [selectedModel]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0] && selectedModel) {
      addAttachment(e.target.files[0], selectedModel.id);
    }
    e.target.value = ''; 
  };

  if (!selectedModel) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-6 text-gray-500">
        <Component className="w-12 h-12 mb-3 opacity-20" />
        <p className="text-sm">Select a model from the Scene tab to manage its attachments.</p>
      </div>
    );
  }

  const boneOptions = [
    { label: '-- Select Bone --', value: '' },
    ...boneNames.map(name => ({ label: name, value: name }))
  ];

  return (
    <div className="flex-1 flex flex-col h-full bg-gray-900/50 relative">
      <div className="p-4 space-y-4 flex-1 overflow-y-auto custom-scrollbar">
        
        {/* Actions Grid */}
        <div className="grid grid-cols-2 gap-2">
            <label className={`
                flex flex-col items-center justify-center gap-2 py-3 px-2 rounded-lg 
                border border-dashed border-gray-700 hover:border-gray-500 bg-gray-800/30 hover:bg-gray-800/60 
                cursor-pointer transition-all duration-200 group
                ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}
            `}>
                <Upload size={16} className="text-gray-400 group-hover:text-white" />
                <span className="text-[10px] font-medium text-gray-400 group-hover:text-white">Upload File</span>
                <input 
                    type="file" 
                    accept=".fbx" 
                    className="hidden" 
                    onChange={handleFileUpload} 
                    disabled={isLoading}
                />
            </label>

            <button 
                onClick={() => setIsLibraryOpen(true)}
                disabled={isLoading}
                className={`
                    flex flex-col items-center justify-center gap-2 py-3 px-2 rounded-lg 
                    border border-dashed border-gray-700 hover:border-gray-500 bg-gray-800/30 hover:bg-gray-800/60 
                    cursor-pointer transition-all duration-200 group
                    ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}
                `}
            >
                <Swords size={16} className="text-gray-400 group-hover:text-white" />
                <span className="text-[10px] font-medium text-gray-400 group-hover:text-white">From Assets</span>
            </button>
        </div>

        {/* List */}
        <div className="space-y-4">
          {modelAttachments.map((att) => (
            <div key={att.id} className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden shadow-sm">
              {/* Header */}
              <div className="flex items-center justify-between p-3 bg-gray-800 border-b border-gray-700">
                <div className="flex items-center gap-2 overflow-hidden">
                  <Paperclip size={14} className="text-gray-400 shrink-0" />
                  <span className="text-xs font-medium text-gray-200 truncate" title={att.name}>{att.name}</span>
                </div>
                <button 
                  onClick={() => removeAttachment(att.id)}
                  className="text-gray-500 hover:text-red-400 transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>

              {/* Controls */}
              <div className="p-3 space-y-4">
                {/* Bone Selector */}
                <div className="space-y-1.5">
                  <label className="text-[10px] uppercase text-gray-500 font-bold tracking-wider flex items-center gap-1.5">
                     <Crosshair size={10} /> Target Bone
                  </label>
                  <Select
                    value={att.boneName || ''}
                    onChange={(val) => updateAttachment(att.id, { boneName: val })}
                    options={boneOptions}
                  />
                </div>

                {/* Transform Inputs */}
                <div className="space-y-3 pt-1">
                  <TransformInputGroup 
                    label="Position" 
                    values={att.position} 
                    onChange={(val) => updateAttachment(att.id, { position: val })}
                    step={0.1}
                  />
                   <TransformInputGroup 
                    label="Rotation" 
                    values={att.rotation} 
                    onChange={(val) => updateAttachment(att.id, { rotation: val })}
                    step={1}
                  />
                   <TransformInputGroup 
                    label="Scale" 
                    values={att.scale} 
                    onChange={(val) => updateAttachment(att.id, { scale: val })}
                    step={0.1}
                  />
                </div>
              </div>
            </div>
          ))}
          
          {modelAttachments.length === 0 && (
            <div className="text-center py-8 px-4">
               <p className="text-xs text-gray-500">No attachments yet.</p>
               <p className="text-[10px] text-gray-600 mt-1">Upload or Select an FBX (e.g., weapon, hat) to attach it to a specific bone.</p>
            </div>
          )}
        </div>
      </div>

      {/* Library Overlay */}
      {isLibraryOpen && (
          <div className="absolute inset-0 bg-gray-900 z-20 flex flex-col animate-in fade-in zoom-in-95 duration-200">
              <div className="flex items-center justify-between p-3 border-b border-gray-800 bg-gray-850">
                  <span className="text-xs font-bold text-gray-200 flex items-center gap-2">
                      <Swords size={14} className="text-gray-400" />
                      Select Attachment
                  </span>
                  <button 
                    onClick={() => setIsLibraryOpen(false)}
                    className="text-gray-500 hover:text-white transition-colors"
                  >
                      <X size={14} />
                  </button>
              </div>
              
              <div className="p-2 border-b border-gray-800 bg-gray-800/50">
                   <div className="relative">
                        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
                        <input 
                            type="text" 
                            placeholder="Search assets..." 
                            value={librarySearch}
                            onChange={(e) => setLibrarySearch(e.target.value)}
                            className="w-full bg-gray-900 border border-gray-700 rounded py-1.5 pl-8 pr-2 text-xs text-gray-300 focus:outline-none focus:border-gray-500"
                            autoFocus
                        />
                   </div>
              </div>

              <div className="flex-1 overflow-y-auto p-2">
                  {availableAssets.length === 0 ? (
                      <div className="text-center py-8 text-gray-500 text-xs">
                          {models.length <= 1 ? "No other assets loaded." : "No matching assets found."}
                      </div>
                  ) : (
                      <div className="grid grid-cols-2 gap-2">
                          {availableAssets.map(asset => (
                              <button
                                key={asset.id}
                                onClick={() => {
                                    addAttachmentFromLibrary(asset.id, selectedModel.id);
                                    setIsLibraryOpen(false);
                                }}
                                className="group flex flex-col gap-1.5 p-2 rounded-lg border border-gray-800 hover:bg-gray-800 hover:border-gray-600 transition-all text-left"
                              >
                                  <div className="aspect-square w-full bg-gray-950 rounded border border-gray-800 overflow-hidden relative">
                                        {asset.thumbnail ? (
                                            <img src={asset.thumbnail} className="w-full h-full object-cover opacity-60 group-hover:opacity-100 transition-opacity" />
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center text-gray-700">
                                                <Component size={20} />
                                            </div>
                                        )}
                                        <div className="absolute top-1 right-1">
                                             {asset.category === 'Weapon' && <Swords size={10} className="text-gray-400" />}
                                        </div>
                                  </div>
                                  <span className="text-[10px] text-gray-400 group-hover:text-white truncate w-full block">
                                      {asset.name}
                                  </span>
                              </button>
                          ))}
                      </div>
                  )}
              </div>
          </div>
      )}
    </div>
  );
};