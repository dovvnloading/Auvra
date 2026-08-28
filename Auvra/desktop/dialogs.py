"""Native project dialogs kept entirely behind the Python host boundary."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
from typing import Any, Callable

from Auvra.diagnostics.core import trace_public_class


_SAFE_NAME = re.compile(r"^[^<>:\"/\\|?*\x00-\x1f]{1,96}$")


class DialogUnavailableError(RuntimeError):
    """The supported operating-system dialog service is unavailable."""


@dataclass(frozen=True, slots=True)
class DialogSelection:
    """Private host result. Paths from this type never cross JSON."""

    path: Path


def _validated_name(value: str, fallback: str = "AuvraProject") -> str:
    candidate = str(value).strip().rstrip(". ")
    if not _SAFE_NAME.fullmatch(candidate) or candidate in {".", ".."}:
        return fallback
    return candidate


@trace_public_class("project_dialogs", concise=(
    "choose_create_location", "choose_open_project", "choose_save_as_location",
    "choose_export_pack", "choose_import_pack", "choose_import_legacy",
))
class WinFormsProjectDialogs:
    """Use the already-approved Windows/.NET dialog surface lazily."""

    def __init__(self, backend_loader: Callable[[], Any] | None = None) -> None:
        self._backend_loader = backend_loader or self._load_backend

    @staticmethod
    def _load_backend() -> Any:
        try:
            import System.Windows.Forms as forms  # type: ignore[import-not-found]

            return forms
        except Exception as exc:
            raise DialogUnavailableError("native project dialogs are unavailable") from exc

    @staticmethod
    def _accepted(forms: Any, dialog: Any) -> bool:
        return dialog.ShowDialog() == forms.DialogResult.OK

    @staticmethod
    def _selection(value: Any) -> DialogSelection | None:
        if not isinstance(value, str) or not value.strip():
            return None
        return DialogSelection(Path(value).expanduser().absolute())

    def choose_create_location(self, suggested_name: str) -> DialogSelection | None:
        forms = self._backend_loader()
        dialog = forms.FolderBrowserDialog()
        try:
            dialog.Description = "Choose where to create the Auvra project"
            dialog.ShowNewFolderButton = True
            if not self._accepted(forms, dialog):
                return None
            selected = self._selection(dialog.SelectedPath)
            if selected is None:
                return None
            return DialogSelection(selected.path / _validated_name(suggested_name))
        finally:
            dialog.Dispose()
    def choose_open_project(self) -> DialogSelection | None:
        return self._open_file(
            "Open Auvra Project",
            "Auvra projects (*.auvra)|*.auvra",
        )

    def choose_save_as_location(self, suggested_name: str) -> DialogSelection | None:
        forms = self._backend_loader()
        dialog = forms.FolderBrowserDialog()
        try:
            dialog.Description = "Choose where to save a copy of the Auvra project"
            dialog.ShowNewFolderButton = True
            if not self._accepted(forms, dialog):
                return None
            selected = self._selection(dialog.SelectedPath)
            if selected is None:
                return None
            return DialogSelection(selected.path / _validated_name(suggested_name))
        finally:
            dialog.Dispose()

    def choose_export_pack(self, suggested_name: str) -> DialogSelection | None:
        forms = self._backend_loader()
        dialog = forms.SaveFileDialog()
        try:
            dialog.Title = "Export Auvra Project Pack"
            dialog.Filter = "Auvra project packs (*.auvrapack)|*.auvrapack"
            dialog.DefaultExt = "auvrapack"
            dialog.AddExtension = True
            dialog.OverwritePrompt = True
            dialog.FileName = _validated_name(suggested_name) + ".auvrapack"
            if not self._accepted(forms, dialog):
                return None
            return self._selection(dialog.FileName)
        finally:
            dialog.Dispose()

    def choose_import_pack(self) -> DialogSelection | None:
        return self._open_file(
            "Import Auvra Project Pack",
            "Auvra project packs (*.auvrapack)|*.auvrapack",
        )

    def choose_import_legacy(self) -> DialogSelection | None:
        return self._open_file(
            "Import Legacy Auvra Project",
            "Legacy Auvra projects (*.forge)|*.forge|Auvra project packs (*.auvrapack)|*.auvrapack",
        )

    def _open_file(self, title: str, filter_value: str) -> DialogSelection | None:
        forms = self._backend_loader()
        dialog = forms.OpenFileDialog()
        try:
            dialog.Title = title
            dialog.Filter = filter_value
            dialog.CheckFileExists = True
            dialog.CheckPathExists = True
            dialog.Multiselect = False
            if not self._accepted(forms, dialog):
                return None
            return self._selection(dialog.FileName)
        finally:
            dialog.Dispose()
