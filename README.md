# dsh-plugin-antigravity

Google **Antigravity** models in [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) —
as a **native LLM adapter**, not a local HTTP proxy. The plugin registers itself with the
harness `llm` service (`ctx.llm.registerAdapter`), streams the harness `StreamChunk` protocol
directly, and gets retry policy, cancellation, usage accounting and the model picker from the
harness itself. There is no gateway process, no `llm-pi-ai` route and no OpenAI wire format in
the middle.

No API key and no extra login: credentials are reused from the installed Antigravity app
(the OS credential store entry `gemini:antigravity` — Windows Credential Manager, macOS Keychain
or Linux libsecret; the OAuth client id/secret are scanned from the installed `language_server`
binary at runtime).

```
DSH agent loop
   │  ctx.llm.stream({provider:'antigravity', model:'gemini-3-flash', messages, tools, reasoningEffort})
   ▼
dsh-plugin-antigravity (native LlmAdapter)  ──►  POST https://daily-cloudcode-pa.googleapis.com
   │  harness StreamChunk: text-delta / reasoning-delta /                    /v1internal:streamGenerateContent
   │  tool-call-delta / usage / finish                                       (Gemini-shaped JSON)
   ▼
Antigravity models: Gemini 3.8/3.5/3/2.5, Claude Opus/Sonnet 5.5, GPT-OSS 120B, Gemini image
```

Unofficial client. Not affiliated with, endorsed by, or supported by Google or DeepSeek.

> **Personal use, and a ToS risk.** This project talks to a private, undocumented API on the
> operator's own machine with the operator's own installed Antigravity session. It is not a
> supported Google integration: using it may breach Google's terms for Antigravity, it spends the
> account's plan quota, and Google can change or close the endpoint at any time. Use it only with
> an account you are allowed to use this way, keep the request throttle at its defaults, and
> expect to maintain it yourself. See [NOTICE](NOTICE).

## Status

Verified live on Windows 11 against a real Antigravity installation and DSH 0.2.1-rc.5:

| Check | Result |
|---|---|
| Offline unit checks (translation, chunk protocol, metadata, errors, throttle, search, image reference, durable store, credentials, GUI routes, client activation) | **43/43** |
| Live adapter checks against the real API (default suite) | **16/16** |
| Live model matrix (`AG_MATRIX_TEST=1`) | **25/25** (Gemini/Claude/GPT-OSS turns, tools, reasoning, grounded search, one image edit) |
| Live full run (`AG_MATRIX_TEST=1` + `AG_IMAGE_TEST=1`) | **26/26, 1 skip (quota)** — an image check hit the account's 4-hour image quota mid-run and was reported as SKIP, not FAIL |
| DSH end-to-end, text | `dsh headless` with only this plugin mounted → model answer `PONG` |
| DSH end-to-end, tools | agent created a file through the harness tool loop (tool-call → tool-result → final answer) |
| DSH end-to-end, built-in image generation | agent called `image_generate` and produced a 1024×1024 JPEG in one turn |
| Live profile replay | the real `desktop` patch replays headlessly and answers |
| Model picker | dynamic: the account's catalogue becomes the Antigravity group |

## What the adapter supports

