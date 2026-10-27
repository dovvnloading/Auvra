import { describe, expect, it } from 'vitest';
import { classicFramePage } from '../../scripts/frames/classicFrames.mjs';

const built = `<!doctype html>
<html lang="en">
  <head>
    <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-eval';" />
    <script type="module" crossorigin src="/assets/hud-N71u0Dyl.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/_commonjsHelpers-C5lxYuLu.js">
    <link rel="stylesheet" crossorigin href="/assets/styles-DfxIFLv-.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

describe('classic sandbox frame pages', () => {
  it('drops module loads, keeps the stylesheet without crossorigin and runs the bundle last', () => {
    const page = classicFramePage(built, './assets/hud-frame-abc.js');
    expect(page).not.toMatch(/type="module"|modulepreload|crossorigin/);
    expect(page).toContain('<link rel="stylesheet" href="/assets/styles-DfxIFLv-.css">');
    expect(page).toContain('script-src \'self\' \'unsafe-eval\'');
    expect(page.indexOf('<div id="root"></div>')).toBeLessThan(page.indexOf('<script src="./assets/hud-frame-abc.js"></script>'));
  });

  it('can link a stylesheet the page did not have', () => {
    const page = classicFramePage('<html><head></head><body></body></html>', '/@auvra-frame/hud-frame.js', '/styles.css');
    expect(page).toContain('<link rel="stylesheet" href="/styles.css">');
    expect(page).toContain('<script src="/@auvra-frame/hud-frame.js"></script>');
  });
});
