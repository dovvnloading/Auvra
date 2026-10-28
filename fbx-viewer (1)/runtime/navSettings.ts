/** The agent a level's navmesh is baked for (Game Settings > Navigation). */
export interface NavSettings {
    /** Agents keep this far from walls and ledges (m). */
    agentRadius: number;
    /** Agents walk under anything at least this high (m). */
    agentHeight: number;
    /** Steepest walkable ground (degrees). */
    maxSlopeDegrees: number;
    /** Tallest step agents climb (m). */
    maxStepHeight: number;
}

export const DEFAULT_NAV_SETTINGS: NavSettings = { agentRadius: 0.4, agentHeight: 1.8, maxSlopeDegrees: 40, maxStepHeight: 0.35 };

/** The editable range of each setting. */
export const NAV_SETTING_LIMITS = {
    agentRadius: { min: 0.1, max: 3, step: 0.05 },
    agentHeight: { min: 0.5, max: 6, step: 0.1 },
    maxSlopeDegrees: { min: 5, max: 70, step: 1 },
    maxStepHeight: { min: 0, max: 1.5, step: 0.05 },
} as const;

/** Settings with every value present and in range. */
export const resolveNavSettings = (settings: Partial<NavSettings> | null | undefined): NavSettings => {
    const pick = (key: keyof NavSettings) => {
        const value = settings?.[key];
        const { min, max } = NAV_SETTING_LIMITS[key];
        return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : DEFAULT_NAV_SETTINGS[key];
    };
    return {
        agentRadius: pick('agentRadius'),
        agentHeight: pick('agentHeight'),
        maxSlopeDegrees: pick('maxSlopeDegrees'),
        maxStepHeight: pick('maxStepHeight'),
    };
};
