import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import {
    Bloom, BrightnessContrast, ChromaticAberration, DepthOfField, HueSaturation, N8AO, Noise, SMAA, ToneMapping, Vignette
} from '@react-three/postprocessing';
import { BlendFunction, LUT3DEffect, ToneMappingMode } from 'postprocessing';
import {
    AutoExposureEffect, COLOR_LOOKS, LightShaftsEffect, lookTexture, MotionBlurEffect, SunHazeEffect, WhiteBalanceEffect, type ColorLook,
} from '../postEffects';
import { ScreenLightingEffect } from '../screenLighting';
import { OwnedComposer, TemporalPipeline } from '../temporal/TemporalPipeline';
import { MAX_RENDER_SCALE, MIN_RENDER_SCALE } from '../temporal/temporalSettings';
import { RENDER_CONVENTIONS } from '../../renderer/conventions';
import type { LevelComponent } from '../../types';
import type { ComponentDefinition, ComponentPropSchema, ComponentRenderProps } from './types';

// --- SETTINGS ---

export type PostProcessToneMapping = 'aces' | 'agx' | 'reinhard' | 'neutral' | 'none';
export type PostProcessAntialias = 'temporal' | 'smaa' | 'none';
export type PostProcessLook = ColorLook;

export const POST_PROCESS_TONE_MAPPINGS: readonly PostProcessToneMapping[] = ['aces', 'agx', 'reinhard', 'neutral', 'none'];
export const POST_PROCESS_ANTIALIAS_MODES: readonly PostProcessAntialias[] = ['temporal', 'smaa', 'none'];

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
    /** Temporal only: the size the lit scene is drawn at, as a share of the display's in each direction. */
    renderScale: number;
    /** Temporal only: how much crispness to restore to the gathered picture. */
    sharpness: number;
    /** The eye adapting to the light: brighter in the dark, darker in glare. */
    autoExposure: boolean;
    /** Stops (EV) brighter or darker than auto exposure settles on. */
    exposureCompensation: number;
    /** How quickly it adapts: 1 is about a second in glare and two in the dark. */
    adaptationSpeed: number;
    /** Beams of sunlight through gaps against the sky. */
    lightShafts: boolean;
    lightShaftsIntensity: number;
    /** Fog and mist glowing toward the sun. */
    sunHaze: boolean;
    sunHazeIntensity: number;
    /** Light bounced from lit surfaces onto the surfaces around them, worked out from the screen. */
    globalIllumination: boolean;
    giIntensity: number;
    /** Reflections of what is on screen in glossy surfaces. */
    reflections: boolean;
    reflectionIntensity: number;
    /** Blur from the camera's own motion; 1 is a full frame's worth (a 360-degree shutter). */
    motionBlur: boolean;
    motionBlurStrength: number;
    /** -1..1: cooler to warmer, and green to magenta. */
    temperature: number;
    tint: number;
    /** A colour grading look, and how much of it. */
    look: PostProcessLook;
    lookStrength: number;
    /** 0..1: film grain and colour fringes toward the edges. */
    filmGrain: number;
    chromaticAberration: number;
}

type SettingKey<T> = { [K in keyof PostProcessSettings]: PostProcessSettings[K] extends T ? K : never }[keyof PostProcessSettings];
type NumberSetting = SettingKey<number>;
type BooleanSetting = SettingKey<boolean>;

