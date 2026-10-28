import { describe, expect, it } from 'vitest';
import { EditorSessionOwner } from '../../utils/editorSession';

describe('editor session leases', () => {
  it('rejects stale completion after a replacement transition', () => {
    const owner = new EditorSessionOwner();
    const first = owner.beginTransition();
    expect(owner.complete(first, 'project-a', 'level-a', 1)).not.toBeNull();
    const replacement = owner.beginTransition();
    expect(owner.complete(first, 'stale-project', 'level', 2)).toBeNull();
    expect(owner.complete(replacement, 'project-b', 'level-b', 1)).not.toBeNull();
  });
  it('goes back to the open project when a replacement replaced nothing, with older leases still invalid', () => {
    const owner = new EditorSessionOwner();
    const open = owner.beginTransition();
    const ready = owner.complete(open, 'project-a', 'level-a', 3);
    const cancelled = owner.beginTransition();
    const back = owner.revert(cancelled, ready, 4);
    expect(back).toMatchObject({ projectId: 'project-a', levelId: 'level-a', revision: 4, phase: 'ready' });
    expect(owner.isCurrent(ready)).toBe(false);
    expect(owner.captureReady()?.projectId).toBe('project-a');
  });

  it('closes when there was no project to go back to', () => {
    const owner = new EditorSessionOwner();
    expect(owner.revert(owner.beginTransition(), null, 0)?.phase).toBe('closed');
  });
});
