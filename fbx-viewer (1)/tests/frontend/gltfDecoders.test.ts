import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { basisTranscodeTargets } from '../../utils/gltfDecoders';
import { textureSourceImage } from '../../utils/textureCompression/compressTextures';

const offering = (...extensions: string[]) => (name: string) => extensions.includes(name);

describe('Basis transcode targets', () => {
  it('uses BC7 and BC1/BC3 on a desktop GPU, never the ETC its driver would unpack', () => {
    const targets = basisTranscodeTargets(offering(
      'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb', 'EXT_texture_compression_bptc',
      'WEBGL_compressed_texture_etc', 'WEBGL_compressed_texture_etc1',
    ));
    expect(targets).toMatchObject({ bptcSupported: true, dxtSupported: true, etc1Supported: false, etc2Supported: false });
  });

  it('uses ETC and ASTC on a phone GPU', () => {
    const targets = basisTranscodeTargets(offering('WEBGL_compressed_texture_etc', 'WEBGL_compressed_texture_etc1', 'WEBGL_compressed_texture_astc'));
    expect(targets).toMatchObject({ etc2Supported: true, etc1Supported: true, astcSupported: true, dxtSupported: false, bptcSupported: false });
  });

  it('leaves BC1/BC3 out without their sRGB formats, which colour textures need', () => {
    expect(basisTranscodeTargets(offering('WEBGL_compressed_texture_s3tc')).dxtSupported).toBe(false);
  });
});

describe('reading a texture\'s pixels', () => {
  it('reads an image texture\'s own image', () => {
    const image = { width: 4, height: 4 };
    expect(textureSourceImage(new THREE.Texture(image))).toBe(image);
  });

  it('finds nothing to read in a texture that arrived compressed, rather than a size with no pixels', () => {
    const basis = new THREE.CompressedTexture([], 64, 64, THREE.RGBA_BPTC_Format);
    expect(textureSourceImage(basis)).toBeNull();
  });
});
