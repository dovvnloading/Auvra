
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
import { RetextureEditor } from './components/Tools/RetextureEditor';
import { GraphEditor } from './components/AnimationGraph/GraphEditor';
import { BlueprintEditor } from './components/Blueprint/BlueprintEditor';
import { SandboxScene } from './components/Sandbox/SandboxScene';
import { HUDEditor } from './components/HUDEditor/HUDEditor';
import { EnvironmentEditor } from './components/Environment/EnvironmentEditor';

const AppContent: React.FC = () => {
  const { models, selectedModelId } = useScene();
  
  // App Mode
  const [activeTab, setActiveTab] = useState<'scene' | 'graph' | 'blueprint' | 'sandbox' | 'hud' | 'retexture' | 'environment'>('scene');

  // Scene State
  const [activeClip, setActiveClip] = useState<THREE.AnimationClip | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [timeScale, setTimeScale] = useState(1);
  
  // Camera State
  const [cameraMode, setCameraMode] = useState<'orbit' | 'free'>('orbit');
  const [resetTrigger, setResetTrigger] = useState(0);

  // Reset animation state when model changes
  React.useEffect(() => {
    setActiveClip(null);
    setIsPlaying(true);
  }, [selectedModelId]);

  return (
    <div className="flex flex-col h-screen w-screen bg-gray-950 text-white overflow-hidden font-sans">
      
      {/* Top Header */}
      <Header 
        activeTab={activeTab}
        onTabChange={setActiveTab}
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

          {/* TAB 7: RETEXTURE EDITOR */}
          {activeTab === 'retexture' && (
            <div className="absolute inset-0 w-full h-full">
                <RetextureEditor />
            </div>
          )}

      </div>
      
      {/* Global Notification Container */}
      <NotificationContainer />
    </div>
  );
};

const App: React.FC = () => {
  // Global Log Suppression for Three.js Spam & Context Warnings
  React.useEffect(() => {
    const originalWarn = console.warn;
    const originalError = console.error;

    console.warn = (...args) => {
        const msg = args.join(' ');
        if (
            msg.includes('THREE.PropertyBinding: No target node found') ||
            msg.includes('THREE.FBXLoader') ||
            msg.includes('FBXLoader') ||
            msg.includes('THREE.ImageUtils') ||
            msg.includes('THREE.WebGLRenderer: Context Lost') || 
            msg.includes('WARNING: Too many active WebGL contexts')
        ) {
            return;
        }
        originalWarn.apply(console, args);
    };

    console.error = (...args) => {
        const msg = args.join(' ');
        // Filter out context lost warnings if they happen during hot-reloads or initialization
        if (msg.includes('Context Lost') || msg.includes('WARNING: Too many active WebGL contexts')) {
            return;
        }
        originalError.apply(console, args);
    }
    
    return () => {
        console.warn = originalWarn;
        console.error = originalError;
    };
  }, []);

  return (
    <NotificationProvider>
      <SceneProvider>
        <AppContent />
      </SceneProvider>
    </NotificationProvider>
  );
};

export default App;
