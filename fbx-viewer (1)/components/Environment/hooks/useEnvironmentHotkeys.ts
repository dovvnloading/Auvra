
import { useEffect } from 'react';
import { EditorState } from '../types';

interface HotkeyConfig {
    state: EditorState;
    actions: {
        setInteractionMode: (mode: any) => void;
        updateTransformSettings: (updates: any) => void;
        deleteSelected: () => void;
        clearSelection: () => void;
        undo: () => void;
        redo: () => void;
    };
    history: {
        undo: () => void;
        redo: () => void;
    };
}

export const useEnvironmentHotkeys = ({ state, actions, history }: HotkeyConfig) => {
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            // Ignore inputs if typing in a field
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
            if (state.isPlaying) return;

            // Undo / Redo
            if (e.ctrlKey || e.metaKey) {
                if (e.key === 'z' || e.key === 'Z') {
                    e.preventDefault();
                    if (e.shiftKey) history.redo(); else history.undo();
                    return;
                }
                if (e.key === 'y' || e.key === 'Y') {
                    e.preventDefault();
                    history.redo();
                    return;
                }
            }

            // Deletion
            if ((e.key === 'Backspace' || e.key === 'Delete') && state.selectedObjectId) {
                actions.deleteSelected();
            }
            
            // Selection Clearing
            if (e.key === 'Escape') {
                actions.clearSelection();
            }
            
            // Mode Switching
            if (e.key === 'q' || e.key === 'Q') actions.setInteractionMode('select');
            if (e.key === 'b' || e.key === 'B') actions.setInteractionMode('paint');
            if (e.key === 'm' || e.key === 'M') actions.setInteractionMode('mask');

            // Transform Tools (Only in select mode)
            if (state.interactionMode === 'select') {
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
    }, [state, actions, history]);
};
