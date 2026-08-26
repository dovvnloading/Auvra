import { useEffect } from 'react';
import { AnimationGraphData } from '../../../types';

export const useInputHandler = (
    graph: AnimationGraphData,
    enableInputs: boolean,
    setVariable: (id: string, value: number | boolean) => void
) => {
    useEffect(() => {
        if (!enableInputs) return;

        const handleKey = (e: KeyboardEvent, isDown: boolean) => {
            const bindings = graph.inputs.filter(i => 
                (i.type === 'Press' && isDown && i.key === e.code) ||
                (i.type === 'Release' && !isDown && i.key === e.code) ||
                (i.type === 'Hold' && isDown && i.key === e.code) 
            );

            bindings.forEach(b => {
                setVariable(b.targetVariableId, b.targetValue);
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
    }, [graph.inputs, enableInputs, setVariable]);
};