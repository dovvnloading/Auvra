"""Builds the Outpost sample's humanoid, a redistributable character made from scratch here, and
writes it twice with different clothes: the Ranger (the player and the Scout) and the Raider.

A Mixamo-named skeleton (Hips, Spine, Spine1, Spine2, Neck, Head, arms, legs), so the engine's
ragdolls, foot IK, look-at and upper-body masks find their bones. The body is one smooth skinned
mesh grown from the skeleton with a Skin modifier; head, hair and eyes are added shapes. Every clip
is keyframed below.

    blender -b --factory-startup --python tools/outpost_character_model.py [-- OUTPUT_DIR [PREVIEW_DIR]]

OUTPUT_DIR defaults to Auvra/project/templates/outpost/assets. With PREVIEW_DIR, also renders a few
poses there as PNGs to look at.
"""
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Quaternion, Vector

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT_DIR = Path(ARGS[0]) if ARGS else Path(__file__).resolve().parents[1] / 'Auvra' / 'project' / 'templates' / 'outpost' / 'assets'
PREVIEW_DIR = Path(ARGS[1]) if len(ARGS) > 1 else None

# --- Skeleton -------------------------------------------------------------------------------------
# Blender units are metres; the character faces -Y with Z up and stands 1.8 m tall.
# name: (head, tail, parent)
BONES = {
    'Hips': ((0, 0, 0.98), (0, 0, 1.06), None),
    'Spine': ((0, 0, 1.06), (0, 0, 1.18), 'Hips'),
    'Spine1': ((0, 0, 1.18), (0, 0, 1.30), 'Spine'),
    'Spine2': ((0, 0, 1.30), (0, 0, 1.45), 'Spine1'),
    'Neck': ((0, 0, 1.45), (0, 0, 1.55), 'Spine2'),
    'Head': ((0, 0, 1.55), (0, 0, 1.76), 'Neck'),
    'HeadTop_End': ((0, 0, 1.76), (0, 0, 1.81), 'Head'),
}
for _side, _sx in (('Left', 1), ('Right', -1)):
    BONES.update({
        f'{_side}Shoulder': ((0.04 * _sx, 0, 1.41), (0.17 * _sx, 0, 1.41), 'Spine2'),
        f'{_side}Arm': ((0.17 * _sx, 0, 1.41), (0.29 * _sx, 0.0, 1.16), f'{_side}Shoulder'),
        f'{_side}ForeArm': ((0.29 * _sx, 0.0, 1.16), (0.39 * _sx, -0.03, 0.93), f'{_side}Arm'),
        f'{_side}Hand': ((0.39 * _sx, -0.03, 0.93), (0.43 * _sx, -0.04, 0.82), f'{_side}ForeArm'),
        f'{_side}UpLeg': ((0.1 * _sx, 0, 0.95), (0.1 * _sx, 0, 0.52), 'Hips'),
        f'{_side}Leg': ((0.1 * _sx, 0, 0.52), (0.1 * _sx, 0.02, 0.1), f'{_side}UpLeg'),
        f'{_side}Foot': ((0.1 * _sx, 0.02, 0.1), (0.1 * _sx, -0.1, 0.03), f'{_side}Leg'),
        f'{_side}ToeBase': ((0.1 * _sx, -0.1, 0.03), (0.1 * _sx, -0.17, 0.03), f'{_side}Foot'),
    })

# --- Body: (position, (radius across, radius deep)) joints joined by edges, skinned into a mesh ----
JOINTS = {
    'pelvis': ((0, 0.0, 0.95), (0.17, 0.125)),
    'waist': ((0, 0.0, 1.1), (0.155, 0.115)),
    'belly': ((0, -0.005, 1.22), (0.17, 0.12)),
    'chest': ((0, -0.01, 1.34), (0.2, 0.13)),
    'collar': ((0, 0.0, 1.43), (0.18, 0.105)),
    'neck': ((0, 0.005, 1.5), (0.06, 0.06)),
    'skull': ((0, 0.005, 1.57), (0.055, 0.055)),
}
for _side, _sx in (('l', 1), ('r', -1)):
    JOINTS.update({
        f'shoulder_{_side}': ((0.18 * _sx, 0, 1.41), (0.08, 0.08)),
        f'elbow_{_side}': ((0.29 * _sx, 0, 1.16), (0.058, 0.058)),
        f'wrist_{_side}': ((0.39 * _sx, -0.03, 0.93), (0.045, 0.04)),
        f'hand_{_side}': ((0.43 * _sx, -0.04, 0.8), (0.05, 0.028)),
        f'hip_{_side}': ((0.1 * _sx, 0, 0.9), (0.105, 0.105)),
        f'knee_{_side}': ((0.1 * _sx, 0.0, 0.52), (0.072, 0.072)),
        f'ankle_{_side}': ((0.1 * _sx, 0.02, 0.1), (0.058, 0.058)),
        f'toe_{_side}': ((0.1 * _sx, -0.15, 0.04), (0.058, 0.042)),
    })
