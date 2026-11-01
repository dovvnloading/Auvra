"""Native credential entry kept outside the WebView DOM and host protocol."""

from __future__ import annotations

import re
from typing import Any, Callable

from Auvra.diagnostics.core import trace_public_class


_SAFE_LABEL = re.compile(r"^[A-Za-z0-9 ._+()/:-]{1,96}$")
_VAULT_LIMIT_BYTES = 2560
_GROUND = (30, 31, 34)
_WELL = (22, 23, 25)
_RAISED = (38, 39, 43)
_INK = (226, 227, 229)
_INK_2 = (173, 176, 182)
_ACCENT = (240, 138, 60)
_ACCENT_INK = (28, 17, 8)


class CredentialPromptUnavailableError(RuntimeError):
    """The supported native credential prompt cannot be created."""


@trace_public_class("credential_prompt", concise=("prompt",))
class WinFormsCredentialPrompt:
    """Collect a provider secret in a native masked input.

    Only the provider label crosses into this adapter.  The returned value is
    handed directly to the host credential store and is never placed in a
    protocol response, browser message, log record, or persisted setting.

    Call it on the frame's UI thread: the window belongs to the editor's, and
    opens over it rather than somewhere behind it.
    """

    def __init__(self, backend_loader: Callable[[], Any] | None = None) -> None:
        self._backend_loader = backend_loader or self._load_backend

    @staticmethod
    def _load_backend() -> Any:
        try:
            import System.Drawing as drawing  # type: ignore[import-not-found]
            import System.Windows.Forms as forms  # type: ignore[import-not-found]

            return forms, drawing
        except Exception as exc:
            raise CredentialPromptUnavailableError(
                "native credential entry is unavailable"
            ) from exc

    def prompt(self, provider_label: str) -> str | None:
        label = str(provider_label).strip()
        if not _SAFE_LABEL.fullmatch(label):
            raise ValueError("provider label is invalid")

        forms, drawing = self._backend_loader()
        color = lambda rgb: drawing.Color.FromArgb(*rgb)  # noqa: E731
        owner = next(iter(forms.Application.OpenForms), None)
        form = forms.Form()
        heading = forms.Label()
        explanation = forms.Label()
        secret = forms.TextBox()
        accept = forms.Button()
        cancel = forms.Button()
        try:
            form.Text = f"Add a key for {label}"
            form.FormBorderStyle = forms.FormBorderStyle.FixedDialog
            form.StartPosition = (forms.FormStartPosition.CenterParent if owner is not None
                                  else forms.FormStartPosition.CenterScreen)
            form.ClientSize = drawing.Size(440, 148)
            form.MinimizeBox = False
            form.MaximizeBox = False
            form.ShowInTaskbar = owner is None
            form.TopMost = owner is None
            form.BackColor = color(_GROUND)
            form.ForeColor = color(_INK)
            form.Font = drawing.Font("Segoe UI", 9.0)

            heading.Text = f"Paste your {label} key"
            heading.AutoSize = True
            heading.Location = drawing.Point(18, 16)
            heading.Font = drawing.Font("Segoe UI Semibold", 10.0)

            explanation.Text = "It stays on this computer, and is never written into a project."
            explanation.AutoSize = True
            explanation.Location = drawing.Point(18, 41)
            explanation.ForeColor = color(_INK_2)

            secret.Location = drawing.Point(18, 67)
            secret.Size = drawing.Size(404, 24)
            secret.UseSystemPasswordChar = True
            secret.MaxLength = _VAULT_LIMIT_BYTES
            secret.BorderStyle = forms.BorderStyle.FixedSingle
            secret.BackColor = color(_WELL)
            secret.ForeColor = color(_INK)

            def style_button(button: Any, text: str, x: int, fill: Any, ink: Any) -> None:
                button.Text = text
                button.Location = drawing.Point(x, 106)
                button.Size = drawing.Size(75, 26)
                button.FlatStyle = forms.FlatStyle.Flat
                button.FlatAppearance.BorderSize = 0
                button.BackColor = fill
                button.ForeColor = ink

            style_button(accept, "Save", 266, color(_RAISED), color(_INK_2))
            style_button(cancel, "Cancel", 347, color(_RAISED), color(_INK))
            accept.DialogResult = forms.DialogResult.OK
            cancel.DialogResult = forms.DialogResult.Cancel
            accept.Enabled = False

            def on_text_changed(_sender: Any, _args: Any) -> None:
                ready = bool(str(secret.Text).strip())
                accept.Enabled = ready
                accept.BackColor = color(_ACCENT if ready else _RAISED)
                accept.ForeColor = color(_ACCENT_INK if ready else _INK_2)

            secret.TextChanged += on_text_changed

            form.Controls.Add(heading)
            form.Controls.Add(explanation)
            form.Controls.Add(secret)
            form.Controls.Add(accept)
            form.Controls.Add(cancel)
            form.AcceptButton = accept
            form.CancelButton = cancel
            form.ActiveControl = secret

            answer = form.ShowDialog(owner) if owner is not None else form.ShowDialog()
            if answer != forms.DialogResult.OK:
                return None
            # What was copied often brings a space or line ending along with it.
            value = str(secret.Text).strip()
            if not value:
                return None
            if len(value.encode("utf-16-le")) > _VAULT_LIMIT_BYTES:
                raise ValueError("credential exceeds the vault limit")
            return value
        finally:
            # Python cannot promise complete process-memory zeroization, but do
            # not leave the managed text control populated after the dialog.
            try:
                secret.Text = ""
            finally:
                form.Dispose()
