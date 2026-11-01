from __future__ import annotations

from types import SimpleNamespace
import unittest
from unittest import mock

from Auvra.desktop.credential_prompt import WinFormsCredentialPrompt


class _Controls:
    def __init__(self) -> None:
        self.values = []

    def Add(self, value) -> None:
        self.values.append(value)


class _Control:
    def __init__(self) -> None:
        self.Text = ""

    def __getattr__(self, name: str):
        # Styling and events: the fake takes whatever a real control would.
        value = mock.MagicMock()
        setattr(self, name, value)
        return value


class _Form(_Control):
    result = "OK"
    shown_over: list = []

    def __init__(self) -> None:
        super().__init__()
        self.Controls = _Controls()
        self.disposed = False

    def ShowDialog(self, owner=None):
        self.shown_over.append(owner)
        return self.result

    def Dispose(self) -> None:
        self.disposed = True


class _Secret(_Control):
    instances = []
    entered = "secret-value"

    def __init__(self) -> None:
        super().__init__()
        self.Text = self.entered
        self.instances.append(self)


class CredentialPromptTests(unittest.TestCase):
    def setUp(self) -> None:
        _Secret.instances.clear()
        _Secret.entered = "secret-value"
        _Form.shown_over = []
        self.forms = SimpleNamespace(
            Form=_Form,
            Label=_Control,
            TextBox=_Secret,
            Button=_Control,
            Application=SimpleNamespace(OpenForms=[]),
            DialogResult=SimpleNamespace(OK="OK", Cancel="Cancel"),
            FormBorderStyle=SimpleNamespace(FixedDialog="fixed"),
            FormStartPosition=SimpleNamespace(CenterScreen="center", CenterParent="parent"),
            BorderStyle=SimpleNamespace(FixedSingle="single"),
            FlatStyle=SimpleNamespace(Flat="flat"),
        )
        self.drawing = SimpleNamespace(
            Size=lambda width, height: (width, height),
            Point=lambda x, y: (x, y),
            Font=lambda *args: args,
            Color=SimpleNamespace(FromArgb=lambda *args: args),
        )
        self.prompt = WinFormsCredentialPrompt(lambda: (self.forms, self.drawing))

    def test_returns_value_then_clears_native_control(self) -> None:
        self.assertEqual(self.prompt.prompt("fal.ai"), "secret-value")
        self.assertEqual(_Secret.instances[0].Text, "")

    def test_cancel_and_untrusted_label_do_not_return_a_secret(self) -> None:
        _Form.result = "Cancel"
        try:
            self.assertIsNone(self.prompt.prompt("OpenAI"))
            with self.assertRaises(ValueError):
                self.prompt.prompt("provider\nsecret")
        finally:
            _Form.result = "OK"

    def test_opens_over_the_editor_window(self) -> None:
        editor = object()
        self.forms.Application.OpenForms = [editor]
        self.prompt.prompt("fal.ai")
        self.assertEqual(_Form.shown_over, [editor])

    def test_with_no_editor_window_it_still_cannot_end_up_behind_something(self) -> None:
        made = []
        original = self.forms.Form
        self.forms.Form = lambda: made.append(original()) or made[-1]
        self.prompt.prompt("fal.ai")
        self.assertIs(made[0].TopMost, True)
        self.assertIs(made[0].ShowInTaskbar, True)

    def test_what_comes_along_with_a_copied_key_is_left_out(self) -> None:
        _Secret.entered = "  secret-value \t"
        self.assertEqual(self.prompt.prompt("fal.ai"), "secret-value")

    def test_nothing_but_spaces_is_no_key(self) -> None:
        _Secret.entered = "   "
        self.assertIsNone(self.prompt.prompt("fal.ai"))


if __name__ == "__main__":
    unittest.main()
