"""Runs one Reframe render in a process of its own, under Reframe's own Python.

Standalone on purpose: it is run by an interpreter that has Reframe's packages and may have none of Auvra's. It reads the job
folder Auvra prepared, reports through status.json there, and stops when a file named cancel appears.
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from pathlib import Path

_FINAL_REPORT_ATTEMPTS = 100
_FINAL_REPORT_WAIT_SECONDS = 0.05


def main(home: str, job_dir: str) -> int:
    folder = Path(job_dir)
    status_file = folder / "status.json"

    def report(state: str, progress: float = 0.0, message: str = "") -> None:
        scratch = folder / "status.tmp"
        scratch.write_text(json.dumps({"state": state, "progress": progress, "message": message[:240]}), encoding="utf-8")
        # Windows refuses while the host is reading the file. Progress can wait for the next report, and must never stop a
        # render; how it ended cannot wait, so that is tried for longer.
        attempts = 1 if state == "running" else _FINAL_REPORT_ATTEMPTS
        for attempt in range(attempts):
            try:
                os.replace(scratch, status_file)
                return
            except OSError:
                if attempt + 1 < attempts:
                    time.sleep(_FINAL_REPORT_WAIT_SECONDS)

    def on_update(state: object = "rendering", progress: object = 0.0, _samples: object = 0, _elapsed: object = 0.0, message: object = "", *_rest: object) -> None:
        report("running", float(progress) if isinstance(progress, (int, float)) else 0.0, str(message))

    report("running", 0.0, "Starting")
    try:
        sys.path.insert(0, home)
        from gi_renderer.engine.render import render_job

        config = json.loads((folder / "config.json").read_text(encoding="utf-8"))
        outcome = render_job(str(folder), config, on_update, (folder / "cancel").exists)
    except Exception:
        (folder / "error.log").write_text(traceback.format_exc(), encoding="utf-8")
        last = traceback.format_exc().strip().splitlines()[-1]
        report("failed", 0.0, last)
        return 1
    if (folder / "cancel").exists() or outcome == "cancelled":
        report("cancelled", 0.0, "")
    elif (folder / "final.png").is_file():
        report("succeeded", 1.0, "")
    else:
        report("failed", 0.0, "The render finished without a picture.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
