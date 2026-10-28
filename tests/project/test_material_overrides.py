from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path

from Auvra.project import ProjectRepository
from Auvra.project.errors import InvalidProjectError
from Auvra.project.schemas import domain_document, validate_domain, validate_project_references

ASSET = "a" * 64


def _model(material_overrides, **extra):
    return {"id": "model", "name": "Robot.fbx", "assetId": ASSET, "materialOverrides": material_overrides, **extra}


def _models(*models):
    return domain_document("models", list(models))


def _textures(*identities):
    return domain_document("textures", [
        {"id": identity, "name": f"{identity}.png", "assetId": ASSET, "dimensions": {"width": 1, "height": 1}}
        for identity in identities
    ])


class MaterialOverrideSchemaTests(unittest.TestCase):
    def test_accepts_every_override_field(self):
        override = {
            "color": "#FF8800", "roughness": 0, "metalness": 1, "emissive": "#00ff00",
            "emissiveIntensity": 4.5, "opacity": 0.25, "mapTextureId": "tex-albedo", "normalTextureId": "tex-normal",
        }
        document = validate_domain("models", _models(_model({"Body": override})))
        self.assertEqual(document["documents"][0]["materialOverrides"], {"Body": override})

    def test_material_names_are_not_mistaken_for_nested_records(self):
        # These names are also keys with their own nested-field rules (or free-form blobs).
        names = ["position", "size", "render", "settings", "data", "layout", "dimensions"]
        overrides = {name: {"roughness": 0.5} for name in names}
        document = validate_domain("models", _models(_model(overrides)))
        self.assertEqual(document["documents"][0]["materialOverrides"], overrides)

    def test_override_field_is_optional(self):
        document = validate_domain("models", _models({"id": "model", "name": "Robot.fbx", "assetId": ASSET}))
        self.assertNotIn("materialOverrides", document["documents"][0])
        validate_domain("models", _models(_model({})))

    def test_accepts_a_material_asset_and_its_graph(self):
        document = validate_domain("models", _models(_model({"Body": {"materialId": "mat-glow"}})))
        self.assertEqual(document["documents"][0]["materialOverrides"], {"Body": {"materialId": "mat-glow"}})
        # A graph's nodes carry params of their own type's; they are not the blueprint nodes of that name.
        graph = {
            "nodes": [
                {"id": "output", "type": "output", "x": 480, "y": 120, "params": {"baseColor": [1, 0, 0], "roughness": 0.4}},
                {"id": "tex", "type": "texture", "x": 0, "y": 0, "params": {"texture": "tex-albedo"}},
            ],
            "links": [{"fromNode": "tex", "fromOutput": "rgb", "toNode": "output", "toInput": "baseColor"}],
        }
        materials = validate_domain("materials", domain_document("materials", [{"id": "mat-glow", "name": "Glow", "graph": graph, "textureIds": ["tex-albedo"]}]))
        self.assertEqual(materials["documents"][0]["graph"], graph)

    def test_rejects_a_missing_material_asset(self):
        models = _models(_model({"Body": {"materialId": "mat-missing"}}))
        domains = {"models": models, "textures": _textures(), "materials": domain_document("materials", [])}
        with self.assertRaisesRegex(ValueError, "model material asset"):
            validate_project_references(domains)
        domains["materials"] = domain_document("materials", [{"id": "mat-missing", "name": "Now here", "graph": {"nodes": [], "links": []}}])
        validate_project_references(domains)

    def test_rejects_unknown_override_fields(self):
        with self.assertRaisesRegex(ValueError, "unknown fields in materialOverrides"):
            validate_domain("models", _models(_model({"Body": {"roughness": 0.5, "specular": 1}})))

    def test_rejects_invalid_override_values(self):
        invalid = [
            {"roughness": 1.5},
            {"roughness": -0.1},
            {"metalness": 2},
            {"opacity": -1},
            {"opacity": True},
            {"emissiveIntensity": -0.5},
            {"emissiveIntensity": 101},
            {"color": "red"},
            {"color": "#ff00"},
            {"emissive": "#gggggg"},
            {"mapTextureId": ""},
            {"normalTextureId": "n" * 129},
            {"metalness": "0.5"},
            {},
        ]
        for override in invalid:
            with self.subTest(override=override), self.assertRaises(ValueError):
                validate_domain("models", _models(_model({"Body": override})))

    def test_rejects_malformed_override_maps(self):
        for overrides in ({"Body": "red"}, {"Body": None}, {"": {"opacity": 0.5}}, {"n" * 257: {"opacity": 0.5}}, ["Body"]):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                validate_domain("models", _models(_model(overrides)))

    def test_rejects_more_than_256_materials(self):
        overrides = {f"Material{index}": {"opacity": 0.5} for index in range(257)}
        with self.assertRaises(ValueError):
            validate_domain("models", _models(_model(overrides)))


class MaterialOverrideReferenceTests(unittest.TestCase):
    def test_texture_references_must_exist(self):
        overrides = {"Body": {"mapTextureId": "tex-albedo", "normalTextureId": "tex-normal"}, "Visor": {"opacity": 0.4}}
        validate_project_references({
            "models": _models(_model(overrides)),
            "textures": _textures("tex-albedo", "tex-normal"),
        })
        for missing in ("tex-albedo", "tex-normal"):
            present = [identity for identity in ("tex-albedo", "tex-normal") if identity != missing]
            with self.subTest(missing=missing), self.assertRaisesRegex(ValueError, "invalid model material texture reference"):
                validate_project_references({"models": _models(_model(overrides)), "textures": _textures(*present)})

    def test_overrides_without_textures_need_no_texture_documents(self):
        validate_project_references({"models": _models(_model({"Body": {"color": "#112233", "opacity": 0.5}}))})


class RepositoryMaterialOverrideTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = ProjectRepository.create(Path(self.tmp.name) / "Project", "Project")

    def tearDown(self):
        self.repo.close()
        self.tmp.cleanup()

    def test_overrides_persist_and_dangling_texture_references_are_rejected(self):
        model_asset = self.repo.assets.put_stream(io.BytesIO(b"model"), mime="application/octet-stream").asset_id
        texture_asset = self.repo.assets.put_stream(io.BytesIO(b"texture"), mime="application/octet-stream").asset_id
        texture = {"id": "tex", "name": "tex.png", "assetId": texture_asset, "dimensions": {"width": 1, "height": 1}}
        overrides = {"Body": {"color": "#336699", "mapTextureId": "tex"}, "position": {"opacity": 0.5}}
        model = {"id": "model", "name": "Robot.fbx", "assetId": model_asset, "materialOverrides": overrides}
        revision = self.repo.apply_changes({"textures": [texture], "models": [model]}, expected_revision=0)
        self.assertEqual(self.repo.get_domain("models")["documents"][0]["materialOverrides"], overrides)
        # Deleting a texture an override still names is a dangling reference.
        with self.assertRaises(InvalidProjectError):
            self.repo.apply_changes({"textures": []}, expected_revision=revision)


if __name__ == "__main__":
    unittest.main()
