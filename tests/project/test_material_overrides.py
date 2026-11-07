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
            "emissiveIntensity": 4.5, "opacity": 0.25, "mapTextureId": "tex-albedo", "paintedMap": True, "normalTextureId": "tex-normal",
            "roughnessTextureId": "tex-rough", "metalnessTextureId": "tex-metal",
        }
        document = validate_domain("models", _models(_model({"Body": override})))
        self.assertEqual(document["documents"][0]["materialOverrides"], {"Body": override})

    def test_parameters_may_name_a_texture_or_choose_a_switch(self):
        override = {"materialId": "mat-glow", "parameters": [{"name": "Picture", "value": "tex-dirty"}, {"name": "Worn", "value": True}]}
        document = validate_domain("models", _models(_model({"Body": override})))
        self.assertEqual(document["documents"][0]["materialOverrides"]["Body"], override)
        with self.assertRaises(ValueError):
            validate_domain("models", _models(_model({"Body": {"materialId": "mat-glow", "parameters": [{"name": "Picture", "value": ""}]}})))

    def test_a_placed_object_keeps_its_own_parameter_values_only(self):
        def placed(overrides):
            return {"id": "crate-1", "levelId": "level", "modelId": "model", "name": "Crate", "type": "prop",
                    "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1], "materialOverrides": overrides}
        values = {"Body": {"parameters": [{"name": "Tint", "value": [0, 1, 0]}, {"name": "Worn", "value": False}]}}
        document = validate_domain("objects", domain_document("objects", [placed(values)]))
        self.assertEqual(document["documents"][0]["materialOverrides"], values)
        for bad in ({"Body": {"color": "#ff0000"}}, {"Body": {}}, {"token": {"parameters": [{"name": "Tint", "value": 1}]}}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_domain("objects", domain_document("objects", [placed(bad)]))

    def test_a_texture_keeps_its_import_settings(self):
        settings = {"colorSpace": "data", "normalMap": False, "compression": "bc4", "maxSize": 2048, "wrap": "clamp", "filter": "linear", "mips": True, "flipGreen": True,
                    "source": {"format": "exr", "depth": 32, "channels": 4, "hdr": True}, "preview": {"assetId": "b" * 64}, "compressed": [{"signature": "v1|abc|colour", "assetId": "c" * 64}]}
        document = validate_domain("textures", domain_document("textures", [{"id": "tex-height", "name": "Height.exr", "assetId": "a" * 64, "settings": settings}]))
        self.assertEqual(document["documents"][0]["settings"], settings)
        for bad in ({"compression": "astc"}, {"maxSize": 1000}, {"source": {"format": "gif", "depth": 8, "channels": 4}}, {"preview": {"assetId": "x"}}, {"tint": 1}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_domain("textures", domain_document("textures", [{"id": "t", "name": "T.png", "assetId": "a" * 64, "settings": bad}]))

    def test_accepts_a_physical_materials_values(self):
        override = {
            "coat": 1, "coatRoughness": 0.05, "sheenColor": "#cc6688", "sheenRoughness": 0.4, "thinFilm": 0.5,
            "thinFilmThickness": 420, "transmission": 1, "thickness": 0.02, "attenuationColor": "#88ccff",
            "attenuationDistance": 0.5, "dispersion": 0.2, "ior": 1.52, "specularWeight": 0.8, "specularColor": "#ffffff",
            "anisotropy": 0.6, "anisotropyRotation": 90,
        }
        document = validate_domain("models", _models(_model({"Paint": override})))
        self.assertEqual(document["documents"][0]["materialOverrides"], {"Paint": override})
        for bad in ({"coat": 1.5}, {"ior": 0.5}, {"sheenColor": "pink"}, {"anisotropyRotation": 400}, {"attenuationDistance": 0}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_domain("models", _models(_model({"Paint": bad})))

    def test_a_material_keeps_its_pictures_by_name_and_older_shapes_still_load(self):
        graph = {"nodes": [{"id": "output", "type": "materialOutput", "x": 0, "y": 0, "params": {}}], "links": []}
        pictures = {"baseColor": "tex-albedo", "normal": "tex-normal", "height": "tex-height"}
        one = {"id": "mat-rock", "name": "Rock", "graph": graph, "pictures": pictures, "textureIds": ["tex-albedo", "tex-normal", "tex-height"],
               "textureGraph": {"baked": {"textures": pictures}}}
        older = {"id": "mat-old", "name": "Old", "graph": graph, "textureIds": ["tex-albedo"], "textureGraph": {"baked": {"textures": {"baseColor": "tex-albedo"}}}}
        document = validate_domain("materials", domain_document("materials", [one, older]))
        self.assertEqual(document["documents"][0]["pictures"], pictures)
        self.assertNotIn("pictures", document["documents"][1])
        for bad in ({"shine": "tex-albedo"}, {"baseColor": ""}, {"baseColor": 3}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_domain("materials", domain_document("materials", [{**one, "pictures": bad}]))

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

    def test_accepts_material_parameter_settings(self):
        override = {"materialId": "mat-glow", "parameters": [
            {"name": "Offset", "value": [0.25, -1]},
            {"name": "Tint", "value": [1, 0.5, 0]},
            {"name": "Wave", "value": [1, 2, 3, 4]},
            {"name": "token", "value": 2},
        ]}
        document = validate_domain("models", _models(_model({"Body": override})))
        self.assertEqual(document["documents"][0]["materialOverrides"]["Body"], override)
        # A parameter is a name and a number or 2, 3 or 4 numbers (a Vector 2, a colour or Vector), a texture's id
        # or a switch's choice, nothing more.
        for bad in (
            [{"name": "Tint"}],
            [{"name": "Tint", "value": [1]}],
            [{"name": "Tint", "value": [1, 2, 3, 4, 5]}],
            [{"name": "Tint", "value": [1, "2"]}],
            [{"name": "Tint", "value": "x" * 129}],
            [{"name": "Tint", "value": {"r": 1}}],
            [{"name": "", "value": 1}],
            [{"name": "Tint", "value": 1, "unit": "m"}],
            {"Tint": 1},
        ):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_domain("models", _models(_model({"Body": {"materialId": "mat-glow", "parameters": bad}})))

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
            {"paintedMap": "yes"},
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