LINKS = [('pelvis', 'waist'), ('waist', 'belly'), ('belly', 'chest'), ('chest', 'collar'), ('collar', 'neck'), ('neck', 'skull')]
for _side in ('l', 'r'):
    LINKS += [('collar', f'shoulder_{_side}'), (f'shoulder_{_side}', f'elbow_{_side}'), (f'elbow_{_side}', f'wrist_{_side}'),
              (f'wrist_{_side}', f'hand_{_side}'), ('pelvis', f'hip_{_side}'), (f'hip_{_side}', f'knee_{_side}'),
              (f'knee_{_side}', f'ankle_{_side}'), (f'ankle_{_side}', f'toe_{_side}')]

# Clothes. Each part is a material; the Ranger and the Raider differ only in colours.
COLORWAYS = {
    'ranger': {'Skin': '#c58c64', 'Hair': '#3b2618', 'Jacket': '#4f6b3a', 'Belt': '#3a2a1c', 'Buckle': '#c9a227',
               'Pants': '#8a7556', 'Boots': '#4a3424', 'Eyes': '#151515'},
    'raider': {'Skin': '#a8775a', 'Hair': '#151515', 'Jacket': '#7a2420', 'Belt': '#222222', 'Buckle': '#8f8f8f',
               'Pants': '#2c2c30', 'Boots': '#3b3b3b', 'Eyes': '#151515'},
}


def display(hex_color):
    """The colour as written (sRGB). FBX importers, three.js's among them, read material colours as sRGB."""
    return tuple(int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)) + (1.0,)


def srgb(hex_color):
    """The colour in linear light, for Blender's own viewport."""
    def channel(value):
        value /= 255
        return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4
    return tuple(channel(int(hex_color[i:i + 2], 16)) for i in (1, 3, 5)) + (1.0,)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS


def build_rig():
    data = bpy.data.armatures.new('Rig')
    rig = bpy.data.objects.new('Armature', data)
    bpy.context.scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    for name, (head, tail, _) in BONES.items():
        bone = data.edit_bones.new(name)
        bone.head, bone.tail, bone.roll = Vector(head), Vector(tail), 0.0
    for name, (_, _, parent) in BONES.items():
        if parent:
            data.edit_bones[name].parent = data.edit_bones[parent]
            data.edit_bones[name].use_connect = False
    bpy.ops.object.mode_set(mode='OBJECT')
    return rig


def apply_modifiers(obj):
    bpy.context.view_layer.objects.active = obj
    for modifier in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=modifier.name)


def build_body(materials):
    """The skinned body, its faces assigned to ``materials`` (name -> material) before smoothing so
    the clothing edges follow the mesh's rings."""
    mesh = bpy.data.meshes.new('Body')
    body = bpy.data.objects.new('Body', mesh)
    bpy.context.scene.collection.objects.link(body)
    names = list(JOINTS)
    mesh.from_pydata([JOINTS[name][0] for name in names], [(names.index(a), names.index(b)) for a, b in LINKS], [])
    skin = body.modifiers.new('Skin', 'SKIN')
    skin.use_smooth_shade = True
    for index, name in enumerate(names):
        vertex = mesh.skin_vertices[0].data[index]
        vertex.radius = JOINTS[name][1]
        vertex.use_root = name == 'pelvis'
    # One round of smoothing first, so the clothing edges have finer faces to follow.
    body.modifiers.new('Smooth', 'SUBSURF').levels = 1
    apply_modifiers(body)
    order = list(materials)
    for material in materials.values():
        body.data.materials.append(material)
    for polygon in body.data.polygons:
        polygon.material_index = order.index(material_for_face(polygon.center))
    body.modifiers.new('Smooth', 'SUBSURF').levels = 1
    apply_modifiers(body)
    return body


def ellipsoid(name, center, radii, segments=24, rings=16):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=1.0)
    for vert in bm.verts:
        vert.co = Vector(center) + Vector((vert.co.x * radii[0], vert.co.y * radii[1], vert.co.z * radii[2]))
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    return obj


