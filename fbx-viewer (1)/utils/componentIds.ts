import type { LevelComponent } from '../types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

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
