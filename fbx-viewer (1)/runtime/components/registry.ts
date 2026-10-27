import type React from 'react';
import type { LevelComponent } from '../../types';
import { BUILTIN_COMPONENTS } from './builtins';
import { ANIMATION_COMPONENT } from './animationComponent';
import { AUDIO_COMPONENTS } from './audioComponents';
import { AUDIO_ZONE_COMPONENTS } from './audioZones';
import { CAMERA_COMPONENT } from './cameraComponent';
import { DECAL_COMPONENT } from './decalComponent';
import { DIALOGUE_COMPONENT } from './dialogueComponent';
import { PARTICLES_COMPONENT } from './particles';
import { IK_COMPONENTS } from './ikComponents';
import { JOINT_COMPONENTS } from './jointComponents';
import { NET_SYNC_COMPONENT } from './netSyncComponent';
import { LOD_COMPONENTS } from './lodComponents';
import { LEVEL_STREAMING_COMPONENT } from './levelStreamingComponent';
import { PHYSICS_COMPONENTS } from './physicsComponents';
import { POST_PROCESS_COMPONENT } from './postProcess';
import { REFLECTION_PROBE_COMPONENT } from './reflectionProbe';
import { SCRIPT_COMPONENT } from './scriptComponent';
import { TIMELINE_COMPONENT } from './timelineComponent';
import { WATER_COMPONENT } from './waterComponent';
import type { ComponentDefinition, ComponentInspectorProps } from './types';

/** Every component type an object can carry, in the order the inspector offers them. */
export const COMPONENT_DEFINITIONS: ComponentDefinition[] = [
    ...BUILTIN_COMPONENTS,
    CAMERA_COMPONENT,
    ...PHYSICS_COMPONENTS,
    ...JOINT_COMPONENTS,
    PARTICLES_COMPONENT,
    DECAL_COMPONENT,
    WATER_COMPONENT,
    ...AUDIO_COMPONENTS,
    ...AUDIO_ZONE_COMPONENTS,
    POST_PROCESS_COMPONENT,
    REFLECTION_PROBE_COMPONENT,
    ...LOD_COMPONENTS,
    LEVEL_STREAMING_COMPONENT,
    ANIMATION_COMPONENT,
    ...IK_COMPONENTS,
    SCRIPT_COMPONENT,
    NET_SYNC_COMPONENT,
    TIMELINE_COMPONENT,
    DIALOGUE_COMPONENT,
];

/** The definition for a stored component type, or undefined for a type this build does not know. */
export const getComponentDefinition = (type: string): ComponentDefinition | undefined =>
    COMPONENT_DEFINITIONS.find(definition => definition.type === type);

/**
 * Attaches an editor Inspector to a component type. Inspectors are editor UI, so they are registered
 * from the editor (components/Environment/componentInspectors.ts) and never reach the game player's bundle.
 */
export const registerComponentInspector = (type: string, Inspector: React.FC<ComponentInspectorProps>): void => {
    const definition = getComponentDefinition(type);
    if (definition) definition.Inspector = Inspector;
};

/** A new, enabled component of `type` with every property at its default. */
export const createComponent = (type: string): LevelComponent => {
    const definition = getComponentDefinition(type);
    if (!definition) throw new Error(`Unknown component type "${type}".`);
    return {
        id: crypto.randomUUID(),
        type,
        enabled: true,
        // Copied so components never share a default array (e.g. a vector3) with the schema or each other.
        props: Object.fromEntries(definition.props.map(prop => [prop.key, structuredClone(prop.default)]))
    };
};
