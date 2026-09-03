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
});
