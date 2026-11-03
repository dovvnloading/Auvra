import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { useScene } from '../../../context/SceneContext';
import type { LoadedModelData } from '../../../types';
import { CORE_ROLES, humanoidRoles } from '../../../utils/retargeting';
import { ALL_BONE_ROLES, boneInfluences, roleLabel, setSkeletonView, skeletonBones, useSkeletonView } from '../../../utils/skeletonView';
import { AutoRigPanel } from './AutoRigPanel';
import { Button, TextInput } from '../kit';
import { Select } from '../Select';

const NO_ROLE = 'none';

const Check: React.FC<{ label: string; checked: boolean; onChange: (checked: boolean) => void }> = ({ label, checked, onChange }) => (
  <label className="flex h-6 cursor-pointer items-center gap-2 text-xs text-ink-2">
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-3.5 w-3.5 shrink-0 accent-blue-500" />
    {label}
  </label>
);

const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex flex-1 items-center justify-center p-8 text-center text-xs text-ink-3">{children}</div>
);

const BoneTree: React.FC<{ model: LoadedModelData }> = ({ model }) => {
  const { updateModelBoneRoles, reimportModel, addSocket, projectStatus } = useScene();
  const [filter, setFilter] = useState('');
  const [closed, setClosed] = useState<ReadonlySet<number>>(new Set());
  const [rolesChanged, setRolesChanged] = useState(false);
  const view = useSkeletonView();
  const bones = useMemo(() => skeletonBones(model.object), [model.object]);
  const influences = useMemo(() => boneInfluences(model.object), [model.object]);
  const roles = useMemo(() => humanoidRoles(bones.map((entry) => entry.bone), model.object, model.boneRoles), [bones, model.object, model.boneRoles]);
  const canEdit = !projectStatus.readOnly;

  // A bone picked on another model means nothing on this one.
  useEffect(() => {
    setSkeletonView({ selectedBone: null });
    setRolesChanged(false);
  }, [model.id]);

  const missing = useMemo(() => {
    const found = new Set(roles.values());
    return CORE_ROLES.filter((role) => !found.has(role));
  }, [roles]);

  const shown = useMemo(() => {
    const words = filter.trim().toLowerCase();
    if (words) {
      return bones.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.name.toLowerCase().includes(words) || (roles.get(entry.bone) ?? '').toLowerCase().includes(words));
    }
    // Without a search, a closed bone hides what hangs from it.
    const rows: { entry: (typeof bones)[number]; index: number }[] = [];
    const hidden = new Set<number>();
    bones.forEach((entry, index) => {
      if (entry.parent >= 0 && (hidden.has(entry.parent) || closed.has(entry.parent))) {
        hidden.add(index);
        return;
      }
      rows.push({ entry, index });
    });
    return rows;
  }, [bones, closed, filter, roles]);

  const picked = view.selectedBone ? bones.find((entry) => entry.name === view.selectedBone) : undefined;
  const pickedRole = picked ? roles.get(picked.bone) ?? NO_ROLE : NO_ROLE;

  const setRole = async (role: string) => {
    if (!picked) return;
    const others = (model.boneRoles ?? []).filter((stored) => stored.bone !== picked.name);
    await updateModelBoneRoles(model.id, [...others, { role: role === NO_ROLE ? '' : role, bone: picked.name }]);
    setRolesChanged(true);
  };

  return (
    <>
      <div className="shrink-0 space-y-1 border-b border-line px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs font-medium text-ink" title={model.name}>{model.name}</span>
          <span className="shrink-0 text-2xs tabular-nums text-ink-3">{bones.length.toLocaleString()} bones</span>
        </div>
        <div className="flex items-center gap-4">
          <Check label="Show bones" checked={view.showSkeleton} onChange={(showSkeleton) => setSkeletonView({ showSkeleton })} />
          <Check label="Show weights" checked={view.showWeights} onChange={(showWeights) => setSkeletonView({ showWeights })} />
        </div>
        {view.showWeights && (
          <div className="flex items-center gap-2 text-2xs text-ink-3">
            <span>None</span>
            <span className="h-1.5 flex-1 rounded-sm" style={{ background: 'linear-gradient(90deg, #0d1229, #0d40d9, #1ad966, #f2261a)' }} />
            <span>All</span>
          </div>
        )}
        <p className={`text-2xs ${missing.length ? 'text-amber-400' : 'text-ink-3'}`}>
          {missing.length
            ? `Clips from other rigs need: ${missing.map(roleLabel).join(', ')}. Pick a bone and say what it is.`
            : 'Reads as a humanoid, so clips from other rigs can play on it.'}
        </p>
        <TextInput aria-label="Search bones" placeholder="Search bones" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto py-0.5 custom-scrollbar" role="tree" aria-label="Bones">
        {shown.map(({ entry, index }) => {
          const isOpen = !closed.has(index);
          const role = roles.get(entry.bone);
          const isPicked = view.selectedBone === entry.name;
          return (
            <li key={`${entry.name}:${index}`} role="treeitem" aria-selected={isPicked} aria-expanded={entry.children ? isOpen : undefined}>
              <div
                className={`flex h-[22px] cursor-pointer items-center gap-1 pr-3 text-2xs ${isPicked ? 'bg-accent/20 text-ink' : 'text-ink-2 hover:bg-white/5'}`}
                style={{ paddingLeft: filter ? 12 : 8 + entry.depth * 10 }}
                onClick={() => setSkeletonView({ selectedBone: entry.name })}
              >
                {!filter && entry.children > 0 ? (
                  <button
                    type="button"
                    aria-label={isOpen ? `Close ${entry.name}` : `Open ${entry.name}`}
                    className="flex h-4 w-3 shrink-0 items-center justify-center text-ink-3 hover:text-ink"
                    onClick={(event) => {
                      event.stopPropagation();
                      setClosed((previous) => {
                        const next = new Set(previous);
                        if (next.has(index)) next.delete(index); else next.add(index);
                        return next;
                      });
                    }}
                  >
                    {isOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  </button>
                ) : <span className="w-3 shrink-0" />}
                <span className="min-w-0 flex-1 truncate" title={entry.name}>{entry.name}</span>
                {role && <span className="shrink-0 text-ink-3">{roleLabel(role)}</span>}
              </div>
            </li>
          );
        })}
        {shown.length === 0 && <li className="px-3 py-1 text-2xs text-ink-3">No bone has that name.</li>}
      </ul>

      {(picked || rolesChanged) && (
        <div className="shrink-0 space-y-1.5 border-t border-line px-3 py-2">
          {picked && (
            <>
              <div className="flex items-center justify-between gap-2 text-2xs">
                <span className="min-w-0 truncate font-medium text-ink" title={picked.name}>{picked.name}</span>
                <span className="shrink-0 tabular-nums text-ink-3">
                  {(influences.get(picked.name) ?? 0) > 0 ? `moves ${influences.get(picked.name)!.toLocaleString()} vertices` : 'moves no vertices itself'}
                </span>
              </div>
              {canEdit && (
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-2xs text-ink-3">This bone is</span>
                  <Select
                    value={pickedRole}
                    onChange={(value: string) => { void setRole(value); }}
                    options={[{ label: 'Nothing in particular', value: NO_ROLE }, ...ALL_BONE_ROLES.map((role) => ({ label: roleLabel(role), value: role }))]}
                    className="min-w-0 flex-1"
                  />
                </div>
              )}
              {canEdit && (
                <Button size="sm" icon={<Plus size={12} />} onClick={() => addSocket(model.id, `Socket_${picked.name}`, picked.name)}>Add a socket here</Button>
              )}
            </>
          )}
          {rolesChanged && canEdit && (
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 text-2xs text-ink-3">Clips from other rigs were made before this change.</span>
              <Button size="sm" onClick={() => { setRolesChanged(false); void reimportModel(model.id); }}>Make them again</Button>
            </div>
          )}
        </div>
      )}
    </>
  );
};

/** The selected model's skeleton: its bones as a tree, what each is for, and what each moves. */
export const SkeletonPanel: React.FC = () => {
  const { models, selectedModelId } = useScene();
  const model = models.find((candidate) => candidate.id === selectedModelId);
  const hasBones = useMemo(() => (model ? skeletonBones(model.object).length > 0 : false), [model]);
  if (!model) return <Empty>Select a model to see its skeleton.</Empty>;
  if (!hasBones) return <AutoRigPanel model={model} />;
  return <BoneTree key={model.id} model={model} />;
};
