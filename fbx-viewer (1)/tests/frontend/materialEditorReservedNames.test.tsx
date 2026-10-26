import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LoadedModelData } from '../../types';
import { MaterialEditor, isReservedMaterialName } from '../../components/Tools/MaterialEditor';

const schema = JSON.parse(readFileSync(path.resolve(__dirname, '../../../project/v1/models.schema.json'), 'utf8'));
const modelProperties = schema.properties.documents.items.properties;
// JSON Schema patterns are flag-less ECMA regular expressions.
const schemaPattern = new RegExp(schema.$defs.reservedMaterialName.pattern);

// The names tests/project/test_material_override_names.py holds the host to.
const RESERVED = [
  'Path', 'PATH', 'FilePath', 'FilesystemPath', 'sourcePath', 'AssetPath', 'DirectoryPath', 'AbsolutePath',
  'LocalPath', 'base64', 'Binary', 'Bytes', 'Blob',
  'Credential', 'Credentials', 'Secret', 'Token', 'API_KEY', 'api-key', 'ApiKey', 'Password',
  'Authorization', 'auth_header', 'AuthHeader', 'File', 'animationFiles', 'Object', 'URL',
];
const ALLOWED = ['Body', 'Path_Stone', 'Pathway', 'Tokens', 'Objects', 'File01', 'Metal Blob', 'position'];
const WORDS = [
  'path', 'filepath', 'filesystempath', 'sourcepath', 'assetpath', 'directorypath', 'absolutepath', 'localpath',
  'base64', 'binary', 'bytes', 'blob', 'credential', 'credentials', 'secret', 'token', 'apikey', 'api_key',
  'api-key', 'password', 'authorization', 'authheader', 'auth_header', 'auth-header', 'file', 'animationfiles',
  'object', 'url',
];
// Python's re.I (the host's blocklist flag) also folds these letters onto ASCII ones.
const FOLDS: Record<string, string[]> = { i: ['\u0130', '\u0131'], s: ['\u017f'], k: ['\u212a'] };

const corpus = (): string[] => {
  const names = new Set([...RESERVED, ...ALLOWED, '', 'api__key', 'auth--header', '\u0130', '\u212a']);
  for (const word of WORDS) {
    const title = word[0].toUpperCase() + word.slice(1);
    for (const name of [word, word.toUpperCase(), title, word.slice(0, -1), word + word, `${word}|${word}`, `Metal ${word}`]) names.add(name);
    [...word].forEach((letter, index) => {
      for (const replacement of [letter.toUpperCase(), ...(FOLDS[letter] ?? [])]) names.add(word.slice(0, index) + replacement + word.slice(index + 1));
    });
    for (const affix of ['\n', '\n\n', '\r', '\r\n', ' ', '_', 's', '0', '\t']) {
      names.add(word + affix);
      names.add(affix + word);
      names.add(title + affix);
    }
  }
  return [...names];
};

const modelWith = (...names: string[]) => {
  const root = new THREE.Group();
  for (const name of names) {
    const material = new THREE.MeshStandardMaterial({ color: 0x808080 });
    material.name = name;
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
  }
  const model: LoadedModelData & { materialOverrides?: unknown } = {
    id: 'model-1', name: 'Robot', url: '', object: root, animations: [], category: 'Prop', isPlacedInScene: true,
    materialOverrides: {},
  };
  return model;
};

describe('reserved material names', () => {
  it('match the models schema blocklist', () => {
    const reserved = { not: { $ref: '#/$defs/reservedMaterialName' } };
    expect(modelProperties.materialOverrides.propertyNames).toMatchObject(reserved);
    expect(modelProperties.textureOverrides.propertyNames).toMatchObject(reserved);
    for (const name of corpus()) expect([name, isReservedMaterialName(name)]).toEqual([name, schemaPattern.test(name)]);
  });

  it('cover the names the host refuses and no others', () => {
    for (const name of RESERVED) expect([name, isReservedMaterialName(name)]).toEqual([name, true]);
    for (const name of ALLOWED) expect([name, isReservedMaterialName(name)]).toEqual([name, false]);
    for (const name of ['Path\n', 'f\u0131le', 'F\u0130LE', '\u017fecret', 'To\u212aen']) expect(isReservedMaterialName(name)).toBe(true);
    for (const name of ['Path\n\n', '\nPath', 'Path\r', ' Path', 'Path ']) expect(isReservedMaterialName(name)).toBe(false);
  });

  it('are listed as not editable with the reason in a tooltip', () => {
    render(createElement(MaterialEditor, { model: modelWith('Body', 'Path', 'api-key'), textures: [] }));

    for (const name of ['Path', 'api-key']) {
      const row = screen.getByRole('button', { name: new RegExp(`^${name}`) });
      expect(row).toBeDisabled();
      expect(row).toHaveAttribute('aria-expanded', 'false');
      expect(row).toHaveAttribute('title', `Materials named \u201c${name}\u201d cannot be overridden: the project format reserves that name. Rename the material in the source file to edit it.`);
      fireEvent.click(row);
      expect(screen.queryByText('Roughness')).toBeNull();
    }
    expect(screen.getAllByText('Reserved')).toHaveLength(2);

    const body = screen.getByRole('button', { name: /^Body/ });
    expect(body).toBeEnabled();
    expect(body).not.toHaveAttribute('title');
    fireEvent.click(body);
    expect(body).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Roughness')).toBeInTheDocument();
  });
});
