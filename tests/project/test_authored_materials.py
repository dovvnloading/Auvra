from __future__ import annotations

import unittest

from Auvra.project.schemas import domain_document, validate_domain, validate_project_references

ASSET = "a" * 64
OTHER = "b" * 64


def _textures(*identities):
    return domain_document("textures", [
        {"id": identity, "name": f"{identity}.png", "assetId": ASSET, "dimensions": {"width": 1, "height": 1}}
        for identity in identities
    ])


def _material(**extra):
    return {"id": "bricks", "name": "Brick wall", "graph": {"nodes": [], "links": []}, "textureIds": [], **extra}


class AuthoredMaterialTests(unittest.TestCase):
    def test_keeps_a_texture_graph_with_its_node_settings(self):
        texture_graph = {
            "graph": {
                "version": 1, "size": {"w": 10, "h": 10}, "seed": 3,
                "nodes": [{"id": "n1", "type": "tiles", "x": 0, "y": 0, "params": {"gap": {"$bind": "gap"}, "columns": 4}}],
                "links": [], "parameters": [{"name": "gap", "label": "Gap", "kind": "float", "default": 0.05}],
            },
            "values": {"gap": 0.1}, "bakeSize": 11, "layout": "engine",
            "baked": {"textures": {"baseColor": "made"}, "signature": "x", "size": 11, "at": 1},
        }
        document = validate_domain("materials", domain_document("materials", [_material(textureGraph=texture_graph, textureIds=["made"])]))
        self.assertEqual(document["documents"][0]["textureGraph"], texture_graph)

    def test_keeps_painted_layers_and_checks_the_pictures_they_name(self):
        paint = {"version": 1, "layers": [{"id": "l1", "kind": "paint", "bitmaps": {"baseColor": {"1001": {"assetId": OTHER}}}}]}
        materials = domain_document("materials", [_material(paint=paint)])
        domains = {"materials": materials, "textures": _textures()}
        validate_project_references(domains, asset_exists=lambda asset: asset == OTHER)
        with self.assertRaises(ValueError):
            validate_project_references(domains, asset_exists=lambda asset: False)

    def test_texture_ids_of_an_authored_material_must_exist(self):
        materials = domain_document("materials", [_material(textureGraph={"graph": {"nodes": []}}, textureIds=["missing"])])
        with self.assertRaises(ValueError):
            validate_project_references({"materials": materials, "textures": _textures()})
        validate_project_references({"materials": materials, "textures": _textures("missing")})


if __name__ == "__main__":
    unittest.main()
