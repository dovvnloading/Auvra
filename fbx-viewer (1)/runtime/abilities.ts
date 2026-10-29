/**
 * ABILITIES
 *
 * A general system for what characters can do and what is done to them, in data:
 *  - Tags: dotted names an actor carries ("State.Stunned", "Element.Fire"). Having "State.Stunned"
 *    also counts as having "State". Effects and abilities grant tags while they last, and check them.
 *  - Attributes: named numbers (health, mana, stamina, armour, speed...). Each has a base value,
 *    changed for good by instant and periodic effects (damage, healing, spending mana), and a current
 *    value, the base with the modifiers of every lasting effect on top (a speed buff, a weakness).
 *    Both stay between a minimum and a maximum, which may be another attribute ("maxHealth"). An
 *    attribute can regenerate, after a pause once it last went down.
 *  - Effects: changes to attributes and tags. Instant ones change base values once; lasting ones
 *    (for some seconds, or until removed) modify current values and grant tags while they last;
 *    periodic ones change base values every so often while they last (burning, regeneration). They
 *    stack, refresh or are refused when applied again, can need or be blocked by tags, and can
 *    remove other effects by their tags (a cleanse).
 *  - Abilities: actions with a cost in attributes, a cooldown, tags that must or must not be present
 *    (no casting while stunned), tags granted while active, and effects applied to the user and to a
 *    target when used.
 * One AbilitySystem holds an actor's attributes, tags, effects and abilities, and steps them with
 * the game clock. Level scripts, gameplay scripts, input and the HUD reach them through actors.
 */

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** A tag: dotted names of letters, digits and underscores, such as "State.Stunned". */
const TAG = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

export const isTag = (value: unknown): value is string => typeof value === 'string' && value.length <= 96 && TAG.test(value);

/** Whether `owned` counts as `query`: the same tag, or one under it ("State.Stunned" is "State"). */
export const tagMatches = (owned: string, query: string): boolean => owned === query || owned.startsWith(`${query}.`);

/** Tags an actor carries, counted, so two effects granting one tag both have to end before it goes. */
export class TagSet {
    private readonly counts = new Map<string, number>();

    add(tag: string, count = 1): void {
        this.counts.set(tag, (this.counts.get(tag) ?? 0) + count);
    }

    remove(tag: string, count = 1): void {
        const left = (this.counts.get(tag) ?? 0) - count;
        if (left > 0) this.counts.set(tag, left);
        else this.counts.delete(tag);
    }

    /** Carries `query` or a tag under it. */
    has(query: string): boolean {
        for (const tag of this.counts.keys()) if (tagMatches(tag, query)) return true;
        return false;
    }

    hasAll(queries: readonly string[]): boolean {
        return queries.every(query => this.has(query));
    }

    hasAny(queries: readonly string[]): boolean {
        return queries.some(query => this.has(query));
    }

    list(): string[] {
        return [...this.counts.keys()].sort();
    }
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export interface AttributeDefinition {
    name: string;
    base: number;
    /** A number, or another attribute's name whose current value is the bound. */
    min: number | string;
    max: number | string;
    /** Units per second the base value climbs back toward its maximum; 0 for none. */
    regen: number;
    /** Seconds after the base value last went down before it regenerates. */
    regenDelay: number;
}

export type ModifierOperation = 'add' | 'multiply' | 'override';
export const MODIFIER_OPERATIONS: readonly ModifierOperation[] = ['add', 'multiply', 'override'];

export interface Modifier {
    attribute: string;
    /** add: plus value; multiply: times (1 + value) (0.5 is +50%); override: set to value. */
    operation: ModifierOperation;
    value: number;
}

export type EffectDuration = 'instant' | 'timed' | 'infinite';
export const EFFECT_DURATIONS: readonly EffectDuration[] = ['instant', 'timed', 'infinite'];

export type EffectStacking = 'refresh' | 'stack' | 'none';
export const EFFECT_STACKINGS: readonly EffectStacking[] = ['refresh', 'stack', 'none'];

export interface EffectDefinition {
    id: string;
    name: string;
    duration: EffectDuration;
    /** Seconds a timed effect lasts. */
    seconds: number;
    /** Seconds between applications of a periodic effect; 0 for a plain lasting one. */
    period: number;
    modifiers: Modifier[];
    /** Tags the target carries while the effect lasts. */
    grantedTags: string[];
    /** The target must carry all of these for the effect to take. */
    requiredTags: string[];
    /** The effect does not take on a target carrying any of these (immunity). */
    blockedTags: string[];
    /** Applying it removes the target's effects that grant any of these (a cleanse). */
    removeEffectsWithTags: string[];
    /** Applied again while it lasts: start its time over, add a stack, or refuse. */
    stacking: EffectStacking;
    maxStacks: number;
}

export interface AbilityCost {
    attribute: string;
    amount: number;
}

export interface AbilityDefinition {
    id: string;
    name: string;
    costs: AbilityCost[];
    /** Seconds before it can be used again. */
    cooldown: number;
    /** Seconds it stays active, granting its active tags; 0 for a moment. */
    activeTime: number;
    /** The user must carry all of these. */
    requiredTags: string[];
    /** It cannot be used while the user carries any of these. */
    blockedTags: string[];
    /** Tags the user carries while it is active ("Ability.Casting"). */
    activeTags: string[];
    /** Using it ends the user's active abilities whose active tags match any of these. */
    cancelTags: string[];
    /** Effects (by id) applied to the user, and to the target. */
    selfEffects: string[];
    targetEffects: string[];
    /** Metres within which a target is taken; 0 for no target. */
    range: number;
    /** An input action that uses it (the player's), or ''. */
    input: string;
}

export interface AbilitySetDefinition {
    attributes: AttributeDefinition[];
    effects: EffectDefinition[];
    abilities: AbilityDefinition[];
    /** Tags the actor starts with. */
    tags: string[];
    /** Effects applied when the actor starts (a passive). */
    startEffects: string[];
}

// ---------------------------------------------------------------------------
// Sanitizing stored definitions
// ---------------------------------------------------------------------------

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const num = (value: unknown, fallback: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, typeof value === 'number' && Number.isFinite(value) ? value : fallback));
const text = (value: unknown, fallback: string, length = 64): string => (typeof value === 'string' ? value.slice(0, length) : fallback);
const choice = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
    typeof value === 'string' && (options as readonly string[]).includes(value) ? value as T : fallback;
