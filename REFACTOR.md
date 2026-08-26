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
| 1 | Make development reproducible and build the Python launcher | In verification |
| 2 | Run the editor in a desktop-owned frame behind a defined host boundary | Planned |
| 3 | Replace browser-owned saving with a durable project system | Planned |
| 4 | Add secure provider routing, BYOK settings, fal.ai media workflows, and text/local provider adapters | Planned |
| 5 | Stabilize the current renderer and establish backend-independent rendering contracts | Planned |
| 6 | Prove the native engine and multi-backend rendering path with a vertical slice | Planned |
| 7 | Complete packaging, recovery, performance, compatibility, and release hardening | Planned |

## What this means for the current repository

- Expect breaking changes while project and runtime boundaries are established.
- The browser-based editor remains the working reference during the migration.
- fal.ai is the intended primary media-generation service; text and coding
  assistance will use capability-based routing across supported cloud and local
  providers.
- Local execution and local compute are first-class requirements.
- Saving, recovery, rendering, and provider access will move behind explicit
  engine services instead of remaining browser-only concerns.
- Experimental work must preserve a tested fallback and may not silently become
  the default path.

There is no release date attached to these stages. Progress is measured by
verified exit conditions, not by partially implemented feature claims.