| Capability | State |
|---|---|
| Text streaming, system prompts, stop sequences, temperature, max tokens | works |
| **Built-in `image_generate` tool — any model can draw mid-conversation** | works (agent called it in a real turn; 1024×1024 JPEG produced and rendered) |
| **Built-in `google_search` tool — any model can search the web and gets cited sources** | works (grounded sub-request; answer plus a markdown source list) |
| Tool calling (`functionDeclarations`) incl. parallel calls | works |
| `thoughtSignature` replay for tool calls (Gemini rejects history without it) | works, encoded in the harness tool-call id |
| Reasoning stream → harness `reasoning-delta` (the "Thinking" block) | works |
| Reasoning effort `low/medium/high` → `thinkingLevel` (Gemini 3.x) or `thinkingBudget` (2.5) | works for Gemini; `claude-*` accepts `thinkingConfig` without error but streams no thought parts, so effort is effectively ignored there |
| Image input (harness attachments) | works |
| Image generation and image editing (`gemini-3.1-flash-image`; `image_generate` takes `reference_path`) | works; images are saved as durable attachments (media-dir fallback) and linked as markdown |
| Structured output (`responseSchema`) | works for Gemini models (Claude/GPT-OSS reject it) |
| Google Search grounding with sources | works through the built-in `google_search` tool; direct grounding only on turns that pass no tools (endpoint limitation) |
| Request shaping: concurrency cap, request spacing, 429 cooldown | works (top-level config, visible in the settings GUI) |
| Settings GUI localization | works through the DSH client locale service (en/zh/ru, 72 keys each, English fallback) |
| Retries | model calls are left to `dsh-llm-retry`; tool sub-calls keep two internal retries |
| Usage (`usageMetadata`, incl. reasoning tokens) | works; the endpoint sends only the four basic counters (prompt / candidates / total / thoughts tokens) — no cached-token count was observed |
| Model catalogue | dynamic per account; 17 chat models + image models on the test account |

Deliberately **not** implemented because the private endpoint accepts but ignores them:
`googleMaps`, `urlContext`, `codeExecution`, `includeThoughts`, `speechConfig`,
`mediaResolution`. And unavailable/absent: `presencePenalty`, `frequencyPenalty`, `n>1`,
`thinkingBudget: 0`, `safetyRatings`/`promptFeedback` metadata, embeddings, a separate image
API, `fileData` uploads. Refusals and RECITATION arrive as HTTP 200 + empty content +
`finishMessage`; the adapter reports them as failures instead of empty answers.

Harness-side limits (not plugin bugs): a `response_format` / JSON-schema request surface does
not exist in DSH 0.2.1, so structured output is configured per provider rather than per call;
the chat UI does not render citations/annotations, so grounded sources are appended to the
answer as markdown; attachments that are not images are projected to text handles by the
harness before any adapter sees them, so PDF/audio input works in the Antigravity API but is
not reachable from the DSH chat surface.

## Requirements

- Antigravity installed and signed in. Windows is the verified platform (Credential Manager);
  the credential reader also supports macOS Keychain (`security`) and Linux libsecret
  (`secret-tool`), but those two paths are **best-effort and untested on this machine**.
- Node.js ≥ 20 (the adapter runs inside the DSH host process).
- DSH with `@deepseek-ai/dsh-llm` (tested on 0.2.1-rc.5).

## Install

Two mount modes; both insert the same managed `antigravity-llm` block.

**Absolute path (default, nothing to install in the profile):**

```powershell
node tools/apply-profile.mjs            # dry run: builds and validates the patch
node tools/apply-profile.mjs --apply    # backup + write $DSH_HOME/profiles/<profile>/cordis.patch.yml
```

**Package name (`--package`):** install the plugin into the profile as a link dependency first,
then let the tool mount it by name:

```powershell
dsh plugin --profile desktop add 'link:C:/lab/antigravity/plugin'
node tools/apply-profile.mjs --apply --package
```

`--package` validates that the patch mounts `dsh-plugin-antigravity`; the path mode validates
`plugin/index.mjs`. Both honour `DSH_HOME`, `DSH_PROFILE` and `DSH_CLI`, and the patch is
validated with DSH's own patcher under a scratch `DSH_HOME` before anything is written.

```yaml
- insert:
    - id: antigravity-llm
      name: 'C:/path/to/dsh-plugin-antigravity/plugin/index.mjs'   # or: dsh-plugin-antigravity
      config:
        enabled: true
        debugDir: 'C:/path/to/dsh-plugin-antigravity/logs'
        features:
          googleSearch: false
          imageOutput: true
          mediaOutputDir: 'C:/path/to/dsh-plugin-antigravity/media'
```

