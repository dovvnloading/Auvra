import React, { useState } from 'react';
import { Crosshair, Plus, Trash2 } from 'lucide-react';
import type { AttachmentData, SocketData, WeaponCarry, WeaponSettings } from '../../types';
import { DEFAULT_WEAPON } from '../../runtime/weapons';
import { TransformInputGroup } from '../UI/Properties/TransformInputGroup';

interface WeaponsPanelProps {
    weapons: WeaponSettings[];
    /** The linked model's attachments and sockets, to pick each weapon's model and muzzle from. */
    attachments: AttachmentData[];
    sockets: SocketData[];
    /** The linked model's bones, to carry a weapon on while it is not in use. */
    boneNames: string[];
    clipNames: string[];
    /** `coalesce` groups typing in one field into one undo step. */
    onChange: (weapons: WeaponSettings[], coalesce?: string) => void;
    /** The weapon being fitted, shown in the preview with its points, and the point being picked on it. */
    focus?: WeaponFocus | null;
    onFocus?: (focus: WeaponFocus | null) => void;
    /** Fits a weapon to the character's hands from its points; returns what happened, for the user. */
    onFit?: (weapon: WeaponSettings) => string;
    /** Seats a weapon's carry placement against the body; returns what happened, for the user. */
    onSeat?: (weapon: WeaponSettings) => string;
}

/** Points on a weapon model that fit it to the hands. */
export type WeaponPointField = 'gripPoint' | 'supportGrip' | 'muzzlePoint';

/** The weapon being fitted in the preview, and the point being picked on it (null: none). */
export interface WeaponFocus {
    weaponId: string;
    field: WeaponPointField | null;
}

/** Each fitting point: its field, its label, its marker colour in the preview and what it is. */
export const WEAPON_POINTS: readonly [WeaponPointField, string, string, string][] = [
    ['gripPoint', 'Grip', '#22c55e', 'The middle of the grip the hand holding the weapon closes round'],
    ['supportGrip', 'Other hand', '#3b82f6', "Where the other hand holds it, such as a rifle's handguard: the barrel runs from the grip through it"],
    ['muzzlePoint', 'Muzzle', '#ef4444', 'The end of the barrel: a one-handed weapon is fitted pointing it ahead'],
];

type NumberField = 'fireRate' | 'damage' | 'magazine' | 'reserve' | 'reloadSeconds' | 'spread' | 'pellets' | 'projectileSpeed';

const NUMBER_FIELDS: readonly { key: NumberField; label: string; step: number; min: number; title: string }[] = [
    { key: 'fireRate', label: 'Rate', step: 0.5, min: 0.1, title: 'Fire rate, in shots per second' },
    { key: 'damage', label: 'Damage', step: 1, min: 0, title: 'Damage per projectile' },
    { key: 'magazine', label: 'Mag', step: 1, min: 0, title: 'Rounds per magazine; 0 never reloads' },
    { key: 'reserve', label: 'Reserve', step: 1, min: -1, title: 'Rounds carried besides the magazine; -1 is unlimited' },
    { key: 'reloadSeconds', label: 'Reload', step: 0.1, min: 0, title: 'Reload time, in seconds' },
    { key: 'spread', label: 'Spread', step: 0.5, min: 0, title: 'Spread: the largest angle, in degrees, a shot strays from the aim; a quarter of it while aiming' },
    { key: 'pellets', label: 'Pellets', step: 1, min: 1, title: 'Projectiles per shot, as from a shotgun' },
    { key: 'projectileSpeed', label: 'Speed', step: 5, min: 1, title: 'Projectile speed, in world units per second' },
];

const CLIP_FIELDS = [
    ['fireClip', 'Fire clip'], ['aimClip', 'Aim clip'], ['reloadClip', 'Reload clip'],
    // How the character moves while holding it: these stand in for the graph's own locomotion.
    ['idleClip', 'Idle while held'], ['walkClip', 'Walk while held'], ['runClip', 'Run while held'],
    ['backClip', 'Walk back while held'], ['leftClip', 'Step left while held'], ['rightClip', 'Step right while held'],
    ['jumpClip', 'Jump while held'],
    // Played on the legs when the aim swings too far round: the character turns as the clip turns.
    ['turnLeftClip', 'Turn left while aiming'], ['turnRightClip', 'Turn right while aiming'],
] as const;

