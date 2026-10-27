import unittest

from Auvra.project.schemas import domain_document, validate_domain


class PrefabLinkSchemaTests(unittest.TestCase):
    def _object(self, **fields):
        return {"id": "o1", "levelId": "l1", "name": "Lamp", "type": "prop", "position": [0, 0, 0],
                "rotation": [0, 0, 0], "scale": [1, 1, 1], **fields}

    def test_objects_may_record_the_prefab_object_they_came_from(self):
        validate_domain("objects", domain_document("objects", [self._object(prefabId="pf", prefabObjectId="p-root")]))

    def test_prefab_object_link_must_be_a_non_empty_string(self):
        with self.assertRaises(Exception):
            validate_domain("objects", domain_document("objects", [self._object(prefabObjectId="")]))


if __name__ == "__main__":
    unittest.main()
