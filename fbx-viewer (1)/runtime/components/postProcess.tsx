import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import {
    Bloom, BrightnessContrast, DepthOfField, EffectComposer, HueSaturation, N8AO, SMAA, ToneMapping, Vignette
} from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { RENDER_CONVENTIONS } from '../../renderer/conventions';
import type { LevelComponent } from '../../types';
import type { ComponentDefinition, ComponentPropSchema, ComponentRenderProps } from './types';

// --- SETTINGS ---

export type PostProcessToneMapping = 'aces' | 'agx' | 'reinhard' | 'neutral' | 'none';
export type PostProcessAntialias = 'smaa' | 'none';

export const POST_PROCESS_TONE_MAPPINGS: readonly PostProcessToneMapping[] = ['aces', 'agx', 'reinhard', 'neutral', 'none'];
export const POST_PROCESS_ANTIALIAS_MODES: readonly PostProcessAntialias[] = ['smaa', 'none'];

/** A level's post-process stack, every field defaulted and within range. */
export interface PostProcessSettings {
    bloom: boolean;
    /** Strength of the glow added around bright pixels. */
    bloomIntensity: number;
    /** Scene luminance, before tone mapping, above which pixels glow; 1 is diffuse white. */
    bloomThreshold: number;
    ambientOcclusion: boolean;
    aoIntensity: number;
    /** World-space radius in metres that occlusion is gathered over. */
    aoRadius: number;
    toneMapping: PostProcessToneMapping;
    /** Multiplier on scene light before tone mapping. */
    exposure: number;
    vignette: boolean;
    vignetteDarkness: number;
    depthOfField: boolean;
    /** Distance in metres from the camera that stays sharp. */
    focusDistance: number;
    bokehScale: number;
    /** -1..1; 0 leaves the image unchanged. */
    saturation: number;
    /** -1..1; 0 leaves the image unchanged. */
    contrast: number;
    /** -1..1; 0 leaves the image unchanged. */
    brightness: number;
    antialias: PostProcessAntialias;
}

type SettingKey<T> = { [K in keyof PostProcessSettings]: PostProcessSettings[K] extends T ? K : never }[keyof PostProcessSettings];
type NumberSetting = SettingKey<number>;
type BooleanSetting = SettingKey<boolean>;

/** Subtle bloom on emissive and over-bright pixels, ambient occlusion, ACES, a light vignette and SMAA. */
export const POST_PROCESS_DEFAULTS: PostProcessSettings = {
    bloom: true,
    bloomIntensity: 0.4,
    // Above the sky's brightness: at 1 the whole sky bloomed into a haze over everything in front of it.
    bloomThreshold: 3,
    ambientOcclusion: true,
    aoIntensity: 2,
    aoRadius: 1.5,
    toneMapping: 'aces',
    exposure: 1,
    vignette: true,
    vignetteDarkness: 0.4,
    depthOfField: false,
    focusDistance: 10,
    bokehScale: 2,
    saturation: 0,
    contrast: 0,
    brightness: 0,
    antialias: 'smaa'
};

