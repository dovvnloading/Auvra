
import React, { useState } from 'react';
import * as THREE from 'three';
import { SceneProvider, useScene } from './context/SceneContext';
import { NotificationProvider } from './context/NotificationContext';
import { NotificationContainer } from './components/UI/NotificationSystem';
import { Sidebar } from './components/UI/Sidebar/Sidebar';
import { ViewerScene } from './components/Scene/ViewerScene';
import { ContentBrowser } from './components/UI/Browser/ContentBrowser';
import { ViewControls } from './components/UI/Viewport/ViewControls';
import { Header } from './components/UI/Header';
import { installRendererDiagnostics } from './renderer/diagnostics';
import { OperationProvider } from './context/OperationContext';
import { OperationCenter } from './components/UI/OperationCenter';
import { AppDialogHost } from './components/UI/AppDialogHost';
import { frontendDiagnostics } from './diagnostics/runtime';

// Each tab's code comes when the tab is first opened, so the window comes up on what it shows first.
const RetextureEditor = React.lazy(() => import('./components/Tools/RetextureEditor').then((module) => ({ default: module.RetextureEditor })));
const MaterialGraphEditor = React.lazy(() => import('./components/Materials/MaterialGraphEditor').then((module) => ({ default: module.MaterialGraphEditor })));
const GraphEditor = React.lazy(() => import('./components/AnimationGraph/GraphEditor').then((module) => ({ default: module.GraphEditor })));
const BlueprintEditor = React.lazy(() => import('./components/Blueprint/BlueprintEditor').then((module) => ({ default: module.BlueprintEditor })));
const SandboxScene = React.lazy(() => import('./components/Sandbox/SandboxScene').then((module) => ({ default: module.SandboxScene })));
const HUDEditor = React.lazy(() => import('./components/HUDEditor/HUDEditor').then((module) => ({ default: module.HUDEditor })));
const EnvironmentEditor = React.lazy(() => import('./components/Environment/EnvironmentEditor').then((module) => ({ default: module.EnvironmentEditor })));

const TabLoading: React.FC = () => (
  <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-500 bg-gray-950">Loading...</div>
);

