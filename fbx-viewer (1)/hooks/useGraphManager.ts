
import { useState, useCallback, useEffect, useRef } from 'react';
import { AnimationGraphData } from '../types';
import { PLAYER_GRAPH } from '../data/blueprints';
import { projectService } from '../utils/projectService';
import { frontendDiagnostics } from '../diagnostics/runtime';

export const useGraphManager = () => {
  // Stores graph data per model ID (Legacy support for raw mesh editing)
  const [graphData, setGraphData] = useState<Record<string, AnimationGraphData>>({});
  const graphDataRef = useRef(graphData);
  useEffect(() => { graphDataRef.current = graphData; }, [graphData]);

  const updateGraph = useCallback(async (modelId: string, data: Partial<AnimationGraphData>) => {
    projectService.assertWritable();
    const previous = graphDataRef.current[modelId];
    const existing = previous || JSON.parse(JSON.stringify(PLAYER_GRAPH));
    const next = { ...existing, ...data };
    graphDataRef.current = { ...graphDataRef.current, [modelId]: next };
    setGraphData(prev => ({ ...prev, [modelId]: next }));
    try {
      await projectService.applyChanges([{ domain: 'graphs', operation: 'upsert', id: modelId, value: { id: modelId, modelId, ...next } }]);
    } catch (error) {
      if (graphDataRef.current[modelId] === next) {
        const restored = previous === undefined
          ? Object.fromEntries(Object.entries(graphDataRef.current).filter(([id]) => id !== modelId))
          : { ...graphDataRef.current, [modelId]: previous };
        graphDataRef.current = restored;
        setGraphData(restored);
      }
      frontendDiagnostics.failure('animation_graph_persist_failed', error);
    }
  }, []);

  const removeGraphData = useCallback(async (modelId: string, persist = true) => {
    if (persist) {
      projectService.assertWritable();
      try {
        await projectService.applyChanges([{ domain: 'graphs', operation: 'remove', id: modelId }]);
      } catch (error) {
        frontendDiagnostics.failure('animation_graph_remove_failed', error);
        return;
      }
    }
    setGraphData(prev => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
  }, []);

  const resetGraphs = useCallback(() => {
      setGraphData({});
  }, []);

  const hydrateGraphs = useCallback((graphs: Record<string, AnimationGraphData>) => {
      setGraphData(graphs);
  }, []);

  return frontendDiagnostics.traceActions('animation_graph_manager', {
    graphData,
    updateGraph,
    removeGraphData,
    resetGraphs
    ,hydrateGraphs
  });
};
