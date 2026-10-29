import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import {
    abilityActors, abilityBus, AbilitySystem, DEAD_TAG, PLAYER_ACTOR, resolveAbilitySet, stepStandIns, type AbilitySetDefinition,
} from '../abilities';
import { setPlayerAim, activateActorAbility } from '../abilityWorld';
import { combat } from '../destructibles';
import { gameState } from '../gameState';
import { playerActions } from '../playerActions';
import { useRuntimeServices } from '../RuntimeServicesContext';
import type { ComponentDefinition, ComponentRenderProps } from './types';

/**
 * ABILITIES
 *
 * The Abilities component makes its object an actor with attributes, effects and abilities (see
 * runtime/abilities.ts), or, set to belong to the player, gives the player theirs: the player's health
 * and maximum health are then the player's own, and the abilities bound to the Ability 1-4 input
 * actions are used with those keys, on what the player aims at. Actors are hurt by weapons and blasts
 * (less armour), regenerate, carry tags, and die when their health reaches 0 (the State.Dead tag and
 * the Actor Died event). It runs in play; the editor shows nothing for it.
 */

/** The input actions abilities can be bound to. */
export const ABILITY_INPUTS = ['Ability1', 'Ability2', 'Ability3', 'Ability4'] as const;

/** Seconds between the player's attributes and cooldowns reaching the HUD. */
const PUBLISH_INTERVAL = 0.1;

/** Stand-ins are stepped once a frame, however many actors there are. */
let standInsSteppedAt = -1;

const _position = new THREE.Vector3();
const _forward = new THREE.Vector3();

/** The player's attributes, their bounds and cooldowns, as the HUD reads them. */
const publishPlayer = (system: AbilitySystem): void => {
    const values: Record<string, number> = {};
    const max: Record<string, number> = {};
    for (const name of system.attributeNames()) {
        values[name] = Math.round((system.get(name) ?? 0) * 10) / 10;
        max[name] = Math.round(system.upperBound(name) * 10) / 10;
    }
    const cooldowns: Record<string, number> = {};
    for (const id of system.abilityIds()) cooldowns[id] = Math.ceil(system.cooldown(id) * 10) / 10;
    gameState.update({ abilities: { values, max, cooldowns } });
};

const AbilitiesActor: React.FC<{ id: string; set: AbilitySetDefinition; player: boolean }> = ({ id, set, player }) => {
    const anchor = useRef<THREE.Group>(null);
    const { input } = useRuntimeServices();
    const system = useMemo(() => new AbilitySystem(id, set), [id, set]);

    // Where it is: the object, or the player's body.
    useLayoutEffect(() => {
        system.locate = player
            ? () => combat().characters().find(character => character.team === 'Player')?.centre() ?? null
            : () => {
                const host = anchor.current?.parent;
                if (!host) return null;
                host.getWorldPosition(_position);
                return { x: _position.x, y: _position.y, z: _position.z };
            };
    }, [system, player]);

    // The player's health and its maximum are the player's own.
    useEffect(() => {
        if (!player) return undefined;
        if (system.hasAttribute('health')) {
            system.bind('health', {
                get: () => gameState.get().player.health,
                set: value => {
                    const now = gameState.get().player.health;
                    if (value < now) playerActions.damage(now - value);
                    else if (value > now) playerActions.heal(value - now);
                },
            });
        }
        if (system.hasAttribute('maxHealth')) system.bind('maxHealth', { get: () => gameState.get().player.maxHealth, set: () => undefined });
        return () => {
            system.bind('health', null);
            system.bind('maxHealth', null);
        };
    }, [system, player]);

    // In the registry, and what it does told to level scripts and gameplay scripts.
    useEffect(() => {
        const release = abilityActors.register('runtime', system);
        const off = system.on(event => {
            if (event.type === 'abilityActivated') {
                abilityBus.emit({ type: 'activated', actor: system.id, ability: event.ability, target: event.target?.id ?? null });
            } else if (event.type === 'attribute' && event.attribute === 'health' && event.value <= 0 && event.previous > 0 && !system.tags.has(DEAD_TAG)) {
                system.addTag(DEAD_TAG);
                abilityBus.emit({ type: 'died', actor: system.id });
            }
        });
        return () => {
            off();
            release();
            if (player) gameState.update({ abilities: null });
        };
    }, [system, player]);

    const sincePublish = useRef(Infinity);

    useFrame((state, delta) => {
        system.step(delta);
        if (state.clock.elapsedTime !== standInsSteppedAt) {
            standInsSteppedAt = state.clock.elapsedTime;
            stepStandIns(delta);
        }
        if (!player) return;
        state.camera.getWorldPosition(_position);
        state.camera.getWorldDirection(_forward);
        setPlayerAim({ eye: { x: _position.x, y: _position.y, z: _position.z }, forward: { x: _forward.x, y: _forward.y, z: _forward.z } });
        if (!system.tags.has(DEAD_TAG)) {
            for (const abilityId of system.abilityIds()) {
                const action = system.ability(abilityId)?.input;
                if (action && input.wasPressed(action)) activateActorAbility(system.id, abilityId);
            }
        }
        sincePublish.current += delta;
        if (sincePublish.current >= PUBLISH_INTERVAL) {
            sincePublish.current = 0;
            publishPlayer(system);
        }
    });

    useEffect(() => () => { if (player) setPlayerAim(null); }, [player]);

    return <group ref={anchor} />;
};

const AbilitiesRender: React.FC<ComponentRenderProps> = ({ object, component, mode }) => {
    const set = useMemo(() => resolveAbilitySet(component.props), [component.props]);
    const player = component.props.owner === 'player';
    if (mode !== 'runtime') return null;
    return <AbilitiesActor id={player ? PLAYER_ACTOR : object.id} set={set} player={player} />;
};

export const ABILITIES_COMPONENT: ComponentDefinition = {
    type: 'abilities',
    label: 'Abilities',
    description: 'Attributes (health, mana, stamina, armor...), effects that change them for a moment or a while (damage, healing, '
        + 'buffs, burning, stuns) and abilities with costs and cooldowns, ruled by tags. Belongs to this object, or to the player, '
        + 'who uses abilities with the number keys. Weapons and blasts hurt an actor with health; level and gameplay scripts use '
        + 'abilities, apply effects and read attributes.',
    props: [
        {
            key: 'owner', label: 'Belongs to', type: 'select', default: 'object',
            options: [{ label: 'This object', value: 'object' }, { label: 'The player', value: 'player' }],
        },
    ],
    Render: AbilitiesRender,
};
