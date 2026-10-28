import React, { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { AlertTriangle, ChevronDown, ChevronRight, Palette, RotateCcw, Save, Search, Trash2, Undo2 } from 'lucide-react';
import type { LoadedModelData, TextureData } from '../../types';
import { Select } from '../UI/Select';
import { materialLibrary } from '../../runtime/materials/materialLibrary';
import {
  MAX_EMISSIVE_INTENSITY,
  applyMaterialOverrides,
  collectOverrideTextures,
  listModelMaterials,
  materialOverridesEqual,
  normalizeMaterialOverrides,
  overrideTextureCacheKey,
  overrideTextureFlipY,
  setMaterialOverrideField,
  tagOverrideTexture,
  type MaterialOverride,
  type MaterialOverrideField,
  type MaterialOverrides,
  type MaterialTextureSlot,
  type ModelMaterialInfo,
} from '../../utils/materialOverrides';

export interface MaterialEditorProps {
  /** The model whose materials are edited; changes preview live on `model.object`. */
  model: LoadedModelData & { materialOverrides?: unknown };
  /** Library textures offered for the base-colour and normal map slots. */
  textures: TextureData[];
  /** Persists the overrides on the model document. Without it the panel only previews. */
  onSave?: (modelId: string, overrides: MaterialOverrides) => Promise<void> | void;
  className?: string;
}

/**
 * Names the project protocol reserves as JSON keys, so the host refuses
 * material overrides keyed by them: `_PROTOCOL_RESERVED_KEY` in
 * Auvra/project/schemas.py and `reservedMaterialName` in
 * project/v1/models.schema.json. Python's `re.I` also folds dotted and dotless
 * I (U+0130, U+0131) to i, long s (U+017F) to s and the Kelvin sign (U+212A)
 * to k, which `isReservedMaterialName` folds first, and its `$` allows one
 * trailing newline, which `\n?` mirrors.
 */
const RESERVED_MATERIAL_NAME = /^(?:path|filepath|filesystempath|sourcepath|assetpath|directorypath|absolutepath|localpath|base64|binary|bytes|blob|credential|credentials|secret|token|api[_-]?key|password|authorization|auth[_-]?header|file|animationfiles|object|url)\n?(?![\s\S])/i;

/** True when the project cannot store overrides for a material with this name. */
export const isReservedMaterialName = (name: string): boolean =>
  RESERVED_MATERIAL_NAME.test(name.replace(/[\u0130\u0131]/g, 'i').replace(/\u017f/g, 's').replace(/\u212a/g, 'k'));

const reservedNameTooltip = (name: string) =>
  `Materials named “${name.trim()}” cannot be overridden: the project format reserves that name. Rename the material in the source file to edit it.`;

const formatNumber = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2));

const FieldRow: React.FC<{
  label: string;
  htmlFor?: string;
  overridden: boolean;
  onReset: () => void;
  children: React.ReactNode;
}> = ({ label, htmlFor, overridden, onReset, children }) => (
  <div className="flex items-center gap-2 min-h-[26px]">
    <label htmlFor={htmlFor} className={`w-24 shrink-0 text-[10px] uppercase font-bold flex items-center gap-1.5 ${overridden ? 'text-blue-300' : 'text-gray-500'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${overridden ? 'bg-blue-400' : 'bg-transparent'}`} aria-hidden />
      {label}
    </label>
    <div className="flex-1 min-w-0 flex items-center gap-2">{children}</div>
    <button
      type="button"
      onClick={onReset}
      disabled={!overridden}
      title={`Reset ${label.toLowerCase()} to the imported value`}
      aria-label={`Reset ${label.toLowerCase()}`}
      className="p-1 rounded text-gray-500 hover:text-white hover:bg-gray-800 disabled:opacity-0 disabled:pointer-events-none"
    >
      <RotateCcw size={11} />
    </button>
  </div>
);

