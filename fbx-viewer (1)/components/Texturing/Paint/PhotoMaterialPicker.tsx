import React, { useImperativeHandle, useRef, useState } from 'react';
import { frontendDiagnostics } from '../../../diagnostics/runtime';
import type { MaterialAsset } from '../../../runtime/materials/materialLibrary';
import { useTextureStore } from '../useTextureStore';
import { PHOTO_ACCEPT, createPhotoMaterial, isPhotoFile } from './photoImport';

/** What a photo material picker offers: choosing a photo, or taking dropped files. */
export interface PhotoMaterialPickerHandle {
    pick: () => void;
    /** Makes a material of the first photo among `files`; false when none is a photo. */
    take: (files: FileList | readonly File[]) => boolean;
}

/**
 * Makes a texture graph material from a photo, chosen or dropped (photoImport.createPhotoMaterial), and
 * says how it goes on a line of its own while it does.
 */
export const PhotoMaterialPicker = React.forwardRef<PhotoMaterialPickerHandle, { onMade: (asset: MaterialAsset) => void; className?: string }>(({ onMade, className = '' }, ref) => {
    const input = useRef<HTMLInputElement>(null);
    const { store } = useTextureStore();
    const [status, setStatus] = useState<string | null>(null);
    const make = (file: File) => {
        setStatus(`Making a material from ${file.name}…`);
        void createPhotoMaterial(file, store).then((asset) => {
            setStatus(null);
            onMade(asset);
        }, (error: unknown) => {
            frontendDiagnostics.failure('photo_material_failed', error);
            setStatus(error instanceof Error ? error.message : 'The photo could not be made into a material.');
        });
    };
    useImperativeHandle(ref, () => ({
        pick: () => input.current?.click(),
        take: (files) => {
            const photo = Array.from(files).find(isPhotoFile);
            if (!photo) return false;
            make(photo);
            return true;
        },
    }));
    return (
        <>
            <input ref={input} type="file" accept={PHOTO_ACCEPT} className="hidden" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) make(file); }} />
            {status && <p className={`text-2xs leading-snug text-zinc-400 ${className}`} role="status">{status}</p>}
        </>
    );
});
PhotoMaterialPicker.displayName = 'PhotoMaterialPicker';
