import React, { useEffect, useMemo, useRef, useState } from 'react';
import { clampHUDPosition, HUDElement, HUDLayout, normalizeHUDLayout } from './types';
import { COMPONENT_REGISTRY } from './componentRegistry';
import { readGameStateBinding, useGameState } from '../../runtime/gameState';
import type { HUDDocumentData } from '../../runtime/types';

type BindingEntry = [prop: string, path: string];

interface HUDRendererProps {
    document: HUDDocumentData;
    /** Resolves each element's `props.bind` map ({ propName: 'player.health' }) against the live game state. */
    bindings?: boolean;
    /** Editor hooks. Without `renderElement` the HUD is read-only and never takes pointer input. */
    stageRef?: React.Ref<HTMLDivElement>;
    stageClassName?: string;
    stageChildren?: React.ReactNode;
    onScaleChange?: (scale: number) => void;
    renderElement?: (element: HUDElement, position: HUDElement['position'], content: React.ReactNode) => React.ReactNode;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Accepts persisted or packaged element records, skipping any that cannot be placed on the stage. */
export function toHUDElements(elements: readonly unknown[]): HUDElement[] {
    const result: HUDElement[] = [];
    for (const candidate of elements) {
        if (!isRecord(candidate) || typeof candidate.id !== 'string' || typeof candidate.type !== 'string') continue;
        const { position, size } = candidate;
        if (!isRecord(position) || !isFiniteNumber(position.x) || !isFiniteNumber(position.y)) continue;
        if (!isRecord(size) || !isFiniteNumber(size.width) || !isFiniteNumber(size.height)) continue;
        result.push({
            ...(candidate as unknown as HUDElement),
            name: typeof candidate.name === 'string' ? candidate.name : candidate.id,
            props: isRecord(candidate.props) ? candidate.props : {},
            zIndex: isFiniteNumber(candidate.zIndex) ? candidate.zIndex : 0,
            isVisible: candidate.isVisible !== false,
            isLocked: candidate.isLocked === true,
        });
    }
    return result;
}

/** Returns the binding map when `bind` is an object of prop name to binding path. */
const bindingEntries = (bind: unknown): BindingEntry[] | null => {
    if (!isRecord(bind)) return null;
    const entries = Object.entries(bind).filter((entry): entry is BindingEntry => typeof entry[1] === 'string');
    return entries.length ? entries : null;
};

const withoutBind = (props: Record<string, unknown>): Record<string, unknown> => {
    if (!isRecord(props.bind)) return props;
    const rest = { ...props };
    delete rest.bind;
    return rest;
};

const BoundHUDComponent: React.FC<{ Component: React.FC<any>; props: Record<string, unknown>; entries: BindingEntry[] }> = ({ Component, props, entries }) => {
    // A primitive key keeps useSyncExternalStore stable and re-renders only when a bound value changes.
    const key = useGameState(state => JSON.stringify(entries.map(([, path]) => readGameStateBinding(state, path))));
    const resolved = useMemo(() => {
        const values = JSON.parse(key) as (number | boolean | string | null)[];
        const next = { ...props };
        // Unknown paths resolve to null and keep the authored value.
        entries.forEach(([prop], index) => { if (values[index] !== null) next[prop] = values[index]; });
        return next;
    }, [entries, key, props]);
    return <Component {...resolved} />;
};

const HUDElementContent: React.FC<{ element: HUDElement; bindings: boolean }> = ({ element, bindings }) => {
    const Component = COMPONENT_REGISTRY[element.type];
    const entries = useMemo(() => (bindings ? bindingEntries(element.props.bind) : null), [bindings, element.props.bind]);
    const props = useMemo(() => withoutBind(element.props), [element.props]);
    if (!Component) return null;
    if (entries) return <BoundHUDComponent Component={Component} props={props} entries={entries} />;
    return <Component {...props} />;
};

/**
 * Lays out a HUD document on its logical stage (1920x1080 by default), letterboxed
 * into the parent, and renders its registered components. The editor canvas
 * reuses it with `renderElement` for selection and drag chrome.
 */
export const HUDRenderer: React.FC<HUDRendererProps> = ({
    document: hudDocument,
    bindings = false,
    stageRef,
    stageClassName,
    stageChildren,
    onScaleChange,
    renderElement,
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const normalizedLayout: HUDLayout = useMemo(() => normalizeHUDLayout(hudDocument.layout), [hudDocument.layout]);
    const elements = useMemo(() => toHUDElements(hudDocument.elements), [hudDocument.elements]);
    const [viewport, setViewport] = useState({ width: 0, height: 0 });
    const readOnly = !renderElement;

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const updateViewport = () => {
            const rect = container.getBoundingClientRect();
            setViewport({ width: rect.width, height: rect.height });
        };
        updateViewport();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(updateViewport);
        observer.observe(container);
        return () => observer.disconnect();
    }, []);

    const scale = viewport.width > 0 && viewport.height > 0
        ? Math.min(viewport.width / normalizedLayout.width, viewport.height / normalizedLayout.height)
        : 1;
    const stageOffset = {
        x: Math.max(0, (viewport.width - normalizedLayout.width * scale) / 2),
        y: Math.max(0, (viewport.height - normalizedLayout.height * scale) / 2),
    };

    useEffect(() => {
        onScaleChange?.(scale);
    }, [onScaleChange, scale]);

    return (
        <div
            ref={containerRef}
            className="absolute inset-0 overflow-hidden"
            style={readOnly ? { pointerEvents: 'none' } : undefined}
            data-hud-renderer={hudDocument.id}
        >
            {/* The stage owns the logical document coordinate space.  It is
                fitted into the available pane, but its children keep their
                authored coordinates. */}
            <div
                ref={stageRef}
                className={`absolute ${stageClassName ?? ''}`}
                style={{
                    left: stageOffset.x,
                    top: stageOffset.y,
                    width: normalizedLayout.width,
                    height: normalizedLayout.height,
                    transform: `scale(${scale})`,
                    transformOrigin: 'top left',
                }}
            >
                {stageChildren}
                {elements
                    .filter(el => el.isVisible && COMPONENT_REGISTRY[el.type])
                    .sort((a, b) => a.zIndex - b.zIndex)
                    .map(el => {
                        const position = clampHUDPosition(el.position, el.size, normalizedLayout);
                        const content = <HUDElementContent element={el} bindings={bindings} />;
                        if (renderElement) return <React.Fragment key={el.id}>{renderElement(el, position, content)}</React.Fragment>;
                        return (
                            <div
                                key={el.id}
                                data-hud-element={el.id}
                                style={{
                                    position: 'absolute',
                                    left: position.x,
                                    top: position.y,
                                    width: el.size.width,
                                    height: el.size.height,
                                    zIndex: el.zIndex,
                                    pointerEvents: 'none',
                                }}
                            >
                                <div className="w-full h-full overflow-hidden">{content}</div>
                            </div>
                        );
                    })}
            </div>
        </div>
    );
};