const AppContent: React.FC = () => {
  const { models, selectedModelId } = useScene();
  
  // App Mode
  const [activeTab, setActiveTab] = useState<'scene' | 'graph' | 'blueprint' | 'sandbox' | 'hud' | 'retexture' | 'materials' | 'environment'>('scene');
  const changeActiveTab = React.useMemo(
    () => frontendDiagnostics.wrap('editor_mode', 'change', setActiveTab, { category: 'action' }),
    [],
  );

  // Scene State
  const [activeClip, setActiveClip] = useState<THREE.AnimationClip | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [timeScale, setTimeScale] = useState(1);
  
  // Camera State
  const [cameraMode, setCameraMode] = useState<'orbit' | 'free'>('orbit');
  const [resetTrigger, setResetTrigger] = useState(0);
  const selectedAnimations = React.useMemo(
    () => models.find((model) => model.id === selectedModelId)?.animations || [],
    [models, selectedModelId],
  );

  // A valid embedded or newly associated clip is immediately available for
  // preview. Manual selection still takes over after this import/selection edge.
  React.useEffect(() => {
    setActiveClip(selectedAnimations[0] || null);
    setIsPlaying(true);
  }, [selectedModelId, selectedAnimations]);

  return (
    <div className="flex flex-col h-screen w-screen bg-gray-950 text-white overflow-hidden font-sans">
      
      {/* Top Header */}
      <Header 
        activeTab={activeTab}
        onTabChange={changeActiveTab}
      />

      <div className="flex flex-1 min-h-0 relative">
          
          {/* TAB 1: SCENE VIEWER */}
          {activeTab === 'scene' && (
            <div className="absolute inset-0 w-full h-full flex">
                <Sidebar 
                  activeClip={activeClip}
                  isPlaying={isPlaying}
                  timeScale={timeScale}
                  onAnimationSelect={setActiveClip}
                  onPlayPause={() => setIsPlaying(!isPlaying)}
                  onSpeedChange={(val) => setTimeScale(val === timeScale ? 1 : val)}
                />
                
                <div className="flex-1 relative h-full min-w-0 bg-gray-900">
                    <main className="absolute inset-0 z-0">
                      <ViewerScene 
                        key="main-scene-viewer"
                        activeClip={activeClip}
                        isPlaying={isPlaying}
                        timeScale={timeScale}
                        cameraMode={cameraMode}
                        resetTrigger={resetTrigger}
                      />
                      
                      {models.length === 0 && (
                        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center pointer-events-none pb-64">
                            <div className="bg-gray-900/80 backdrop-blur-md p-8 rounded-2xl border border-gray-800 text-center max-w-md shadow-2xl pointer-events-auto">
                              <div className="mt-2 flex flex-col gap-2 text-xs text-gray-500">
                                  <p>1. Open "Import" in the Content Browser below.</p>
                                  <p>2. Select Asset Type.</p>
                                  <p>3. Manage scene hierarchy in the left sidebar.</p>
                              </div>
                            </div>
                        </div>
                      )}
                    </main>
                    
                    <ViewControls 
                      mode={cameraMode} 
                      setMode={setCameraMode} 
                      onReset={() => setResetTrigger(prev => prev + 1)} 
                    />

                    <div className="absolute bottom-0 left-0 right-0 z-20 pointer-events-none">
                       <div className="pointer-events-auto">
                          <ContentBrowser />
                       </div>
                    </div>
                </div>
            </div>
          )}

          <React.Suspense fallback={<TabLoading />}>

          {/* TAB 2: ENVIRONMENT EDITOR */}
          {activeTab === 'environment' && (
            <div className="absolute inset-0 w-full h-full">
                <EnvironmentEditor />
            </div>
          )}

          {/* TAB 3: GRAPH EDITOR */}
          {activeTab === 'graph' && (
            <div className="absolute inset-0 w-full h-full">
               <GraphEditor visible={true} />
            </div>
          )}

          {/* TAB 4: BLUEPRINT EDITOR */}
          {activeTab === 'blueprint' && (
            <div className="absolute inset-0 w-full h-full">
                <BlueprintEditor visible={true} />
            </div>
          )}

          {/* TAB 5: SANDBOX */}
          {activeTab === 'sandbox' && (
            <div className="absolute inset-0 w-full h-full">
                <SandboxScene visible={true} />
            </div>
          )}

          {/* TAB 6: HUD EDITOR */}
          {activeTab === 'hud' && (
            <div className="absolute inset-0 w-full h-full">
                <HUDEditor />
            </div>
          )}

          {/* TAB 8: MATERIAL GRAPHS */}
          {activeTab === 'materials' && (
            <div className="absolute inset-0 w-full h-full">
                <MaterialGraphEditor />
            </div>
          )}

          {/* TAB 7: RETEXTURE EDITOR */}
          {activeTab === 'retexture' && (
            <div className="absolute inset-0 w-full h-full">
                <RetextureEditor />
            </div>
          )}

          </React.Suspense>

      </div>
      
      {/* Global Notification Container */}
      <OperationCenter />
      <NotificationContainer />
    </div>
  );
};

const App: React.FC = () => {
  React.useEffect(() => {
    const span = frontendDiagnostics.startSpan('editor', 'mounted', { category: 'lifecycle' });
    const uninstallRendererDiagnostics = installRendererDiagnostics();
    return () => {
      uninstallRendererDiagnostics?.();
      span.finish('success');
    };
  }, []);

  return (
    <NotificationProvider>
      <OperationProvider>
        <SceneProvider>
          <AppContent />
          <AppDialogHost />
        </SceneProvider>
      </OperationProvider>
    </NotificationProvider>
  );
};

export default App;
