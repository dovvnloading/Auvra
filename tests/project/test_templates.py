from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any

from Auvra.project.errors import InvalidProjectError
from Auvra.project.repository import ProjectRepository
from Auvra.project.service import ProjectService
from Auvra.project.index import ProjectIndex
from Auvra.project.templates import TEMPLATE_NAMES, apply_template


def documents(repository: ProjectRepository, domain: str) -> list[dict]:
    value = repository.get_domain(domain)
    return value["documents"] if isinstance(value, dict) else value


def components(item: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    return [component for component in item.get("components") or [] if component["type"] == kind and component["enabled"]]


class Graph:
    """Read-only view of a level blueprint: nodes by id and the wire into or out of each pin."""

    def __init__(self, blueprint: dict[str, Any]) -> None:
        self.blueprint = blueprint
        self.nodes = {node["id"]: node for node in blueprint["nodes"]}

    def pin(self, node_id: str, name: str, direction: str) -> dict[str, Any]:
        pins = self.nodes[node_id]["inputs" if direction == "Input" else "outputs"]
        return next(pin for pin in pins if pin["name"] == name)

    def source(self, node_id: str, pin_name: str) -> dict[str, Any] | None:
        """The node wired into a data input, or None when it reads its default."""
        pin = self.pin(node_id, pin_name, "Input")
        wire = next((c for c in self.blueprint["connections"] if c["toPinId"] == pin["id"]), None)
        return self.nodes[wire["fromNodeId"]] if wire else None

    def next(self, node_id: str, pin_name: str) -> dict[str, Any] | None:
        pin = self.pin(node_id, pin_name, "Output")
        wire = next((c for c in self.blueprint["connections"] if c["fromPinId"] == pin["id"]), None)
        return self.nodes[wire["toNodeId"]] if wire else None

    def flow(self, node_id: str) -> list[dict[str, Any]]:
        """Nodes run after ``node_id`` following each node's first exec output (Branch: True)."""
        chain = []
        node: dict[str, Any] | None = self.nodes[node_id]
        while node is not None:
            exec_outputs = [pin["name"] for pin in node["outputs"] if pin["dataType"] == "Exec"]
            node = self.next(node["id"], exec_outputs[0]) if exec_outputs else None
            if node is not None:
                chain.append(node)
        return chain


class TemplateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        # Cleanups run last-in first-out, so repositories close before the folder is removed.
        self.addCleanup(self.tmp.cleanup)

    def create(self, name: str) -> ProjectRepository:
        repository = ProjectRepository.create(self.root / name, name.title())
        self.addCleanup(repository.close)
        return repository

    def test_template_names_list_every_template(self) -> None:
        self.assertEqual(TEMPLATE_NAMES, ("blank", "starter", "arena", "courtyard"))

    def test_starter_template_is_a_valid_playable_project(self) -> None:
        repository = self.create("starter")
        apply_template(repository, "starter", project_name="Starter")
        objects = documents(repository, "objects")
        kinds = {item["type"] for item in objects}
        self.assertTrue({"terrain", "sky_sphere", "player_start", "prop"} <= kinds)
        level_ids = {item["id"] for item in documents(repository, "levels")}
        self.assertTrue(all(item["levelId"] in level_ids for item in objects))
        model_ids = {item["id"] for item in documents(repository, "models")}
        self.assertTrue(all(item["modelId"] in model_ids for item in objects if item["type"] == "prop"))
        settings = next(item for item in documents(repository, "metadata") if item["id"] == "game-settings")["settings"]
        self.assertIn(settings["startupLevelId"], level_ids)
        player = next(item for item in documents(repository, "blueprints") if item["id"] == settings["playerBlueprintId"])
        self.assertIn(player["linkedModelId"], model_ids)
        for asset_id in repository.referenced_asset_ids():
            self.assertTrue(repository.assets.verify(asset_id), asset_id)

    def test_blank_template_leaves_the_project_empty(self) -> None:
        repository = self.create("blank")
        revision = repository.revision
        apply_template(repository, "blank", project_name="Blank")
        apply_template(repository, None, project_name="Blank")
        self.assertEqual(repository.revision, revision)
        self.assertEqual(documents(repository, "objects"), [])

    def test_unknown_template_is_rejected(self) -> None:
        repository = self.create("other")
        for template in ("shooter", 42):
            with self.assertRaises(InvalidProjectError):
                apply_template(repository, template, project_name="Other")

    def test_service_create_applies_the_template(self) -> None:
        service = ProjectService(ProjectIndex(self.root / "index.sqlite3"))
        try:
            for template in TEMPLATE_NAMES[1:]:
                with self.subTest(template=template):
                    service.create(self.root / f"via-service-{template}", "Via Service", template)
                    self.assertGreater(len(documents(service.active, "objects")), 3)
        finally:
            service.shutdown()

    # -- arena --------------------------------------------------------------------------------

    def arena(self) -> ProjectRepository:
        repository = self.create("arena")
        apply_template(repository, "arena", project_name="Arena Sample")
        return repository

    def arena_levels(self, repository: ProjectRepository) -> tuple[dict[str, Any], dict[str, Any]]:
        levels = {item["name"]: item for item in documents(repository, "levels")}
        self.assertEqual(set(levels), {"Arena", "Finish"})
        return levels["Arena"], levels["Finish"]

    def test_arena_template_is_a_valid_project_whose_references_resolve(self) -> None:
        repository = self.arena()
        arena, finish = self.arena_levels(repository)
        objects = documents(repository, "objects")
        self.assertTrue({"terrain", "sky_sphere", "player_start", "prop", "spawn_point"}
                        <= {item["type"] for item in objects})
        for level in (arena, finish):
            kinds = [item["type"] for item in objects if item["levelId"] == level["id"]]
            for kind in ("terrain", "sky_sphere", "player_start"):
                self.assertEqual(kinds.count(kind), 1, (level["name"], kind))

        level_ids = {arena["id"], finish["id"]}
        model_ids = {item["id"] for item in documents(repository, "models")}
        blueprints = {item["id"]: item for item in documents(repository, "blueprints")}
        audio_ids = {item["id"] for item in documents(repository, "audio")}
        self.assertTrue(all(item["levelId"] in level_ids for item in objects))
        for item in objects:
            if item["type"] == "prop":
                self.assertIn(item["modelId"], model_ids, item["id"])
        for blueprint in blueprints.values():
            self.assertIn(blueprint["linkedModelId"], model_ids, blueprint["id"])

        settings = next(item for item in documents(repository, "metadata") if item["id"] == "game-settings")["settings"]
        self.assertEqual((settings["name"], settings["startupLevelId"]), ("Arena Sample", arena["id"]))
        self.assertEqual(blueprints[settings["playerBlueprintId"]]["type"], "Player Character")

        # The spawner places enemies from an Enemy Controller blueprint tuned by the AI stats.
        spawners = [item for item in objects if item["type"] == "spawn_point"]
        self.assertEqual(len(spawners), 1)
        config = spawners[0]["spawnConfig"]
        self.assertGreater(config["interval"], 0)
        self.assertGreater(config["maxSpawns"], 0)
        enemy = blueprints[config["blueprintId"]]
        self.assertEqual(enemy["type"], "Enemy Controller")
        self.assertTrue({"Health", "Speed", "Attack Range", "Attack Cooldown", "Sight Range"}
                        <= {stat["name"] for stat in enemy["stats"]})

        # Sounds the blueprint plays, levels it opens and menus it shows all exist.
        for level in (arena, finish):
            for node in level["blueprint"]["nodes"]:
                if node["type"] == "PlaySound":
                    self.assertIn(node["data"]["default_Sound"], audio_ids)
                if node["type"] == "LevelAction" and node["data"]["action"] == "OpenLevel":
                    self.assertIn(node["data"]["levelId"], level_ids)
        for asset_id in repository.referenced_asset_ids():
            self.assertTrue(repository.assets.verify(asset_id), asset_id)
        mimes = {repository.assets.reference(asset_id).mime for asset_id in repository.referenced_asset_ids()}
        self.assertEqual(mimes, {"model/fbx", "audio/wav", "application/vnd.auvra.heightfield"})

        # The project reopens: every document validates again from disk.
        path, revision = repository.path, repository.revision
        repository.close()
        with ProjectRepository(path) as reopened:
            self.assertEqual(reopened.revision, revision)
            self.assertEqual(len(documents(reopened, "objects")), len(objects))

    def test_arena_coins_are_triggers_that_the_level_blueprint_scores(self) -> None:
        repository = self.arena()
        arena, finish = self.arena_levels(repository)
        coins = [item for item in documents(repository, "objects")
                 if item["levelId"] == arena["id"] and item["name"].startswith("Coin")]
        self.assertTrue(3 <= len(coins) <= 5)
        for coin in coins:
            triggers = components(coin, "collider")
            self.assertEqual(len(triggers), 1, coin["id"])
            self.assertIs(triggers[0]["props"]["isTrigger"], True)
            self.assertEqual(len(components(coin, "rotator")), 1, coin["id"])
            self.assertEqual(components(coin, "particles")[0]["props"]["preset"], "sparks")
            self.assertEqual(components(coin, "rigidBody"), [], coin["id"])

        blueprint = arena["blueprint"]
        self.assertEqual(blueprint["variables"], [{"id": "arena-variable-score", "name": "score", "type": "Float", "value": 0}])
        graph = Graph(blueprint)
        events = [node for node in blueprint["nodes"] if node["type"] == "Event" and "Overlap" in node["name"]]
        self.assertEqual(sorted(node["data"]["targetActorId"] for node in events), sorted(coin["id"] for coin in coins))
        for event in events:
            chain = graph.flow(event["id"])
            self.assertEqual([node["type"] for node in chain], ["SetLevelVariable", "PlaySound", "DestroyActor", "Print"])
            increment = chain[0]
            self.assertEqual(increment["data"]["default_Name"], "score")
            # score = Get Level Variable(score) + 1
            add = graph.source(increment["id"], "Value")
            self.assertEqual((add["type"], add["data"]["default_B"]), ("Add", 1))
            self.assertEqual([pin["name"] for pin in add["inputs"][:2]], ["A", "B"])
            read = graph.source(add["id"], "A")
            self.assertEqual((read["type"], read["data"]["default_Name"]), ("GetLevelVariable", "score"))
            self.assertEqual(graph.source(chain[3]["id"], "Arg 0"), read)

        # Every frame: once score equals the coin count, print, wait, then open the Finish level (once).
        tick = next(node for node in blueprint["nodes"] if node["name"] == "Event Tick")
        sequence = graph.next(tick["id"], "Exec")
        check = graph.next(sequence["id"], "Then 0")
        self.assertEqual(check["type"], "Branch")
        equal = graph.source(check["id"], "Condition")
        self.assertEqual((equal["type"], equal["data"]["default_B"]), ("Equal", len(coins)))
        self.assertEqual(graph.source(equal["id"], "A")["data"]["default_Name"], "score")
        once = graph.next(check["id"], "True")
        finale = [once, *graph.flow(once["id"])]
        self.assertEqual([node["type"] for node in finale], ["DoOnce", "PrintString", "Delay", "LevelAction"])
        self.assertIn("Level complete", finale[1]["data"]["printMessage"])
        self.assertEqual(finale[3]["data"], {"action": "OpenLevel", "levelId": finish["id"]})
        # ...and a dead player restarts the level.
        death = graph.next(sequence["id"], "Then 1")
        self.assertEqual(graph.source(death["id"], "Condition")["data"]["variableName"], "IsDead")
        self.assertEqual(graph.next(death["id"], "True")["data"], {"action": "Restart"})

        begin = next(node for node in finish["blueprint"]["nodes"] if node["name"] == "Event BeginPlay")
        self.assertEqual(Graph(finish["blueprint"]).flow(begin["id"])[0]["type"], "PrintString")

    def test_arena_blueprint_wires_join_existing_pins_like_the_editor(self) -> None:
        repository = self.arena()
        for level in self.arena_levels(repository):
            blueprint = level["blueprint"]
            nodes = {node["id"]: node for node in blueprint["nodes"]}
            self.assertEqual(len(nodes), len(blueprint["nodes"]))
            pins = [pin["id"] for node in nodes.values() for pin in node["inputs"] + node["outputs"]]
            self.assertEqual(len(pins), len(set(pins)))
            wired_inputs: set[str] = set()
            for wire in blueprint["connections"]:
                source = next(p for p in nodes[wire["fromNodeId"]]["outputs"] if p["id"] == wire["fromPinId"])
                target = next(p for p in nodes[wire["toNodeId"]]["inputs"] if p["id"] == wire["toPinId"])
                self.assertEqual(source["dataType"] == "Exec", target["dataType"] == "Exec", wire["id"])
                # The editor keeps one wire per input pin.
                self.assertNotIn(target["id"], wired_inputs)
                wired_inputs.add(target["id"])
            for node in nodes.values():
                for pin in node["inputs"]:
                    self.assertEqual(pin["direction"], "Input")
                    if pin["dataType"] == "Exec" and pin["name"] == "Exec":
                        self.assertIn(pin["id"], wired_inputs, f"{node['id']} never runs")
                    elif pin["dataType"] != "Exec" and pin["id"] not in wired_inputs and not pin["name"].startswith("Arg "):
                        # An unwired data input reads data['default_<pin>'] (unused Print args stay blank).
                        self.assertIn(f"default_{pin['name']}", node.get("data", {}), f"{node['id']}.{pin['name']}")

    def test_arena_has_solid_cover_and_pushable_crates(self) -> None:
        repository = self.arena()
        arena, finish = self.arena_levels(repository)
        crates = [item for item in documents(repository, "objects")
                  if item["levelId"] == arena["id"] and item["modelId"] == "arena-model-crate"]
        cover = [item for item in crates if not components(item, "rigidBody")]
        pushable = [item for item in crates if components(item, "rigidBody")]
        self.assertGreaterEqual(len(cover), 8)
        self.assertGreaterEqual(len(pushable), 2)
        for item in crates:
            (collider,) = components(item, "collider")
            self.assertEqual((collider["props"]["shape"], collider["props"]["isTrigger"]), ("box", False))
        for item in pushable:
            self.assertEqual(components(item, "rigidBody")[0]["props"]["type"], "dynamic")
        ids = [component["id"] for item in documents(repository, "objects") for component in item.get("components") or []]
        self.assertEqual(len(ids), len(set(ids)))

    def test_arena_hud_shows_the_score_and_authored_menus(self) -> None:
        repository = self.arena()
        hud = {item["id"]: item for item in documents(repository, "hud")}
        self.assertEqual(set(hud), {"hud-main", "menu-title", "menu-pause"})
        main = hud["hud-main"]["elements"]
        score = [element for element in main if element["props"].get("bind") == {"text": "vars.score"}]
        self.assertEqual([element["type"] for element in score], ["Text"])
        self.assertTrue(any(element["type"] == "Text" and element["props"]["text"] == "Coins:" for element in main))

        def actions(document_id: str) -> list[str]:
            return [element["props"]["action"] for element in hud[document_id]["elements"] if element["type"] == "Button"]

        self.assertEqual(actions("menu-title"), ["play", "options", "quit"])
        self.assertEqual(actions("menu-pause"), ["resume", "save", "load", "options", "quit"])
        for document in hud.values():
            self.assertEqual(document["layout"], {"width": 1920, "height": 1080})
            for element in document["elements"]:
                self.assertTrue(element["isVisible"])
                self.assertLessEqual(element["position"]["x"] + element["size"]["width"], 1920, element["id"])
                self.assertLessEqual(element["position"]["y"] + element["size"]["height"], 1080, element["id"])
                if element["type"] == "Button":
                    self.assertTrue(element["props"]["label"].strip())

    # -- courtyard ----------------------------------------------------------------------------

    def courtyard(self) -> tuple[ProjectRepository, dict[str, Any], dict[str, dict[str, Any]]]:
        repository = self.create("courtyard")
        apply_template(repository, "courtyard", project_name="Courtyard Sample")
        levels = documents(repository, "levels")
        self.assertEqual([level["name"] for level in levels], ["Courtyard"])
        objects = {item["id"]: item for item in documents(repository, "objects")}
        return repository, levels[0], objects

    def test_courtyard_template_is_a_valid_project_whose_references_resolve(self) -> None:
        repository, level, objects = self.courtyard()
        kinds = [item["type"] for item in objects.values()]
        for kind in ("terrain", "sky_sphere", "player_start"):
            self.assertEqual(kinds.count(kind), 1, kind)
        model_ids = {item["id"] for item in documents(repository, "models")}
        for item in objects.values():
            self.assertEqual(item["levelId"], level["id"])
            # A prop has a model, or none at all (an empty object that only carries components).
            if item["type"] == "prop" and item["modelId"]:
                self.assertIn(item["modelId"], model_ids, item["id"])
            elif item["type"] == "prop":
                self.assertTrue(item.get("components"), item["id"])
        settings = next(item for item in documents(repository, "metadata") if item["id"] == "game-settings")["settings"]
        self.assertEqual((settings["name"], settings["startupLevelId"]), ("Courtyard Sample", level["id"]))
        player = next(item for item in documents(repository, "blueprints") if item["id"] == settings["playerBlueprintId"])
        self.assertEqual(player["type"], "Player Character")
        for asset_id in repository.referenced_asset_ids():
            self.assertTrue(repository.assets.verify(asset_id), asset_id)

        path, revision = repository.path, repository.revision
        repository.close()
        with ProjectRepository(path) as reopened:
            self.assertEqual(reopened.revision, revision)

    def test_courtyard_keeper_dialogue_leads_somewhere_on_every_path(self) -> None:
        _, _, objects = self.courtyard()
        keeper = objects["courtyard-keeper"]
        [dialogue] = components(keeper, "dialogue")
        data = dialogue["props"]["dialogue"]
        lines = {line["id"]: line for line in data["lines"]}
        self.assertIn(data["startId"], lines)
        for line in lines.values():
            targets = [line["next"]] + [choice["next"] for choice in line.get("choices", [])]
            for target in targets:
                self.assertTrue(target is None or target in lines, (line["id"], target))
        self.assertGreater(dialogue["props"]["radius"], 0)
        # The keeper stands beside the gate, not in the way out.
        self.assertGreater(abs(keeper["position"][0]), 2.5)

    def test_courtyard_relics_open_the_gate_that_leads_to_the_exit(self) -> None:
        repository, level, objects = self.courtyard()
        audio_ids = {item["id"] for item in documents(repository, "audio")}
        relics = [item for item in objects.values() if item["name"].startswith("Relic")]
        self.assertEqual(len(relics), 3)
        for relic in relics:
            [trigger] = components(relic, "collider")
            self.assertIs(trigger["props"]["isTrigger"], True)
            [script] = components(relic, "script")
            source = script["props"]["source"]
            self.assertIn("function onTriggerEnter", source)
            self.assertIn("const SCORE_VARIABLE = 'relics';", source)
            sound = source.split("const PICKUP_SOUND = '")[1].split("'")[0]
            self.assertIn(sound, audio_ids)

        # The gate halves are kinematic, so their colliders follow the timeline that sinks them.
        [timeline] = components(objects["courtyard-gate-mechanism"], "timeline")
        self.assertEqual(timeline["props"]["playVariable"], "gate_open")
        self.assertIs(timeline["props"]["autoplay"], False)
        tracks = timeline["props"]["timeline"]["tracks"]
        self.assertEqual(len(tracks), 2)
        for track in tracks:
            gate = objects[track["objectId"]]
            self.assertEqual(components(gate, "rigidBody")[0]["props"]["type"], "kinematicPosition")
            start, end = track["position"][0]["value"], track["position"][-1]["value"]
            self.assertEqual(start, gate["position"])
            self.assertLess(end[1], -2.5)

        graph = Graph(level["blueprint"])
        nodes = level["blueprint"]["nodes"]
        [opener] = [node for node in nodes if node["type"] == "SetLevelVariable"]
        self.assertEqual((opener["data"]["default_Name"], opener["data"]["default_Value"]), ("gate_open", "1"))
        [equal] = [node for node in nodes if node["type"] == "Equal"]
        self.assertEqual(equal["data"]["default_B"], len(relics))
        self.assertEqual(graph.source(equal["id"], "A")["data"]["default_Name"], "relics")
        [leave] = [node for node in nodes if node["type"] == "Event" and "Overlap" in node["name"]]
        exit_trigger = objects[leave["data"]["targetActorId"]]
        self.assertIs(components(exit_trigger, "collider")[0]["props"]["isTrigger"], True)
        self.assertLess(exit_trigger["position"][2], objects["courtyard-gate-left"]["position"][2])
        self.assertEqual(graph.flow(leave["id"])[-1]["data"]["action"], "EndGame")
        for node in nodes:
            if node["type"] == "PlaySound":
                self.assertIn(node["data"]["default_Sound"], audio_ids)

        hud = {item["id"]: item for item in documents(repository, "hud")}
        bound = [element for element in hud["hud-main"]["elements"] if element["props"].get("bind") == {"text": "vars.relics"}]
        self.assertEqual(len(bound), 1)


if __name__ == "__main__":
    unittest.main()