/** Editable range of every numeric setting; stored values outside it clamp. */
export const POST_PROCESS_RANGES: Record<NumberSetting, { min: number; max: number; step: number }> = {
    bloomIntensity: { min: 0, max: 10, step: 0.05 },
    bloomThreshold: { min: 0, max: 10, step: 0.05 },
    aoIntensity: { min: 0, max: 10, step: 0.1 },
    aoRadius: { min: 0.05, max: 20, step: 0.05 },
    exposure: { min: 0.05, max: 10, step: 0.05 },
    vignetteDarkness: { min: 0, max: 1, step: 0.05 },
    focusDistance: { min: 0.1, max: 1000, step: 0.1 },
    bokehScale: { min: 0, max: 10, step: 0.1 },
    saturation: { min: -1, max: 1, step: 0.01 },
    contrast: { min: -1, max: 1, step: 0.01 },
    brightness: { min: -1, max: 1, step: 0.01 }
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const readNumber = (props: Record<string, unknown>, key: NumberSetting): number => {
    const value = props[key];
    const { min, max } = POST_PROCESS_RANGES[key];
    return clamp(typeof value === 'number' && Number.isFinite(value) ? value : POST_PROCESS_DEFAULTS[key], min, max);
};

const readBoolean = (props: Record<string, unknown>, key: BooleanSetting): boolean => {
    const value = props[key];
    return typeof value === 'boolean' ? value : POST_PROCESS_DEFAULTS[key];
};

const readChoice = <T extends string>(value: unknown, choices: readonly T[], fallback: T): T =>
    typeof value === 'string' && (choices as readonly string[]).includes(value) ? value as T : fallback;

/** Stored component props to stack settings; missing or malformed values fall back, numbers clamp to their range. */
export const resolvePostProcessSettings = (component: LevelComponent): PostProcessSettings => {
    const props: Record<string, unknown> = component.props && typeof component.props === 'object' ? component.props : {};
    return {
        bloom: readBoolean(props, 'bloom'),
        bloomIntensity: readNumber(props, 'bloomIntensity'),
        bloomThreshold: readNumber(props, 'bloomThreshold'),
        ambientOcclusion: readBoolean(props, 'ambientOcclusion'),
        aoIntensity: readNumber(props, 'aoIntensity'),
        aoRadius: readNumber(props, 'aoRadius'),
        toneMapping: readChoice(props.toneMapping, POST_PROCESS_TONE_MAPPINGS, POST_PROCESS_DEFAULTS.toneMapping),
        exposure: readNumber(props, 'exposure'),
        vignette: readBoolean(props, 'vignette'),
        vignetteDarkness: readNumber(props, 'vignetteDarkness'),
        depthOfField: readBoolean(props, 'depthOfField'),
        focusDistance: readNumber(props, 'focusDistance'),
        bokehScale: readNumber(props, 'bokehScale'),
        saturation: readNumber(props, 'saturation'),
        contrast: readNumber(props, 'contrast'),
        brightness: readNumber(props, 'brightness'),
        antialias: readChoice(props.antialias, POST_PROCESS_ANTIALIAS_MODES, POST_PROCESS_DEFAULTS.antialias)
    };
};

// --- OWNERSHIP ---

/** Claims per canvas (keyed by its renderer), oldest first; the oldest owns that canvas's post-process output. */
const postProcessClaims = new WeakMap<object, object[]>();
const ownerListeners = new Set<() => void>();

const notifyOwnerListeners = () => {
    for (const listener of [...ownerListeners]) listener();
};

/**
 * Queues `token` for the post-process output of `scope` (a renderer, so each canvas has its own owner).
 * The oldest claim owns it; when the owner releases, the next claim takes over. Returns the release,
 * which is safe to call more than once.
 */
export const claimPostProcess = (scope: object, token: object): (() => void) => {
    let queue = postProcessClaims.get(scope);
    if (!queue) {
        queue = [];
        postProcessClaims.set(scope, queue);
    }
    const held = queue;
    held.push(token);
    notifyOwnerListeners();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const index = held.indexOf(token);
        if (index < 0) return;
        held.splice(index, 1);
        if (held.length === 0 && postProcessClaims.get(scope) === held) postProcessClaims.delete(scope);
        notifyOwnerListeners();
    };
};

/** The claim that owns `scope`'s post-process output, or null when nothing claims it. */
export const getPostProcessOwner = (scope: object): object | null => postProcessClaims.get(scope)?.[0] ?? null;

/** Calls `listener` whenever a claim is made or released on any canvas; returns the unsubscribe. */
export const subscribePostProcessOwner = (listener: () => void): (() => void) => {
    ownerListeners.add(listener);
    return () => {
        ownerListeners.delete(listener);
    };
};

/**
 * Claims this canvas's post-process output while mounted and `enabled`; true while the caller owns it.
 * Several objects carrying an enabled postProcess component therefore mount one composer: the first
 * mounted, then the next in line once it goes away.
 */
export const useActivePostProcess = (enabled = true): boolean => {
    const gl = useThree(state => state.gl);
    const [token] = useState(() => ({}));
    useLayoutEffect(() => (enabled ? claimPostProcess(gl, token) : undefined), [enabled, gl, token]);
    return useSyncExternalStore(subscribePostProcessOwner, () => getPostProcessOwner(gl) === token);
};

/** True while a postProcess component owns this canvas's output, so another composer on it can stand down. */
export const usePostProcessClaimed = (): boolean => {
    const gl = useThree(state => state.gl);
    return useSyncExternalStore(subscribePostProcessOwner, () => getPostProcessOwner(gl) !== null);
};

/** False turns every postProcess component under it off (the player's post-processing quality setting). */
export const PostProcessAllowedContext = createContext(true);

// --- RENDERER TONE MAPPING ---

/** The renderer fields a post-process stack overrides while it owns the output. */
export type ToneMappingTarget = Pick<THREE.WebGLRenderer, 'toneMapping' | 'toneMappingExposure'>;

