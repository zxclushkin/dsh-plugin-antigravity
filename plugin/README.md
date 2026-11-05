# dsh-plugin-antigravity

Native [DeepSeek Harness](https://github.com/deepseek-ai) LLM adapter for the models of an
installed Google **Antigravity** app. It registers itself with the harness `llm` service and
streams the harness `StreamChunk` protocol directly — no local HTTP gateway, no `llm-pi-ai`
route.

Full documentation, install steps and troubleshooting: **[../README.md](../README.md)**.

```
DSH agent loop ──ctx.llm.stream──► dsh-plugin-antigravity ──Gemini JSON──► cloudcode-pa
                                   (native LlmAdapter)                     streamGenerateContent
```

## Plugin contract

`index.mjs` exports what the Cordis loader expects:

```js
export const name = 'antigravity-llm'
export const inject = ['llm']
export const Config = { '~standard': { version: 1, vendor: 'antigravity', validate(value) { /* … */ } } }
export async function apply(ctx, config) {
  const registration = ctx.llm.registerAdapter(['antigravity'], adapter)
  return () => registration()   // unregister on disposal
}
```

`src/adapter.mjs` is a duck-typed adapter (no imports from the installation, because an
absolute-path plugin cannot resolve `@deepseek-ai/*` specifiers):

| Member | Purpose |
|---|---|
| `providerInfo(id)` | `{ id, name: 'Antigravity' }` (id must equal the route) |
| `providerRetryPolicy()` | `undefined` → harness default retry policy |
| `listModels(provider)` | live Antigravity catalogue: `{ provider, id, name, inputModalities }` |
| `resolveModel(provider, model)` | adds `context.contextWindow`, `defaultMaxTokens`, `reasoning.efforts` |
| `prepareCall(provider, model, signal)` | `{ model, stream }` — called before every request |
| `stream(options)` | async generator of harness chunks: `text-delta`, `reasoning-delta`, `tool-call-delta`, `usage`, `finish` |
| `imageRequestTarget(...)` | attachment projection geometry for input images |

Errors are thrown as an `Error` carrying an own `code` **and** an own
`failure = { code, message, status? }` snapshot — the documented cross-package seam that the
harness accepts without class identity (`normalizeLlmFailure`).

## Endpoints and credentials

No configuration of endpoints or keys is needed: the adapter reads the Antigravity credential
(Windows Credential Manager `gemini:antigravity`), scans the OAuth client pair out of the
installed `language_server.exe`, mints access tokens and calls the private
`v1internal:streamGenerateContent` API. Every request carries the `antigravity` user agent the
endpoint demands.

## Tests

```powershell
node test/unit.mjs     # offline, 18 checks
node test/live.mjs     # live, 10 checks, needs Antigravity installed and spends quota
```

## License

MIT.