**Source edits need a restart or a `?rev=` bump.** HMR does not reliably watch linked plugin
sources in this DSH build (verified: editing `src/*.mjs` did not reload the running plugin either
under the package-name or the file-URL mount), so a changed `index.mjs`/`src/*.mjs` is normally
picked up by a fresh process. To reload the **host** half without restarting DSH, bump the query
string of a versioned file-URL mount — e.g. change
`name: 'file:///C:/lab/antigravity/plugin/index.mjs?rev=1793902881797'` to a new `rev` value; DSH
re-imports the module and re-registers the adapter live (verified twice in the running app). The
client half is a separate bundle and needs a page refresh. Patch and config edits — the managed
block, or the `features.*` toggles from the settings page — always apply live.

Nothing else needs configuring: the models appear in the picker as the **Antigravity** group as
soon as the adapter registers. Pick one and chat.

### Uninstall

Delete the managed block (it is fenced with
`# >>> dsh-plugin-antigravity … # <<< dsh-plugin-antigravity`) from
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`, or restore the `.bak-*` file the tool leaves
next to it.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | mount the adapter at all |
| `credentialTarget` | `gemini:antigravity` | OS credential-store entry: Windows Credential Manager, macOS Keychain, Linux libsecret |
| `languageServerPath` | platform default (`…/Antigravity/resources/bin/language_server[.exe]`) | where the OAuth client pair is scanned from |
| `clientId` / `clientSecret` | — | override the scanned OAuth client |
| `upstreamHost` | `https://daily-cloudcode-pa.googleapis.com` | Antigravity API base |
| `userAgent` | `antigravity/2.29.0` | must contain `antigravity`; the endpoint answers `403 #3501` otherwise |
| `requestTimeoutMs` | `300000` | discovery RPC timeout (a generation stream has no deadline) |
| `modelCacheTtlMs` | `600000` | model catalogue cache in ms; `0` disables the cache (every catalogue read hits the endpoint) |
| `maxConcurrentRequests` | `2` | in-flight Antigravity requests; model calls and tool sub-calls share the pool |
| `minRequestIntervalMs` | `500` | minimum gap between two request starts, in ms; `0` disables spacing |
| `rateLimitCooldownMs` | `60000` | pause every request for up to this long after a `429`/`QUOTA` answer |
| `debugDir` | — | appends adapter events to `antigravity-adapter.log` (no secrets) |
| `features.googleSearch` | `false` | add `tools:[{googleSearch:{}}]` when a request carries no tools |
| `features.googleSearchTool` | `true` | register the built-in `google_search` agent tool |
| `features.searchModel` | `gemini-3.5-flash-lite` | model used for the grounded search sub-request |
| `features.includeThoughts` | — | accepted by the endpoint but ignored (thoughts always stream) |
| `features.defaultThinkingLevel` | — | `low`/`medium`/`high` used when the caller names no effort |
| `features.thinkingBudgets` | `{low:1024, medium:4096, high:16384}` | token budgets for Gemini 2.5 models |
| `features.responseMimeType` / `features.responseSchema` | — | structured output (Gemini only) |
| `features.imageOutput` | `true` | allow image models |
| `features.imageGen` | `true` | register the built-in `image_generate` agent tool (generation and editing) |
| `features.imageModel` | account's `imageGenerationModelIds[0]` | override the image model used by the tool |
| `features.imageAspectRatio` | `1:1` | default aspect ratio for image models and the tool |
| `features.imageAspectRatios` | `['1:1','16:9','9:16','4:3','3:4']` | ratios the tool accepts |
| `features.imageMaxOutputTokens` | `4096` | output cap for one image generation |
| `features.imageMaxBytes` | 4 MiB | attachment projection budget for input images |
| `features.durableImages` | `true` | global switch for the durable attachment store; `false` forces `mediaOutputDir` for both the image model's chat-turn output and `image_generate` |
| `features.mediaOutputDir` | `%TEMP%/dsh-antigravity-media` | fallback directory for generated images (no attachment store, or `durableImages: false`) |
| `features.maxOutputTokensCap` | — | hard cap on `maxOutputTokens` |
| `features.safetySettings` | — | passed through as-is |

