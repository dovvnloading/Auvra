export type EditorSessionPhase = 'closed' | 'transitioning' | 'ready';

export interface EditorSessionLease {
  readonly projectId: string | null;
  readonly generation: number;
  readonly levelId: string | null;
  readonly revision: number;
  readonly phase: EditorSessionPhase;
}

export interface EditorSessionTransition {
  readonly generation: number;
}

export interface EditorSessionReadyLease extends EditorSessionLease {
  readonly phase: 'ready';
}

export interface EditorProjectIdentity {
  readonly projectId: string | null;
  readonly revision: number;
}

export function selectObjectsForLevel<T extends { levelId: string }>(objects: readonly T[], levelId: string): T[] {
  return objects.filter((object) => object.levelId === levelId);
}

const CLOSED_LEASE: EditorSessionLease = Object.freeze({
  projectId: null,
  generation: 0,
  levelId: null,
  revision: 0,
  phase: 'closed' as const,
});

/**
 * Synchronous identity gate for the World Editor. It deliberately has no
 * React or host dependencies: delayed work captures a lease and proves that
 * every identity field still describes the current ready session before it
 * publishes a result.
 */
export class EditorSessionOwner {
  private currentLease: EditorSessionLease = CLOSED_LEASE;
  private currentTransition: EditorSessionTransition | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): EditorSessionLease => this.currentLease;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  };

  beginTransition(): EditorSessionTransition {
    const generation = this.currentLease.generation + 1;
    const transition = Object.freeze({ generation });
    this.currentTransition = transition;
    this.publish({
      projectId: null,
      generation,
      levelId: null,
      revision: 0,
      phase: 'transitioning',
    });
    return transition;
  }

  complete(
    transition: EditorSessionTransition,
    projectId: string,
    levelId: string | null,
    revision: number,
  ): EditorSessionReadyLease | null {
    if (!this.isTransitionCurrent(transition)) return null;
    if (!projectId) throw new Error('A ready World Editor session requires a project identity.');
    if (levelId !== null && !levelId) throw new Error('A level identity cannot be empty.');
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('A project revision must be a non-negative safe integer.');
    this.currentTransition = null;
    this.publish({ projectId, generation: transition.generation, levelId, revision, phase: 'ready' });
    return this.currentLease as EditorSessionReadyLease;
  }

  close(transition: EditorSessionTransition): EditorSessionLease | null {
    if (!this.isTransitionCurrent(transition)) return null;
    this.currentTransition = null;
    this.publish({
      projectId: null,
      generation: transition.generation,
      levelId: null,
      revision: 0,
      phase: 'closed',
    });
    return this.currentLease;
  }

  fail(transition: EditorSessionTransition): EditorSessionLease | null {
    // Failure is intentionally represented by the closed phase. A failed
    // transition cannot leave a lease that looks usable to delayed work.
    return this.close(transition);
  }

  /**
   * Advance only the revision of the currently ready project. Host status
   * events can arrive while a replacement transition is in flight; those are
   * intentionally ignored because the project identity is not established
   * until complete() publishes the new lease.
   */
  advanceRevision(projectId: string | null, revision: number): EditorSessionReadyLease | null {
    if (this.currentLease.phase !== 'ready' || !projectId || this.currentLease.projectId !== projectId) return null;
    if (!Number.isSafeInteger(revision) || revision < this.currentLease.revision) return null;
    if (revision === this.currentLease.revision) return this.currentLease as EditorSessionReadyLease;
    this.publish({ ...this.currentLease, revision, phase: 'ready' });
    return this.currentLease as EditorSessionReadyLease;
  }

  captureReady(): EditorSessionReadyLease | null {
    return this.currentLease.phase === 'ready' ? this.currentLease as EditorSessionReadyLease : null;
  }

  isCurrent(lease: EditorSessionLease | null | undefined): lease is EditorSessionReadyLease {
    if (!lease || this.currentLease.phase !== 'ready' || lease.phase !== 'ready') return false;
    return lease.projectId === this.currentLease.projectId
      && lease.generation === this.currentLease.generation
      && lease.levelId === this.currentLease.levelId
      && lease.revision === this.currentLease.revision;
  }

  requireCurrent(lease: EditorSessionLease | null | undefined): EditorSessionReadyLease {
    if (!this.isCurrent(lease)) throw new Error('World Editor session is no longer current.');
    return lease;
  }

  requireWritable(
    lease: EditorSessionLease | null | undefined,
    project: EditorProjectIdentity,
  ): EditorSessionReadyLease {
    const current = this.requireCurrent(lease);
    if (project.projectId !== current.projectId || project.revision !== current.revision) {
      throw new Error('World Editor project identity or revision changed before persistence.');
    }
    return current;
  }

  isSameSession(lease: EditorSessionLease | null | undefined): lease is EditorSessionReadyLease {
    if (!lease || this.currentLease.phase !== 'ready' || lease.phase !== 'ready') return false;
    return lease.projectId === this.currentLease.projectId
      && lease.generation === this.currentLease.generation
      && lease.levelId === this.currentLease.levelId;
  }

  requireSameSession(lease: EditorSessionLease | null | undefined): EditorSessionReadyLease {
    if (!this.isSameSession(lease)) throw new Error('World Editor session is no longer current.');
    return this.currentLease as EditorSessionReadyLease;
  }

  /**
   * Proves that an asynchronous replacement still belongs to the exact
   * transition which started it. The transition object is intentionally
   * identity based; matching a generation number alone would allow a caller
   * to forge a completion token.
   */
  isTransitionCurrent(transition: EditorSessionTransition | null | undefined): boolean {
    return Boolean(transition && this.currentLease.phase === 'transitioning'
      && this.currentTransition === transition);
  }

  private publish(next: EditorSessionLease): void {
    this.currentLease = Object.freeze({ ...next });
    for (const listener of [...this.listeners]) listener();
  }
}

export const editorSession: EditorSessionOwner = new EditorSessionOwner();
