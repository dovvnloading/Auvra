import React, { useCallback } from 'react';
import { textureService } from '../../services/TextureGenerationService';
import type { MaterialGraph } from '../../runtime/materials/materialGraph';
import { graphFromTextures, type PaintedTextures } from './graphFromTextures';
import { useAssets } from '../../context/AssetContext';
import { DescribeWithAI, nameFromWords, type PaintedFromWords } from '../Tools/DescribeWithAI';

/** Paints a seamless material from a description, with its surface maps, and hands back a graph that draws with it. */
export const MaterialFromDescription: React.FC<{ onCreated: (name: string, graph: MaterialGraph) => void }> = ({ onCreated }) => {
  const { adoptHostTexture } = useAssets();

  const onPainted = useCallback(async ({ job, preview, words }: PaintedFromWords) => {
    const dimensions = preview.dimensions ?? { width: 1024, height: 1024 };
    // Kept straight away: a material's graph draws with the project's textures, and has nowhere to wait for them.
    const keep = async (previewAssetId: string, suffix: string) => {
      const name = nameFromWords(words, suffix);
      await textureService.commit(job.jobId, previewAssetId, { name });
      await adoptHostTexture(previewAssetId, name, previewAssetId, dimensions);
      return previewAssetId;
    };
    const textures: PaintedTextures = { color: await keep(preview.previewAssetId, '') };
    for (const item of preview.maps ?? []) {
      if (item.role === 'normal' || item.role === 'roughness' || item.role === 'metalness') textures[item.role] = await keep(item.previewAssetId, ` ${item.role}`);
    }
    onCreated(nameFromWords(words), graphFromTextures(textures));
  }, [adoptHostTexture, onCreated]);

  return (
    <DescribeWithAI
      capability="media.material"
      title="New material from a description"
      hint="A seamless texture with normal, roughness and metal maps, wired into a new material."
      placeholder="For example: mossy cobblestones, wet after rain"
      onPainted={onPainted}
    />
  );
};