const tags = (value: unknown): string[] => (Array.isArray(value) ? [...new Set(value.filter(isTag))].slice(0, 16) : []);
const ids = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64).slice(0, 16) : []);
const bound = (value: unknown, fallback: number): number | string =>
    typeof value === 'string' && NAME.test(value) ? value : num(value, fallback, -1e9, 1e9);

const BIG = 1e9;

export const sanitizeAttribute = (value: unknown): AttributeDefinition | null => {
    const a = record(value);
    if (typeof a.name !== 'string' || !NAME.test(a.name) || a.name.length > 48) return null;
    return {
        name: a.name,
        base: num(a.base, 100, -BIG, BIG),
        min: bound(a.min, 0),
        max: bound(a.max, BIG),
        regen: num(a.regen, 0, -BIG, BIG),
        regenDelay: num(a.regenDelay, 0, 0, 3600),
    };
};

const sanitizeModifier = (value: unknown): Modifier | null => {
    const m = record(value);
    if (typeof m.attribute !== 'string' || !NAME.test(m.attribute)) return null;
    return { attribute: m.attribute, operation: choice(m.operation, MODIFIER_OPERATIONS, 'add'), value: num(m.value, 0, -BIG, BIG) };
};

export const sanitizeEffect = (value: unknown): EffectDefinition | null => {
    const e = record(value);
    if (typeof e.id !== 'string' || !e.id || e.id.length > 64) return null;
    return {
        id: e.id,
        name: text(e.name, e.id),
        duration: choice(e.duration, EFFECT_DURATIONS, 'instant'),
        seconds: num(e.seconds, 5, 0, 3600),
        period: num(e.period, 0, 0, 3600),
        modifiers: (Array.isArray(e.modifiers) ? e.modifiers : []).map(sanitizeModifier).filter((m): m is Modifier => m !== null).slice(0, 16),
        grantedTags: tags(e.grantedTags),
        requiredTags: tags(e.requiredTags),
        blockedTags: tags(e.blockedTags),
        removeEffectsWithTags: tags(e.removeEffectsWithTags),
        stacking: choice(e.stacking, EFFECT_STACKINGS, 'refresh'),
        maxStacks: Math.round(num(e.maxStacks, 1, 1, 99)),
    };
};

export const sanitizeAbility = (value: unknown): AbilityDefinition | null => {
    const a = record(value);
    if (typeof a.id !== 'string' || !a.id || a.id.length > 64) return null;
    return {
        id: a.id,
        name: text(a.name, a.id),
        costs: (Array.isArray(a.costs) ? a.costs : []).map(entry => {
            const c = record(entry);
            return typeof c.attribute === 'string' && NAME.test(c.attribute) ? { attribute: c.attribute, amount: num(c.amount, 0, 0, BIG) } : null;
        }).filter((c): c is AbilityCost => c !== null).slice(0, 4),
        cooldown: num(a.cooldown, 0, 0, 3600),
        activeTime: num(a.activeTime, 0, 0, 3600),
        requiredTags: tags(a.requiredTags),
        blockedTags: tags(a.blockedTags),
        activeTags: tags(a.activeTags),
        cancelTags: tags(a.cancelTags),
        selfEffects: ids(a.selfEffects),
        targetEffects: ids(a.targetEffects),
        range: num(a.range, 0, 0, 1000),
        input: text(a.input, '', 48),
    };
};

