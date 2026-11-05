// language: JavaScript (ESM), file: src/antigravity.mjs, runtime: Node >= 20 (DSH host)
// Upstream client for Google Antigravity's "Cloud Code" private API.
//
// Credentials are NOT asked for: they are the ones the installed Antigravity app already holds.
//   1. Windows Credential Manager entry `gemini:antigravity` (JSON: {token:{access_token,refresh_token,expiry}})
//   2. OAuth client id/secret pair embedded in resources/bin/language_server.exe (scanned, not hardcoded)
// A 60-minute access token is minted from the refresh token at https://oauth2.googleapis.com/token.
//
// Wire protocol (verified live on the machine this was written for):
//   POST {host}/v1internal:loadCodeAssist         {} -> {cloudaicompanionProject, currentTier}
//   POST {host}/v1internal:fetchAvailableModels   {} -> {models: {<slug>: {...}}}
//   POST {host}/v1internal:retrieveUserQuota      {} -> {buckets: [...]}
//   POST {host}/v1internal:streamGenerateContent?alt=sse
//        body {model: <slug>, project: <projectId>, request: {contents, systemInstruction, tools, generationConfig}}
//        SSE events: data: {"response": {"candidates": [{"content": {"parts": [...]}, "finishReason": ...}],
//                                        "usageMetadata": {...}, "modelVersion": ...}}
// The User-Agent must contain "antigravity" or the server answers 403 (#3501).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const DEFAULT_API_HOST = 'https://daily-cloudcode-pa.googleapis.com';
export const DEFAULT_USER_AGENT = 'antigravity/2.29.0';
export const DEFAULT_CREDENTIAL_TARGET = 'gemini:antigravity';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REFRESH_SKEW_MS = 60_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function defaultLanguageServerPath() {
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Antigravity', 'resources', 'bin', 'language_server.exe');
  }
  if (process.platform === 'darwin') {
    return '/Applications/Antigravity.app/Contents/Resources/bin/language_server';
  }
  return '/opt/Antigravity/resources/bin/language_server';
}

/* ------------------------------------------------------------------ keyring */

// Add-Type + CredRead because there is no dependency-free way to read a
// GENERIC credential blob from Node on Windows.
const PS_CREDREAD = String.raw`
$src = @'
using System;
using System.Runtime.InteropServices;
public class AgCredRead {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type; public IntPtr TargetName; public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist;
    public UInt32 AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredReadW(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr buffer);
  public static byte[] Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) return null;
    CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
    byte[] b = new byte[c.CredentialBlobSize];
    Marshal.Copy(c.CredentialBlob, b, 0, (int)c.CredentialBlobSize);
    CredFree(p); return b;
  }
}
'@
Add-Type -TypeDefinition $src -ErrorAction Stop
$b = [AgCredRead]::Read('__TARGET__')
if ($null -eq $b) { exit 2 }
[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($b))
`;

/** Read and parse the Antigravity credential blob. Returns {token: {access_token, refresh_token, expiry}}. */
export function readKeyringCredential(target = DEFAULT_CREDENTIAL_TARGET) {
  if (process.platform !== 'win32') throw new Error('Credential Manager is only available on Windows');
  const script = PS_CREDREAD.replace('__TARGET__', String(target).replace(/'/g, "''"));
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', maxBuffer: 1 << 20, windowsHide: true, timeout: 30_000,
  });
  if (r.error) throw new Error('CredRead spawn failed: ' + r.error.message);
  if (r.status === 2) throw new Error('credential not found: ' + target);
  if (r.status !== 0) throw new Error('CredRead failed: ' + String(r.stderr || '').slice(0, 300));
  const text = String(r.stdout || '').trim();
  if (!text) throw new Error('empty credential blob for ' + target);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('credential blob is not JSON'); }
  return parsed.token ? parsed : { token: parsed };
}

/* ------------------------------------------------------- OAuth client pairs */

