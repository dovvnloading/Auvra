import React, { useId } from 'react';
import { MousePointerClick } from 'lucide-react';
import { parseMenuAction, type MenuActionKind } from '../../player/menus';

const OPEN_LEVEL_PREFIX = 'openLevel:';

/** Every action a menu element can run, in the order the dropdown lists them. */
export const HUD_ACTION_OPTIONS: readonly { value: MenuActionKind; label: string }[] = [
    { value: 'play', label: 'Play' },
    { value: 'continue', label: 'Continue' },
    { value: 'options', label: 'Options' },
    { value: 'quit', label: 'Quit' },
    { value: 'resume', label: 'Resume' },
    { value: 'save', label: 'Save' },
    { value: 'load', label: 'Load' },
    { value: 'openLevel', label: 'Open level...' },
];

export const describeMenuAction = (kind: MenuActionKind): string =>
    HUD_ACTION_OPTIONS.find(option => option.value === kind)?.label.replace(/\.+$/, '') ?? kind;

const NONE = '';
const UNKNOWN = '__unknown__';

const FIELD_CLASS = 'w-full bg-gray-800 border border-gray-700 rounded p-1.5 text-xs text-white focus:outline-none focus:border-blue-500';

interface HUDActionFieldProps {
    /** The element's raw `props.action`. */
    value: unknown;
    levels: readonly { id: string; name: string }[];
    /** The new `props.action`, or null to remove it. */
    onChange: (action: string | null) => void;
}

/** Picks the menu action an element runs when the player clicks it. */
export const HUDActionField: React.FC<HUDActionFieldProps> = ({ value, levels, onChange }) => {
    const id = useId();
    const raw = typeof value === 'string' ? value.trim() : '';
    const parsed = parseMenuAction(raw);
    // 'openLevel:' with no level yet is still the open-level choice, waiting for a pick.
    const isOpenLevel = parsed?.kind === 'openLevel' || raw.startsWith(OPEN_LEVEL_PREFIX);
    const levelId = parsed?.kind === 'openLevel' ? parsed.levelId : '';
    const mode = isOpenLevel ? 'openLevel' : parsed ? parsed.kind : raw ? UNKNOWN : NONE;
    const levelMissing = levelId !== '' && !levels.some(level => level.id === levelId);

    const handleModeChange = (next: string) => {
        if (next === mode) return;
        if (next === NONE) onChange(null);
        else if (next === 'openLevel') onChange(`${OPEN_LEVEL_PREFIX}${levels[0]?.id ?? ''}`);
        else if (next !== UNKNOWN) onChange(next);
    };

    return (
        <div className="space-y-2">
            <div className="space-y-1">
                <label htmlFor={`${id}-action`} className="text-[10px] text-gray-500 font-bold uppercase flex items-center gap-1">
                    <MousePointerClick size={10} /> Action
                </label>
                <select id={`${id}-action`} value={mode} onChange={(event) => handleModeChange(event.target.value)} className={FIELD_CLASS}>
                    <option value={NONE}>None</option>
                    {mode === UNKNOWN && <option value={UNKNOWN} disabled>Unknown ({raw})</option>}
                    {HUD_ACTION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
            </div>
            {isOpenLevel && (
                <div className="space-y-1">
                    <label htmlFor={`${id}-level`} className="text-[10px] text-gray-500 font-bold uppercase">Level</label>
                    <select
                        id={`${id}-level`}
                        value={levelId}
                        onChange={(event) => onChange(`${OPEN_LEVEL_PREFIX}${event.target.value}`)}
                        className={FIELD_CLASS}
                    >
                        <option value="" disabled>{levels.length ? '-- Select Level --' : 'No levels in this project'}</option>
                        {levelMissing && <option value={levelId} disabled>Missing level ({levelId})</option>}
                        {levels.map(level => <option key={level.id} value={level.id}>{level.name || level.id}</option>)}
                    </select>
                </div>
            )}
            <p className="text-[10px] text-gray-500 leading-snug">Runs when the player clicks this element on a menu screen.</p>
        </div>
    );
};