/** An ability set from stored data: malformed entries dropped, names unique, every field in range. */
export const sanitizeAbilitySet = (value: unknown): AbilitySetDefinition => {
    const s = record(value);
    const unique = <T>(items: (T | null)[], key: (item: T) => string): T[] => {
        const seen = new Set<string>();
        const kept: T[] = [];
        for (const item of items) {
            if (item === null || seen.has(key(item))) continue;
            seen.add(key(item));
            kept.push(item);
        }
        return kept;
    };
    return {
        attributes: unique((Array.isArray(s.attributes) ? s.attributes : []).map(sanitizeAttribute), a => a.name).slice(0, 32),
        effects: unique((Array.isArray(s.effects) ? s.effects : []).map(sanitizeEffect), e => e.id).slice(0, 64),
        abilities: unique((Array.isArray(s.abilities) ? s.abilities : []).map(sanitizeAbility), a => a.id).slice(0, 32),
        tags: tags(s.tags),
        startEffects: ids(s.startEffects),
    };
};

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface Vec3 { x: number; y: number; z: number }

/** Why an ability could not be used. */
export type AbilityRefusal = 'unknown' | 'cooldown' | 'blocked' | 'missingTags' | 'cost' | 'noTarget';

export type AbilityEvent =
    | { type: 'attribute'; attribute: string; value: number; previous: number }
    | { type: 'effectApplied'; effect: string; stacks: number }
    | { type: 'effectRemoved'; effect: string }
    | { type: 'abilityActivated'; ability: string; target: AbilitySystem | null }
    | { type: 'abilityEnded'; ability: string }
    | { type: 'abilityRefused'; ability: string; reason: AbilityRefusal }
    | { type: 'tags'; tags: string[] };

/**
 * An attribute kept elsewhere (the player's health in its controller): the system reads its base value
 * from `get` and writes changes to it through `set`, instead of holding it.
 */
export interface AttributeBinding {
    get: () => number;
    set: (value: number) => void;
}

interface ActiveEffect {
    serial: number;
    definition: EffectDefinition;
    stacks: number;
    /** Seconds left (timed effects). */
    left: number;
    /** Seconds until the next period. */
    untilTick: number;
    source: AbilitySystem | null;
}

interface AbilityState {
    definition: AbilityDefinition;
    /** Seconds of cooldown left. */
    cooldown: number;
    /** Seconds it stays active; 0 when not active. */
    active: number;
}

interface AttributeState {
    definition: AttributeDefinition;
    base: number;
    current: number;
    /** Seconds since the base value last went down. */
    sinceDrop: number;
    binding: AttributeBinding | null;
}

export class AbilitySystem {
    readonly tags = new TagSet();
    /** Where the actor is (world), for range, aim and blasts; null when it has no place. */
    locate: (() => Vec3 | null) | null = null;
    private readonly attributes = new Map<string, AttributeState>();
    private readonly effectDefinitions = new Map<string, EffectDefinition>();
    private readonly abilities = new Map<string, AbilityState>();
    private readonly active: ActiveEffect[] = [];
    private readonly listeners = new Set<(event: AbilityEvent) => void>();
    private serial = 0;

    constructor(readonly id: string, definition: AbilitySetDefinition = sanitizeAbilitySet({})) {
        for (const attribute of definition.attributes) {
            this.attributes.set(attribute.name, { definition: attribute, base: attribute.base, current: attribute.base, sinceDrop: Infinity, binding: null });
        }
        for (const effect of definition.effects) this.effectDefinitions.set(effect.id, effect);
        for (const ability of definition.abilities) this.abilities.set(ability.id, { definition: ability, cooldown: 0, active: 0 });
        for (const tag of definition.tags) this.tags.add(tag);
        this.recompute();
        for (const effect of definition.startEffects) this.applyEffect(effect);
    }

    // --- Events -------------------------------------------------------------

