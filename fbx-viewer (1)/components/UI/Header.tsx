
import React, { useState } from 'react';
import { Brush, Grid, Network, FileCode, Gamepad2, Download, Upload, LayoutTemplate, Trees, FilePlus, X, Save, FolderOpen, Settings2 } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import { SettingsModal } from '../Settings/SettingsModal';

interface HeaderProps {
  activeTab?: 'scene' | 'graph' | 'blueprint' | 'sandbox' | 'hud' | 'retexture' | 'environment';
  onTabChange?: (tab: 'scene' | 'graph' | 'blueprint' | 'sandbox' | 'hud' | 'retexture' | 'environment') => void;
}

export const Header: React.FC<HeaderProps> = ({ activeTab, onTabChange }) => {
  const { saveProject, saveProjectAs, exportProject, importProject, importLegacyProject, migrateLegacyBrowserProject, loadProject, openRecentProject, recoverProject, createNewProject, closeProject, isLoading, projectStatus } = useScene();
  const [resetConfirm, setResetConfirm] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const handleNewProject = async () => {
      if (resetConfirm) {
          console.log("[Header] Creating a new native project");
          await createNewProject();
          setResetConfirm(false);
      } else {
          console.log("[Header] Requesting new project confirmation...");
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
           <div className="text-[11px] text-gray-500 max-w-40 truncate" title={projectStatus.name || 'No project open'}>
             {projectStatus.name || 'No project'}{projectStatus.dirty ? ' •' : ''}{projectStatus.readOnly ? ' (Read-only)' : ''}
           </div>
           {projectStatus.recentProjects.length > 0 && <select
             aria-label="Recent projects"
             className="max-w-32 bg-gray-900 border border-gray-800 text-[10px] text-gray-500 rounded px-1 py-1"
             value=""
             onChange={(event) => { if (event.target.value) void openRecentProject(event.target.value); }}
             disabled={isLoading}
           >
             <option value="">Recent</option>
             {projectStatus.recentProjects.map((recent) => <option key={recent.projectId} value={recent.projectId}>{recent.name}</option>)}
           </select>}
           {typeof projectStatus.progress === 'number' && <div className="text-[10px] text-blue-400">{Math.round(projectStatus.progress * 100)}%</div>}
           {projectStatus.recoveryAvailable && <div className="flex items-center gap-1 text-[10px] text-amber-400" title="Project recovery is available">
             <span>Recovery available</span>
             {projectStatus.recoveryPoints.length > 0 && <select
               aria-label="Recovery points"
               className="max-w-28 bg-gray-900 border border-amber-900 text-[10px] text-amber-300 rounded px-1 py-1"
               value=""
               onChange={(event) => { if (event.target.value) void recoverProject(event.target.value); }}
               disabled={isLoading}
             >
               <option value="">Open recovery…</option>
               {projectStatus.recoveryPoints.map((point) => <option key={point.recoveryId} value={point.recoveryId}>{point.kind}{point.size ? ` (${Math.round(point.size / 1024)} KiB)` : ''}</option>)}
             </select>}
           </div>}
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
                 title={resetConfirm ? "Click again to create a new project" : "Create a new project"}
               >
                   <FilePlus size={12} /> {resetConfirm ? "Confirm New?" : "New"}
               </button>
               <div className="w-px h-3 bg-gray-800 mx-1"></div>
               <button 
                 onClick={saveProject}
                 className="flex items-center gap-2 px-3 py-1 text-xs font-bold text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors disabled:opacity-50"
                 title={projectStatus.readOnly ? "Project is read-only" : "Save project"}
                 disabled={isLoading || !projectStatus.projectId || projectStatus.readOnly}
               >
                   <Save size={12} /> Save
               </button>
               <button onClick={saveProjectAs} disabled={isLoading || !projectStatus.projectId || projectStatus.readOnly} className="flex items-center gap-2 px-3 py-1 text-xs font-bold text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors disabled:opacity-50" title="Save project as">
                   <Download size={12} /> Save As
               </button>
               <div className="w-px h-3 bg-gray-800 mx-1"></div>
               <button 
                 onClick={loadProject}
                 disabled={isLoading}
                 className="flex items-center gap-2 px-3 py-1 text-xs font-bold text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors disabled:opacity-50"
                 title="Open project"
               >
                   <FolderOpen size={12} /> Open
               </button>
               <button onClick={importProject} disabled={isLoading} className="flex items-center gap-2 px-3 py-1 text-xs font-bold text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors disabled:opacity-50" title="Import an .auvrapack project">
                   <Upload size={12} /> Import
               </button>
               <button onClick={importLegacyProject} disabled={isLoading} className="flex items-center gap-2 px-2 py-1 text-xs font-bold text-gray-500 hover:text-white hover:bg-gray-800 rounded transition-colors disabled:opacity-50" title="Import a legacy .forge project">Legacy file</button>
               <button onClick={migrateLegacyBrowserProject} disabled={isLoading || !projectStatus.projectId || projectStatus.readOnly} className="flex items-center gap-2 px-2 py-1 text-xs font-bold text-gray-500 hover:text-white hover:bg-gray-800 rounded transition-colors disabled:opacity-50" title="Copy read-only OmniRenderDB data into this empty native project">Browser data</button>
               <button onClick={exportProject} disabled={isLoading || !projectStatus.projectId} className="flex items-center gap-2 px-3 py-1 text-xs font-bold text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors disabled:opacity-50" title="Export an .auvrapack project">
                   <Download size={12} /> Export
               </button>
               <button onClick={closeProject} disabled={isLoading || !projectStatus.projectId} className="flex items-center gap-2 px-2 py-1 text-xs font-bold text-gray-500 hover:text-white hover:bg-gray-800 rounded transition-colors disabled:opacity-50" title="Close project">
                   <X size={12} />
               </button>
           </div>
           <button type="button" onClick={() => setSettingsOpen(true)} className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 px-3 py-1 text-xs font-bold text-gray-400 hover:bg-gray-800 hover:text-white" title="Provider settings">
             <Settings2 size={13} /> Settings
           </button>
       </div>
       {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
};
