
import React, { useState } from 'react';
import { Brush, Grid, Network, FileCode, Gamepad2, LayoutTemplate, Trees, Save, Settings2, SlidersHorizontal, Languages, Palette, History } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import type { ProjectTemplate } from '../../types';
import { NewProjectMenu } from './NewProjectMenu';
import { MenuButton, type MenuButtonItem } from './MenuButton';
import { IconButton } from './kit';
import { SettingsModal } from '../Settings/SettingsModal';
import { GameSettingsPanel } from '../Settings/GameSettingsPanel';
import { LocalizationPanel } from '../Settings/LocalizationPanel';

type EditorTab = 'scene' | 'graph' | 'blueprint' | 'sandbox' | 'hud' | 'retexture' | 'materials' | 'environment';

interface HeaderProps {
  activeTab?: EditorTab;
  onTabChange?: (tab: EditorTab) => void;
}

const TABS: readonly { id: EditorTab; label: string; icon: React.ReactNode }[] = [
  { id: 'scene', label: 'Scene', icon: <Grid size={13} /> },
  { id: 'environment', label: 'Environment', icon: <Trees size={13} /> },
  { id: 'graph', label: 'Graph', icon: <Network size={13} /> },
  { id: 'blueprint', label: 'Blueprints', icon: <FileCode size={13} /> },
  { id: 'sandbox', label: 'Sandbox', icon: <Gamepad2 size={13} /> },
  { id: 'hud', label: 'HUD/UI', icon: <LayoutTemplate size={13} /> },
  { id: 'retexture', label: 'Retexture', icon: <Brush size={13} /> },
  { id: 'materials', label: 'Materials', icon: <Palette size={13} /> },
];

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

  const noProject = !projectStatus.projectId;
  const cannotWrite = noProject || projectStatus.readOnly;
  const fileItems: MenuButtonItem[] = [
    { label: 'Open project', onSelect: () => runProjectAction(loadProject) },
    { label: 'Save', disabled: cannotWrite, onSelect: () => runProjectAction(saveProject) },
    { label: 'Save as', disabled: cannotWrite, onSelect: () => runProjectAction(saveProjectAs) },
    { label: 'Close project', disabled: noProject, onSelect: () => runProjectAction(closeProject) },
    ...projectStatus.recentProjects.map((recent): MenuButtonItem => ({ group: 'Recent', label: recent.name, onSelect: () => runProjectAction(() => openRecentProject(recent.projectId)) })),
    { group: 'Import and export', label: 'Import project', description: 'Open an .auvrapack project file', onSelect: () => runProjectAction(importProject) },
    { group: 'Import and export', label: 'Export project', description: 'Save this project as an .auvrapack file', disabled: noProject, onSelect: () => runProjectAction(exportProject) },
    { group: 'Import and export', label: 'Import legacy file', description: 'Import a legacy .forge project', onSelect: () => runProjectAction(importLegacyProject) },
    { group: 'Import and export', label: 'Browser data', description: 'Copy read-only OmniRenderDB data into this empty native project', disabled: cannotWrite, onSelect: () => runProjectAction(migrateLegacyBrowserProject) },
  ];
  const buildItems: MenuButtonItem[] = [
    { label: 'Web', description: 'A static folder to host over http or https', disabled: noProject, onSelect: () => runProjectAction(() => buildGame('web')) },
    { label: 'Windows', description: 'A folder with a .exe', disabled: noProject, onSelect: () => runProjectAction(() => buildGame('windows')) },
  ];
  const recoveryItems: MenuButtonItem[] = projectStatus.recoveryPoints.map((point) => ({
    label: point.kind,
    description: point.size ? `${Math.round(point.size / 1024)} KiB` : undefined,
    onSelect: () => runProjectAction(() => recoverProject(point.recoveryId)),
  }));

  return (
    <div className="z-50 flex h-9 min-w-0 shrink-0 items-stretch gap-3 border-b border-ground bg-panel pl-1.5 pr-2">
       <div className="flex shrink-0 items-center gap-0.5">
         <NewProjectMenu onCreate={handleNewProject} disabled={isLoading} unsavedChanges={Boolean(projectStatus.projectId && projectStatus.dirty)} />
         <MenuButton label="File" title="Open, save, import and export projects" disabled={isLoading} items={fileItems} />
         <MenuButton label="Build" title="Build the game to run outside the editor" disabled={isLoading} items={buildItems} />
       </div>

       <nav aria-label="Editor views" className="scrollbar-none flex min-w-0 items-stretch overflow-x-auto">
         {TABS.map((tab) => {
           const active = activeTab === tab.id;
           return (
             <button
               key={tab.id}
               type="button"
               aria-current={active ? 'page' : undefined}
               onClick={() => onTabChange?.(tab.id)}
               className={`relative flex shrink-0 items-center gap-1.5 px-2.5 text-xs transition-colors duration-75 ${active ? 'font-medium text-ink' : 'text-ink-2 hover:text-ink'}`}
             >
               <span className={active ? 'text-accent' : 'text-ink-3'}>{tab.icon}</span>
               {tab.label}
               {active && <span className="absolute inset-x-1.5 bottom-0 h-0.5 rounded-t-sm bg-accent" />}
             </button>
           );
         })}
       </nav>

       <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1">
         {typeof projectStatus.progress === 'number' && <div className="text-2xs tabular-nums text-accent">{Math.round(projectStatus.progress * 100)}%</div>}
         {projectStatus.recoveryAvailable && (recoveryItems.length > 0
           ? <MenuButton label="Recovery" hideLabel icon={<History size={13} className="text-warn" />} title="This project can be put back to an earlier state" disabled={isLoading} items={recoveryItems} />
           : <div className="flex h-6 items-center px-1 text-warn" title="Project recovery is available"><History size={13} /></div>)}
         <div className="flex max-w-36 items-center gap-1.5 px-1 text-2xs text-ink-2" title={projectStatus.name || 'No project open'}>
           <span className="truncate">{projectStatus.name || 'No project'}{projectStatus.readOnly ? ' (read-only)' : ''}</span>
           {projectStatus.dirty && <span aria-label="Unsaved changes" title="Unsaved changes" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
         </div>
         <IconButton label={projectStatus.readOnly ? 'Project is read-only' : 'Save project'} disabled={isLoading || cannotWrite} onClick={() => runProjectAction(saveProject)}>
           <Save size={14} />
         </IconButton>
         <span className="mx-0.5 h-4 w-px bg-line" />
         <IconButton label="Game settings" onClick={() => setGameSettingsOpen(true)}><SlidersHorizontal size={14} /></IconButton>
         <IconButton label="Localization: text translations for the game" onClick={() => setLocalizationOpen(true)}><Languages size={14} /></IconButton>
         <IconButton label="Settings: AI providers" onClick={() => setSettingsOpen(true)}><Settings2 size={14} /></IconButton>
       </div>
       {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
       {gameSettingsOpen && <GameSettingsPanel onClose={() => setGameSettingsOpen(false)} />}
       {localizationOpen && <LocalizationPanel onClose={() => setLocalizationOpen(false)} />}
    </div>
  );
};