    /** Listens to what happens to the actor; returns the unsubscribe. */
    on(listener: (event: AbilityEvent) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private emit(event: AbilityEvent): void {
        for (const listener of [...this.listeners]) listener(event);
    }

    // --- Attributes ---------------------------------------------------------

    hasAttribute(name: string): boolean {
        return this.attributes.has(name);
    }

    attributeNames(): string[] {
        return [...this.attributes.keys()];
    }

    /** The current value (base and lasting modifiers), or null for an attribute it does not have. */
    get(name: string): number | null {
        return this.attributes.get(name)?.current ?? null;
    }

    /** The attribute's upper bound now (its maximum, or the attribute bounding it); Infinity for none. */
    upperBound(name: string): number {
        const state = this.attributes.get(name);
        return state ? this.limit(state.definition.max, Infinity) : Infinity;
    }

    getBase(name: string): number | null {
        const state = this.attributes.get(name);
        return state ? this.baseOf(state) : null;
    }

    /** Keeps an attribute's base value elsewhere (see AttributeBinding); null keeps it here again. */
    bind(name: string, binding: AttributeBinding | null): void {
        const state = this.attributes.get(name);
        if (!state) return;
        if (!binding && state.binding) state.base = state.binding.get();
        state.binding = binding;
        this.recompute();
    }

    /** Sets an attribute's base value (clamped), as an instant change would. */
    setBase(name: string, value: number): void {
        const state = this.attributes.get(name);
        if (!state) return;
        this.writeBase(state, value);
        this.recompute();
    }

    /** Adds to an attribute's base value: negative for damage or spending. */
    addBase(name: string, amount: number): void {
        const state = this.attributes.get(name);
        if (!state) return;
        this.writeBase(state, this.baseOf(state) + amount);
        this.recompute();
    }

    private baseOf(state: AttributeState): number {
        return state.binding ? state.binding.get() : state.base;
    }

    private limit(value: number | string, fallback: number): number {
        if (typeof value === 'number') return value;
        return this.attributes.get(value)?.current ?? fallback;
    }

    private clamp(state: AttributeState, value: number): number {
        const min = this.limit(state.definition.min, -Infinity);
        const max = this.limit(state.definition.max, Infinity);
        return Math.min(Math.max(value, min), Math.max(min, max));
    }

    private writeBase(state: AttributeState, value: number): void {
        const before = this.baseOf(state);
        const next = this.clamp(state, value);
        if (next < before) state.sinceDrop = 0;
        if (state.binding) state.binding.set(next);
        else state.base = next;
    }

    /** Current values from base values and lasting effects' modifiers, then the clamps, in order. */
    private recompute(): void {
        // Bounds first, so health is clamped to the max health just worked out.
        const ordered = [...this.attributes.values()].sort((a, b) => Number(typeof a.definition.max === 'string') - Number(typeof b.definition.max === 'string'));
        for (const state of ordered) {
            let add = 0;
            let multiply = 1;
            let override: number | null = null;
            for (const effect of this.active) {
                if (effect.definition.period > 0) continue;
                for (const modifier of effect.definition.modifiers) {
                    if (modifier.attribute !== state.definition.name) continue;
                    if (modifier.operation === 'add') add += modifier.value * effect.stacks;
                    else if (modifier.operation === 'multiply') multiply += modifier.value * effect.stacks;
                    else override = modifier.value;
                }
            }
            const previous = state.current;
            // A base value kept here stays within bounds that may have moved (a max health buff ending).
            if (!state.binding) state.base = this.clamp(state, state.base);
            const value = override ?? (this.baseOf(state) + add) * Math.max(0, multiply);
            state.current = this.clamp(state, value);
            if (state.current !== previous && Number.isFinite(previous)) {
                this.emit({ type: 'attribute', attribute: state.definition.name, value: state.current, previous });
            }
        }
    }

    // --- Effects ------------------------------------------------------------

    hasEffect(id: string): boolean {
        return this.active.some(effect => effect.definition.id === id);
    }

    effectDefinition(id: string): EffectDefinition | null {
        return this.effectDefinitions.get(id) ?? null;
    }

    /** Effects lasting on the actor: id, stacks and seconds left (Infinity for unending ones). */
    activeEffects(): Array<{ id: string; stacks: number; left: number }> {
        return this.active.map(effect => ({
            id: effect.definition.id,
            stacks: effect.stacks,
            left: effect.definition.duration === 'timed' ? effect.left : Infinity,
        }));
    }

    /**
     * Applies an effect by id (looked up on `source` first when given, then here) or definition.
     * Returns whether it took.
     */
    applyEffect(effect: string | EffectDefinition, source: AbilitySystem | null = null): boolean {
        const definition = typeof effect === 'string'
            ? (source?.effectDefinition(effect) ?? this.effectDefinitions.get(effect) ?? null)
            : effect;
        if (!definition) return false;
        if (!this.tags.hasAll(definition.requiredTags) || this.tags.hasAny(definition.blockedTags)) return false;
        if (definition.removeEffectsWithTags.length) this.removeEffectsWithTags(definition.removeEffectsWithTags);
        if (definition.duration === 'instant') {
            this.applyToBase(definition.modifiers, 1);
            this.emit({ type: 'effectApplied', effect: definition.id, stacks: 1 });
            return true;
        }
        const existing = this.active.find(entry => entry.definition.id === definition.id);
        if (existing) {
            if (definition.stacking === 'none') return false;
            if (definition.stacking === 'stack' && existing.stacks < definition.maxStacks) {
                existing.stacks++;
                for (const tag of definition.grantedTags) this.tags.add(tag);
            }
            existing.left = definition.seconds;
            this.recompute();
            this.emit({ type: 'effectApplied', effect: definition.id, stacks: existing.stacks });
            this.emitTags(definition.grantedTags.length > 0);
            return true;
        }
        this.active.push({ serial: ++this.serial, definition, stacks: 1, left: definition.seconds, untilTick: definition.period, source });
        for (const tag of definition.grantedTags) this.tags.add(tag);
        this.recompute();
        this.emit({ type: 'effectApplied', effect: definition.id, stacks: 1 });
        this.emitTags(definition.grantedTags.length > 0);
        return true;
    }

    /** Removes a lasting effect by id, every stack; returns whether it was there. */
    removeEffect(id: string): boolean {
        const index = this.active.findIndex(effect => effect.definition.id === id);
        if (index < 0) return false;
        this.removeAt(index);
        this.recompute();
        return true;
    }

    /** Removes the lasting effects that grant any of `queries`. */
    removeEffectsWithTags(queries: readonly string[]): number {
        let removed = 0;
        for (let i = this.active.length - 1; i >= 0; i--) {
            if (this.active[i].definition.grantedTags.some(tag => queries.some(query => tagMatches(tag, query)))) {
                this.removeAt(i);
                removed++;
            }
        }
        if (removed) this.recompute();
        return removed;
    }

    private removeAt(index: number): void {
        const [effect] = this.active.splice(index, 1);
        for (const tag of effect.definition.grantedTags) this.tags.remove(tag, effect.stacks);
        this.emit({ type: 'effectRemoved', effect: effect.definition.id });
        this.emitTags(effect.definition.grantedTags.length > 0);
    }

    private applyToBase(modifiers: readonly Modifier[], stacks: number): void {
        for (const modifier of modifiers) {
            const state = this.attributes.get(modifier.attribute);
            if (!state) continue;
            const base = this.baseOf(state);
            const next = modifier.operation === 'add' ? base + modifier.value * stacks
                : modifier.operation === 'multiply' ? base * (1 + modifier.value * stacks)
                    : modifier.value;
            this.writeBase(state, next);
        }
        this.recompute();
    }

    private emitTags(changed: boolean): void {
        if (changed) this.emit({ type: 'tags', tags: this.tags.list() });
    }

    // --- Tags ---------------------------------------------------------------

    addTag(tag: string): void {
        if (!isTag(tag)) return;
        this.tags.add(tag);
        this.emitTags(true);
    }

    removeTag(tag: string): void {
        this.tags.remove(tag);
        this.emitTags(true);
    }

    // --- Abilities ----------------------------------------------------------

    abilityIds(): string[] {
        return [...this.abilities.keys()];
    }

    ability(id: string): AbilityDefinition | null {
        return this.abilities.get(id)?.definition ?? null;
    }

    /** Seconds of cooldown left (0 when ready). */
    cooldown(id: string): number {
        return this.abilities.get(id)?.cooldown ?? 0;
    }

    isActive(id: string): boolean {
        return (this.abilities.get(id)?.active ?? 0) > 0;
    }

    /** Why the ability cannot be used now, or null when it can. */
    refusal(id: string, target: AbilitySystem | null = null): AbilityRefusal | null {
        const state = this.abilities.get(id);
        if (!state) return 'unknown';
        const ability = state.definition;
        if (state.cooldown > 0) return 'cooldown';
        if (this.tags.hasAny(ability.blockedTags)) return 'blocked';
        if (!this.tags.hasAll(ability.requiredTags)) return 'missingTags';
        for (const cost of ability.costs) {
            const value = this.getBase(cost.attribute);
            if (value === null || value < cost.amount) return 'cost';
        }
        if (ability.targetEffects.length && ability.range > 0 && !target) return 'noTarget';
        return null;
    }

    /**
     * Uses an ability on `target` (another actor, or null): pays its costs, starts its cooldown, ends
     * abilities it cancels, grants its active tags and applies its effects. Returns why it could not,
     * or null when it was used.
     */
    activate(id: string, target: AbilitySystem | null = null): AbilityRefusal | null {
        const reason = this.refusal(id, target);
        if (reason) {
            this.emit({ type: 'abilityRefused', ability: id, reason });
            return reason;
        }
        const state = this.abilities.get(id)!;
        const ability = state.definition;
        for (const cost of ability.costs) this.addBase(cost.attribute, -cost.amount);
        state.cooldown = ability.cooldown;
        if (ability.cancelTags.length) {
            for (const other of this.abilities.values()) {
                if (other !== state && other.active > 0 && other.definition.activeTags.some(tag => ability.cancelTags.some(query => tagMatches(tag, query)))) {
                    this.end(other);
                }
            }
        }
        if (ability.activeTime > 0) {
            if (state.active <= 0) for (const tag of ability.activeTags) this.tags.add(tag);
            state.active = ability.activeTime;
            this.emitTags(ability.activeTags.length > 0);
        }
        this.emit({ type: 'abilityActivated', ability: id, target });
        for (const effect of ability.selfEffects) this.applyEffect(effect, this);
        if (target) for (const effect of ability.targetEffects) target.applyEffect(effect, this);
        if (ability.activeTime <= 0) this.emit({ type: 'abilityEnded', ability: id });
        return null;
    }

    /** Ends an active ability early. */
    cancel(id: string): void {
        const state = this.abilities.get(id);
        if (state && state.active > 0) this.end(state);
    }

    private end(state: AbilityState): void {
        state.active = 0;
        for (const tag of state.definition.activeTags) this.tags.remove(tag);
        this.emitTags(state.definition.activeTags.length > 0);
        this.emit({ type: 'abilityEnded', ability: state.definition.id });
    }

    // --- Time ---------------------------------------------------------------

    /** Advances cooldowns, active abilities, effects (their time and periods) and regeneration. */
    step(dt: number): void {
        if (!(dt > 0)) return;
        for (const state of this.abilities.values()) {
            if (state.cooldown > 0) state.cooldown = Math.max(0, state.cooldown - dt);
            if (state.active > 0) {
                state.active -= dt;
                if (state.active <= 0) this.end(state);
            }
        }
        for (let i = this.active.length - 1; i >= 0; i--) {
            const effect = this.active[i];
            const definition = effect.definition;
            const elapsed = definition.duration === 'timed' ? Math.min(dt, effect.left) : dt;
            if (definition.period > 0) {
                effect.untilTick -= elapsed;
                while (effect.untilTick <= 1e-9) {
                    this.applyToBase(definition.modifiers, effect.stacks);
                    effect.untilTick += definition.period;
                }
            }
            if (definition.duration === 'timed') {
                effect.left -= dt;
                if (effect.left <= 1e-9) this.removeAt(i);
            }
        }
        for (const state of this.attributes.values()) {
            state.sinceDrop += dt;
            const regen = state.definition.regen;
            // Only the part of the step after the pause counts.
            const time = Math.min(dt, state.sinceDrop - state.definition.regenDelay);
            if (regen === 0 || time <= 0) continue;
            const base = this.baseOf(state);
            const next = this.clamp(state, base + regen * time);
            if (next === base) continue;
            const since = state.sinceDrop;
            this.writeBase(state, next);
            // Regenerating downward (a draining attribute) is not a drop that pauses it.
            state.sinceDrop = since;
        }
        this.recompute();
    }
}

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

/** The player's actor id. */
export const PLAYER_ACTOR = 'player';

/** Every actor with abilities in a scope (the editor's preview or the play session), by object id. */
const scopes = new Map<string, Map<string, AbilitySystem>>();
const actorListeners = new Set<() => void>();

const distanceTo = (actor: AbilitySystem, point: Vec3): number => {
    const at = actor.locate?.();
    return at ? Math.hypot(at.x - point.x, at.y - point.y, at.z - point.z) : Infinity;
};

export const abilityActors = {
    register(scope: string, system: AbilitySystem): () => void {
        let actors = scopes.get(scope);
        if (!actors) {
            actors = new Map();
            scopes.set(scope, actors);
        }
        const held = actors;
        held.set(system.id, system);
        for (const listener of [...actorListeners]) listener();
        return () => {
            if (held.get(system.id) === system) held.delete(system.id);
            for (const listener of [...actorListeners]) listener();
        };
    },
    get(scope: string, id: string): AbilitySystem | null {
        return scopes.get(scope)?.get(id) ?? null;
    },
    all(scope: string): AbilitySystem[] {
        return [...(scopes.get(scope)?.values() ?? [])];
    },
    /** Actors whose place is within `radius` of `centre`, with their distance. */
    within(scope: string, centre: Vec3, radius: number): Array<{ actor: AbilitySystem; distance: number }> {
        const found: Array<{ actor: AbilitySystem; distance: number }> = [];
        for (const actor of scopes.get(scope)?.values() ?? []) {
            const distance = distanceTo(actor, centre);
            if (distance <= radius) found.push({ actor, distance });
        }
        return found;
    },
    /** Calls `listener` when an actor comes or goes; returns the unsubscribe. */
    subscribe(listener: () => void): () => void {
        actorListeners.add(listener);
        return () => { actorListeners.delete(listener); };
    },
};

/** Damage is turned away entirely while an actor carries this tag. */
export const INVULNERABLE_TAG = 'State.Invulnerable';
/** Carried once an actor's health reaches 0. */
export const DEAD_TAG = 'State.Dead';

/**
 * Hurts an actor's health by `amount` less its armour (see damageAfterArmor). False when it has no
 * health, is invulnerable or already dead.
 */
export const damageActor = (actor: AbilitySystem, amount: number): boolean => {
    if (!(amount > 0) || !actor.hasAttribute('health') || actor.tags.has(INVULNERABLE_TAG) || actor.tags.has(DEAD_TAG)) return false;
    actor.addBase('health', -damageAfterArmor(amount, actor.get('armor') ?? 0));
    return true;
};

// --- What happens, for level scripts and gameplay scripts ---------------------

export type AbilityBusEvent =
    | { type: 'activated'; actor: string; ability: string; target: string | null }
    | { type: 'died'; actor: string };

const busListeners = new Set<(event: AbilityBusEvent) => void>();

export const abilityBus = {
    emit(event: AbilityBusEvent): void {
        for (const listener of [...busListeners]) listener(event);
    },
    on(listener: (event: AbilityBusEvent) => void): () => void {
        busListeners.add(listener);
        return () => { busListeners.delete(listener); };
    },
};

// --- Characters without an Abilities component ------------------------------

/** A character an ability can reach without being an actor: an enemy, or the player before it has abilities. */
export interface AbilityCharacter {
    id: string;
    team: 'Player' | 'Enemy';
    centre(): Vec3;
    isDead(): boolean;
    damage(amount: number): void;
    heal?(amount: number): void;
}

/** Health a stand-in starts from: only its changes are passed on, as damage and healing. */
const STAND_IN_HEALTH = 1e6;
const standIns = new Map<string, { actor: AbilitySystem; character: AbilityCharacter }>();

/**
 * An actor standing in for a character without an Abilities component, so an ability's effects can
 * land on it: changes to its health are passed to the character as damage or healing, tags and
 * lasting effects are kept here while they last. Made on first use; stepped by stepStandIns.
 */
export const standInFor = (character: AbilityCharacter): AbilitySystem => {
    const held = standIns.get(character.id);
    if (held) {
        held.character = character;
        return held.actor;
    }
    const actor = new AbilitySystem(character.id, sanitizeAbilitySet({
        attributes: [{ name: 'health', base: STAND_IN_HEALTH, min: -BIG, max: BIG }],
    }));
    // The entry outlives its place in the map, so an effect landing after it was let go still reaches the character.
    const entry = { actor, character };
    let health = STAND_IN_HEALTH;
    actor.bind('health', {
        get: () => health,
        set: value => {
            const change = value - health;
            health = value;
            if (entry.character.isDead()) return;
            if (change < 0) entry.character.damage(-change);
            else if (change > 0) entry.character.heal?.(change);
        },
    });
    actor.locate = () => entry.character.centre();
    standIns.set(character.id, entry);
    return actor;
};

/** Steps the stand-ins and lets go of those with nothing lasting on them, or whose character died. */
export const stepStandIns = (dt: number): void => {
    for (const [id, entry] of standIns) {
        entry.actor.step(dt);
        if (entry.character.isDead() || entry.actor.activeEffects().length === 0) standIns.delete(id);
    }
};

export const clearStandIns = (): void => {
    standIns.clear();
};

/**
 * What a user aims an ability at: of the actors and characters within `range` of `from`, the one
 * nearest the middle of the view along `forward` (within `cone` radians of it), the nearer one when
 * two are as well aimed at. Never the user itself, nor a character of `ownTeam`.
 */
export const pickAbilityTarget = (options: {
    user: AbilitySystem;
    from: Vec3;
    eye: Vec3;
    forward: Vec3;
    range: number;
    actors: readonly AbilitySystem[];
    characters: readonly AbilityCharacter[];
    ownTeam: 'Player' | 'Enemy' | null;
    cone?: number;
}): AbilitySystem | null => {
    const { user, from, eye, forward, range, ownTeam } = options;
    const cosCone = Math.cos(options.cone ?? 0.35);
    let best: { score: number; distance: number; take: () => AbilitySystem } | null = null;
    const consider = (at: Vec3, take: () => AbilitySystem) => {
        const distance = Math.hypot(at.x - from.x, at.y - from.y, at.z - from.z);
        if (distance > range) return;
        const dx = at.x - eye.x, dy = at.y - eye.y, dz = at.z - eye.z;
        const length = Math.hypot(dx, dy, dz) || 1;
        const score = (dx * forward.x + dy * forward.y + dz * forward.z) / length;
        if (score < cosCone) return;
        if (!best || score > best.score + 0.02 || (Math.abs(score - best.score) <= 0.02 && distance < best.distance)) best = { score, distance, take };
    };
    for (const actor of options.actors) {
        if (actor === user || actor.tags.has(DEAD_TAG)) continue;
        const at = actor.locate?.();
        if (at) consider(at, () => actor);
    }
    for (const character of options.characters) {
        if (character.isDead() || (ownTeam && character.team === ownTeam)) continue;
        if (options.actors.some(actor => actor.id === character.id)) continue;
        consider(character.centre(), () => standInFor(character));
    }
    return best ? (best as { take: () => AbilitySystem }).take() : null;
};

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const health = (max: number) => [
    { name: 'maxHealth', base: max, min: 1, max: 100000, regen: 0, regenDelay: 0 },
    { name: 'health', base: max, min: 0, max: 'maxHealth', regen: 0, regenDelay: 0 },
];

/** Ability sets to start from. */
export const ABILITY_PRESETS = {
    fighter: sanitizeAbilitySet({
        attributes: [
            ...health(150),
            { name: 'stamina', base: 100, min: 0, max: 100, regen: 25, regenDelay: 1 },
            { name: 'armor', base: 20, min: 0, max: 1000 },
            { name: 'speed', base: 1, min: 0, max: 5 },
        ],
        effects: [
            { id: 'slam', name: 'Slam hit', duration: 'instant', modifiers: [{ attribute: 'health', operation: 'add', value: -35 }] },
            { id: 'stagger', name: 'Staggered', duration: 'timed', seconds: 1.5, grantedTags: ['State.Stunned'], stacking: 'refresh', blockedTags: ['State.Unstoppable'] },
            { id: 'sprint', name: 'Sprinting', duration: 'timed', seconds: 4, modifiers: [{ attribute: 'speed', operation: 'multiply', value: 0.5 }], grantedTags: ['State.Hasted'] },
            { id: 'secondWind', name: 'Second wind', duration: 'timed', seconds: 5, period: 1, modifiers: [{ attribute: 'health', operation: 'add', value: 8 }], grantedTags: ['State.Healing'] },
        ],
        abilities: [
            { id: 'groundSlam', name: 'Ground slam', costs: [{ attribute: 'stamina', amount: 40 }], cooldown: 4, blockedTags: ['State.Stunned'], targetEffects: ['slam', 'stagger'], range: 4, input: 'Ability1' },
            { id: 'sprint', name: 'Sprint', costs: [{ attribute: 'stamina', amount: 30 }], cooldown: 8, blockedTags: ['State.Stunned'], selfEffects: ['sprint'], input: 'Ability2' },
            { id: 'secondWind', name: 'Second wind', cooldown: 20, selfEffects: ['secondWind'], input: 'Ability3' },
        ],
        tags: ['Class.Fighter'],
    }),
    mage: sanitizeAbilitySet({
        attributes: [
            ...health(90),
            { name: 'mana', base: 100, min: 0, max: 100, regen: 8, regenDelay: 2 },
            { name: 'armor', base: 5, min: 0, max: 1000 },
            { name: 'speed', base: 1, min: 0, max: 5 },
        ],
        effects: [
            { id: 'fireballHit', name: 'Fireball hit', duration: 'instant', modifiers: [{ attribute: 'health', operation: 'add', value: -25 }] },
            { id: 'burning', name: 'Burning', duration: 'timed', seconds: 4, period: 1, modifiers: [{ attribute: 'health', operation: 'add', value: -4 }], grantedTags: ['State.Burning'], stacking: 'stack', maxStacks: 3, blockedTags: ['State.Wet'] },
            { id: 'frostHit', name: 'Frost hit', duration: 'timed', seconds: 3, modifiers: [{ attribute: 'speed', operation: 'multiply', value: -0.5 }], grantedTags: ['State.Chilled'], removeEffectsWithTags: ['State.Burning'] },
            { id: 'heal', name: 'Heal', duration: 'instant', modifiers: [{ attribute: 'health', operation: 'add', value: 30 }] },
            { id: 'cleanse', name: 'Cleanse', duration: 'instant', removeEffectsWithTags: ['State.Burning', 'State.Chilled', 'State.Stunned'] },
        ],
        abilities: [
            { id: 'fireball', name: 'Fireball', costs: [{ attribute: 'mana', amount: 20 }], cooldown: 1.5, blockedTags: ['State.Stunned', 'Ability.Casting'], targetEffects: ['fireballHit', 'burning'], range: 40, input: 'Ability1' },
            { id: 'frostBolt', name: 'Frost bolt', costs: [{ attribute: 'mana', amount: 15 }], cooldown: 3, blockedTags: ['State.Stunned'], targetEffects: ['frostHit'], range: 40, input: 'Ability2' },
            { id: 'heal', name: 'Heal', costs: [{ attribute: 'mana', amount: 35 }], cooldown: 6, activeTime: 1, activeTags: ['Ability.Casting'], blockedTags: ['State.Stunned'], selfEffects: ['heal', 'cleanse'], input: 'Ability3' },
        ],
        tags: ['Class.Mage'],
    }),
    target: sanitizeAbilitySet({
        attributes: [...health(500), { name: 'armor', base: 0, min: 0, max: 1000 }, { name: 'speed', base: 1, min: 0, max: 5 }],
        effects: [{ id: 'mend', name: 'Mending', duration: 'infinite', period: 2, modifiers: [{ attribute: 'health', operation: 'add', value: 25 }] }],
        abilities: [],
        tags: ['Role.Target'],
        startEffects: ['mend'],
    }),
} satisfies Record<string, AbilitySetDefinition>;

export type AbilityPresetId = keyof typeof ABILITY_PRESETS;
export const ABILITY_PRESET_IDS = Object.keys(ABILITY_PRESETS) as AbilityPresetId[];
export const ABILITY_PRESET_LABELS: Record<AbilityPresetId, string> = { fighter: 'Fighter', mage: 'Mage', target: 'Training target' };

/** A component's ability set: its own, or its preset's, or the fighter's. */
export const resolveAbilitySet = (props: Record<string, unknown>): AbilitySetDefinition => {
    if (props.abilities && typeof props.abilities === 'object') return sanitizeAbilitySet(props.abilities);
    const preset = typeof props.preset === 'string' && (ABILITY_PRESET_IDS as string[]).includes(props.preset) ? props.preset as AbilityPresetId : 'fighter';
    return ABILITY_PRESETS[preset];
};

/**
 * Damage after armour: each point of armour turns away a little more, never all of it
 * (100 armour halves damage, 300 quarters it).
 */
export const damageAfterArmor = (damage: number, armor: number): number => damage * (100 / (100 + Math.max(0, armor)));