/** Subtle bloom on emissive and over-bright pixels, ambient occlusion, ACES, a light vignette and temporal anti-aliasing. */
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
    antialias: 'temporal',
    renderScale: 1,
    sharpness: 0.25,
    autoExposure: true,
    exposureCompensation: 0,
    adaptationSpeed: 1,
    lightShafts: true,
    lightShaftsIntensity: 0.35,
    sunHaze: true,
    sunHazeIntensity: 0.5,
    globalIllumination: true,
    giIntensity: 1,
    reflections: true,
    reflectionIntensity: 1,
    motionBlur: false,
    motionBlurStrength: 0.5,
    temperature: 0,
    tint: 0,
    look: 'none',
    lookStrength: 1,
    filmGrain: 0,
    chromaticAberration: 0
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
    brightness: { min: -1, max: 1, step: 0.01 },
    exposureCompensation: { min: -4, max: 4, step: 0.1 },
    adaptationSpeed: { min: 0.1, max: 10, step: 0.1 },
    lightShaftsIntensity: { min: 0, max: 3, step: 0.05 },
    sunHazeIntensity: { min: 0, max: 3, step: 0.05 },
    giIntensity: { min: 0, max: 4, step: 0.05 },
    reflectionIntensity: { min: 0, max: 2, step: 0.05 },
    motionBlurStrength: { min: 0, max: 1, step: 0.05 },
    temperature: { min: -1, max: 1, step: 0.01 },
    tint: { min: -1, max: 1, step: 0.01 },
    lookStrength: { min: 0, max: 1, step: 0.05 },
    filmGrain: { min: 0, max: 1, step: 0.01 },
    chromaticAberration: { min: 0, max: 1, step: 0.01 },
    renderScale: { min: MIN_RENDER_SCALE, max: MAX_RENDER_SCALE, step: 0.05 },
    sharpness: { min: 0, max: 1, step: 0.05 }
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
        antialias: readChoice(props.antialias, POST_PROCESS_ANTIALIAS_MODES, POST_PROCESS_DEFAULTS.antialias),
        renderScale: readNumber(props, 'renderScale'),
        sharpness: readNumber(props, 'sharpness'),
        autoExposure: readBoolean(props, 'autoExposure'),
        exposureCompensation: readNumber(props, 'exposureCompensation'),
        adaptationSpeed: readNumber(props, 'adaptationSpeed'),
        lightShafts: readBoolean(props, 'lightShafts'),
        lightShaftsIntensity: readNumber(props, 'lightShaftsIntensity'),
        sunHaze: readBoolean(props, 'sunHaze'),
        sunHazeIntensity: readNumber(props, 'sunHazeIntensity'),
        globalIllumination: readBoolean(props, 'globalIllumination'),
        giIntensity: readNumber(props, 'giIntensity'),
        reflections: readBoolean(props, 'reflections'),
        reflectionIntensity: readNumber(props, 'reflectionIntensity'),
        motionBlur: readBoolean(props, 'motionBlur'),
        motionBlurStrength: readNumber(props, 'motionBlurStrength'),
        temperature: readNumber(props, 'temperature'),
        tint: readNumber(props, 'tint'),
        look: readChoice(props.look, COLOR_LOOKS, POST_PROCESS_DEFAULTS.look),
        lookStrength: readNumber(props, 'lookStrength'),
        filmGrain: readNumber(props, 'filmGrain'),
        chromaticAberration: readNumber(props, 'chromaticAberration')
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

/**
 * What the project and the moment allow: the most anti-aliasing a stack may use, and a multiplier on its
 * render scale (the project's setting, times whatever a slow frame rate has taken off).
 */
export const PostProcessQualityContext = createContext<{
    antialias: PostProcessAntialias;
    renderScale: number;
    /** Counts the stacks running temporal anti-aliasing, for what can lower the render scale to know it would help. */
    temporalStacks?: React.MutableRefObject<number>;
}>({ antialias: 'temporal', renderScale: 1 });

/** A level's choice held to what the project allows: temporal steps down to the project's choice, nothing steps up. */
export const allowedAntialias = (wanted: PostProcessAntialias, allowed: PostProcessAntialias): PostProcessAntialias =>
    wanted === 'temporal' ? allowed : allowed === 'none' ? 'none' : wanted;

/** The temporal stage keeps depth in a float target, which a device must be able to draw into. */
const canDrawFloat = (gl: unknown): boolean =>
    (gl as { extensions?: { has?: (name: string) => boolean } }).extensions?.has?.('EXT_color_buffer_float') !== false;

