import React, { useEffect, useMemo, useState } from 'react';
import { Cloud, Moon, Pause, Play, Sparkles, Sun, SunDim, Wind } from 'lucide-react';
import type { SkyConfig } from '../../types';
import { ScrubbableInput } from '../UI/Properties/ScrubbableInput';
import { useGameContent } from '../../runtime/GameContentContext';
import { formatHours, worldClock } from '../../runtime/weather';
import { dayPreview } from './sky/dayPreview';
import {
    applySkyPreset, matchesSkyPreset, newSkyConfig, skyPreset, skyPresetSwatch, SKY_PRESET_GROUPS, SKY_PRESETS, type SkyPreset,
} from '../../runtime/sky/skyPresets';
import {
    CLOUD_QUALITIES, CLOUD_QUALITY_LABELS, DEFAULT_SKY_LIGHT, resolveAtmosphere, resolveClouds, resolveNight, resolveSkyImage, resolveSkyLight, SKY_MODEL_LABELS, SKY_MODELS, skyModel, sunSize, sunTilt,
    type CloudQuality, type SkyAtmosphereSettings, type SkyCloudSettings, type SkyImageSettings, type SkyLightSettings, type SkyModel, type SkyNightSettings,
} from '../../runtime/sky/skySettings';

interface SkyDomeSectionProps {
    config: SkyConfig;
    /** A change while dragging (scrub) or a finished one (commit). */
    onScrub: (config: SkyConfig) => void;
    onCommit: (config: SkyConfig) => void;
}

const SECTION_TITLE = 'text-[10px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5';
const PANEL = 'space-y-2 bg-gray-800 p-2 rounded border border-gray-700';
const SELECT = 'bg-gray-900 border border-gray-700 rounded text-[10px] text-white px-1 py-0.5';

const Row: React.FC<{ label: string; title?: string; children: React.ReactNode }> = ({ label, title, children }) => (
    <div className="flex items-center justify-between gap-2" title={title}>
        <span className="text-[10px] text-gray-400">{label}</span>
        {children}
    </div>
);

const Scrub: React.FC<{ label: string; title?: string; value: number; step: number; onChange: (value: number) => void }> = ({ label, title, value, step, onChange }) => (
    <Row label={label} title={title}>
        <div className="w-16">
            <ScrubbableInput label="" value={value} onChange={onChange} step={step} labelWidth="w-0" />
        </div>
    </Row>
);

const Colour: React.FC<{ label: string; title?: string; value: string; onChange: (value: string) => void }> = ({ label, title, value, onChange }) => (
    <Row label={label} title={title}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="w-6 h-4 bg-transparent border-none p-0 cursor-pointer" aria-label={label} />
    </Row>
);

const HOUR_JUMPS: readonly { label: string; hour: number }[] = [
    { label: 'Dawn', hour: 6.2 }, { label: 'Morning', hour: 9 }, { label: 'Noon', hour: 12 }, { label: 'Sunset', hour: 17.7 }, { label: 'Night', hour: 23 },
];
/** Hours the preview moves a second: a whole day in half a minute. */
const PREVIEW_SPEED = 0.8;

/** Jumps to a time of day, and plays the day through in the editor (saved only by the jumps). */
export const DayPreviewControls: React.FC<{ hour: number; onHour: (hours: number) => void }> = ({ hour, onHour }) => {
    const [playing, setPlaying] = useState(false);
    const [shown, setShown] = useState(hour);
    useEffect(() => {
        if (!playing) return undefined;
        dayPreview.speed = PREVIEW_SPEED;
        const timer = window.setInterval(() => setShown(worldClock.hours), 150);
        return () => {
            window.clearInterval(timer);
            dayPreview.speed = 0;
            // Back to the hour as set: the preview changes nothing.
            worldClock.setHours(hour);
        };
    }, [playing, hour]);
    return (
        <div className="mt-2 flex items-center gap-1">
            <button
                type="button"
                onClick={() => setPlaying(value => !value)}
                aria-label={playing ? 'Stop the day preview' : 'Play the day through'}
                title="Plays the day through in the viewport, to see the light change. It does not change the level."
                className="p-1 rounded bg-gray-900 border border-gray-700 text-cyan-300 hover:border-gray-500"
            >
                {playing ? <Pause size={10} /> : <Play size={10} />}
            </button>
            {playing && <span className="text-[9px] font-mono text-gray-300 w-8">{formatHours(shown)}</span>}
            <div className="flex-1 flex flex-wrap justify-end gap-1">
                {HOUR_JUMPS.map(jump => (
                    <button key={jump.label} type="button" onClick={() => onHour(jump.hour)} className="px-1 py-0.5 rounded text-[8px] bg-gray-900 border border-gray-700 text-gray-300 hover:border-gray-500">
                        {jump.label}
                    </button>
                ))}
            </div>
        </div>
    );
};

