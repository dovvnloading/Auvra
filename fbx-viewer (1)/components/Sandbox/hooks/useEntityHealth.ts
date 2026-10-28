
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { GraphRuntimeAPI } from '../../AnimationGraph/GraphRuntime';
import type { MontageBoneWeight } from '../../AnimationGraph/utils/montage';

interface UseEntityHealthProps {
    maxHealth: number;
    /** Health to start the session with (a loaded save); full when left out. */
    initialHealth?: number;
    onHealthChange?: (current: number, max: number) => void;
    graphApiRef: React.MutableRefObject<GraphRuntimeAPI | undefined>;
    /** Played additively on each hit the character survives. */
    hitReactClip?: string | null;
    /** The share of the hit reaction parts of the body take as of the hit (MontageOptions.boneWeights); all of it when empty. */
    hitReactWeights?: React.MutableRefObject<readonly MontageBoneWeight[] | null>;
}

/** A hit reaction snaps in and eases out, added to the pose so the character keeps moving. */
export const HIT_REACTION_OPTIONS = { additive: true, blendIn: 0.05, blendOut: 0.25 } as const;

/** The upper body's share of a hit reaction while the weapon is held ready, when the blueprint sets none. */
export const DEFAULT_HIT_REACT_AIMED = 0.2;

/** A hit this soon after the last reaction started lets that one play on, so sustained fire staggers rather than shakes. */
export const HIT_REACTION_RETRIGGER_SECONDS = 0.5;

/** Whether a hit at `now` (seconds) starts a new reaction, the last having started at `last` (null when none has). */
export const hitReactionDue = (last: number | null, now: number): boolean =>
    last === null || now < last || now - last >= HIT_REACTION_RETRIGGER_SECONDS;

/** Starting health: a saved value kept within 1..max (a save is never taken dead), else full. */
export const startingHealth = (maxHealth: number, initialHealth?: number): number =>
    initialHealth !== undefined && Number.isFinite(initialHealth) ? Math.min(maxHealth, Math.max(1, initialHealth)) : maxHealth;

export const useEntityHealth = ({ maxHealth, initialHealth, onHealthChange, graphApiRef, hitReactClip, hitReactWeights }: UseEntityHealthProps) => {
    const [currentHealth, setCurrentHealth] = useState(() => startingHealth(maxHealth, initialHealth));
    const [isDead, setIsDead] = useState(false);
    const isDeadRef = useRef(false);
    // Health as of the last hit, read synchronously to tell whether a hit is survived.
    const healthRef = useRef(startingHealth(maxHealth, initialHealth));
    // The saved health applies to the session's first life only.
    const initialHealthRef = useRef(initialHealth);
    // When the playing hit reaction started, in seconds.
    const lastReactionRef = useRef<number | null>(null);

    // Sync Initial Health or Reset when maxHealth changes
    useEffect(() => {
        const start = startingHealth(maxHealth, initialHealthRef.current);
        initialHealthRef.current = undefined;
        setCurrentHealth(start);
        setIsDead(false);
        isDeadRef.current = false;
        healthRef.current = start;
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
        const now = performance.now() / 1000;
        if (healthRef.current > 0 && hitReactClip && hitReactionDue(lastReactionRef.current, now)
            && graphApiRef.current?.playMontage?.(hitReactClip, { ...HIT_REACTION_OPTIONS, boneWeights: hitReactWeights?.current ?? undefined })) {
            lastReactionRef.current = now;
        }

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
    }, [graphApiRef, hitReactClip, hitReactWeights]);

    /** Restores up to `amount` health; false when dead or already full. */
    const heal = useCallback((amount: number): boolean => {
        if (isDeadRef.current || !(amount > 0) || healthRef.current >= maxHealth) return false;
        healthRef.current = Math.min(maxHealth, healthRef.current + amount);
        setCurrentHealth(healthRef.current);
        return true;
    }, [maxHealth]);

    return {
        currentHealth,
        isDead,
        takeDamage,
        heal
    };
};
