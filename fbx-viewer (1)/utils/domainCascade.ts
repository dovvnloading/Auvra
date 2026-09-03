export type DomainCascadeKind = 'model' | 'texture' | 'audio';

export interface DomainCascadeEvent {
  kind: DomainCascadeKind;
  id: string;
  projectId: string;
}

type DomainCascadeListener = (event: DomainCascadeEvent) => void;

const listeners = new Set<DomainCascadeListener>();

/**
 * Publish host-side referential-delete cascades to providers that are lower
 * in the React tree than the asset provider. The event is deliberately
 * project-scoped so a late delete from a replaced project cannot mutate the
 * newly opened editor session.
 */
export const emitDomainCascade = (event: DomainCascadeEvent): void => {
  for (const listener of [...listeners]) listener(event);
};

export const subscribeDomainCascade = (listener: DomainCascadeListener): (() => void) => {
  listeners.add(listener);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    listeners.delete(listener);
  };
};