## How the model picker gets models

`listModels()` returns the account's live catalogue from `fetchAvailableModels` (chat models
plus image models, filtered of IDE completion routers `tab_*`, internal `chat_*` routers and
`*-tiered` routers). `resolveModel()` adds context window, default output cap, input modalities
and reasoning efforts. The harness builds the picker from exactly that, so a new model on the
account appears after the catalogue cache expires (or a restart).

## Request shaping and retries

The adapter spends the operator's personal Antigravity plan, and an agent loop can produce
bursts no human IDE session would. Three top-level keys keep the traffic shaped like normal app
use, which lowers the risk of the account being flagged for abuse:

| Key | Default | Effect |
|---|---|---|
| `maxConcurrentRequests` | `2` | at most two Antigravity requests in flight; the rest queue (the queue is visible in the settings GUI) |
| `minRequestIntervalMs` | `500` | minimum gap between two request starts in ms; this is what makes a local loop look like an IDE session. Set `0` only for deliberate speed tests |
| `rateLimitCooldownMs` | `60000` | a `429`/`QUOTA` answer pauses *all* requests; the pause honours the server's `Retry-After`/`retryDelay` but never exceeds this cap |

One limiter instance is shared by model calls, `image_generate` and `google_search`, so a burst
of parallel agent steps cannot become a burst of upstream requests.

Retries are split on purpose:

- **Model calls** carry no retry loop inside the adapter — `dsh-llm-retry` already repeats the
  harness step, and retrying here as well would only double the delay and the quota cost.
- **Tool sub-calls** (`image_generate`, `google_search`) sit outside that harness layer, so they
  keep two internal retries for transient `429`/`503` answers.

Keep the defaults unless you know why you are changing them. The quota is per account and shared
with the IDE, and parallel bursts are exactly the pattern that looks like abuse.

## Troubleshooting

| Symptom | Cause |
|---|---|
| No Antigravity group in the picker | plugin not mounted (check the managed block, DSH logs) or credentials unavailable |
| `AUTH` / 401 | refresh token revoked — sign in to Antigravity again |
| `QUOTA` (HTTP 429, "exhausted your capacity … will reset after 4h") | the Antigravity account quota for that model; the reset time is in the message |
| `RATE_LIMIT` | transient throttling; DSH retry policy repeats the step, and the throttle pauses further requests for `rateLimitCooldownMs` |
| Requests feel slow while several agents run | that is the throttle queue (`maxConcurrentRequests`, `minRequestIntervalMs`) — visible in the settings GUI |
| `google_search` is not offered to the agent | `features.googleSearchTool` is `false` (toggle it in the settings GUI or the patch) |
| `google_search` answers without sources | the model answered from its own grounding-free knowledge; rephrase the query or check `features.searchModel` |
| `EMPTY_RESPONSE` with a message about the image | image model refused the prompt (or RECITATION) — rephrase |
| `INVALID_REQUEST` mentioning `reference_path` | the reference file is missing, is not a `.png`/`.jpg`/`.jpeg`/`.webp`, or is larger than 20 MiB |
| `403 … (#3501) You do not have a valid license` | `userAgent` lost the `antigravity` substring |
| `DUPLICATE_ADAPTER` | a stale `antigravity` provider route is still in the `llm-pi-ai` block — remove it |
| Model missing after an account change | wait for `modelCacheTtlMs` or restart DSH |
| No models and the log says `credential not found in security…` (macOS) | the Keychain entry `gemini:antigravity` is unreadable from the DSH process — sign in to Antigravity again, unlock the login keychain, re-check with `security find-generic-password -s gemini:antigravity -w` |
| No models and the log says `secret-tool is not available` (Linux) | install libsecret tools (`secret-tool`), then check `secret-tool lookup service gemini:antigravity`; the non-Windows credential paths are best-effort |
| Generated images land in `mediaOutputDir` instead of the attachment store | no attachment store in the composition, the store refused the image, or `features.durableImages: false`; the log records the fallback |
| The settings page stays in English | the composition has no client locale service — the page falls back to English by design |
| Edited plugin sources are not picked up | HMR does not reliably watch linked sources in this DSH build; restart DSH, or bump the `?rev=` query of the versioned file-URL mount (Install) to force a host-side re-import |

