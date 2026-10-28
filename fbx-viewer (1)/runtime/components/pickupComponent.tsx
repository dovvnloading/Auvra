import React, { useContext, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { LevelComponent } from '../../types';
import { useGameContent } from '../GameContentContext';
import { playerActions } from '../playerActions';
import { useRuntimeServices } from '../RuntimeServicesContext';
import { findAudioAsset } from './audioComponents';
import { ComponentHostContext } from './builtins';
import { IKPlayerTargetContext } from './ikComponents';
import type { ComponentDefinition, ComponentRenderProps } from './types';

/**
 * PICKUP COMPONENT
 *
 * Health, rounds or a weapon the player collects by walking into the object. A pickup that gives
 * nothing (full health, a weapon that takes no rounds) stays for later. Taken, it disappears and
 * comes back after Respawn seconds; with no respawn the object is removed from the session, so a
 * save remembers it is gone.
 */

export const PICKUP_COMPONENT_TYPE = 'pickup';

export type PickupKind = 'health' | 'ammo' | 'weapon';

export const PICKUP_DEFAULTS = { kind: 'health' as PickupKind, amount: 25, weapon: '', radius: 1.2, respawn: 0, sound: '' };

export interface PickupSettings {
    kind: PickupKind;
    /** Health restored, or rounds added. */
    amount: number;
    /** The weapon by name or id: rounds for it (blank: the held one), or the weapon given. */
    weapon: string;
    /** How close the player must come, in metres. */
    radius: number;
    /** Seconds until it comes back; 0 never does. */
    respawn: number;
    /** Audio asset (id or name) played when taken. */
    sound: string;
}

const number = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

export const readPickupSettings = (component: LevelComponent): PickupSettings => {
    const props = component.props;
    const kind = props.kind === 'ammo' || props.kind === 'weapon' ? props.kind : 'health';
    return {
        kind,
        amount: number(props.amount, PICKUP_DEFAULTS.amount, 0, 100000),
        weapon: typeof props.weapon === 'string' ? props.weapon.trim() : '',
        radius: number(props.radius, PICKUP_DEFAULTS.radius, 0.1, 50),
        respawn: number(props.respawn, PICKUP_DEFAULTS.respawn, 0, 3600),
        sound: typeof props.sound === 'string' ? props.sound.trim() : '',
    };
};

/** Gives the player what the pickup holds; true when it was taken. */
export const applyPickup = (settings: PickupSettings): boolean => {
    if (settings.kind === 'health') return playerActions.heal(settings.amount);
    if (settings.kind === 'ammo') return playerActions.addAmmo(settings.amount, settings.weapon || null);
    return playerActions.giveWeapon(settings.weapon);
};

const _player = new THREE.Vector3();
const _pickup = new THREE.Vector3();

const PickupRuntime: React.FC<{ objectId: string; settings: PickupSettings }> = ({ objectId, settings }) => {
    const host = useContext(ComponentHostContext);
    const playerRef = useContext(IKPlayerTargetContext);
    const services = useRuntimeServices();
    const { audioAssets } = useGameContent();
    // Seconds until a taken pickup comes back; null while it is there to take.
    const away = useRef<number | null>(null);

    useFrame((_, delta) => {
        const object = host?.current;
        const player = playerRef?.current;
        if (!object) return;
        if (away.current !== null) {
            away.current -= delta;
            if (away.current > 0) return;
            away.current = null;
            object.visible = true;
        }
        if (!player) return;
        player.getWorldPosition(_player);
        object.getWorldPosition(_pickup);
        if (_player.distanceTo(_pickup) > settings.radius || !applyPickup(settings)) return;
        const sound = findAudioAsset(audioAssets, settings.sound);
        if (sound) services.playSound(sound.id);
        if (settings.respawn > 0) {
            away.current = settings.respawn;
            object.visible = false;
        } else {
            services.destroyObject(objectId);
        }
    });
    return null;
};

const PICKUP_COLORS: Record<PickupKind, string> = { health: '#22c55e', ammo: '#f59e0b', weapon: '#38bdf8' };

const PickupPreview: React.FC<{ settings: PickupSettings }> = ({ settings }) => (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} raycast={() => null}>
        <ringGeometry args={[Math.max(0, settings.radius - 0.05), settings.radius, 48]} />
        <meshBasicMaterial color={PICKUP_COLORS[settings.kind]} transparent opacity={0.5} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
);

const PickupRender: React.FC<ComponentRenderProps> = ({ object, component, mode }) => {
    const settings = useMemo(() => readPickupSettings(component), [component]);
    return mode === 'runtime' ? <PickupRuntime objectId={object.id} settings={settings} /> : <PickupPreview settings={settings} />;
};

export const PICKUP_COMPONENT: ComponentDefinition = {
    type: PICKUP_COMPONENT_TYPE,
    label: 'Pickup',
    description: 'Health, rounds or a weapon the player collects by walking into the object. It stays while it would give nothing (full health). Taken, it comes back after Respawn seconds, or never with 0.',
    props: [
        {
            key: 'kind', label: 'Gives', type: 'select', default: PICKUP_DEFAULTS.kind,
            options: [{ label: 'Health', value: 'health' }, { label: 'Ammo', value: 'ammo' }, { label: 'Weapon', value: 'weapon' }],
        },
        { key: 'amount', label: 'Amount (health or rounds)', type: 'number', default: PICKUP_DEFAULTS.amount, min: 0, max: 100000, step: 1 },
        { key: 'weapon', label: 'Weapon (name; blank: held)', type: 'string', default: PICKUP_DEFAULTS.weapon },
        { key: 'radius', label: 'Reach (m)', type: 'number', default: PICKUP_DEFAULTS.radius, min: 0.1, max: 50, step: 0.1 },
        { key: 'respawn', label: 'Respawn (s, 0 never)', type: 'number', default: PICKUP_DEFAULTS.respawn, min: 0, max: 3600, step: 1 },
        { key: 'sound', label: 'Sound (id or name)', type: 'string', default: PICKUP_DEFAULTS.sound },
    ],
    Render: PickupRender,
};