const ColorField: React.FC<{
  label: string;
  value: string;
  overridden: boolean;
  onChange: (value: string) => void;
  onReset: () => void;
}> = ({ label, value, overridden, onChange, onReset }) => {
  const id = useId();
  return (
    <FieldRow label={label} htmlFor={id} overridden={overridden} onReset={onReset}>
      <input
        id={id}
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value.toLowerCase())}
        className="w-8 h-6 rounded border border-gray-700 bg-gray-950 cursor-pointer p-0"
      />
      <span className="text-[10px] font-mono text-gray-400">{value}</span>
    </FieldRow>
  );
};

const SliderField: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  overridden: boolean;
  onChange: (value: number) => void;
  onReset: () => void;
}> = ({ label, value, min, max, step, overridden, onChange, onReset }) => {
  const id = useId();
  return (
    <FieldRow label={label} htmlFor={id} overridden={overridden} onReset={onReset}>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, value))}
        onChange={(event) => onChange(Number(event.target.value))}
        className="flex-1 min-w-0 accent-blue-500"
      />
      <span className="w-9 text-right text-[10px] font-mono text-gray-400">{formatNumber(value)}</span>
    </FieldRow>
  );
};

const TextureField: React.FC<{
  label: string;
  value: string | undefined;
  textures: TextureData[];
  status: string | null;
  onChange: (textureId: string | undefined) => void;
}> = ({ label, value, textures, status, onChange }) => {
  const options = useMemo(() => {
    const list = [{ label: 'Imported', value: '' }, ...textures.map((texture) => ({ label: texture.name, value: texture.id }))];
    if (value && !textures.some((texture) => texture.id === value)) list.push({ label: 'Missing texture', value });
    return list;
  }, [textures, value]);
  return (
    <FieldRow label={label} overridden={Boolean(value)} onReset={() => onChange(undefined)}>
      <div className="flex-1 min-w-0" aria-label={label}>
        <Select value={value ?? ''} options={options} onChange={(next: string) => onChange(next || undefined)} className="w-full" />
      </div>
      {status && <span className="text-[9px] text-amber-400 shrink-0">{status}</span>}
    </FieldRow>
  );
};

/**
 * Lists a model's materials and edits per-material overrides (colour, PBR
 * values, emissive, opacity and texture maps). Every edit previews live on the
 * model; unsaved edits are reverted when the panel closes or the model changes.
 */
