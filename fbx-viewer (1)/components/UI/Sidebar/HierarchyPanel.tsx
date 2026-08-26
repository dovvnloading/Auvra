import React from 'react';
import { Layers, ChevronDown, EyeOff, User, Image, Component, Paperclip, Film } from 'lucide-react';
import { useScene } from '../../../context/SceneContext';

export const HierarchyPanel: React.FC = () => {
    const { models, attachments, selectedModelId, selectModel, removeFromScene, removeAttachment } = useScene();

    // Only show models that are placed in the scene
    const placedModels = models.filter(m => m.isPlacedInScene);

    return (
        <div className="p-2 space-y-1">
             {/* Scene Root */}
             <div className="flex items-center gap-1 text-xs text-gray-500 font-mono px-2 py-1">
                <Layers size={12} />
                <span>Scene Root</span>
             </div>

             {placedModels.length === 0 && (
                 <div className="text-center py-10 opacity-50">
                     <p className="text-xs text-gray-500">Scene is empty.</p>
                     <p className="text-[10px] text-gray-600 mt-2">Add assets from the Library below.</p>
                 </div>
             )}

             {placedModels.map(model => {
                 const isSelected = selectedModelId === model.id;
                 const modelAttachments = attachments.filter(a => a.parentModelId === model.id);
                 const hasAttachments = modelAttachments.length > 0;

                 return (
                     <div key={model.id} className="select-none">
                         {/* Model Row */}
                         <div 
                            onClick={() => selectModel(model.id)}
                            className={`
                                flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors group
                                ${isSelected ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'}
                            `}
                         >
                             {hasAttachments ? <ChevronDown size={12} /> : <div className="w-3" />}
                             
                             {model.category === 'Character' ? <User size={14} className="text-gray-500" /> :
                              model.category === 'Prop' ? <Component size={14} className="text-gray-500" /> :
                              model.category === 'Environment' ? <Image size={14} className="text-gray-500" /> :
                              model.category === 'Animation' ? <Film size={14} className="text-gray-500" /> :
                              <Component size={14} className="text-gray-500" />}
                             
                             <span className="text-xs truncate flex-1">{model.name}</span>
                             
                             {/* Remove from Scene (Hide) Button */}
                             <button 
                                onClick={(e) => { e.stopPropagation(); removeFromScene(model.id); }}
                                className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-white p-1"
                                title="Remove from Scene (Keep in Library)"
                             >
                                 <EyeOff size={12} />
                             </button>
                         </div>

                         {/* Attachments (Children) */}
                         {hasAttachments && (
                             <div className="pl-6 border-l border-gray-800 ml-3 mt-1 space-y-0.5">
                                 {modelAttachments.map(att => (
                                     <div key={att.id} className="flex items-center gap-2 px-2 py-1 text-gray-500 hover:text-gray-300 rounded hover:bg-gray-800/50 cursor-default group">
                                         <Paperclip size={10} className="-scale-y-100" />
                                         <span className="text-[11px] truncate flex-1">{att.name}</span>
                                         <span className="text-[9px] text-gray-600 bg-gray-900 px-1 rounded">{att.boneName}</span>
                                         <button 
                                            onClick={() => removeAttachment(att.id)}
                                            className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-white p-1"
                                        >
                                            <EyeOff size={10} />
                                        </button>
                                     </div>
                                 ))}
                             </div>
                         )}
                     </div>
                 );
             })}
        </div>
    );
};