const RE_CLIENT_ID = /\d{10,}-[a-z0-9]{15,}\.apps\.googleusercontent\.com/g;
const RE_CLIENT_SECRET = /GOCSPX-[A-Za-z0-9_-]{28}/g;

function scanFileStrings(file, regexes, chunkSize = 4 << 20, overlap = 256) {
  const found = Object.fromEntries(Object.keys(regexes).map((k) => [k, new Set()]));
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(chunkSize);
    let carry = '';
    for (let pos = 0; pos < size; pos += chunkSize) {
      const n = fs.readSync(fd, buf, 0, chunkSize, pos);
      const text = carry + buf.toString('latin1', 0, n);
      for (const [k, re] of Object.entries(regexes)) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text))) found[k].add(m[0]);
      }
      carry = text.slice(-overlap);
    }
  } finally {
    fs.closeSync(fd);
  }
  return Object.fromEntries(Object.entries(found).map(([k, v]) => [k, [...v]]));
}

/**
 * Candidate OAuth (client_id, client_secret) pairs. Explicit config wins; otherwise the
 * installed language server binary is scanned once and the result memoised by the caller.
 */
export function discoverOAuthClients({ binary, clientId, clientSecret } = {}) {
  if (clientId && clientSecret) return [{ clientId, clientSecret }];
  const file = binary || defaultLanguageServerPath();
  if (!fs.existsSync(file)) throw new Error('Antigravity language server not found: ' + file);
  const got = scanFileStrings(file, { ids: RE_CLIENT_ID, secs: RE_CLIENT_SECRET });
  return got.ids.flatMap((id) => got.secs.map((secret) => ({ clientId: id, clientSecret: secret })));
}

async function refreshAccessToken({ refreshToken, clients, timeoutMs }) {
  let last = null;
  for (const client of clients) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
    let res;
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(timeoutMs || 60_000),
      });
    } catch (err) {
      last = 'network: ' + err.message;
      continue;
    }
    const json = await res.json().catch(() => ({}));
    if (res.status === 200 && json.access_token) {
      return {
        accessToken: json.access_token,
        expiresAt: Date.now() + (Number(json.expires_in) || 3599) * 1000,
        client,
      };
    }
    last = res.status + ' ' + (json.error || '') + ' ' + String(json.error_description || '').slice(0, 120);
  }
  throw new Error('could not refresh the Antigravity access token (' + last + '); sign in again in Antigravity');
}

/**
 * Access-token source. Reads the keyring blob, reuses a live access token, and mints a new one
 * from the refresh token when it is missing or expired. `invalidate()` forces a refresh after a 401.
 */
export function createTokenSource(config = {}) {
  const log = config.log || (() => {});
  const target = config.credentialTarget || DEFAULT_CREDENTIAL_TARGET;
  const binary = config.languageServerPath || defaultLanguageServerPath();
  let cached = null; // { accessToken, expiresAt }
  let clients = null;
  let inflight = null;

  async function mint(force) {
    const cred = readKeyringCredential(target);
    const token = cred.token || {};
    const refreshToken = token.refresh_token;
    const expMs = token.expiry ? Date.parse(String(token.expiry).replace(/\.(\d{3})\d+/, '.$1')) : NaN;
    const valid = token.access_token && Number.isFinite(expMs) && expMs - Date.now() > REFRESH_SKEW_MS;
    if (valid && !force) {
      return { accessToken: token.access_token, expiresAt: expMs };
    }
    if (!refreshToken) throw new Error('Antigravity credential has no refresh_token; sign in again in Antigravity');
    if (!clients) {
      clients = discoverOAuthClients({ binary, clientId: config.clientId, clientSecret: config.clientSecret });
      if (clients.length === 0) throw new Error('no OAuth client pair found in ' + binary);
      log('found ' + clients.length + ' OAuth client candidate(s) in the Antigravity language server');
    }
    const minted = await refreshAccessToken({ refreshToken, clients, timeoutMs: config.timeoutMs });
    log('minted a new Antigravity access token (client ' + minted.client.clientId.slice(0, 12) + '…)');
    return { accessToken: minted.accessToken, expiresAt: minted.expiresAt };
  }

  return {
    /** @returns {Promise<string>} a live access token */
    async getToken() {
      if (cached && cached.expiresAt - Date.now() > REFRESH_SKEW_MS) return cached.accessToken;
      if (!inflight) {
        inflight = mint(false)
          .then((t) => { cached = t; return t.accessToken; })
          .finally(() => { inflight = null; });
      }
      return inflight;
    },
    invalidate() { cached = null; },
    state() {
      return { cached: Boolean(cached), expiresAt: cached ? new Date(cached.expiresAt).toISOString() : null,
        clientCandidates: clients ? clients.length : 0 };
    },
  };
}

