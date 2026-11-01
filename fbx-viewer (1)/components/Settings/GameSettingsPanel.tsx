import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Hammer, RotateCcw, Save, SlidersHorizontal, X } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import { projectService } from '../../utils/projectService';
import { useNativeProjectDocument } from '../../utils/useNativeProjectDocument';
import {
  DEFAULT_GAME_SETTINGS,
  GAME_SETTINGS_DOCUMENT_ID,
  GameSettings,
  normalizeGameSettings,
} from '../../runtime/types';
import { normalizeNetworkSettings } from '../../runtime/net/protocol';
import { NAV_SETTING_LIMITS, resolveNavSettings } from '../../runtime/navSettings';
import { MAX_RENDER_SCALE, MIN_RENDER_SCALE } from '../../runtime/temporal/temporalSettings';

interface GameSettingsDocument {
  id: string;
  settings: GameSettings;
}

interface GameSettingsPanelProps { onClose: () => void; }

/** Build Game targets in picker order; each is a `target` the host's project.buildGame accepts. */
export const GAME_BUILD_TARGETS = ['web', 'windows', 'linux', 'macos'] as const;

/** A platform Build Game can produce. */
export type GameBuildTarget = typeof GAME_BUILD_TARGETS[number];

/** Whether the host can build one target now, as the project status `buildTargets` reports it. */
export interface GameBuildTargetStatus {
  target: GameBuildTarget;
  available: boolean;
  reason?: string;
}

const BUILD_TARGET_COPY: Record<GameBuildTarget, { label: string; detail: string }> = {
  web: { label: 'Web', detail: 'Static folder to host over http(s)' },
  windows: { label: 'Windows', detail: 'Folder with a .exe' },
  linux: { label: 'Linux', detail: 'Folder with an executable; needs WebKitGTK' },
  macos: { label: 'macOS', detail: 'Unsigned .app bundle' },
};

/**
 * Availability of every Build Game target from a project status. When the host does not report
 * `buildTargets`, every target stays enabled and the host rejects a build it cannot run.
 */
