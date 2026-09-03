from __future__ import annotations
import io, json, os, subprocess, sys, tempfile, time, unittest, zipfile
from pathlib import Path
from unittest import mock

from Auvra.project import ProjectRepository, AssetStore, ProjectIndex, ProjectService, canonical_json
import Auvra.project.repository as repository_module
from Auvra.project.errors import (ArchiveValidationError, InvalidProjectError,
                                  ReadOnlyError, RecoveryRequiredError, RevisionConflictError)
from Auvra.project.legacy import LegacyArchive
from Auvra.project.schemas import (
    DOMAIN_NAMES,
    domain_document,
    validate_domain,
    validate_project_references,
)

class ProjectTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name) / "Проект 🚀"
        self.repo = ProjectRepository.create(self.root, "Проект 🚀")
    def tearDown(self): self.repo.close(); self.tmp.cleanup()
    def test_format_and_deterministic_round_trip(self):
        self.assertEqual(canonical_json({"z": 1, "a": "é"}), '{"a":"é","z":1}\n')
        rev = self.repo.apply_changes({"metadata": [{"id":"meta", "name":"é"}]}, expected_revision=0)
        self.assertEqual(rev, 1); self.assertEqual(self.repo.get_domain("metadata")["documents"][0]["name"], "é")
        self.assertEqual(self.repo.snapshot(["metadata"]).domains["metadata"]["documents"][0]["id"], "meta")
    def test_candidate_revision_rejects_dangling_domain_and_asset_references(self):
        self.repo.apply_changes({"levels": [{"id": "level", "name": "Level"}]}, expected_revision=0)
        with self.assertRaises(InvalidProjectError):
            self.repo.apply_changes({"objects": [{"id": "object", "levelId": "level", "modelId": "missing", "name": "Object", "type": "prop"}]}, expected_revision=1)
        with self.assertRaises(InvalidProjectError):
            self.repo.apply_changes({"models": [{"id": "model", "name": "Model", "assetId": "a" * 64}]}, expected_revision=1)
        reference = self.repo.assets.put_stream(io.BytesIO(b"model"), mime="application/octet-stream")
        self.repo.apply_changes({"models": [{"id": "model", "name": "Model", "assetId": reference.asset_id}]}, expected_revision=1)
        self.repo.apply_changes({"objects": [{"id": "object", "levelId": "level", "modelId": "model", "name": "Object", "type": "prop"}]}, expected_revision=2)
    def test_revision_and_readonly_lock(self):
        second = ProjectRepository(self.root)
        try:
            self.assertTrue(second.read_only)
            with self.assertRaises(ReadOnlyError): second.apply_changes({"metadata": []}, expected_revision=0)
            with self.assertRaises(RevisionConflictError): self.repo.apply_changes({"metadata": []}, expected_revision=2)
        finally: second.close()

    def test_existing_project_rejects_linked_authority_before_locking(self):
        self.repo.close()
        original = repository_module._is_reparse
        with mock.patch.object(repository_module, "_is_reparse", side_effect=lambda path: Path(path) == self.root / "Project" or original(path)):
            with self.assertRaises(InvalidProjectError):
                ProjectRepository(self.root)
        self.repo = ProjectRepository(self.root)

    def test_existing_project_rejects_linked_document_before_recovery(self):
        self.repo.close()
        authored = self.root / "Project" / "textures.json"
        authored.write_text('{"schemaVersion":1,"documents":[]}', encoding="utf-8")
        original = repository_module._is_reparse

        def linked(path):
            return Path(path) == authored or original(path)

        with mock.patch.object(repository_module, "_is_reparse", side_effect=linked), \
             mock.patch.object(ProjectRepository, "_recover") as recover:
            with self.assertRaises(InvalidProjectError):
                ProjectRepository(self.root)
            recover.assert_not_called()
        self.repo = ProjectRepository(self.root)

    def test_readonly_opener_never_recovers_a_writer_transaction(self):
        journal = self.root / ".auvra" / "transactions" / "writer-active.json"
        journal.write_text(json.dumps({"state": "prepared", "newRevision": 1}), encoding="utf-8")
        before = journal.read_bytes()
        with self.assertRaises(RecoveryRequiredError):
            ProjectRepository(self.root)
        self.assertEqual(journal.read_bytes(), before)
        journal.unlink()
    def test_streaming_asset_address_and_verification(self):
        store = self.repo.assets; data = b"abc" * 10000
        ref = store.put_stream(io.BytesIO(data), size=len(data), chunk_size=7, mime="model/gltf")
        self.assertEqual(ref.size, len(data)); self.assertTrue(store.verify(ref.asset_id))
        with store.open(ref.asset_id) as stream: self.assertEqual(stream.read(), data)

    def test_reingest_repairs_corrupt_existing_hash_named_asset(self):
        store = self.repo.assets
        authentic = b"authentic-content"
        reference = store.put_stream(io.BytesIO(authentic), name="asset.bin")
        target = store.path_for(reference.asset_id)
        target.write_bytes(b"corrupt-content")
        self.assertFalse(store.verify(reference.asset_id, expected_size=len(authentic)))
        repaired = store.put_stream(io.BytesIO(authentic), size=len(authentic), name="asset.bin")
        self.assertEqual(repaired.asset_id, reference.asset_id)
        self.assertTrue(store.verify(reference.asset_id, expected_size=len(authentic)))
        with store.open(reference.asset_id) as stream:
            self.assertEqual(stream.read(), authentic)

    def test_autosave_eligibility(self):
        self.repo.apply_changes({"metadata": [{"id":"m"}]}, expected_revision=0)
        now = 1000
        self.assertTrue(self.repo.autosave_due(dirty_since=900, last_mutation=994, now=now))
        self.assertFalse(self.repo.autosave_due(dirty_since=950, last_mutation=994, now=now))
    def test_interrupted_transaction_recovers_previous_revision(self):
        self.repo.apply_changes({"metadata": [{"id":"old", "name":"old"}]}, expected_revision=0)
        original_replace = repository_module.os.replace
        calls = {"count": 0}
        def fail_after_first(source, target):
            calls["count"] += 1
            if calls["count"] == 2: raise OSError("simulated interruption")
            return original_replace(source, target)
        with mock.patch.object(repository_module.os, "replace", side_effect=fail_after_first):
            with self.assertRaises(OSError): self.repo.apply_changes({"metadata": [{"id":"new"}], "levels": [{"id":"l", "name":"L"}]}, expected_revision=1)
        self.repo.close(); self.repo = ProjectRepository(self.root)
        self.assertEqual(self.repo.revision, 1); self.assertEqual(self.repo.get_domain("metadata")["documents"][0]["id"], "old")
    def test_fault_at_every_replace_boundary_recovers_old_or_new(self):
        # Cover journal publication, each document replacement, descriptor
        # commit, committed-journal replacement, and post-commit cleanup.
        for failure_at in range(1, 7):
            root = Path(self.tmp.name) / f"fault-{failure_at}"; repo = ProjectRepository.create(root, "fault")
            repo.apply_changes({"metadata": [{"id":"old"}]}, expected_revision=0)
            original = repository_module.os.replace; calls = {"n": 0}
            def fail(source, target):
                calls["n"] += 1
                if calls["n"] == failure_at: raise OSError("injected failure")
                return original(source, target)
            with mock.patch.object(repository_module.os, "replace", side_effect=fail):
                try: repo.apply_changes({"metadata": [{"id":"new"}], "levels": [{"id":"l","name":"L"}]}, expected_revision=1)
                except OSError: pass
            repo.close(); repo = ProjectRepository(root)
            self.assertIn(repo.get_domain("metadata")["documents"][0]["id"], ("old", "new")); repo.close()
    def test_save_as_failure_leaves_no_partial_destination(self):
        destination = Path(self.tmp.name) / "save-as-target"
        with mock.patch.object(repository_module.shutil, "copytree", side_effect=OSError("disk full")):
            with self.assertRaises(OSError): self.repo.save_as(destination)
        self.assertFalse(destination.exists())
    def test_save_as_same_name_keeps_descriptor(self):
        destination = Path(self.tmp.name) / "same-name"
        copy = self.repo.save_as(destination, name=self.repo.name)
        try:
            self.assertTrue((destination / f"{self.repo.name}.auvra").is_file())
        finally: copy.close()

    def test_save_as_and_import_publish_authority_directories_with_rename(self):
        original_replace = repository_module.os.replace
        save_as_destination = Path(self.tmp.name) / "staged-save-as"
        seen_save_as: list[bool] = []

        def inspect_save_as(source, target):
            if Path(target) == save_as_destination:
                seen_save_as.append((Path(source) / ".auvra" / "transactions").is_dir())
            return original_replace(source, target)

        with mock.patch.object(repository_module.os, "replace", side_effect=inspect_save_as):
            copied = self.repo.save_as(save_as_destination)
        copied.close()
        self.assertEqual(seen_save_as, [True])
        self.assertTrue((save_as_destination / ".auvra" / "transactions").is_dir())

        archive = Path(self.tmp.name) / "staged-import.auvrapack"
        self.repo.export_pack(archive)
        import_destination = Path(self.tmp.name) / "staged-import"
        seen_import: list[bool] = []

        def inspect_import(source, target):
            if Path(target) == import_destination:
                seen_import.append((Path(source) / ".auvra" / "transactions").is_dir())
            return original_replace(source, target)

        with mock.patch.object(repository_module.os, "replace", side_effect=inspect_import):
            imported = ProjectRepository.import_pack(archive, import_destination)
        imported.close()
        self.assertEqual(seen_import, [True])
        self.assertTrue((import_destination / ".auvra" / "transactions").is_dir())

    def test_recovery_count_and_byte_cap(self):
        self.repo.apply_changes({"metadata": [{"id":"m", "description":"0123456789"}]}, expected_revision=0)
        with mock.patch.object(repository_module, "PROJECT_CAP", 1):
            for _ in range(7): self.repo.save()
        self.assertLessEqual(len(self.repo.recovery_points("manual")), 5)
        root = self.root / ".auvra" / "backups"
        self.assertLessEqual(sum(f.stat().st_size for f in root.rglob("*") if f.is_file()), 1)

    def test_recovery_points_older_than_thirty_days_are_pruned(self):
        self.repo.apply_changes({"metadata": [{"id": "m"}]}, expected_revision=0)
        self.repo.save()
        point = self.repo.recovery_points("manual")[0]["name"]
        root = self.root / ".auvra" / "backups" / point
        old = time.time() - repository_module.RECOVERY_MAX_AGE_SECONDS - 1
        for child in root.iterdir():
            os.utime(child, (old, old))
        os.utime(root, (old, old))
        self.repo.save()
        self.assertNotIn(point, {item["name"] for item in self.repo.recovery_points("manual")})
    def test_recovery_cap_combines_manual_and_autosave(self):
        self.repo.apply_changes({"metadata": [{"id":"m", "description":"0123456789"}]}, expected_revision=0)
        with mock.patch.object(repository_module, "PROJECT_CAP", 1000):
            for _ in range(4): self.repo.save()
            for _ in range(4): self.repo.autosave()
        roots = [self.root / ".auvra" / "backups", self.root / ".auvra" / "autosaves"]
        total = sum(f.stat().st_size for r in roots for f in r.rglob("*") if f.is_file())
        self.assertLessEqual(total, 1000); self.assertLessEqual(len(list(roots[0].iterdir())), 5); self.assertLessEqual(len(list(roots[1].iterdir())), 10)
    def test_recovery_selection_restores_atomically(self):
        self.repo.apply_changes({"metadata": [{"id":"first", "name":"First"}]}, expected_revision=0); self.repo.save()
        point = self.repo.recovery_points("manual")[0]["name"]
        self.repo.apply_changes({"metadata": [{"id":"second", "name":"Second"}]}, expected_revision=1)
        self.repo.restore_recovery("manual", point)
        self.assertEqual(self.repo.get_domain("metadata")["documents"][0]["id"], "first")

    def test_recovery_requires_complete_domains_and_restores_assets(self):
        reference = self.repo.assets.put_stream(io.BytesIO(b"recovery-asset"), name="asset.bin")
        self.repo.apply_changes({"metadata": [{"id": "snapshot", "name": "Snapshot"}]}, expected_revision=0)
        self.repo.save()
        point = self.repo.recovery_points("manual")[0]["name"]
        reference_path = self.repo.assets.path_for(reference.asset_id)
        reference_path.unlink()
        self.assertFalse(self.repo.assets.verify(reference.asset_id))
        self.repo.restore_recovery("manual", point)
        self.assertTrue(self.repo.assets.verify(reference.asset_id))
        self.assertEqual(self.repo.get_domain("metadata")["documents"][0]["id"], "snapshot")

        incomplete = self.root / ".auvra" / "backups" / "incomplete"
        incomplete.mkdir()
        (incomplete / "metadata.json").write_text("{}", encoding="utf-8")
        self.assertNotIn("incomplete", {item["name"] for item in self.repo.recovery_points("manual")})
        with self.assertRaises(InvalidProjectError):
            self.repo.restore_recovery("manual", "incomplete")
        import shutil
        shutil.rmtree(incomplete)

    def test_malicious_journal_path_fails_closed(self):
        journal = self.root / ".auvra" / "transactions" / "malicious.json"
        journal.write_text(json.dumps({"state":"prepared","newRevision":1,"files":[{"target":"../../escape.json","backup":"staging/x/old","staged":"staging/x/new"}]}), encoding="utf-8")
        self.repo.close()
        with self.assertRaises(RecoveryRequiredError): ProjectRepository(self.root)
    def test_subprocess_lock_falls_back_readonly(self):
        code = "from Auvra.project import ProjectRepository; import sys; r=ProjectRepository(sys.argv[1]); print(r.status.read_only, flush=True); input(); r.close()"
        child = subprocess.Popen([sys.executable, "-u", "-c", code, str(self.root)], cwd=Path(__file__).parents[2], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "True")
        finally:
            child.stdin.write("x\n"); child.stdin.flush(); child.wait(timeout=10); child.stdin.close(); child.stdout.close()
    def test_pack_and_failed_import_isolated(self):
        self.repo.apply_changes({"metadata": [{"id":"m", "name":"x"}]}, expected_revision=0)
        archive = Path(self.tmp.name) / "x.auvrapack"; self.repo.export_pack(archive)
        imported = ProjectRepository.import_pack(archive, Path(self.tmp.name) / "imported")
        try: self.assertEqual(imported.get_domain("metadata")["documents"][0]["id"], "m")
        finally: imported.close()
        bad = Path(self.tmp.name) / "bad.auvrapack"
        with zipfile.ZipFile(bad, "w") as z: z.writestr("../escape", "bad")
        with self.assertRaises(ArchiveValidationError): ProjectRepository.import_pack(bad, Path(self.tmp.name) / "bad-import")
        self.assertFalse((Path(self.tmp.name) / "bad-import").exists())

    def test_pack_validation_and_extraction_share_one_open_archive(self):
        self.repo.apply_changes({"metadata": [{"id": "same-handle", "name": "x"}]}, expected_revision=0)
        archive = Path(self.tmp.name) / "same-handle.auvrapack"
        self.repo.export_pack(archive)
        original_validator = repository_module.validate_archive
        observed: list[zipfile.ZipFile] = []

        def observe(source, **kwargs):
            self.assertIsInstance(source, zipfile.ZipFile)
            observed.append(source)
            return original_validator(source, **kwargs)

        with mock.patch.object(repository_module, "validate_archive", side_effect=observe):
            imported = ProjectRepository.import_pack(archive, Path(self.tmp.name) / "same-handle-import")
        try:
            self.assertEqual(len(observed), 1)
            self.assertEqual(imported.get_domain("metadata")["documents"][0]["id"], "same-handle")
        finally:
            imported.close()

    def test_failed_service_import_keeps_active_project(self):
        service = ProjectService(index=ProjectIndex(Path(self.tmp.name) / "index.sqlite"))
        try:
            original = service.create(self.root / "service", "service")
            bad = Path(self.tmp.name) / "bad2.auvrapack"
            with zipfile.ZipFile(bad, "w") as z: z.writestr("../escape", "bad")
            with self.assertRaises(ArchiveValidationError): service.import_pack(bad, Path(self.tmp.name) / "bad-destination")
            self.assertEqual(service.get_status().project_id, original.project_id)
        finally: service.shutdown()
    def test_legacy_migration_publishes_native_project_and_path_free_report(self):
        source = Path(self.tmp.name) / "legacy.forge"
        model_bytes = b"model-bytes"
        with zipfile.ZipFile(source, "w") as z:
            z.writestr("manifest.json", '{"version":7}')
            z.writestr("scene.json", '{"id":"scene"}')
            z.writestr("models.json", '[{"id":"model","name":"Model","assetFilename":"assets/model.bin"}]')
            z.writestr("assets/model.bin", model_bytes)
        service = ProjectService(index=ProjectIndex(Path(self.tmp.name) / "migration-index.sqlite"))
        before = source.read_bytes()
        try:
            status, report = service.migrate_legacy(source, Path(self.tmp.name) / "migrated", name="Migrated")
            self.assertEqual(status.name, "Migrated"); self.assertFalse(hasattr(report, "source")); self.assertEqual(source.read_bytes(), before)
            model = service._require().get_domain("models")["documents"][0]
            self.assertEqual(len(model["assetId"]), 64); self.assertTrue(service._require().assets.verify(model["assetId"]))
        finally: service.shutdown()
    def test_asset_mime_and_archive_hash_validation(self):
        with self.assertRaises(ValueError): self.repo.assets.put_stream(io.BytesIO(b"not-png"), mime="image/png")
        self.repo.assets.put_stream(io.BytesIO(b"\x89PNG\r\n\x1a\nvalid"), mime="image/png")
        archive = Path(self.tmp.name) / "hash.auvrapack"; self.repo.export_pack(archive)
        tampered = Path(self.tmp.name) / "tampered.auvrapack"
        with zipfile.ZipFile(archive) as src, zipfile.ZipFile(tampered, "w") as dst:
            for info in src.infolist():
                data = src.read(info); dst.writestr(info, b"tampered" if info.filename.startswith("Content/sha256/") and info.filename != "Content/sha256/manifest.json" else data)
        with self.assertRaises(InvalidProjectError): ProjectRepository.import_pack(tampered, Path(self.tmp.name) / "tampered-import")

    def test_pack_rejects_spoofed_mime_and_incomplete_manifest(self):
        ref = self.repo.assets.put_stream(io.BytesIO(b"plain bytes"), mime="application/octet-stream")
        archive = Path(self.tmp.name) / "manifest.auvrapack"; self.repo.export_pack(archive)
        for mode in ("mime", "missing"):
            candidate = Path(self.tmp.name) / f"manifest-{mode}.auvrapack"
            with zipfile.ZipFile(archive) as source, zipfile.ZipFile(candidate, "w") as target:
                for info in source.infolist():
                    data = source.read(info)
                    if info.filename == "Content/manifest.json":
                        manifest = json.loads(data)
                        if mode == "mime": manifest[ref.asset_id]["mime"] = "image/png"
                        else: manifest.pop(ref.asset_id)
                        data = json.dumps(manifest).encode("utf-8")
                    target.writestr(info, data)
            with self.assertRaises(InvalidProjectError):
                ProjectRepository.import_pack(candidate, Path(self.tmp.name) / f"manifest-{mode}-import")
    def test_archive_case_collision_and_nested_content_rejected(self):
        case = Path(self.tmp.name) / "case.zip"
        with zipfile.ZipFile(case, "w") as z: z.writestr("Foo", "1"); z.writestr("foo", "2")
        with self.assertRaises(ArchiveValidationError): ProjectRepository.import_pack(case, Path(self.tmp.name) / "case-import")
        nested = Path(self.tmp.name) / "nested.zip"
        with zipfile.ZipFile(nested, "w") as z: z.writestr("Project/", b""); z.writestr("Content/", b""); z.writestr("Content/sha256/", b""); z.writestr("bad.auvra", "{}")
        with self.assertRaises(InvalidProjectError): ProjectRepository.import_pack(nested, Path(self.tmp.name) / "nested-import")

    def test_archive_rejects_portable_name_collisions_and_windows_devices(self):
        candidates = {
            "trailing": ["Project/value.json", "Project/value.json."],
            "device": ["Content/sha256/CON"],
            "unicode": ["Project/caf\u00e9.json", "Project/cafe\u0301.json"],
            "alternate-stream": ["Project/value:stream.json"],
        }
        for label, names in candidates.items():
            archive = Path(self.tmp.name) / f"unsafe-{label}.zip"
            with zipfile.ZipFile(archive, "w") as output:
                for name in names: output.writestr(name, "x")
            with self.assertRaises(ArchiveValidationError, msg=label):
                ProjectRepository.import_pack(archive, Path(self.tmp.name) / f"unsafe-{label}-import")
    def test_bounded_asset_reader_and_index_rebuild(self):
        class Oversized:
            def read(self, size): return b"x" * (size + 1)
        with self.assertRaises(ValueError): self.repo.assets.put_stream(Oversized(), chunk_size=8)
        index_path = Path(self.tmp.name) / "corrupt.sqlite"; index_path.write_bytes(b"not sqlite")
        index = ProjectIndex(index_path); self.assertEqual(index.recent(), []); index.close()

    def test_webp_asset_content_must_match_declared_media_type(self):
        webp = b"RIFF" + (4).to_bytes(4, "little") + b"WEBP"
        reference = self.repo.assets.put_stream(io.BytesIO(webp), mime="image/webp")
        self.assertEqual(reference.mime, "image/webp")
        with self.assertRaises(ValueError):
            self.repo.assets.put_stream(io.BytesIO(b"not-webp"), mime="image/webp")

    def test_concurrent_asset_manifest_updates_do_not_lose_entries(self):
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=8) as pool:
            references = list(pool.map(
                lambda index: self.repo.assets.put_stream(io.BytesIO(f"asset-{index}".encode()), name=f"{index}.bin"),
                range(32),
            ))
        manifest = json.loads((self.root / "Content" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(set(manifest), {reference.asset_id for reference in references})
    @unittest.skipUnless(os.name == "nt", "Windows long-path acceptance only")
    def test_supported_windows_long_path(self):
        path = Path(self.tmp.name) / ("x" * 220)
        try: repo = ProjectRepository.create(path, "long"); repo.close()
        except OSError as exc: self.skipTest(f"long paths unavailable: {exc}")

    @unittest.skipUnless(os.name != "nt", "POSIX permission semantics only")
    def test_permission_failure_is_actionable(self):
        target = self.root / "Project"; target.chmod(0o500)
        try:
            with self.assertRaises(OSError): self.repo.apply_changes({"metadata": [{"id":"denied"}]}, expected_revision=0)
        finally: target.chmod(0o700)

class SchemaTests(unittest.TestCase):
    def test_all_domains_have_valid_schema_and_unknown_fields_fail(self):
        for domain in DOMAIN_NAMES:
            fixture = {"schemaVersion": 1, "documents": [{"id": "one"}]}
            if domain == "levels": fixture["documents"][0]["name"] = "Level"
            if domain in ("models", "animations", "attachments", "sockets", "textures", "audio", "materials"):
                fixture["documents"][0]["name"] = "Asset"
            if domain in ("models", "animations", "attachments", "textures", "audio"):
                fixture["documents"][0]["assetId"] = "a" * 64
            if domain == "animations": fixture["documents"][0]["modelId"] = "model"
            if domain in ("attachments", "sockets"): fixture["documents"][0]["parentModelId"] = "model"
            if domain == "objects": fixture["documents"][0].update(levelId="level", name="Object", type="prop")
            if domain == "blueprints": fixture["documents"][0].update(name="B", type="Enemy Controller")
            validate_domain(domain, fixture)
            fixture["documents"][0]["unexpected"] = True
            with self.assertRaises(ValueError): validate_domain(domain, fixture)
    def test_nested_unknown_nonfinite_and_incompatible_versions_fail_closed(self):
        with self.assertRaises(ValueError):
            validate_domain("textures", {"schemaVersion": 1, "documents": [{
                "id": "texture", "name": "Texture", "assetId": "a" * 64,
                "dimensions": {"width": 1, "height": 1, "depth": 1},
            }]})
        with self.assertRaises(ValueError):
            validate_domain("objects", {"schemaVersion": 1, "documents": [{
                "id": "object", "levelId": "level", "name": "Object", "type": "prop",
                "spawnConfig": {"blueprintId": "", "interval": 1, "maxSpawns": 0, "team": "Enemy", "unknown": True},
            }]})
        with self.assertRaises(ValueError):
            validate_domain("metadata", {"schemaVersion": 1, "documents": [{"id": "meta", "settings": {"scale": float("nan")}}]})
        with self.assertRaises(ValueError):
            validate_domain("metadata", {"schemaVersion": 2, "documents": [{"id": "meta"}]})

    def test_generated_texture_provenance_is_bounded_and_secret_free(self):
        asset = "a" * 64
        provenance = {
            "providerId": "fal",
            "modelId": "fal-ai/flux/dev",
            "jobId": "job-0123456789abcdef",
            "createdAt": 1,
            "routeOrigin": "cloud",
            "routeConsent": "explicit",
            "promptSha256": "b" * 64,
            "settingsSha256": "c" * 64,
            "artifactSha256": asset,
            "inputAssetIds": [],
        }
        document = {"schemaVersion": 1, "documents": [{
            "id": "texture", "name": "Generated", "assetId": asset,
            "dimensions": {"width": 1024, "height": 1024},
            "generation": provenance,
        }]}
        validate_domain("textures", document)
        with self.assertRaises(ValueError):
            validate_domain("textures", {"schemaVersion": 1, "documents": [{
                **document["documents"][0],
                "generation": {**provenance, "prompt": "must not persist"},
            }]})
        with self.assertRaises(ValueError):
            mismatched = {
                **document["documents"][0],
                "generation": {**provenance, "artifactSha256": "d" * 64},
            }
            domains = {
                domain: domain_document(domain, [mismatched] if domain == "textures" else [])
                for domain in DOMAIN_NAMES
            }
            validate_project_references(domains, asset_exists=lambda identity: identity == asset)

    def test_hud_documents_and_generated_command_provenance_are_strict(self):
        value = {
            "id": "hud-main", "name": "Main HUD",
            "elements": [{
                "id": "health", "name": "Health", "type": "HealthBar",
                "props": {"value": 85, "barColor": "#dc2626"},
                "position": {"x": 10, "y": 20},
                "size": {"width": 250, "height": 60},
                "zIndex": 1, "isVisible": True, "isLocked": False,
            }],
            "layout": {"width": 1920, "height": 1080},
            "commands": [{
                "id": "command-1", "jobId": "job-0123456789abcdef",
                "providerId": "ollama", "modelId": "local-model",
                "promptSha256": "a" * 64, "operationsSha256": "b" * 64,
                "appliedAt": 1,
            }],
        }
        validate_domain("hud", {"schemaVersion": 1, "documents": [value]})
        with self.assertRaises(ValueError):
            validate_domain("hud", {"schemaVersion": 1, "documents": [{
                **value,
                "commands": [{**value["commands"][0], "rawPrompt": "not allowed"}],
            }]})
    def test_substantive_round_trip_fixture_for_every_domain(self):
        asset = "a" * 64
        fixtures = {
            "metadata":{"id":"m","name":"Project","description":"D","settings":{"grid":True}},
            "worlds":{"id":"w","name":"World","levels":["l"]}, "scenes":{"id":"s","name":"Scene","levelId":"l","objects":[]},
            "levels":{"id":"l","name":"Level","createdAt":1}, "objects":{"id":"o","levelId":"l","modelId":"m","name":"Object","type":"prop","position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1]},
            "environment":{"id":"e","name":"Environment","settings":{"exposure":1}}, "models":{"id":"m","name":"Model","assetId":asset},
            "animations":{"id":"an","name":"Anim","assetId":asset,"modelId":"m"}, "attachments":{"id":"at","name":"Attachment","assetId":asset,"parentModelId":"m","position":[0,0,0]},
            "sockets":{"id":"so","name":"Socket","parentModelId":"m","position":[0,0,0]}, "textures":{"id":"t","name":"Texture","assetId":asset,"dimensions":{"width":1,"height":1}},
            "audio":{"id":"au","name":"Audio","assetId":asset,"type":"audio/wav","duration":1}, "materials":{"id":"mat","name":"Material","textureIds":["t"],"overrides":{}},
            "blueprints":{"id":"b","name":"Blueprint","type":"Enemy Controller","description":"D","linkedModelId":None,"stats":[],"traits":[],"variables":[],"animationGraph":{},"meshScale":1},
            "graphs":{"id":"g","modelId":"m","variables":[],"inputs":[],"states":[],"transitions":[],"activeStateId":None}, "hud":{"id":"h","name":"HUD","elements":[],"layout":{"width":1920,"height":1080},"commands":[]},
        }
        for domain, value in fixtures.items():
            document = {"schemaVersion":1,"documents":[value]}; validate_domain(domain, document); self.assertEqual(validate_domain(domain, json.loads(canonical_json(document))), document)

    def test_object_transform_defaults_and_legacy_quaternion_are_canonicalized(self):
        legacy = {"schemaVersion": 1, "documents": [{
            "id": "legacy", "levelId": "level", "name": "Legacy", "type": "prop",
            "position": [1, 2, 3], "rotation": [0, 0, 0, 2], "scale": [2, 3, 4],
        }, {
            "id": "defaults", "levelId": "level", "name": "Defaults", "type": "prop",
        }]}
        normalized = validate_domain("objects", legacy)
        self.assertEqual(legacy["documents"][0]["rotation"], [0, 0, 0, 2])
        self.assertEqual(normalized["documents"][0]["rotation"], [0.0, 0.0, 0.0])
        self.assertEqual(normalized["documents"][1]["position"], [0.0, 0.0, 0.0])
        self.assertEqual(normalized["documents"][1]["rotation"], [0.0, 0.0, 0.0])
        self.assertEqual(normalized["documents"][1]["scale"], [1.0, 1.0, 1.0])

    def test_object_transform_contract_rejects_invalid_shapes_values_and_bounds(self):
        base = {"id": "object", "levelId": "level", "name": "Object", "type": "prop",
                "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}
        cases = (
            ("position", [0, 0]), ("position", [0, 0, 0, 0]),
            ("position", [1_000_001, 0, 0]), ("position", [float("inf"), 0, 0]),
            ("rotation", [0, 0]), ("rotation", [0, 0, 0, 0]),
            ("rotation", [float("nan"), 0, 0]), ("rotation", [0, 0, 0, 0, 1]),
            ("scale", [0, 1, 1]), ("scale", [0.00009, 1, 1]),
            ("scale", [1_000_001, 1, 1]), ("scale", [1, True, 1]),
        )
        for field, replacement in cases:
            candidate = {"schemaVersion": 1, "documents": [{**base, field: replacement}]}
            with self.assertRaises(ValueError, msg=f"{field}={replacement!r}"):
                validate_domain("objects", candidate)

    def test_object_quaternion_conversion_matches_three_xyz_radians(self):
        # A 90-degree Z rotation has the same canonical Euler result in
        # Three.js XYZ order, independent of the quaternion's magnitude.
        candidate = {"schemaVersion": 1, "documents": [{
            "id": "object", "levelId": "level", "name": "Object", "type": "prop",
            "rotation": [0, 0, 2 ** -0.5, 2 ** -0.5],
        }]}
        result = validate_domain("objects", candidate)["documents"][0]
        self.assertAlmostEqual(result["rotation"][0], 0.0, places=7)
        self.assertAlmostEqual(result["rotation"][1], 0.0, places=7)
        self.assertAlmostEqual(result["rotation"][2], 1.5707963267948966, places=7)

    def test_three_value_rotation_is_never_guessed_to_be_degrees(self):
        authored = [90, -180, 360]
        candidate = {"schemaVersion": 1, "documents": [{
            "id": "object", "levelId": "level", "name": "Object", "type": "prop",
            "rotation": authored,
        }]}
        result = validate_domain("objects", candidate)["documents"][0]
        self.assertEqual(result["rotation"], authored)

class LegacyTests(unittest.TestCase):
    def test_legacy_source_is_not_modified(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "old.forge"
            with zipfile.ZipFile(source, "w") as z: z.writestr("manifest.json", '{"version":7}'); z.writestr("scene.json", '{"id":"s"}')
            before = source.read_bytes(); values, report = LegacyArchive(source).migrate()
            self.assertIn("scene", values); self.assertEqual(source.read_bytes(), before); self.assertEqual(report.assets, 0)

class ServiceTests(unittest.TestCase):
    def test_service_keeps_path_internal_and_enforces_identity(self):
        with tempfile.TemporaryDirectory() as root:
            service = ProjectService(); status = service.create(Path(root) / "Project", "Project")
            self.assertEqual(status.revision, 0)
            with self.assertRaises(ValueError): service.apply_changes({"metadata": [{"id": "m"}]}, project_id="wrong", expected_revision=0)
            status = service.apply_changes({"metadata": [{"id": "m"}]}, project_id=status.project_id, expected_revision=0)
            self.assertEqual(status.revision, 1); service.shutdown()

    def test_failed_create_open_and_save_as_preserve_active_project(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            service = ProjectService(index=ProjectIndex(root_path / "index.sqlite"))
            try:
                active = service.create(root_path / "active", "Active")
                occupied = root_path / "occupied"; occupied.mkdir(); (occupied / "file").write_text("x")
                with self.assertRaises(InvalidProjectError):
                    service.create(occupied, "Other")
                self.assertEqual(service.get_status().project_id, active.project_id)
                with self.assertRaises(InvalidProjectError):
                    service.open(root_path / "missing")
                self.assertEqual(service.get_status().project_id, active.project_id)
                with self.assertRaises(InvalidProjectError):
                    service.save_as(occupied, project_id=active.project_id, name="Other")
                self.assertEqual(service.get_status().project_id, active.project_id)
            finally:
                service.shutdown()

if __name__ == "__main__": unittest.main()