export interface ToneMappingOverride {
    /** Turns the renderer's tone mapping off and sets the exposure the ToneMapping effect reads; call before each composer render. */
    apply: (exposure: number) => void;
    /** Puts back the renderer's own tone mapping and exposure. */
    restore: () => void;
}

/** Auvra's fixed colour pipeline (renderer/conventions): what a canvas uses when nothing says otherwise. */
const CONVENTION_TONE_MAPPING: THREE.ToneMapping = THREE.ACESFilmicToneMapping;

/**
 * Overrides `gl`'s tone mapping for a composer that applies its own. Anything else writing the fields
 * while the override is applied (R3F re-applying the canvas gl props on a re-render, another composer
 * letting go) is taken as the renderer's own setting, so restore() puts back the latest of those. A
 * renderer already at NoToneMapping when the override starts is under another composer, and gets the
 * Auvra convention back.
 */
export const createToneMappingOverride = (gl: ToneMappingTarget): ToneMappingOverride => {
    let ownToneMapping = gl.toneMapping !== THREE.NoToneMapping ? gl.toneMapping : CONVENTION_TONE_MAPPING;
    let ownExposure = Number.isFinite(gl.toneMappingExposure) ? gl.toneMappingExposure : RENDER_CONVENTIONS.color.toneMappingExposure;
    let applied: number | null = null;
    return {
        apply: (exposure) => {
            if (gl.toneMapping !== THREE.NoToneMapping) ownToneMapping = gl.toneMapping;
            if (applied === null || gl.toneMappingExposure !== applied) ownExposure = gl.toneMappingExposure;
            gl.toneMapping = THREE.NoToneMapping;
            gl.toneMappingExposure = exposure;
            applied = exposure;
        },
        restore: () => {
            gl.toneMapping = ownToneMapping;
            gl.toneMappingExposure = ownExposure;
            applied = null;
        }
    };
};

/**
 * Holds the renderer's tone mapping off while the stack is mounted, so the ToneMapping effect is the
 * only curve applied, and drives the exposure it reads. It is mounted after the EffectComposer, whose
 * own save/restore of gl.toneMapping then runs first on unmount and this one has the last word.
 */
const RendererToneOverride: React.FC<{ exposure: number }> = ({ exposure }) => {
    const gl = useThree(state => state.gl);
    // Read while rendering, before the composer's mount effect switches the renderer's tone mapping off.
    const [override] = useState(() => createToneMappingOverride(gl));
    // Priority 0 runs ahead of the composer's render (priority 1) every frame.
    useFrame(() => override.apply(exposure));
    useEffect(() => () => override.restore(), [override]);
    return null;
};

// --- STACK ---

/** postprocessing's curve for each choice; None still scales by exposure (linear, clamped to display range). */
const TONE_MAPPING_MODES: Record<PostProcessToneMapping, ToneMappingMode> = {
    aces: ToneMappingMode.ACES_FILMIC,
    agx: ToneMappingMode.AGX,
    reinhard: ToneMappingMode.REINHARD,
    neutral: ToneMappingMode.NEUTRAL,
    none: ToneMappingMode.LINEAR
};

const BLOOM_SMOOTHING = 0.2;
const BLOOM_RADIUS = 0.7;
/** N8AO fades occlusion over this fraction of the radius (its own screen-space ratio). */
const AO_FALLOFF_RATIO = 0.2;
/** N8AO's Medium quality, passed as values: its quality prop is overwritten whenever another prop changes. */
const AO_QUALITY = { aoSamples: 16, denoiseSamples: 8, denoiseRadius: 12 };
/** The in-focus band spans this fraction of the focus distance, so near focus gives a shallower field, as with a lens. */
const FOCUS_RANGE_RATIO = 0.5;
const VIGNETTE_OFFSET = 0.35;

/**
 * One composer with the enabled effects, in pipeline order: occlusion on the lit scene, depth of field,
 * bloom on HDR values, tone mapping, colour grading and vignette on display values, then SMAA. MSAA stays
 * off: SMAA (or nothing) is the anti-aliasing, which keeps the HDR buffers single-sampled.
 */
