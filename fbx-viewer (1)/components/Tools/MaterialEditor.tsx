import React, { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { ChevronDownIcon, ChevronRightIcon, MaterialIcon, ResetIcon, SaveIcon, SearchIcon, TrashIcon, UndoIcon, WarningIcon } from '../UI/Icons';
import type { LoadedModelData, TextureData } from '../../types';
import { Select } from '../UI/Select';
import { materialAssetUse, materialLibrary } from '../../runtime/materials/materialLibrary';
import { isSmartMaterialAsset } from '../../texturing/paint/smartMaterials';
import { materialGraphParameters, type MaterialParameter, type MaterialParameterValue } from '../../runtime/materials/materialGraph';
import { Segmented } from '../UI/kit';
import { assetShaderVersions, type ObjectMaterialOverrides } from '../../utils/materialInstances';
import { expandPaintedCopies, isPaintedCopy } from '../../utils/paintedCopies';
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
  withBaseMap,
  type MaterialOverride,
  type MaterialOverrideField,
  type MaterialOverrides,
  type MaterialTextureSlot,
  type ModelMaterialInfo,
  type PhysicalOverrideColor,
  type PhysicalOverrideNumber,
  type PhysicalValues,
  type MaterialParameterSetting,
} from '../../utils/materialOverrides';
import { ColourField } from '../UI/ColourPicker';
import { projectService } from '../../utils/projectService';
import { nativeDomainRecords } from '../../utils/projectRecords';
import { texturePicture } from './Retexture/parts';

export interface MaterialEditorProps {
  /** The model whose materials are edited; changes preview live on `model.object`. */
  model: LoadedModelData & { materialOverrides?: unknown };
  /** Library textures offered for the map slots. */
  textures: TextureData[];
  /** Persists the overrides on the model document. Without it the panel only previews. */
  onSave?: (modelId: string, overrides: MaterialOverrides) => Promise<void> | void;
  /** The model's placed copies in the open level, whose own material values add shader versions. */
  placedCopies?: ReadonlyArray<{ modelId: string; materialOverrides?: ObjectMaterialOverrides }>;
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
    <label htmlFor={htmlFor} className={`w-24 shrink-0 text-2xs font-bold flex items-center gap-1.5 ${overridden ? 'text-blue-300' : 'text-gray-500'}`}>
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
      <ResetIcon size={11} />
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
      <ColourField id={id} value={value} onChange={onChange} label={label} className="h-6 w-8" />
      <span className="text-2xs font-mono text-gray-400">{value}</span>
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
  /** What the value reads as, where a number would not say it (no absorption at all). */
  display?: string;
  onChange: (value: number) => void;
  onReset: () => void;
}> = ({ label, value, min, max, step, overridden, display, onChange, onReset }) => {
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
      <span className="w-9 text-right text-2xs font-mono text-gray-400">{display ?? formatNumber(value)}</span>
    </FieldRow>
  );
};

type PhysicalField = PhysicalOverrideNumber | PhysicalOverrideColor;

/** One physical value: a slider for a number, a colour field for a colour. */
interface PhysicalFieldDef {
  field: PhysicalField;
  label: string;
  min?: number;
  max?: number;
  step?: number;
}

