import type { LevelComponent } from '../types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Object-scoped mappings: component IDs are meaningful only on their owning object. */
export type ParticleCueTargets = Map<string, { objectId: string; emitters: Map<string, string> }>;

/** Record corresponding emitters from two lists whose component slots match. */
export function recordParticleTargets(
  targets: ParticleCueTargets, oldId: string, newId: string,
  source: readonly LevelComponent[] = [], destination: readonly LevelComponent[] = [],
): void {
  const emitters = new Map<string, string>();
  source.forEach((component, index) => {
    const target = destination[index];
    if (component.type === 'particles' && target?.type === 'particles') emitters.set(component.id, target.id);
  });
  targets.set(oldId, { objectId: newId, emitters });
}

/** Internal cues follow their copy; references outside the supplied subtree retain their binding. */
export function remapParticleCues(components: LevelComponent[], targets: ParticleCueTargets): LevelComponent[] {
  return components.map(component => {
    const timeline = component.props?.timeline;
    if (component.type !== 'timeline' || !isRecord(timeline) || !Array.isArray(timeline.tracks)) return component;
    const tracks = timeline.tracks.map(track => {
      if (!isRecord(track) || track.kind !== 'particle' || typeof track.objectId !== 'string') return track;
      const next = targets.get(track.objectId);
      if (!next) return track;
      const componentId = typeof track.componentId === 'string' ? next.emitters.get(track.componentId) : undefined;
      return { ...track, objectId: next.objectId, ...(componentId === undefined ? {} : { componentId }) };
    });
    return { ...component, props: { ...component.props, timeline: { ...timeline, tracks } } };
  });
}

/** Replace this object's component IDs and retarget particle event links to the corresponding sibling. */
export function rekeyComponents(
  components: readonly LevelComponent[],
  idFor: (component: LevelComponent, index: number) => string,
): LevelComponent[] {
  // Allocate IDs first so an emitter can reference a sibling appearing later in the list.
  const ids = components.map(idFor);
  const targets = new Map<string, string>();
  components.forEach((component, i) => {
    if (component.type === 'particles') targets.set(component.id, ids[i]);
  });
  return components.map((component, index) => {
    const result = { ...component, id: ids[index] };
    if (component.type !== 'particles') return result;
    const { props } = component;
    const effect = props?.effect;
    if (!isRecord(effect) || !Array.isArray(effect.subEmitters)) return result;
    const subEmitters = effect.subEmitters.map((link: unknown) => {
      if (!isRecord(link) || typeof link.target !== 'string') return link;
      const target = targets.get(link.target);
      return target === undefined ? link : { ...link, target };
    });
    return { ...result, props: { ...props, effect: { ...effect, subEmitters } } };
  });
}
