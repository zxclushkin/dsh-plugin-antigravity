# Research notes

These documents are the reverse-engineering work the plugin was built on. They were captured
on a live Windows machine against a real Antigravity installation and a real DSH profile, so
they contain local paths (`C:\Users\…`, `C:\lab\…`) and approximate line references into
installed packages; treat them as evidence, not as documentation with a stable API.

| File | Scope |
|---|---|
| [api.md](api.md) | Antigravity side: endpoint and envelope, credential locations, OAuth refresh, `User-Agent` gate, SSE shape, tool-call format (`functionCall` / `thoughtSignature` / `functionResponse`), model catalogue, quotas and error codes. |
| [capabilities.md](capabilities.md) | The live feature matrix of the private API: which `generationConfig` fields, server-side tools, modalities, RPCs and response metadata actually work, with exact request/response fragments and the mapping to the harness. |
| [dsh-integration.md](dsh-integration.md) | DSH side, predating the 0.2 native-adapter rewrite: how `@deepseek-ai/dsh-llm-pi-ai` registers a provider route and its models, what the Web UI model picker reads, patch-layer semantics, live-reload behaviour. The route-based install described there is superseded by [dsh-surface.md](dsh-surface.md). |
| [dsh-surface.md](dsh-surface.md) | The native adapter contract of `@deepseek-ai/dsh-llm` (`LlmAdapter`, `GenerateOptions`, `StreamChunk`, `resolveModel`/`listModels` validation, error normalization) and what the chat UI renders. |

All are written in Russian. Secrets are masked to `first6…last4`; nothing here contains a
usable token.
