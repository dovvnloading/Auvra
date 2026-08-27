
"""Auvra development launcher entry point.

This file intentionally remains a thin Visual Studio/Python entry point; the
implementation lives in :mod:`launcher` so it can be tested without starting
the editor.
"""

from pathlib import Path
import sys

# Direct execution puts ``Auvra/`` first on sys.path, where ``Auvra.py`` would
# shadow the ``Auvra`` namespace package. Establish the repository package root
# so launcher, desktop, and host modules always have one import identity.
_REPO_ROOT = str(Path(__file__).resolve().parent.parent)
try:
    sys.path.remove(_REPO_ROOT)
except ValueError:
    pass
sys.path.insert(0, _REPO_ROOT)

from Auvra.launcher.bootstrap import BOOTSTRAP_EXIT_CODE, BootstrapError, bootstrap


def _configure_console_output() -> None:
    """Prevent child output from crashing the launcher on legacy code pages."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(errors="backslashreplace")
            except (OSError, ValueError):
                pass


def main() -> int:
    _configure_console_output()
    try:
        bootstrap()
    except KeyboardInterrupt:
        print("Auvra bootstrap interrupted.", file=sys.stderr)
        return 130
    except (BootstrapError, OSError) as exc:
        print(f"Auvra bootstrap failed: {exc}", file=sys.stderr)
        return BOOTSTRAP_EXIT_CODE
    # Import third-party-dependent launcher modules only after the managed
    # interpreter has been established (or when its loop marker is active).
    from Auvra.launcher.cli import main as cli_main
    return cli_main()


if __name__ == "__main__":
    raise SystemExit(main())
