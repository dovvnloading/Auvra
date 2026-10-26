import React, { useEffect, useMemo, useState } from 'react';
import { RotateCcw, Save, SlidersHorizontal, X } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import { useNativeProjectDocument } from '../../utils/useNativeProjectDocument';
import {
  DEFAULT_GAME_SETTINGS,
  GAME_SETTINGS_DOCUMENT_ID,
  GameSettings,
  normalizeGameSettings,
} from '../../runtime/types';

interface GameSettingsDocument {
  id: string;
  settings: GameSettings;
}

interface GameSettingsPanelProps { onClose: () => void; }

// Module scoped so the document hook sees a stable factory and does not re-hydrate every render.
const createDefaultGameSettingsDocument = (): GameSettingsDocument => ({
  id: GAME_SETTINGS_DOCUMENT_ID,
  settings: normalizeGameSettings(DEFAULT_GAME_SETTINGS),
});

const clamp = (value: number, min: number, max: number, fallback: number) => (
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
);

const LIMITS = {
  maxDpr: { min: 0.5, max: 4, step: 0.25 },
  fov: { min: 30, max: 120, step: 1 },
  mouseSensitivity: { min: 0.0001, max: 0.02, step: 0.0001 },
  masterVolume: { min: 0, max: 1, step: 0.05 },
} as const;

/** Clamps numeric fields and trims the name so the stored document is always runtime-safe. */
const sanitizeGameSettings = (value: GameSettings): GameSettings => {
  const settings = normalizeGameSettings(value);
  const defaults = DEFAULT_GAME_SETTINGS;
  return {
    ...settings,
    name: settings.name.trim() || defaults.name,
    startupLevelId: settings.startupLevelId || null,
    playerBlueprintId: settings.playerBlueprintId || null,
    window: { fullscreen: Boolean(settings.window.fullscreen) },
    quality: {
      shadows: Boolean(settings.quality.shadows),
      postProcessing: Boolean(settings.quality.postProcessing),
      maxDpr: clamp(settings.quality.maxDpr, LIMITS.maxDpr.min, LIMITS.maxDpr.max, defaults.quality.maxDpr),
      fov: clamp(settings.quality.fov, LIMITS.fov.min, LIMITS.fov.max, defaults.quality.fov),
    },
    input: {
      mouseSensitivity: clamp(settings.input.mouseSensitivity, LIMITS.mouseSensitivity.min, LIMITS.mouseSensitivity.max, defaults.input.mouseSensitivity),
      invertY: Boolean(settings.input.invertY),
    },
    audio: {
      masterVolume: clamp(settings.audio.masterVolume, LIMITS.masterVolume.min, LIMITS.masterVolume.max, defaults.audio.masterVolume),
    },
  };
};

const sectionClass = 'rounded-lg border border-gray-800 bg-gray-950/60 p-3 space-y-3';
const sectionTitleClass = 'text-[10px] font-bold uppercase tracking-wider text-gray-500';
const inputClass = 'w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-xs text-white disabled:opacity-50';

const Toggle: React.FC<{ label: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }> = ({ label, checked, disabled, onChange }) => (
  <label className="flex items-center justify-between gap-3 text-xs text-gray-300">
    <span>{label}</span>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
  </label>
);

const NumberField: React.FC<{ label: string; value: number; limits: { min: number; max: number; step: number }; disabled: boolean; onChange: (value: number) => void }> = ({ label, value, limits, disabled, onChange }) => (
  <label className="block text-[9px] uppercase text-gray-500">
    {label}
    <input
      type="number"
      min={limits.min}
      max={limits.max}
      step={limits.step}
      value={value}
      disabled={disabled}
      onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next)) onChange(next); }}
      className={`mt-1 ${inputClass}`}
    />
  </label>
);

