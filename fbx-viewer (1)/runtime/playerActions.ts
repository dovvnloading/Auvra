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

let handlers: Partial<PlayerActionHandlers> = {};

const positive = (value: number): number => (Number.isFinite(value) ? Math.max(0, value) : 0);

export const playerActions = {
    /** Registers some of the handlers; the returned function removes exactly those again. */
    register(part: Partial<PlayerActionHandlers>): () => void {
        handlers = { ...handlers, ...part };
        return () => {
            const next = { ...handlers };
            for (const key of Object.keys(part) as (keyof PlayerActionHandlers)[]) {
                if (next[key] === part[key]) delete next[key];
            }
            handlers = next;
        };
    },
    damage(amount: number): boolean {
        const value = positive(amount);
        return value > 0 && handlers.damage?.(value) === true;
    },
    heal(amount: number): boolean {
        const value = positive(amount);
        return value > 0 && handlers.heal?.(value) === true;
    },
    addAmmo(rounds: number, weapon?: string | null): boolean {
        const value = Math.round(positive(rounds));
        return value > 0 && handlers.addAmmo?.(value, weapon ?? null) === true;
    },
    giveWeapon(weapon: string): boolean {
        return typeof weapon === 'string' && weapon.trim() !== '' && handlers.giveWeapon?.(weapon.trim()) === true;
    },
};
