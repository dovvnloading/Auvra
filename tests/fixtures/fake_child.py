"""Small child process used by launcher lifecycle tests.

It intentionally uses only the standard library and writes its PID to a file so
tests can prove that process ownership is precise.  The process stays alive
until it receives SIGINT/SIGTERM (or is killed by its process group/job).
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def _write_pid(path: str | None) -> None:
    if path:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(str(os.getpid()), encoding="utf-8")


def _stop(_signum: int, _frame: object) -> None:
    raise SystemExit(0)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid-file")
    parser.add_argument("--spawn-pid-file")
    parser.add_argument("--child-script")
    args = parser.parse_args()
    signal.signal(signal.SIGINT, _stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _stop)
    _write_pid(args.pid_file)
    descendant: subprocess.Popen[str] | None = None
    if args.spawn_pid_file:
        script = args.child_script or __file__
        descendant = subprocess.Popen(
            [sys.executable, script, "--pid-file", args.spawn_pid_file],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
        )
    try:
        while True:
            time.sleep(0.1)
    finally:
        if descendant is not None and descendant.poll() is None:
            descendant.terminate()
            descendant.wait(timeout=2)


if __name__ == "__main__":
    raise SystemExit(main())
