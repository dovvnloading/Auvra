# Auvra

Auvra is an open-source game engine and editor under active development. The
current repository is an early working prototype, not a stable release. Project
files, workflows, and internal APIs may change while the engine is rebuilt on a
more durable foundation.

The editor currently includes scene assembly, environment tools, animation
graphs, visual blueprints, sandbox play, HUD editing, and texture workflows. It
uses React, TypeScript, Three.js, and Vite today. A Python launcher now owns the
development startup process and provides a foundation for the desktop host and
local services that will follow.

## Development status

Auvra is pre-alpha. It is suitable for development and experimentation, but it
should not yet be used for production projects or irreplaceable work.

The current refactor status is tracked in [REFACTOR.md](REFACTOR.md). That file
is a public summary; detailed architecture and internal implementation planning
are intentionally maintained outside the public repository history.

## Requirements

- CPython 3.12, 3.13, or 3.14
- Node.js 22.12 or newer on the Node 22 LTS line, or Node.js 24
- npm 10 or 11

## Start the editor

Run the launcher from the repository root:

```powershell
python Auvra/Auvra.py
```

The launcher checks the local runtimes, restores locked frontend dependencies
with `npm ci` when needed, and starts Vite on loopback. It prefers port 3000;
if that port is occupied, it reports and uses the first available port from
3001 through 3099. It does not open a browser or stop unrelated processes.

Useful commands:

```powershell
python Auvra/Auvra.py doctor
python Auvra/Auvra.py prepare
python Auvra/Auvra.py prepare --repair
python Auvra/Auvra.py start --port 3010
python Auvra/Auvra.py clean
python Auvra/Auvra.py clean --dependencies
```

`clean` removes launcher state and frontend build output. Dependency removal is
separate and requires confirmation. Add `--json` before or after a command for
structured diagnostics.

The stable exit codes are 0 for success, 2 for invalid usage, 10 for an
unsupported runtime, 11 for dependency failure, 12 for a port problem, 13 for
readiness failure, 14 for a child-process failure, 15 for cleanup failure, and
130 for interruption.

The manual Vite path remains available for diagnosis:

```powershell
cd "fbx-viewer (1)"
npm ci
npm run dev
```

To verify the launcher and production bundle locally:

```powershell
python -m unittest discover -s tests -t . -v
cd "fbx-viewer (1)"
npm run build
```

Python environment metadata is locked with uv. The launcher has no third-party
Python runtime dependencies and can be used without uv; contributors can check
the locked environment with `uv sync --locked --no-install-project --no-dev`.

## Contributing

The codebase is moving through a staged refactor, and changes need to stay
within the active stage. Before starting a substantial pull request, open an
issue describing the problem and the files it would affect. Keep pull requests
focused, include the checks used to verify the change, and avoid unrelated
cleanup.

## License

Auvra is licensed under the [Apache License 2.0](LICENSE).