/** The anti-aliasing a stack that wants `wanted` should run on this canvas, counted for the slow-frame fallback while it runs. */
export const useAllowedAntialias = (wanted: PostProcessAntialias, running = true): PostProcessAntialias => {
    const gl = useThree(state => state.gl);
    const { antialias: allowed, temporalStacks } = useContext(PostProcessQualityContext);
    const chosen = allowedAntialias(wanted, allowed);
    const antialias = chosen === 'temporal' && !canDrawFloat(gl) ? 'smaa' : chosen;
    const temporal = running && antialias === 'temporal';
    useLayoutEffect(() => {
        if (!temporal || !temporalStacks) return undefined;
        const stacks = temporalStacks;
        stacks.current += 1;
        return () => { stacks.current -= 1; };
    }, [temporal, temporalStacks]);
    return antialias;
};

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

// --- CINEMATIC EFFECTS (runtime/postEffects.ts) ---

/** Ambient occlusion, which frees its targets when it goes, as the component on its own does not. */
const AmbientOcclusion: React.FC<React.ComponentProps<typeof N8AO>> = (props) => {
    const pass = useRef<{ dispose?: () => void } | null>(null);
    useLayoutEffect(() => {
        const owned = pass.current;
        return () => owned?.dispose?.();
    }, []);
    return <N8AO ref={pass as never} {...props} />;
};

/** Bounced light and screen-space reflections; rebuilt for a new scene or camera. */
export const ScreenLighting: React.FC<{ bounce: number; reflections: number }> = ({ bounce, reflections }) => {
    const scene = useThree(state => state.scene);
    const camera = useThree(state => state.camera);
    const effect = useMemo(() => new ScreenLightingEffect(scene, camera, { bounce, reflections }), [scene, camera]);
    useEffect(() => { effect.set({ bounce, reflections }); }, [effect, bounce, reflections]);
    useEffect(() => () => effect.dispose(), [effect]);
    return <primitive object={effect} />;
};

/** Auto exposure; lives as long as the stack, its settings changed in place. */
export const AutoExposure: React.FC<{ compensation: number; speed: number }> = ({ compensation, speed }) => {
    const effect = useMemo(() => new AutoExposureEffect(), []);
    useEffect(() => { effect.set({ compensation, brighten: 3 * speed, darken: 1.2 * speed }); }, [effect, compensation, speed]);
    useEffect(() => () => effect.dispose(), [effect]);
    return <primitive object={effect} />;
};

/** Light shafts round the sun; rebuilt for a new camera. */
export const LightShafts: React.FC<{ intensity: number }> = ({ intensity }) => {
    const camera = useThree(state => state.camera);
    const effect = useMemo(() => new LightShaftsEffect(camera, intensity), [camera]);
    useEffect(() => { effect.intensity = intensity; }, [effect, intensity]);
    useEffect(() => () => effect.dispose(), [effect]);
    return <primitive object={effect} />;
};

/** Fog glowing toward the sun; rebuilt for a new camera. */
export const SunHaze: React.FC<{ intensity: number }> = ({ intensity }) => {
    const camera = useThree(state => state.camera);
    const effect = useMemo(() => new SunHazeEffect(camera, intensity), [camera]);
    useEffect(() => { effect.intensity = intensity; }, [effect, intensity]);
    useEffect(() => () => effect.dispose(), [effect]);
    return <primitive object={effect} />;
};

const MotionBlur: React.FC<{ strength: number }> = ({ strength }) => {
    const camera = useThree(state => state.camera);
    const effect = useMemo(() => new MotionBlurEffect(camera, strength), [camera]);
    useEffect(() => { effect.strength = strength; }, [effect, strength]);
    useEffect(() => () => effect.dispose(), [effect]);
    return <primitive object={effect} />;
};

const WhiteBalance: React.FC<{ temperature: number; tint: number }> = ({ temperature, tint }) => {
    const effect = useMemo(() => new WhiteBalanceEffect(), []);
    useEffect(() => { effect.set(temperature, tint); }, [effect, temperature, tint]);
    useEffect(() => () => effect.dispose(), [effect]);
    return <primitive object={effect} />;
};

