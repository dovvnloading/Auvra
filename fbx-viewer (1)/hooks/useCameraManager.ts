import { useState } from 'react';
import { CameraState } from '../types';
import { frontendDiagnostics } from '../diagnostics/runtime';

export const useCameraManager = () => {
  const [cameraState, setCameraState] = useState<CameraState>({
    position: [4, 4, 8],
    target: [0, 1, 0]
  });

  return frontendDiagnostics.traceActions('camera_manager', {
    cameraState,
    setCameraState
  });
};
