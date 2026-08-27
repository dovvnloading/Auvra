# Auvra

Auvra is an open-source game engine and editor under active development. The
current repository is an early working prototype, not a stable release. Project
files, workflows, and internal APIs may change while the engine is rebuilt on a
more durable foundation.

The editor currently includes scene assembly, environment tools, animation
graphs, visual blueprints, sandbox play, HUD editing, and texture workflows. It
uses React, TypeScript, Three.js, and Vite today. A Python launcher now owns the
development startup process and runs the editor in the supported desktop frame.
A versioned host boundary provides the foundation for future local services.

## Development status

Auvra is pre-alpha. It is suitable for development and experimentation, but it
should not yet be used for production projects or irreplaceable work.

The current refactor status is tracked in [REFACTOR.md](REFACTOR.md). That file
is a public summary; detailed architecture and internal implementation planning
are intentionally maintained outside the public repository history.

## Development requirements

- Windows 11 24H2 or newer on x64 for the desktop editor
- Microsoft Evergreen WebView2 Runtime
- CPython 3.12, 3.13, or 3.14
- Node.js 22.12 or newer on the Node 22 LTS line, or Node.js 24
- npm 10 or 11

Installed packages carry their own Python runtime, WebView2 runtime and SDK,
native engine, and compiled frontend. Node.js, npm, uv, Vite, and the repository
source tree are development tools and are not runtime requirements for an
installed build.

## Development startup

Run the launcher from the repository root:

```powershell
python Auvra/Auvra.py
```

The standard-library bootstrap prepares the repository's locked Python
environment and provisions the pinned uv tool when needed. The launcher then
checks the local runtimes, restores locked frontend dependencies with `npm ci`
when needed, starts Vite on loopback, and opens Auvra in its own WebView2
window. It prefers port 3000; if that port is occupied, it reports and uses the
first available port from 3001 through 3099. It never opens the user's normal
browser or stops unrelated processes.

The first desktop launch may download the pinned WebView2 SDK package. The
Evergreen WebView2 Runtime is a machine prerequisite and is not installed by
the launcher.

Useful commands:

```powershell
python Auvra/Auvra.py doctor
python Auvra/Auvra.py prepare
python Auvra/Auvra.py prepare --repair
python Auvra/Auvra.py start --port 3010
python Auvra/Auvra.py clean
python Auvra/Auvra.py clean --dependencies
python Auvra/Auvra.py support --output .\auvra-support.zip
python Auvra/Auvra.py support --delete-local --yes
```

`clean` removes launcher state and frontend build output. Dependency removal is
separate and requires confirmation. Add `--json` before or after a command for
structured diagnostics.

Diagnostics stay on the local machine, are redacted, and are limited to five
files, 30 days, and 5 MiB. A support bundle is created only when requested, and
local diagnostics can be deleted explicitly. Auvra does not collect telemetry
or upload crash reports automatically.

The stable exit codes are 0 for success, 2 for invalid usage, 10 for an
unsupported runtime, 11 for dependency failure, 12 for a port problem, 13 for
readiness failure, 14 for a child-process failure, 15 for cleanup failure, and
130 for interruption.

The manual Vite path remains available for frontend diagnosis. It does not
exercise the native host boundary:

```powershell
cd "fbx-viewer (1)"
npm ci
npm run dev
```

## Projects

Project saving is owned by the Python host. Use the editor's New, Open, Save,
Save As, Import, Export, and Close controls instead of browser downloads or
file inputs. A project is a regular folder with an `.auvra` descriptor,
reviewable JSON documents, and content-addressed source assets. Portable copies
use the `.auvrapack` extension.

Only one Auvra process writes a project at a time. If the same project is
already open elsewhere, the additional window opens it read-only. The editor
tracks unsaved changes, keeps bounded manual and automatic recovery points, and
restores project state without reloading the page.

Legacy `.forge` files can be imported through the native project controls. An
existing `OmniRenderDB` browser database can also be copied into an empty native
project. Both legacy sources are treated as read-only and are never cleared or
modified automatically. Because Auvra remains pre-alpha, keep independent
backups of important work.

## Rendering

The current editor renderer remains Three.js on WebGL2, now behind Auvra-owned
rendering contracts and explicit surface ownership. Editor, preview, and play
surfaces share one lifecycle policy, report their capabilities and frame
metrics, and recover from a lost graphics context without hiding the failure.
Thumbnail generation uses a separate on-demand capture path instead of opening
additional live renderers in hover UI.

WebGL2 is the stable compatibility path. WebGPU is available only as an
experimental reference probe and is not selected for editor presentation; an
explicit WebGPU request reports why it falls back to WebGL2.

A native engine vertical slice is also available for development. It runs as a
launcher-owned Rust process, keeps its world state across editor reloads, and
renders reference content through `wgpu` in a separate native viewport. Build
the pinned release binary before launching Auvra:

```powershell
cd native
cargo +1.98.0 build --release --locked
cd ..
python Auvra/Auvra.py
```

Add `?renderer=native` to the editor URL to select the native viewport. If the
release binary or native device is unavailable, Auvra reports the reason and
keeps the WebGL2 viewport active.

## Packaged releases

The release pipeline produces a deterministic Windows x64 MSIX containing the
compiled frontend, embedded Python environment, fixed WebView2 runtime, and
native engine. Packaged startup verifies the release manifest before opening
the editor, runs without Vite or a network connection, and keeps projects,
settings, diagnostics, and recovery data outside the immutable package.

Stable, beta, and development packages have separate Windows identities. CI
builds an unsigned development package and verifies its contents and packaged
startup. Stable and beta packages must be signed in a protected release
operation; signing certificates are never stored in the repository or CI.

Provider extensions use signed `.auvraplugin` packages. Their permissions are
granted per project, can be revoked, and are enforced in a restricted
out-of-process worker. Plugins do not receive raw credentials or ambient access
to project files, the network, the browser, or the engine process.

## Provider integrations

Provider access is owned by the Python host. fal.ai is Auvra's primary media
provider. Text, coding, and command assistance can be explicitly routed to
OpenAI, Anthropic, xAI, OpenRouter, Ollama, or llama.cpp.

Configure providers from the editor settings. On supported Windows systems,
credentials can be stored in Windows Credential Manager or kept in memory for
the current session. Credentials are never written to project files or browser
storage. Routes are explicit; the host does not silently switch providers.

Generated media remains a preview until it is committed to the project. Local
providers use explicitly configured loopback endpoints.

To verify the launcher, frontend contracts, and production bundle locally:

```powershell
python -m unittest discover -s tests -t . -v
cd "fbx-viewer (1)"
npm run protocol:verify
npm run renderer:verify
npm run project:verify
npm run provider:verify
npm run build
cd ..
cargo +1.98.0 build --release --locked --manifest-path native/Cargo.toml
.\native\target\release\auvra-native.exe --self-test
```

Python environment metadata is locked with uv. Contributors can check the
managed environment with `uv sync --locked --no-install-project --no-dev`;
users do not need to preinstall uv for the normal launcher path.

## Contributing

The codebase is moving through a staged refactor, and changes need to stay
within the active stage. Before starting a substantial pull request, open an
issue describing the problem and the files it would affect. Keep pull requests
focused, include the checks used to verify the change, and avoid unrelated
cleanup.

## License

Auvra is licensed under the [Apache License 2.0](LICENSE).