export const readBuildTargets = (status: unknown): GameBuildTargetStatus[] => {
  const reported = status && typeof status === 'object' ? (status as { buildTargets?: unknown }).buildTargets : undefined;
  const entries = Array.isArray(reported)
    ? reported.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : null;
  return GAME_BUILD_TARGETS.map((target) => {
    if (!entries) return { target, available: true };
    const entry = entries.find((item) => item.target === target);
    if (!entry) return { target, available: false, reason: 'This editor cannot build for this platform.' };
    const reason = typeof entry.reason === 'string' && entry.reason.trim() ? entry.reason : undefined;
    return { target, available: entry.available === true, ...(reason ? { reason } : {}) };
  });
};

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
  renderScale: { min: MIN_RENDER_SCALE, max: MAX_RENDER_SCALE, step: 0.05 },
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
      meshLod: settings.quality.meshLod !== false,
      textureCompression: settings.quality.textureCompression !== false,
      maxDpr: clamp(settings.quality.maxDpr, LIMITS.maxDpr.min, LIMITS.maxDpr.max, defaults.quality.maxDpr),
      fov: clamp(settings.quality.fov, LIMITS.fov.min, LIMITS.fov.max, defaults.quality.fov),
      antiAliasing: settings.quality.antiAliasing === 'smaa' || settings.quality.antiAliasing === 'none' ? settings.quality.antiAliasing : 'temporal',
      renderScale: clamp(settings.quality.renderScale, LIMITS.renderScale.min, LIMITS.renderScale.max, defaults.quality.renderScale),
    },
    input: {
      mouseSensitivity: clamp(settings.input.mouseSensitivity, LIMITS.mouseSensitivity.min, LIMITS.mouseSensitivity.max, defaults.input.mouseSensitivity),
      invertY: Boolean(settings.input.invertY),
    },
    audio: {
      masterVolume: clamp(settings.audio.masterVolume, LIMITS.masterVolume.min, LIMITS.masterVolume.max, defaults.audio.masterVolume),
    },
    network: normalizeNetworkSettings(settings.network),
    navigation: resolveNavSettings(settings.navigation),
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
  const { levels, blueprints, projectStatus, buildGame, isLoading } = useScene();
  const { document, hydrated, error, replace } = useNativeProjectDocument<GameSettingsDocument>(
    'metadata', GAME_SETTINGS_DOCUMENT_ID, createDefaultGameSettingsDocument,
  );
  const stored = useMemo(() => normalizeGameSettings(document.settings), [document]);
  const [draft, setDraft] = useState<GameSettings>(stored);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // JSON of the stored settings the draft was last synced to. The draft is unedited while it matches.
  const baselineRef = useRef(JSON.stringify(stored));

  // An unedited draft follows the stored document (hydrate, another writer). An edited draft is kept
  // until the user saves or reverts: every revision bump re-hydrates the document and a failed save
  // rolls it back, and neither may discard what the user typed. A placeholder shown while loading
  // never replaces the draft. This is decided here, not in a setDraft updater: React calls updaters
  // twice in StrictMode, and the second call would see the moved baseline and keep the old draft.
  useEffect(() => {
    if (!hydrated) return;
    const next = JSON.stringify(stored);
    if (next === baselineRef.current) return;
    if (JSON.stringify(normalizeGameSettings(draftRef.current)) !== baselineRef.current) return;
    baselineRef.current = next;
    setDraft(stored);
  }, [stored, hydrated]);

  // A project switch always discards the draft.
  useEffect(() => {
    baselineRef.current = JSON.stringify(stored);
    setDraft(stored);
  }, [projectStatus.projectId]);

  const revert = () => {
    setMessage(null);
    baselineRef.current = JSON.stringify(stored);
    setDraft(stored);
  };

  const buildIdPrefix = useId();
  const buildTargets = useMemo(() => readBuildTargets(projectStatus), [projectStatus]);
  const [buildTarget, setBuildTarget] = useState<GameBuildTarget>('web');
  const [building, setBuilding] = useState(false);

  // Availability is host-wide and can change while the editor runs (a desktop player built or
  // downloaded since startup), so opening the panel asks the host again.
  useEffect(() => {
    void projectService.refreshStatus().catch(() => undefined);
  }, []);

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

  const selectedBuild = buildTargets.find((item) => item.target === buildTarget) ?? buildTargets[0];
  const buildBlocked = !projectStatus.projectId
    ? 'Open a project to build it.'
    : dirty
      ? 'Save or revert your changes first; builds use the saved settings.'
      : !selectedBuild.available
        ? selectedBuild.reason ?? 'This target is not available.'
        : null;
  const canBuild = hydrated && !saving && !building && !isLoading && buildBlocked === null;

  const build = async () => {
    const { target } = selectedBuild;
    setBuilding(true); setMessage(null);
    try {
      // project.buildGame accepts every GameBuildTarget; the scene action forwards it unchanged.
      await (buildGame as (target: GameBuildTarget) => Promise<void>)(target);
      setMessage(`${BUILD_TARGET_COPY[target].label} build finished.`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'The game could not be built.');
    } finally { setBuilding(false); }
  };

  const save = async () => {
    setSaving(true); setMessage(null);
    try {
      const settings = sanitizeGameSettings(draft);
      await replace({ ...document, id: GAME_SETTINGS_DOCUMENT_ID, settings });
      // The saved values (trimmed and clamped) become the new unedited baseline.
      const saved = normalizeGameSettings(settings);
      baselineRef.current = JSON.stringify(saved);
      setDraft(saved);
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
            <Toggle label="Mesh detail levels" checked={draft.quality.meshLod} disabled={disabled} onChange={(meshLod) => update((current) => ({ ...current, quality: { ...current.quality, meshLod } }))} />
            <Toggle label="Texture compression" checked={draft.quality.textureCompression} disabled={disabled} onChange={(textureCompression) => update((current) => ({ ...current, quality: { ...current.quality, textureCompression } }))} />
            <label className="block text-[9px] uppercase text-gray-500">Anti-aliasing
              <select aria-label="Anti-aliasing" value={draft.quality.antiAliasing} disabled={disabled} onChange={(event) => { const antiAliasing = event.target.value as GameSettings['quality']['antiAliasing']; update((current) => ({ ...current, quality: { ...current.quality, antiAliasing } })); }} className={`mt-1 ${inputClass}`}>
                <option value="temporal">Temporal</option>
                <option value="smaa">SMAA</option>
                <option value="none">None</option>
              </select>
            </label>
            <NumberField label="Render scale (temporal)" value={draft.quality.renderScale} limits={LIMITS.renderScale} disabled={disabled} onChange={(renderScale) => update((current) => ({ ...current, quality: { ...current.quality, renderScale } }))} />
            <div className="grid grid-cols-2 gap-2">
              <NumberField label="Max pixel ratio" value={draft.quality.maxDpr} limits={LIMITS.maxDpr} disabled={disabled} onChange={(maxDpr) => update((current) => ({ ...current, quality: { ...current.quality, maxDpr } }))} />
              <NumberField label="Field of view" value={draft.quality.fov} limits={LIMITS.fov} disabled={disabled} onChange={(fov) => update((current) => ({ ...current, quality: { ...current.quality, fov } }))} />
            </div>
          </div>

          <div className={sectionClass}>
            <div className={sectionTitleClass}>Navigation</div>
            <p className="text-[10px] text-gray-500">The agent each level's navmesh is baked for: enemies keep to it.</p>
            <div className="grid grid-cols-2 gap-2">
              <NumberField label="Agent radius (m)" value={draft.navigation.agentRadius} limits={NAV_SETTING_LIMITS.agentRadius} disabled={disabled} onChange={(agentRadius) => update((current) => ({ ...current, navigation: { ...current.navigation, agentRadius } }))} />
              <NumberField label="Agent height (m)" value={draft.navigation.agentHeight} limits={NAV_SETTING_LIMITS.agentHeight} disabled={disabled} onChange={(agentHeight) => update((current) => ({ ...current, navigation: { ...current.navigation, agentHeight } }))} />
              <NumberField label="Max slope (°)" value={draft.navigation.maxSlopeDegrees} limits={NAV_SETTING_LIMITS.maxSlopeDegrees} disabled={disabled} onChange={(maxSlopeDegrees) => update((current) => ({ ...current, navigation: { ...current.navigation, maxSlopeDegrees } }))} />
              <NumberField label="Max step (m)" value={draft.navigation.maxStepHeight} limits={NAV_SETTING_LIMITS.maxStepHeight} disabled={disabled} onChange={(maxStepHeight) => update((current) => ({ ...current, navigation: { ...current.navigation, maxStepHeight } }))} />
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

          <div className={sectionClass}>
            <div className={sectionTitleClass}>Multiplayer</div>
            <Toggle label="Online multiplayer" checked={draft.network.enabled} disabled={disabled} onChange={(enabled) => update((current) => ({ ...current, network: { ...current.network, enabled } }))} />
            {draft.network.enabled && (
              <>
                <label className="block text-[9px] uppercase text-gray-500">Server address
                  <input type="text" aria-label="Server address" value={draft.network.serverUrl} disabled={disabled} placeholder="ws://127.0.0.1:7777" onChange={(event) => { const serverUrl = event.target.value; update((current) => ({ ...current, network: { ...current.network, serverUrl } })); }} className={`mt-1 ${inputClass}`} />
                </label>
                {!/^wss?:\/\//i.test(draft.network.serverUrl.trim()) && <p className="text-[10px] text-amber-400">The address must start with ws:// or wss://.</p>}
                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-[9px] uppercase text-gray-500">Room
                    <input type="text" aria-label="Room" value={draft.network.room} disabled={disabled} onChange={(event) => { const room = event.target.value; update((current) => ({ ...current, network: { ...current.network, room } })); }} className={`mt-1 ${inputClass}`} />
                  </label>
                  <NumberField label="Max players" value={draft.network.maxPlayers} limits={{ min: 1, max: 16, step: 1 }} disabled={disabled} onChange={(maxPlayers) => update((current) => ({ ...current, network: { ...current.network, maxPlayers } }))} />
                </div>
                <p className="text-[10px] text-gray-500">Players meet through a relay server: run <code>python -m Auvra.net.relay</code>, or the <code>server/relay.py</code> shipped with the build. Play in the editor reaches a relay on this machine at port 7777.</p>
              </>
            )}
          </div>

          <div className={sectionClass}>
            <div className={sectionTitleClass}>Build game</div>
            <fieldset className="grid grid-cols-2 gap-2" aria-label="Build target">
              {buildTargets.map(({ target, available, reason }) => {
                const copy = BUILD_TARGET_COPY[target];
                const hintId = `${buildIdPrefix}-${target}-hint`;
                return (
                  <label key={target} className={`flex items-start gap-2 rounded border px-2 py-1.5 text-xs ${buildTarget === target && available ? 'border-emerald-600 bg-emerald-950/30' : 'border-gray-800'} ${available ? 'cursor-pointer text-gray-200' : 'cursor-not-allowed text-gray-500'}`}>
                    <input type="radio" name={`${buildIdPrefix}-target`} value={target} aria-label={copy.label} aria-describedby={hintId} checked={buildTarget === target} disabled={!available || building} onChange={() => setBuildTarget(target)} className="mt-0.5" />
                    <span className="min-w-0">
                      <span className="block font-bold">{copy.label}</span>
                      <span id={hintId} className={`block text-[10px] ${available ? 'text-gray-500' : 'text-amber-400'}`}>{available ? copy.detail : reason ?? 'Not available in this editor.'}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] text-gray-500">{buildBlocked ?? 'Pick a parent folder; an earlier build of this target there is replaced.'}</p>
              <button type="button" disabled={!canBuild} onClick={() => void build()} className="flex shrink-0 items-center gap-2 rounded bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-600 disabled:opacity-50"><Hammer size={13} /> {building ? 'Building…' : `Build ${BUILD_TARGET_COPY[selectedBuild.target].label}`}</button>
            </div>
          </div>

          {(message || error) && <div className="rounded border border-gray-700 bg-gray-950 p-3 text-xs text-gray-300">{message || error?.message}</div>}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-gray-800 bg-gray-950 px-5 py-3">
          <button type="button" disabled={disabled || !dirty} onClick={revert} className="flex items-center gap-2 rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50"><RotateCcw size={13} /> Revert</button>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-white">Close</button>
            <button type="button" disabled={disabled || !dirty || !writable} onClick={() => void save()} className="flex items-center gap-2 rounded bg-blue-600 px-3 py-1.5 text-xs font-bold text-accent-ink hover:bg-blue-500 disabled:opacity-50" title={writable ? 'Save game settings' : 'Open a writable project to save'}><Save size={13} /> {saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
};
