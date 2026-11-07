import React, { useEffect, useMemo, useSyncExternalStore } from 'react';
import { GraphIcon } from '../UI/Icons';
import { useAssets } from '../../context/AssetContext';
import { materialAssetUse, materialLibrary, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import { BallShelf, ballLook } from './ballShelf';
import { textureSettingsOf } from '../../texturing/textureSettings';
import type { TextureData } from '../../types';
import { renderMaterialBall, type BallPictureSource } from './materialBalls';

/**
 * BALLS FOR THE PROJECT'S MATERIALS
 *
 * Each material in the Materials tab's list shows its ball, drawn as My library's are (materialBalls.ts: on the engine's
 * material path) from the project's textures. A ball is drawn again when what the material draws with changes (its
 * graph, its pictures, or a texture it names arriving), once edits have settled, one at a time.
 */

let shelf: BallShelf | null = null;
const projectShelf = (): BallShelf => {
    shelf ??= new BallShelf(renderMaterialBall);
    return shelf;
};

/** The project's textures as a ball reads them (their 8-bit pictures). */
const projectSource = (textures: readonly TextureData[]): BallPictureSource => (textureId) => {
    const texture = textures.find(candidate => candidate.id === textureId);
    return texture ? { url: texture.url, settings: textureSettingsOf(textureId) ?? texture.settings } : null;
};

/** A project material's ball in the Materials list; a graph made for other graphs shows its kind instead. */
export const ProjectBall: React.FC<{ asset: MaterialAsset; size?: number }> = ({ asset, size = 28 }) => {
    const { textures } = useAssets();
    const balls = projectShelf();
    useSyncExternalStore((listener) => balls.subscribe(listener), () => balls.version);
    const drawable = materialAssetUse(asset) !== 'forOtherGraphs';
    const look = useMemo(() => {
        const known = new Set(textures.map(texture => texture.id));
        return ballLook(asset, (id) => known.has(id));
    }, [asset, textures]);
    useEffect(() => {
        if (drawable) balls.want(asset, look, projectSource(textures), materialLibrary.generation);
    }, [asset, balls, drawable, look, textures]);
    const url = drawable ? balls.ball(asset.id) : null;
    if (!drawable) {
        return <span aria-hidden className="flex shrink-0 items-center justify-center rounded bg-gray-800 text-amber-400/80" style={{ width: size, height: size }}><GraphIcon size={13} /></span>;
    }
    return url
        ? <img src={url} alt="" draggable={false} className="block shrink-0 rounded" style={{ width: size, height: size }} />
        : <span aria-hidden className="block shrink-0 animate-pulse rounded bg-gray-800" style={{ width: size, height: size }} />;
};
