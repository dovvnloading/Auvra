
import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { BoxSelect, Network, Component, FileCode, Settings, ChevronRight } from 'lucide-react';
import type { AnimationGraphData } from '../../types';
import { GraphPreview, type PreviewStatus } from './GraphPreview';
import { BlackboardPanel } from './BlackboardPanel';
import { InspectorPanel } from './InspectorPanel';
import { GraphCanvas, type FiredTransition } from './GraphCanvas';
import type { GraphRuntimeAPI } from './GraphRuntime';
import { Select } from '../UI/Select';
import { useGraphContext } from './hooks/useGraphContext';
import { useGraphHistory } from './hooks/useGraphHistory';
import { authoredTransitionId, graphLevel, levelActiveStateId, writeGraphLevel } from './utils/stateMachines';

interface GraphEditorProps {
    visible: boolean;
}

export const GraphEditor: React.FC<GraphEditorProps> = ({ visible }) => {
  // Logic extracted to custom hook
  const {
      contextType,
      setContextType,
      selectedContextId,
      setSelectedContextId,
      currentGraph,
      previewModel,
      handleUpdateGraph,
      allSceneClips,
      contextOptions
  } = useGraphContext();

  const [activeSidebarTab, setActiveSidebarTab] = useState<'blackboard' | 'inspector'>('blackboard');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Memoize clips to prevent infinite reset loop in mixer
  const previewClips = useMemo(() => allSceneClips.map(a => a.clip), [allSceneClips]);

  // Undo/redo over the selected graph; history resets when another model/blueprint is opened.
  const history = useGraphHistory({
      graph: currentGraph,
      updateGraph: handleUpdateGraph,
      active: visible && !!selectedContextId,
      resetKey: `${contextType}:${selectedContextId ?? ''}`,
  });
  const { updateGraphWithHistory } = history;

  // --- Live debugging: what the preview runtime reports ---
  // Reports are tagged with the graph they came from, so after switching context nothing from the
  // previous graph shows until the new run reports its entry state.
  const contextKey = `${contextType}:${selectedContextId ?? ''}`;
  const contextKeyRef = useRef(contextKey);
  contextKeyRef.current = contextKey;
  const previewApiRef = useRef<GraphRuntimeAPI | undefined>(undefined);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>('no-mesh');
  const [liveActive, setLiveActive] = useState<{ key: string; id: string } | null>(null);
  const [lastFired, setLastFired] = useState<{ key: string; fired: FiredTransition } | null>(null);
  const firedSeqRef = useRef(0);

  const handleActiveStateChange = useCallback((id: string) => {
      setLiveActive({ key: contextKeyRef.current, id });
  }, []);

  const handleTransitionFired = useCallback((id: string) => {
      firedSeqRef.current += 1;
      setLastFired({ key: contextKeyRef.current, fired: { id, seq: firedSeqRef.current } });
  }, []);

  // --- Nested state machines: the canvas shows one level at a time ---
  // The State Machine states opened, from the top level down; empty shows the top level.
  const [machinePath, setMachinePath] = useState<string[]>([]);
  useEffect(() => { setMachinePath([]); }, [contextKey]);
  const level = graphLevel(currentGraph, machinePath);
  // A machine that was deleted, retyped or undone away drops the view back to the top.
  const path = useMemo(() => (level ? machinePath : []), [level, machinePath]);
  useEffect(() => { if (!level && machinePath.length) setMachinePath([]); }, [level, machinePath.length]);
  const levelGraph = useMemo<AnimationGraphData>(
      () => (level ? { ...currentGraph, states: level.states, transitions: level.transitions } : currentGraph),
      [currentGraph, level],
  );
  const updateLevel = useCallback((modelId: string, data: Partial<AnimationGraphData>) => {
      updateGraphWithHistory(modelId, writeGraphLevel(currentGraph, path, data));
  }, [updateGraphWithHistory, currentGraph, path]);
  const updateLevelLive = useCallback((modelId: string, data: Partial<AnimationGraphData>) => {
      handleUpdateGraph(modelId, writeGraphLevel(currentGraph, path, data));
  }, [handleUpdateGraph, currentGraph, path]);
  const { commitMove } = history;
  const commitLevelMove = useCallback((before: AnimationGraphData) => {
      commitMove({ ...currentGraph, ...writeGraphLevel(currentGraph, path, { states: before.states, transitions: before.transitions }) });
  }, [commitMove, currentGraph, path]);
  const openStateMachine = useCallback((id: string) => {
      setMachinePath(current => [...(graphLevel(currentGraph, current) ? current : []), id]);
      setSelectedNodeId(null);
  }, [currentGraph]);
  const crumbs = path.map((id, index) => ({
      id,
      name: graphLevel(currentGraph, path.slice(0, index))?.states.find(state => state.id === id)?.name ?? 'State Machine',
  }));

  const previewRunning = visible && previewStatus !== 'no-mesh';
  const liveActiveStateId = previewRunning && liveActive?.key === contextKey ? levelActiveStateId(liveActive.id, path) : null;
  const firedTransition = previewRunning && lastFired?.key === contextKey
      ? { ...lastFired.fired, id: authoredTransitionId(lastFired.fired.id) }
      : null;

  const handleDeleteState = (id: string) => {
      const updatedStates = levelGraph.states.filter(s => s.id !== id);
      // An any-state transition belongs to its target only; its stored source is not a real link.
      const updatedTrans = levelGraph.transitions.filter(t => t.toStateId !== id && (t.anyState || t.fromStateId !== id));
      updateLevel('', { states: updatedStates, transitions: updatedTrans });
      setSelectedNodeId(null);
  };

  const handleDeleteTransition = (id: string) => {
      const updatedTrans = levelGraph.transitions.filter(t => t.id !== id);
      updateLevel('', { transitions: updatedTrans });
      setSelectedNodeId(null);
  };

  const handleSelectNode = (id: string | null) => {
      setSelectedNodeId(id);
      if (id) {
          setActiveSidebarTab('inspector');
      }
  };

  return (
    <div className="flex h-full w-full bg-gray-950 text-white font-sans overflow-hidden select-none">
      
      {/* LEFT SIDEBAR: Context Selection, Blackboard & Inspector */}
      <div className="w-80 bg-gray-900 border-r border-gray-800 flex flex-col z-30 shrink-0 shadow-xl">
          
          {/* CONTEXT SELECTOR HEADER - Always Visible */}
          <div className="p-3 border-b border-gray-800 bg-gray-950 space-y-2">
              <label className="text-[10px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                  <Network size={12} /> Graph Context
              </label>
              
              <div className="flex bg-gray-900 rounded-lg border border-gray-800 p-0.5">
                  <button 
                    onClick={() => { setContextType('model'); setSelectedContextId(null); }}
                    className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded transition-all ${contextType === 'model' ? 'bg-gray-800 text-white shadow' : 'text-gray-500 hover:text-gray-300'}`}
                  >
                      <Component size={12} /> Models
                  </button>
                  <button 
                    onClick={() => { setContextType('blueprint'); setSelectedContextId(null); }}
                    className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded transition-all ${contextType === 'blueprint' ? 'bg-gray-800 text-white shadow' : 'text-gray-500 hover:text-gray-300'}`}
                  >
                      <FileCode size={12} /> Blueprints
                  </button>
              </div>

              <Select
                value={selectedContextId || ''} 
                onChange={(val) => {
                    setSelectedContextId(val);
                    setSelectedNodeId(null); 
                }}
                options={contextOptions}
              />
          </div>

          {selectedContextId ? (
              <>
                {/* TABS */}
                <div className="flex border-b border-gray-800 bg-gray-950 shrink-0">
                        <button 
                            onClick={() => setActiveSidebarTab('blackboard')}
                            className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider transition-colors border-b-2 flex items-center justify-center gap-2 ${activeSidebarTab === 'blackboard' ? 'border-blue-500 text-white bg-gray-900' : 'border-transparent text-gray-500 hover:text-gray-300 hover:bg-gray-900'}`}
                        >
                            <BoxSelect size={12} /> Blackboard
                        </button>
                        <button 
                            onClick={() => setActiveSidebarTab('inspector')}
                            className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider transition-colors border-b-2 flex items-center justify-center gap-2 ${activeSidebarTab === 'inspector' ? 'border-blue-500 text-white bg-gray-900' : 'border-transparent text-gray-500 hover:text-gray-300 hover:bg-gray-900'}`}
                        >
                            <Settings size={12} /> Inspector
                        </button>
                </div>

                <div className="flex-1 flex flex-col min-h-0 overflow-hidden relative">
                    {activeSidebarTab === 'blackboard' && (
                        <BlackboardPanel 
                            graph={currentGraph} 
                            modelId={selectedContextId}
                            updateGraph={updateGraphWithHistory}
                            runtime={previewApiRef}
                            live={previewRunning}
                        />
                    )}
                    {activeSidebarTab === 'inspector' && (
                        <InspectorPanel
                            selectedNodeId={selectedNodeId}
                            graph={levelGraph}
                            modelId={selectedContextId}
                            updateGraph={updateLevel}
                            availableClips={allSceneClips}
                            onDeleteState={handleDeleteState}
                            onDeleteTransition={handleDeleteTransition}
                            onOpenStateMachine={openStateMachine}
                        />
                    )}
                </div>
              </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-600 text-xs italic p-4 text-center">
                Select a context above to edit graph logic.
            </div>
          )}
      </div>

      {/* MAIN WORKSPACE */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#111111]">
          {selectedContextId ? (
            <>
                {/* Live Preview */}
                <div className="h-[45%] bg-black relative border-b-4 border-gray-800 shadow-2xl z-20">
                    {visible && (
                        <GraphPreview 
                            graph={currentGraph}
                            model={previewModel ?? null}
                            allClips={previewClips} 
                            controls
                            apiRef={previewApiRef}
                            onActiveStateChange={handleActiveStateChange}
                            onTransitionFired={handleTransitionFired}
                            onStatusChange={setPreviewStatus}
                            resetKey={contextKey}
                        />
                    )}
                </div>

                {/* Which state machine the canvas shows */}
                {crumbs.length > 0 && (
                    <nav aria-label="State machine path" className="flex items-center gap-1 px-3 py-1.5 bg-gray-950 border-b border-gray-800 text-[11px] shrink-0">
                        <button type="button" onClick={() => { setMachinePath([]); setSelectedNodeId(null); }} className="px-1.5 py-0.5 rounded text-gray-400 hover:text-white hover:bg-gray-800">
                            Graph
                        </button>
                        {crumbs.map((crumb, index) => (
                            <React.Fragment key={crumb.id}>
                                <ChevronRight size={12} className="text-gray-600" />
                                <button
                                    type="button"
                                    disabled={index === crumbs.length - 1}
                                    onClick={() => { setMachinePath(path.slice(0, index + 1)); setSelectedNodeId(null); }}
                                    className={`px-1.5 py-0.5 rounded ${index === crumbs.length - 1 ? 'text-white font-bold' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
                                >
                                    {crumb.name}
                                </button>
                            </React.Fragment>
                        ))}
                    </nav>
                )}

                {/* Graph Canvas */}
                <GraphCanvas
                    key={`${selectedContextId}:${path.join('/')}`}
                    graph={levelGraph}
                    modelId={selectedContextId}
                    updateGraph={updateLevel}
                    updateGraphLive={updateLevelLive}
                    onMoveEnd={commitLevelMove}
                    onOpenStateMachine={openStateMachine}
                    onUndo={history.undo}
                    onRedo={history.redo}
                    canUndo={history.canUndo}
                    canRedo={history.canRedo}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={handleSelectNode}
                    availableClips={allSceneClips}
                    activeStateId={liveActiveStateId}
                    firedTransition={firedTransition}
                />
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-500 gap-4">
                <Network size={48} className="opacity-20" />
                <p>No Context Selected</p>
                <span className="text-xs text-gray-600">Please select a Model or Blueprint from the sidebar.</span>
            </div>
          )}
      </div>
    </div>
  );
};
