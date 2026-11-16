/**
 * PLAYER ACTIONS
 *
 * What gameplay may do to the player during a play session: hurt and heal them, give rounds and
 * weapons. Pickups, Level Blueprint nodes and scripts all go through here. The play session
 * registers the handlers (health from the player's entity, weapons from the player controller)
 * and removes them when it ends; with nothing registered every action does nothing and reports
 * false.
 */

export interface PlayerActionHandlers {
    /** Hurts the player; false when there is no live player. */
    damage(amount: number): boolean;
    /** Restores health up to the maximum; false when already full, dead or absent. */
    heal(amount: number): boolean;
    /** Adds rounds to a carried weapon's reserve (blank: the held one); false when it takes none. */
    addAmmo(rounds: number, weapon?: string | null): boolean;
    /** Gives a weapon by name or id (or a magazine for one already carried); false when nothing changed. */
    giveWeapon(weapon: string): boolean;
}

type PlayerAction = keyof PlayerActionHandlers;
type HandlerEntry<K extends PlayerAction> = { owner: symbol; handler: PlayerActionHandlers[K] };

// Each action has its own priority order, so removing a newer provider restores any older one
// that is still mounted. Owner tokens also distinguish registrations of the same function.
const handlerStacks: { [K in PlayerAction]: HandlerEntry<K>[] } = {
    damage: [],
    heal: [],
    addAmmo: [],
    giveWeapon: [],
};
const actionNames: PlayerAction[] = ['damage', 'heal', 'addAmmo', 'giveWeapon'];

const activeHandler = <K extends PlayerAction>(action: K): PlayerActionHandlers[K] | undefined => {
    const stack = handlerStacks[action];
    return stack[stack.length - 1]?.handler;
};

const registerHandler = <K extends PlayerAction>(action: K, owner: symbol, handler: PlayerActionHandlers[K]): void => {
    handlerStacks[action].push({ owner, handler });
};

const unregisterHandler = <K extends PlayerAction>(action: K, owner: symbol): void => {
    const stack = handlerStacks[action];
    const index = stack.findIndex(entry => entry.owner === owner);
    if (index !== -1) stack.splice(index, 1);
};

const positive = (value: number): number => (Number.isFinite(value) ? Math.max(0, value) : 0);

export const playerActions = {
    /** Registers some of the handlers; cleanup removes only this registration (and is safe to repeat). */
    register(part: Partial<PlayerActionHandlers>): () => void {
        const owner = Symbol('player action registration');
        const registered: PlayerAction[] = [];
        for (const action of actionNames) {
            const handler = part[action];
            if (typeof handler !== 'function') continue;
            registerHandler(action, owner, handler);
            registered.push(action);
        }
        return () => {
            for (const action of registered) unregisterHandler(action, owner);
            registered.length = 0;
        };
    },
    damage(amount: number): boolean {
        const value = positive(amount);
        return value > 0 && activeHandler('damage')?.(value) === true;
    },
    heal(amount: number): boolean {
        const value = positive(amount);
        return value > 0 && activeHandler('heal')?.(value) === true;
    },
    addAmmo(rounds: number, weapon?: string | null): boolean {
        const value = Math.round(positive(rounds));
        return value > 0 && activeHandler('addAmmo')?.(value, weapon ?? null) === true;
    },
    giveWeapon(weapon: string): boolean {
        return typeof weapon === 'string' && weapon.trim() !== '' && activeHandler('giveWeapon')?.(weapon.trim()) === true;
    },
};
