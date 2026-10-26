import type { LevelComponent } from '../../types';
import { BUILTIN_COMPONENTS } from './builtins';
import { AUDIO_COMPONENTS } from './audioComponents';
import { PARTICLES_COMPONENT } from './particles';
import { PHYSICS_COMPONENTS } from './physicsComponents';
import type { ComponentDefinition } from './types';

/** Every component type an object can carry, in the order the inspector offers them. */
export const COMPONENT_DEFINITIONS: ComponentDefinition[] = [
    ...BUILTIN_COMPONENTS,
    ...PHYSICS_COMPONENTS,
    PARTICLES_COMPONENT,
    ...AUDIO_COMPONENTS,
];

/** The definition for a stored component type, or undefined for a type this build does not know. */
export const getComponentDefinition = (type: string): ComponentDefinition | undefined =>
    COMPONENT_DEFINITIONS.find(definition => definition.type === type);

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
