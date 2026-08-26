
import { useState, useCallback } from 'react';
import { AnimationGraphData } from '../types';
import { PLAYER_GRAPH } from '../data/blueprints';

export const useGraphManager = () => {
  // Stores graph data per model ID (Legacy support for raw mesh editing)
  const [graphData, setGraphData] = useState<Record<string, AnimationGraphData>>({});

  const updateGraph = useCallback((modelId: string, data: Partial<AnimationGraphData>) => {
    setGraphData(prev => {
      const existing = prev[modelId] || JSON.parse(JSON.stringify(PLAYER_GRAPH));
      return {
        ...prev,
        [modelId]: { ...existing, ...data }
      };
    });
  }, []);

  const removeGraphData = useCallback((modelId: string) => {
    setGraphData(prev => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
  }, []);

  const resetGraphs = useCallback(() => {
      setGraphData({});
  }, []);

  return {
    graphData,
    updateGraph,
    removeGraphData,
    resetGraphs
  };
};
