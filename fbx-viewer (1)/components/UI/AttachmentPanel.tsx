import React, { useMemo } from 'react';
import * as THREE from 'three';
import { Paperclip, Upload, Trash2, Crosshair, Component } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import { LoadedModelData } from '../../types';
import { Select } from './Select';

interface AttachmentPanelProps {
  selectedModel: LoadedModelData | null;
}

export const AttachmentPanel: React.FC<AttachmentPanelProps> = ({ selectedModel }) => {
  const { attachments, addAttachment, updateAttachment, removeAttachment, isLoading } = useScene();
  
  // Filter attachments for current model
  const modelAttachments = useMemo(() => 
    selectedModel ? attachments.filter(a => a.parentModelId === selectedModel.id) : [], 
  [selectedModel, attachments]);

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
    <div className="flex-1 flex flex-col h-full bg-gray-900/50">
      <div className="p-4 space-y-4 flex-1 overflow-y-auto custom-scrollbar">
        
        {/* Add Button */}
        <label className={`
            flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-lg 
            font-medium text-xs border border-dashed border-gray-700 hover:border-gray-500
            transition-all duration-200 cursor-pointer bg-gray-800/30 hover:bg-gray-800/60 text-gray-400 hover:text-white
            ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}
        `}>
          {isLoading ? (
             <span className="animate-spin rounded-full h-3 w-3 border-2 border-current border-t-transparent"></span>
          ) : (
             <Upload size={14} />
          )}
          Upload Mesh Attachment
          <input 
            type="file" 
            accept=".fbx" 
            className="hidden" 
            onChange={handleFileUpload} 
            disabled={isLoading}
          />
        </label>

        {/* List */}
        <div className="space-y-4">
          {modelAttachments.map((att) => (
            <div key={att.id} className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
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
              <div className="p-3 space-y-3">
                {/* Bone Selector */}
                <div className="space-y-1">
                  <label className="text-[10px] uppercase text-gray-500 font-semibold tracking-wider flex items-center gap-1">
                     <Crosshair size={10} /> Target Bone
                  </label>
                  <Select
                    value={att.boneName || ''}
                    onChange={(val) => updateAttachment(att.id, { boneName: val })}
                    options={boneOptions}
                    placeholder="-- Select Bone --"
                  />
                </div>

                {/* Transform Inputs */}
                <div className="space-y-3">
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
                    step={5}
                    suffix="°"
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
               <p className="text-[10px] text-gray-600 mt-1">Upload an FBX (e.g., weapon, hat) to attach it to a specific bone.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const TransformInputGroup: React.FC<{
  label: string;
  values: [number, number, number];
  onChange: (val: [number, number, number]) => void;
  step: number;
  suffix?: string;
}> = ({ label, values, onChange, step, suffix }) => {
  const labels = ['X', 'Y', 'Z'];
  
  const handleChange = (index: number, valStr: string) => {
    const val = parseFloat(valStr);
    if (!isNaN(val)) {
      const newValues = [...values] as [number, number, number];
      newValues[index] = val;
      onChange(newValues);
    }
  };

  return (
    <div className="space-y-1">
      <div className="text-[10px] text-gray-500 font-semibold uppercase">{label}</div>
      <div className="grid grid-cols-3 gap-1">
        {values.map((v, i) => (
          <div key={i} className="relative group">
             <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[9px] text-gray-500 font-bold select-none pointer-events-none">
               {labels[i]}
             </span>
             <input
               type="number"
               step={step}
               value={v}
               onChange={(e) => handleChange(i, e.target.value)}
               className="w-full bg-gray-900 border border-gray-700 rounded text-[10px] py-1 pl-4 pr-1 text-gray-300 focus:outline-none focus:border-gray-500 text-right font-mono"
             />
          </div>
        ))}
      </div>
    </div>
  );
};