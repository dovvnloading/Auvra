import { useEffect, useRef } from 'react';
import { EditorState } from '../types';
import { useScene } from '../../../context/SceneContext';
import { editorSession } from '../../../utils/editorSession';
import { frontendDiagnostics } from '../../../diagnostics/runtime';
import { collectSubtree } from '../../../utils/sceneGraph';
import { copyLevelObjects, pasteLevelObjects, readLevelClipboard, writeLevelClipboard, type LevelClipboardPayload } from '../../../utils/levelClipboard';
import { deleteSelectedSplinePoint, splineEditing } from '../splineEditing';

interface HotkeyConfig {
    state: EditorState & { selectedObjectIds?: string[] };
    actions: {
        setInteractionMode: (mode: any) => void;
        updateTransformSettings: (updates: any) => void;
        /** Unused: Delete removes the whole selection (with descendants) here. */
        deleteSelected?: () => void;
        clearSelection: () => void;
        setSelection: (ids: string[], primary?: string) => void;
        requestFocus: (id: string) => void;
        undo: () => void;
        redo: () => void;
    };
    history: {
        undo: () => void;
        redo: () => void;
    };
}

const isEditableTarget = (target: EventTarget | null) => {
    const element = target as HTMLElement | null;
    return !!element && (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName));
};

const hasTextSelection = () => !!window.getSelection()?.toString();

