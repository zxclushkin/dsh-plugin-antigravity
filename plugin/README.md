# dsh-plugin-antigravity

Local OpenAI-compatible gateway that exposes the models of an installed Google **Antigravity**
app to [DeepSeek Harness](https://github.com/deepseek-ai) (DSH). DSH reaches it as an ordinary
`llm-pi-ai` route with `api: openai-completions`; nothing inside DSH is patched.

Full documentation, install steps and troubleshooting: **[../README.md](../README.md)**.

```
DSH ──OpenAI SSE──► 127.0.0.1:8732 ──Gemini JSON──► daily-cloudcode-pa.googleapis.com
```

No key is requested: credentials come from the Antigravity installation itself (Windows
Credential Manager target `gemini:antigravity`; the OAuth client pair is scanned from
`resources/bin/language_server.exe`).

## Plugin contract

`index.mjs` exports what the Cordis loader expects:

```js
export const name = 'antigravity-gateway'
export const inject = []
export const Config = { '~standard': { version: 1, vendor: 'antigravity', validate(value) { /* … */ } } }
export async function apply(ctx, config) {
  const proxy = createAntigravityProxy({ ...config, log })
  const address = await proxy.listen(config.port, config.host)
  return async () => { await proxy.close() }   // returned disposer is owned by the fiber
}
```

Config keys: `enabled`, `host`, `port`, `upstreamHost`, `userAgent`, `project`,
`requestTimeoutMs`, `streamIdleTimeoutMs`, `debugDir`, `modelCacheTtlMs`, `credentialTarget`,
`languageServerPath`, `clientId`, `clientSecret`, `maxOutputTokensCap`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness, token state, catalogue size |
| GET | `/v1/models` | chat model catalogue (OpenAI envelope) |
| GET | `/v1/quota` | remaining quota per model |
| POST | `/v1/chat/completions` | chat, streaming and non-streaming |

## Tests

```powershell
node test/unit.mjs     # offline, 17 checks
node test/gateway.mjs  # live, 8 checks, needs Antigravity installed and signed in
```

## License

MIT.
