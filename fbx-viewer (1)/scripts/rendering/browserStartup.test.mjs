import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { launchBrowser } from './browser.mjs';

const endpoint = 'ws://127.0.0.1:43210/devtools/browser/00000000-0000-0000-0000-000000000000';

test('retries a failed Chromium startup with a separate profile', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'auvra-browser-start-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'fake-browser.mjs');
  writeFileSync(script, [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "const marker = path.join(path.dirname(process.argv[2]), 'launched-once');",
    "if (!existsSync(marker)) {",
    "  writeFileSync(marker, '1');",
    "  console.error('temporary launch failure');",
    "  process.exit(23);",
    "}",
    "console.error('DevTools listening on " + endpoint + "');",
    "setInterval(() => {}, 1000);",
  ].join('\n'));
  const { browser, endpoint: actual } = await launchBrowser({
    executable: process.execPath,
    argsForProfile: (profile) => [script, profile],
    profileDir: root,
    attempts: 2,
    timeoutMs: 3000,
  });
  try {
    assert.equal(actual, endpoint);
    assert.ok(existsSync(path.join(root, 'launched-once')));
  } finally {
    const exited = new Promise((resolve) => browser.once('exit', resolve));
    browser.kill();
    await exited;
  }
});

test('reports both failed starts with Chromium stderr', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'auvra-browser-fail-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'broken-browser.mjs');
  writeFileSync(script, "console.error('Chromium cannot allocate memory'); process.exit(27);");
  await assert.rejects(
    launchBrowser({
      executable: process.execPath,
      argsForProfile: (profile) => [script, profile],
      profileDir: root,
      attempts: 2,
      timeoutMs: 3000,
    }),
    (error) => {
      assert.match(error.message, /Attempt 1:/);
      assert.match(error.message, /Attempt 2:/);
      assert.equal(error.message.split('Chromium cannot allocate memory').length - 1, 2);
      return true;
    },
  );
});
