"""Rebuildable user-local project index; never project authority."""
from __future__ import annotations
import os, sqlite3, time
from pathlib import Path
import threading
from Auvra.diagnostics.core import trace_public_class

@trace_public_class("project_index", concise=("record", "rebuild", "close"))
class ProjectIndex:
    def __init__(self, path: str | os.PathLike[str] | None = None) -> None:
        # Native WebView callbacks may invoke project operations on a thread
        # different from the launcher thread.  SQLite's default thread guard
        # would reject that legitimate host-boundary use; serialize access at
        # this rebuildable, noncanonical index instead.
        self._lock = threading.RLock()
        if path is None:
            path = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Auvra" / "projects.sqlite3"
        self.path = Path(path); self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.db = sqlite3.connect(self.path, check_same_thread=False)
            self.db.execute("CREATE TABLE IF NOT EXISTS projects (project_id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, opened_at REAL NOT NULL)")
            self.db.execute("SELECT 1 FROM projects LIMIT 1")
        except sqlite3.DatabaseError:
            try: self.db.close()
            except Exception: pass
            corrupt = self.path.with_name(self.path.name + f".corrupt-{int(time.time())}")
            if self.path.exists(): os.replace(self.path, corrupt)
            self.db = sqlite3.connect(self.path, check_same_thread=False)
            self.db.execute("CREATE TABLE projects (project_id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, opened_at REAL NOT NULL)")
        with self._lock:
            self.db.commit()
    def record(self, project_id: str, name: str, path: str, opened_at: float) -> None:
        with self._lock:
            self.db.execute("INSERT OR REPLACE INTO projects VALUES (?,?,?,?)", (project_id,name,path,opened_at)); self.db.commit()
    def recent(self, limit: int = 20):
        with self._lock:
            return self.db.execute("SELECT project_id,name,path,opened_at FROM projects ORDER BY opened_at DESC LIMIT ?", (limit,)).fetchall()
    def rebuild(self, roots):
        with self._lock:
            self.db.execute("DELETE FROM projects")
        from .serialization import load_json
        for root in roots:
            root = Path(root)
            for descriptor in root.rglob("*.auvra"):
                try:
                    data = load_json(descriptor)
                    from .schemas import validate_project_descriptor
                    validate_project_descriptor(data)
                    self.record(data["projectId"], data["name"], str(descriptor.parent), float(data.get("updatedAt", 0)))
                except Exception: continue
        with self._lock:
            self.db.commit()
    def close(self):
        with self._lock:
            self.db.close()