const Look: React.FC<{ look: ColorLook; strength: number }> = ({ look, strength }) => {
    const effect = useMemo(() => new LUT3DEffect(lookTexture(look), { blendFunction: BlendFunction.NORMAL }), [look]);
    useEffect(() => { effect.blendMode.opacity.value = strength; }, [effect, strength]);
    useEffect(() => () => effect.dispose(), [effect]);
    return <primitive object={effect} />;
};

/**
 * One composer with the enabled effects, in pipeline order: bounced light, reflections, sunlit haze and
 * occlusion on the lit scene,
 * depth of field, light shafts, motion blur, then auto exposure, white balance and bloom on HDR values;
 * tone mapping, colour grading, look, vignette, fringes and grain on display values; then SMAA when that is
 * the choice. MSAA stays off, which keeps the HDR buffers single-sampled.
 *
 * With temporal anti-aliasing the part on the lit scene runs at the render scale inside the temporal stage,
 * up to the resolve, and everything from depth of field on runs on the steady picture at the display's size.
 *
 * Haze stays in the composer's first effect pass: it reads depth there, from the buffer the depth texture
 * belongs to, so nothing that starts a pass of its own may come before it. Bounced light and reflections
 * draw their own surface buffer and join that pass. Later effects that need depth read it into targets of
 * their own.
 */
const PostProcessStack = React.memo<{ settings: PostProcessSettings }>(({ settings }) => {
    const camera = useThree(state => state.camera);
    const quality = useContext(PostProcessQualityContext);
    const antialias = useAllowedAntialias(settings.antialias);
    // Kept from render to render: a composer given new children rebuilds every pass and loses what they have gathered.
    const stack = useMemo(() => stackEffects(settings, camera.uuid, antialias), [settings, camera.uuid, antialias]);
    return (
        <>
            {antialias === 'temporal' ? (
                <TemporalPipeline key={stack.key} renderScale={settings.renderScale * quality.renderScale} sharpness={settings.sharpness} lit={stack.lit} display={stack.effects} />
            ) : (
                <OwnedComposer key={stack.key}>
                    {stack.all}
                </OwnedComposer>
            )}
            <RendererToneOverride exposure={settings.exposure} />
        </>
    );
});
PostProcessStack.displayName = 'PostProcessStack';

