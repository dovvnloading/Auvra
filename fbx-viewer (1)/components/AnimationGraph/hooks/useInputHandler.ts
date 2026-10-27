import { useEffect, useRef } from 'react';
import { AnimationGraphData, InputBinding } from '../../../types';

/** True when a key event belongs to a text field, so typing a state name never drives the graph. */
export const isEditableTarget = (target: EventTarget | null): boolean => {
    if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
    const element = target as HTMLElement;
    const tag = element.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable === true;
};

/**
 * The variable writes one key event causes. Press fires once per physical press (auto-repeat is
 * ignored), Release on key up, and Hold sets its value while the key is down and puts the
 * variable back to its initial value when the key comes up.
 */
export const bindingWrites = (
    graph: AnimationGraphData,
    code: string,
    isDown: boolean,
    repeat: boolean
): { variableId: string; value: number | boolean }[] => {
    const writes: { variableId: string; value: number | boolean }[] = [];
    graph.inputs.forEach((binding: InputBinding) => {
        if (binding.key !== code) return;
        if (binding.type === 'Press' && isDown && !repeat) writes.push({ variableId: binding.targetVariableId, value: binding.targetValue });
        else if (binding.type === 'Release' && !isDown) writes.push({ variableId: binding.targetVariableId, value: binding.targetValue });
        else if (binding.type === 'Hold') {
            if (isDown) writes.push({ variableId: binding.targetVariableId, value: binding.targetValue });
            else {
                const variable = graph.variables.find(v => v.id === binding.targetVariableId);
                if (variable) writes.push({ variableId: variable.id, value: variable.value });
            }
        }
    });
    return writes;
};

export const useInputHandler = (
    graph: AnimationGraphData,
    enableInputs: boolean,
    setVariable: (id: string, value: number | boolean) => void
) => {
    // Read through refs so editing the graph does not re-attach the listeners and drop held keys.
    const graphRef = useRef(graph);
    graphRef.current = graph;
    const setVariableRef = useRef(setVariable);
    setVariableRef.current = setVariable;

    useEffect(() => {
        if (!enableInputs) return;

        const handleKey = (e: KeyboardEvent, isDown: boolean) => {
            if (isEditableTarget(e.target)) return;
            bindingWrites(graphRef.current, e.code, isDown, e.repeat).forEach(write => {
                setVariableRef.current(write.variableId, write.value);
            });
        };

        const onDown = (e: KeyboardEvent) => handleKey(e, true);
        const onUp = (e: KeyboardEvent) => handleKey(e, false);

        window.addEventListener('keydown', onDown);
        window.addEventListener('keyup', onUp);

        return () => {
            window.removeEventListener('keydown', onDown);
            window.removeEventListener('keyup', onUp);
        };
    }, [enableInputs]);
};
