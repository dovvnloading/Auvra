# Editor frontend

This directory contains Auvra's current React and TypeScript editor.

The supported development entry point is the Python launcher at the repository
root:

```powershell
python Auvra/Auvra.py
```

It validates Python, Node.js, npm, and the committed lockfile; installs only
when the dependency state is missing or stale; starts Vite on `127.0.0.1`; and
opens the editor in the Python-owned WebView2 frame on Windows 11 24H2 or newer
on x64. The
launcher owns the development-server process tree and never opens the user's
normal browser. The Microsoft Evergreen WebView2 Runtime is required for this
development path.

For direct frontend diagnosis, use the manual fallback from this directory.
This path does not exercise the native host boundary:

```powershell
npm ci
npm run dev
```

The supported frontend runtimes are Node.js 22.12+ on the Node 22 LTS line or
Node.js 24, with npm 10 or 11.

Installed packages do not use this development toolchain. They contain the
compiled frontend, embedded Python environment, fixed WebView2 runtime, and
native engine, and start without Node.js, npm, uv, Vite, or network access.

Project files are controlled by the native host. The header provides New,
Open, Save, Save As, Close, `.auvrapack` import/export, legacy `.forge` import,
recent projects, read-only status, and recovery selection. Browser storage is
not a saving authority; `OmniRenderDB` is opened only as a read-only migration
source for older work.

Provider settings and requests are owned by the native host. fal.ai is the
primary media path; OpenAI, Anthropic, xAI, OpenRouter, Ollama, and llama.cpp
are available for explicitly configured text, coding, and command capabilities.
Credentials use Windows Credential Manager or an explicit memory-only mode.
Routes do not silently fall back, and generated media remains a preview until
it is committed to the project.

The editor currently presents through the WebGL2 compatibility renderer. Its
editor, preview, and play surfaces are registered through one Auvra-owned
lifecycle boundary with observable context recovery and frame/resource
diagnostics. Generated thumbnails use a separate on-demand capture renderer.
The WebGPU reference path remains experimental and deliberately falls back to
WebGL2 for editor presentation.

The Stage 6 native vertical slice can be selected with `?renderer=native` after
building `native/target/release/auvra-native`. The launcher owns that process;
its world state survives an editor reload, and it presents through a separate
native viewport. A failed or unavailable native start reports its reason and
leaves the WebGL2 compatibility renderer active. Production packages include
the verified native release binary while preserving WebGL2 as the compatibility
fallback.

Create the compiled frontend input with:

```powershell
npm run build
```

This command does not create an installer. The repository release pipeline
combines the compiled frontend with the pinned runtimes, native engine, host,
licenses, integrity manifest, and software bill of materials before producing
the Windows package.

Verify the frontend project and host boundary with:

```powershell
npm run project:verify
npm run protocol:verify
npm run provider:verify
npm run renderer:verify
```

Repository status, licensing, and contribution guidance are documented in the
root [README](../README.md).