const stackEffects = (settings: PostProcessSettings, cameraId: string, antialias: PostProcessAntialias) => {
    const lit: React.ReactElement[] = [];
    const effects: React.ReactElement[] = [];
    // Light first: bounces and reflections, then haze and shafts add to the lit scene, motion blur smears it,
    // and the eye adapts to the result. Nothing that starts its own pass may come before the haze (see above).
    const bounce = settings.globalIllumination ? settings.giIntensity : 0;
    const reflections = settings.reflections ? settings.reflectionIntensity : 0;
    if (bounce > 0 || reflections > 0) lit.push(<ScreenLighting key="lighting" bounce={bounce} reflections={reflections} />);
    if (settings.sunHaze) lit.push(<SunHaze key="haze" intensity={settings.sunHazeIntensity} />);
    if (settings.ambientOcclusion) {
        // The pass keeps the camera it was built with, so a new default camera rebuilds it.
        lit.push(
            <AmbientOcclusion
                key={`ao-${cameraId}`}
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
    if (settings.lightShafts) effects.push(<LightShafts key="shafts" intensity={settings.lightShaftsIntensity} />);
    if (settings.motionBlur) effects.push(<MotionBlur key="motion" strength={settings.motionBlurStrength} />);
    if (settings.autoExposure) effects.push(<AutoExposure key="exposure" compensation={settings.exposureCompensation} speed={settings.adaptationSpeed} />);
    if (settings.temperature !== 0 || settings.tint !== 0) effects.push(<WhiteBalance key="balance" temperature={settings.temperature} tint={settings.tint} />);
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
    if (settings.look !== 'none' && settings.lookStrength > 0) effects.push(<Look key={`look-${settings.look}`} look={settings.look} strength={settings.lookStrength} />);
    if (settings.vignette) {
        effects.push(<Vignette key="vignette" eskil={false} offset={VIGNETTE_OFFSET} darkness={settings.vignetteDarkness} />);
    }
    if (settings.chromaticAberration > 0) {
        const shift = settings.chromaticAberration * 0.004;
        effects.push(<ChromaticAberration key="fringe" offset={new THREE.Vector2(shift, shift)} radialModulation modulationOffset={0.25} />);
    }
    if (settings.filmGrain > 0) {
        effects.push(<Noise key="grain" premultiply blendFunction={BlendFunction.SOFT_LIGHT} opacity={settings.filmGrain * 0.6} />);
    }
    if (antialias === 'smaa') effects.push(<SMAA key="smaa" />);
    // A composer takes its effects in the order it first saw them, and an effect added later lands last, after
    // tone mapping. A different set of effects, or a new camera (which rebuilds them), gets a fresh composer.
    const all = [...lit, ...effects];
    return { lit, effects, all, key: `${cameraId}/${all.map(effect => effect.key).join(',')}` };
};

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
        + 'exposure and auto exposure, global illumination, screen reflections, light shafts, sunlit haze, motion blur, '
        + 'vignette, depth of field, white balance, '
        + 'colour grading looks, film grain and anti-aliasing. The object\'s transform is ignored; '
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
        booleanProp('autoExposure', 'Auto Exposure'),
        numberProp('exposureCompensation', 'Exposure Compensation (EV)'),
        numberProp('adaptationSpeed', 'Adaptation Speed'),
        booleanProp('lightShafts', 'Light Shafts'),
        numberProp('lightShaftsIntensity', 'Light Shafts Intensity'),
        booleanProp('sunHaze', 'Sunlit Haze'),
        numberProp('sunHazeIntensity', 'Haze Intensity'),
        booleanProp('globalIllumination', 'Global Illumination'),
        numberProp('giIntensity', 'GI Intensity'),
        booleanProp('reflections', 'Screen Reflections'),
        numberProp('reflectionIntensity', 'Reflection Intensity'),
        booleanProp('motionBlur', 'Motion Blur'),
        numberProp('motionBlurStrength', 'Motion Blur Strength'),
        booleanProp('vignette', 'Vignette'),
        numberProp('vignetteDarkness', 'Vignette Darkness'),
        booleanProp('depthOfField', 'Depth of Field'),
        numberProp('focusDistance', 'Focus Distance (m)'),
        numberProp('bokehScale', 'Bokeh Scale'),
        numberProp('saturation', 'Saturation'),
        numberProp('contrast', 'Contrast'),
        numberProp('brightness', 'Brightness'),
        numberProp('temperature', 'Temperature'),
        numberProp('tint', 'Tint'),
        {
            key: 'look', label: 'Look', type: 'select', default: POST_PROCESS_DEFAULTS.look,
            options: [
                { label: 'None', value: 'none' },
                { label: 'Warm', value: 'warm' },
                { label: 'Cool', value: 'cool' },
                { label: 'Cinematic (teal and orange)', value: 'cinematic' },
                { label: 'Bleach bypass', value: 'bleach' },
                { label: 'Noir', value: 'noir' },
                { label: 'Vintage', value: 'vintage' },
                { label: 'Night', value: 'night' }
            ]
        },
        numberProp('lookStrength', 'Look Strength'),
        numberProp('filmGrain', 'Film Grain'),
        numberProp('chromaticAberration', 'Chromatic Aberration'),
        {
            key: 'antialias', label: 'Anti-aliasing', type: 'select', default: POST_PROCESS_DEFAULTS.antialias,
            options: [
                { label: 'Temporal', value: 'temporal' },
                { label: 'SMAA', value: 'smaa' },
                { label: 'None', value: 'none' }
            ]
        },
        numberProp('renderScale', 'Render Scale'),
        numberProp('sharpness', 'Sharpness')
    ],
    Render: PostProcessRender
};