const PostProcessStack = React.memo<{ settings: PostProcessSettings }>(({ settings }) => {
    const camera = useThree(state => state.camera);
    const effects: React.ReactElement[] = [];
    if (settings.ambientOcclusion) {
        // The pass keeps the camera it was built with, so a new default camera rebuilds it.
        effects.push(
            <N8AO
                key={`ao-${camera.uuid}`}
                intensity={settings.aoIntensity}
                aoRadius={settings.aoRadius}
                distanceFalloff={settings.aoRadius * AO_FALLOFF_RATIO}
                {...AO_QUALITY}
            />
        );
    }
    if (settings.depthOfField) {
        effects.push(
            <DepthOfField
                key="dof"
                worldFocusDistance={settings.focusDistance}
                worldFocusRange={settings.focusDistance * FOCUS_RANGE_RATIO}
                bokehScale={settings.bokehScale}
            />
        );
    }
    if (settings.bloom) {
        effects.push(
            <Bloom
                key="bloom"
                mipmapBlur
                intensity={settings.bloomIntensity}
                luminanceThreshold={settings.bloomThreshold}
                luminanceSmoothing={BLOOM_SMOOTHING}
                radius={BLOOM_RADIUS}
            />
        );
    }
    effects.push(<ToneMapping key="tone" mode={TONE_MAPPING_MODES[settings.toneMapping]} />);
    if (settings.saturation !== 0) effects.push(<HueSaturation key="saturation" saturation={settings.saturation} />);
    if (settings.brightness !== 0 || settings.contrast !== 0) {
        effects.push(<BrightnessContrast key="grade" brightness={settings.brightness} contrast={settings.contrast} />);
    }
    if (settings.vignette) {
        effects.push(<Vignette key="vignette" eskil={false} offset={VIGNETTE_OFFSET} darkness={settings.vignetteDarkness} />);
    }
    if (settings.antialias === 'smaa') effects.push(<SMAA key="smaa" />);
    return (
        <>
            <EffectComposer multisampling={0} enableNormalPass={false}>
                {effects}
            </EffectComposer>
            <RendererToneOverride exposure={settings.exposure} />
        </>
    );
});
PostProcessStack.displayName = 'PostProcessStack';

/** Mounts the stack for the canvas's post-process owner; the owner's transform plays no part. */
const PostProcessRender: React.FC<ComponentRenderProps> = ({ component }) => {
    const allowed = useContext(PostProcessAllowedContext);
    const active = useActivePostProcess(allowed);
    const settings = useMemo(() => resolvePostProcessSettings(component), [component]);
    return active ? <PostProcessStack settings={settings} /> : null;
};

// --- DEFINITION ---

const numberProp = (key: NumberSetting, label: string): ComponentPropSchema => ({
    key, label, type: 'number', default: POST_PROCESS_DEFAULTS[key], ...POST_PROCESS_RANGES[key]
});

const booleanProp = (key: BooleanSetting, label: string): ComponentPropSchema => ({
    key, label, type: 'boolean', default: POST_PROCESS_DEFAULTS[key]
});

export const POST_PROCESS_COMPONENT: ComponentDefinition = {
    type: 'postProcess',
    label: 'Post Process',
    description: 'Post-processing for the whole view, in the editor and in play: bloom, ambient occlusion, tone mapping, '
        + 'exposure, vignette, depth of field, colour grading and anti-aliasing. The object\'s transform is ignored; '
        + 'when several objects carry one, the first mounted applies.',
    props: [
        booleanProp('bloom', 'Bloom'),
        numberProp('bloomIntensity', 'Bloom Intensity'),
        numberProp('bloomThreshold', 'Bloom Threshold'),
        booleanProp('ambientOcclusion', 'Ambient Occlusion'),
        numberProp('aoIntensity', 'AO Intensity'),
        numberProp('aoRadius', 'AO Radius (m)'),
        {
            key: 'toneMapping', label: 'Tone Mapping', type: 'select', default: POST_PROCESS_DEFAULTS.toneMapping,
            options: [
                { label: 'ACES Filmic', value: 'aces' },
                { label: 'AgX', value: 'agx' },
                { label: 'Reinhard', value: 'reinhard' },
                { label: 'Neutral', value: 'neutral' },
                { label: 'None', value: 'none' }
            ]
        },
        numberProp('exposure', 'Exposure'),
        booleanProp('vignette', 'Vignette'),
        numberProp('vignetteDarkness', 'Vignette Darkness'),
        booleanProp('depthOfField', 'Depth of Field'),
        numberProp('focusDistance', 'Focus Distance (m)'),
        numberProp('bokehScale', 'Bokeh Scale'),
        numberProp('saturation', 'Saturation'),
        numberProp('contrast', 'Contrast'),
        numberProp('brightness', 'Brightness'),
        {
            key: 'antialias', label: 'Anti-aliasing', type: 'select', default: POST_PROCESS_DEFAULTS.antialias,
            options: [
                { label: 'SMAA', value: 'smaa' },
                { label: 'None', value: 'none' }
            ]
        }
    ],
    Render: PostProcessRender
};
