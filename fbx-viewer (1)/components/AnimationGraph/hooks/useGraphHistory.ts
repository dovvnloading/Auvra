import { useCallback, useRef } from 'react';
import { AnimationGraphData } from '../../../types';
import { useEditorHistory } from '../../../utils/history';
import { frontendDiagnostics } from '../../../diagnostics/runtime';

type GraphUpdater = (modelId: string, data: Partial<AnimationGraphData>) => void;

/** Consecutive keystrokes in the same text field within this window form one undo step. */
const HISTORY_COALESCE_MS = 1000;

/** The focused text-entry field, if any, so per-keystroke onChange edits can be coalesced. */
const focusedTextEntry = (): HTMLElement | null => {
    if (typeof document === 'undefined') return null;
    const element = document.activeElement as HTMLElement | null;
    if (!element) return null;
    if (element.tagName === 'TEXTAREA' || element.isContentEditable) return element;
    if (element.tagName !== 'INPUT') return null;
    const type = (element as HTMLInputElement).type;
    return type === 'checkbox' || type === 'radio' || type === 'button' ? null : element;
};

/** Undo restores authored graph data but keeps the live preview's active state. */
export const restoreGraphSnapshot = (snapshot: AnimationGraphData, current: AnimationGraphData): AnimationGraphData => ({
    ...snapshot,
    activeStateId: current.activeStateId,
});

/**
 * Undo/redo for the Animation Graph editor.
 *
 * `updateGraphWithHistory` records the graph before every edit (state, transition, variable and
 * input-binding changes); `commitMove` records the pre-drag snapshot once a node move ends.
 */
export const useGraphHistory = ({ graph, updateGraph, active, resetKey }: {
    graph: AnimationGraphData;
    updateGraph: GraphUpdater;
    active: boolean;
    resetKey: unknown;
}) => {
    const graphRef = useRef(graph);
    graphRef.current = graph;
    const lastEdit = useRef<{ target: HTMLElement; at: number } | null>(null);

    const apply = useCallback((restored: AnimationGraphData) => {
        lastEdit.current = null;
        try {
            updateGraph('', restoreGraphSnapshot(restored, graphRef.current));
        } catch (error) {
            frontendDiagnostics.failure('animation_graph_history_apply_failed', error);
        }
    }, [updateGraph]);

    const history = useEditorHistory<AnimationGraphData>({ value: graph, apply, active, resetKey });
    const { record } = history;

    const updateGraphWithHistory = useCallback<GraphUpdater>((modelId, data) => {
        const target = focusedTextEntry();
        const now = Date.now();
        const previous = lastEdit.current;
        lastEdit.current = target ? { target, at: now } : null;
        if (!(target && previous?.target === target && now - previous.at < HISTORY_COALESCE_MS)) record();
        updateGraph(modelId, data);
    }, [record, updateGraph]);

    const commitMove = useCallback((before: AnimationGraphData) => {
        lastEdit.current = null;
        record(before);
    }, [record]);

    return { ...history, updateGraphWithHistory, commitMove };
};
