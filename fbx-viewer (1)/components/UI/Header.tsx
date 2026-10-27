
import React, { useState } from 'react';
import { Brush, Grid, Network, FileCode, Gamepad2, Download, Upload, LayoutTemplate, Trees, X, Save, FolderOpen, Settings2, SlidersHorizontal, Hammer, Languages } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import type { ProjectTemplate } from '../../types';
import { NewProjectMenu } from './NewProjectMenu';
import { MenuButton } from './MenuButton';
import { SettingsModal } from '../Settings/SettingsModal';
import { GameSettingsPanel } from '../Settings/GameSettingsPanel';
import { LocalizationPanel } from '../Settings/LocalizationPanel';

interface HeaderProps {
  activeTab?: 'scene' | 'graph' | 'blueprint' | 'sandbox' | 'hud' | 'retexture' | 'environment';
  onTabChange?: (tab: 'scene' | 'graph' | 'blueprint' | 'sandbox' | 'hud' | 'retexture' | 'environment') => void;
}

export const Header: React.FC<HeaderProps> = ({ activeTab, onTabChange }) => {
  const { saveProject, saveProjectAs, exportProject, buildGame, importProject, importLegacyProject, migrateLegacyBrowserProject, loadProject, openRecentProject, recoverProject, createNewProject, closeProject, isLoading, projectStatus } = useScene();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [gameSettingsOpen, setGameSettingsOpen] = useState(false);
  const [localizationOpen, setLocalizationOpen] = useState(false);

  // Project actions notify through useProjectManager and retain their rejected
  // promise for programmatic callers.  Header events are fire-and-forget UI
  // boundaries, so consume that rejection here to avoid duplicate global
  // unhandled-rejection diagnostics after a cancelled/failed dialog.
  const runProjectAction = (action: () => Promise<unknown>) => {
      void action().catch(() => undefined);
  };

  // Opening the menu and choosing a template are two deliberate steps, which
  // replaces the old click-twice confirmation for a new project.
  const handleNewProject = (template: ProjectTemplate) => {
      runProjectAction(() => createNewProject(template));
  };

  return (
    <div className="h-10 bg-gray-950 border-b border-gray-800 flex items-center gap-4 px-4 justify-between shrink-0 z-50 min-w-0">
       <div className="flex items-center gap-4 shrink-0">
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
       
       {/* Project actions scroll within the header on narrow windows instead of widening the page. */}
       <div className="flex items-center gap-2 min-w-0 overflow-x-auto whitespace-nowrap">
           <div className="text-[11px] text-gray-500 max-w-40 truncate shrink-0" title={projectStatus.name || 'No project open'}>
             {projectStatus.name || 'No project'}{projectStatus.dirty ? ' •' : ''}{projectStatus.readOnly ? ' (Read-only)' : ''}
           </div>
           {projectStatus.recentProjects.length > 0 && <select
             aria-label="Recent projects"
             className="max-w-32 bg-gray-900 border border-gray-800 text-[10px] text-gray-500 rounded px-1 py-1"
             value=""
             onChange={(event) => { if (event.target.value) runProjectAction(() => openRecentProject(event.target.value)); }}
             disabled={isLoading}
           >
             <option value="">Recent</option>
             {projectStatus.recentProjects.map((recent) => <option key={recent.projectId} value={recent.projectId}>{recent.name}</option>)}
           </select>}
           {typeof projectStatus.progress === 'number' && <div className="text-[10px] text-blue-400">{Math.round(projectStatus.progress * 100)}%</div>}
           {projectStatus.recoveryAvailable && <div className="flex items-center gap-1 text-[10px] text-amber-400" title="Project recovery is available">
             {projectStatus.recoveryPoints.length === 0 && <span>Recovery available</span>}
             {projectStatus.recoveryPoints.length > 0 && <select
               aria-label="Recovery points"
               className="max-w-28 bg-gray-900 border border-amber-900 text-[10px] text-amber-300 rounded px-1 py-1"
               value=""
               onChange={(event) => { if (event.target.value) runProjectAction(() => recoverProject(event.target.value)); }}
               disabled={isLoading}
             >
               <option value="">Recovery available…</option>
               {projectStatus.recoveryPoints.map((point) => <option key={point.recoveryId} value={point.recoveryId}>{point.kind}{point.size ? ` (${Math.round(point.size / 1024)} KiB)` : ''}</option>)}
             </select>}
           </div>}
           {/* Project Controls */}
           <div className="flex items-center bg-gray-900 p-0.5 rounded-lg border border-gray-800 mr-2">
               <NewProjectMenu onCreate={handleNewProject} disabled={isLoading} unsavedChanges={Boolean(projectStatus.projectId && projectStatus.dirty)} />
               <div className="w-px h-3 bg-gray-800 mx-1"></div>
               <button 
                 onClick={() => runProjectAction(saveProject)}
                 className="flex items-center gap-2 px-3 py-1 text-xs font-bold text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors disabled:opacity-50"
                 title={projectStatus.readOnly ? "Project is read-only" : "Save project"}
                 disabled={isLoading || !projectStatus.projectId || projectStatus.readOnly}
               >
                   <Save size={12} /> Save
               </button>
               <button onClick={() => runProjectAction(saveProjectAs)} disabled={isLoading || !projectStatus.projectId || projectStatus.readOnly} className="flex items-center gap-2 px-3 py-1 text-xs font-bold text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors disabled:opacity-50" title="Save project as">
                   <Download size={12} /> Save As
               </button>
               <div className="w-px h-3 bg-gray-800 mx-1"></div>
               <button 
                 onClick={() => runProjectAction(loadProject)}
                 disabled={isLoading}
                 className="flex items-center gap-2 px-3 py-1 text-xs font-bold text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors disabled:opacity-50"
                 title="Open project"
               >
                   <FolderOpen size={12} /> Open
               </button>
               <MenuButton
                 label="More"
                 icon={<Upload size={12} />}
                 title="Import, export and migrate projects"
                 disabled={isLoading}
                 items={[
                   { label: 'Import project', description: 'Open an .auvrapack project file', onSelect: () => runProjectAction(importProject) },
                   { label: 'Export project', description: 'Save this project as an .auvrapack file', disabled: !projectStatus.projectId, onSelect: () => runProjectAction(exportProject) },
                   { label: 'Import legacy file', description: 'Import a legacy .forge project', onSelect: () => runProjectAction(importLegacyProject) },
                   { label: 'Browser data', description: 'Copy read-only OmniRenderDB data into this empty native project', disabled: !projectStatus.projectId || projectStatus.readOnly, onSelect: () => runProjectAction(migrateLegacyBrowserProject) },
                 ]}
               />
               <button onClick={() => runProjectAction(closeProject)} disabled={isLoading || !projectStatus.projectId} className="flex items-center gap-2 px-2 py-1 text-xs font-bold text-gray-500 hover:text-white hover:bg-gray-800 rounded transition-colors disabled:opacity-50" title="Close project">
                   <X size={12} />
               </button>
           </div>
           <div className="flex items-center gap-1 rounded-lg border border-gray-800 bg-gray-900 p-0.5">
             <button type="button" onClick={() => runProjectAction(() => buildGame('web'))} disabled={isLoading || !projectStatus.projectId} className="flex items-center gap-2 px-3 py-1 text-xs font-bold text-emerald-300 hover:text-white hover:bg-gray-800 rounded transition-colors disabled:opacity-50" title="Build a web version of the game (static folder to host over http/https)">
               <Hammer size={12} /> Build Web
             </button>
             <button type="button" onClick={() => runProjectAction(() => buildGame('windows'))} disabled={isLoading || !projectStatus.projectId} className="flex items-center gap-2 px-2 py-1 text-xs font-bold text-emerald-300 hover:text-white hover:bg-gray-800 rounded transition-colors disabled:opacity-50" title="Build a Windows version of the game (folder with a .exe)">
               Windows
             </button>
           </div>
           <button type="button" onClick={() => setGameSettingsOpen(true)} className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 px-3 py-1 text-xs font-bold text-gray-400 hover:bg-gray-800 hover:text-white" title="Game settings">
             <SlidersHorizontal size={13} /> Game Settings
           </button>
           {/* Icon-only, so the header fits laptop widths; the title names them. */}
           <button type="button" onClick={() => setLocalizationOpen(true)} aria-label="Localization" className="flex items-center rounded-lg border border-gray-800 bg-gray-900 px-2 py-1.5 text-gray-400 hover:bg-gray-800 hover:text-white" title="Localization: text translations for the game">
             <Languages size={13} />
           </button>
           <button type="button" onClick={() => setSettingsOpen(true)} aria-label="Settings" className="flex items-center rounded-lg border border-gray-800 bg-gray-900 px-2 py-1.5 text-gray-400 hover:bg-gray-800 hover:text-white" title="Settings: AI providers">
             <Settings2 size={13} />
           </button>
       </div>
       {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
       {gameSettingsOpen && <GameSettingsPanel onClose={() => setGameSettingsOpen(false)} />}
       {localizationOpen && <LocalizationPanel onClose={() => setLocalizationOpen(false)} />}
    </div>
  );
};
