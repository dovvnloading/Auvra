"""Native credential entry kept outside the WebView DOM and host protocol."""

from __future__ import annotations

import re
from typing import Any, Callable


_SAFE_LABEL = re.compile(r"^[A-Za-z0-9 ._+()/:-]{1,96}$")


class CredentialPromptUnavailableError(RuntimeError):
    """The supported native credential prompt cannot be created."""


class WinFormsCredentialPrompt:
    """Collect a provider secret in a native masked input.

    Only the provider label crosses into this adapter.  The returned value is
    handed directly to the host credential store and is never placed in a
    protocol response, browser message, log record, or persisted setting.
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
        form = forms.Form()
        heading = forms.Label()
        explanation = forms.Label()
        secret = forms.TextBox()
        accept = forms.Button()
        cancel = forms.Button()
        try:
            form.Text = f"Configure {label}"
            form.FormBorderStyle = forms.FormBorderStyle.FixedDialog
            form.StartPosition = forms.FormStartPosition.CenterScreen
            form.ClientSize = drawing.Size(440, 168)
            form.MinimizeBox = False
            form.MaximizeBox = False
            form.ShowInTaskbar = False

            heading.Text = f"{label} API credential"
            heading.AutoSize = True
            heading.Location = drawing.Point(18, 18)

            explanation.Text = (
                "The credential is stored by the Python host and is never sent "
                "to the editor page or written into an Auvra project."
            )
            explanation.AutoSize = False
            explanation.Size = drawing.Size(404, 38)
            explanation.Location = drawing.Point(18, 43)

            secret.Location = drawing.Point(18, 87)
            secret.Size = drawing.Size(404, 24)
            secret.UseSystemPasswordChar = True
            secret.MaxLength = 2560

            accept.Text = "Save"
            accept.DialogResult = forms.DialogResult.OK
            accept.Location = drawing.Point(266, 126)
            accept.Size = drawing.Size(75, 26)

            cancel.Text = "Cancel"
            cancel.DialogResult = forms.DialogResult.Cancel
            cancel.Location = drawing.Point(347, 126)
            cancel.Size = drawing.Size(75, 26)

            form.Controls.Add(heading)
            form.Controls.Add(explanation)
            form.Controls.Add(secret)
            form.Controls.Add(accept)
            form.Controls.Add(cancel)
            form.AcceptButton = accept
            form.CancelButton = cancel

            if form.ShowDialog() != forms.DialogResult.OK:
                return None
            value = str(secret.Text)
            if not value or len(value.encode("utf-16-le")) > 2560:
                raise ValueError("credential is empty or exceeds the vault limit")
            return value
        finally:
            # Python cannot promise complete process-memory zeroization, but do
            # not leave the managed text control populated after the dialog.
            try:
                secret.Text = ""
            finally:
                form.Dispose()
