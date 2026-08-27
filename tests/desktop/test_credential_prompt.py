from __future__ import annotations

from types import SimpleNamespace
import unittest

from Auvra.desktop.credential_prompt import WinFormsCredentialPrompt


class _Controls:
    def __init__(self) -> None:
        self.values = []

    def Add(self, value) -> None:
        self.values.append(value)


class _Control:
    def __init__(self) -> None:
        self.Text = ""


class _Form(_Control):
    result = "OK"

    def __init__(self) -> None:
        super().__init__()
        self.Controls = _Controls()
        self.disposed = False

    def ShowDialog(self):
        return self.result

    def Dispose(self) -> None:
        self.disposed = True


class _Secret(_Control):
    instances = []

    def __init__(self) -> None:
        super().__init__()
        self.Text = "secret-value"
        self.instances.append(self)


class CredentialPromptTests(unittest.TestCase):
    def setUp(self) -> None:
        _Secret.instances.clear()
        self.forms = SimpleNamespace(
            Form=_Form,
            Label=_Control,
            TextBox=_Secret,
            Button=_Control,
            DialogResult=SimpleNamespace(OK="OK", Cancel="Cancel"),
            FormBorderStyle=SimpleNamespace(FixedDialog="fixed"),
            FormStartPosition=SimpleNamespace(CenterScreen="center"),
        )
        self.drawing = SimpleNamespace(
            Size=lambda width, height: (width, height),
            Point=lambda x, y: (x, y),
        )

    def test_returns_value_then_clears_native_control(self) -> None:
        prompt = WinFormsCredentialPrompt(lambda: (self.forms, self.drawing))
        self.assertEqual(prompt.prompt("fal.ai"), "secret-value")
        self.assertEqual(_Secret.instances[0].Text, "")

    def test_cancel_and_untrusted_label_do_not_return_a_secret(self) -> None:
        _Form.result = "Cancel"
        try:
            prompt = WinFormsCredentialPrompt(lambda: (self.forms, self.drawing))
            self.assertIsNone(prompt.prompt("OpenAI"))
            with self.assertRaises(ValueError):
                prompt.prompt("provider\nsecret")
        finally:
            _Form.result = "OK"


if __name__ == "__main__":
    unittest.main()
