import React, { useImperativeHandle, useRef, useState } from 'react';
import { PackageIcon } from '../UI/Icons';
import { IconButton } from '../UI/kit';
import { useAssets } from '../../context/AssetContext';
import { useNotification } from '../../context/NotificationContext';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { materialLibrary, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import { textureSettingsOf } from '../../texturing/textureSettings';
import { download } from '../../texturing/zip';
import {
    MaterialPackageError, PACKAGE_EXTENSION, packageFileStem, packageFromLibrary, packageFromProject, packageIntoLibrary, readMaterialPackage, writeMaterialPackage,
} from '../../utils/materialPackage';
import { projectService } from '../../utils/projectService';
import { userMaterialLibrary, type LibraryEntry } from '../../utils/userMaterialLibrary';
import { bringMaterialIn } from '../../utils/userMaterialLibraryActions';
import { renderMaterialBall } from './materialBalls';
import { useProjectTarget } from './projectTarget';

/**
 * Material packages in the Materials tab (utils/materialPackage.ts): a material published as one .auvramat file
 * (its texture graph with its parameters and presets, its pictures, the graphs it uses as nodes and its ball),
 * from the project or from My library, and such a file read into the project or into My library.
 */

const PACKAGE_WORDS = 'one .auvramat file, with its pictures and the graphs it uses as nodes';

/** Writes a project material as a material package. */
export const MaterialPackageExportButton: React.FC<{ asset: MaterialAsset }> = ({ asset }) => {
    const { textures } = useAssets();
    const { addNotification } = useNotification();
    const [writing, setWriting] = useState(false);
    const write = async () => {
        setWriting(true);
        try {
            const current = materialLibrary.get(asset.id) ?? asset;
            const pkg = await packageFromProject(current, {
                textures,
                settingsOf: textureSettingsOf,
                read: async (url) => (await fetch(url)).blob(),
                materialOf: (id) => materialLibrary.get(id),
            }, renderMaterialBall);
            download(await writeMaterialPackage(pkg), `${packageFileStem(current.name)}${PACKAGE_EXTENSION}`);
            addNotification({ message: `"${current.name}" is written as a material package, ready for another project or someone else's library.`, type: 'success' });
        } catch (failure) {
            frontendDiagnostics.failure('material_package_export_failed', failure);
            addNotification({ message: `"${asset.name}" could not be written as a material package.`, type: 'error' });
        } finally {
            setWriting(false);
        }
    };
    return (
        <IconButton label={writing ? 'Writing the material package…' : `Publish as a material package: ${PACKAGE_WORDS}`} disabled={writing} onClick={() => void write()}>
            <PackageIcon size={14} />
        </IconButton>
    );
};

/** Writes a My library material as a material package. */
export const useExportLibraryPackage = () => {
    const { addNotification } = useNotification();
    return async (entry: LibraryEntry): Promise<void> => {
        try {
            const pkg = packageFromLibrary(entry, await userMaterialLibrary().pictures(entry.id));
            download(await writeMaterialPackage(pkg), `${packageFileStem(entry.name)}${PACKAGE_EXTENSION}`);
            addNotification({ message: `"${entry.name}" is written as a material package.`, type: 'success' });
        } catch (failure) {
            frontendDiagnostics.failure('material_package_export_failed', failure);
            addNotification({ message: `"${entry.name}" could not be written as a material package.`, type: 'error' });
        }
    };
};

export interface MaterialPackageImportHandle { pick(): void }

const readFailure = (failure: unknown): string => (failure instanceof MaterialPackageError ? failure.message : 'The material package could not be read.');

/**
 * A hidden file picker reading a material package into the open project (`into` 'project': the material, its
 * node graphs and its pictures become the project's own) or into My library. `pick` opens it.
 */
export const MaterialPackageImport = React.forwardRef<MaterialPackageImportHandle, {
    into: 'project' | 'library';
    onProjectMaterial?: (asset: MaterialAsset) => void;
    onLibraryEntry?: (entry: LibraryEntry) => void;
}>(({ into, onProjectMaterial, onLibraryEntry }, ref) => {
    const input = useRef<HTMLInputElement>(null);
    const projectTarget = useProjectTarget();
    const { addNotification } = useNotification();
    useImperativeHandle(ref, () => ({ pick: () => input.current?.click() }), []);

    const read = async (file: File) => {
        let pkg: Awaited<ReturnType<typeof readMaterialPackage>>;
        try {
            pkg = await readMaterialPackage(file);
        } catch (failure) {
            if (!(failure instanceof MaterialPackageError)) frontendDiagnostics.failure('material_package_read_failed', failure);
            addNotification({ message: readFailure(failure), type: 'error' });
            return;
        }
        const graphs = pkg.nodeGraphs.length ? `, with the ${pkg.nodeGraphs.length === 1 ? 'graph' : `${pkg.nodeGraphs.length} graphs`} it uses as nodes` : '';
        try {
            if (into === 'library') {
                const entry = await packageIntoLibrary(userMaterialLibrary(), pkg);
                onLibraryEntry?.(entry);
                addNotification({ message: `"${entry.name}" is in your library${graphs}, for every project.`, type: 'success' });
                return;
            }
            const target = projectTarget();
            if (!target) {
                addNotification({ message: 'Open a project to bring a material package into it.', type: 'error' });
                return;
            }
            projectService.assertWritable();
            const asset = await bringMaterialIn(pkg, target);
            onProjectMaterial?.(asset);
            addNotification({ message: `"${asset.name}" is in this project${graphs}. Its parameters are live: change them on the material.`, type: 'success' });
        } catch (failure) {
            frontendDiagnostics.failure('material_package_import_failed', failure);
            addNotification({
                message: failure instanceof Error && failure.message.includes('read-only') ? 'This project is read-only.' : `"${pkg.name}" could not be brought into ${into === 'library' ? 'your library' : 'this project'}.`,
                type: 'error',
            });
        }
    };

    return (
        <input ref={input} type="file" hidden aria-hidden accept={`${PACKAGE_EXTENSION},application/zip`}
            onChange={(event) => {
                const picked = event.target.files?.[0];
                event.target.value = '';
                if (picked) void read(picked);
            }} />
    );
});
MaterialPackageImport.displayName = 'MaterialPackageImport';
