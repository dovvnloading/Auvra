"""Builds the Outpost sample's scenery, made from scratch here: a palisade wall segment, a supply
cache, the signal beacon and a tent, each a static FBX.

    blender -b --factory-startup --python tools/outpost_props_model.py [-- OUTPUT_DIR [PREVIEW_DIR]]

OUTPUT_DIR defaults to Auvra/project/templates/outpost/assets. With PREVIEW_DIR, also renders each
prop there as a PNG to look at. Blender units are metres, Z up; each prop stands on z = 0.
"""
import math
import random
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT_DIR = Path(ARGS[0]) if ARGS else Path(__file__).resolve().parents[1] / 'Auvra' / 'project' / 'templates' / 'outpost' / 'assets'
PREVIEW_DIR = Path(ARGS[1]) if len(ARGS) > 1 else None

COLORS = {
    'Wood': '#7a5a3a', 'DarkWood': '#4e3923', 'Metal': '#7d838a', 'Canvas': '#c2b080', 'Rope': '#a08a5e',
    'Coal': '#1c1714', 'Ember': '#e0702a', 'Cloth': '#5f7d45', 'Gunmetal': '#2b2d31', 'Grip': '#5a3d28',
}


def display(hex_color):
    """The colour as written (sRGB). FBX importers, three.js's among them, read material colours as sRGB."""
    return tuple(int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)) + (1.0,)


class Prop:
    """Collects shapes into one mesh, each face tagged with a material by name."""

    def __init__(self):
        self.bm = bmesh.new()
        self.materials = []

    def _tag(self, faces, material):
        if material not in self.materials:
            self.materials.append(material)
        for face in faces:
            face.material_index = self.materials.index(material)
            face.smooth = material in ('Canvas', 'Cloth')

    def _place(self, verts, matrix):
        bmesh.ops.transform(self.bm, matrix=matrix, verts=verts)

    def box(self, center, size, material, rotation=None):
        result = bmesh.ops.create_cube(self.bm, size=1.0)
        verts = result['verts']
        self._place(verts, Matrix.Diagonal((*size, 1.0)))
        if rotation:
            self._place(verts, rotation)
        self._place(verts, Matrix.Translation(center))
        self._tag({f for v in verts for f in v.link_faces}, material)

    def cylinder(self, start, end, radius, material, segments=10, tip=0.0, radius_end=None):
        """A post from ``start`` to ``end``; ``tip`` adds a point of that length beyond ``end``."""
        start, end = Vector(start), Vector(end)
        if tip:
            self.cylinder(end, end + (end - start).normalized() * tip, radius, material, segments, radius_end=0.0)
        length = (end - start).length
        result = bmesh.ops.create_cone(self.bm, cap_ends=True, segments=segments, radius1=radius,
                                       radius2=radius if radius_end is None else radius_end, depth=length)
        verts = result['verts']
        self._place(verts, Matrix.Translation((0, 0, length / 2)))
        direction = (end - start).normalized()
        self._place(verts, direction.to_track_quat('Z', 'Y').to_matrix().to_4x4())
        self._place(verts, Matrix.Translation(start))
        self._tag({f for v in verts for f in v.link_faces}, material)

    def build(self, name):
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        # Faces grouped by material: importers that split a mesh per run of one material (three.js
        # does) then make one piece per material.
        self.bm.faces.sort(key=lambda face: face.material_index)
        mesh = bpy.data.meshes.new(name)
        self.bm.to_mesh(mesh)
        self.bm.free()
        for material_name in self.materials:
            material = bpy.data.materials.get(material_name) or bpy.data.materials.new(material_name)
            material.use_nodes = True
            material.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = display(COLORS[material_name])
            material.diffuse_color = display(COLORS[material_name])
            mesh.materials.append(material)
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        return obj


def palisade():
    """A wall segment 1.2 m wide: sharpened logs of uneven height on two cross rails."""
    prop = Prop()
    rng = random.Random(7)
    for index in range(5):
        x = -0.48 + index * 0.24
        height = 2.0 + rng.uniform(-0.12, 0.12)
        prop.cylinder((x, 0, 0), (x, 0, height), 0.115, 'Wood', segments=9, tip=0.28)
    for z in (0.55, 1.55):
        prop.box((0, 0.13, z), (1.26, 0.07, 0.14), 'DarkWood')
    return prop.build('Palisade')


def supply_cache():
    """A banded crate with a rolled bundle strapped on top."""
    prop = Prop()
    prop.box((0, 0, 0.22), (0.66, 0.44, 0.44), 'Wood')
    for x in (-0.24, 0.24):
        prop.box((x, 0, 0.22), (0.05, 0.46, 0.46), 'Metal')
    prop.box((0, 0, 0.445), (0.6, 0.38, 0.02), 'DarkWood')
    prop.cylinder((-0.27, 0, 0.56), (0.27, 0, 0.56), 0.11, 'Cloth', segments=12)
    for x in (-0.13, 0.13):
        prop.cylinder((x - 0.015, 0, 0.56), (x + 0.015, 0, 0.56), 0.118, 'Rope', segments=12)
    return prop.build('SupplyCache')


