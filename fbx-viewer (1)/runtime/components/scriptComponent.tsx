import type React from 'react';
import type { LevelComponent } from '../../types';
import type { ComponentDefinition, ComponentRenderProps } from './types';

/** The stored type of gameplay script components. */
export const SCRIPT_COMPONENT_TYPE = 'script';

/** A script component's source (props.source, TypeScript or JavaScript); '' when it has none. */
export const readScriptSource = (component: Pick<LevelComponent, 'props'>): string => {
    const source = component.props?.source;
    return typeof source === 'string' ? source : '';
};

// The scripts run in the play session's ScriptRuntime, not here. Rendering nothing still gives a scripted
// object its own transform group in the level runtime (static leaves are instanced instead), so the moves
// and visibility changes its script makes reach exactly that object.
const ScriptRender: React.FC<ComponentRenderProps> = () => null;

/** A gameplay script attached to an object; its source lives in props.source and is edited by ScriptInspector. */
export const SCRIPT_COMPONENT: ComponentDefinition = {
    type: SCRIPT_COMPONENT_TYPE,
    label: 'Script',
    description: 'Runs a TypeScript or JavaScript gameplay script while playing. Each frame it reads the world and can move, hide, spawn or destroy objects, push bodies, cast rays, play sounds, set level variables and print.',
    props: [],
    Render: ScriptRender,
};