## Built-in image generation (imageGen)

The plugin registers an `image_generate` tool, so **any** model in the agent — Gemini, Claude,
GPT-OSS — can draw during a normal conversation, the way the Antigravity IDE's own agent does.
The tool calls the same built-in image model the IDE uses (`imageGenerationModelIds`, i.e.
`gemini-3.1-flash-image`) with `responseModalities: ["TEXT","IMAGE"]` + `imageConfig`, saves the
image and returns a markdown image reference, which the chat UI renders (absolute paths are
allowed by the harness file route).

**Where the file goes.** When the composition provides the harness attachment store, a generated
image is committed to it as a content-addressed attachment (under the DSH home, e.g.
`~/.dsh/attachments/v1/objects/…`) and the markdown link points at the store's durable host path,
so the image survives the media directory being cleaned; `image_generate` also returns the
`attachment_id`. If the composition has no store, the store refuses the image, or
`features.durableImages: false`, the plugin writes a plain file into `features.mediaOutputDir`
instead (and the adapter log records why). The flag is a single switch for both the image model's
chat-turn output and the `image_generate` tool. Either way the image is linked as markdown — by
the tool result or by the assistant message.

```
user: "нарисуй красный круг на белом фоне"
model → image_generate {prompt, aspect_ratio}
      → gemini-3.1-flash-image (built-in imageGen)
      → C:\Users\<you>\.dsh\attachments\v1\objects\…  +  ![…](C:/Users/<you>/.dsh/attachments/v1/objects/…)
```

Parameters: `prompt` (required), `aspect_ratio` (enum of the configured ratios), `count`
(1–4; the endpoint rejects `candidateCount > 1`, so extra images are sequential calls) and
`reference_path` — an existing `.png`, `.jpg`/`.jpeg` or `.webp` file (≤ 20 MiB) to **edit**
instead of drawing from scratch. The reference image is sent as `inlineData` before the prompt:

```
user: "сделай небо на этом фото закатным"
model → image_generate {prompt: "a sunset sky …", reference_path: "C:/lab/antigravity/media/in.png"}
      → gemini-3.1-flash-image (image-to-image)
      → C:\Users\<you>\.dsh\attachments\v1\objects\…  +  ![…](C:/Users/<you>/.dsh/attachments/v1/objects/…)
```

A refused generation comes back as HTTP 200 + empty content + `finishMessage`; the tool reports
it as an error instead of a blank success. The tool always calls the built-in imageGen model, so
it works even when the conversation itself runs on a text-only model.

## Built-in web search (google_search)

Grounding cannot ride along with a normal agent turn: the endpoint rejects
`tools:[{googleSearch:{}}]` together with `functionDeclarations` (HTTP 400 — and the
`includeServerSideToolInvocations` flag does not lift that), while every agent turn carries the
harness tools. The plugin therefore registers a **separate** `google_search` tool that issues its
own grounded generation with **no** function declarations:

```
user: "what changed in the latest Node.js release?"
model → google_search {query: "Node.js latest release notes"}
      → gemini-3.5-flash-lite with tools:[{googleSearch:{}}] (no function declarations)
      → answer + a markdown "Sources:" list
```

- Registered by default; `features.googleSearchTool: false` removes it. The separate
  `features.googleSearch` switch is the adapter-side "ground tool-free turns directly" flag.
