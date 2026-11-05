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
export const inject = ['llm', 'tools']
export const Config = { '~standard': { version: 1, vendor: 'antigravity', validate(value) { /* … */ } } }
export async function apply(ctx, config) {
  const registration = ctx.llm.registerAdapter(['antigravity'], adapter)
  const disposers = [/* image_generate / google_search via ctx.tools.register */]
  return () => { registration(); disposers.forEach((dispose) => dispose()) }   // unregister on disposal
}
```

`src/adapter.mjs` is a duck-typed adapter (no imports from the installation, because an
absolute-path plugin cannot resolve `@deepseek-ai/*` specifiers):

| Member | Purpose |
|---|---|
| `providerInfo(id)` | `{ id, name: 'Antigravity' }` (id must equal the route) |
| `providerRetryPolicy()` | `undefined` → harness default retry policy (model calls are retried by `dsh-llm-retry`, not here) |
| `listModels(provider)` | live Antigravity catalogue: `{ provider, id, name, inputModalities }` |
| `resolveModel(provider, model)` | adds `context.contextWindow`, `defaultMaxTokens`, `reasoning.efforts` |
| `prepareCall(provider, model, signal)` | `{ model, stream }` — called before every request |
| `stream(options)` | async generator of harness chunks: `text-delta`, `reasoning-delta`, `tool-call-delta`, `usage`, `finish` |
| `imageRequestTarget(...)` | attachment projection geometry for input images |
| `lastError` | the last failure (`{at, code, message}`), shown in the settings GUI; a `RATE_LIMIT`/`QUOTA` failure also arms the throttle cooldown |

Errors are thrown as an `Error` carrying an own `code` **and** an own
`failure = { code, message, status? }` snapshot — the documented cross-package seam that the
harness accepts without class identity (`normalizeLlmFailure`).

## Endpoints and credentials

No configuration of endpoints or keys is needed: the adapter reads the Antigravity credential
(Windows Credential Manager `gemini:antigravity`), scans the OAuth client pair out of the
installed `language_server.exe`, mints access tokens and calls the private
`v1internal:streamGenerateContent` API. Every request carries the `antigravity` user agent the
endpoint demands.

## Built-in image generation

With `features.imageGen` (default `true`) the plugin also registers an `image_generate` agent
tool (`src/tool.mjs` + `src/imagegen.mjs`). Any model can call it mid-conversation; the tool
calls Antigravity's built-in image model (`imageGenerationModelIds` →
`gemini-3.1-flash-image`) with `responseModalities: ["TEXT","IMAGE"]` + `imageConfig`, saves
the JPEG into `features.mediaOutputDir` and returns a markdown image reference that the chat UI
renders. Parameters: `prompt`, `aspect_ratio` (enum), `count` (1–4) and `reference_path` — an
existing `.png`/`.jpg`/`.jpeg`/`.webp` file (≤ 20 MiB) sent as `inlineData` before the prompt,
which turns the tool into image **editing**. A refused generation (HTTP 200 + empty content +
`finishMessage`) is reported as an error, not a blank success.

## Built-in web search

The endpoint refuses `tools:[{googleSearch:{}}]` together with `functionDeclarations` (HTTP 400),
so a normal agent turn can never ground. With `features.googleSearchTool` (default `true`) the
plugin registers a `google_search` tool (`src/search.mjs`) that runs its **own** grounded
generation with no function declarations — model `features.searchModel`
(default `gemini-3.5-flash-lite`) — and returns the answer plus a de-duplicated source list. The
tool result appends the sources as a markdown list (`[n] title — uri`), because the chat UI does
not render citation annotations. The endpoint only grounds Gemini models; Claude/GPT-OSS ignore
the server tool.

## Request shaping and retries

One `src/throttle.mjs` instance is shared by the adapter and both tools: `maxConcurrentRequests`
(default `2`), `minRequestIntervalMs` (default `0`) and `rateLimitCooldownMs` (default
`60000`, a cap on the pause armed by a 429/QUOTA answer, honouring the server's `retryAfter`).
This keeps the request pattern close to the IDE's own and lowers account-abuse risk.

Model calls carry **no** retry loop inside the adapter — `dsh-llm-retry` owns them. Tool
sub-calls are outside that layer and pass `retries: 2` to `client.openStream`, which retries
only transient `429`/`503`/`CAPACITY_EXHAUSTED` answers.

## Settings GUI (Client half)

`client.js` is a standard `dsh.client` bundle (declared in `package.json` with `platform: web`,
`immediately: true`, and the `./client` export). It registers one `settings.section` entry via
`ctx.slots` and reads the host API with `fetch`:

| Route (host, `src/status.mjs`) | Purpose |
|---|---|
| `GET /antigravity/status[?refresh=1]` | account, quota buckets, catalogue, effective config and plugin runtime (`version`, `tools`, `throttle`, `lastError`, `limits`) (60 s cache) |
| `POST /antigravity/config` | edits the editable `features.*` flags through the harness config editor |
| `POST /antigravity/test-image` | `{prompt, aspect_ratio}` → generated image path + markdown |
| `POST /antigravity/test-search` | `{query}` → `{ok, query, answer, sources[], queries[]}`; 501 when the composition has no search wiring |
| `GET /antigravity/media/<name>` | serves a generated image for the preview |

The header shows the plugin version (`Antigravity v0.5.0`). The page shows the account
tier/project, per-model limits with bars and reset times, the live catalogue
(context/output/thinking/image) and the effective `features.*` flags — `googleSearchTool`,
`googleSearch`, `imageGen`, `imageOutput`, `includeThoughts`, `defaultThinkingLevel` and
`imageAspectRatio` are editable live; paths/models/credentials stay in `cordis.patch.yml`. A
**Служебное** card adds the version, the registered tools, the throttle limits and live state
(`active`/`queued`, 429 cooldown deadline) and the last adapter error. Below it are a one-click
imageGen smoke test and a one-click grounded-search smoke test with clickable sources.

## Tests

```powershell
node test/unit.mjs     # offline, 37 checks (includes the GUI routes)
node test/live.mjs     # live default, 16 checks; needs Antigravity installed and spends quota
$env:AG_MATRIX_TEST = '1'; node test/live.mjs   # + model matrix, 25 checks
$env:AG_IMAGE_TEST = '1'; node test/live.mjs    # + image generation/editing
$env:AG_IMAGE_TEST = '1'; $env:AG_MATRIX_TEST = '1'; node test/live.mjs   # everything, 27 checks
```

Checks that are not enabled, cannot run on this account (model not advertised, image quota wall)
or were not reached (no 429) print `SKIP …` and are not counted.

## License

MIT.
