
import React, { useMemo, useState, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { Target, Plus, Trash2, Crosshair, Play, Zap, Flame, Upload, Image as ImageIcon, Eye, EyeOff } from 'lucide-react';
import { useScene } from '../../../context/SceneContext';
import { LoadedModelData } from '../../../types';
import { Select } from '../Select';
import { TransformInputGroup } from './TransformInputGroup';
import { ScrubbableInput } from './ScrubbableInput';

interface SocketPanelProps {
  selectedModel: LoadedModelData | null;
  onPreviewAnimation: (clip: THREE.AnimationClip | null) => void;
}

export const SocketPanel: React.FC<SocketPanelProps> = ({ selectedModel, onPreviewAnimation }) => {
  const { 
      sockets, addSocket, updateSocket, removeSocket, models, 
      triggerDebugProjectile, triggerSocketFlash, 
      textures, addTexture, triggerCharacterFire 
  } = useScene();
  
  // Filter sockets for current model
  const modelSockets = useMemo(() => 
    selectedModel ? sockets.filter(s => s.parentModelId === selectedModel.id) : [], 
  [selectedModel, sockets]);

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
  
  // Animation options
  const animationOptions = useMemo(() => {
      const options: { label: string, value: string, clip: THREE.AnimationClip }[] = [];
      models.forEach(model => {
          if (model.animations) {
              model.animations.forEach(clip => {
                  const isSelected = selectedModel && model.id === selectedModel.id;
                  const source = isSelected ? 'Self' : model.name;
                  options.push({ 
                      label: `${clip.name} (${source})`, 
                      value: `${model.id}::${clip.name}`, 
                      clip: clip 
                  });
              });
          }
      });
      return options;
  }, [models, selectedModel]);

  const boneOptions = [
    { label: '-- Root (None) --', value: '' },
    ...boneNames.map(name => ({ label: name, value: name }))
  ];

  const handleTestFire = (socketId: string) => {
      if (!selectedModel) return;

      // 1. Trigger Visual Flash
      triggerSocketFlash(socketId);

      // 2. Trigger Debug Projectile
      let socketObj: THREE.Object3D | undefined;
      selectedModel.object.traverse((child) => {
          if (child.name === `Socket_${socketId}`) socketObj = child;
      });

      if (socketObj) {
          const pos = new THREE.Vector3();
          const qt = new THREE.Quaternion();
          socketObj.getWorldPosition(pos);
          socketObj.getWorldQuaternion(qt);
          const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(qt);
          triggerDebugProjectile(pos.toArray(), dir.toArray());
      }

      // 3. Trigger Character Animation
      triggerCharacterFire(selectedModel.id);
  };

  const handleTextureUpload = async (e: React.ChangeEvent<HTMLInputElement>, socketId: string) => {
      if (e.target.files && e.target.files[0]) {
          const id = await addTexture(e.target.files[0]);
          if (id) {
              const sock = sockets.find(s => s.id === socketId);
              if (sock) {
                  updateSocket(socketId, {
                      flashConfig: {
                          ...(sock.flashConfig || { enabled: true, scale: 1, color: '#ffffff', duration: 0.1 }),
                          textureId: id
                      }
                  });
              }
          }
      }
  };

  if (!selectedModel) return null;

  return (
    <div className="px-4 space-y-4">
      
      {/* Add Button */}
      <button 
        onClick={() => addSocket(selectedModel.id, `Muzzle_${modelSockets.length + 1}`)}
        className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-lg border border-dashed border-gray-700 hover:border-gray-500 bg-gray-800/30 hover:bg-gray-800/60 text-gray-400 hover:text-white transition-all text-xs font-medium"
      >
        <Plus size={14} /> Add Socket / Muzzle
      </button>

      {/* List */}
      <div className="space-y-4">
        {modelSockets.map((sock) => {
            const flashCfg = sock.flashConfig || { 
                enabled: false, textureId: null, scale: 1.0, color: '#ffffff', duration: 0.05, preview: false 
            };
            const currentTexture = textures.find(t => t.id === flashCfg.textureId);

            return (
                <div key={sock.id} className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden shadow-sm">
                    {/* Header */}
                    <div className="flex items-center justify-between p-3 bg-gray-800 border-b border-gray-700">
                        <div className="flex items-center gap-2">
                            <Target size={14} className="text-red-400" />
                            <input 
                                value={sock.name}
                                onChange={(e) => updateSocket(sock.id, { name: e.target.value })}
                                className="bg-transparent text-xs font-bold text-gray-200 focus:outline-none focus:border-b border-gray-600 w-32"
                            />
                        </div>
                        <button onClick={() => removeSocket(sock.id)} className="text-gray-500 hover:text-red-400 transition-colors">
                            <Trash2 size={14} />
                        </button>
                    </div>

                    {/* Controls */}
                    <div className="p-3 space-y-4">
                        
                        {/* Actions Row */}
                        <div className="flex gap-2">
                            <div className="flex-1 bg-gray-900/50 p-2 rounded border border-gray-800">
                                <div className="flex items-center justify-between mb-1">
                                    <span className="text-[9px] uppercase font-bold text-gray-500 flex items-center gap-1">
                                        <Play size={8} /> Preview Anim
                                    </span>
                                </div>
                                <Select 
                                    value=""
                                    onChange={(val) => {
                                        const opt = animationOptions.find(o => o.value === val);
                                        if (opt) onPreviewAnimation(opt.clip);
                                    }}
                                    options={animationOptions}
                                    placeholder="Play..."
                                />
                            </div>

                            {/* Fire Button */}
                            <button 
                                onClick={() => handleTestFire(sock.id)}
                                className="w-12 flex flex-col items-center justify-center bg-red-900/20 hover:bg-red-900/40 border border-red-900/50 hover:border-red-500 rounded text-red-400 hover:text-red-200 transition-all active:scale-95"
                                title="Trigger Once"
                            >
                                <Zap size={14} className="mb-1" />
                                <span className="text-[9px] font-bold">FIRE</span>
                            </button>
                        </div>

                        {/* Bone Selector */}
                        <div className="space-y-1.5">
                            <label className="text-[10px] uppercase text-gray-500 font-bold tracking-wider flex items-center gap-1.5">
                                <Crosshair size={10} /> Parent Bone
                            </label>
                            <Select
                                value={sock.boneName || ''}
                                onChange={(val) => updateSocket(sock.id, { boneName: val })}
                                options={boneOptions}
                            />
                        </div>

                        {/* Transform Inputs */}
                        <div className="space-y-3 pt-1">
                            <TransformInputGroup 
                                label="Position Offset" 
                                values={sock.position} 
                                onChange={(val) => updateSocket(sock.id, { position: val })}
                                step={0.01}
                            />
                            <TransformInputGroup 
                                label="Rotation Offset" 
                                values={sock.rotation} 
                                onChange={(val) => updateSocket(sock.id, { rotation: val })}
                                step={15}
                            />
                        </div>

                        {/* --- MUZZLE FLASH CONFIG --- */}
                        <div className="pt-3 border-t border-gray-700/50 space-y-3">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <Flame size={10} className={flashCfg.enabled ? "text-orange-400" : "text-gray-600"} /> 
                                    <label className="text-[10px] uppercase text-gray-500 font-bold tracking-wider">Muzzle Flash</label>
                                    
                                    {/* PREVIEW TOGGLE */}
                                    {flashCfg.enabled && (
                                        <button 
                                            onClick={() => updateSocket(sock.id, { flashConfig: { ...flashCfg, preview: !flashCfg.preview } })}
                                            className={`ml-2 flex items-center gap-1 px-1.5 py-0.5 rounded border transition-colors ${flashCfg.preview ? 'bg-orange-900/30 border-orange-500/50 text-orange-400' : 'bg-gray-900 border-gray-700 text-gray-500 hover:text-gray-300'}`}
                                            title="Toggle Static Preview Mode (Always Visible)"
                                        >
                                            {flashCfg.preview ? <Eye size={10} /> : <EyeOff size={10} />}
                                            <span className="text-[9px] font-bold">PREVIEW</span>
                                        </button>
                                    )}
                                </div>
                                <input 
                                    type="checkbox" 
                                    checked={flashCfg.enabled}
                                    onChange={(e) => updateSocket(sock.id, { flashConfig: { ...flashCfg, enabled: e.target.checked } })}
                                    className="rounded bg-gray-900 border-gray-600 text-orange-500 focus:ring-0 cursor-pointer"
                                />
                            </div>

                            {flashCfg.enabled && (
                                <div className="space-y-3 bg-gray-900/30 p-2 rounded border border-gray-800 animate-in fade-in zoom-in-95 duration-200">
                                    {/* Texture Picker */}
                                    <div className="flex gap-2">
                                        <div className="w-10 h-10 bg-black rounded border border-gray-700 flex items-center justify-center overflow-hidden shrink-0">
                                            {currentTexture ? (
                                                <img src={currentTexture.url} className="w-full h-full object-contain" />
                                            ) : (
                                                <ImageIcon size={16} className="text-gray-600" />
                                            )}
                                        </div>
                                        <div className="flex-1 space-y-1">
                                            <Select 
                                                value={flashCfg.textureId || ''}
                                                onChange={(val) => updateSocket(sock.id, { flashConfig: { ...flashCfg, textureId: val } })}
                                                options={[{ label: 'None', value: '' }, ...textures.map(t => ({ label: t.name, value: t.id }))]}
                                                placeholder="Select from Texture Maps..."
                                            />
                                            <label className="flex items-center gap-1 text-[9px] text-blue-400 hover:text-blue-300 cursor-pointer w-fit">
                                                <Upload size={10} /> Import to Library
                                                <input type="file" accept="image/*" className="hidden" onChange={(e) => handleTextureUpload(e, sock.id)} />
                                            </label>
                                        </div>
                                    </div>

                                    {/* Flash Properties */}
                                    <div className="grid grid-cols-2 gap-2">
                                        <div className="flex items-center justify-between bg-gray-900 px-2 py-1 rounded border border-gray-700">
                                            <span className="text-[9px] text-gray-500 font-bold">Scale</span>
                                            <div className="w-12">
                                                <ScrubbableInput label="" value={flashCfg.scale} onChange={(v) => updateSocket(sock.id, { flashConfig: { ...flashCfg, scale: Math.max(0.1, v) } })} step={0.1} labelWidth="w-0" />
                                            </div>
                                        </div>
                                        <div className="flex items-center justify-between bg-gray-900 px-2 py-1 rounded border border-gray-700">
                                            <span className="text-[9px] text-gray-500 font-bold">Duration</span>
                                            <div className="w-12">
                                                <ScrubbableInput label="" value={flashCfg.duration} onChange={(v) => updateSocket(sock.id, { flashConfig: { ...flashCfg, duration: Math.max(0.01, v) } })} step={0.01} labelWidth="w-0" />
                                            </div>
                                        </div>
                                        <div className="col-span-2 flex items-center justify-between bg-gray-900 px-2 py-1 rounded border border-gray-700">
                                            <span className="text-[9px] text-gray-500 font-bold">Tint</span>
                                            <input type="color" value={flashCfg.color} onChange={(e) => updateSocket(sock.id, { flashConfig: { ...flashCfg, color: e.target.value } })} className="w-6 h-4 bg-transparent border-none p-0 cursor-pointer" />
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                    </div>
                </div>
            );
        })}
        
        {modelSockets.length === 0 && (
          <div className="text-center py-4 px-4 border border-dashed border-gray-800 rounded">
             <p className="text-xs text-gray-500">No sockets defined.</p>
             <p className="text-[10px] text-gray-600 mt-1">Add a socket to define muzzle flash points.</p>
          </div>
        )}
      </div>
    </div>
  );
};