/* ------------------------------------------------------------- API client */

export function createAntigravityClient(config = {}) {
  const host = (config.upstreamHost || DEFAULT_API_HOST).replace(/\/+$/, '');
  const userAgent = config.userAgent || DEFAULT_USER_AGENT;
  const timeoutMs = config.requestTimeoutMs || 300_000;
  const log = config.log || (() => {});
  const tokens = config.tokens || createTokenSource({ ...config, log });
  let projectId = config.project || null;
  let projectFetchedAt = 0;

  function headers(token) {
    return {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': userAgent, // required: "antigravity" in the UA, otherwise 403 #3501
      'X-Goog-Api-Client': 'gl-go/1.24.0',
      'X-Request-ID': crypto.randomUUID(),
    };
  }

  async function rawPost(pathSuffix, payload, { signal, noTimeout } = {}) {
    const token = await tokens.getToken();
    const doFetch = (tok) => fetch(host + pathSuffix, {
      method: 'POST',
      headers: headers(tok),
      body: JSON.stringify(payload ?? {}),
      signal: noTimeout ? signal : (signal || AbortSignal.timeout(timeoutMs)),
    });
    let res = await doFetch(token);
    if (res.status === 401) {
      // The cached token expired under us: mint a fresh one once and repeat.
      await res.body?.cancel().catch(() => {});
      tokens.invalidate();
      res = await doFetch(await tokens.getToken());
    }
    return res;
  }

  async function rpc(method, payload, opts) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await rawPost('/v1internal:' + method, payload, opts);
      const text = await res.text();
      if (res.status !== 200) {
        const err = new Error('antigravity ' + method + ' failed: HTTP ' + res.status + ' ' + text.slice(0, 400));
        err.status = res.status;
        err.body = text;
        if (attempt < 2 && isRetryableStatus(res.status, text)) {
          lastErr = err;
          await sleep(retryDelay(attempt));
          continue;
        }
        throw err;
      }
      try { return JSON.parse(text); } catch { throw new Error('antigravity ' + method + ': response is not JSON'); }
    }
    throw lastErr;
  }

  /** Retry only failures that are transient by construction (capacity, throttle). */
  function isRetryableStatus(status, body) {
    if (status === 503) return true;
    if (status === 429) return true;
    return /MODEL_CAPACITY_EXHAUSTED|RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(String(body || ''));
  }

  function retryDelay(attempt) {
    return attempt === 0 ? 1500 : 4000;
  }

  return {
    host,
    tokens,

    /** Cloud project id that bills the request. Best-effort: the API also accepts it omitted. */
    async getProject() {
      if (projectId && Date.now() - projectFetchedAt < 6 * 3600_000) return projectId;
      try {
        const json = await rpc('loadCodeAssist', { metadata: { pluginType: 'GEMINI' } });
        projectId = json.cloudaicompanionProject || json.project || projectId;
        projectFetchedAt = Date.now();
        if (!projectId) log('loadCodeAssist returned no project id; requests will omit it');
      } catch (err) {
        projectFetchedAt = Date.now();
        log('loadCodeAssist failed (' + err.message + '); requests will omit the project id');
      }
      return projectId || undefined;
    },

    /** Model catalogue for this account: {slug: {id, name, contextWindow, maxTokens, input, supportsImages, supportsThinking, provider}} */
    async fetchModels() {
      const json = await rpc('fetchAvailableModels', {});
      const out = {};
      for (const [slug, m] of Object.entries(json.models || {})) {
        if (!m || typeof m !== 'object') continue;
        out[slug] = {
          id: slug,
          name: m.displayName || slug,
          contextWindow: Number(m.maxTokens) || undefined,
          maxTokens: Number(m.maxOutputTokens) || undefined,
          supportsImages: Boolean(m.supportsImages),
          supportsThinking: Boolean(m.supportsThinking),
          provider: String(m.modelProvider || '').replace(/^MODEL_PROVIDER_/, '') || undefined,
          wireModel: m.model || undefined,
          vertexModelId: m.vertexModelId || undefined,
          thinkingLevel: m.thinkingLevel,
          recommended: Boolean(m.recommended),
        };
      }
      return { models: out, defaultModelId: json.defaultAgentModelId || null };
    },

    async fetchQuota() {
      const json = await rpc('retrieveUserQuota', {});
      const buckets = Array.isArray(json.buckets) ? json.buckets : [];
      return Object.fromEntries(buckets.map((b) => [b.modelId, b.remainingFraction]));
    },

    /**
     * Start a streaming generation and return the raw fetch Response.
     * The caller parses SSE and owns cancellation.
     */
    async openStream({ model, request, signal }) {
      const project = await this.getProject();
      const payload = { model, request };
      if (project) payload.project = project;
      // No overall deadline: a long generation is normal. The gateway enforces stream idleness.
      for (let attempt = 0; ; attempt++) {
        const res = await rawPost('/v1internal:streamGenerateContent?alt=sse', payload,
          { signal, noTimeout: true });
        if (res.ok) return res;
        const text = await res.text().catch(() => '');
        const retryable = attempt < 2 && isRetryableStatus(res.status, text) && !signal?.aborted;
        if (!retryable) {
          const err = new Error('antigravity streamGenerateContent failed: HTTP ' + res.status + ' ' +
            text.slice(0, 400));
          err.status = res.status;
          err.body = text;
          throw err;
        }
        log('upstream HTTP ' + res.status + ' (' + text.slice(0, 120) + '); retrying in ' +
          retryDelay(attempt) + 'ms');
        await sleep(retryDelay(attempt));
      }
    },

    async dispose() { /* stateless: nothing to release */ },
  };
}