/** The preset gallery: a swatch of each sky, grouped, showing which this sky came from. */
const PresetGallery: React.FC<{ current: string | undefined; onPick: (preset: SkyPreset) => void }> = ({ current, onPick }) => {
    const swatches = useMemo(() => new Map(SKY_PRESETS.map(preset => [preset.id, skyPresetSwatch(preset)])), []);
    return (
        <div className="space-y-2">
            {SKY_PRESET_GROUPS.map(group => (
                <div key={group} className="space-y-1">
                    <div className="text-[9px] text-gray-500">{group}</div>
                    <div className="grid grid-cols-3 gap-1">
                        {SKY_PRESETS.filter(preset => preset.group === group).map(preset => (
                            <button
                                key={preset.id}
                                type="button"
                                onClick={() => onPick(preset)}
                                aria-pressed={current === preset.id}
                                title={preset.label}
                                className={`rounded overflow-hidden border text-left ${current === preset.id ? 'border-cyan-400' : 'border-gray-700 hover:border-gray-500'}`}
                            >
                                <div className="h-8" style={{ background: swatches.get(preset.id) }} />
                                <div className="px-1 py-0.5 text-[8px] text-gray-300 truncate bg-gray-900">{preset.label}</div>
                            </button>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
};

/**
 * The sky's look: what draws it, a gallery of ready-made skies, and each of the things they set (the sun's
 * path, the air, the clouds and the night), then the Sky Light it lights the level with.
 */
export const SkyDomeSection: React.FC<SkyDomeSectionProps> = ({ config, onScrub, onCommit }) => {
    const model = skyModel(config);
    const atmosphere = resolveAtmosphere(config.atmosphere);
    const clouds = resolveClouds(config.cloudLayer);
    const night = resolveNight(config.night);
    const skyLight = resolveSkyLight(config.skyLight);
    const panorama = resolveSkyImage(config.panorama);
    const { textures } = useGameContent();
    const preset = skyPreset(config.preset);

    const setAtmosphere = (change: Partial<SkyAtmosphereSettings>) => onScrub({ ...config, atmosphere: { ...atmosphere, ...change } });
    const setClouds = (change: Partial<SkyCloudSettings>) => onScrub({ ...config, cloudLayer: { ...clouds, ...change } });
    const setNight = (change: Partial<SkyNightSettings>) => onScrub({ ...config, night: { ...night, ...change } });
    const setSkyLight = (change: Partial<SkyLightSettings>) => onScrub({ ...config, skyLight: { ...skyLight, ...change } });
    const setPanorama = (change: Partial<SkyImageSettings>) => onScrub({ ...config, panorama: { ...panorama, ...change } });

    const setModel = (next: SkyModel) => {
        // The first time a sky leaves Classic it takes a whole new look: its old values were tuned for another model.
        if (next === 'atmosphere' && model === 'classic' && !config.atmosphere) {
            const fresh = newSkyConfig();
            onCommit({ ...config, ...fresh, shadowDistance: config.shadowDistance, dayLength: config.dayLength });
            return;
        }
        onCommit({ ...config, model: next, skyLight: next !== 'classic' && !config.skyLight ? { ...DEFAULT_SKY_LIGHT } : config.skyLight });
    };

    return (
        <>
            <div className="space-y-2">
                <div className={SECTION_TITLE}><SunDim size={12} /> Sky Model</div>
                <div className={PANEL}>
                    <Row label="Draws With">
                        <select aria-label="Sky model" className={SELECT} value={model} onChange={(e) => setModel(e.target.value as SkyModel)}>
                            {SKY_MODELS.map(option => <option key={option} value={option}>{SKY_MODEL_LABELS[option]}</option>)}
                        </select>
                    </Row>
                </div>
            </div>

            {model !== 'classic' && (
                <>
                    {model === 'image' && (
                        <div className="space-y-2">
                            <div className={SECTION_TITLE}><Sparkles size={12} /> Panorama</div>
                            <div className={PANEL}>
                                <Row label="Image" title="A panorama from your textures: 360 by 180 degrees, twice as wide as it is tall.">
                                    <select aria-label="Panorama image" className={`${SELECT} max-w-[140px]`} value={panorama.textureId} onChange={(e) => onCommit({ ...config, panorama: { ...panorama, textureId: e.target.value } })}>
                                        <option value="">None</option>
                                        {textures.map(texture => <option key={texture.id} value={texture.id}>{texture.name}</option>)}
                                    </select>
                                </Row>
                                <Scrub label="Rotation °" value={panorama.rotation} step={1} onChange={(v) => setPanorama({ rotation: v })} />
                                <Scrub label="Brightness" value={panorama.brightness} step={0.05} onChange={(v) => setPanorama({ brightness: Math.max(0, v) })} />
                            </div>
                        </div>
                    )}

                    {model === 'atmosphere' && (
                        <div className="space-y-2">
                            <div className={SECTION_TITLE}><Sparkles size={12} /> Sky Presets</div>
                            <PresetGallery current={config.preset} onPick={(next) => onCommit(applySkyPreset(config, next))} />
                            {preset && !matchesSkyPreset(config) && (
                                <div className="text-[9px] text-gray-500">Changed from {preset.label}.</div>
                            )}
                        </div>
                    )}

                    <div className="space-y-2">
                        <div className={SECTION_TITLE}><Sun size={12} /> Sun Path</div>
                        <div className={PANEL}>
                            <Scrub label="Compass Turn" title="Turns the sun's whole path round the horizon (0-1: a full turn)." value={config.azimuth} step={0.01} onChange={(v) => onScrub({ ...config, azimuth: v })} />
                            <Scrub label="Lean °" title="How far the sun's path leans from passing straight overhead. Away from the tropics it never quite reaches the top of the sky." value={sunTilt(config)} step={1} onChange={(v) => onScrub({ ...config, sunTilt: Math.min(80, Math.max(-80, v)) })} />
                            <Scrub label="Sun Size" title="1: as the sun really looks." value={sunSize(config)} step={0.1} onChange={(v) => onScrub({ ...config, sunSize: Math.min(12, Math.max(0.1, v)) })} />
                            <Colour label="Sun Colour" title="The sun's own colour, before the air. Also tints the sky it lights." value={config.sunColor} onChange={(v) => onScrub({ ...config, sunColor: v })} />
                        </div>
                    </div>

                    {model === 'atmosphere' && (
                        <>
                            <div className="space-y-2">
                                <div className={SECTION_TITLE}><Wind size={12} /> Atmosphere</div>
                                <div className={PANEL}>
                                    <Scrub label="Air" title="How much the air scatters light. 1 is Earth's. More is a deeper sky and a redder sunset." value={atmosphere.rayleigh} step={0.05} onChange={(v) => setAtmosphere({ rayleigh: Math.max(0, v) })} />
                                    <Colour label="Air Colour" title="What the air scatters. White gives Earth's blue; a tint shifts the whole sky." value={atmosphere.rayleighTint} onChange={(v) => setAtmosphere({ rayleighTint: v })} />
                                    <Scrub label="Haze" title="Dust and droplets in the air. More is a paler sky with a wider glow round the sun." value={atmosphere.haze} step={0.1} onChange={(v) => setAtmosphere({ haze: Math.max(0, v) })} />
                                    <Scrub label="Sun Glow" title="How tightly the haze glows round the sun (0-0.98)." value={atmosphere.hazeGlow} step={0.01} onChange={(v) => setAtmosphere({ hazeGlow: Math.min(0.98, Math.max(0, v)) })} />
                                    <Scrub label="Ozone" title="Keeps the sky blue at dusk. 1 is Earth's." value={atmosphere.ozone} step={0.05} onChange={(v) => setAtmosphere({ ozone: Math.max(0, v) })} />
                                    <Colour label="Ground" title="The ground beyond the level, seen below the horizon. It lights the sky a little too." value={atmosphere.ground} onChange={(v) => setAtmosphere({ ground: v })} />
                                    <Scrub label="Brightness" title="The sky's brightness, without changing its colour or the sun's strength." value={atmosphere.brightness} step={0.05} onChange={(v) => setAtmosphere({ brightness: Math.max(0, v) })} />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <div className={SECTION_TITLE}><Cloud size={12} /> Clouds</div>
                                <div className={PANEL}>
                                    <Row label="Quality" title="Volumetric clouds cost GPU time every frame; a higher quality is sharper. How much of the sky they cover is the weather's Clouds value.">
                                        <select aria-label="Cloud quality" className={SELECT} value={clouds.quality} onChange={(e) => onCommit({ ...config, cloudLayer: { ...clouds, quality: e.target.value as CloudQuality } })}>
                                            {CLOUD_QUALITIES.map(option => <option key={option} value={option}>{CLOUD_QUALITY_LABELS[option]}</option>)}
                                        </select>
                                    </Row>
                                    <Scrub label="Base Height" title="Height of the cloud base, metres." value={clouds.altitude} step={50} onChange={(v) => setClouds({ altitude: Math.min(12000, Math.max(200, v)) })} />
                                    <Scrub label="Depth" title="How deep the cloud layer is, metres. Deep layers grow towering clouds." value={clouds.thickness} step={50} onChange={(v) => setClouds({ thickness: Math.min(8000, Math.max(100, v)) })} />
                                    <Scrub label="Density" value={clouds.density} step={0.05} onChange={(v) => setClouds({ density: Math.min(4, Math.max(0.05, v)) })} />
                                    <Scrub label="Detail" title="How much fine detail eats at their edges (0-1)." value={clouds.detail} step={0.01} onChange={(v) => setClouds({ detail: Math.min(1, Math.max(0, v)) })} />
                                    <Scrub label="Cloud Size" value={clouds.scale} step={0.05} onChange={(v) => setClouds({ scale: Math.min(5, Math.max(0.2, v)) })} />
                                    <Scrub label="Ground Shadows" title="How much clouds shade the ground from the sun as they pass (0-1)." value={clouds.shadows} step={0.01} onChange={(v) => setClouds({ shadows: Math.min(1, Math.max(0, v)) })} />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <div className={SECTION_TITLE}><Moon size={12} /> Night</div>
                                <div className={PANEL}>
                                    <Scrub label="Moon Phase" title="0 and 1: new moon. 0.5: full moon." value={night.moonPhase} step={0.01} onChange={(v) => setNight({ moonPhase: Math.min(1, Math.max(0, v)) })} />
                                    <Scrub label="Moon Size" title="1: as the moon really looks." value={night.moonSize} step={0.1} onChange={(v) => setNight({ moonSize: Math.min(12, Math.max(0.2, v)) })} />
                                    <Scrub label="Moonlight" title="The moon's light, as a share of the Sun Intensity. The moon casts shadows." value={night.moonBrightness} step={0.01} onChange={(v) => setNight({ moonBrightness: Math.min(1, Math.max(0, v)) })} />
                                    <Scrub label="Stars" value={night.stars} step={0.05} onChange={(v) => setNight({ stars: Math.min(4, Math.max(0, v)) })} />
                                    <Scrub label="Milky Way" value={night.milkyWay} step={0.05} onChange={(v) => setNight({ milkyWay: Math.min(4, Math.max(0, v)) })} />
                                    <Colour label="Night Air" title="The night air's own faint glow, which keeps a moonless night from going pure black." value={night.glow} onChange={(v) => setNight({ glow: v })} />
                                </div>
                            </div>
                        </>
                    )}

                    <div className="space-y-2">
                        <div className={SECTION_TITLE}><SunDim size={12} /> Sky Light</div>
                        <div className={PANEL}>
                            <label className="flex items-center justify-between text-[10px] text-gray-400" title="Lights the level from the sky as it looks now: its colour, clouds and time of day. Off leaves a flat fill.">
                                <span>Light From Sky</span>
                                <input type="checkbox" aria-label="Light from sky" checked={skyLight.enabled} onChange={(e) => onCommit({ ...config, skyLight: { ...skyLight, enabled: e.target.checked } })} />
                            </label>
                            {skyLight.enabled && (
                                <>
                                    <Row label="Source" title="What it lights the level with: this sky, or the panorama image.">
                                        <select aria-label="Sky light source" className={SELECT} value={skyLight.source} onChange={(e) => onCommit({ ...config, skyLight: { ...skyLight, source: e.target.value as SkyLightSettings['source'] } })}>
                                            <option value="sky">This Sky</option>
                                            <option value="image">Panorama Image</option>
                                        </select>
                                    </Row>
                                    {skyLight.source === 'image' && model !== 'image' && (
                                        <Row label="Image">
                                            <select aria-label="Sky light image" className={`${SELECT} max-w-[140px]`} value={panorama.textureId} onChange={(e) => onCommit({ ...config, panorama: { ...panorama, textureId: e.target.value } })}>
                                                <option value="">None</option>
                                                {textures.map(texture => <option key={texture.id} value={texture.id}>{texture.name}</option>)}
                                            </select>
                                        </Row>
                                    )}
                                    <Row label="Capture" title="Live follows the sky as it changes. Once captures it when it is set, and costs nothing after.">
                                        <select aria-label="Sky light capture" className={SELECT} value={skyLight.capture} onChange={(e) => onCommit({ ...config, skyLight: { ...skyLight, capture: e.target.value as SkyLightSettings['capture'] } })}>
                                            <option value="live">Live</option>
                                            <option value="once">Once</option>
                                        </select>
                                    </Row>
                                    <Row label="Resolution" title="Size of the captured map: higher gives sharper reflections on shiny surfaces.">
                                        <select aria-label="Sky light resolution" className={SELECT} value={skyLight.resolution} onChange={(e) => onCommit({ ...config, skyLight: { ...skyLight, resolution: Number(e.target.value) } })}>
                                            {[64, 128, 256].map(size => <option key={size} value={size}>{size}</option>)}
                                        </select>
                                    </Row>
                                    <Scrub label="Intensity" value={skyLight.intensity} step={0.05} onChange={(v) => setSkyLight({ intensity: Math.max(0, v) })} />
                                    <Colour label="Tint" value={skyLight.tint} onChange={(v) => setSkyLight({ tint: v })} />
                                    <Scrub label="Reflections" title="How much of it shows in reflections." value={skyLight.reflections} step={0.05} onChange={(v) => setSkyLight({ reflections: Math.max(0, v) })} />
                                    <label className="flex items-center justify-between text-[10px] text-gray-400" title="Light from below the horizon comes from this colour, in place of the sky's ground.">
                                        <span>Solid Lower Half</span>
                                        <input type="checkbox" aria-label="Solid lower half" checked={skyLight.lowerSolid} onChange={(e) => onCommit({ ...config, skyLight: { ...skyLight, lowerSolid: e.target.checked } })} />
                                    </label>
                                    {skyLight.lowerSolid && <Colour label="Lower Colour" value={skyLight.lowerColor} onChange={(v) => setSkyLight({ lowerColor: v })} />}
                                    <div className="h-px bg-gray-700 my-1" />
                                    <Scrub label="Occlusion" title="How far what stands overhead shuts out the sky, so a room under a roof goes dark and a forest floor falls into shade (0-1). 0 turns it off." value={skyLight.occlusion} step={0.01} onChange={(v) => setSkyLight({ occlusion: Math.min(1, Math.max(0, v)) })} />
                                    <Scrub label="Min Light" title="The least sky a covered place keeps (0-1)." value={skyLight.occlusionFloor} step={0.01} onChange={(v) => setSkyLight({ occlusionFloor: Math.min(1, Math.max(0, v)) })} />
                                    <Scrub label="Reach" title="Half the side of the area round the camera occlusion covers, metres. A larger area is coarser." value={skyLight.occlusionRange} step={8} onChange={(v) => setSkyLight({ occlusionRange: Math.min(1024, Math.max(16, Math.round(v))) })} />
                                </>
                            )}
                        </div>
                    </div>
                </>
            )}
        </>
    );
};
