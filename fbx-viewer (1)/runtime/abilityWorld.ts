import {
    abilityActors, pickAbilityTarget, standInFor, PLAYER_ACTOR, type AbilityRefusal, type AbilitySystem, type Vec3,
} from './abilities';
import { combat } from './destructibles';

/**
 * ABILITIES IN THE WORLD
 *
 * Where abilities meet the play session's characters: finding an actor by id (an object with an
 * Abilities component, the player, or any living character through a stand-in), what an ability is
 * aimed at, and using abilities and applying effects for level scripts and gameplay scripts.
 */

/** The player's view, kept current by the player's Abilities component: what their abilities aim along. */
let playerAim: { eye: Vec3; forward: Vec3 } | null = null;

export const setPlayerAim = (aim: { eye: Vec3; forward: Vec3 } | null): void => {
    playerAim = aim;
};

/** An actor by id: one with an Abilities component, else a stand-in for a living character of that id. */
export const findActor = (id: string): AbilitySystem | null => {
    const actor = abilityActors.get('runtime', id);
    if (actor) return actor;
    const character = combat().characters().find(entry => entry.id === id);
    return character ? standInFor(character) : null;
};

/**
 * What `actor` aims an ability of `range` metres at: for the player, what is nearest the middle of
 * their view; for any other actor, the nearest actor or character in reach.
 */
export const aimedTarget = (actor: AbilitySystem, range: number): AbilitySystem | null => {
    const from = actor.locate?.();
    if (!from) return null;
    const player = actor.id === PLAYER_ACTOR;
    const aim = player && playerAim ? playerAim : { eye: from, forward: { x: 0, y: 0, z: 1 } };
    return pickAbilityTarget({
        user: actor,
        from,
        eye: aim.eye,
        forward: aim.forward,
        range,
        actors: abilityActors.all('runtime'),
        characters: combat().characters(),
        ownTeam: player ? 'Player' : null,
        cone: player && playerAim ? undefined : Math.PI,
    });
};

/**
 * Uses an actor's ability: on `targetId` when given, else (for an ability with a target and a range)
 * on what it aims at. Returns why it could not, or null when it was used.
 */
export const activateActorAbility = (actorId: string, abilityId: string, targetId: string | null = null): AbilityRefusal | null => {
    const actor = abilityActors.get('runtime', actorId);
    const ability = actor?.ability(abilityId);
    if (!actor || !ability) return 'unknown';
    let target = targetId ? findActor(targetId) : null;
    if (!target && !targetId && ability.targetEffects.length > 0 && ability.range > 0) target = aimedTarget(actor, ability.range);
    return actor.activate(abilityId, target);
};

/**
 * Applies an effect to an actor (or a character, through its stand-in). The effect is looked up on
 * `sourceId`'s actor first, then on the target's own. Returns whether it took.
 */
export const applyActorEffect = (targetId: string, effectId: string, sourceId: string | null = null): boolean => {
    const target = findActor(targetId);
    if (!target) return false;
    const source = sourceId ? abilityActors.get('runtime', sourceId) : null;
    return target.applyEffect(effectId, source);
};