/** A physical material's values in Material Overrides, by group, in the order a surface is built up. */
const PHYSICAL_GROUPS: ReadonlyArray<{ title: string; fields: readonly PhysicalFieldDef[]; inUse: (values: PhysicalValues) => boolean }> = [
  {
    title: 'Coat',
    fields: [{ field: 'coat', label: 'Coat', min: 0, max: 1, step: 0.01 }, { field: 'coatRoughness', label: 'Coat roughness', min: 0, max: 1, step: 0.01 }],
    inUse: (values) => values.coat > 0,
  },
  {
    title: 'Sheen',
    fields: [{ field: 'sheenColor', label: 'Sheen colour' }, { field: 'sheenRoughness', label: 'Sheen roughness', min: 0, max: 1, step: 0.01 }],
    inUse: (values) => values.sheenColor !== '#000000',
  },
  {
    title: 'Specular',
    fields: [
      { field: 'specularWeight', label: 'Specular strength', min: 0, max: 1, step: 0.01 },
      { field: 'specularColor', label: 'Specular colour' },
      { field: 'ior', label: 'Index of refraction', min: 1, max: 2.5, step: 0.01 },
      { field: 'anisotropy', label: 'Anisotropy', min: 0, max: 1, step: 0.01 },
      { field: 'anisotropyRotation', label: 'Anisotropy direction', min: 0, max: 360, step: 1 },
    ],
    inUse: (values) => values.specularWeight !== 1 || values.specularColor !== '#ffffff' || Math.abs(values.ior - 1.5) > 1e-3 || values.anisotropy > 0,
  },
  {
    title: 'Thin film',
    fields: [{ field: 'thinFilm', label: 'Thin film', min: 0, max: 1, step: 0.01 }, { field: 'thinFilmThickness', label: 'Thin film thickness (nm)', min: 0, max: 1200, step: 10 }],
    inUse: (values) => values.thinFilm > 0,
  },
  {
    title: 'Transmission',
    fields: [
      { field: 'transmission', label: 'Transmission', min: 0, max: 1, step: 0.01 },
      { field: 'thickness', label: 'Thickness', min: 0, max: 2, step: 0.005 },
      { field: 'attenuationColor', label: 'Absorption colour' },
      { field: 'attenuationDistance', label: 'Absorption distance', min: 0.01, max: 10, step: 0.01 },
      { field: 'dispersion', label: 'Dispersion', min: 0, max: 1, step: 0.01 },
    ],
    inUse: (values) => values.transmission > 0,
  },
];

const isColorField = (field: PhysicalField): field is PhysicalOverrideColor => field === 'sheenColor' || field === 'attenuationColor' || field === 'specularColor';

/**
 * A physical material's coat, sheen, specular, thin film and transmission values (glTF's material
 * extensions), each group under a header of its own that opens when the material uses it.
 */
