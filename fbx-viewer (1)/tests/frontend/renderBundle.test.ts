import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { buildRenderBundle, renderView } from '../../components/Environment/renderBundle';
import { radianceFile } from '../../components/Environment/renderCapture';
import { POST_PROCESS_DEFAULTS } from '../../runtime/components/postProcess';
import { frameLook } from '../../runtime/frameLook';
import { GraphMaterial } from '../../runtime/materials/graphMaterial';
import { OUTPUT_NODE_TYPE, defaultParams, normalizeMaterialGraph } from '../../runtime/materials/materialGraph';

const bytesOf = (blob: Blob): Promise<ArrayBuffer> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result as ArrayBuffer);
  reader.onerror = () => reject(reader.error);
  reader.readAsArrayBuffer(blob);
});

type Part = { offset: number; length: number };

/** The bundle as a renderer reads it: each mesh's corners, as they were sent. */
const readBundle = async (frame?: { width: number; height: number }) => {
  const built = await buildRenderBundle(frame);
  if (!built) throw new Error('nothing was gathered');
  const bytes = await bytesOf(built.bundle);
  const headerLength = new DataView(bytes).getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 12, headerLength)));
  const floats = (part: Part) => Array.from(new Float32Array(bytes.slice(12 + headerLength + part.offset, 12 + headerLength + part.offset + part.length)));
  return { header, floats };
};

const triangle = () => new THREE.BufferGeometry()
  .setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0, 0, 0, 1], 3))
  .setAttribute('normal', new THREE.Float32BufferAttribute([1, 0, 0, 1, 0, 0, 1, 0, 0], 3))
  .setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));

const view = (...objects: THREE.Object3D[]) => {
  const scene = new THREE.Scene();
  scene.add(...objects);
  renderView.scene = scene;
  renderView.camera = new THREE.PerspectiveCamera();
};

/** Just enough of a renderer to see what is drawn with what, whose every pixel comes back covered. */
const fakeRenderer = () => {
  const drawn: { object: THREE.Object3D; material: THREE.Mesh['material']; children: boolean[] }[] = [];
  const scenes: THREE.Scene[] = [];
  const renderer = {
    autoClear: true,
    coordinateSystem: THREE.WebGLCoordinateSystem,
    toneMappingExposure: 1,
    toneMapping: THREE.NoToneMapping,
    xr: { enabled: false },
    shadowMap: { autoUpdate: true },
    getRenderTarget: () => null,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    setRenderTarget: () => undefined,
    getClearAlpha: () => 1,
    getClearColor: (into: THREE.Color) => into,
    setClearColor: () => undefined,
    clear: () => undefined,
    render: (object: THREE.Object3D & THREE.Mesh) => {
      if ((object as unknown as THREE.Scene).isScene) scenes.push(object as unknown as THREE.Scene);
      else drawn.push({ object, material: object.material, children: object.children.map((child) => child.visible) });
    },
    readRenderTargetPixels: (_target: unknown, _x: number, _y: number, _width: number, _height: number, pixels: Uint8Array | Float32Array) => { pixels.fill(200); },
  };
  renderView.renderer = renderer as unknown as THREE.WebGLRenderer;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: () => undefined,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA');
  return { renderer, drawn, scenes };
};

afterEach(() => {
  renderView.scene = null;
  renderView.camera = null;
  renderView.renderer = null;
  frameLook.settings = null;
  frameLook.adaptedExposure = null;
  vi.restoreAllMocks();
});