def build_belt(body, height=1.0, depth=0.06):
    """A band round the waist at ``height``, just outside the body there, with a buckle in front."""
    ring = [v.co for v in body.data.vertices if abs(v.co.z - height) < depth and abs(v.co.x) < 0.25]  # not the arms
    across = max(abs(co.x) for co in ring) * 1.06
    deep = max(abs(co.y) for co in ring) * 1.08
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=False, segments=32, radius1=1.0, radius2=1.0, depth=depth)
    for vert in bm.verts:
        vert.co = Vector((vert.co.x * across, vert.co.y * deep, vert.co.z + height))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new('Belt')
    bm.to_mesh(mesh)
    bm.free()
    belt = bpy.data.objects.new('Belt', mesh)
    bpy.context.scene.collection.objects.link(belt)
    buckle = ellipsoid('Buckle', (0, -deep - 0.004, height), (0.032, 0.008, 0.028), 12, 8)
    return [(belt, 'Belt'), (buckle, 'Buckle')]


def build_head_parts():
    """Head, nose, ears, hair and eyes, each tagged with the material it wears."""
    parts = [
        (ellipsoid('Head', (0, -0.005, 1.655), (0.105, 0.118, 0.13)), 'Skin'),
        (ellipsoid('Nose', (0, -0.118, 1.64), (0.018, 0.025, 0.03), 10, 8), 'Skin'),
        (ellipsoid('EarL', (0.104, 0.0, 1.655), (0.015, 0.025, 0.035), 10, 8), 'Skin'),
        (ellipsoid('EarR', (-0.104, 0.0, 1.655), (0.015, 0.025, 0.035), 10, 8), 'Skin'),
        (ellipsoid('EyeL', (0.04, -0.105, 1.675), (0.016, 0.012, 0.018), 10, 8), 'Eyes'),
        (ellipsoid('EyeR', (-0.04, -0.105, 1.675), (0.016, 0.012, 0.018), 10, 8), 'Eyes'),
    ]
    # Hair: the top and back of a slightly larger head, cut off above the brow and behind the ears.
    hair = ellipsoid('Hair', (0, 0.0, 1.668), (0.114, 0.126, 0.135))
    bm = bmesh.new()
    bm.from_mesh(hair.data)
    doomed = [vert for vert in bm.verts if vert.co.z < 1.69 - max(0.0, vert.co.y) * 1.3 or (vert.co.y < -0.07 and vert.co.z < 1.73)]
    bmesh.ops.delete(bm, geom=doomed, context='VERTS')
    bm.to_mesh(hair.data)
    bm.free()
    parts.append((hair, 'Hair'))
    return parts


def nearest_link(point):
    """The skeleton link nearest ``point``, and how far along it (0 at its first joint, 1 at its second)."""
    best = None
    for a, b in LINKS:
        start, end = Vector(JOINTS[a][0]), Vector(JOINTS[b][0])
        span = end - start
        t = max(0.0, min(1.0, (point - start).dot(span) / span.length_squared))
        distance = (start + span * t - point).length
        if best is None or distance < best[0]:
            best = (distance, (a, b), t)
    return best[1], best[2]


def material_for_face(center):
    """Which clothing part a body face belongs to: by the stretch of skeleton it wraps."""
    (a, b), t = nearest_link(Vector(center))
    kind = (a.split('_')[0], b.split('_')[0])
    z = center[2]
    if kind == ('wrist', 'hand') or (kind == ('elbow', 'wrist') and t > 0.88):
        return 'Skin'
    if kind in (('collar', 'neck'), ('neck', 'skull')):
        return 'Skin' if abs(center[0]) < 0.065 and z > 1.465 else 'Jacket'
    if kind == ('ankle', 'toe') or (kind == ('knee', 'ankle') and t > 0.72):
        return 'Boots'
    # Round the hips the joints branch every way, so the waistband is a level cut (the belt covers it).
    if 'pelvis' in kind or 'waist' in kind or (kind == ('hip', 'knee') and t < 0.2):
        return 'Jacket' if z > 1.0 else 'Pants'
    if kind in (('hip', 'knee'), ('knee', 'ankle')):
        return 'Pants'
    return 'Jacket'


