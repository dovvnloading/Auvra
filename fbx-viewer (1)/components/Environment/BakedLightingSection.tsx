import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Loader2, Sun, X } from 'lucide-react';
import { useLevel } from '../../context/LevelContext';
import { editorSession } from '../../utils/editorSession';
import { projectService } from '../../utils/projectService';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { ScrubbableInput } from '../UI/Properties/ScrubbableInput';
import {
    BAKED_LIGHTING_LIMITS,
    bakeSignature,
    encodeLightVolume,
    LIGHT_VOLUME_ENCODING,
    LIGHT_VOLUME_FILE_NAME,
    LIGHT_VOLUME_MIME,
    readBakedProbeVolume,
    resolveBakedLightingSettings,
    type BakedLightingSettings,
    type LevelBakedLighting,
} from '../../runtime/lighting/bakedLighting';
import { lightBakeJobs, LightBakeCancelled } from '../../runtime/lighting/lightBakeJobs';
import { rememberLightVolume } from '../../runtime/lighting/lightVolumeLoader';

/** Settings edits are saved once they stop changing for this long. */
const SAVE_DELAY_MS = 400;

const SETTING_FIELDS: Array<{ key: keyof BakedLightingSettings; label: string; title: string }> = [
    { key: 'spacing', label: 'Gap', title: 'World units between light probes; closer probes catch smaller rooms and shadows but take longer to bake' },
    { key: 'bounces', label: 'Bnc', title: 'Times light bounces; more lets light reach further into enclosed spaces' },
    { key: 'intensity', label: 'Int', title: 'Strength of the baked light; changes show without baking again' },
];

const clampSetting = (key: keyof BakedLightingSettings, value: number): number => {
    const { min, max, step } = BAKED_LIGHTING_LIMITS[key];
    const clamped = Math.min(max, Math.max(min, value));
    return key === 'bounces' ? Math.round(clamped) : Math.round(clamped / step) * step;
};

