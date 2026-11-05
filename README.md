# dsh-plugin-antigravity

Google **Antigravity** models in [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) —
as a **native LLM adapter**, not a local HTTP proxy. The plugin registers itself with the
harness `llm` service (`ctx.llm.registerAdapter`), streams the harness `StreamChunk` protocol
directly, and gets retry policy, cancellation, usage accounting and the model picker from the
harness itself. There is no gateway process, no `llm-pi-ai` route and no OpenAI wire format in
the middle.

No API key and no extra login: credentials are reused from the installed Antigravity app
(Windows Credential Manager entry `gemini:antigravity`; the OAuth client id/secret are scanned
from `resources/bin/language_server.exe` at runtime).

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

## Status

Verified live on Windows 11 against a real Antigravity installation and DSH 0.2.1-rc.5:

| Check | Result |
|---|---|
| Offline unit checks (translation, chunk protocol, metadata, errors) | **18/18** |
| Live adapter checks against the real API | **10/10** (image generation proven; later runs hit the account's 4-hour image quota) |
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
| Tool calling (`functionDeclarations`) incl. parallel calls | works |
| `thoughtSignature` replay for tool calls (Gemini rejects history without it) | works, encoded in the harness tool-call id |
| Reasoning stream → harness `reasoning-delta` (the "Thinking" block) | works |
| Reasoning effort `low/medium/high` → `thinkingLevel` (Gemini 3.x) or `thinkingBudget` (2.5) | works |
| Image input (harness attachments) | works |
| Image generation and image editing (`gemini-3.1-flash-image`) | works; image is saved and linked as markdown |
| Structured output (`responseSchema`) | works for Gemini models (Claude/GPT-OSS reject it) |
| Google Search grounding with sources | works **only on turns that pass no tools** (endpoint limitation) |
| Usage incl. cached tokens | works |
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

- Windows with Antigravity installed and signed in.
- Node.js ≥ 20 (the adapter runs inside the DSH host process).
- DSH with `@deepseek-ai/dsh-llm` (tested on 0.2.1-rc.5).

## Install

The plugin is mounted by absolute path; no package install and no pnpm run in the profile:

```powershell
node tools/apply-profile.mjs            # dry run: builds and validates the patch
node tools/apply-profile.mjs --apply    # backup + write $DSH_HOME/profiles/<profile>/cordis.patch.yml
```

The tool inserts one managed block:

```yaml
- insert:
    - id: antigravity-llm
      name: 'C:/path/to/dsh-plugin-antigravity/plugin/index.mjs'
      config:
        enabled: true
        debugDir: 'C:/path/to/dsh-plugin-antigravity/logs'
        features:
          googleSearch: false
          imageOutput: true
          mediaOutputDir: 'C:/path/to/dsh-plugin-antigravity/media'
```

`DSH_HOME`, `DSH_PROFILE` and `DSH_CLI` are honoured. The patch is validated with DSH's own
patcher under a scratch `DSH_HOME` before anything is written.

**Restart DSH once** after installing (or after editing the plugin sources): an absolute-path
plugin sits outside the harness HMR watch scope, so module changes are only picked up on a
fresh process. Install with `dsh plugin --profile <p> add 'link:<repo>/plugin'` instead if you
want live source reload while developing.

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
| `credentialTarget` | `gemini:antigravity` | Windows Credential Manager entry |
| `languageServerPath` | `<Antigravity>/resources/bin/language_server.exe` | where the OAuth client pair is scanned from |
| `clientId` / `clientSecret` | — | override the scanned OAuth client |
| `upstreamHost` | `https://daily-cloudcode-pa.googleapis.com` | Antigravity API base |
| `userAgent` | `antigravity/2.29.0` | must contain `antigravity`; the endpoint answers `403 #3501` otherwise |
| `requestTimeoutMs` | `300000` | discovery RPC timeout (a generation stream has no deadline) |
| `modelCacheTtlMs` | `600000` | model catalogue cache |
| `debugDir` | — | appends adapter events to `antigravity-adapter.log` (no secrets) |
| `features.googleSearch` | `false` | add `tools:[{googleSearch:{}}]` when a request carries no tools |
| `features.includeThoughts` | — | accepted by the endpoint but ignored (thoughts always stream) |
| `features.defaultThinkingLevel` | — | `low`/`medium`/`high` used when the caller names no effort |
| `features.thinkingBudgets` | `{low:1024, medium:4096, high:16384}` | token budgets for Gemini 2.5 models |
| `features.responseMimeType` / `features.responseSchema` | — | structured output (Gemini only) |
| `features.imageOutput` | `true` | allow image models |
| `features.imageGen` | `true` | register the built-in `image_generate` agent tool |
| `features.imageModel` | account's `imageGenerationModelIds[0]` | override the image model used by the tool |
| `features.imageAspectRatio` | `1:1` | default aspect ratio for image models and the tool |
| `features.imageAspectRatios` | `['1:1','16:9','9:16','4:3','3:4']` | ratios the tool accepts |
| `features.imageMaxOutputTokens` | `4096` | output cap for one image generation |
| `features.imageMaxBytes` | 4 MiB | attachment projection budget for input images |
| `features.mediaOutputDir` | `%TEMP%/dsh-antigravity-media` | where generated images are written |
| `features.maxOutputTokensCap` | — | hard cap on `maxOutputTokens` |
| `features.safetySettings` | — | passed through as-is |

## How the model picker gets models

`listModels()` returns the account's live catalogue from `fetchAvailableModels` (chat models
plus image models, filtered of IDE completion routers `tab_*`, internal `chat_*` routers and
`*-tiered` routers). `resolveModel()` adds context window, default output cap, input modalities
and reasoning efforts. The harness builds the picker from exactly that, so a new model on the
account appears after the catalogue cache expires (or a restart).

