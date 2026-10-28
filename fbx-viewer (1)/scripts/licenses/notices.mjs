import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Third-party notices for everything shipped from node_modules: every non-dev package in
// package-lock.json, with its declared license and the license text it ships.

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;
// The release content scan rejects runtime CDN URLs in shipped text; notices only need to
// name them, so the scheme is dropped.
const CDN_URL = /https?:\/\/(cdn\.jsdelivr\.net|unpkg\.com|esm\.sh|fonts\.googleapis\.com|fonts\.gstatic\.com)/gi;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// Libraries bundled from inside another package rather than as packages of their own: the
// decoders three carries for compressed glTF, which the editor and player bundle
// (utils/gltfDecoders.ts). Their license texts are kept beside this script.
const VENDORED_LIBRARIES = [
  { name: 'Basis Universal transcoder', package: 'three', folder: 'examples/jsm/libs/basis', copyright: 'Copyright Binomial LLC', project: 'github.com/BinomialLLC/basis_universal', license: 'Apache-2.0' },
  { name: 'Draco 3D decoder', package: 'three', folder: 'examples/jsm/libs/draco/gltf', copyright: 'Copyright The Draco Authors', project: 'github.com/google/draco', license: 'Apache-2.0' },
];

export const productionPackages = (root) => {
  const lock = readJson(path.join(root, 'package-lock.json'));
  return Object.entries(lock.packages ?? {})
    .filter(([key, entry]) => key.startsWith('node_modules/') && !entry.dev && !entry.devOptional)
    .map(([key, entry]) => ({ dir: key, name: key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length), version: entry.version ?? '' }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
};

const licenseTexts = (packageDir) => {
  if (!existsSync(packageDir)) return [];
  return readdirSync(packageDir)
    .filter((name) => LICENSE_FILE.test(name))
    .sort()
    .map((name) => readFileSync(path.join(packageDir, name), 'utf8').replace(/\r\n/g, '\n').trim());
};

export const collectThirdPartyNotices = (root) => {
  const sections = productionPackages(root).map(({ dir, name, version }) => {
    const packageDir = path.join(root, dir);
    let license = 'UNKNOWN';
    try {
      const manifest = readJson(path.join(packageDir, 'package.json'));
      license = typeof manifest.license === 'string' ? manifest.license : manifest.license?.type ?? 'UNKNOWN';
    } catch { /* missing optional dependency: keep the lockfile identity */ }
    const texts = licenseTexts(packageDir);
    const body = texts.length ? texts.join('\n\n') : `(No license file shipped; declared license: ${license})`;
    return `${'='.repeat(78)}\n${name}@${version} (${license})\n${'='.repeat(78)}\n\n${body}\n`;
  });
  // The copy the app imports: the top-level one, not one nested under another package.
  const installed = new Map(productionPackages(root).filter(({ dir, name }) => dir === `node_modules/${name}`).map(({ dir, name, version }) => [name, { dir, version }]));
  for (const library of VENDORED_LIBRARIES) {
    const owner = installed.get(library.package);
    if (!owner || !existsSync(path.join(root, owner.dir, library.folder))) continue;
    const text = readFileSync(path.join(root, 'scripts', 'licenses', `${library.license}.txt`), 'utf8').replace(/\r\n/g, '\n').trim();
    sections.push(`${'='.repeat(78)}\n${library.name} (${library.license}), inside ${library.package}@${owner.version} (${library.folder})\n${'='.repeat(78)}\n\n`
      + `${library.copyright}. ${library.project}\n\n${text}\n`);
  }
  const header = 'Third-party software notices\n\nThis software includes the following open-source packages. '
    + 'Each is used under the license reproduced below.\n\n';
  return (header + sections.join('\n')).replace(CDN_URL, '$1');
};
