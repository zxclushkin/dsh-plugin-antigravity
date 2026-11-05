# Changelog

## 0.6.0 — localized settings page, durable images, cross-platform credentials

The GUI now speaks the operator's language, generated images land in the harness attachment
store, credentials are read on macOS/Linux as well, and the default request spacing finally looks
human.

- **GUI localization** (`plugin/client.js`): every visible string of **Settings → Antigravity**
  goes through the DSH client locale service, registered under the `antigravity` namespace.
  Complete **en / zh / ru** dictionaries, 72 keys each, with `{placeholder}` interpolation; the
  page follows the DSH language and re-translates live; a composition without the locale service
  gets the English fallback. Technical values — model ids/names, tool names, paths,
  `HTTP <status>`, `k ctx`/`k out` — stay untranslated on purpose. Slot id, order and label are
  unchanged.
- **Durable image attachments** (`src/imagegen.mjs`, `src/adapter.mjs`, `src/tool.mjs`): generated
  images — both `image_generate` and image-model output in a chat turn — are committed to the
  harness attachment store as normalized, content-addressed attachments and referenced by their
  durable host path (`~/.dsh/attachments/…`); the tool output gains `attachment_id`. Falls back
  to `features.mediaOutputDir` when the composition has no store or the store refuses the image;
  `features.durableImages: false` is a single switch that forces that fallback for both the image
  model's chat-turn output and `image_generate`. The GUI imageGen preview serves durable objects
  too (`/antigravity/media/?path=`, content type sniffed from magic bytes, only the media dir and
  the attachment store are allowed). The store contract was checked against the live service:
  `saveImages` takes a **Uint8Array** of decoded bytes, not base64 text (fixed here).
- **Cross-platform credentials** (`src/antigravity.mjs`): `readKeyringCredential` reads Windows
  Credential Manager (verified live), macOS Keychain (`security find-generic-password -s
  gemini:antigravity -w`) and Linux libsecret (`secret-tool lookup service gemini:antigravity`);
  the language-server scan path is derived per platform. The macOS/Linux paths are best-effort and
  untested here; failures name the command and the entry to fix. `parseCredentialBlob` and
  `credentialCommandFor` are exported for tests and diagnostics.
- **Human-shaped throttle default**: `minRequestIntervalMs` is now `500` (was `0`), alongside
  `maxConcurrentRequests: 2` and `rateLimitCooldownMs: 60000`, so a local agent loop is spaced
  like an IDE session. All three stay configurable.
- **Packaging** (`tools/apply-profile.mjs`): new `--package` mode mounts the plugin by package
  name and validates `name: dsh-plugin-antigravity` in the generated patch; the desktop profile
  installs it as a link dependency (`dsh plugin --profile desktop add
  'link:C:/lab/antigravity/plugin'`). The mount switch applies live. HMR does **not** reliably
  watch linked plugin sources in this DSH build, so source edits still need a restart; patch and
  config edits do not. Bumping a versioned `file:///…?rev=<timestamp>` mount re-imports the module
  live (verified) and is the no-restart path for host-code changes; the client bundle needs a page
  refresh either way.
- Tests: offline checks grew to 42 (durable-store persistence and media-directory fallback,
  credential helpers for every platform, throttle defaults, durable-preview route); live default
  is 16 checks, matrix
  25, and the full matrix+image run 26 with one image check skipped on the account's image quota
  (a quota wall is a SKIP, not a FAIL).

## 0.5.0 — grounded search tool, request throttling, image editing

Closes the "grounding never works in the agent loop" gap and hardens the account-facing
behaviour: a `google_search` tool, a request throttle, image editing and a cleaner retry split.

- `google_search` tool (`src/search.mjs`): the endpoint rejects `googleSearch` together with
  `functionDeclarations` (HTTP 400), so a normal agent turn — which always carries the harness
  tools — can never ground. The tool issues its own grounded generation with no function
  declarations (model `features.searchModel`, default `gemini-3.5-flash-lite`) and returns the
  answer plus a de-duplicated source list rendered as a markdown `Sources:` block. Registered by
  default; `features.googleSearchTool: false` removes it.
- `image_generate` now edits as well as draws: the new `reference_path` parameter takes an
  existing `.png`/`.jpg`/`.jpeg`/`.webp` file (≤ 20 MiB, extension and size guarded) and sends it
  as `inlineData` before the prompt, turning the call into image-to-image editing.
