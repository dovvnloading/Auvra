
import React, { createContext, useContext, useState, ReactNode } from 'react';
import { frontendDiagnostics } from '../diagnostics/runtime';

interface SelectionContextType {
  selectedModelId: string | null;
  selectedBlueprintId: string | null;
  selectModel: (id: string | null) => void;
  selectBlueprint: (id: string | null) => void;
}

const SelectionContext = createContext<SelectionContextType | undefined>(undefined);

export const useSelection = () => {
  const context = useContext(SelectionContext);
  if (!context) throw new Error('useSelection must be used within SelectionProvider');
  return context;
};

export const SelectionProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [selectedBlueprintId, setSelectedBlueprintId] = useState<string | null>(null);

  const selectModel = (id: string | null) => {
    setSelectedModelId(id);
    if (id) setSelectedBlueprintId(null);
  };

  const selectBlueprint = (id: string | null) => {
    setSelectedBlueprintId(id);
    if (id) setSelectedModelId(null);
  };

  const value = frontendDiagnostics.traceActions('selection', {
    selectedModelId,
    selectedBlueprintId,
    selectModel,
    selectBlueprint
  });

  return (
    <SelectionContext.Provider value={value}>
      {children}
    </SelectionContext.Provider>
  );
};
