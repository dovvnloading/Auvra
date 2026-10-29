import React from 'react';
import { CloudRain, Clock } from 'lucide-react';
import type { SkyConfig } from '../../types';
import { ScrubbableInput } from '../UI/Properties/ScrubbableInput';
import {
    isWeatherKind, matchesPreset, sanitizeWeather, weatherFromPreset,
    WEATHER_KINDS, WEATHER_LABELS, type WeatherSettings, type WeatherState,
} from '../../runtime/weather';

interface SkyWeatherSectionProps {
    config: SkyConfig;
    /** A change while dragging (scrub) or a finished one (commit). */
    onScrub: (config: SkyConfig) => void;
    onCommit: (config: SkyConfig) => void;
}

const SLIDERS: { field: keyof WeatherState; label: string; step: number }[] = [
    { field: 'clouds', label: 'Clouds', step: 0.01 },
    { field: 'rain', label: 'Rain', step: 0.01 },
    { field: 'snow', label: 'Snow', step: 0.01 },
    { field: 'fog', label: 'Mist', step: 0.01 },
    { field: 'wind', label: 'Wind m/s', step: 0.1 },
    { field: 'windDirection', label: 'Wind dir °', step: 1 },
    { field: 'lightning', label: 'Strikes/min', step: 0.1 },
];

/**
 * The sky's day-night cycle and weather: how long a day lasts in play, whether fog follows the
 * sky's colour, and the weather the level starts in (a preset, then each value).
 */
export const SkyWeatherSection: React.FC<SkyWeatherSectionProps> = ({ config, onScrub, onCommit }) => {
    const weather = sanitizeWeather(config.weather);
    const dayLength = config.dayLength ?? 0;
    const setWeather = (next: WeatherSettings | null, commit: boolean) => {
        const updated: SkyConfig = { ...config };
        if (next) updated.weather = next;
        else delete updated.weather;
        (commit ? onCommit : onScrub)(updated);
    };

    return (
        <>
            <div className="space-y-2">
                <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                    <Clock size={12} /> Day-Night Cycle
                </div>
                <div className="space-y-2 bg-gray-800 p-2 rounded border border-gray-700">
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] text-gray-400">Day Length (min)</span>
                        <div className="w-16">
                            <ScrubbableInput
                                label=""
                                value={dayLength}
                                onChange={(v) => onScrub({ ...config, dayLength: Math.max(0, v) })}
                                step={1}
                                labelWidth="w-0"
                            />
                        </div>
                    </div>
                    <div className="text-[9px] text-gray-500">
                        {dayLength > 0
                            ? `In play a full day takes ${dayLength} min, starting at the Time of Day.`
                            : 'Time stands still at the Time of Day.'}
                    </div>
                    <label className="flex items-center justify-between text-[10px] text-gray-400">
                        <span>Fog Follows Sky</span>
                        <input
                            type="checkbox"
                            aria-label="Fog follows sky"
                            checked={(config.fogMode ?? 'custom') === 'sky'}
                            onChange={(e) => onCommit({ ...config, fogMode: e.target.checked ? 'sky' : 'custom' })}
                        />
                    </label>
                </div>
            </div>

            <div className="space-y-2">
                <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                    <CloudRain size={12} /> Weather
                </div>
                <div className="space-y-2 bg-gray-800 p-2 rounded border border-gray-700">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] text-gray-400">Preset</span>
                        <select
                            aria-label="Weather preset"
                            className="bg-gray-900 border border-gray-700 rounded text-[10px] text-white px-1 py-0.5"
                            value={weather?.preset ?? 'none'}
                            onChange={(e) => setWeather(isWeatherKind(e.target.value) ? weatherFromPreset(e.target.value) : null, true)}
                        >
                            <option value="none">None</option>
                            {WEATHER_KINDS.map(kind => <option key={kind} value={kind}>{WEATHER_LABELS[kind]}</option>)}
                        </select>
                    </div>
                    {weather && !matchesPreset(weather) && (
                        <div className="text-[9px] text-gray-500">Customized from {WEATHER_LABELS[weather.preset]}.</div>
                    )}
                    {weather && (
                        <div className="grid grid-cols-2 gap-2">
                            {SLIDERS.map(({ field, label, step }) => (
                                <ScrubbableInput
                                    key={field}
                                    label={label}
                                    value={weather[field]}
                                    onChange={(v) => setWeather(sanitizeWeather({ ...weather, [field]: v }), false)}
                                    step={step}
                                    labelWidth="w-16"
                                />
                            ))}
                        </div>
                    )}
                    <div className="text-[9px] text-gray-500">
                        Level scripts change the weather and the hour in play: Set Weather, Set Time of Day.
                    </div>
                </div>
            </div>
        </>
    );
};
