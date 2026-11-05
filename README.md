# dsh-plugin-antigravity

Google **Antigravity** models in [DeepSeek Harness](https://github.com/deepseek-ai) (DSH):
a localhost OpenAI-compatible gateway that puts the models of an installed Antigravity app
(Gemini 3.x/2.5, Claude Opus/Sonnet 5.5, GPT-OSS) into DSH's model picker.

No API key, no login, no copying of tokens: the gateway reuses the credentials the Antigravity
app already holds and mints its own access tokens.

```
DSH (llm-pi-ai, api: openai-completions)
        │  POST http://127.0.0.1:8732/v1/chat/completions   (OpenAI SSE)
        ▼
dsh-plugin-antigravity  ──►  POST https://daily-cloudcode-pa.googleapis.com
        │                      /v1internal:streamGenerateContent?alt=sse
        │  Bearer <antigravity access token>            (Gemini-shaped JSON)
        ▼
   Antigravity models: Gemini 3.8/3.5/3/2.5, Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B
```

Unofficial client. Not affiliated with, endorsed by, or supported by Google or DeepSeek.

## Status

Verified live on Windows 11 against a real Antigravity installation (DSH 0.2.1-rc.5):

| Check | Result |
|---|---|
| Offline unit tests (translation, tool ids, plugin contract) | **17/17** |
| Gateway e2e against the real API, Gemini family | **8/8** |
| Gateway e2e against the real API, Claude family | **8/8** |
| DSH end-to-end (`dsh headless` replaying the patched profile) | model answer returned, tools called |
| Live gateway inside the DSH app | served an agent turn: 13 109 prompt tokens, `finish=stop` |
| Model picker | "Antigravity" group with 16 models |

## What gets translated

| OpenAI (DSH) | Antigravity / Gemini |
|---|---|
| `messages[].role: system` / `developer` | `systemInstruction.parts[].text` |
| `messages[].role: user` + `image_url` | `contents[].parts[{text}]` / `{inlineData}` |
| `messages[].role: assistant.tool_calls` | `parts[{functionCall:{name,args,id}}]` + `thoughtSignature` |
| `messages[].role: tool` | `parts[{functionResponse:{name,id,response}}]` |
| `tools[].function` (JSON Schema) | `tools[0].functionDeclarations` (Gemini schema: `OBJECT`, `STRING`, …) |
| `tool_choice` | `toolConfig.functionCallingConfig` |
| `max_tokens`, `temperature`, `top_p`, `stop` | `generationConfig.*` |
| `reasoning_effort` | `generationConfig.thinkingConfig.thinkingLevel` |
| `response_format: json_object` | `generationConfig.responseMimeType` |
| token accounting | `usageMetadata` → `usage` |

Gemini returns a `thoughtSignature` with every `functionCall` and rejects a replayed call that
lost it (`400 missing a thought_signature`); Claude requires the `id` in `functionResponse`
(`400 tool_result.tool_use_id: Field required`). Both survive the OpenAI protocol because the
signature is encoded inside the `tool_call.id` (`call_…_s.<base64url>`) and restored when the
history comes back.

## Requirements

- Windows with Antigravity installed and signed in (credential store format is Windows-only;
  macOS/Linux support would need a different credential source).
- Node.js ≥ 20 (the gateway runs inside the DSH host process).
- DeepSeek Harness with `@deepseek-ai/dsh-llm-pi-ai` — tested on 0.2.1-rc.5.

## Install

Two ways. Both end with the same two pieces of `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:
an `insert` row that mounts the gateway, and an `antigravity` provider inside the existing
`- id: llm-pi-ai` entry.

The patch layer **replaces** the `config` of `llm-pi-ai` wholesale, so the whole `providers`
block has to be carried over. `tools/apply-profile.mjs` does that for you, merges the live
model catalogue, and validates the result with DSH's own patcher under a scratch `DSH_HOME`:

```powershell
# dry run: builds and validates the candidate patch, writes nothing
node tools/apply-profile.mjs

# backup the profile patch and write it
node tools/apply-profile.mjs --apply
```

Restart DSH once if the dependency was installed with `dsh plugin add` (see option B); the
patch itself is picked up live by DSH's HMR.

### Option A — mount by absolute path (no install, no restart)

```yaml
- insert:
    - id: antigravity-gateway
      name: 'C:/path/to/dsh-plugin-antigravity/plugin/index.mjs'
      config:
        host: 127.0.0.1
        port: 8732
```

Point the `baseURL` of the route at the same port. This is what `apply-profile.mjs` generates.

### Option B — install as a package

```powershell
$DSH = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $DSH plugin --profile desktop add 'link:C:\path\to\dsh-plugin-antigravity\plugin'
```

Then use `name: dsh-plugin-antigravity` in the `insert` row and restart DeepSeek Harness (the
dependency change itself needs a restart; the patch does not).

### The route block

```yaml
      antigravity:
        displayName: Antigravity
        api: openai-completions
        # The local gateway ignores the key, but pi-ai still requires one to exist; a literal
        # Authorization header satisfies it without inventing a credential reference.
        headers:
          Authorization: 'Bearer dummy'
        baseURL: http://127.0.0.1:8732/v1
        timeoutMs: 300000
        streamIdleTimeoutMs: 300000
        models:
          - id: gemini-3-flash
            name: "Gemini 3 Flash"
            contextWindow: 1048576
            maxTokens: 65536
            input: [ text, image ]
```

Without `apiKeyEnv` **and** without an `Authorization` header, pi-ai refuses the route with
`No API key for provider`; with an unresolvable `apiKeyEnv` the model list silently comes back
empty.

## Models

The catalogue is dynamic: `POST v1internal:fetchAvailableModels` returns the models of the
account (20–24 entries, changing over time). Only chat models are exposed — `tab_*` (IDE
autocomplete), `chat_*` (400 INVALID_ARGUMENT), `*-image`, `*-tiered` are filtered out.
`gemini-2.5-pro` is excluded by default because it answers `503 MODEL_CAPACITY_EXHAUSTED` on
some accounts (`ANTIGRAVITY_EXCLUDE=id1,id2` overrides the exclusion list).

Refresh the list when the account catalogue changes:

```powershell
node tools/catalogue.mjs > research/catalogue.json
node tools/apply-profile.mjs --apply --from=path/to/pristine-cordis.patch.yml
```

Names in the picker are derived from the model id: Antigravity's own `displayName` is
unreliable (it reports `gemini-2.5-flash` as "Gemini 3.5 Flash Lite").

## Gateway HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness, token state, catalogue size |
| GET | `/v1/models` | catalogue in the OpenAI envelope |
| GET | `/v1/quota` | remaining quota per model (`retrieveUserQuota`) |
| POST | `/v1/chat/completions` | chat, streaming and non-streaming |

## Plugin configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | start the gateway at all |
| `host` / `port` | `127.0.0.1` / `8732` | bind address (must match the route `baseURL`) |
| `upstreamHost` | `https://daily-cloudcode-pa.googleapis.com` | Antigravity API |
| `userAgent` | `antigravity/2.29.0` | **must** contain `antigravity`, otherwise `403 #3501` |
| `project` | — | Cloud project id; taken from `loadCodeAssist` when omitted (it is optional upstream) |
| `requestTimeoutMs` | `300000` | discovery RPC timeout; does not cut a stream |
| `streamIdleTimeoutMs` | `300000` | SSE idle watchdog |
| `debugDir` | — | JSONL request/response dumps (**contains prompts**) |
| `modelCacheTtlMs` | `600000` | model catalogue cache |
| `credentialTarget` | `gemini:antigravity` | Credential Manager entry name |
| `languageServerPath` | `<Antigravity>/resources/bin/language_server.exe` | where the OAuth client id/secret are scanned from |
| `clientId` / `clientSecret` | — | override the scanned OAuth client |
| `maxOutputTokensCap` | `0` (no cap) | hard ceiling for `maxOutputTokens` |

## How authentication works

1. The refresh token sits in the Windows Credential Manager entry `gemini:antigravity`
   (`CredRead`, JSON with `token.access_token` / `token.refresh_token` / `token.expiry`).
2. The OAuth `client_id` / `client_secret` pair is not hardcoded: it is scanned out of
   `resources/bin/language_server.exe` once and mixed with the refresh token at
   `https://oauth2.googleapis.com/token` (`grant_type=refresh_token`).
3. The resulting access token lives ~60 minutes and is renewed on expiry or on a `401`.
   Google does not rotate this refresh token.
4. Every request carries `User-Agent: antigravity/…` — without the word `antigravity` the API
   answers `403 … (#3501) You do not have a valid license`.

`~/.gemini/oauth_creds.json` is the Gemini CLI's own client and is useless here (403
`ACCESS_TOKEN_SCOPE_INSUFFICIENT`).