export const useEnvironmentHotkeys = (config: HotkeyConfig) => {
    const scene = useScene();
    const latest = useRef({ config, scene });
    latest.current = { config, scene };
    const pasteCount = useRef(0);
    useEffect(() => {
        /** Insert `objects` (parents first); returns the id each one ended up with. */
        const place = (payload: LevelClipboardPayload | null, offset: [number, number, number]) => {
            const current = latest.current.scene;
            const levelId = editorSession.captureReady()?.levelId;
            if (!payload || !levelId || levelId !== current.currentLevelId) return;
            const pasted = pasteLevelObjects(payload, {
                levelId,
                levelObjects: current.levelObjects,
                offset,
                canPlace: (object) => !object.modelId || (object.type !== 'prop' && object.type !== 'foliage')
                    || current.models.some((model) => model.id === object.modelId),
            });
            if (pasted.objects.length === 0) return;
            void current.addLevelObjects(pasted.objects).then((ids) => {
                const selected = pasted.rootIds.filter(id => ids.includes(id));
                if (selected.length && editorSession.captureReady()) latest.current.config.actions.setSelection(selected);
            }).catch((error) => frontendDiagnostics.failure('level_paste_failed', error));
        };

        const handleKey = (e: KeyboardEvent) => {
            // Ignore inputs if typing in a field
            if (isEditableTarget(e.target)) return;
            const { config: { state, actions, history }, scene: current } = latest.current;
            if (state.isPlaying) return;

            const live = new Set(current.levelObjects.map((object) => object.id));
            const selection = (state.selectedObjectIds ?? (state.selectedObjectId ? [state.selectedObjectId] : []))
                .filter((id) => live.has(id));
            // Level edits stay out of the Level Blueprint overlay and of a session that is switching.
            const inBlueprint = state.interactionMode === 'blueprint';
            const canEdit = () => !inBlueprint && editorSession.captureReady() !== null;
            const gridStep = state.transformSettings.snapEnabled ? state.transformSettings.snapGrid : 1;

            if (e.ctrlKey || e.metaKey) {
                const key = e.key.toLowerCase();
                // The Level Blueprint overlay owns undo/redo/duplicate (its own Ctrl+Z) while it is open.
                if (inBlueprint && (key === 'z' || key === 'y' || key === 'd')) return;
                if (key === 'z') {
                    e.preventDefault();
                    if (e.shiftKey) history.redo(); else history.undo();
                } else if (key === 'y') {
                    e.preventDefault();
                    history.redo();
                } else if (key === 's') {
                    e.preventDefault();
                    void current.saveProject();
                } else if (key === 'a') {
                    e.preventDefault();
                    if (canEdit()) actions.setSelection(current.levelObjects.filter((object) => object.type !== 'foliage_set').map((object) => object.id), state.selectedObjectId ?? undefined);
                } else if (key === 'd') {
                    e.preventDefault();
                    if (canEdit() && selection.length) place(copyLevelObjects(current.levelObjects, selection), [gridStep, 0, gridStep]);
                } else if (key === 'c') {
                    // Leave a text selection (e.g. in a panel) to the browser's own copy.
                    if (hasTextSelection() || !canEdit() || selection.length === 0) return;
                    const payload = copyLevelObjects(current.levelObjects, selection);
                    if (!payload) return;
                    e.preventDefault();
                    writeLevelClipboard(payload);
                    pasteCount.current = 0;
                } else if (key === 'v') {
                    e.preventDefault();
                    if (!canEdit()) return;
                    pasteCount.current += 1;
                    const step = gridStep * pasteCount.current;
                    place(readLevelClipboard(), [step, 0, step]);
                }
                // Other modified keys never fall through to the single-key tools below.
                return;
            }

            // A selected spline point is deleted, or deselected, before its object.
            const splinePoint = splineEditing.get();
            const splineObject = splinePoint && selection.includes(splinePoint.objectId)
                ? current.levelObjects.find((object) => object.id === splinePoint.objectId)
                : undefined;
            if (splineObject && (e.key === 'Backspace' || e.key === 'Delete')) {
                e.preventDefault();
                if (!canEdit()) return;
                const components = deleteSelectedSplinePoint(splineObject);
                if (components) {
                    current.snapshotHistory();
                    current.updateLevelObject(splineObject.id, { components });
                }
                return;
            }
            if (splineObject && e.key === 'Escape') {
                splineEditing.set(null);
                return;
            }

            // Deletion: the selection and everything parented under it, as one undo step.
            if (e.key === 'Backspace' || e.key === 'Delete') {
                if (selection.length && canEdit()) {
                    e.preventDefault();
                    const ids = new Set(selection.flatMap((id) => collectSubtree(current.levelObjects, id).map((object) => object.id)));
                    current.removeLevelObjects([...ids]);
                    actions.setSelection([]);
                }
                return;
            }

            // Selection Clearing
            if (e.key === 'Escape') {
                // In the Terrain and Foliage tools, Escape is the brush's: it cancels what is in progress there.
                if (state.interactionMode !== 'sculpt' && state.interactionMode !== 'paint') actions.clearSelection();
                return;
            }

            if ((e.key === 'f' || e.key === 'F') && state.selectedObjectId && state.interactionMode !== 'blueprint') {
                actions.requestFocus(state.selectedObjectId);
                return;
            }

            // Mode Switching
            if (e.key === 'q' || e.key === 'Q') actions.setInteractionMode('select');
            if (e.key === 'b' || e.key === 'B') actions.setInteractionMode('paint');
            if (e.key === 'm' || e.key === 'M') actions.setInteractionMode('mask');

            // Transform Tools (Only in select mode, and the Foliage tool, whose Select moves instances)
            if (state.interactionMode === 'select' || state.interactionMode === 'paint') {
                if (e.key === 'w' || e.key === 'W') actions.updateTransformSettings({ tool: 'translate' });
                if (e.key === 'e' || e.key === 'E') actions.updateTransformSettings({ tool: 'rotate' });
                if (e.key === 'r' || e.key === 'R') actions.updateTransformSettings({ tool: 'scale' });
            }

            // Toggles
            if (e.key === 'z' || e.key === 'Z') {
                actions.updateTransformSettings({ space: state.transformSettings.space === 'world' ? 'local' : 'world' });
            }
            if (e.key === 'x' || e.key === 'X') {
                actions.updateTransformSettings({ snapEnabled: !state.transformSettings.snapEnabled });
            }
        };

        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, []);
};