/* ------------------------------------------------------------ SSE parsing */

/**
 * Parse Antigravity's SSE body into generation events.
 * Yields {type:'text'|'thought'|'toolCall'|'finish'|'usage'|'meta'}.
 */
export async function* parseGenerationStream(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason = null;
  for await (const chunk of body) {
    // The server separates events with \r\n\r\n; normalise so a plain split works.
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue; // "event:"/"id:" lines do not occur here
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let event;
        try { event = JSON.parse(payload); } catch { continue; }
        const response = event.response || {};
        for (const candidate of response.candidates || []) {
          for (const part of (candidate.content && candidate.content.parts) || []) {
            if (part.functionCall) {
              yield { type: 'toolCall', call: part.functionCall, thoughtSignature: part.thoughtSignature };
            } else if (part.inlineData || part.fileData) {
              yield { type: 'media', part };
            } else if (typeof part.text === 'string') {
              yield {
                type: part.thought ? 'thought' : 'text',
                text: part.text,
                thoughtSignature: part.thoughtSignature,
              };
            }
          }
          if (candidate.finishReason) finishReason = candidate.finishReason;
        }
        if (response.usageMetadata) yield { type: 'usage', usage: response.usageMetadata };
        if (response.modelVersion) yield { type: 'meta', modelName: response.modelVersion, responseId: response.responseId };
      }
    }
  }
  if (finishReason) yield { type: 'finish', reason: finishReason };
}