## Troubleshooting

| Symptom | Cause |
|---|---|
| `403 … (#3501) You do not have a valid license` | `User-Agent` lost the `antigravity` substring |
| `401` keeps repeating | refresh token revoked — sign in to Antigravity again |
| `No API key for provider: antigravity` | route has neither `apiKeyEnv` nor an `Authorization` header |
| provider present, model list empty | unresolvable `apiKeyEnv`, or the gateway does not answer `GET {baseURL}/models` |
| `503 MODEL_CAPACITY_EXHAUSTED` | model overloaded; the gateway retries twice (1.5 s, 4 s) |
| `429 QUOTA_EXHAUSTED` | daily quota of the Antigravity account |
| empty answer with `finish_reason=length` | `max_tokens` too small for a thinking model (keep ≥ 1024) |
| gateway not healthy on `/health` | entry did not activate — check that `name` points at `plugin/index.mjs` |

## Development

```powershell
cd plugin
node test/unit.mjs     # offline: 18 checks, no network, no Antigravity
node test/gateway.mjs  # live: 8 checks against the real API (spends account quota)
```

With the absolute-path mount (option A) the plugin module sits outside the profile, which is
outside DSH's HMR watch scope: **editing plugin sources needs a restart** (disabling and
re-enabling the row does not bust Node's ESM cache). Install with the `link:` route (option B)
when iterating — DSH then reloads linked targets live.

`docs/` holds the reverse-engineering notes this implementation is based on (in Russian):
[`docs/api.md`](docs/api.md) for the Antigravity side (endpoint, auth, SSE, tools, quotas) and
[`docs/dsh-integration.md`](docs/dsh-integration.md) for the DSH side (how a provider and its
models are registered). `research/` is not published — it contains local probe artifacts.

## Security notes

- The gateway binds `127.0.0.1` and **does not authenticate local callers**: any process on
  the machine can spend the operator's Antigravity quota through it. Do not expose the port.
- It uses the operator's existing Google session and the Antigravity plan limits. This is an
  unofficial integration of a private API; it may break when Antigravity updates.
- `debugDir` writes complete request and response bodies, including prompts. Treat those files
  as private and delete them after debugging.
- Access and refresh tokens are never printed or persisted by the plugin; `/health` reports only
  whether a token is cached and when it expires.

## License

MIT — see [LICENSE](LICENSE). Antigravity, Gemini and Google are trademarks of Google LLC;
Claude is a trademark of Anthropic.
