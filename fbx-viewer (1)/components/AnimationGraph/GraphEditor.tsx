
import React, { useState, useMemo } from 'react';
import { BoxSelect, Network, Component, FileCode, Settings } from 'lucide-react';
import { GraphPreview } from './GraphPreview';
import { BlackboardPanel } from './BlackboardPanel';
import { InspectorPanel } from './InspectorPanel';
import { GraphCanvas } from './GraphCanvas';
import { Select } from '../UI/Select';
import { useGraphContext } from './hooks/useGraphContext';

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

  const handleDeleteState = (id: string) => {
      const updatedStates = currentGraph.states.filter(s => s.id !== id);
      const updatedTrans = currentGraph.transitions.filter(t => t.fromStateId !== id && t.toStateId !== id);
      handleUpdateGraph('', { states: updatedStates, transitions: updatedTrans });
      setSelectedNodeId(null);
  };

  const handleDeleteTransition = (id: string) => {
      const updatedTrans = currentGraph.transitions.filter(t => t.id !== id);
      handleUpdateGraph('', { transitions: updatedTrans });
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
                            updateGraph={handleUpdateGraph} 
                        />
                    )}
                    {activeSidebarTab === 'inspector' && (
                        <InspectorPanel 
                            selectedNodeId={selectedNodeId}
                            graph={currentGraph}
                            modelId={selectedContextId}
                            updateGraph={handleUpdateGraph}
                            availableClips={allSceneClips}
                            onDeleteState={handleDeleteState}
                            onDeleteTransition={handleDeleteTransition}
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
                    <div className="absolute top-4 left-4 z-10 bg-gray-900/80 backdrop-blur px-3 py-1.5 rounded-full text-[10px] font-bold text-green-400 border border-gray-700 flex items-center gap-2 shadow-lg">
                        <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                        LIVE PREVIEW {previewModel ? `(${previewModel.name})` : '(No Mesh Linked)'}
                    </div>
                    
                    {visible && (
                        <GraphPreview 
                            graph={currentGraph}
                            model={previewModel}
                            allClips={previewClips} 
                        />
                    )}
                </div>

                {/* Graph Canvas */}
                <GraphCanvas 
                    key={selectedContextId}
                    graph={currentGraph}
                    modelId={selectedContextId}
                    updateGraph={handleUpdateGraph}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={handleSelectNode}
                    availableClips={allSceneClips}
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
