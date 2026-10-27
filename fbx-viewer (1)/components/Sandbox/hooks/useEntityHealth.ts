
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { GraphRuntimeAPI } from '../../AnimationGraph/GraphRuntime';

interface UseEntityHealthProps {
    maxHealth: number;
    onHealthChange?: (current: number, max: number) => void;
    graphApiRef: React.MutableRefObject<GraphRuntimeAPI | undefined>;
    /** Played additively on each hit the character survives. */
    hitReactClip?: string | null;
}

/** A hit reaction snaps in and eases out, added to the pose so the character keeps moving. */
export const HIT_REACTION_OPTIONS = { additive: true, blendIn: 0.05, blendOut: 0.25 } as const;

export const useEntityHealth = ({ maxHealth, onHealthChange, graphApiRef, hitReactClip }: UseEntityHealthProps) => {
    const [currentHealth, setCurrentHealth] = useState(maxHealth);
    const [isDead, setIsDead] = useState(false);
    const isDeadRef = useRef(false);
    // Health as of the last hit, read synchronously to tell whether a hit is survived.
    const healthRef = useRef(maxHealth);

    // Sync Initial Health or Reset when maxHealth changes
    useEffect(() => {
        setCurrentHealth(maxHealth);
        setIsDead(false);
        isDeadRef.current = false;
        healthRef.current = maxHealth;
    }, [maxHealth]);

    // Report changes up to HUD
    useEffect(() => {
        if (onHealthChange) {
            onHealthChange(currentHealth, maxHealth);
        }
    }, [currentHealth, maxHealth, onHealthChange]);

    const takeDamage = useCallback((amount: number) => {
        if (isDeadRef.current) return;
        healthRef.current = Math.max(0, healthRef.current - amount);
        if (healthRef.current > 0 && hitReactClip) graphApiRef.current?.playMontage?.(hitReactClip, HIT_REACTION_OPTIONS);

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
    }, [graphApiRef, hitReactClip]);

    return {
        currentHealth,
        isDead,
        takeDamage
    };
};
