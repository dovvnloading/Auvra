import { describe, expect, it } from 'vitest';
import {
    ASSET_DRAG_TYPE,
    MODEL_FILE_ACCEPT,
    childFolderPaths,
    collectFolderPaths,
    decodeAssetDrag,
    depthFirstFolderOrder,
    encodeAssetDrag,
    folderLeafName,
    hasAssetDrag,
    isModelFileName,
    isWithinFolder,
    normalizeFolderPath,
    parentFolderPath,
    splitAssetName,
    validateAssetRename,
    validateNewFolderName,
} from '../../components/UI/Browser/browserFolders';

describe('content browser folder paths', () => {
    it('normalizes stored folder values to a canonical path', () => {
        expect(normalizeFolderPath(undefined)).toBe('');
        expect(normalizeFolderPath('  ')).toBe('');
        expect(normalizeFolderPath('/Characters//Enemies/ ')).toBe('Characters/Enemies');
        expect(normalizeFolderPath('Props\\Crates')).toBe('Props/Crates');
        expect(normalizeFolderPath('A/../B/./C')).toBe('A/B/C');
    });

    it('derives the folder tree from asset folders, ancestors included', () => {
        const paths = collectFolderPaths(['Characters/Enemies', undefined, '', 'Props', 'characters/Enemies/Bosses']);
        expect(paths).toEqual(['Characters', 'characters', 'Characters/Enemies', 'characters/Enemies', 'characters/Enemies/Bosses', 'Props']);
        expect(childFolderPaths(paths, '')).toEqual(['Characters', 'characters', 'Props']);
        expect(childFolderPaths(paths, 'Characters')).toEqual(['Characters/Enemies']);
        expect(parentFolderPath('Characters/Enemies')).toBe('Characters');
        expect(parentFolderPath('Props')).toBe('');
        expect(folderLeafName('Characters/Enemies')).toBe('Enemies');
        expect(folderLeafName('')).toBe('Content');
    });

    it('lists folders depth first for indented menus', () => {
        const paths = collectFolderPaths(['A/B', 'A B', 'AB', 'A/B/C']);
        expect(depthFirstFolderOrder(paths)).toEqual(['A', 'A/B', 'A/B/C', 'A B', 'AB']);
    });

    it('matches assets to folders directly or recursively', () => {
        expect(isWithinFolder(undefined, '', false)).toBe(true);
        expect(isWithinFolder('Props', '', false)).toBe(false);
        expect(isWithinFolder('Props', '', true)).toBe(true);
        expect(isWithinFolder('Props/Crates', 'Props', true)).toBe(true);
        expect(isWithinFolder('PropsExtra', 'Props', true)).toBe(false);
        expect(isWithinFolder('Props/Crates', 'Props', false)).toBe(false);
    });

    it('validates new folder names and reuses an existing sibling', () => {
        expect(validateNewFolderName('  ', '', [])).toEqual({ ok: false, error: 'Folder name is required.' });
        expect(validateNewFolderName('a/b', '', []).ok).toBe(false);
        expect(validateNewFolderName('..', '', []).ok).toBe(false);
        expect(validateNewFolderName(' Enemies ', 'Characters', ['Characters'])).toEqual({ ok: true, path: 'Characters/Enemies', existed: false });
        expect(validateNewFolderName('enemies', 'Characters', ['Characters/Enemies'])).toEqual({ ok: true, path: 'Characters/Enemies', existed: true });
        expect(validateNewFolderName('x'.repeat(300), '', []).ok).toBe(false);
    });
});

describe('content browser asset names', () => {
    it('splits names into stem and source extension', () => {
        expect(splitAssetName('Crate.glb')).toEqual({ stem: 'Crate', extension: '.glb' });
        expect(splitAssetName('archive.tar.gz')).toEqual({ stem: 'archive.tar', extension: '.gz' });
        expect(splitAssetName('Character v1.2')).toEqual({ stem: 'Character v1.2', extension: '' });
        expect(splitAssetName('.hidden')).toEqual({ stem: '.hidden', extension: '' });
    });

    it('keeps the extension through a rename and rejects collisions', () => {
        expect(validateAssetRename('tree.glb', 'Oak', ['tree.glb'])).toEqual({ ok: true, name: 'Oak.glb', changed: true });
        expect(validateAssetRename('tree.glb', 'Oak.GLB', [])).toEqual({ ok: true, name: 'Oak.glb', changed: true });
        expect(validateAssetRename('tree.glb', ' tree ', [])).toEqual({ ok: true, name: 'tree.glb', changed: false });
        expect(validateAssetRename('tree.glb', '', [])).toEqual({ ok: false, error: 'Name is required.' });
        expect(validateAssetRename('tree.glb', 'a/b', []).ok).toBe(false);
        expect(validateAssetRename('tree.glb', 'Rock', ['tree.glb', 'rock.glb'])).toEqual({ ok: false, error: 'An asset named "Rock.glb" already exists.' });
        expect(validateAssetRename('Tree', 'Oak', [])).toEqual({ ok: true, name: 'Oak', changed: true });
    });

    it('recognizes every supported model format', () => {
        for (const name of ['a.fbx', 'b.GLB', 'c.gltf', 'd.obj']) expect(isModelFileName(name)).toBe(true);
        expect(isModelFileName('e.png')).toBe(false);
        expect(MODEL_FILE_ACCEPT.split(',')).toEqual(expect.arrayContaining(['.fbx', '.glb', '.gltf', '.obj', 'model/gltf-binary']));
    });
});

describe('content browser drag payloads', () => {
    it('round-trips valid payloads and rejects malformed ones', () => {
        expect(decodeAssetDrag(encodeAssetDrag({ kind: 'texture', id: 't1' }))).toEqual({ kind: 'texture', id: 't1' });
        expect(decodeAssetDrag('not json')).toBeNull();
        expect(decodeAssetDrag(JSON.stringify({ kind: 'blueprint', id: 'b1' }))).toBeNull();
        expect(decodeAssetDrag(JSON.stringify({ kind: 'model', id: '' }))).toBeNull();
        expect(hasAssetDrag(['Files', ASSET_DRAG_TYPE])).toBe(true);
        expect(hasAssetDrag(['Files'])).toBe(false);
    });
});