const PhysicalFields: React.FC<{
  values: PhysicalValues;
  override: MaterialOverride;
  onChange: (field: PhysicalField, value: number | string | undefined) => void;
}> = ({ values, override, onChange }) => {
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  // What the material shows: its own values, with this override's on top.
  const shown = { ...values, ...Object.fromEntries(Object.entries(override).filter(([key]) => key in values)) } as PhysicalValues;
  return (
    <div className="space-y-1">
      {PHYSICAL_GROUPS.map((group) => {
        const overridden = group.fields.some(({ field }) => override[field] !== undefined);
        const open = toggled[group.title] ?? (group.inUse(shown) || overridden);
        return (
          <div key={group.title} className="border-t border-gray-800/80 pt-1">
            <button type="button" aria-expanded={open} onClick={() => setToggled((current) => ({ ...current, [group.title]: !open }))}
              className="flex w-full items-center gap-1 text-left text-2xs font-semibold text-gray-300 hover:text-white">
              {open ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} />}
              {group.title}
              {!open && (group.inUse(shown) || overridden) && <span className="ml-auto text-2xs font-normal text-gray-500">In use</span>}
            </button>
            {open && (
              <div className="mt-1 space-y-1">
                {group.fields.map(({ field, label, min = 0, max = 1, step = 0.01 }) => (isColorField(field)
                  ? <ColorField key={field} label={label} value={shown[field]} overridden={override[field] !== undefined}
                    onChange={(value) => onChange(field, value)} onReset={() => onChange(field, undefined)} />
                  : <SliderField key={field} label={label} value={shown[field]} min={min} max={max} step={step} overridden={override[field] !== undefined}
                    display={field === 'attenuationDistance' && !Number.isFinite(shown[field]) ? 'none' : undefined}
                    onChange={(value) => onChange(field, value)} onReset={() => onChange(field, undefined)} />))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

/**
 * A texture an override names that the texture library list does not hold yet (the mask tool's pictures
 * until the project opens again): its name in the project, or what it is, and a picture of it when the
 * model wears it.
 */
interface TextureFound {
  name: string;
  thumbnail: string | null;
}

/** Pixels across a map's thumbnail. */
const THUMBNAIL_EDGE = 48;
const thumbnails = new WeakMap<THREE.Texture, string>();

/** A small picture of a texture a model wears, drawn once. */
const thumbnailOf = (texture: THREE.Texture, flipY: boolean): string | null => {
  const known = thumbnails.get(texture);
  if (known) return known;
  const picture = texturePicture(texture, THUMBNAIL_EDGE, 'image/png', flipY)?.url ?? null;
  if (picture) thumbnails.set(texture, picture);
  return picture;
};

const TextureField: React.FC<{
  label: string;
  value: string | undefined;
  textures: TextureData[];
  status: string | null;
  /** The value when the library list does not hold it; null when it cannot be found anywhere. */
  found?: TextureFound | null;
  onChange: (textureId: string | undefined) => void;
}> = ({ label, value, textures, status, found, onChange }) => {
  const known = value ? textures.find((texture) => texture.id === value) : undefined;
  const foundName = found?.name;
  const options = useMemo(() => {
    const list = [{ label: 'Imported', value: '' }, ...textures.map((texture) => ({ label: texture.name, value: texture.id }))];
    if (value && !known) list.push({ label: foundName ?? 'Missing texture', value });
    return list;
  }, [textures, value, known, foundName]);
  const thumbnail = known?.url || found?.thumbnail || null;
  return (
    <FieldRow label={label} overridden={Boolean(value)} onReset={() => onChange(undefined)}>
      {value && thumbnail && <img src={thumbnail} alt="" className="h-6 w-6 shrink-0 rounded border border-gray-700 object-cover" />}
      <div className="flex-1 min-w-0" aria-label={label}>
        <Select value={value ?? ''} options={options} onChange={(next: string) => onChange(next || undefined)} className="w-full" />
      </div>
      {status && <span className="text-2xs text-amber-400 shrink-0">{status}</span>}
    </FieldRow>
  );
};

/**
 * A material asset (Materials tab) whose node graph shades this material instead of the fields below.
 * Only assets that draw are offered: a texture graph whose pictures are not made yet, or a painting not
 * yet put on a model, would shade it plain grey, and a graph made for other graphs is no material.
 */
const MaterialAssetField: React.FC<{
  value: string | undefined;
  /** Whether this kind of material can be shaded by a graph (standard materials only). */
  takesAsset: boolean;
  materialType: string;
  onChange: (value: string | undefined) => void;
}> = ({ value, takesAsset, materialType, onChange }) => {
  const version = useSyncExternalStore((listener) => materialLibrary.subscribe(listener), () => materialLibrary.version);
  // Painted copies are each model's own: shown as its painted base map, never offered as an asset.
  const assets = useMemo(() => materialLibrary.list().filter(asset => !isPaintedCopy(asset)), [version]);
  const drawing = useMemo(() => assets.filter((asset) => !isSmartMaterialAsset(asset) && materialAssetUse(asset) === 'material'), [assets]);
  const waiting = useMemo(() => assets.filter((asset) => !isSmartMaterialAsset(asset) && materialAssetUse(asset) === 'needsPictures'), [assets]);
  const options = useMemo(() => {
    const list = [{ label: 'Its own', value: '' }, ...drawing.map((asset) => ({ label: asset.name, value: asset.id }))];
    if (value && !drawing.some((asset) => asset.id === value)) {
      const chosen = assets.find((asset) => asset.id === value);
      list.push({ label: chosen ? chosen.name + ' (has no pictures yet)' : 'Missing material', value });
    }
    return list;
  }, [assets, drawing, value]);
  const unlit = materialType === 'MeshBasicMaterial';
  return (
    <>
      <FieldRow label="Material asset" overridden={Boolean(value)} onReset={() => onChange(undefined)}>
        <div className="flex-1 min-w-0" aria-label="Material asset">
          <Select value={value ?? ''} options={options} onChange={(next: string) => onChange(next || undefined)} disabled={!takesAsset} className="w-full" />
        </div>
      </FieldRow>
      {!takesAsset && (
        <p className="text-2xs leading-snug text-amber-400/90">
          A material asset can&apos;t shade this material: it is {unlit ? 'drawn without lighting' : 'an older kind of shaded material'}, and material assets need the standard lit material. Its own colour and maps below still apply.
        </p>
      )}
      {takesAsset && waiting.length > 0 && (
        <p className="text-2xs leading-snug text-gray-500">
          Not offered until they have pictures: {waiting.map((asset) => asset.name).join(', ')}. Choose Update material on a texture graph in Materials, or Put on the model in Paint.
        </p>
      )}
    </>
  );
};

const toHex = (rgb: number[]): string =>
  `#${rgb.map(channel => Math.round(Math.min(1, Math.max(0, channel)) * 255).toString(16).padStart(2, '0')).join('')}`;
const fromHex = (hex: string): number[] => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255);

const NumberInput: React.FC<{ label: string; value: number; step: number; onChange: (value: number) => void; id?: string }> = ({ label, value, step, onChange, id }) => (
  <input
    id={id}
    type="number"
    aria-label={label}
    step={step}
    value={Number.isFinite(value) ? Number(value.toFixed(4)) : 0}
    onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next)) onChange(next); }}
    className="w-full min-w-0 bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-2xs text-gray-200"
  />
);

/** The textures a texture parameter can take, the graph's own first. */
const textureOptions = (textures: ReadonlyArray<{ id: string; name: string }>, graphTexture: string) => [
  { value: '', label: 'As in the material' },
  ...textures.filter(texture => texture.id !== graphTexture || graphTexture === '').map(texture => ({ value: texture.id, label: texture.name })),
];

/** One parameter of the assigned material asset: this material's value, or the one it inherits when unset. */
const ParameterField: React.FC<{
  parameter: MaterialParameter;
  value: MaterialParameterValue | undefined;
  /** The value used when this one is unset: the model's own, for a placed object; else the graph's. */
  inherited?: MaterialParameterValue;
  textures?: ReadonlyArray<{ id: string; name: string }>;
  onChange: (value: MaterialParameterValue | undefined) => void;
}> = ({ parameter, value, inherited, textures = [], onChange }) => {
  const id = useId();
  const { name, param } = parameter;
  const current = value ?? inherited ?? parameter.value;
  const overridden = value !== undefined;
  const reset = () => onChange(undefined);
  if (param.kind === 'texture') {
    const picked = typeof value === 'string' ? value : '';
    return (
      <FieldRow label={name} overridden={overridden} onReset={reset}>
        <Select value={picked} placeholder={name} options={textureOptions(textures, String(parameter.value ?? ''))}
          onChange={(next: string) => onChange(next ? next : undefined)} className="flex-1 min-w-0" />
      </FieldRow>
    );
  }
  if (param.kind === 'boolean') {
    return (
      <FieldRow label={name} overridden={overridden} onReset={reset}>
        <Segmented label={name} value={current === false ? 'off' : 'on'}
          options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off', hint: 'Each choice of a switch builds a shader version of its own' }]}
          onChange={(next) => onChange(next === 'on')} />
      </FieldRow>
    );
  }
  if (param.kind === 'color') {
    return <ColorField label={name} value={toHex(current as number[])} overridden={overridden} onChange={(hex) => onChange(fromHex(hex))} onReset={reset} />;
  }
  if (param.kind === 'float') {
    if (param.min !== undefined && param.max !== undefined) {
      return <SliderField label={name} value={current as number} min={param.min} max={param.max} step={param.step ?? 0.01} overridden={overridden} onChange={onChange} onReset={reset} />;
    }
    return (
      <FieldRow label={name} htmlFor={id} overridden={overridden} onReset={reset}>
        <NumberInput id={id} label={name} value={current as number} step={param.step ?? 0.05} onChange={onChange} />
      </FieldRow>
    );
  }
  const components = current as number[];
  return (
    <FieldRow label={name} overridden={overridden} onReset={reset}>
      {components.map((component, index) => (
        <NumberInput key={index} label={`${name} ${'XYZW'[index]}`} value={component} step={0.05}
          onChange={(next) => onChange(components.map((old, at) => (at === index ? next : old)))} />
      ))}
    </FieldRow>
  );
};

/**
 * The assigned material asset's parameters (named in its graph), each set here or left at what it
 * inherits (the asset's value, or the model's own for a placed object), with how many shader versions
 * the asset builds for its uses when that is more than one.
 */
export const MaterialParameterFields: React.FC<{
  materialId: string;
  values: MaterialParameterSetting[] | undefined;
  onChange: (values: MaterialParameterSetting[] | undefined) => void;
  /** Values used where these set none (a placed object inherits its model's). */
  inherited?: MaterialParameterSetting[];
  textures?: ReadonlyArray<{ id: string; name: string }>;
  /** Shader versions the asset builds for its uses (one per choice of its switches). */
  versions?: number;
  title?: string;
}> = ({ materialId, values, onChange, inherited, textures, versions, title = 'Material parameters' }) => {
  const version = useSyncExternalStore((listener) => materialLibrary.subscribe(listener), () => materialLibrary.version);
  const parameters = useMemo(() => {
    const asset = materialLibrary.get(materialId);
    return asset ? materialGraphParameters(asset.graph) : [];
  }, [materialId, version]);
  if (!parameters.length) return null;
  const set = (name: string, value: MaterialParameterValue | undefined) => {
    const next = (values ?? []).filter(setting => setting.name !== name);
    if (value !== undefined) next.push({ name, value });
    next.sort((a, b) => a.name.localeCompare(b.name));
    onChange(next.length ? next : undefined);
  };
  return (
    <div className="space-y-1 pl-2 border-l border-gray-800">
      <div className="flex items-center gap-2">
        <p className="text-2xs font-bold text-gray-500">{title}</p>
        {versions !== undefined && versions > 1 && (
          <span className="ml-auto text-2xs text-amber-400/80" title="Each different choice of its switches builds a shader of its own, which takes time to build and memory to keep">
            {versions} shader versions
          </span>
        )}
      </div>
      {parameters.map((parameter) => (
        <ParameterField key={parameter.name} parameter={parameter} value={values?.find(setting => setting.name === parameter.name)?.value}
          inherited={inherited?.find(setting => setting.name === parameter.name)?.value} textures={textures}
          onChange={(value) => set(parameter.name, value)} />
      ))}
    </div>
  );
};

export const MaterialEditor: React.FC<MaterialEditorProps> = (props) => (
  // A different model (or a reloaded one) starts a fresh editing session.
  <MaterialEditorSession key={`${props.model.id}:${props.model.object.uuid}`} {...props} />
);

/**
 * Lists a model's materials and edits per-material overrides (colour, PBR
 * values, emissive, opacity, texture maps and a material asset). Every edit
 * previews live on the model; unsaved edits are reverted when the panel closes
 * or the model changes.
 */
const MaterialEditorSession: React.FC<MaterialEditorProps> = ({ model, textures, onSave, placedCopies, className = '' }) => {
  // Painted copies the model owns are edited as the painted base maps they carry (utils/paintedCopies.ts).
  const stored = useMemo(() => expandPaintedCopies(normalizeMaterialOverrides(model.materialOverrides), (id) => materialLibrary.get(id)), [model.materialOverrides]);
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

  // Names, from the project, of textures the overrides name that the library list does not hold yet.
  const [projectNames, setProjectNames] = useState<Record<string, string>>({});
  const askedNames = useRef(new Set<string>());
  const unlisted = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of Object.values(draft)) {
      for (const id of [entry.mapTextureId, entry.normalTextureId, entry.roughnessTextureId, entry.metalnessTextureId]) if (id && !textureUrls.has(id)) ids.add(id);
    }
    return [...ids].sort().join('\n');
  }, [draft, textureUrls]);
  useEffect(() => {
    const wanted = unlisted ? unlisted.split('\n').filter((id) => !askedNames.current.has(id)) : [];
    if (!wanted.length || !projectService.getStatus().projectId) return;
    for (const id of wanted) askedNames.current.add(id);
    let current = true;
    projectService.getSnapshotAll('textures').then((snapshot) => {
      if (!current) return;
      const names: Record<string, string> = {};
      for (const record of nativeDomainRecords(snapshot, 'textures')) {
        if (wanted.includes(record.id) && typeof record.name === 'string' && record.name) names[record.id] = record.name;
      }
      if (Object.keys(names).length) setProjectNames((previous) => ({ ...previous, ...names }));
    }, () => undefined);
    return () => { current = false; };
  }, [unlisted]);

  /**
   * A texture an override names that the library list does not hold: found when the model wears it or the
   * project keeps it, named as the project names it or by what it is; null when it is nowhere at all.
   */
  const foundTexture = (textureId: string | undefined, slot: MaterialTextureSlot, painted = false): TextureFound | null => {
    if (!textureId || textureUrls.has(textureId)) return null;
    const key = overrideTextureCacheKey(textureId, slot);
    const worn = textureCache.current.get(key) ?? collectOverrideTextures(model.object).get(key);
    const name = projectNames[textureId];
    if (!worn && !name) return null;
    return {
      name: name ?? (painted ? 'Painted picture' : 'Picture on the model'),
      thumbnail: worn ? thumbnailOf(worn, overrideTextureFlipY(model.object)) : null,
    };
  };

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

  const editBaseMap = (name: string, textureId: string | undefined) => {
    setError(null);
    setDraft((current) => withBaseMap(current, name, textureId));
  };

  const textureStatus = (textureId: string | undefined, slot: MaterialTextureSlot): string | null => {
    if (!textureId) return null;
    const key = overrideTextureCacheKey(textureId, slot);
    if (textureCache.current.has(key)) return null;
    if (failedTextures.current.has(key)) return 'Failed';
    if (pendingTextures.current.has(key)) return 'Loading';
    return textureUrls.has(textureId) || projectNames[textureId] ? null : 'Missing';
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
        <MaterialAssetField value={override.materialId} takesAsset={material.takesAsset} materialType={material.type} onChange={(value) => editField(material.name, 'materialId', value)} />
        {override.materialId && (
          <MaterialParameterFields materialId={override.materialId} values={override.parameters} textures={textures}
            versions={assetShaderVersions(override.materialId, [{ id: model.id, materialOverrides: draft }], placedCopies ?? [])}
            onChange={(value) => editField(material.name, 'parameters', value)} />
        )}
        {override.materialId && <p className="text-2xs text-gray-500">Shaded by the material asset; the fields below apply again without one.</p>}
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
            found={foundTexture(override.mapTextureId, 'map', override.paintedMap === true)} onChange={(value) => editBaseMap(material.name, value)} />
        )}
        {base.hasMapSlot && override.mapTextureId && override.paintedMap && (
          <p className="pl-[6.5rem] text-2xs leading-snug text-gray-500">A painted picture: it shows its own colours, is cut out where it is see-through, and draws from both sides.</p>
        )}
        {base.hasNormalSlot && (
          <TextureField label="Normal map" value={override.normalTextureId} textures={textures} status={textureStatus(override.normalTextureId, 'normal')}
            found={foundTexture(override.normalTextureId, 'normal')} onChange={(value) => editField(material.name, 'normalTextureId', value)} />
        )}
        {base.hasRoughnessSlot && (
          <TextureField label="Roughness map" value={override.roughnessTextureId} textures={textures} status={textureStatus(override.roughnessTextureId, 'roughness')}
            found={foundTexture(override.roughnessTextureId, 'roughness')} onChange={(value) => editField(material.name, 'roughnessTextureId', value)} />
        )}
        {base.hasMetalnessSlot && (
          <TextureField label="Metalness map" value={override.metalnessTextureId} textures={textures} status={textureStatus(override.metalnessTextureId, 'metalness')}
            found={foundTexture(override.metalnessTextureId, 'metalness')} onChange={(value) => editField(material.name, 'metalnessTextureId', value)} />
        )}
        {base.physical && (
          <PhysicalFields values={base.physical} override={override}
            onChange={(field, value) => editField(material.name, field, value as MaterialOverride[typeof field])} />
        )}
        {material.instanceCount > 1 && (
          <p className="text-2xs text-gray-600 pt-1">Applies to {material.instanceCount} materials named “{material.name}”.</p>
        )}
      </div>
    );
  };

  return (
    <div className={`flex flex-col h-full min-h-0 bg-gray-900 text-gray-200 ${className}`}>
      <div className="p-3 border-b border-gray-800 shrink-0 space-y-2">
        <div className="flex items-center gap-2">
          <MaterialIcon size={14} className="text-blue-400 shrink-0" />
          <h2 className="text-xs font-bold ">Materials</h2>
          <span className="text-2xs text-gray-500 truncate" title={model.name}>{model.name}</span>
          <span className="ml-auto text-2xs text-gray-600 shrink-0">{materials.length}</span>
        </div>
        {materials.length > 6 && (
          <div className="relative">
            <SearchIcon size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
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
          // How a base map draws is part of the base map, not a field of its own.
          const fieldCount = override ? Object.keys(override).filter((field) => field !== 'paintedMap').length : 0;
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
                {isOpen ? <ChevronDownIcon size={12} className="text-gray-500 shrink-0" /> : <ChevronRightIcon size={12} className="text-gray-500 shrink-0" />}
                <span className="w-4 h-4 rounded border border-gray-700 shrink-0" style={{ backgroundColor: swatch }} aria-hidden />
                <span className={`flex-1 min-w-0 truncate text-xs ${editable ? 'text-gray-200' : reserved ? 'text-gray-500' : 'text-gray-600 italic'}`}>
                  {unnamed ? 'Unnamed material' : material.name}
                </span>
                {reserved && <span className="text-2xs font-bold text-amber-500/80 shrink-0">Reserved</span>}
                <span className="text-2xs text-gray-600 shrink-0">{material.type.replace(/^Mesh|Material$/g, '')}</span>
                {fieldCount > 0 && (
                  <span className="text-2xs font-bold text-blue-300 bg-blue-900/40 border border-blue-800/50 rounded px-1.5 shrink-0">{fieldCount}</span>
                )}
              </button>
              {isOpen && renderFields(material)}
            </div>
          );
        })}
        {staleNames.length > 0 && (
          <div className="mt-3 rounded-md border border-amber-900/50 bg-amber-900/10 p-2 space-y-1">
            <div className="text-2xs font-bold text-amber-400 flex items-center gap-1.5">
              <WarningIcon size={11} /> Overrides for materials not in this model
            </div>
            {staleNames.map((name) => (
              <div key={name} className="flex items-center gap-2 text-2xs text-gray-400">
                <span className="flex-1 truncate">{name}</span>
                <button
                  type="button"
                  onClick={() => setDraft((current) => { const next = { ...current }; delete next[name]; return next; })}
                  aria-label={`Remove overrides for ${name}`}
                  className="p-1 rounded hover:bg-gray-800 hover:text-white"
                >
                  <TrashIcon size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="p-3 border-t border-gray-800 shrink-0 space-y-2">
        {error && (
          <div role="alert" className="text-2xs text-red-400 bg-red-900/20 p-2 rounded border border-red-900/50 flex gap-2">
            <WarningIcon size={12} className="shrink-0 mt-0.5" /> <span className="flex-1">{error}</span>
          </div>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => { setError(null); setDraft(saved); }}
            disabled={!dirty || saving}
            className="flex-1 py-2 rounded-md bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-bold flex items-center justify-center gap-1.5 border border-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <UndoIcon size={12} /> Revert
          </button>
          {onSave ? (
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!dirty || saving}
              className="flex-1 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-accent-ink text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <SaveIcon size={12} /> {saving ? 'Saving…' : 'Save'}
            </button>
          ) : (
            <span className="flex-1 text-2xs text-gray-600 self-center text-center">Preview only — not saved</span>
          )}
        </div>
      </div>
    </div>
  );
};
