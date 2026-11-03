import React, { Component, Suspense, useMemo } from 'react';
import { Physics, useRapier } from '@react-three/rapier';
import { frontendDiagnostics } from '../diagnostics/runtime';
import { PhysicsQueriesContext, createPhysicsQueries } from './physicsQueries';

export * from './physicsQueries';

/**
 * The play session's physics world (Rapier through @react-three/rapier). What gameplay asks of it is in
 * runtime/physicsQueries.ts.
 */

const PhysicsServices: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
    const { world, rapier } = useRapier();
    const queries = useMemo(() => createPhysicsQueries(world, rapier), [world, rapier]);
    return React.createElement(PhysicsQueriesContext.Provider, { value: queries }, children);
};

interface PhysicsFailureBoundaryProps {
    /** Diagnostics code reported for a handled failure. */
    code: string;
    /** Rendered in place of the children once a handled failure happened. */
    fallback?: React.ReactNode;
    /** Which errors this boundary absorbs; anything else propagates to the next boundary. Defaults to all. */
    handles?: (error: unknown) => boolean;
    children?: React.ReactNode;
}

interface PhysicsFailureBoundaryState {
    error: unknown;
    handled: boolean;
}

/**
 * Keeps a physics failure local: reports it once, then renders `fallback` instead of crashing the
 * scene. Errors it does not handle, and any error thrown by the fallback, go to the next boundary up.
 */
export class PhysicsFailureBoundary extends Component<PhysicsFailureBoundaryProps, PhysicsFailureBoundaryState> {
    state: PhysicsFailureBoundaryState = { error: null, handled: false };
    private absorbed: unknown = null;

    static getDerivedStateFromError(error: unknown): Partial<PhysicsFailureBoundaryState> {
        return { error: error ?? new Error('physics failure') };
    }

    private absorbs(error: unknown): boolean {
        return !this.state.handled && (!this.props.handles || this.props.handles(error));
    }

    componentDidCatch(error: unknown) {
        if (!this.absorbs(error)) return;
        this.absorbed = error;
        frontendDiagnostics.failure(this.props.code, error);
        this.setState({ handled: true });
    }

    render() {
        const { error, handled } = this.state;
        if (error === null) return this.props.children ?? null;
        if (handled ? error !== this.absorbed : !this.absorbs(error)) throw error;
        return handled ? (this.props.fallback ?? null) : null;
    }
}

/** Rapier ships as WebAssembly; a page that cannot compile it (CSP, old engine) plays on without physics. */
export const isPhysicsEngineLoadError = (error: unknown): boolean => {
    if (typeof WebAssembly !== 'undefined' && (error instanceof WebAssembly.CompileError
        || error instanceof WebAssembly.LinkError || error instanceof WebAssembly.RuntimeError)) return true;
    const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
    return /webassembly|\bwasm\b/i.test(text);
};

const GRAVITY: [number, number, number] = [0, -9.81, 0];

export interface PhysicsWorldProps {
    children?: React.ReactNode;
    /** Freezes the simulation (pause menu, game over); bodies keep their state. */
    paused?: boolean;
    /** Draws every collider as Rapier debug lines. */
    debug?: boolean;
}

/**
 * The physics world of a play session. Children render once Rapier has loaded; if it cannot load
 * they render without physics (bodies are skipped, queries hit nothing) and the failure is reported.
 */
export const PhysicsWorld: React.FC<PhysicsWorldProps> = ({ children, paused = false, debug = false }) =>
    React.createElement(
        PhysicsFailureBoundary,
        { code: 'physics_engine_unavailable', handles: isPhysicsEngineLoadError, fallback: children },
        React.createElement(
            Suspense,
            { fallback: null },
            React.createElement(Physics, {
                gravity: GRAVITY,
                paused,
                debug,
                children: React.createElement(PhysicsServices, null, children)
            })
        )
    );