const UPPER_BODY_CLIPS: ReadonlySet<string> = new Set(['fireClip', 'aimClip']);

const selectClass = 'w-36 bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-500';

/** A player blueprint's weapons: what each fires, its ammunition, the model it shows and its clips. */
export const WeaponsPanel: React.FC<WeaponsPanelProps> = ({ weapons, attachments, sockets, boneNames, clipNames, onChange, focus = null, onFocus, onFit, onSeat }) => {
    const [seatStatus, setSeatStatus] = useState<Record<string, string>>({});
    const [fitStatus, setFitStatus] = useState<Record<string, string>>({});
    const update = (id: string, changes: Partial<WeaponSettings>, coalesce?: string) =>
        onChange(weapons.map(weapon => (weapon.id === id ? { ...weapon, ...changes } : weapon)), coalesce);
    const updateCarry = (weapon: WeaponSettings, changes: Partial<WeaponCarry>, coalesce?: string) => {
        if (!weapon.carry) return;
        update(weapon.id, { carry: { ...weapon.carry, ...changes } }, coalesce);
    };

    const addWeapon = () => {
        // A new weapon shows the first attachment no other weapon uses.
        const used = new Set(weapons.map(weapon => weapon.attachmentId));
        const attachment = attachments.find(candidate => !used.has(candidate.id));
        onChange([...weapons, {
            id: crypto.randomUUID(),
            name: attachment?.name.replace(/\.[^.]+$/, '') || `Weapon ${weapons.length + 1}`,
            attachmentId: attachment?.id ?? null,
            fireMode: 'auto', fireRate: 8, damage: 10, magazine: 30, reserve: 90, reloadSeconds: 1.5, spread: 2, pellets: 1, projectileSpeed: 60,
        }]);
    };

    return (
        <div className="space-y-2">
            <label className="text-[10px] uppercase font-bold text-gray-500 flex items-center gap-2">
                <Crosshair size={12} /> Weapons
            </label>
            <div className="bg-gray-800/50 rounded p-3 border border-gray-800 space-y-3">
                {weapons.map((weapon, index) => (
                    <div key={weapon.id} data-testid="weapon-entry" className="space-y-2 pb-3 border-b border-gray-800 last:border-b-0 last:pb-0">
                        <div className="flex items-center gap-2">
                            <span className="text-[9px] font-mono text-gray-500 w-4">{index + 1}</span>
                            <input
                                aria-label="Weapon name"
                                value={weapon.name}
                                onChange={(event) => update(weapon.id, { name: event.target.value }, `weapon:${weapon.id}:name`)}
                                className="flex-1 min-w-0 bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
                            />
                            <button
                                type="button"
                                aria-label={`Remove ${weapon.name}`}
                                onClick={() => onChange(weapons.filter(other => other.id !== weapon.id))}
                                className="p-1 text-gray-500 hover:text-red-400"
                            >
                                <Trash2 size={12} />
                            </button>
                        </div>
                        <div className="flex items-center justify-between gap-4">
                            <span className="text-xs text-gray-400 shrink-0">Model</span>
                            <select
                                aria-label="Weapon model"
                                value={weapon.attachmentId ?? ''}
                                onChange={(event) => update(weapon.id, { attachmentId: event.target.value || null })}
                                className={selectClass}
                            >
                                <option value="">None</option>
                                {attachments.map(attachment => <option key={attachment.id} value={attachment.id}>{attachment.name}</option>)}
                                {weapon.attachmentId && !attachments.some(attachment => attachment.id === weapon.attachmentId) && (
                                    <option value={weapon.attachmentId}>(missing attachment)</option>
                                )}
                            </select>
                        </div>
                        <div className="flex items-center justify-between gap-4">
                            <span className="text-xs text-gray-400 shrink-0">Muzzle</span>
                            <select
                                aria-label="Weapon muzzle socket"
                                value={weapon.muzzleSocket ?? ''}
                                onChange={(event) => update(weapon.id, { muzzleSocket: event.target.value || null })}
                                className={selectClass}
                            >
                                <option value="">First Muzzle socket</option>
                                {sockets.map(socket => <option key={socket.id} value={socket.name}>{socket.name}</option>)}
                                {weapon.muzzleSocket && !sockets.some(socket => socket.name === weapon.muzzleSocket) && (
                                    <option value={weapon.muzzleSocket}>{weapon.muzzleSocket} (missing)</option>
                                )}
                            </select>
                        </div>
                        <label className="flex items-center gap-2 text-xs text-gray-400" title="Off: the player gets it from a pickup, a Give Weapon node or a script">
                            <input
                                type="checkbox"
                                aria-label="Carried from the start"
                                checked={weapon.startsOwned !== false}
                                onChange={(event) => update(weapon.id, { startsOwned: event.target.checked })}
                                className="accent-blue-500"
                            />
                            Carried from the start
                        </label>
                        <div className="flex items-center justify-between gap-4">
                            <span className="text-xs text-gray-400 shrink-0" title="Where the model goes while not aiming, firing or reloading, and while another weapon is held">When not in use</span>
                            <select
                                aria-label="Carry bone"
                                value={weapon.carry?.boneName ?? ''}
                                onChange={(event) => update(weapon.id, {
                                    carry: event.target.value
                                        ? { boneName: event.target.value, position: weapon.carry?.position ?? [0, 0, 0], rotation: weapon.carry?.rotation ?? [0, 0, 0] }
                                        : null,
                                })}
                                className={selectClass}
                            >
                                <option value="">Stay in hand</option>
                                {boneNames.map(name => <option key={name} value={name}>On {name}</option>)}
                                {weapon.carry && !boneNames.includes(weapon.carry.boneName) && (
                                    <option value={weapon.carry.boneName}>On {weapon.carry.boneName} (missing)</option>
                                )}
                            </select>
                        </div>
                        {weapon.carry && (
                            <div className="space-y-1.5">
                                <TransformInputGroup
                                    label="Carry position"
                                    values={weapon.carry.position}
                                    step={0.5}
                                    onChange={(position) => updateCarry(weapon, { position }, `weapon:${weapon.id}:carryPosition`)}
                                />
                                <TransformInputGroup
                                    label="Carry rotation (°)"
                                    values={weapon.carry.rotation}
                                    step={5}
                                    onChange={(rotation) => updateCarry(weapon, { rotation }, `weapon:${weapon.id}:carryRotation`)}
                                />
                                {onSeat && (
                                    <div className="flex items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={() => setSeatStatus(status => ({ ...status, [weapon.id]: onSeat(weapon) }))}
                                            className="px-2 py-0.5 text-[10px] text-gray-200 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded"
                                            title="Moves the carried weapon straight out from or in toward the bone until it rests against the body, keeping its rotation"
                                        >
                                            Seat on the body
                                        </button>
                                        {seatStatus[weapon.id] && <span className="text-[10px] text-gray-400 leading-tight">{seatStatus[weapon.id]}</span>}
                                    </div>
                                )}
                            </div>
                        )}
                        {onFocus && weapon.attachmentId && (
                            <div className="space-y-1.5 rounded border border-gray-800 bg-gray-950/50 p-2">
                                <div className="flex items-center justify-between gap-2">
                                    <button
                                        type="button"
                                        onClick={() => onFocus(focus?.weaponId === weapon.id ? null : { weaponId: weapon.id, field: null })}
                                        className={`text-xs ${focus?.weaponId === weapon.id ? 'text-blue-300' : 'text-gray-300 hover:text-white'}`}
                                        title="Shows this weapon in the hands in the preview, with its points"
                                    >
                                        Fit to the hands
                                    </button>
                                    {onFit && (
                                        <button
                                            type="button"
                                            onClick={() => setFitStatus(status => ({ ...status, [weapon.id]: onFit(weapon) }))}
                                            className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accent-ink bg-blue-600 hover:bg-blue-500 rounded"
                                            title="Places the weapon in the hands as its Idle while held clip (else its Aim clip) poses them: its grip where the fingers close, its barrel through the other hand, or ahead"
                                        >
                                            Fit
                                        </button>
                                    )}
                                </div>
                                {WEAPON_POINTS.map(([field, label, color, title]) => {
                                    const point = weapon[field];
                                    const picking = focus?.weaponId === weapon.id && focus.field === field;
                                    return (
                                        <div key={field} className="space-y-1" title={title}>
                                            <div className="flex items-center gap-2">
                                                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
                                                <span className="text-[10px] text-gray-400 w-16 shrink-0">{label}</span>
                                                <span className="flex-1 text-[10px] font-mono text-gray-500 truncate">{point ? point.map(value => value.toFixed(3)).join(', ') : 'not set'}</span>
                                                <button
                                                    type="button"
                                                    aria-label={`Pick the ${label.toLowerCase()} point on the weapon`}
                                                    onClick={() => onFocus(picking ? { weaponId: weapon.id, field: null } : { weaponId: weapon.id, field })}
                                                    className={`px-1.5 py-0.5 text-[10px] rounded border ${picking ? 'border-blue-500 text-blue-300' : 'border-gray-700 text-gray-300 hover:text-white'}`}
                                                >
                                                    {picking ? 'Click the weapon' : 'Pick'}
                                                </button>
                                                {point && (
                                                    <button
                                                        type="button"
                                                        aria-label={`Clear the ${label.toLowerCase()} point`}
                                                        onClick={() => update(weapon.id, { [field]: null })}
                                                        className="text-gray-500 hover:text-red-400"
                                                    >
                                                        <Trash2 size={11} />
                                                    </button>
                                                )}
                                            </div>
                                            {point && focus?.weaponId === weapon.id && (
                                                <TransformInputGroup
                                                    label={`${label} point`}
                                                    values={point}
                                                    step={0.01}
                                                    onChange={(value) => update(weapon.id, { [field]: value }, `weapon:${weapon.id}:${field}`)}
                                                />
                                            )}
                                        </div>
                                    );
                                })}
                                {fitStatus[weapon.id] && <p className="text-[10px] text-gray-400 leading-tight">{fitStatus[weapon.id]}</p>}
                            </div>
                        )}
<div className="flex items-center justify-between gap-4">
                            <span className="text-xs text-gray-400 shrink-0">Fire mode</span>
                            <select
                                aria-label="Fire mode"
                                value={weapon.fireMode ?? DEFAULT_WEAPON.fireMode}
                                onChange={(event) => update(weapon.id, { fireMode: event.target.value === 'semi' ? 'semi' : 'auto' })}
                                className={selectClass}
                            >
                                <option value="auto">Automatic</option>
                                <option value="semi">Semi-automatic</option>
                            </select>
                        </div>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                            {NUMBER_FIELDS.map(field => (
                                <label key={field.key} title={field.title} className="flex items-center justify-between gap-2 text-[10px] text-gray-400">
                                    <span className="truncate">{field.label}</span>
                                    <input
                                        type="number"
                                        aria-label={field.title}
                                        step={field.step}
                                        min={field.min}
                                        value={weapon[field.key] ?? DEFAULT_WEAPON[field.key]}
                                        onChange={(event) => {
                                            const value = event.target.valueAsNumber;
                                            if (Number.isFinite(value)) update(weapon.id, { [field.key]: Math.max(field.min, value) }, `weapon:${weapon.id}:${field.key}`);
                                        }}
                                        className="w-16 bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-gray-200 font-mono focus:outline-none focus:border-blue-500"
                                    />
                                </label>
                            ))}
                        </div>
                        {CLIP_FIELDS.map(([key, label]) => {
                            const current = weapon[key] ?? '';
                            return (
                                <div key={key} className="flex items-center justify-between gap-4">
                                    <span className="text-xs text-gray-400 shrink-0">{label}</span>
                                    <select
                                        aria-label={label}
                                        value={current}
                                        onChange={(event) => update(weapon.id, { [key]: event.target.value || null })}
                                        className={selectClass}
                                    >
                                        <option value="">{UPPER_BODY_CLIPS.has(key) ? 'Upper Body clip' : key === 'reloadClip' ? 'None' : 'Graph clip'}</option>
                                        {clipNames.map(name => <option key={name} value={name}>{name}</option>)}
                                        {current && !clipNames.includes(current) && <option value={current}>{current} (missing)</option>}
                                    </select>
                                </div>
                            );
                        })}
                    </div>
                ))}
                <button
                    type="button"
                    onClick={addWeapon}
                    className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-300 bg-gray-900 hover:bg-gray-800 border border-gray-700 rounded"
                >
                    <Plus size={12} /> Add Weapon
                </button>
                <p className="text-[9px] text-gray-500 leading-tight">
                    {weapons.length
                        ? 'The player starts holding the first weapon carried from the start; the others come from pickups, Give Weapon nodes or scripts. Next Weapon(Q) switches, Reload (R) reloads, and an empty magazine reloads when you fire. Only the held weapon’s model shows.'
                        : 'Without weapons the player fires an automatic with unlimited ammunition. Add one to set its rate, damage, magazine and model.'}
                </p>
            </div>
        </div>
    );
};