- Request throttle (`src/throttle.mjs`): one limiter shared by the adapter and both tools. New
  top-level config `maxConcurrentRequests` (default `2`), `minRequestIntervalMs` (default `0`)
  and `rateLimitCooldownMs` (default `60000`, cap on the pause armed by a 429/QUOTA answer,
  honouring the server's `retryAfter`). A local agent loop can no longer turn into a burst of
  upstream requests, which lowers the account-abuse risk.
- Retry policy: model calls no longer retry inside the adapter (previously up to two retries on
  429/503) — `dsh-llm-retry` owns those, so delay and quota cost are not doubled. Tool sub-calls
  sit outside that layer and keep two internal retries via `client.openStream({retries: 2})`.
- Status/GUI: `/antigravity/status` gains `plugin` (`version`, `tools`, `throttle`, `lastError`)
  and `limits`; the settings page shows the version in the header and a **Служебное** card with
  the registered tools, the throttle limits and live state, and the last adapter error.
  `googleSearchTool` is editable live through `POST /antigravity/config`. New
  `POST /antigravity/test-search` runs one grounded query and returns
  `{answer, sources[], queries[]}` (501 when the composition has no search wiring), rendered as
  a **Проверка google_search** card with clickable sources.
- `modelCacheTtlMs: 0` now means "no catalogue cache" (every catalogue read goes to the
  endpoint), which the live tests use for a fresh catalogue.
- Tests: offline checks grew to 37 (throttle concurrency/interval/cooldown, grounded-search
  parsing, reference-image request, adapter error recording, new config keys, status meta and the
  new GUI routes). The live suite grew to 16 default checks, 25 with `AG_MATRIX_TEST=1` (a
  per-model matrix, `groundedSearch`, throttle serialization and one image edit) and 27 with the
  image gate as well.

## 0.4.0 — settings GUI with account limits

The plugin now ships a Client half: **Settings → Antigravity** in the DSH Web UI.

- `client.js` registers a `settings.section` entry through `ctx.slots` and is loaded by the
  harness web plugin table (`dsh.client` in `package.json`, `./client` export). The package is
  discovered from the mounted row's own manifest, so the absolute-path install needs no
  extra wiring.
- Shows account tier/project, **per-model quotas** with bars and reset times, the live model
  catalogue (context/output/thinking/image), and the effective `features.*` configuration,
  with a refresh action and a one-click imageGen smoke test with inline preview.
- `src/status.mjs` adds the host API behind it: `GET /antigravity/status` (60 s cache,
  `?refresh=1`), `POST /antigravity/test-image`, `GET /antigravity/media/<name>`; routes are
  registered through `ctx.inject(['webServer'])` so compositions without a web server skip
  them cleanly.
- POST /antigravity/config edits the editable eatures.* flags through the harness config editor, so toggles apply live.
- Offline checks grew to 27 (status snapshot, JSON route, test-image route, media guard).

## 0.3.0 — built-in image generation tool

The adapter now also registers a harness **tool**, so image generation is available to *any*
model in the agent instead of only to the image model in the picker — the way the Antigravity
IDE's own agent uses its built-in imageGen.

- `image_generate` tool (`src/tool.mjs`): `prompt`, `aspect_ratio` (enum), `count` (1–4);
  returns saved absolute paths and a markdown image reference rendered by the chat UI.
- `src/imagegen.mjs`: calls the account's built-in image model
  (`imageGenerationModelIds` → `gemini-3.1-flash-image`) with
  `responseModalities: ["TEXT","IMAGE"]` + `imageConfig`, saves the JPEG, and turns the
  endpoint's HTTP-200-with-`finishMessage` refusals into real failures.
- Config: `features.imageGen`, `features.imageModel`, `features.imageAspectRatios`,
  `features.imageMaxOutputTokens`; `plugin.inject` is now `['llm','tools']`.
- Verified end-to-end through `dsh headless`: the agent called `image_generate` and produced a
  1024×1024 JPEG in one turn; offline checks grew to 21.

## 0.2.0 — native LLM adapter

Rewritten from a local OpenAI-compatible gateway + `llm-pi-ai` route into a **native harness
LLM adapter**: `ctx.llm.registerAdapter(['antigravity'], adapter)` streams the harness
`StreamChunk` protocol directly. No HTTP hop, no OpenAI wire format, no model list to maintain —
the picker is built from the live Antigravity catalogue.

- Adapter contract: `providerInfo`, `providerRetryPolicy`, `listModels`, `resolveModel`,
  `prepareCall`, `stream`, `imageRequestTarget`, with zero imports from the installation
  (absolute-path mount cannot resolve `@deepseek-ai/*`).
- Harness chunks: text, reasoning (`Thinking` block), tool-call deltas with JSON arguments,
  usage (incl. cached tokens), terminal finish reasons; failures carry harness `code`/`failure`
  facts through the documented cross-package seam.
- Gemini protocol: system instructions, alternating contents, image attachments resolved via
  the harness attachment service, tool declarations (no-argument tools declared without
  `parameters`), `thoughtSignature` replay encoded in the tool-call id, thinking levels/budgets.
- Google AI features that actually work on the private endpoint: structured output
  (`responseSchema`), Google Search grounding (turns without tools), image generation and image
  editing, image input, live model catalogue (17 chat + image models on the test account).
- Explicit non-features of the endpoint are documented instead of faked: `googleMaps`,
  `urlContext`, `codeExecution`, `includeThoughts`, safety metadata, embeddings, penalties,
  `n>1`, `fileData`.
- `tools/apply-profile.mjs` now installs a single managed block and no longer touches
  `llm-pi-ai`; it also refuses to pick a backup that mentions Antigravity when `--pristine` is
  requested, so unrelated profile edits are never reverted.
- Tests: 18 offline checks, 10 live checks; verified end-to-end through `dsh headless`
  (text and a full agent tool loop).

## 0.1.0 — initial gateway

Local OpenAI-compatible gateway in front of Antigravity's `v1internal` API, registered as an
`llm-pi-ai` provider route. Superseded by 0.2.0.
