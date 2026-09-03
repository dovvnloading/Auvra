import { useState } from 'react';
import { CameraState } from '../types';
import { frontendDiagnostics } from '../diagnostics/runtime';
import { createDefaultCameraState } from '../utils/editorState';

export const useCameraManager = () => {
  const [cameraState, setCameraState] = useState<CameraState>(createDefaultCameraState);

  return frontendDiagnostics.traceActions('camera_manager', {
    cameraState,
    setCameraState
  });
};
