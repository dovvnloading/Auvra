
"""Auvra development launcher entry point.

This file intentionally remains a thin Visual Studio/Python entry point; the
implementation lives in :mod:`launcher` so it can be tested without starting
the editor.
"""

from launcher.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