def build_character(colorway):
    rig = build_rig()
    materials = {}
    for part, color in COLORWAYS[colorway].items():
        material = bpy.data.materials.new(part)
        material.use_nodes = True
        bsdf = material.node_tree.nodes['Principled BSDF']
        bsdf.inputs['Base Color'].default_value = display(color)
        bsdf.inputs['Roughness'].default_value = 0.35 if part == 'Eyes' else 0.8
        material.diffuse_color = srgb(color)  # the viewport's (and the previews') colour
        materials[part] = material
    body = build_body(materials)

    # Skin weights from the bones' shapes (bone heat), then parented to the rig.
    bpy.ops.object.select_all(action='DESELECT')
    body.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')

    # The separate shapes follow one bone rigidly: the head's the Head, the belt's the Hips.
    shapes = [(part, material, 'Head') for part, material in build_head_parts()]
    shapes += [(part, material, 'Hips') for part, material in build_belt(body)]
    for part, material_name, bone in shapes:
        part.data.materials.append(materials[material_name])
        part.vertex_groups.new(name=bone).add(range(len(part.data.vertices)), 1.0, 'REPLACE')
        bpy.ops.object.select_all(action='DESELECT')
        part.select_set(True)
        body.select_set(True)
        bpy.context.view_layer.objects.active = body
        bpy.ops.object.join()
    body.name = 'Body'
    sort_faces_by_material(body)
    return rig, body


def sort_faces_by_material(obj):
    """Groups the faces by material, so importers that split a mesh per run of one material (three.js
    does) make one piece per material rather than dozens."""
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.sort_elements(type='MATERIAL', elements={'FACE'})
    bpy.ops.object.mode_set(mode='OBJECT')


