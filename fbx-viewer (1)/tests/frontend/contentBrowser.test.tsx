import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { LoadedModelData, TextureData } from '../../types';

const scene: Record<string, unknown> = {};
vi.mock('../../context/SceneContext', () => ({ useScene: () => scene }));
vi.mock('../../context/NotificationContext', () => ({ useNotification: () => ({ addNotification: vi.fn() }) }));
vi.mock('../../components/UI/ThumbnailTooltip', () => ({ ThumbnailTooltip: () => null }));

import { ContentBrowser } from '../../components/UI/Browser/ContentBrowser';

const model = (id: string, name: string, folder?: string): LoadedModelData => ({
    id, name, url: '', object: new THREE.Group(), animations: [], category: 'Prop', isPlacedInScene: false, folder,
});

const resetScene = (overrides: Record<string, unknown> = {}) => {
    for (const key of Object.keys(scene)) delete scene[key];
    const texture: TextureData & { folder: string } = { id: 't1', name: 'Skin.png', url: '', dimensions: { width: 4, height: 4 }, folder: 'Characters/Enemies' };
    Object.assign(scene, {
        models: [model('m1', 'Knight.fbx', 'Characters'), model('m2', 'Crate.glb')],
        textures: [texture],
        audioAssets: [],
        blueprints: [],
        selectedModelId: null,
        isLoading: false,
        isCreatingPlayerBlueprint: false,
        projectStatus: { projectId: null },
        addModel: vi.fn(), addAnimations: vi.fn(), selectModel: vi.fn(), placeInScene: vi.fn(),
        selectBlueprint: vi.fn(), addBlueprint: vi.fn(), addTexture: vi.fn(), removeTexture: vi.fn(),
        addAudio: vi.fn(), removeAudio: vi.fn(),
        ...overrides,
    });
};

const dragCard = (name: string) => {
    const setData = vi.fn();
    const card = screen.getByText(name).closest('[draggable]') as HTMLElement;
    fireEvent.dragStart(card, { dataTransfer: { setData, effectAllowed: '' } });
    return setData;
};

describe('ContentBrowser folders', () => {
    beforeEach(() => resetScene());

    it('groups assets by folder and navigates into subfolders', () => {
        render(<ContentBrowser />);
        const grid = () => within(document.querySelector('.grid') as HTMLElement);
        expect(grid().getByText('Crate.glb')).toBeInTheDocument();
        expect(grid().queryByText('Knight.fbx')).toBeNull();
        fireEvent.click(grid().getByRole('button', { name: 'Open folder Characters' }));
        expect(grid().getByText('Knight.fbx')).toBeInTheDocument();
        expect(grid().getByRole('button', { name: 'Open folder Enemies' })).toBeInTheDocument();
        expect(grid().queryByText('Skin.png')).toBeNull();
    });

    it('searches the open folder recursively', () => {
        render(<ContentBrowser />);
        fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'skin' } });
        expect(screen.getByText('Skin.png')).toBeInTheDocument();
    });

    it('publishes the model id for viewport drops', () => {
        render(<ContentBrowser />);
        const setData = dragCard('Crate.glb');
        expect(setData).toHaveBeenCalledWith('application/x-auvra-model', 'm2');
        expect(setData).toHaveBeenCalledWith('application/x-auvra-asset', JSON.stringify({ kind: 'model', id: 'm2' }));
    });

    it('moves an asset dropped on a folder through the asset update path', () => {
        const updateModel = vi.fn();
        resetScene({ updateModel });
        render(<ContentBrowser />);
        const folderCard = screen.getByRole('button', { name: 'Open folder Characters' });
        fireEvent.drop(folderCard, {
            dataTransfer: { types: ['application/x-auvra-asset'], getData: () => JSON.stringify({ kind: 'model', id: 'm2' }) },
        });
        expect(updateModel).toHaveBeenCalledWith('m2', { folder: 'Characters' });
    });

    it('renames from the context menu and keeps the source extension', async () => {
        const updateModel = vi.fn();
        resetScene({ updateModel });
        render(<ContentBrowser />);
        fireEvent.contextMenu(screen.getByText('Crate.glb'));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
        const input = screen.getByRole('textbox', { name: 'Rename Crate.glb' });
        fireEvent.change(input, { target: { value: 'Barrel' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        await vi.waitFor(() => expect(updateModel).toHaveBeenCalledWith('m2', { name: 'Barrel.glb' }));
    });

    it('disables organization actions the context does not expose', () => {
        render(<ContentBrowser />);
        fireEvent.contextMenu(screen.getByText('Crate.glb'));
        expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeDisabled();
        expect(screen.getByRole('menuitem', { name: 'Reimport...' })).toBeDisabled();
    });

    it('creates a folder from the toolbar', () => {
        render(<ContentBrowser />);
        fireEvent.click(screen.getByRole('button', { name: /Folder/ }));
        const input = screen.getByRole('textbox', { name: 'New folder name' });
        fireEvent.change(input, { target: { value: 'Props' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(screen.getByRole('button', { name: 'Open folder Props' })).toBeInTheDocument();
    });
});
