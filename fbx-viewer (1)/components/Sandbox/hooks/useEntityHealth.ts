
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { GraphRuntimeAPI } from '../../AnimationGraph/GraphRuntime';

interface UseEntityHealthProps {
    maxHealth: number;
    onHealthChange?: (current: number, max: number) => void;
    graphApiRef: React.MutableRefObject<GraphRuntimeAPI | undefined>;
}

export const useEntityHealth = ({ maxHealth, onHealthChange, graphApiRef }: UseEntityHealthProps) => {
    const [currentHealth, setCurrentHealth] = useState(maxHealth);
    const [isDead, setIsDead] = useState(false);
    const isDeadRef = useRef(false);

    // Sync Initial Health or Reset when maxHealth changes
    useEffect(() => {
        setCurrentHealth(maxHealth);
        setIsDead(false);
        isDeadRef.current = false;
    }, [maxHealth]);

    // Report changes up to HUD
    useEffect(() => {
        if (onHealthChange) {
            onHealthChange(currentHealth, maxHealth);
        }
    }, [currentHealth, maxHealth, onHealthChange]);

    const takeDamage = useCallback((amount: number) => {
        if (isDeadRef.current) return;

        setCurrentHealth(prev => {
            const newVal = Math.max(0, prev - amount);
            
            if (newVal <= 0 && !isDeadRef.current) {
                setIsDead(true);
                isDeadRef.current = true;
                // Sync death state to Animation Graph if available
                if (graphApiRef.current) {
                    graphApiRef.current.setVariable('IsDead', true);
                }
            }
            return newVal;
        });
    }, [graphApiRef]);

    return {
        currentHealth,
        isDead,
        takeDamage
    };
};