- Model: `features.searchModel`, default `gemini-3.5-flash-lite`.
- Returns `{answer, sources[]}`; the tool result appends `[n] title — uri` lines as markdown, so
  sources stay readable even though the chat UI does not render citation annotations.
- The `uri` values are Google grounding redirect URLs (`vertexaisearch.cloud.google.com`), not
  the publisher's own links; `docs/capabilities.md` records what the endpoint actually returns.
- Sources are whatever the endpoint returned for that query: an answer the model can give from
  its own knowledge may come back without `groundingMetadata`, and the tool result says so.
- One query, one answer — not a research loop. Multi-step research means the agent calls the
  tool several times; each call costs quota on the search model and has a 120 s timeout.
- Only Gemini models ground on this endpoint (Claude/GPT-OSS silently ignore the server tool),
  so keep a Gemini `features.searchModel`.

## Settings GUI

The plugin ships a Client half: **Settings → Antigravity** in the DSH Web UI. The header shows
the plugin version (`Antigravity v0.6.0`).

The whole page is localized through the DSH client locale service under the `antigravity`
namespace: complete **en / zh / ru** dictionaries (72 keys each) with `{placeholder}`
interpolation. The language follows the DSH language (**Settings → General → Language**) and the
page re-translates live on a switch; a composition without the locale service falls back to
English. Technical values stay untranslated on purpose — model ids and names, tool names, paths,
`HTTP <status>`, and the `k ctx` / `k out` / `ImageGen` markers.

The page shows

- account tier, tier name and cloud project (`loadCodeAssist`);
- **per-model limits** from `retrieveUserQuota`: remaining fraction with a bar (green/amber/red)
  and the quota reset time;
- the live model catalogue: context window, output cap, input modalities, `thinking` /
  `recommended` badges, and the imageGen model;
- the effective plugin configuration (the `features.*` flags) with a note on where to edit them.
  `googleSearchTool`, `googleSearch`, `imageGen`, `durableImages`, `imageOutput`,
  `includeThoughts`, `defaultThinkingLevel` and `imageAspectRatio` are editable from the page and
  apply live; paths, models and credentials still live in `cordis.patch.yml`;
- the **service** card (titled «Служебное» in Russian, "Service" in English): plugin version, the
  registered agent tools (`image_generate`, `google_search`), the effective throttle limits, the
  live throttle state (`active` / `queued`, and the cooldown deadline after a 429) and the last
  adapter error with its code and timestamp;
- **refresh** (forces a fresh quota read), a **one-click imageGen smoke test**, and a **one-click
  grounded-search smoke test** (titled «Проверка google_search» in Russian: query, answer, the
  queries Google ran, clickable sources). The imageGen card shows the saved path and an inline
  preview (`previewUrl`): the media route serves both files under `features.mediaOutputDir` and
  durable attachment objects by absolute path, sniffing the content type from magic bytes
  (durable objects have no extension). Only those two roots are served; everything else is 404.

The page is served by the plugin itself over the harness web server, same-origin:

| Route | Purpose |
|---|---|
| `GET /antigravity/status[?refresh=1]` | account, quotas, catalogue, effective config and plugin runtime (`version`, `tools`, `throttle`, `lastError`, `limits`) (60 s cache) |
| `POST /antigravity/config` | edits the editable `features.*` flags through the harness config editor (applies live) |
| `POST /antigravity/test-image` | `{prompt, aspect_ratio}` → saved image path (durable when available) + markdown |
| `POST /antigravity/test-search` | `{query}` → `{ok, query, answer, sources[], queries[]}`; 501 when the composition has no search wiring |
| `GET /antigravity/media/<name>` | serves an image from `features.mediaOutputDir` for the inline preview |
| `GET /antigravity/media/?path=<abs>` | serves an image by absolute path when it is under `mediaOutputDir` or the durable attachment store (content type sniffed; anything else 404) |

