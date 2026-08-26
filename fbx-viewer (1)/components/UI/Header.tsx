
import React, { useRef, useState } from 'react';
import { Brush, Grid, Network, FileCode, Gamepad2, Download, Upload, LayoutTemplate, Trees, FilePlus, AlertTriangle } from 'lucide-react';
import { useScene } from '../../context/SceneContext';

interface HeaderProps {
  activeTab?: 'scene' | 'graph' | 'blueprint' | 'sandbox' | 'hud' | 'retexture' | 'environment';
  onTabChange?: (tab: 'scene' | 'graph' | 'blueprint' | 'sandbox' | 'hud' | 'retexture' | 'environment') => void;
}

export const Header: React.FC<HeaderProps> = ({ activeTab, onTabChange }) => {
  const { saveProject, loadProject, createNewProject, isLoading } = useScene();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [resetConfirm, setResetConfirm] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
          loadProject(e.target.files[0]);
      }
      // Reset value so the same file can be selected again if needed
      if (e.target) e.target.value = '';
  };

  const triggerLoad = () => {
    if (fileInputRef.current) {
        fileInputRef.current.click();
    }
  };

  const handleNewProject = async () => {
      if (resetConfirm) {
          console.log("%c[Header] CONFIRMED reset. Wiping database...", "color: red; font-weight: bold; font-size: 14px;");
          await createNewProject();
          setResetConfirm(false);
      } else {
          console.log("[Header] Requesting reset confirmation...");
          setResetConfirm(true);
          // Auto-reset state after 3s to prevent accidental clicks later
          setTimeout(() => setResetConfirm(false), 3000);
      }
  };

  return (
    <div className="h-10 bg-gray-950 border-b border-gray-800 flex items-center px-4 justify-between shrink-0 z-50">
       <div className="flex items-center gap-4">
           {/* Navigation Tabs */}
           <div className="flex items-center bg-gray-900 p-0.5 rounded-lg border border-gray-800">
              <button 
                onClick={() => onTabChange && onTabChange('scene')}
                className={`flex items-center gap-2 px-3 py-1 rounded text-xs font-bold transition-all ${activeTab === 'scene' ? 'bg-gray-800 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
              >
                  <Grid size={12} /> Scene
              </button>
              <button
                onClick={() => onTabChange && onTabChange('environment')}
                className={`flex items-center gap-2 px-3 py-1 rounded text-xs font-bold transition-all ${activeTab === 'environment' ? 'bg-gray-800 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
              >
                  <Trees size={12} /> Environment
              </button>
              <button 
                onClick={() => onTabChange && onTabChange('graph')}
                className={`flex items-center gap-2 px-3 py-1 rounded text-xs font-bold transition-all ${activeTab === 'graph' ? 'bg-gray-800 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
              >
                  <Network size={12} /> Graph
              </button>
              <button 
                onClick={() => onTabChange && onTabChange('blueprint')}
                className={`flex items-center gap-2 px-3 py-1 rounded text-xs font-bold transition-all ${activeTab === 'blueprint' ? 'bg-gray-800 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
              >
                  <FileCode size={12} /> Blueprints
              </button>
              <button 
                onClick={() => onTabChange && onTabChange('sandbox')}
                className={`flex items-center gap-2 px-3 py-1 rounded text-xs font-bold transition-all ${activeTab === 'sandbox' ? 'bg-gray-800 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
              >
                  <Gamepad2 size={12} /> Sandbox
              </button>
              <button 
                onClick={() => onTabChange && onTabChange('hud')}
                className={`flex items-center gap-2 px-3 py-1 rounded text-xs font-bold transition-all ${activeTab === 'hud' ? 'bg-gray-800 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
              >
                  <LayoutTemplate size={12} /> HUD/UI
              </button>
              <button
                onClick={() => onTabChange && onTabChange('retexture')}
                className={`flex items-center gap-2 px-3 py-1 rounded text-xs font-bold transition-all ${activeTab === 'retexture' ? 'bg-gray-800 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
              >
                  <Brush size={12} /> Retexture
              </button>
           </div>
       </div>
       
       <div className="flex items-center gap-2">
           {/* Project Controls */}
           <div className="flex items-center bg-gray-900 p-0.5 rounded-lg border border-gray-800 mr-2">
               <button 
                 onClick={handleNewProject}
                 className={`
                    flex items-center gap-2 px-3 py-1 text-xs font-bold rounded transition-all duration-200
                    ${resetConfirm 
                        ? 'bg-red-600 text-white hover:bg-red-500 animate-pulse ring-2 ring-red-900' 
                        : 'text-gray-400 hover:text-red-400 hover:bg-gray-800'
                    }
                 `}
                 title={resetConfirm ? "CLICK AGAIN TO CONFIRM WIPE" : "Start New Project (Wipe Data)"}
               >
                   {resetConfirm ? <AlertTriangle size={12} /> : <FilePlus size={12} />}
                   {resetConfirm ? "Confirm Wipe?" : "New"}
               </button>
               <div className="w-px h-3 bg-gray-800 mx-1"></div>
               <button 
                 onClick={saveProject}
                 disabled={isLoading}
                 className="flex items-center gap-2 px-3 py-1 text-xs font-bold text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors disabled:opacity-50"
                 title="Save Project to .forge file"
               >
                   <Download size={12} /> Save
               </button>
               <div className="w-px h-3 bg-gray-800 mx-1"></div>
               <button 
                 onClick={triggerLoad}
                 disabled={isLoading}
                 className="flex items-center gap-2 px-3 py-1 text-xs font-bold text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors disabled:opacity-50"
                 title="Load .forge Project"
               >
                   <Upload size={12} /> Load
               </button>
               {/* Hidden Input for File Loading */}
               <input 
                 type="file" 
                 accept=".forge" 
                 className="hidden" 
                 ref={fileInputRef} 
                 onChange={handleFileChange}
                 style={{ display: 'none' }} 
               />
           </div>
       </div>
    </div>
  );
};
