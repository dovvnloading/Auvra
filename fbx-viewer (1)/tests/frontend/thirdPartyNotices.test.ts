import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectThirdPartyNotices, productionPackages } from '../../scripts/licenses/notices.mjs';

const root = path.resolve(__dirname, '../..');

describe('third-party notices', () => {
  it('lists shipped dependencies but not development tools', () => {
    const names = productionPackages(root).map(item => item.name);
    expect(names).toContain('three');
    expect(names).toContain('react');
    expect(names).not.toContain('vitest');
    expect(names).not.toContain('typescript');
  });

  it('includes license text and never a runtime CDN URL', () => {
    const notices = collectThirdPartyNotices(root);
    expect(notices).toMatch(/three@[\d.]+ \(MIT\)/);
    expect(notices).toMatch(/Permission is hereby granted/);
    expect(notices).not.toMatch(/https?:\/\/(cdn\.jsdelivr\.net|unpkg\.com|esm\.sh|fonts\.googleapis\.com|fonts\.gstatic\.com)/i);
  });
});