## Troubleshooting

| Symptom | Cause |
|---|---|
| No Antigravity group in the picker | plugin not mounted (check the managed block, DSH logs) or credentials unavailable |
| `AUTH` / 401 | refresh token revoked — sign in to Antigravity again |
| `QUOTA` (HTTP 429, "exhausted your capacity … will reset after 4h") | the Antigravity account quota for that model; the reset time is in the message |
| `RATE_LIMIT` | transient throttling; DSH retry policy repeats the step |
| `EMPTY_RESPONSE` with a message about the image | image model refused the prompt (or RECITATION) — rephrase |
| `403 … (#3501) You do not have a valid license` | `userAgent` lost the `antigravity` substring |
| `DUPLICATE_ADAPTER` | a stale `antigravity` provider route is still in the `llm-pi-ai` block — remove it |
| Model missing after an account change | wait for `modelCacheTtlMs` or restart DSH |

## Built-in image generation (imageGen)

The plugin registers an `image_generate` tool, so **any** model in the agent — Gemini, Claude,
GPT-OSS — can draw during a normal conversation, the way the Antigravity IDE's own agent does.
The tool calls the same built-in image model the IDE uses (`imageGenerationModelIds`, i.e.
`gemini-3.1-flash-image`) with `responseModalities: ["TEXT","IMAGE"]` + `imageConfig`, saves the
JPEG under `features.mediaOutputDir` and returns a markdown image reference, which the chat UI
renders (absolute paths are allowed by the harness file route).

```
user: "нарисуй красный круг на белом фоне"
model → image_generate {prompt, aspect_ratio}
      → gemini-3.1-flash-image (built-in imageGen)
      → C:\lab\antigravity\media\ag-….jpeg  +  ![…](C:/lab/antigravity/media/ag-….jpeg)
```

Parameters: `prompt` (required), `aspect_ratio` (enum of the configured ratios), `count`
(1–4; the endpoint rejects `candidateCount > 1`, so extra images are sequential calls).
A refused generation comes back as HTTP 200 + empty content + `finishMessage`; the tool reports
it as an error instead of a blank success. Image *editing* is available by attaching an image
and choosing the image model directly in the picker (the tool is text-to-image).

## Development

```powershell
cd plugin
node test/unit.mjs     # offline: 21 checks, no network, no Antigravity
node test/live.mjs     # live: 10 checks against the real API (spends the account quota)
AG_IMAGE_TEST=1 node test/live.mjs   # additionally exercises the imageGen generator
```

`tools/apply-profile.mjs` rebuilds and validates the profile patch; `tools/catalogue.mjs`
prints the raw account catalogue as JSON.

`docs/` holds the reverse-engineering notes this implementation is based on (in Russian):
[`docs/api.md`](docs/api.md) — Antigravity endpoint, auth, SSE, tools, quotas;
[`docs/capabilities.md`](docs/capabilities.md) — the live feature matrix with exact
request/response shapes; [`docs/dsh-integration.md`](docs/dsh-integration.md) and
[`docs/dsh-surface.md`](docs/dsh-surface.md) — the DSH provider/extension contracts and the
native adapter contract. `research/` is not published (local probe artifacts).

## Security notes

- The adapter sends the operator's own Antigravity access token directly to Google's endpoint;
  it never prints or persists tokens.
- It consumes the operator's own Antigravity plan limits, which are shared with the IDE.
- `features.mediaOutputDir` and `debugDir` write generated images and adapter events to disk;
  treat `media/` as private and delete when not needed.
- Unofficial integration of a private API: it may break when Antigravity changes.

## License

MIT — see [LICENSE](LICENSE). Antigravity, Gemini and Google are trademarks of Google LLC;
Claude is a trademark of Anthropic.
