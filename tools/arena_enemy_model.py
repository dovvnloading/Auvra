"""Regenerates Auvra/project/templates/arena/assets/enemy.fbx, the Arena guard: a blocky humanoid
on a Mixamo-named skeleton (Hips, Spine, Head, arms, legs) with each box skinned rigidly to its
bone, so a killed guard falls as a ragdoll.

    blender -b --factory-startup --python tools/arena_enemy_model.py [-- OUTPUT.fbx]
"""
import math
import sys
from pathlib import Path
import bpy
import bmesh
from mathutils import Vector

bpy.ops.wm.read_factory_settings(use_empty=True)
out = (sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv
       else str(Path(__file__).resolve().parents[1] / 'Auvra' / 'project' / 'templates' / 'arena' / 'assets' / 'enemy.fbx'))
color = (0.75, 0.1, 0.08, 1.0)

# name: (head, tail, parent)
BONES = {
    'Hips': ((0, 0, 0.95), (0, 0, 1.05), None),
    'Spine': ((0, 0, 1.05), (0, 0, 1.42), 'Hips'),
    'Neck': ((0, 0, 1.42), (0, 0, 1.52), 'Spine'),
    'Head': ((0, 0, 1.52), (0, 0, 1.78), 'Neck'),
    'HeadTop_End': ((0, 0, 1.78), (0, 0, 1.84), 'Head'),
}
for side, sx in (('Left', 1), ('Right', -1)):
    BONES.update({
        f'{side}Shoulder': ((0.05 * sx, 0, 1.38), (0.19 * sx, 0, 1.38), 'Spine'),
        f'{side}Arm': ((0.19 * sx, 0, 1.38), (0.24 * sx, 0, 1.10), f'{side}Shoulder'),
        f'{side}ForeArm': ((0.24 * sx, 0, 1.10), (0.27 * sx, 0, 0.84), f'{side}Arm'),
        f'{side}Hand': ((0.27 * sx, 0, 0.84), (0.28 * sx, 0, 0.74), f'{side}ForeArm'),
        f'{side}UpLeg': ((0.1 * sx, 0, 0.95), (0.1 * sx, 0, 0.52), 'Hips'),
        f'{side}Leg': ((0.1 * sx, 0, 0.52), (0.1 * sx, 0, 0.09), f'{side}UpLeg'),
        f'{side}Foot': ((0.1 * sx, 0, 0.09), (0.1 * sx, -0.14, 0.03), f'{side}Leg'),
        f'{side}ToeBase': ((0.1 * sx, -0.14, 0.03), (0.1 * sx, -0.2, 0.03), f'{side}Foot'),
    })

armature_data = bpy.data.armatures.new('GuardRig')
rig = bpy.data.objects.new('Armature', armature_data)
bpy.context.scene.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode='EDIT')
for name, (head, tail, parent) in BONES.items():
    bone = armature_data.edit_bones.new(name)
    bone.head, bone.tail = Vector(head), Vector(tail)
for name, (_, _, parent) in BONES.items():
    if parent:
        armature_data.edit_bones[name].parent = armature_data.edit_bones[parent]
        armature_data.edit_bones[name].use_connect = False
bpy.ops.object.mode_set(mode='OBJECT')

# Boxes: bone -> (center, size)
BOXES = {
    'Hips': ((0, 0, 0.98), (0.34, 0.2, 0.16)),
    'Spine': ((0, 0, 1.24), (0.38, 0.22, 0.38)),
    'Neck': ((0, 0, 1.47), (0.1, 0.1, 0.1)),
    'Head': ((0, 0, 1.64), (0.22, 0.24, 0.26)),
}
for side, sx in (('Left', 1), ('Right', -1)):
    BOXES.update({
        f'{side}Arm': ((0.215 * sx, 0, 1.24), (0.1, 0.1, 0.3)),
        f'{side}ForeArm': ((0.255 * sx, 0, 0.97), (0.09, 0.09, 0.27)),
        f'{side}Hand': ((0.275 * sx, 0, 0.79), (0.08, 0.06, 0.1)),
        f'{side}UpLeg': ((0.1 * sx, 0, 0.735), (0.14, 0.14, 0.43)),
        f'{side}Leg': ((0.1 * sx, 0, 0.305), (0.12, 0.12, 0.43)),
        f'{side}Foot': ((0.1 * sx, -0.06, 0.04), (0.11, 0.26, 0.08)),
    })

