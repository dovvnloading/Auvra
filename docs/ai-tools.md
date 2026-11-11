# AI tools — local only

**Paid cloud AI has been removed.** Provider catalog prices are estimates, not worst-case billing ceilings. The host does not submit new work or retries to fal.ai, OpenAI, Anthropic, xAI or OpenRouter, even when an older project has a cloud route saved, a key exists, or the request supplies an estimated price or explicit consent. The former **Spending** page and its unenforceable limits were removed; no guarantee about third-party billing is made.

## Available without paid cloud access

- **Local text, scripts and HUD proposals:** Choose an installed Ollama or llama.cpp model where that model supports the task. The editor can still propose code or HUD changes for review and approval, without contacting the paid cloud services.
- **Local render:** **Render this view** uses [Reframe](https://github.com/dovvnloading/Reframe-Diffused), a renderer on this computer, where installed. Its **Preview**, **Good** and **Final** settings trade time for image quality. Rendering does not call a paid cloud AI provider.
- **Model and project editing:** Existing projects, assets and previously generated textures remain available; the normal editing, preview and undo operations are unaffected by removing paid AI generation.

## Unavailable features

Cloud-generated textures, surface maps, skies, decals, full-mesh retexturing, and paid cloud text or code completions are unavailable. The model picker lists only local providers for supported tasks; if no local model supports a task, the editor says so rather than silently falling back to a paid service.

The **Keys** page marks legacy cloud providers as disabled and still allows existing cloud credentials to be deleted. It does not offer new cloud key entry or cloud activation. Upstream jobs submitted before installing this change may still be charged by the provider, so manage those requests and billing accounts directly with the provider.

Paid cloud inference can only be reintroduced in a separate reviewed change backed by real provider-enforced maximum charge bounds or equivalent enforceable spending controls, with complete regression coverage. A host-side rough estimate is never such a guarantee.
