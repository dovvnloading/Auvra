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

  it('names the decoders bundled from inside three, with their license', () => {
    const notices = collectThirdPartyNotices(root);
    for (const library of ['Basis Universal transcoder', 'Draco 3D decoder']) {
      const section = notices.slice(notices.indexOf(`${library} (Apache-2.0), inside three@`));
      expect(section).toMatch(/^[^\n]+\n=+\n\nCopyright [^\n]+\n\n\s*Apache License\s+Version 2\.0/);
    }
  });

  it('credits Recast and Detour, compiled into the navmesh library, under the zlib license', () => {
    const notices = collectThirdPartyNotices(root);
    const section = notices.slice(notices.indexOf('Recast & Detour (Zlib), inside @recast-navigation/wasm@'));
    expect(section).toMatch(/^[^\n]+\n=+\n\nCopyright \(c\) 2009 Mikko Mononen[^\n]*\n\nThis software is provided 'as-is'/);
  });
});
