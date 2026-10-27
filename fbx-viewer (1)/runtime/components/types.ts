import type React from 'react';
import type { LevelComponent, LevelObject } from '../../types';

export type ComponentPropType = 'number' | 'boolean' | 'string' | 'color' | 'vector3' | 'select';

/** Describes one editable component property; the inspector renders a field from this. */
export interface ComponentPropSchema {
    key: string;
    label: string;
    type: ComponentPropType;
    default: unknown;
    min?: number;
    max?: number;
    step?: number;
    options?: { label: string; value: string }[];
}

export interface ComponentRenderProps {
    object: LevelObject;
    component: LevelComponent;
    /** 'editor' renders a static preview (lights visible, no motion); 'runtime' runs behaviour. */
    mode: 'editor' | 'runtime';
}

export interface ComponentInspectorProps {
    object: LevelObject;
    component: LevelComponent;
    /** Merges `changes` into the component's props and commits them as one undoable edit. */
    onChangeProps: (changes: Record<string, unknown>) => void;
}

/**
 * A component type. Render is mounted inside the owning object's transform group, so it works
 * in local space and inherits the object's world transform. Inspector, when given, is shown under
 * the schema fields for settings a plain field cannot edit (code, tracks, ...); props it owns are
 * left out of `props`.
 */
export interface ComponentDefinition {
    type: string;
    label: string;
    description: string;
    props: ComponentPropSchema[];
    Render?: React.FC<ComponentRenderProps>;
    Inspector?: React.FC<ComponentInspectorProps>;
}