def beacon():
    """A four-legged tower with a platform and an iron brazier on top, 3.4 m tall."""
    prop = Prop()
    for sx, sy in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
        prop.cylinder((0.75 * sx, 0.75 * sy, 0), (0.42 * sx, 0.42 * sy, 2.7), 0.08, 'Wood', segments=8)
    for z, half in ((0.9, 0.64), (1.8, 0.53)):
        for axis in range(4):
            angle = axis * math.pi / 2
            ox, oy = math.cos(angle) * half, math.sin(angle) * half
            rotation = Matrix.Rotation(angle, 4, 'Z')
            prop.box((ox, oy, z), (0.06, 2 * half, 0.08), 'DarkWood', rotation=rotation)
    prop.box((0, 0, 2.74), (1.1, 1.1, 0.1), 'DarkWood')
    prop.cylinder((0, 0, 2.79), (0, 0, 3.15), 0.42, 'Metal', segments=16, radius_end=0.55)
    prop.cylinder((0, 0, 3.05), (0, 0, 3.12), 0.5, 'Coal', segments=16)
    return prop.build('Beacon')


def tent():
    """An A-frame tent 2.2 m long, with its poles and a flap."""
    prop = Prop()
    half_width, height, half_length = 0.85, 1.35, 1.1
    bm = prop.bm
    corners = [Vector((x, y, 0)) for y in (-half_length, half_length) for x in (-half_width, half_width)]
    ridge = [Vector((0, -half_length, height)), Vector((0, half_length, height))]
    verts = [bm.verts.new(co) for co in corners + ridge]
    a, b, c, d, r0, r1 = verts
    faces = [bm.faces.new((a, c, r1, r0)), bm.faces.new((d, b, r0, r1)), bm.faces.new((c, d, r1)), bm.faces.new((b, a, r0))]
    prop._tag(faces, 'Canvas')
    # The canvas is thin: give it a back face so it shows from inside too.
    back = bmesh.ops.duplicate(bm, geom=faces)['geom']
    bmesh.ops.reverse_faces(bm, faces=[f for f in back if isinstance(f, bmesh.types.BMFace)])
    prop._tag([f for f in back if isinstance(f, bmesh.types.BMFace)], 'Canvas')
    for y in (-half_length - 0.05, half_length + 0.05):
        prop.cylinder((0, y, 0), (0, y, height + 0.12), 0.04, 'DarkWood', segments=6)
    prop.cylinder((0, -half_length - 0.05, height + 0.02), (0, half_length + 0.05, height + 0.02), 0.03, 'DarkWood', segments=6)
    for sx in (-1, 1):
        prop.cylinder((0, -half_length - 0.05, height), (sx * 1.25, -half_length - 0.6, 0), 0.012, 'Rope', segments=5)
    return prop.build('Tent')


def pistol():
    """The Ranger's sidearm, 0.21 m long: the barrel points along -Y, the grip hangs down at the origin."""
    prop = Prop()
    prop.box((0, -0.06, 0.055), (0.03, 0.19, 0.035), 'Gunmetal')
    prop.cylinder((0, -0.15, 0.05), (0, -0.165, 0.05), 0.009, 'Gunmetal', segments=8)
    prop.box((0, 0.005, -0.005), (0.028, 0.04, 0.11), 'Grip', rotation=Matrix.Rotation(math.radians(-14), 4, 'X'))
    prop.box((0, -0.05, 0.022), (0.026, 0.07, 0.03), 'Gunmetal')
    prop.box((0, -0.045, -0.002), (0.006, 0.05, 0.006), 'Gunmetal')
    return prop.build('Pistol')


PROPS = {'palisade': palisade, 'supply': supply_cache, 'beacon': beacon, 'tent': tent, 'pistol': pistol}


def render_preview(obj, path):
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'MATERIAL'
    scene.render.resolution_x = scene.render.resolution_y = 480
    size = max(obj.dimensions)
    camera_data = bpy.data.cameras.new('Preview')
    camera_data.type = 'ORTHO'
    camera_data.ortho_scale = size * 1.5
    camera = bpy.data.objects.new('Preview', camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    centre = Vector((0, 0, obj.dimensions.z / 2))
    camera.location = centre + Vector((1, -1, 0.6)).normalized() * size * 4
    camera.rotation_euler = (centre - camera.location).to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(camera)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, build in PROPS.items():
        bpy.ops.wm.read_factory_settings(use_empty=True)
        obj = build()
        if PREVIEW_DIR:
            PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
            render_preview(obj, PREVIEW_DIR / f'{name}.png')
        bpy.ops.export_scene.fbx(filepath=str(OUT_DIR / f'{name}.fbx'), use_selection=False, object_types={'MESH'},
                                 mesh_smooth_type='FACE', bake_anim=False)


main()
