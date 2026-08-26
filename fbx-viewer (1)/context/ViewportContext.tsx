
import React, { createContext, useContext, ReactNode } from 'react';
import { CameraState } from '../types';
import { useCameraManager } from '../hooks/useCameraManager';

interface ViewportContextType {
  cameraState: CameraState;
  setCameraState: React.Dispatch<React.SetStateAction<CameraState>>;
}

const ViewportContext = createContext<ViewportContextType | undefined>(undefined);

export const useViewport = () => {
  const context = useContext(ViewportContext);
  if (!context) throw new Error('useViewport must be used within ViewportProvider');
  return context;
};

export const ViewportProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const cameraManager = useCameraManager();

  return (
    <ViewportContext.Provider value={cameraManager}>
      {children}
    </ViewportContext.Provider>
  );
};
