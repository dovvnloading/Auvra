import { describe, expect, it } from 'vitest';
import { readMaterialXZip, materialXZipPictureMember } from '../../texturing/materialXZip';
import { makeZip, openZip } from '../../texturing/zip';

const material = (path: string, second?: string) => `<?xml version="1.0"?>
<materialx version="1.39">
  <image name="colour" type="color3">
    <input name="file" type="filename" value="${path}" colorspace="srgb_texture" />
  </image>
  ${second ? `<image name="rough" type="float"><input name="file" type="filename" value="${second}" /></image>` : ''}
  <standard_surface name="surface" type="surfaceshader">
    <input name="base_color" type="color3" nodename="colour" />
    ${second ? '<input name="specular_roughness" type="float" nodename="rough" />' : ''}
  </standard_surface>
  <surfacematerial name="Material" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="surface" />
  </surfacematerial>
</materialx>`;

const bytes = new Uint8Array([41, 97, 200, 55, 16]);
const make = async (files: ReadonlyArray<{ name: string; bytes: Uint8Array | string }>): Promise<Blob> =>
    makeZip(files.map((file) => ({ name: file.name, data: typeof file.bytes === 'string' ? new TextEncoder().encode(file.bytes) : file.bytes })));

describe('safe MaterialX archive import', () => {
    it('round-trips the exported one-document ZIP layout without extracting files', async () => {
        const zip = await make([
            { name: 'stone.mtlx', bytes: material('textures/stone_albedo.png', 'textures/stone_roughness.png') },
            { name: 'textures/stone_albedo.png', bytes },
            { name: 'textures/stone_roughness.png', bytes: new Uint8Array([10, 11, 12]) },
            { name: 'unrelated.txt', bytes: 'Never use this file' },
        ]);
        const result = await readMaterialXZip(zip);
        expect(result.documentName).toBe('stone.mtlx');
        expect(result.xml).toContain('<materialx version="1.39">');
        expect(result.missing).toEqual([]);
        expect(result.pictures.map(({ path }) => path)).toEqual(['textures/stone_albedo.png', 'textures/stone_roughness.png']);
        expect(result.pictures[0].file.name).toBe('stone_albedo.png');
        expect(result.pictures[0].file.type).toBe('image/png');
        expect(new Uint8Array(await result.pictures[0].file.arrayBuffer())).toEqual(bytes);
    });

    it('resolves safe relative paths for nested MTLX files, including parent folders', async () => {
        const zip = await make([
            { name: 'materials/wood/panel.mtlx', bytes: material('../textures/oak.jpg') },
            { name: 'materials/textures/oak.jpg', bytes },
        ]);
        const result = await readMaterialXZip(zip);
        expect(result.documentName).toBe('materials/wood/panel.mtlx');
        expect(result.pictures).toHaveLength(1);
        expect(result.pictures[0].file).toMatchObject({ name: 'oak.jpg', type: 'image/jpeg' });
        expect(result.missing).toEqual([]);
        expect(materialXZipPictureMember('materials/wood/panel.mtlx', '../textures/oak.jpg')).toBe('materials/textures/oak.jpg');
    });

    it('reports missing and unsupported images but retains valid referenced ones', async () => {
        const zip = await make([
            { name: 'material.mtlx', bytes: material('textures/yes.png', 'textures/no.tx') },
            { name: 'textures/yes.png', bytes },
        ]);
        const result = await readMaterialXZip(zip);
        expect(result.pictures.map(x => x.path)).toEqual(['textures/yes.png']);
        expect(result.missing).toEqual(['textures/no.tx']);
    });

    it('rejects unsafe image references rather than reading outside the archive', async () => {
        for (const bad of ['../../secret.png', '/var/secret.png', 'C:\\images\\stone.png',
            'https://example.com/a.png', 'file://secret.png', 'data:image/png', 'textures/with?query.png', 'textures/#bad.png']) {
            expect(materialXZipPictureMember('assets/mat.mtlx', bad), bad).toBeNull();
        }
        const zip = await make([{ name: 'assets/mat.mtlx', bytes: material('../../secret.png') },
            { name: 'secret.png', bytes }]);
        const result = await readMaterialXZip(zip);
        expect(result.pictures).toHaveLength(0);
        expect(result.missing).toEqual(['../../secret.png']);
    });

    it('requires exactly one material document and refuses ambiguously cased pictures', async () => {
        await expect(readMaterialXZip(await make([
            { name: 'a.mtlx', bytes: material('a.png') },
            { name: 'b.mtlx', bytes: material('b.png') },
        ]))).rejects.toThrow(/multiple .mtlx/);
        await expect(readMaterialXZip(await make([{ name: 'texture.png', bytes }]))).rejects.toThrow(/no .mtlx/);
        const zip = await make([
            { name: 'mat.mtlx', bytes: material('textures/STONE.png') },
            { name: 'textures/stone.png', bytes },
            { name: 'textures/Stone.png', bytes },
        ]);
        await expect(readMaterialXZip(zip)).rejects.toThrow(/ambiguous/);
    });

    it('verifies referenced image CRC before providing any import-ready File', async () => {
        const zip = await make([
            { name: 'mat.mtlx', bytes: material('textures/stone.png') },
            { name: 'textures/stone.png', bytes },
        ]);
        const data = new Uint8Array(await zip.arrayBuffer());
        // Flip the first bytes of the payload without changing directory CRC,
        // offsets or sizes. The ZIP opens, but its referenced image must fail.
        const start = data.findIndex((value, index) =>
            value === bytes[0] && bytes.every((wanted, n) => data[index + n] === wanted));
        expect(start).toBeGreaterThan(0);
        data[start] ^= 0xff;
        await expect(readMaterialXZip(data)).rejects.toThrow(/damaged/);
    });

    it('preflights the declared XML member size before it can be inflated', async () => {
        const tooBig = new Uint8Array(4 * 1024 * 1024 + 1);
        const zip = await make([{ name: 'huge.mtlx', bytes: tooBig }]);
        const opened = await openZip(zip);
        expect(opened.memberInfo('huge.mtlx')).toEqual({
            size: tooBig.byteLength, packedSize: tooBig.byteLength, method: 0,
        });
        expect(opened.memberInfo('not-here')).toBeUndefined();
        await expect(readMaterialXZip(zip)).rejects.toThrow(/exceeds the 4 MB safety limit/);
    });

    it('rejects oversized/invalid XML without processing any pictures', async () => {
        await expect(readMaterialXZip(await make([
            { name: 'mat.mtlx', bytes: '<svg></svg>' },
            { name: 'picture.png', bytes },
        ]))).rejects.toThrow(/not a MaterialX file/);
        await expect(readMaterialXZip(await make([
            { name: 'mat.mtlx', bytes: new Uint8Array([0xc3, 0x28]) },
        ]))).rejects.toThrow(/not valid UTF-8/);
    });
});
