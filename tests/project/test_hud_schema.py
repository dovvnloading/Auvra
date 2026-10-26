"""The HUD domain accepts every element the HUD editor writes, including menu buttons."""
from __future__ import annotations

import copy
import json
import re
import tempfile
import unittest
from pathlib import Path

from Auvra.project import ProjectRepository
from Auvra.project.schemas import SCHEMA_DIR, validate_domain

REGISTRY = Path(__file__).resolve().parents[2] / "fbx-viewer (1)" / "components" / "HUDEditor" / "componentRegistry.tsx"
STAGE = {"width": 1920, "height": 1080}
BUTTON = {"width": 420, "height": 72}


def _element(identity, name, kind, props, position, size, z_index, *, locked=False):
    return {
        "id": identity, "name": name, "type": kind, "props": props,
        "position": position, "size": size, "zIndex": z_index,
        "isVisible": True, "isLocked": locked,
    }


def _title(document_id, text, top, font_size):
    return _element(
        f"{document_id}-title", "Title", "Text",
        {"text": text, "color": "#ffffff", "fontSize": font_size, "fontWeight": "bold", "fontFamily": "sans-serif", "textAlign": "center"},
        {"x": (STAGE["width"] - 1200) / 2, "y": top}, {"width": 1200, "height": round(font_size * 1.4)}, 2,
    )


def _buttons(document_id, top, buttons):
    return [
        _element(
            f"{document_id}-{action}", f"{label} Button", "Button",
            {"label": label, "action": action, "variant": variant, "fontSize": 28},
            {"x": (STAGE["width"] - BUTTON["width"]) / 2, "y": top + index * (BUTTON["height"] + 20)},
            dict(BUTTON), 10 + index,
        )
        for index, (action, label, variant) in enumerate(buttons)
    ]


def _document(identity, name, elements):
    return {"id": identity, "name": name, "elements": elements, "layout": dict(STAGE), "commands": []}


# Mirrors createDefaultTitleMenu / createDefaultPauseMenu in components/HUDEditor/HUDEditor.tsx.
TITLE_MENU = _document("menu-title", "Title Menu", [
    _title("menu-title", "GAME TITLE", 220, 96),
    *_buttons("menu-title", 460, [
        ("play", "Play", "primary"), ("continue", "Continue", "secondary"),
        ("options", "Options", "secondary"), ("quit", "Quit", "outline"),
    ]),
])
PAUSE_MENU = _document("menu-pause", "Pause Menu", [
    _element(
        "menu-pause-backdrop", "Backdrop", "Container",
        {"backgroundColor": "rgba(0,0,0,0.6)", "borderColor": "transparent", "borderWidth": 0, "borderRadius": 0},
        {"x": 0, "y": 0}, dict(STAGE), 1, locked=True,
    ),
    _title("menu-pause", "PAUSED", 200, 72),
    *_buttons("menu-pause", 360, [
        ("resume", "Resume", "primary"), ("save", "Save", "secondary"), ("load", "Load", "secondary"),
        ("options", "Options", "secondary"), ("quit", "Quit to title", "outline"),
    ]),
])
# Library defaults (AVAILABLE_COMPONENTS) plus a localized key, a level action and live bindings.
MAIN_HUD = _document("hud-main", "Main HUD", [
    _element(
        "start", "Button 1", "Button",
        {"label": "Button", "labelKey": "menu.start", "action": "openLevel:level-1", "variant": "ghost", "fontSize": 24},
        {"x": 800, "y": 508}, {"width": 320, "height": 64}, 1,
    ),
    _element(
        "score", "Text Block 2", "Text",
        {"text": "HUD ELEMENT", "textKey": "hud.score", "color": "#ffffff", "fontSize": 16, "fontWeight": "bold",
         "fontFamily": "monospace", "textAlign": "left", "bind": {"text": "vars.score"}},
        {"x": 860, "y": 520}, {"width": 200, "height": 40}, 2,
    ),
    _element(
        "health", "Health Widget 3", "HealthBar",
        {"value": 85, "max": 100, "barColor": "#dc2626", "backgroundColor": "#1f2937", "showIcon": True, "showText": True,
         "bind": {"value": "player.health", "max": "player.maxHealth"}},
        {"x": 835, "y": 510}, {"width": 250, "height": 60}, 3,
    ),
])


def _hud(*documents):
    return {"schemaVersion": 1, "documents": [copy.deepcopy(document) for document in documents]}


class HudSchemaTests(unittest.TestCase):
    def test_button_elements_and_default_menus_validate(self):
        value = _hud(MAIN_HUD, TITLE_MENU, PAUSE_MENU)
        self.assertEqual(validate_domain("hud", value), value)

    def test_unregistered_element_types_are_still_rejected(self):
        slider = copy.deepcopy(MAIN_HUD)
        slider["elements"][0]["type"] = "Slider"
        with self.assertRaises(ValueError):
            validate_domain("hud", _hud(slider))

    def test_schema_lists_every_registered_hud_component(self):
        if not REGISTRY.exists():
            self.skipTest("frontend sources are not part of this checkout")
        source = REGISTRY.read_text(encoding="utf-8")
        block = re.search(r"COMPONENT_REGISTRY[^=]*=\s*\{(.*?)\};", source, re.S)
        self.assertIsNotNone(block)
        registered = set(re.findall(r"^\s*'(\w+)'\s*:", block.group(1), re.M))
        schema = json.loads((SCHEMA_DIR / "hud.schema.json").read_text(encoding="utf-8"))
        element = schema["properties"]["documents"]["items"]["properties"]["elements"]["items"]
        self.assertIn("Button", registered)
        self.assertEqual(set(element["properties"]["type"]["enum"]), registered)


class HudRepositoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = ProjectRepository.create(Path(self.tmp.name) / "HUD", "HUD")
        self.addCleanup(self.repo.close)

    def test_menus_with_buttons_save_and_reload_through_the_repository(self):
        revision = self.repo.apply_changes(
            {"hud": copy.deepcopy([MAIN_HUD, TITLE_MENU, PAUSE_MENU])}, expected_revision=0,
        )
        self.assertEqual(revision, 1)
        saved = {document["id"]: document for document in self.repo.get_domain("hud")["documents"]}
        self.assertEqual(saved["menu-title"], TITLE_MENU)
        self.assertEqual(saved["menu-pause"], PAUSE_MENU)
        self.assertEqual(saved["hud-main"]["elements"][0]["type"], "Button")
        self.assertEqual(saved["hud-main"]["elements"][1]["props"]["bind"], {"text": "vars.score"})


if __name__ == "__main__":
    unittest.main()