export const GameSettingsPanel: React.FC<GameSettingsPanelProps> = ({ onClose }) => {
  const { levels, blueprints, projectStatus } = useScene();
  const { document, hydrated, error, replace } = useNativeProjectDocument<GameSettingsDocument>(
    'metadata', GAME_SETTINGS_DOCUMENT_ID, createDefaultGameSettingsDocument,
  );
  const stored = useMemo(() => normalizeGameSettings(document.settings), [document]);
  const [draft, setDraft] = useState<GameSettings>(stored);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // A hydrate, project switch or successful save replaces the draft with the stored document.
  useEffect(() => { setDraft(stored); }, [stored]);

  const playerBlueprints = useMemo(() => blueprints.filter((blueprint) => blueprint.type === 'Player Character'), [blueprints]);
  const missingLevel = draft.startupLevelId !== null && !levels.some((level) => level.id === draft.startupLevelId);
  const missingBlueprint = draft.playerBlueprintId !== null && !playerBlueprints.some((blueprint) => blueprint.id === draft.playerBlueprintId);
  const dirty = JSON.stringify(sanitizeGameSettings(draft)) !== JSON.stringify(sanitizeGameSettings(stored));
  const writable = Boolean(projectStatus.projectId) && !projectStatus.readOnly;
  const disabled = !hydrated || saving;

  const update = (patch: (current: GameSettings) => GameSettings) => {
    setMessage(null);
    setDraft((current) => patch(current));
  };

  const save = async () => {
    setSaving(true); setMessage(null);
    try {
      await replace({ ...document, id: GAME_SETTINGS_DOCUMENT_ID, settings: sanitizeGameSettings(draft) });
      setMessage('Game settings saved to the project.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Game settings could not be saved.');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-label="Game settings">
      <div className="flex w-full max-w-xl max-h-[90vh] flex-col overflow-hidden rounded-xl border border-gray-700 bg-gray-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-800 bg-gray-950 px-5 py-4">
          <div className="flex items-center gap-3"><SlidersHorizontal size={18} className="text-blue-400" /><div><h2 className="text-sm font-bold text-white">Game Settings</h2><p className="text-[10px] text-gray-500">Stored in the project · used by Play and Build Game</p></div></div>
          <button type="button" onClick={onClose} className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-white" aria-label="Close game settings"><X size={16} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5 space-y-4">
          {!hydrated && <div className="text-xs text-gray-500">Loading game settings…</div>}
          {!projectStatus.projectId && <div className="rounded border border-amber-900 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-300">Open or create a project to save game settings.</div>}
          {projectStatus.readOnly && <div className="rounded border border-amber-900 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-300">This project is read-only.</div>}

          <div className={sectionClass}>
            <div className={sectionTitleClass}>Game</div>
            <label className="block text-[9px] uppercase text-gray-500">Name
              <input type="text" value={draft.name} disabled={disabled} onChange={(event) => { const name = event.target.value; update((current) => ({ ...current, name })); }} className={`mt-1 ${inputClass}`} />
            </label>
            <label className="block text-[9px] uppercase text-gray-500">Startup level
              <select aria-label="Startup level" value={draft.startupLevelId ?? ''} disabled={disabled} onChange={(event) => { const startupLevelId = event.target.value || null; update((current) => ({ ...current, startupLevelId })); }} className={`mt-1 ${inputClass}`}>
                <option value="">First level</option>
                {levels.map((level) => <option key={level.id} value={level.id}>{level.name}</option>)}
                {missingLevel && <option value={draft.startupLevelId ?? ''}>Missing level ({draft.startupLevelId})</option>}
              </select>
            </label>
            <label className="block text-[9px] uppercase text-gray-500">Player blueprint
              <select aria-label="Player blueprint" value={draft.playerBlueprintId ?? ''} disabled={disabled} onChange={(event) => { const playerBlueprintId = event.target.value || null; update((current) => ({ ...current, playerBlueprintId })); }} className={`mt-1 ${inputClass}`}>
                <option value="">First Player Character</option>
                {playerBlueprints.map((blueprint) => <option key={blueprint.id} value={blueprint.id}>{blueprint.name}</option>)}
                {missingBlueprint && <option value={draft.playerBlueprintId ?? ''}>Missing blueprint ({draft.playerBlueprintId})</option>}
              </select>
            </label>
            {playerBlueprints.length === 0 && <p className="text-[10px] text-amber-400">No Player Character blueprint exists yet.</p>}
          </div>

          <div className={sectionClass}>
            <div className={sectionTitleClass}>Window & quality</div>
            <Toggle label="Fullscreen" checked={draft.window.fullscreen} disabled={disabled} onChange={(fullscreen) => update((current) => ({ ...current, window: { ...current.window, fullscreen } }))} />
            <Toggle label="Shadows" checked={draft.quality.shadows} disabled={disabled} onChange={(shadows) => update((current) => ({ ...current, quality: { ...current.quality, shadows } }))} />
            <Toggle label="Post-processing" checked={draft.quality.postProcessing} disabled={disabled} onChange={(postProcessing) => update((current) => ({ ...current, quality: { ...current.quality, postProcessing } }))} />
            <div className="grid grid-cols-2 gap-2">
              <NumberField label="Max pixel ratio" value={draft.quality.maxDpr} limits={LIMITS.maxDpr} disabled={disabled} onChange={(maxDpr) => update((current) => ({ ...current, quality: { ...current.quality, maxDpr } }))} />
              <NumberField label="Field of view" value={draft.quality.fov} limits={LIMITS.fov} disabled={disabled} onChange={(fov) => update((current) => ({ ...current, quality: { ...current.quality, fov } }))} />
            </div>
          </div>

          <div className={sectionClass}>
            <div className={sectionTitleClass}>Input & audio</div>
            <NumberField label="Mouse sensitivity" value={draft.input.mouseSensitivity} limits={LIMITS.mouseSensitivity} disabled={disabled} onChange={(mouseSensitivity) => update((current) => ({ ...current, input: { ...current.input, mouseSensitivity } }))} />
            <Toggle label="Invert Y" checked={draft.input.invertY} disabled={disabled} onChange={(invertY) => update((current) => ({ ...current, input: { ...current.input, invertY } }))} />
            <label className="block text-[9px] uppercase text-gray-500">Master volume · {Math.round(draft.audio.masterVolume * 100)}%
              <input type="range" aria-label="Master volume" min={LIMITS.masterVolume.min} max={LIMITS.masterVolume.max} step={LIMITS.masterVolume.step} value={draft.audio.masterVolume} disabled={disabled} onChange={(event) => { const masterVolume = Number(event.target.value); update((current) => ({ ...current, audio: { ...current.audio, masterVolume } })); }} className="mt-1 w-full" />
            </label>
          </div>

          {(message || error) && <div className="rounded border border-gray-700 bg-gray-950 p-3 text-xs text-gray-300">{message || error?.message}</div>}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-gray-800 bg-gray-950 px-5 py-3">
          <button type="button" disabled={disabled || !dirty} onClick={() => { setMessage(null); setDraft(stored); }} className="flex items-center gap-2 rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50"><RotateCcw size={13} /> Revert</button>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-white">Close</button>
            <button type="button" disabled={disabled || !dirty || !writable} onClick={() => void save()} className="flex items-center gap-2 rounded bg-blue-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-blue-500 disabled:opacity-50" title={writable ? 'Save game settings' : 'Open a writable project to save'}><Save size={13} /> {saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
};
