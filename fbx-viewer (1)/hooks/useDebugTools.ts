
import { useState, useCallback } from 'react';
import { DebugProjectile } from '../types';

export const useDebugTools = () => {
  const [debugProjectile, setDebugProjectile] = useState<DebugProjectile>({ 
    trigger: 0, 
    origin: [0,0,0], 
    direction: [0,0,1] 
  });

  const triggerDebugProjectile = useCallback((origin: [number, number, number], direction: [number, number, number]) => {
      setDebugProjectile(prev => ({
          trigger: prev.trigger + 1,
          origin,
          direction
      }));
  }, []);

  return {
    debugProjectile,
    triggerDebugProjectile
  };
};
