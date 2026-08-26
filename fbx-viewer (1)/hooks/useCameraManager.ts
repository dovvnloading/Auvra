import { useState } from 'react';
import { CameraState } from '../types';

export const useCameraManager = () => {
  const [cameraState, setCameraState] = useState<CameraState>({
    position: [4, 4, 8],
    target: [0, 1, 0]
  });

  return {
    cameraState,
    setCameraState
  };
};