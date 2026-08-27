# Editor frontend

This directory contains Auvra's current React and TypeScript editor.

The supported development entry point is the Python launcher at the repository
root:

```powershell
python Auvra/Auvra.py
```

It validates Python, Node.js, npm, and the committed lockfile; installs only
when the dependency state is missing or stale; starts Vite on `127.0.0.1`; and
opens the editor in the Python-owned WebView2 frame on Windows 11 x64. The
launcher owns the development-server process tree and never opens the user's
normal browser. The Microsoft Evergreen WebView2 Runtime is required.

For direct frontend diagnosis, use the manual fallback from this directory.
This path does not exercise the native host boundary:

```powershell
npm ci
npm run dev
```

The supported frontend runtimes are Node.js 22.12+ on the Node 22 LTS line or
Node.js 24, with npm 10 or 11.

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

Create a production bundle with:

```powershell
npm run build
```

Verify the frontend project and host boundary with:

```powershell
npm run project:verify
npm run protocol:verify
npm run provider:verify
```

Repository status, licensing, and contribution guidance are documented in the
root [README](../README.md).