mesh = bpy.data.meshes.new('Guard')
body = bpy.data.objects.new('Guard', mesh)
bpy.context.scene.collection.objects.link(body)
bm = bmesh.new()
groups = {}
deform = bm.verts.layers.deform.verify()
for index, (bone, (center, size)) in enumerate(BOXES.items()):
    result = bmesh.ops.create_cube(bm, size=1.0)
    for vert in result['verts']:
        vert.co = Vector(center) + Vector((vert.co.x * size[0], vert.co.y * size[1], vert.co.z * size[2]))
        vert[deform][index] = 1.0
    groups[index] = bone
bm.to_mesh(mesh)
bm.free()
for index in range(len(groups)):
    body.vertex_groups.new(name=groups[index])

material = bpy.data.materials.new('GuardMaterial')
material.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = color
mesh.materials.append(material)

body.parent = rig
modifier = body.modifiers.new('Armature', 'ARMATURE')
modifier.object = rig

# Clips, named for the guard's animation graph states. Each key is (frame, degrees about the bone's
# own X axis); the bones hang down, so a positive angle swings a limb backwards and bends a knee.
FPS = 24
CLIPS = {
    'Idle': {  # two seconds of breathing
        'Spine': [(1, 0), (25, 3), (49, 0)],
        'Head': [(1, 0), (25, -2), (49, 0)],
        'LeftArm': [(1, 0), (25, 3), (49, 0)],
        'RightArm': [(1, 0), (25, 3), (49, 0)],
    },
    'Walk': {  # one stride a second
        'LeftUpLeg': [(1, -25), (13, 25), (25, -25)],
        'RightUpLeg': [(1, 25), (13, -25), (25, 25)],
        'LeftLeg': [(1, 10), (7, 5), (13, 40), (19, 25), (25, 10)],
        'RightLeg': [(1, 40), (7, 25), (13, 10), (19, 5), (25, 40)],
        'LeftArm': [(1, 20), (13, -20), (25, 20)],
        'RightArm': [(1, -20), (13, 20), (25, -20)],
        'Spine': [(1, 4), (25, 4)],
    },
    'Attack': {  # a punch with the right arm
        'RightArm': [(1, 0), (5, -95), (9, -70), (15, 0)],
        'RightForeArm': [(1, 0), (4, -40), (6, 0), (15, 0)],
        'Spine': [(1, 0), (5, 8), (15, 0)],
    },
}
bpy.context.scene.render.fps = FPS
rig.animation_data_create()
for name, tracks in CLIPS.items():
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    rig.animation_data.action = action
    for bone_name, keys in tracks.items():
        pose_bone = rig.pose.bones[bone_name]
        pose_bone.rotation_mode = 'XYZ'
        for frame, degrees in keys:
            pose_bone.rotation_euler = (math.radians(degrees), 0.0, 0.0)
            pose_bone.keyframe_insert('rotation_euler', frame=frame)
        pose_bone.rotation_euler = (0.0, 0.0, 0.0)
rig.animation_data.action = bpy.data.actions['Idle']

bpy.ops.export_scene.fbx(
    filepath=out, use_selection=False, object_types={'ARMATURE', 'MESH'},
    add_leaf_bones=False, armature_nodetype='NULL', mesh_smooth_type='FACE',
    bake_anim=True, bake_anim_use_all_actions=True, bake_anim_use_nla_strips=False,
    bake_anim_force_startend_keying=True,
)
