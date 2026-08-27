from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from Auvra.desktop.dialogs import WinFormsProjectDialogs


class _Dialog:
    def __init__(self, *, result: int, path: str) -> None:
        self._result = result
        self._selected = path
        self.SelectedPath = path
        self.FileName = path
        self.disposed = False

    def ShowDialog(self) -> int:
        self.FileName = self._selected
        return self._result

    def Dispose(self) -> None:
        self.disposed = True


class _Forms:
    class DialogResult:
        OK = 1

    def __init__(self, *, result: int, folder: str, file: str) -> None:
        self.result = result
        self.folder = folder
        self.file = file
        self.created: list[_Dialog] = []

    def FolderBrowserDialog(self) -> _Dialog:
        dialog = _Dialog(result=self.result, path=self.folder)
        self.created.append(dialog)
        return dialog

    def OpenFileDialog(self) -> _Dialog:
        dialog = _Dialog(result=self.result, path=self.file)
        self.created.append(dialog)
        return dialog

    def SaveFileDialog(self) -> _Dialog:
        dialog = _Dialog(result=self.result, path=self.file)
        self.created.append(dialog)
        return dialog


class ProjectDialogTests(unittest.TestCase):
    def test_create_and_save_as_keep_paths_inside_host(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            forms = _Forms(result=1, folder=temp, file=str(Path(temp) / "unused"))
            dialogs = WinFormsProjectDialogs(lambda: forms)
            created = dialogs.choose_create_location("Demo")
            copied = dialogs.choose_save_as_location("Demo Copy")
            self.assertEqual(created.path, Path(temp).absolute() / "Demo")
            self.assertEqual(copied.path, Path(temp).absolute() / "Demo Copy")
            self.assertTrue(all(dialog.disposed for dialog in forms.created))

    def test_unsafe_suggestion_is_not_used_as_a_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            forms = _Forms(result=1, folder=temp, file=str(Path(temp) / "out.auvrapack"))
            dialogs = WinFormsProjectDialogs(lambda: forms)
            selected = dialogs.choose_create_location("../escape")
            self.assertEqual(selected.path, Path(temp).absolute() / "AuvraProject")

    def test_cancel_returns_none_and_disposes_dialog(self) -> None:
        forms = _Forms(result=0, folder="", file="")
        dialogs = WinFormsProjectDialogs(lambda: forms)
        self.assertIsNone(dialogs.choose_open_project())
        self.assertTrue(forms.created[0].disposed)

    def test_open_import_and_export_use_native_file_selections(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = str(Path(temp) / "project.auvra")
            forms = _Forms(result=1, folder=temp, file=path)
            dialogs = WinFormsProjectDialogs(lambda: forms)
            self.assertEqual(dialogs.choose_open_project().path, Path(path).absolute())
            self.assertEqual(dialogs.choose_import_pack().path, Path(path).absolute())
            self.assertEqual(dialogs.choose_import_legacy().path, Path(path).absolute())
            self.assertEqual(dialogs.choose_export_pack("Demo").path, Path(path).absolute())


if __name__ == "__main__":
    unittest.main()
