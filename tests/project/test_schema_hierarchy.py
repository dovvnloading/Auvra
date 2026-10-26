from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path

from Auvra.project import ProjectRepository
from Auvra.project.errors import InvalidProjectError
from Auvra.project.schemas import (
    DOMAIN_NAMES,
    SCHEMA_DIR,
    domain_document,
    validate_domain,
    validate_project_references,
)


def _object(identity: str, **extra):
    return {"id": identity, "levelId": "level", "name": identity, "type": "prop",
            "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1], **extra}


def _member(identity: str, **extra):
    value = _object(identity, **extra)
    del value["levelId"]
    return value


def _prefab(identity: str = "prefab", root: str = "root", members=None, **extra):
    if members is None:
        members = [_member("root", parentId=None), _member("child", parentId="root")]
    return {"id": identity, "name": "Prefab", "rootId": root, "objects": members, **extra}


def _domains(objects=(), prefabs=(), levels=("level",)):
    return {
        "levels": domain_document("levels", [{"id": identity, "name": identity} for identity in levels]),
        "objects": domain_document("objects", list(objects)),
        "prefabs": domain_document("prefabs", list(prefabs)),
    }


class SchemaContractTests(unittest.TestCase):
    def test_prefabs_is_a_domain_with_a_draft_2020_schema(self):
        self.assertIn("prefabs", DOMAIN_NAMES)
        self.assertEqual(validate_domain("prefabs", {"schemaVersion": 1, "documents": []})["documents"], [])

    def test_prefab_member_schema_is_the_object_schema_without_a_level(self):
        objects = json.loads((SCHEMA_DIR / "objects.schema.json").read_text(encoding="utf-8"))
        prefabs = json.loads((SCHEMA_DIR / "prefabs.schema.json").read_text(encoding="utf-8"))
        expected = objects["properties"]["documents"]["items"]
        member = prefabs["properties"]["documents"]["items"]["properties"]["objects"]["items"]
        self.assertEqual(member["required"], [key for key in expected["required"] if key != "levelId"])
        self.assertEqual(member["properties"], {key: value for key, value in expected["properties"].items() if key != "levelId"})
        self.assertEqual(member["additionalProperties"], expected["additionalProperties"])


class ObjectDocumentTests(unittest.TestCase):
    def validate(self, *objects):
        return validate_domain("objects", {"schemaVersion": 1, "documents": list(objects)})

    def test_hierarchy_components_and_prefab_fields_round_trip(self):
        component = {"id": "c1", "type": "rotator", "enabled": True, "props": {"speed": 1.5, "axis": [0, 1, 0]}}
        documents = self.validate(
            _object("root", parentId=None),
            _object("child", parentId="root", components=[component], prefabId="prefab"),
        )["documents"]
        self.assertIsNone(documents[0]["parentId"])
        self.assertEqual(documents[1]["components"], [component])
        self.assertEqual(documents[1]["prefabId"], "prefab")

    def test_component_shape_is_strict(self):
        valid = {"id": "c1", "type": "mover", "enabled": False, "props": {}}
        for component in (
            {**valid, "extra": 1},
            {key: value for key, value in valid.items() if key != "props"},
            {key: value for key, value in valid.items() if key != "enabled"},
            {**valid, "props": []},
            {**valid, "enabled": "yes"},
            {**valid, "type": ""},
            {**valid, "id": ""},
        ):
            with self.subTest(component=component), self.assertRaises(ValueError):
                self.validate(_object("o", components=[component]))

    def test_component_ids_are_unique_per_object(self):
        component = {"id": "c1", "type": "rotator", "enabled": True, "props": {}}
        with self.assertRaisesRegex(ValueError, "duplicate component ids"):
            self.validate(_object("o", components=[component, dict(component)]))
        # The same component id on two different objects is fine.
        self.validate(_object("a", components=[component]), _object("b", components=[dict(component)]))

    def test_hierarchy_field_types(self):
        for extra in ({"parentId": 3}, {"prefabId": ""}, {"prefabId": None}, {"components": {}}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.validate(_object("o", **extra))


class AssetDocumentTests(unittest.TestCase):
    asset = "a" * 64

    def test_folders_on_models_textures_and_audio(self):
        for domain in ("models", "textures", "audio"):
            with self.subTest(domain=domain):
                value = {"id": "x", "name": "X", "assetId": self.asset, "folder": "Characters/Enemies"}
                self.assertEqual(validate_domain(domain, {"schemaVersion": 1, "documents": [value]})["documents"][0]["folder"], "Characters/Enemies")
                for folder in ("f" * 257, 7, None):
                    with self.assertRaises(ValueError):
                        validate_domain(domain, {"schemaVersion": 1, "documents": [{**value, "folder": folder}]})

    def test_model_import_settings(self):
        model = {"id": "m", "name": "Model", "assetId": self.asset}
        accepted = validate_domain("models", {"schemaVersion": 1, "documents": [{**model, "importSettings": {"normalize": False, "targetSize": 0.25}}]})
        self.assertEqual(accepted["documents"][0]["importSettings"], {"normalize": False, "targetSize": 0.25})
        for settings in (
            {"normalize": True, "targetSize": 0},
            {"normalize": True, "targetSize": -1},
            {"normalize": True},
            {"targetSize": 5},
            {"normalize": "true", "targetSize": 5},
            {"normalize": True, "targetSize": 5, "extra": 1},
        ):
            with self.subTest(settings=settings), self.assertRaises(ValueError):
                validate_domain("models", {"schemaVersion": 1, "documents": [{**model, "importSettings": settings}]})


class HierarchyReferenceTests(unittest.TestCase):
    def test_valid_tree_and_prefab_instance(self):
        validate_project_references(_domains(
            objects=[_object("root", prefabId="prefab"), _object("child", parentId="root", prefabId="prefab"),
                     _object("grandchild", parentId="child"), _object("loose", parentId=None)],
            prefabs=[_prefab()],
        ))

    def test_parent_must_exist_in_the_same_level(self):
        with self.assertRaisesRegex(ValueError, "invalid object parent reference"):
            validate_project_references(_domains(objects=[_object("child", parentId="missing")]))
        other = {**_object("other"), "levelId": "second"}
        with self.assertRaisesRegex(ValueError, "invalid object parent reference"):
            validate_project_references(_domains(objects=[other, _object("child", parentId="other")], levels=("level", "second")))

    def test_cycles_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "object hierarchy contains a cycle"):
            validate_project_references(_domains(objects=[_object("self", parentId="self")]))
        with self.assertRaisesRegex(ValueError, "object hierarchy contains a cycle"):
            validate_project_references(_domains(objects=[
                _object("top"), _object("a", parentId="c"), _object("b", parentId="a"), _object("c", parentId="b"),
                _object("tail", parentId="a"),
            ]))

    def test_deep_chain_is_accepted(self):
        chain = [_object("n0")] + [_object(f"n{index}", parentId=f"n{index - 1}") for index in range(1, 2000)]
        validate_project_references(_domains(objects=list(reversed(chain))))

    def test_prefab_id_must_exist(self):
        with self.assertRaisesRegex(ValueError, "invalid object prefab reference"):
            validate_project_references(_domains(objects=[_object("o", prefabId="missing")]))


class PrefabReferenceTests(unittest.TestCase):
    def check(self, prefab):
        validate_project_references(_domains(prefabs=[prefab]))

    def test_root_must_be_a_member(self):
        with self.assertRaisesRegex(ValueError, "invalid prefab root reference"):
            self.check(_prefab(root="absent"))

    def test_root_has_no_parent_and_members_form_one_tree(self):
        with self.assertRaisesRegex(ValueError, "prefab root must not have a parent"):
            self.check(_prefab(members=[_member("root", parentId="child"), _member("child", parentId="root")]))
        with self.assertRaisesRegex(ValueError, "invalid prefab object parent reference"):
            self.check(_prefab(members=[_member("root"), _member("child", parentId="outside")]))
        with self.assertRaisesRegex(ValueError, "invalid prefab object parent reference"):
            self.check(_prefab(members=[_member("root"), _member("stray")]))
        with self.assertRaisesRegex(ValueError, "prefab hierarchy contains a cycle"):
            self.check(_prefab(members=[_member("root"), _member("a", parentId="b"), _member("b", parentId="a")]))

    def test_member_ids_are_unique(self):
        with self.assertRaisesRegex(ValueError, "duplicate prefab object id"):
            self.check(_prefab(members=[_member("root"), _member("root")]))

    def test_member_documents_have_no_level_and_prefab_shape_is_strict(self):
        for prefab in (
            _prefab(members=[{**_member("root"), "levelId": "level"}]),
            _prefab(members=[]),
            {key: value for key, value in _prefab().items() if key != "rootId"},
            _prefab(extra=True),
            _prefab(name=""),
            _prefab(createdAt=-1),
        ):
            with self.subTest(prefab=prefab), self.assertRaises(ValueError):
                validate_domain("prefabs", {"schemaVersion": 1, "documents": [prefab]})

    def test_members_follow_object_cross_field_rules(self):
        component = {"id": "c", "type": "rotator", "enabled": True, "props": {}}
        with self.assertRaisesRegex(ValueError, "duplicate component ids"):
            validate_domain("prefabs", {"schemaVersion": 1, "documents": [
                _prefab(members=[_member("root", components=[component, dict(component)])])]})
        terrain = {"resolution": 2, "width": 10, "depth": 10, "heightfield": {"assetId": "a" * 64, "encoding": "float32le", "columns": 9, "rows": 9}}
        with self.assertRaisesRegex(ValueError, "does not match its resolution"):
            validate_domain("prefabs", {"schemaVersion": 1, "documents": [
                _prefab(members=[_member("root", type="terrain", terrainData=terrain)])]})


class RepositoryPrefabTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = ProjectRepository.create(Path(self.tmp.name) / "Project", "Project")

    def tearDown(self):
        self.repo.close()
        self.tmp.cleanup()

    def test_prefabs_and_hierarchy_persist_and_dangling_links_are_rejected(self):
        reference = self.repo.assets.put_stream(io.BytesIO(b"model"), mime="application/octet-stream")
        model = {"id": "model", "name": "Model", "assetId": reference.asset_id, "folder": "Props",
                 "importSettings": {"normalize": True, "targetSize": 5}}
        revision = self.repo.apply_changes({
            "levels": [{"id": "level", "name": "Level"}],
            "models": [model],
            "prefabs": [_prefab(members=[_member("root", modelId="model"), _member("child", parentId="root")], createdAt=1)],
            "objects": [_object("root", modelId="model", prefabId="prefab"), _object("child", parentId="root", prefabId="prefab")],
        }, expected_revision=0)
        self.assertEqual(self.repo.get_domain("prefabs")["documents"][0]["rootId"], "root")
        self.assertEqual(self.repo.get_domain("objects")["documents"][1]["parentId"], "root")
        self.assertEqual(self.repo.get_domain("models")["documents"][0]["importSettings"], {"normalize": True, "targetSize": 5})
        # Removing the prefab while instances still name it is a dangling reference.
        with self.assertRaises(InvalidProjectError):
            self.repo.apply_changes({"prefabs": []}, expected_revision=revision)
        # Removing a parent while its child still points at it is too.
        with self.assertRaises(InvalidProjectError):
            self.repo.apply_changes({"objects": [_object("child", parentId="root")]}, expected_revision=revision)


if __name__ == "__main__":
    unittest.main()