The Client module is a standard `dsh.client` bundle (`plugin/client.js`): it registers a
`settings.section` entry through `ctx.slots`, registers the `antigravity` locale namespace through
`ctx.locale` when the composition mounts that service, and reads the host API with `fetch`. Only
the plugin's own `/antigravity/*` routes are reachable from the page; the API binds to the harness
web server on `127.0.0.1` and is not exposed elsewhere.

## Development

```powershell
cd plugin
node test/unit.mjs          # offline: 43 checks, no network, no Antigravity
node test/live.mjs          # live default: 16 checks against the real API (spends the account quota)
$env:AG_MATRIX_TEST = '1'; node test/live.mjs                          # + model matrix: 25 checks
$env:AG_IMAGE_TEST = '1'; node test/live.mjs                           # + image generation/editing
$env:AG_IMAGE_TEST = '1'; $env:AG_MATRIX_TEST = '1'; node test/live.mjs  # everything: 26 checks (+1 skip)
```

On bash the same switches are spelled `AG_MATRIX_TEST=1 node test/live.mjs`. Checks that are not
enabled, that this account cannot run (model not advertised, image quota wall) or that were not
reached (no 429 encountered) print `SKIP …` and are not counted, so a different account — or a
run after the account's 4-hour image quota is spent — can report a slightly smaller total. That is
expected: the image checks skip on a quota wall instead of failing.

The default run is the cheap smoke suite: catalogue/metadata, text, reasoning, tool calling and
replay, structured output, grounding, both agent tools, throttle/status config and error
classification. The matrix adds one turn per vendor and thinking tier (including the Gemini 2.5
token-budget style), a `groundedSearch` probe, a throttle-serialization probe and one image edit
through `reference_path`. The image gate adds image generation and the image model through the
adapter; the reference-image edit runs under either gate. The offline suite covers chunk
translation, error classification, throttle semantics, grounded-search parsing, the image
reference request, durable-attachment persistence with its media-directory fallback, the
cross-platform credential helpers, and the GUI routes/status payload.

`tools/apply-profile.mjs` rebuilds and validates the profile patch; `tools/catalogue.mjs`
prints the raw account catalogue as JSON.

`docs/` holds the reverse-engineering notes this implementation is based on (in Russian):
[`docs/api.md`](docs/api.md) — Antigravity endpoint, auth, SSE, tools, quotas;
[`docs/capabilities.md`](docs/capabilities.md) — the live feature matrix with exact
request/response shapes; [`docs/dsh-integration.md`](docs/dsh-integration.md) and
[`docs/dsh-surface.md`](docs/dsh-surface.md) — the DSH provider/extension contracts and the
native adapter contract. `research/` is not published (local probe artifacts).

## Security notes

- The adapter sends the operator's own Antigravity access token directly to Google's endpoint.
  Tokens are read from the OS credential store (Windows Credential Manager, macOS Keychain or
  Linux libsecret) and never printed or written to disk by the plugin.
- It consumes the operator's own Antigravity plan limits, which are shared with the IDE.
- The throttle (`maxConcurrentRequests`, `minRequestIntervalMs`, `rateLimitCooldownMs`) and the
  absence of adapter-level model retries keep the request pattern close to what the IDE itself
  produces. That is the main lever against the account being flagged for abuse — do not disable
  it to make the agent faster.
- The `google_search` tool sends the agent's query to Google's grounding service, and the answer
  comes back with Google redirect URLs as sources; treat search queries as data leaving the box.
- Generated images are committed to the harness attachment store as content-addressed attachments
  under the DSH home (`~/.dsh/attachments` by default), and the tool output carries their
  `attachment_id`; treat that directory as private. `features.mediaOutputDir` is the fallback and
  `debugDir` writes adapter events; both are private as well, so delete them when not needed.
- Unofficial integration of a private API: it may break when Antigravity changes.

## License

MIT — see [LICENSE](LICENSE). Antigravity, Gemini and Google are trademarks of Google LLC;
Claude is a trademark of Anthropic.
