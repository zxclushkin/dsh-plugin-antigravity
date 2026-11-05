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
| `persistMedia(part)` | persists generated image/audio parts: durable attachment store first, `features.mediaOutputDir` fallback |
| `lastError` | the last failure (`{at, code, message}`), shown in the settings GUI; a `RATE_LIMIT`/`QUOTA` failure also arms the throttle cooldown |

Errors are thrown as an `Error` carrying an own `code` **and** an own
`failure = { code, message, status? }` snapshot — the documented cross-package seam that the
harness accepts without class identity (`normalizeLlmFailure`).

## Endpoints and credentials

No configuration of endpoints or keys is needed: the adapter reads the Antigravity credential
from the platform store (Windows Credential Manager, macOS Keychain via `security
find-generic-password`, Linux libsecret via `secret-tool`; entry `gemini:antigravity`), scans the
OAuth client pair out of the installed `language_server` binary (platform default path), mints
access tokens and calls the private `v1internal:streamGenerateContent` API. Every request carries
the `antigravity` user agent the endpoint demands. Windows is verified live; the macOS/Linux
paths are best-effort, and their errors name the command and the entry to fix.
`parseCredentialBlob` and `credentialCommandFor` are exported for diagnostics and tests.

## Built-in image generation

With `features.imageGen` (default `true`) the plugin also registers an `image_generate` agent
tool (`src/tool.mjs` + `src/imagegen.mjs`). Any model can call it mid-conversation; the tool
calls Antigravity's built-in image model (`imageGenerationModelIds` →
`gemini-3.1-flash-image`) with `responseModalities: ["TEXT","IMAGE"]` + `imageConfig` and returns
a markdown image reference that the chat UI renders. Parameters: `prompt`, `aspect_ratio` (enum),
`count` (1–4) and `reference_path` — an existing `.png`/`.jpg`/`.jpeg`/`.webp` file (≤ 20 MiB)
sent as `inlineData` before the prompt, which turns the tool into image **editing**.

`src/imagegen.mjs` persists each image through `persistGeneratedImage`: when the composition
provides the harness attachment store it calls `saveImages` with a **Uint8Array** of the decoded
bytes (not base64 text — that was the bug this contract check fixed), stores the image
content-addressed and returns the store's durable host path; `image_generate` then also returns
`attachment_id`. When the store is absent or refuses the image, it writes a plain file into
`features.mediaOutputDir` and logs the fallback. The `image_generate` path always tries the store
first; the adapter gates the store for the image model's own chat-turn output on
`features.durableImages` (default on). A refused generation (HTTP 200 + empty content +
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
(default `2`), `minRequestIntervalMs` (default `500`, so a local loop looks like an IDE session)
and `rateLimitCooldownMs` (default `60000`, a cap on the pause armed by a 429/QUOTA answer,
honouring the server's `retryAfter`). This keeps the request pattern close to the IDE's own and
lowers account-abuse risk.

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
| `POST /antigravity/test-image` | `{prompt, aspect_ratio}` → saved image path (durable when available) + markdown |
| `POST /antigravity/test-search` | `{query}` → `{ok, query, answer, sources[], queries[]}`; 501 when the composition has no search wiring |
| `GET /antigravity/media/<name>` | serves an image from `features.mediaOutputDir` for the inline preview |
| `GET /antigravity/media/?path=<abs>` | serves an image by absolute path when it is under `mediaOutputDir` or the durable attachment store; content type is sniffed from magic bytes and anything outside the two roots is 404 |

Every visible string goes through the DSH client locale service (registered under the
`antigravity` namespace in `client.js`, complete **en/zh/ru** dictionaries of 72 keys each,
`{placeholder}` interpolation). The language follows the DSH language and the page re-translates
live; without a locale service it falls back to English. Model/tool names, paths, `HTTP <status>`
and the `k ctx`/`k out` markers stay untranslated on purpose.

The header shows the plugin version (`Antigravity v0.6.0`). The page shows the account
tier/project, per-model limits with bars and reset times, the live catalogue
(context/output/thinking/image) and the effective `features.*` flags — `googleSearchTool`,
`googleSearch`, `imageGen`, `durableImages`, `imageOutput`, `includeThoughts`,
`defaultThinkingLevel` and `imageAspectRatio` are editable live; paths, models and credentials stay
in `cordis.patch.yml`. The service card adds the version, the registered tools, the throttle limits
and live state (`active`/`queued`, 429 cooldown deadline) and the last adapter error. Below it are
a one-click imageGen smoke test (inline preview via `previewUrl`, which covers both the media
directory and durable attachment objects) and a one-click grounded-search smoke test with
clickable sources.

## Tests

```powershell
node test/unit.mjs     # offline, 43 checks (includes the GUI routes, durable store, credentials, client activation)
node test/live.mjs     # live default, 16 checks; needs Antigravity installed and spends quota
$env:AG_MATRIX_TEST = '1'; node test/live.mjs   # + model matrix, 25 checks
$env:AG_IMAGE_TEST = '1'; node test/live.mjs    # + image generation/editing
$env:AG_IMAGE_TEST = '1'; $env:AG_MATRIX_TEST = '1'; node test/live.mjs   # everything, 26 checks (+1 skip)
```

Checks that are not enabled, cannot run on this account (model not advertised, image quota wall)
or were not reached (no 429) print `SKIP …` and are not counted — an image check on an exhausted
image quota is a skip, not a failure.

## License

MIT.