describe('gathering the view for a render', () => {
  it('turns a posed character\'s surface with its bones, not only its corners', async () => {
    const geometry = triangle();
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
    const bone = new THREE.Bone();
    mesh.add(bone);
    mesh.bind(new THREE.Skeleton([bone]));
    // A quarter turn about Z takes the surface's +X normal to +Y.
    bone.rotation.z = Math.PI / 2;
    mesh.updateMatrixWorld(true);
    mesh.skeleton.update();
    view(mesh);

    const { header, floats } = await readBundle();
    const normals = floats(header.meshes[0].normals);
    const positions = floats(header.meshes[0].positions);
    // The second corner, at +Y in the bind pose, has moved to -X.
    expect(positions[3]).toBeCloseTo(-1);
    expect(positions[4]).toBeCloseTo(0);
    for (let corner = 0; corner < 3; corner += 1) {
      expect(normals[corner * 3]).toBeCloseTo(0);
      expect(normals[corner * 3 + 1]).toBeCloseTo(1);
      expect(normals[corner * 3 + 2]).toBeCloseTo(0);
    }
  });

  it('sends the view\'s fog, of either kind, and none where it has none', async () => {
    view(new THREE.Mesh(triangle(), new THREE.MeshStandardMaterial()));
    expect((await readBundle()).header.fog).toBeUndefined();
    renderView.scene!.fog = new THREE.FogExp2(0x336699, 0.01);
    const squared = (await readBundle()).header.fog;
    expect(squared.density).toBeCloseTo(0.01);
    expect(squared.near).toBeUndefined();
    expect(squared.color[2]).toBeCloseTo(new THREE.Color(0x336699).b, 5);
    renderView.scene!.fog = new THREE.Fog(0xffffff, 10, 90);
    const linear = (await readBundle()).header.fog;
    expect([linear.near, linear.far, linear.density]).toEqual([10, 90, undefined]);
  });

  it('sends the brightness that brings the renderer\'s curve to the view\'s', async () => {
    view(new THREE.Mesh(triangle(), new THREE.MeshStandardMaterial()));
    expect((await readBundle()).header.exposure).toBeCloseTo(Math.log2(1 / 0.6), 5);
    fakeRenderer().renderer.toneMappingExposure = 2;
    expect((await readBundle()).header.exposure).toBeCloseTo(Math.log2(2 / 0.6), 5);
  });

  it('lights a frame with what lights the view: its reflection map and its plain fill', async () => {
    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x000000, 2);
    view(new THREE.Mesh(triangle(), new THREE.MeshStandardMaterial()), hemisphere, new THREE.AmbientLight(0xffffff, 1));
    const reflections = new THREE.Texture();
    renderView.scene!.environment = reflections;
    renderView.scene!.environmentIntensity = 0.7;
    const { scenes } = fakeRenderer();
    const { header } = await readBundle();
    expect(header.environment.lightAround).toBeDefined();
    const around = scenes.find((scene) => scene.background === reflections)!;
    expect(around.backgroundIntensity).toBeCloseTo(0.7);
    const quad = scenes[scenes.length - 1].children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    // The hemisphere's 2 and the ambient's 1 from above, and only the ambient from below, over pi as a white surface sends it back.
    expect(quad.material.uniforms.fromAbove.value.r).toBeCloseTo(3 / Math.PI, 5);
    expect(quad.material.uniforms.fromBelow.value.g).toBeCloseTo(1 / Math.PI, 5);
    expect(header.lights).toEqual([]);
  });

  it('says how the view blends what goes over a surface, with a post-process stack or without', async () => {
    view(new THREE.Mesh(triangle(), new THREE.MeshStandardMaterial()));
    expect((await readBundle()).header.blendsOnScreen).toBe(true);
    frameLook.settings = POST_PROCESS_DEFAULTS;
    expect((await readBundle()).header.blendsOnScreen).toBe(false);
  });

  it('sends what a post-process stack does, and the exposure it has adapted to', async () => {
    view(new THREE.Mesh(triangle(), new THREE.MeshStandardMaterial()));
    fakeRenderer();
    frameLook.settings = { ...POST_PROCESS_DEFAULTS, autoExposure: true, toneMapping: 'reinhard', saturation: 0.2, contrast: -0.1, vignette: true, vignetteDarkness: 0.3, temperature: 0.5, tint: 0, bloom: true, bloomIntensity: 0.4, bloomThreshold: 2 };
    frameLook.adaptedExposure = () => 2;
    const { header } = await readBundle();
    expect(header.toneMapping).toBe('reinhard');
    // A curve with no scale of its own to take out.
    expect(header.exposure).toBeCloseTo(1, 5);
    expect(header.post.saturation).toBeCloseTo(0.2);
    expect(header.post.contrast).toBeCloseTo(-0.1);
    expect(header.post.vignette).toBeCloseTo(0.3);
    expect(header.post.whiteBalance[0]).toBeGreaterThan(header.post.whiteBalance[2]);
    expect(header.post.bloom).toEqual({ intensity: 0.4, threshold: 2 });
    expect(header.post.depthOfField).toBeUndefined();
    expect(header.post.look).toBeUndefined();
  });

  it('draws fog and particles at the size of the frame, and sends no particle as a surface', async () => {
    const particles = new THREE.Mesh(triangle(), new THREE.MeshBasicMaterial());
    particles.userData.drawnOverPicture = true;
    view(new THREE.Mesh(triangle(), new THREE.MeshStandardMaterial()), particles);
    renderView.scene!.fog = new THREE.FogExp2(0x336699, 0.01);
    fakeRenderer();
    const { header, floats } = await readBundle({ width: 16, height: 8 });
    expect(header.meshes).toHaveLength(1);
    expect([header.over.width, header.over.height]).toEqual([16, 8]);
    expect(floats(header.over.picture)).toHaveLength(16 * 8 * 4);
    expect(floats(header.fog.picture.picture)).toHaveLength(16 * 8 * 4);
    expect(renderView.scene!.fog.density).toBeCloseTo(0.01);
    expect(renderView.scene!.children).toHaveLength(2);
  });

  it('writes light of any strength as a picture a renderer reads', () => {
    const file = radianceFile(new Float32Array([0, 0, 0, 1, 1, 0.5, 0.25, 1, 8, 4, 2, 1, 0.5, 0.25, 0, 1]), 2, 2);
    const head = '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 2\n';
    expect(new TextDecoder().decode(file.slice(0, head.length))).toBe(head);
    const pixels = file.slice(head.length);
    const read = (at: number) => [0, 1, 2].map((channel) => pixels[at + channel] * 2 ** (pixels[at + 3] - 136));
    // The top row comes first.
    expect(read(0)).toEqual([8, 4, 2]);
    expect(read(4)).toEqual([0.5, 0.25, 0]);
    expect(read(8)).toEqual([0, 0, 0]);
    expect(read(12)).toEqual([1, 0.5, 0.25]);
  });

  it('leaves a surface that has no bones as it is', async () => {
    const mesh = new THREE.Mesh(triangle(), new THREE.MeshStandardMaterial());
    mesh.rotation.z = Math.PI / 2;
    view(mesh);

    const { header, floats } = await readBundle();
    const normals = floats(header.meshes[0].normals);
    expect(normals[0]).toBeCloseTo(0);
    expect(normals[1]).toBeCloseTo(1);
  });

  it('stands a decal off its surface further than a ray steps through it, in a level of any size', async () => {
    const sizes = [100, 4000];
    for (const size of sizes) {
      const ground = new THREE.Mesh(new THREE.BoxGeometry(size, 1, 1), new THREE.MeshStandardMaterial());
      const decal = new THREE.Mesh(triangle(), new THREE.MeshStandardMaterial({ polygonOffset: true }));
      view(ground, decal);

      const { header, floats } = await readBundle();
      const lifted = floats(header.meshes[1].positions)[0];
      // A ray passing through a clear part of it moves on by 2e-5 of the level's size.
      expect(lifted).toBeGreaterThan(2e-5 * size);
      expect(lifted).toBeLessThan(1e-4 * size);
    }
  });

  describe('a material with a graph', () => {
    const node = (id: string, type: string, params: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, params: { ...defaultParams(type), ...params } });
    const noisy = () => new GraphMaterial(normalizeMaterialGraph({
      nodes: [node('out', OUTPUT_NODE_TYPE, { roughness: 0.3, metalness: 0.7 }), node('noise', 'noise')],
      links: [{ fromNode: 'noise', fromOutput: 'out', toNode: 'out', toInput: 'baseColor' }],
    }));
    it('sends what it gives its wired inputs as pictures, and the values of the rest', async () => {
      const material = noisy();
      view(new THREE.Mesh(triangle(), material));
      fakeRenderer();
      const { header } = await readBundle();
      const sent = header.meshes[0].material;
      expect(sent.baseColorTexture).toBeDefined();
      expect(sent.baseColor).toEqual([1, 1, 1]);
      expect(sent.roughnessTexture).toBeUndefined();
      expect(sent.roughness).toBeCloseTo(0.3);
      expect(sent.metallic).toBeCloseTo(0.7);
    });

    describe('a glow', () => {
      const glowing = () => new GraphMaterial(normalizeMaterialGraph({
        nodes: [node('out', OUTPUT_NODE_TYPE, { baseColor: [0.5, 0, 0] }), node('noise', 'noise')],
        links: [{ fromNode: 'noise', fromOutput: 'out', toNode: 'out', toInput: 'emissive' }],
      }));
      /** Hands back a drawn glow of two pixels' worth across every row, and a plain colour for anything else. */
      const drawGlow = (renderer: ReturnType<typeof fakeRenderer>['renderer'], glow: [number, number]) => {
        let current: THREE.MeshStandardMaterial | null = null;
        const render = renderer.render;
        renderer.render = (object) => { current = object.material as THREE.MeshStandardMaterial; render(object); };
        renderer.readRenderTargetPixels = (_target, _x, _y, _width, _height, pixels) => {
          const isGlow = String(current?.customProgramCacheKey()).includes('capture:emissive');
          for (let at = 0; at < pixels.length; at += 4) {
            const value = isGlow ? glow[(at / 4) % 2] : 128;
            pixels.fill(value, at, at + 3);
            pixels[at + 3] = isGlow ? 1 : 255;
          }
        };
      };

      it('keeps one that is the same all over as a glow, and leaves the colour to the graph', async () => {
        view(new THREE.Mesh(triangle(), glowing()));
        const { renderer } = fakeRenderer();
        drawGlow(renderer, [0.2, 0.2]);
        const { header } = await readBundle();
        const sent = header.meshes[0].material;
        expect(sent.emission[0]).toBeCloseTo(0.2);
        expect(sent.emissionTexture).toBeUndefined();
        expect(sent.baseColorTexture).toBeUndefined();
        expect(sent.baseColor[0]).toBeGreaterThan(0);
      });

      it('sends one that varies as a map of its own, at its full strength, and leaves the colour alone', async () => {
        view(new THREE.Mesh(triangle(), glowing()));
        const { renderer } = fakeRenderer();
        drawGlow(renderer, [0, 3]);
        const putImage = vi.fn();
        (HTMLCanvasElement.prototype.getContext as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
          createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
          putImageData: putImage,
        });
        const { header } = await readBundle();
        const sent = header.meshes[0].material;
        expect(sent.emission).toEqual([3, 3, 3]);
        expect(sent.emissionTexture).toBeDefined();
        expect(sent.baseColorTexture).toBeUndefined();
        const { data } = putImage.mock.calls[0][0] as { data: Uint8ClampedArray };
        expect([data[0], data[4]]).toEqual([0, 255]);
      });
    });

    describe('that goes by where a surface stands or faces', () => {
      const rimmed = () => new GraphMaterial(normalizeMaterialGraph({
        nodes: [node('out', OUTPUT_NODE_TYPE), node('rim', 'fresnel')],
        links: [{ fromNode: 'rim', fromOutput: 'out', toNode: 'out', toInput: 'baseColor' }],
      }));

      it('draws each triangle as it stands, on a place of its own, for copies that share a place on their map', async () => {
        const material = rimmed();
        const shared = triangle();
        const far = new THREE.Mesh(shared, material);
        far.position.x = 50;
        view(new THREE.Mesh(shared, material), far);
        const { drawn } = fakeRenderer();
        const { header, floats } = await readBundle();
        // One drawing, of both copies where they stand.
        expect(drawn).toHaveLength(1);
        const position = (drawn[0].object as THREE.Mesh).geometry.getAttribute('position');
        expect(position.count).toBe(6);
        expect(position.getX(3)).toBeCloseTo(50);
        const uvs = floats(header.meshes[0].uvs);
        expect(uvs).toHaveLength(12);
        // Each on a place of its own.
        expect(uvs.slice(0, 6)).not.toEqual(uvs.slice(6, 12));
        for (const value of uvs) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
        expect(header.meshes[0].material.baseColorTexture).toBeDefined();
      });

      it('leaves out a normal, which holds nothing on a place made up for baking', async () => {
        const material = new GraphMaterial(normalizeMaterialGraph({
          nodes: [node('out', OUTPUT_NODE_TYPE), node('rim', 'fresnel'), node('nm', 'normalMap')],
          links: [{ fromNode: 'rim', fromOutput: 'out', toNode: 'out', toInput: 'baseColor' }, { fromNode: 'nm', fromOutput: 'out', toNode: 'out', toInput: 'normal' }],
        }));
        view(new THREE.Mesh(triangle(), material));
        fakeRenderer();
        const { header } = await readBundle();
        expect(header.meshes[0].material.normalTexture).toBeUndefined();
      });

      it('keeps a mesh\'s own map where the graph does not', async () => {
        view(new THREE.Mesh(triangle(), noisy()));
        fakeRenderer();
        const { header, floats } = await readBundle();
        expect(floats(header.meshes[0].uvs)).toEqual([0, 0, 1, 0, 0, 1]);
      });
    });

    it('puts everything back as it was after drawing it, whatever hangs off the mesh', async () => {
      const material = noisy();
      const mesh = new THREE.Mesh(triangle(), material);
      const held = new THREE.Mesh(triangle(), new THREE.MeshStandardMaterial());
      mesh.add(held);
      view(mesh);
      const { renderer, drawn } = fakeRenderer();
      await readBundle();
      expect(drawn).toHaveLength(1);
      expect(drawn[0].material).not.toBe(material);
      expect(drawn[0].children).toEqual([false]);
      expect(mesh.material).toBe(material);
      expect(held.visible).toBe(true);
      expect(mesh.frustumCulled).toBe(true);
      expect(renderer.autoClear).toBe(true);
    });

    it('draws one object of each shape, as copies lie the same way on a map', async () => {
      const material = noisy();
      const shared = triangle();
      view(new THREE.Mesh(shared, material), new THREE.Mesh(shared, material), new THREE.Mesh(triangle(), material));
      const { drawn } = fakeRenderer();
      await readBundle();
      expect(drawn).toHaveLength(2);
    });

    it('draws one copy of an instanced object, and leaves its count alone', async () => {
      const material = noisy();
      const instanced = new THREE.InstancedMesh(triangle(), material, 5);
      for (let copy = 0; copy < 5; copy += 1) instanced.setMatrixAt(copy, new THREE.Matrix4());
      view(instanced);
      const counts: number[] = [];
      const { renderer } = fakeRenderer();
      const render = renderer.render;
      renderer.render = (object) => {
        if ((object as unknown as THREE.InstancedMesh).isInstancedMesh) counts.push((object as unknown as THREE.InstancedMesh).count);
        render(object);
      };
      await readBundle();
      expect(counts).toEqual([1]);
      expect(instanced.count).toBe(5);
    });

    it('sends only its values with nothing to draw with', async () => {
      view(new THREE.Mesh(triangle(), noisy()));
      const { header } = await readBundle();
      expect(header.meshes[0].material.baseColorTexture).toBeUndefined();
      expect(header.meshes[0].material.baseColor[0]).toBeCloseTo(new THREE.Color().setRGB(0.8, 0.8, 0.8, THREE.SRGBColorSpace).r, 5);
    });
  });
});
