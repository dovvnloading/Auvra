import { CameraState } from '../types';

export const EDITOR_STATE_DOCUMENT_ID = 'editor-state';

export interface EditorState {
  cameraState: CameraState;
  selectedModelId: string | null;
  selectedBlueprintId: string | null;
}

export const createDefaultCameraState = (): CameraState => ({
  position: [4, 4, 8],
  target: [0, 1, 0],
});

export const createEditorStateDocument = (
  cameraState: CameraState,
  selectedModelId: string | null,
  selectedBlueprintId: string | null,
) => ({
  id: EDITOR_STATE_DOCUMENT_ID,
  name: 'Editor state',
  settings: {
    cameraState: {
      position: [...cameraState.position],
      target: [...cameraState.target],
    },
    // SelectionContext permits only one active selection. Preserve that
    // invariant in the document even if a caller supplies both IDs.
    selectedModelId: selectedModelId || null,
    selectedBlueprintId: selectedModelId ? null : selectedBlueprintId || null,
  },
});

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const tuple = (value: unknown): [number, number, number] | null => {
  if (!Array.isArray(value) || value.length !== 3 || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    return null;
  }
  return [value[0], value[1], value[2]];
};

const validId = (value: unknown): string | null => (
  typeof value === 'string' && value.length > 0 ? value : null
);

const settingsFromSnapshot = (snapshot: unknown): Record<string, unknown> => {
  if (!isRecord(snapshot)) return {};
  const candidate = snapshot as Record<string, unknown>;
  const domains = isRecord(candidate.domains) ? candidate.domains : null;
  const metadataValue = domains?.metadata ?? candidate.metadata;
  const metadataDocuments = Array.isArray(metadataValue)
    ? metadataValue
    : isRecord(metadataValue) && Array.isArray(metadataValue.documents)
      ? metadataValue.documents
      : [];
  const editorDocument = metadataDocuments.find((item) => (
    isRecord(item) && item.id === EDITOR_STATE_DOCUMENT_ID
  ));
  if (isRecord(editorDocument) && isRecord(editorDocument.settings)) return editorDocument.settings;

  // Accept the old compatibility shape while all new writes use metadata.
  if (isRecord(candidate.editorState)) return candidate.editorState;
  return candidate;
};

export const readEditorState = (snapshot: unknown): EditorState => {
  const settings = settingsFromSnapshot(snapshot);
  const position = tuple(settings.cameraState && isRecord(settings.cameraState)
    ? settings.cameraState.position : undefined);
  const target = tuple(settings.cameraState && isRecord(settings.cameraState)
    ? settings.cameraState.target : undefined);
  return {
    cameraState: position && target
      ? { position, target }
      : createDefaultCameraState(),
    selectedModelId: validId(settings.selectedModelId),
    selectedBlueprintId: validId(settings.selectedBlueprintId),
  };
};
