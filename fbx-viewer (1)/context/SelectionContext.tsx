
import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { frontendDiagnostics } from '../diagnostics/runtime';

interface SelectionContextType {
  selectedModelId: string | null;
  selectedBlueprintId: string | null;
  selectModel: (id: string | null) => void;
  selectBlueprint: (id: string | null) => void;
  clearModel: (id: string) => void;
  clearBlueprint: (id: string) => void;
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

  const selectModel = useCallback((id: string | null) => {
    setSelectedModelId(id);
    if (id) setSelectedBlueprintId(null);
  }, []);

  const selectBlueprint = useCallback((id: string | null) => {
    setSelectedBlueprintId(id);
    if (id) setSelectedModelId(null);
  }, []);

  // Domain managers use these conditional clears after asynchronous deletes.
  // A stale completion must not clear a newer selection made in the meantime.
  const clearModel = useCallback((id: string) => {
    setSelectedModelId((current) => current === id ? null : current);
  }, []);

  const clearBlueprint = useCallback((id: string) => {
    setSelectedBlueprintId((current) => current === id ? null : current);
  }, []);

  const value = frontendDiagnostics.traceActions('selection', {
    selectedModelId,
    selectedBlueprintId,
    selectModel,
    selectBlueprint,
    clearModel,
    clearBlueprint,
  });

  return (
    <SelectionContext.Provider value={value}>
      {children}
    </SelectionContext.Provider>
  );
};