def render_previews(rig, directory, poses):
    """Renders each (name, action, frame) pose from the front and the side into ``directory``."""
    directory.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'MATERIAL'
    scene.render.resolution_x, scene.render.resolution_y = 480, 640
    scene.render.film_transparent = False
    camera_data = bpy.data.cameras.new('Preview')
    camera_data.type = 'ORTHO'
    camera_data.ortho_scale = 2.2
    camera = bpy.data.objects.new('Preview', camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    views = {'front': ((0, -6, 0.95), (math.pi / 2, 0, 0)), 'side': ((6, 0, 0.95), (math.pi / 2, 0, math.pi / 2)),
             'three-quarter': ((4.2, -4.2, 0.95), (math.pi / 2, 0, math.radians(45)))}
    for name, action, frame in poses:
        rig.animation_data.action = bpy.data.actions.get(action) if action else None
        if not action:
            for bone in rig.pose.bones:
                bone.rotation_quaternion = Quaternion()
                bone.rotation_euler = (0, 0, 0)
                bone.location = (0, 0, 0)
        scene.frame_set(frame)
        for view, (location, rotation) in views.items():
            camera.location, camera.rotation_euler = location, rotation
            scene.render.filepath = str(directory / f'{name}-{view}.png')
            bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(camera)


def export(rig, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    rig.animation_data.action = bpy.data.actions.get('Idle')
    bpy.ops.export_scene.fbx(
        filepath=str(path), use_selection=False, object_types={'ARMATURE', 'MESH'},
        add_leaf_bones=False, armature_nodetype='NULL', mesh_smooth_type='FACE',
        bake_anim=True, bake_anim_use_all_actions=True, bake_anim_use_nla_strips=False,
        bake_anim_force_startend_keying=True,
    )


FPS = 24


def main():
    for colorway in COLORWAYS:
        reset_scene()
        rig, _ = build_character(colorway)
        rig.animation_data_create()
        add_clips(rig)
        if PREVIEW_DIR:
            render_previews(rig, PREVIEW_DIR / colorway, PREVIEW_POSES)
        export(rig, OUT_DIR / f'{colorway}.fbx')


# --- Clips ----------------------------------------------------------------------------------------
# A pose is a list of turns about the character's own axes, applied in order as seen from the bone's
# parent: x is the side-to-side axis (negative swings a hanging limb forward, positive bends a knee
# back; for the upright spine and head positive leans forward), y the front-to-back axis (negative swings a left limb out to the side), z the vertical axis
# (negative turns the left side forward). Hips moves are offsets in metres (z up, -y forward).
AXES = {'x': Vector((1, 0, 0)), 'y': Vector((0, 1, 0)), 'z': Vector((0, 0, 1))}

# Every clip starts from these relaxed arms, so clips blend without the arms jumping.
BASE = {
    'LeftArm': [('y', 16)], 'RightArm': [('y', -16)],
    'LeftForeArm': [('x', -14)], 'RightForeArm': [('x', -14)],
}


def mirror_name(name):
    return name.replace('Left', '\0').replace('Right', 'Left').replace('\0', 'Right')


def mirrored(bones, hips=()):
    """A clip's bones and hips moves reflected left to right."""
    flipped = {mirror_name(bone): [(frame, [(axis, degrees if axis == 'x' else -degrees) for axis, degrees in turns])
                                   for frame, turns in keys] for bone, keys in bones.items()}
    return flipped, [(frame, (-x, y, z)) for frame, (x, y, z) in hips]


def gait(frames, upleg, leg, foot, arm, forearm, hips_z, hips_turn, spine_turn, lean):
    """A left-right cycle from the left side's keys at contact and passing; the right side runs half a
    cycle behind. Each list holds the left side's values at 0, 1/4, 1/2 and 3/4 of the cycle."""
    quarter = frames // 4
    times = [1 + quarter * index for index in range(5)]

    def cycle(values, axis='x'):
        values = values + values[:1]
        return [(time, [(axis, value)]) for time, value in zip(times, values)]

    def shifted(values):
        return values[2:] + values[:2]

    bones = {
        'LeftUpLeg': cycle(upleg), 'RightUpLeg': cycle(shifted(upleg)),
        'LeftLeg': cycle(leg), 'RightLeg': cycle(shifted(leg)),
        'LeftFoot': cycle(foot), 'RightFoot': cycle(shifted(foot)),
        'LeftArm': cycle(arm), 'RightArm': cycle(shifted(arm)),
        'LeftForeArm': cycle(forearm), 'RightForeArm': cycle(shifted(forearm)),
        'Hips': cycle(hips_turn, 'z'),
        'Spine': [(time, [('x', lean)]) for time in times],
        'Spine2': cycle(spine_turn, 'z'),
    }
    hips = [(time, (0, 0, z)) for time, z in zip(times, hips_z + hips_z[:1])]
    return bones, hips


def reversed_clip(bones, hips, frames):
    last = frames + 1
    return ({bone: sorted((last + 1 - frame, turns) for frame, turns in keys) for bone, keys in bones.items()},
            sorted((last + 1 - frame, offset) for frame, offset in hips))


WALK = gait(28, upleg=[-26, -4, 22, 8], leg=[6, 12, 18, 48], foot=[-14, 4, 14, -6],
            arm=[18, 4, -18, -4], forearm=[-6, -10, -24, -12],
            hips_z=[-0.03, 0.0, -0.03, 0.0], hips_turn=[-6, 0, 6, 0], spine_turn=[5, 0, -5, 0], lean=3)
RUN = gait(16, upleg=[-42, -8, 34, 0], leg=[22, 34, 30, 95], foot=[-10, 12, 24, -10],
           arm=[34, 6, -34, -6], forearm=[-70, -78, -86, -78],
           hips_z=[-0.05, 0.0, -0.05, 0.0], hips_turn=[-9, 0, 9, 0], spine_turn=[8, 0, -8, 0], lean=11)
WALK_BACK = reversed_clip(*WALK, 28)

_STRAFE_LEFT = {  # the left foot steps out to the side, the right one closes up behind it
    'LeftUpLeg': [(1, [('y', 0)]), (8, [('y', -16), ('x', -10)]), (15, [('y', -12)]), (22, [('y', -4)]), (29, [('y', 0)])],
    'RightUpLeg': [(1, [('y', 0)]), (8, [('y', 4)]), (15, [('y', 12)]), (22, [('y', 4), ('x', -10)]), (29, [('y', 0)])],
    'LeftLeg': [(1, [('x', 8)]), (8, [('x', 30)]), (15, [('x', 8)]), (22, [('x', 8)]), (29, [('x', 8)])],
    'RightLeg': [(1, [('x', 8)]), (8, [('x', 8)]), (15, [('x', 8)]), (22, [('x', 30)]), (29, [('x', 8)])],
    'LeftArm': [(1, [('y', 0)]), (15, [('y', -6)]), (29, [('y', 0)])],
    'RightArm': [(1, [('y', 0)]), (15, [('y', -6)]), (29, [('y', 0)])],
    'Spine': [(1, [('x', 3)]), (29, [('x', 3)])],
}
_STRAFE_LEFT_HIPS = [(1, (0, 0, -0.01)), (8, (0.02, 0, 0.0)), (15, (0.03, 0, -0.035)), (22, (0.01, 0, 0.0)), (29, (0, 0, -0.01))]

_AIM = {  # both hands forward round an imagined pistol, right arm leading
    'RightArm': [('x', -82), ('z', 22)], 'RightForeArm': [('x', -8)],
    'LeftArm': [('x', -74), ('z', -38)], 'LeftForeArm': [('x', -28)],
    'Spine2': [('z', 8)], 'Head': [('z', -6)],
}


def held(pose, frames, sway=None):
    """A looping clip holding ``pose``; ``sway`` adds (bone, axis, degrees) at the halfway frame."""
    middle = 1 + frames // 2
    bones = {bone: [(1, turns), (middle, turns), (frames + 1, turns)] for bone, turns in pose.items()}
    for bone, axis, degrees in sway or ():
        keys = bones.setdefault(bone, [(1, []), (middle, []), (frames + 1, [])])
        keys[1] = (middle, keys[1][1] + [(axis, degrees)])
    return bones


CLIPS = {
    # name: (bones, hips moves, frames). Frame 1 of Hit Reaction is the neutral pose: it plays additively.
    'Idle': ({
        'Spine2': [(1, [('x', 0)]), (25, [('x', -2.5)]), (49, [('x', 0)])],
        'Neck': [(1, [('z', 0)]), (13, [('z', 4)]), (37, [('z', -4)]), (49, [('z', 0)])],
        'Head': [(1, [('x', 0)]), (25, [('x', 2)]), (49, [('x', 0)])],
        'LeftArm': [(1, [('x', 0)]), (25, [('x', 3)]), (49, [('x', 0)])],
        'RightArm': [(1, [('x', 0)]), (25, [('x', 3)]), (49, [('x', 0)])],
    }, [(1, (0, 0, 0)), (25, (0, 0, -0.008)), (49, (0, 0, 0))], 48),
    'Walk': (*WALK, 28),
    'Run': (*RUN, 16),
    'Walk Back': (*WALK_BACK, 28),
    'Strafe Left': (_STRAFE_LEFT, _STRAFE_LEFT_HIPS, 28),
    'Strafe Right': (*mirrored(_STRAFE_LEFT, _STRAFE_LEFT_HIPS), 28),
    'Jump': ({  # crouch, spring, then tuck rising
        'LeftUpLeg': [(1, [('x', -20)]), (4, [('x', 4)]), (9, [('x', -38)]), (13, [('x', -34)])],
        'RightUpLeg': [(1, [('x', -20)]), (4, [('x', 8)]), (9, [('x', -26)]), (13, [('x', -24)])],
        'LeftLeg': [(1, [('x', 40)]), (4, [('x', 2)]), (9, [('x', 60)]), (13, [('x', 55)])],
        'RightLeg': [(1, [('x', 40)]), (4, [('x', 2)]), (9, [('x', 40)]), (13, [('x', 38)])],
        'LeftFoot': [(1, [('x', -10)]), (4, [('x', 30)]), (13, [('x', 10)])],
        'RightFoot': [(1, [('x', -10)]), (4, [('x', 30)]), (13, [('x', 10)])],
        'LeftArm': [(1, [('x', 20)]), (4, [('x', -70)]), (9, [('x', -40), ('y', -20)]), (13, [('x', -35), ('y', -25)])],
        'RightArm': [(1, [('x', 20)]), (4, [('x', -70)]), (9, [('x', -40), ('y', 20)]), (13, [('x', -35), ('y', 25)])],
        'Spine': [(1, [('x', 14)]), (4, [('x', -2)]), (13, [('x', 6)])],
    }, [(1, (0, 0, -0.1)), (4, (0, 0, 0.02)), (13, (0, 0, 0))], 12),
    'Falling': ({  # legs ready, arms out for balance
        'LeftUpLeg': [(1, [('x', -24)]), (13, [('x', -18)]), (25, [('x', -24)])],
        'RightUpLeg': [(1, [('x', 6)]), (13, [('x', 2)]), (25, [('x', 6)])],
        'LeftLeg': [(1, [('x', 40)]), (13, [('x', 34)]), (25, [('x', 40)])],
        'RightLeg': [(1, [('x', 55)]), (13, [('x', 60)]), (25, [('x', 55)])],
        'LeftArm': [(1, [('y', -46), ('x', -10)]), (13, [('y', -54), ('x', -4)]), (25, [('y', -46), ('x', -10)])],
        'RightArm': [(1, [('y', 46), ('x', -10)]), (13, [('y', 54), ('x', -16)]), (25, [('y', 46), ('x', -10)])],
        'Spine': [(1, [('x', 6)]), (25, [('x', 6)])],
    }, [], 24),
    'Landing': ({  # knees take the impact, then straighten
        'LeftUpLeg': [(1, [('x', -48)]), (6, [('x', -24)]), (13, [('x', 0)])],
        'RightUpLeg': [(1, [('x', -40)]), (6, [('x', -20)]), (13, [('x', 0)])],
        'LeftLeg': [(1, [('x', 80)]), (6, [('x', 40)]), (13, [('x', 0)])],
        'RightLeg': [(1, [('x', 72)]), (6, [('x', 36)]), (13, [('x', 0)])],
        'LeftFoot': [(1, [('x', -30)]), (6, [('x', -14)]), (13, [('x', 0)])],
        'RightFoot': [(1, [('x', -30)]), (6, [('x', -14)]), (13, [('x', 0)])],
        'Spine': [(1, [('x', 22)]), (6, [('x', 10)]), (13, [('x', 0)])],
        'LeftArm': [(1, [('x', -30), ('y', -12)]), (13, [('x', 0)])],
        'RightArm': [(1, [('x', -30), ('y', 12)]), (13, [('x', 0)])],
    }, [(1, (0, 0, -0.2)), (6, (0, 0, -0.09)), (13, (0, 0, 0))], 12),
    'Punch': ({  # guard, a right jab with the shoulder behind it, back to guard
        'RightArm': [(1, [('x', -40)]), (5, [('x', -86), ('z', 16)]), (9, [('x', -44)]), (17, [('x', 0)])],
        'RightForeArm': [(1, [('x', -100)]), (5, [('x', -4)]), (9, [('x', -96)]), (17, [('x', 0)])],
        'LeftArm': [(1, [('x', -40)]), (5, [('x', -34)]), (17, [('x', 0)])],
        'LeftForeArm': [(1, [('x', -100)]), (5, [('x', -105)]), (17, [('x', 0)])],
        'Spine2': [(1, [('z', 0)]), (5, [('z', 18)]), (9, [('z', 4)]), (17, [('z', 0)])],
        'Spine': [(1, [('x', 4)]), (5, [('x', 8)]), (17, [('x', 0)])],
        'RightUpLeg': [(1, [('x', 6)]), (17, [('x', 0)])],
        'LeftUpLeg': [(1, [('x', -10)]), (17, [('x', 0)])],
    }, [], 16),
    'Shooting': (held(_AIM, 8, sway=[('RightArm', 'x', -9), ('LeftArm', 'x', -7), ('Spine2', 'x', 3)]), [], 8),
    'Aiming': (held(_AIM, 24, sway=[('Spine2', 'z', 2), ('RightArm', 'x', -2)]), [], 24),
    'Hit Reaction': ({  # a flinch back from a blow in front, then recover
        'Spine': [(1, [('x', 0)]), (4, [('x', -9)]), (15, [('x', 0)])],
        'Spine2': [(1, [('x', 0)]), (4, [('x', -10), ('z', -6)]), (15, [('x', 0)])],
        'Head': [(1, [('x', 0)]), (4, [('x', -16)]), (15, [('x', 0)])],
        'LeftArm': [(1, [('y', 0)]), (4, [('y', -18), ('x', -14)]), (15, [('y', 0)])],
        'RightArm': [(1, [('y', 0)]), (4, [('y', 18), ('x', -14)]), (15, [('y', 0)])],
    }, [(1, (0, 0, 0)), (4, (0, 0.04, -0.02)), (15, (0, 0, 0))], 14),
    'Death': ({  # staggers, knees give, falls flat on the back
        'Hips': [(1, [('x', 0)]), (6, [('x', 0)]), (14, [('x', -22)]), (22, [('x', -62)]), (30, [('x', -88)]), (37, [('x', -88)])],
        'Spine': [(1, [('x', 0)]), (6, [('x', -12)]), (14, [('x', 10)]), (30, [('x', 0)])],
        'Head': [(1, [('x', 0)]), (6, [('x', -20)]), (22, [('x', 10)]), (30, [('x', -6)]), (37, [('x', -6)])],
        'LeftUpLeg': [(1, [('x', 0)]), (14, [('x', -46)]), (22, [('x', -30)]), (30, [('x', -4)])],
        'RightUpLeg': [(1, [('x', 0)]), (14, [('x', -38)]), (22, [('x', -24)]), (30, [('x', 2), ('y', 6)])],
        'LeftLeg': [(1, [('x', 0)]), (6, [('x', 20)]), (14, [('x', 78)]), (22, [('x', 44)]), (30, [('x', 10)])],
        'RightLeg': [(1, [('x', 0)]), (6, [('x', 16)]), (14, [('x', 70)]), (22, [('x', 40)]), (30, [('x', 14)])],
        'LeftArm': [(1, [('y', 0)]), (6, [('y', -20), ('x', -20)]), (22, [('y', -50)]), (30, [('y', -66)])],
        'RightArm': [(1, [('y', 0)]), (6, [('y', 20), ('x', -20)]), (22, [('y', 50)]), (30, [('y', 70)])],
    }, [(1, (0, 0, 0)), (6, (0, 0.02, -0.04)), (14, (0, 0.12, -0.38)), (22, (0, 0.3, -0.74)), (30, (0, 0.42, -0.86)),
        (37, (0, 0.42, -0.86))], 36),
    'Wave': ({  # the right hand raised high, waving from the elbow
        'RightArm': [(1, [('y', 0)]), (7, [('y', 128), ('x', -14)]), (41, [('y', 128), ('x', -14)]), (47, [('y', 0)])],
        'RightForeArm': [(1, [('x', 0)]), (7, [('y', -30)]), (13, [('y', 6)]), (19, [('y', -30)]), (25, [('y', 6)]),
                         (31, [('y', -30)]), (37, [('y', 6)]), (41, [('y', -20)]), (47, [('x', 0)])],
        'Head': [(1, [('z', 0)]), (24, [('z', -5), ('x', -3)]), (47, [('z', 0)])],
        'Spine2': [(1, [('x', 0)]), (24, [('x', -2)]), (47, [('x', 0)])],
    }, [], 46),
}


def turn(rest, turns):
    """The pose-bone rotation for ``turns`` about the character's axes, given the bone's rest rotation."""
    world = Quaternion()
    for axis, degrees in turns:
        world = Quaternion(AXES[axis], math.radians(degrees)) @ world
    return (rest.inverted() @ world.to_matrix() @ rest).to_quaternion()


def add_clips(rig):
    for bone in rig.pose.bones:
        bone.rotation_mode = 'QUATERNION'
    for name, (bones, hips, frames) in CLIPS.items():
        action = bpy.data.actions.new(name)
        action.use_fake_user = True
        rig.animation_data.action = action
        # Every bone is keyed in every clip; the exporter bakes a clip over whatever pose the
        # previous one left on bones it does not key.
        keyed = dict(bones)
        for pose_bone in rig.pose.bones:
            keyed.setdefault(pose_bone.name, [(1, []), (frames + 1, [])])
        for bone_name, keys in keyed.items():
            pose_bone = rig.pose.bones[bone_name]
            rest = pose_bone.bone.matrix_local.to_3x3()
            previous = None
            for frame, turns in keys:
                rotation = turn(rest, BASE.get(bone_name, []) + list(turns))
                if previous is not None and previous.dot(rotation) < 0:
                    rotation.negate()
                pose_bone.rotation_quaternion = previous = rotation
                pose_bone.keyframe_insert('rotation_quaternion', frame=frame)
        hips_bone = rig.pose.bones['Hips']
        hips_rest = hips_bone.bone.matrix_local.to_3x3()
        for frame, offset in hips or [(1, (0, 0, 0)), (frames + 1, (0, 0, 0))]:
            hips_bone.location = hips_rest.inverted() @ Vector(offset)
            hips_bone.keyframe_insert('location', frame=frame)
        for pose_bone in rig.pose.bones:
            pose_bone.rotation_quaternion = Quaternion()
            pose_bone.location = (0, 0, 0)


PREVIEW_POSES = [
    ('rest', None, 1), ('idle', 'Idle', 25), ('walk-contact', 'Walk', 1), ('walk-passing', 'Walk', 8),
    ('run-contact', 'Run', 1), ('run-passing', 'Run', 5), ('strafe-left', 'Strafe Left', 15), ('jump', 'Jump', 9),
    ('falling', 'Falling', 1), ('landing', 'Landing', 1), ('punch', 'Punch', 5), ('aiming', 'Aiming', 1),
    ('hit', 'Hit Reaction', 4), ('death-mid', 'Death', 14), ('death-end', 'Death', 37), ('wave', 'Wave', 13),
]

main()
