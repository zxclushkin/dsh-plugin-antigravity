# Research notes

These documents are the reverse-engineering work the plugin was built on. They were captured
on a live Windows machine against a real Antigravity installation and a real DSH profile, so
they contain local paths (`C:\Users\…`, `C:\lab\…`) and approximate line references into
installed packages; treat them as evidence, not as documentation with a stable API.

| File | Scope |
|---|---|
| [api.md](api.md) | Antigravity side: endpoint and envelope, credential locations, OAuth refresh, `User-Agent` gate, SSE shape, tool-call format (`functionCall` / `thoughtSignature` / `functionResponse`), model catalogue, quotas and error codes. |
| [dsh-integration.md](dsh-integration.md) | DSH side: how `@deepseek-ai/dsh-llm-pi-ai` registers a provider route and its models, what the Web UI model picker reads, patch-layer semantics (`config` is replaced wholesale), live-reload behaviour, and how the result was verified. |

Both are written in Russian. Secrets are masked to `first6…last4`; nothing here contains a
usable token.
