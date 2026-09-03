# Auvra refactor

Auvra is being rebuilt in place. The editor is usable as a development
prototype, but the repository is not a stable engine release and compatibility
is not guaranteed yet.

The work is deliberately staged. Each stage has a fixed scope and a completion
gate; implementation does not advance merely because adjacent work looks
convenient. This public outline summarizes the direction without publishing the
internal architecture or working notes.

## Status

| Stage | Focus | Status |
|---|---|---|
| -1 | Remove inherited provider-specific scaffolding and establish a clean baseline | Complete |
| 0 | Establish the public repository, license, project status, and verification baseline | Complete |
| 1 | Make development reproducible and build the Python launcher | Complete |
| 2 | Run the editor in a desktop-owned frame behind a defined host boundary | Complete |
| 3 | Replace browser-owned saving with a durable project system | Complete |
| 4 | Add secure provider routing, BYOK settings, fal.ai media workflows, and text/local provider adapters | Complete |
| 5 | Stabilize the current renderer and establish backend-independent rendering contracts | Complete |
| 6 | Prove the native engine and multi-backend rendering path with a vertical slice | Complete |
| 7 | Complete packaging, recovery, performance, compatibility, and release hardening | Complete |
| 8 | Establish the deterministic native world, asset cooker, and capability-gated production renderer baseline | Complete |

## What this means for the current repository

- Expect breaking changes while project and runtime boundaries are established.
- The current WebGL2 renderer remains the working compatibility path inside the
  desktop frame. Renderer ownership, capture, diagnostics, context recovery,
  reference measurements, and backend-independent contracts are now explicit.
  WebGPU remains an experimental reference path and does not silently replace
  the stable renderer.
- Provider access now runs through the Python host. fal.ai is the primary media
  path; OpenAI, Anthropic, xAI, OpenRouter, Ollama, and llama.cpp support
  explicitly configured text, coding, and command capabilities. Credentials use
  Windows Credential Manager or an explicit memory-only mode, routes do not
  silently fall back, and generated media remains a preview until committed.
- Local execution and local compute are first-class requirements.
- Saving, recovery, provider access, and rendering now run behind explicit
  engine services. The Rust runtime hydrates a deterministic fixed-step world
  from the Python project repository, cooks source assets into a rebuildable
  local cache, and extracts immutable render snapshots. Its capability-gated
  `wgpu` renderer covers the native production baseline in a separate viewport
  while preserving WebGL2 as the compatibility path.
- Project saving and recovery now run through the native host; legacy browser
  storage remains available only as a read-only migration source.
- Experimental work must preserve a tested fallback and may not silently become
  the default path.
- The Windows release pipeline now assembles the frontend, embedded Python,
  fixed WebView2 runtime, and native engine into a deterministic MSIX. Packaged
  startup is offline and verifies its payload before opening the editor; CI
  publishes unsigned development artifacts, while stable and beta signing stays
  in a protected release operation.
- Provider extensions now have a signed package format, per-project permissions,
  revocation, a versioned interface, and restricted out-of-process execution.
  Diagnostics remain local, bounded, and redacted, with explicit export and
  deletion controls and no automatic telemetry or crash upload.

There is no release date attached to these stages. Progress is measured by
verified exit conditions, not by partially implemented feature claims.
