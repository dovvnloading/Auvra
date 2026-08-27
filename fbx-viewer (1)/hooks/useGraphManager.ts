
import { useState, useCallback } from 'react';
import { AnimationGraphData } from '../types';
import { PLAYER_GRAPH } from '../data/blueprints';
import { projectService } from '../utils/projectService';

export const useGraphManager = () => {
  // Stores graph data per model ID (Legacy support for raw mesh editing)
  const [graphData, setGraphData] = useState<Record<string, AnimationGraphData>>({});

  const updateGraph = useCallback((modelId: string, data: Partial<AnimationGraphData>) => {
    projectService.assertWritable();
    setGraphData(prev => {
      const existing = prev[modelId] || JSON.parse(JSON.stringify(PLAYER_GRAPH));
      const next = { ...existing, ...data };
      projectService.applyChanges([{ domain: 'graphs', operation: 'upsert', id: modelId, value: { id: modelId, modelId, ...next } }]).catch((error) => {
        console.error('Failed to persist animation graph', error);
      });
      return {
        ...prev,
        [modelId]: next
      };
    });
  }, []);

  const removeGraphData = useCallback((modelId: string, persist = true) => {
    if (persist) {
      projectService.assertWritable();
      projectService.applyChanges([{ domain: 'graphs', operation: 'remove', id: modelId }]).catch((error) => {
        console.error('Failed to remove animation graph', error);
      });
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

  return {
    graphData,
    updateGraph,
    removeGraphData,
    resetGraphs
    ,hydrateGraphs
  };
};