/** A material asset (Materials tab) whose node graph shades this material instead of the fields below. */
const MaterialAssetField: React.FC<{ value: string | undefined; onChange: (value: string | undefined) => void }> = ({ value, onChange }) => {
  const id = useId();
  const version = useSyncExternalStore((listener) => materialLibrary.subscribe(listener), () => materialLibrary.version);
  const assets = useMemo(() => materialLibrary.list(), [version]);
  return (
    <FieldRow label="Material asset" htmlFor={id} overridden={Boolean(value)} onReset={() => onChange(undefined)}>
      <select id={id} value={value ?? ''} onChange={(event) => onChange(event.target.value || undefined)}
        className="flex-1 min-w-0 bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-gray-200">
        <option value="">(its own)</option>
        {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
        {value && !assets.some((asset) => asset.id === value) && <option value={value}>(missing material)</option>}
      </select>
    </FieldRow>
  );
};

export const MaterialEditor: React.FC<MaterialEditorProps> = (props) => (
  // A different model (or a reloaded one) starts a fresh editing session.
  <MaterialEditorSession key={`${props.model.id}:${props.model.object.uuid}`} {...props} />
);

const MaterialEditorSession: React.FC<MaterialEditorProps> = ({ model, textures, onSave, className = '' }) => {
  const stored = useMemo(() => normalizeMaterialOverrides(model.materialOverrides), [model.materialOverrides]);
  const [saved, setSaved] = useState<MaterialOverrides>(stored);
  const [draft, setDraft] = useState<MaterialOverrides>(stored);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [textureVersion, setTextureVersion] = useState(0);

  const savedRef = useRef(saved);
  savedRef.current = saved;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const textureCache = useRef(new Map<string, THREE.Texture>());
  const pendingTextures = useRef(new Set<string>());
  const failedTextures = useRef(new Set<string>());
  const session = useRef(0);
  /** True while a save awaits the host; closing then defers the session end until it settles. */
  const savingRef = useRef(false);
  const deferredEnd = useRef<(() => void) | null>(null);

  const materials = useMemo(() => listModelMaterials(model.object), [model.object]);
  const dirty = !materialOverridesEqual(draft, saved);

  // Adopt stored overrides that change underneath the panel (e.g. a reload) unless there are unsaved edits.
  useEffect(() => {
    const previous = savedRef.current;
    if (materialOverridesEqual(previous, stored)) return;
    savedRef.current = stored;
    setSaved(stored);
    setDraft((current) => (materialOverridesEqual(current, previous) ? stored : current));
  }, [stored]);

  // Own the model's override textures for this session; on close, revert unsaved edits and release unbound textures.
  useEffect(() => {
    const object = model.object;
    const cache = textureCache.current;
    session.current += 1;
    for (const [key, texture] of collectOverrideTextures(object)) cache.set(key, texture);
    return () => {
      session.current += 1;
      const endSession = () => {
        const bound = applyMaterialOverrides(object, savedRef.current, (textureId, slot) => cache.get(overrideTextureCacheKey(textureId, slot))).boundTextureKeys;
        for (const [key, texture] of cache) {
          if (!bound.has(key)) texture.dispose();
        }
        cache.clear();
        pendingTextures.current.clear();
        failedTextures.current.clear();
      };
      // An in-flight save still needs the previewed textures on the object;
      // it ends the session with the value it settled on.
      if (savingRef.current) deferredEnd.current = endSession;
      else endSession();
    };
  }, [model.object]);

  const textureUrls = useMemo(() => new Map(textures.map((texture) => [texture.id, texture.url])), [textures]);

  const resolveTexture = useCallback((textureId: string, slot: MaterialTextureSlot) => {
    const key = overrideTextureCacheKey(textureId, slot);
    const cached = textureCache.current.get(key);
    if (cached) return cached;
    const url = textureUrls.get(textureId);
    if (!url || pendingTextures.current.has(key) || failedTextures.current.has(key)) return null;
    const loadSession = session.current;
    pendingTextures.current.add(key);
    new THREE.TextureLoader().loadAsync(url).then((texture) => {
      if (loadSession !== session.current) {
        texture.dispose();
        return;
      }
      pendingTextures.current.delete(key);
      textureCache.current.set(key, tagOverrideTexture(texture, textureId, slot, overrideTextureFlipY(model.object)));
      setTextureVersion((version) => version + 1);
    }, () => {
      if (loadSession !== session.current) return;
      pendingTextures.current.delete(key);
      failedTextures.current.add(key);
      setTextureVersion((version) => version + 1);
    });
    return null;
  }, [textureUrls, model.object]);

  // Live preview: every draft change is laid onto the model's materials.
  useEffect(() => {
    applyMaterialOverrides(model.object, draft, resolveTexture);
  }, [model.object, draft, resolveTexture, textureVersion]);

  const editField = <K extends MaterialOverrideField>(name: string, field: K, value: MaterialOverride[K] | undefined) => {
    setError(null);
    setDraft((current) => setMaterialOverrideField(current, name, field, value));
  };

  const textureStatus = (textureId: string | undefined, slot: MaterialTextureSlot): string | null => {
    if (!textureId) return null;
    const key = overrideTextureCacheKey(textureId, slot);
    if (textureCache.current.has(key)) return null;
    if (failedTextures.current.has(key)) return 'Failed';
    if (pendingTextures.current.has(key)) return 'Loading';
    return textureUrls.has(textureId) ? null : 'Missing';
  };

  const handleSave = async () => {
    if (!onSave || saving) return;
    const next = draftRef.current;
    setSaving(true);
    setError(null);
    savingRef.current = true;
    try {
      await onSave(model.id, next);
      savedRef.current = next;
      setSaved(next);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Material overrides could not be saved.');
    } finally {
      savingRef.current = false;
      setSaving(false);
      const endSession = deferredEnd.current;
      deferredEnd.current = null;
      endSession?.();
    }
  };

  const knownNames = useMemo(() => new Set(materials.map((material) => material.name)), [materials]);
  const staleNames = Object.keys(draft).filter((name) => !knownNames.has(name));
  const query = filter.trim().toLowerCase();
  const visible = query ? materials.filter((material) => material.name.toLowerCase().includes(query)) : materials;

  const renderFields = (material: ModelMaterialInfo) => {
    const override = draft[material.name] || {};
    const { base } = material;
    return (
      <div className="px-3 pb-3 pt-1 space-y-1 border-t border-gray-800/80">
        <MaterialAssetField value={override.materialId} onChange={(value) => editField(material.name, 'materialId', value)} />
        {override.materialId && <p className="text-[9px] text-gray-500">Shaded by the material asset; the fields below apply again without one.</p>}
        {base.color !== null && (
          <ColorField label="Color" value={override.color ?? base.color} overridden={override.color !== undefined}
            onChange={(value) => editField(material.name, 'color', value)} onReset={() => editField(material.name, 'color', undefined)} />
        )}
        {base.roughness !== null && (
          <SliderField label="Roughness" min={0} max={1} step={0.01} value={override.roughness ?? base.roughness} overridden={override.roughness !== undefined}
            onChange={(value) => editField(material.name, 'roughness', value)} onReset={() => editField(material.name, 'roughness', undefined)} />
        )}
        {base.metalness !== null && (
          <SliderField label="Metalness" min={0} max={1} step={0.01} value={override.metalness ?? base.metalness} overridden={override.metalness !== undefined}
            onChange={(value) => editField(material.name, 'metalness', value)} onReset={() => editField(material.name, 'metalness', undefined)} />
        )}
        {base.emissive !== null && (
          <ColorField label="Emissive" value={override.emissive ?? base.emissive} overridden={override.emissive !== undefined}
            onChange={(value) => editField(material.name, 'emissive', value)} onReset={() => editField(material.name, 'emissive', undefined)} />
        )}
        {base.emissiveIntensity !== null && (
          <SliderField label="Glow" min={0} max={Math.min(MAX_EMISSIVE_INTENSITY, 20)} step={0.05}
            value={override.emissiveIntensity ?? base.emissiveIntensity} overridden={override.emissiveIntensity !== undefined}
            onChange={(value) => editField(material.name, 'emissiveIntensity', value)} onReset={() => editField(material.name, 'emissiveIntensity', undefined)} />
        )}
        <SliderField label="Opacity" min={0} max={1} step={0.01} value={override.opacity ?? base.opacity} overridden={override.opacity !== undefined}
          onChange={(value) => editField(material.name, 'opacity', value)} onReset={() => editField(material.name, 'opacity', undefined)} />
        {base.hasMapSlot && (
          <TextureField label="Base map" value={override.mapTextureId} textures={textures} status={textureStatus(override.mapTextureId, 'map')}
            onChange={(value) => editField(material.name, 'mapTextureId', value)} />
        )}
        {base.hasNormalSlot && (
          <TextureField label="Normal map" value={override.normalTextureId} textures={textures} status={textureStatus(override.normalTextureId, 'normal')}
            onChange={(value) => editField(material.name, 'normalTextureId', value)} />
        )}
        {material.instanceCount > 1 && (
          <p className="text-[9px] text-gray-600 pt-1">Applies to {material.instanceCount} materials named “{material.name}”.</p>
        )}
      </div>
    );
  };

  return (
    <div className={`flex flex-col h-full min-h-0 bg-gray-900 text-gray-200 ${className}`}>
      <div className="p-3 border-b border-gray-800 shrink-0 space-y-2">
        <div className="flex items-center gap-2">
          <Palette size={14} className="text-blue-400 shrink-0" />
          <h2 className="text-xs font-bold tracking-wide uppercase">Materials</h2>
          <span className="text-[10px] text-gray-500 truncate" title={model.name}>{model.name}</span>
          <span className="ml-auto text-[10px] text-gray-600 shrink-0">{materials.length}</span>
        </div>
        {materials.length > 6 && (
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              type="text"
              placeholder="Filter materials..."
              aria-label="Filter materials"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              className="w-full bg-gray-950 border border-gray-700 rounded-md py-1.5 pl-8 pr-3 text-xs text-gray-300 focus:outline-none focus:border-blue-500 placeholder-gray-600"
            />
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-2 space-y-1.5">
        {materials.length === 0 && <div className="text-center py-8 text-gray-600 text-xs italic">This model has no materials.</div>}
        {visible.map((material) => {
          const unnamed = material.name === '';
          const reserved = !unnamed && isReservedMaterialName(material.name);
          const editable = !unnamed && !reserved;
          const isOpen = editable && expanded === material.name;
          const override = draft[material.name];
          const fieldCount = override ? Object.keys(override).length : 0;
          const swatch = override?.color ?? material.base.color ?? '#000000';
          return (
            <div key={material.name || '(unnamed)'} className={`rounded-md border ${isOpen ? 'border-blue-500/30 bg-gray-950/60' : 'border-gray-800 bg-gray-950/30'}`}>
              <button
                type="button"
                disabled={!editable}
                onClick={() => setExpanded(isOpen ? null : material.name)}
                aria-expanded={isOpen}
                className="w-full flex items-center gap-2 px-2 py-2 text-left disabled:cursor-not-allowed"
                title={editable ? undefined : reserved ? reservedNameTooltip(material.name) : 'Unnamed materials cannot be overridden.'}
              >
                {isOpen ? <ChevronDown size={12} className="text-gray-500 shrink-0" /> : <ChevronRight size={12} className="text-gray-500 shrink-0" />}
                <span className="w-4 h-4 rounded border border-gray-700 shrink-0" style={{ backgroundColor: swatch }} aria-hidden />
                <span className={`flex-1 min-w-0 truncate text-xs ${editable ? 'text-gray-200' : reserved ? 'text-gray-500' : 'text-gray-600 italic'}`}>
                  {unnamed ? 'Unnamed material' : material.name}
                </span>
                {reserved && <span className="text-[9px] font-bold text-amber-500/80 uppercase shrink-0">Reserved</span>}
                <span className="text-[9px] text-gray-600 uppercase shrink-0">{material.type.replace(/^Mesh|Material$/g, '')}</span>
                {fieldCount > 0 && (
                  <span className="text-[9px] font-bold text-blue-300 bg-blue-900/40 border border-blue-800/50 rounded px-1.5 shrink-0">{fieldCount}</span>
                )}
              </button>
              {isOpen && renderFields(material)}
            </div>
          );
        })}
        {staleNames.length > 0 && (
          <div className="mt-3 rounded-md border border-amber-900/50 bg-amber-900/10 p-2 space-y-1">
            <div className="text-[10px] font-bold text-amber-400 flex items-center gap-1.5">
              <AlertTriangle size={11} /> Overrides for materials not in this model
            </div>
            {staleNames.map((name) => (
              <div key={name} className="flex items-center gap-2 text-[10px] text-gray-400">
                <span className="flex-1 truncate">{name}</span>
                <button
                  type="button"
                  onClick={() => setDraft((current) => { const next = { ...current }; delete next[name]; return next; })}
                  aria-label={`Remove overrides for ${name}`}
                  className="p-1 rounded hover:bg-gray-800 hover:text-white"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="p-3 border-t border-gray-800 shrink-0 space-y-2">
        {error && (
          <div role="alert" className="text-[10px] text-red-400 bg-red-900/20 p-2 rounded border border-red-900/50 flex gap-2">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" /> <span className="flex-1">{error}</span>
          </div>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => { setError(null); setDraft(saved); }}
            disabled={!dirty || saving}
            className="flex-1 py-2 rounded-md bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-bold flex items-center justify-center gap-1.5 border border-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Undo2 size={12} /> Revert
          </button>
          {onSave ? (
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!dirty || saving}
              className="flex-1 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Save size={12} /> {saving ? 'Saving…' : 'Save'}
            </button>
          ) : (
            <span className="flex-1 text-[9px] text-gray-600 self-center text-center">Preview only — not saved</span>
          )}
        </div>
      </div>
    </div>
  );
};