const describeAge = (iso: string): string => {
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return '';
    const minutes = Math.round((Date.now() - time) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours} h ago` : new Date(time).toLocaleDateString();
};

/**
 * The open level's baked lighting: bake settings, Bake and Clear, and whether the bake still
 * matches the level. The bake itself runs in the level viewport (LightBakeRunner).
 */
export const BakedLightingSection: React.FC<{ levelId: string | null }> = ({ levelId }) => {
    const { levels, currentLevelId, levelObjects, updateLevelBakedLighting } = useLevel();
    const session = useSyncExternalStore(editorSession.subscribe, editorSession.getSnapshot, editorSession.getSnapshot);
    const bake = useSyncExternalStore(lightBakeJobs.subscribe, lightBakeJobs.getSnapshot, lightBakeJobs.getSnapshot);
    const level = levels.find(item => item.id === levelId);
    const stored = level?.bakedLighting;
    const [draft, setDraft] = useState<LevelBakedLighting | undefined>(stored);
    const [error, setError] = useState<string | null>(null);
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Follow the stored record (another level, a finished bake) unless an edit is waiting to be saved.
    useEffect(() => {
        if (!saveTimer.current) setDraft(stored);
    }, [stored]);
    useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

    const isOpenLevel = Boolean(levelId) && levelId === currentLevelId && session.phase === 'ready' && session.levelId === levelId;
    const writable = isOpenLevel && !projectService.getStatus().readOnly;
    const settings = resolveBakedLightingSettings(draft);
    const probes = readBakedProbeVolume(stored?.probes);
    const baking = bake.levelId !== null;
    const bakingThis = baking && bake.levelId === levelId;
    const { spacing, bounces } = settings;
    const signature = useMemo(() => bakeSignature(levelObjects, { spacing, bounces, intensity: 1 }), [levelObjects, spacing, bounces]);
    const outOfDate = Boolean(probes && probes.signature !== signature);

    const save = (next: LevelBakedLighting | null) => {
        if (!levelId) return;
        updateLevelBakedLighting(levelId, next).catch((failure: unknown) => {
            frontendDiagnostics.failure('baked_lighting_save_failed', failure);
            setError('The baked lighting could not be saved.');
        });
    };

    const editSetting = (key: keyof BakedLightingSettings, value: number) => {
        if (!writable || !Number.isFinite(value)) return;
        const next = { ...draft, [key]: clampSetting(key, value) };
        setDraft(next);
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
            saveTimer.current = null;
            save({ ...level?.bakedLighting, ...next });
        }, SAVE_DELAY_MS);
    };

    const runBake = async () => {
        if (!writable || !levelId || baking) return;
        if (saveTimer.current) {
            clearTimeout(saveTimer.current);
            saveTimer.current = null;
        }
        setError(null);
        const objects = levelObjects;
        try {
            const result = await lightBakeJobs.start({ levelId, levelObjects: objects, settings });
            const bytes = encodeLightVolume(result.sh, result.grid.counts);
            const assetId = await projectService.uploadAsset(new File([bytes], LIGHT_VOLUME_FILE_NAME, { type: LIGHT_VOLUME_MIME }));
            rememberLightVolume(assetId, result.sh);
            await updateLevelBakedLighting(levelId, {
                ...settings,
                probes: {
                    assetId,
                    encoding: LIGHT_VOLUME_ENCODING,
                    origin: [result.grid.origin.x, result.grid.origin.y, result.grid.origin.z],
                    spacing: result.grid.spacing,
                    counts: result.grid.counts,
                    bakedAt: new Date().toISOString(),
                    signature: bakeSignature(objects, settings),
                },
            });
        } catch (failure) {
            if (failure instanceof LightBakeCancelled) return;
            frontendDiagnostics.failure('light_bake_failed', failure);
            setError(failure instanceof Error && failure.message ? failure.message : 'The light bake failed.');
        }
    };

    const clear = () => {
        if (!writable || !stored?.probes) return;
        const { probes: _probes, ...rest } = stored;
        save(rest);
    };

    const fraction = Math.round(bake.progress.fraction * 100);
    const stage = bake.progress.bounce === 0
        ? 'Finding probes inside geometry'
        : `Bounce ${bake.progress.bounce} of ${settings.bounces}`;

    return (
        <div className="shrink-0 border-t border-gray-800 bg-gray-950 p-3 space-y-2">
            <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-gray-300 flex items-center gap-2">
                    <Sun size={14} className="text-amber-400" /> Baked Lighting
                </span>
                {probes && !bakingThis && (
                    <span className={`text-2xs ${outOfDate ? 'text-amber-400' : 'text-gray-500'}`} title={probes.bakedAt}>
                        {outOfDate ? 'Out of date' : `Baked ${describeAge(probes.bakedAt)}`}
                    </span>
                )}
            </div>
            <div className="grid grid-cols-3 gap-1">
                {SETTING_FIELDS.map(field => (
                    <div key={field.key} title={field.title}>
                        <ScrubbableInput
                            label={field.label}
                            labelWidth="w-7"
                            value={settings[field.key]}
                            step={BAKED_LIGHTING_LIMITS[field.key].step}
                            onChange={(value) => editSetting(field.key, value)}
                        />
                    </div>
                ))}
            </div>
            {bakingThis ? (
                <div className="space-y-1">
                    <div className="flex items-center justify-between text-2xs text-gray-400">
                        <span className="flex items-center gap-1"><Loader2 size={10} className="animate-spin" /> {stage}</span>
                        <span>{fraction}%</span>
                    </div>
                    <div className="h-1.5 rounded bg-gray-800 overflow-hidden">
                        <div className="h-full bg-amber-500 transition-[width]" style={{ width: `${fraction}%` }} />
                    </div>
                    <button
                        onClick={() => lightBakeJobs.cancel()}
                        className="w-full flex items-center justify-center gap-1 py-1 rounded text-2xs text-gray-300 bg-gray-800 hover:bg-gray-700"
                        aria-label="Cancel light bake"
                    >
                        <X size={11} /> Cancel
                    </button>
                </div>
            ) : (
                <div className="flex gap-1">
                    <button
                        onClick={() => void runBake()}
                        disabled={!writable || baking}
                        className="flex-1 py-1 rounded text-2xs font-bold text-white bg-amber-600 hover:bg-amber-500 disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed"
                        title={writable ? 'Bake the light of the level\'s static geometry, lights and sky into light probes' : 'Open this level to bake its lighting'}
                        aria-label="Bake lighting"
                    >
                        {probes ? 'Bake again' : 'Bake'}
                    </button>
                    {probes && (
                        <button
                            onClick={clear}
                            disabled={!writable || baking}
                            className="px-2 py-1 rounded text-2xs text-gray-300 bg-gray-800 hover:bg-gray-700 disabled:text-gray-600 disabled:cursor-not-allowed"
                            title="Remove the baked light; the level is lit by its sky fill alone"
                            aria-label="Clear baked lighting"
                        >
                            Clear
                        </button>
                    )}
                </div>
            )}
            {probes && !bakingThis && (
                <p className="text-2xs text-gray-500">
                    {(probes.counts[0] * probes.counts[1] * probes.counts[2]).toLocaleString()} probes, {probes.spacing.toFixed(2)} apart
                    {probes.spacing > settings.spacing + 1e-6 && ' (widened to stay within the probe limit)'}
                </p>
            )}
            {error && <p className="text-2xs text-red-400">{error}</p>}
        </div>
    );
};
