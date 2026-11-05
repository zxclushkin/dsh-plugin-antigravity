// language: JavaScript (ESM), file: src/server.mjs, runtime: Node >= 20 (DSH host)
// Local OpenAI-compatible gateway in front of Antigravity's v1internal API.
// The harness treats it as an ordinary `openai-completions` route, so nothing in DSH
// has to know how Antigravity works.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAntigravityClient, createTokenSource, parseGenerationStream } from './antigravity.mjs';
import {
  buildUpstreamRequest, decodeToolCallId, finishReasonToOpenAi, makeToolCallId,
  openAiChunk, openAiCompletion, openAiModelList, openAiUsage,
} from './openai.mjs';

export const DEFAULT_PROXY_PORT = 8732;

// Models that answer but are not usable as chat models: IDE tab completions, image
// generation, and Antigravity's internal "tiered" routers (they return empty text).
const NOT_A_CHAT_MODEL = /^(tab_|chat_)|-image$|-tiered$/i;

export function isChatModel(id) {
  return typeof id === 'string' && id.length > 0 && !NOT_A_CHAT_MODEL.test(id);
}

export function createAntigravityProxy(config = {}) {
  const log = config.log || ((msg) => console.error('[antigravity] ' + msg));
  const host = config.host || '127.0.0.1';
  const port = Number.isInteger(config.port) ? config.port : DEFAULT_PROXY_PORT;
  const debugDir = config.debugDir || process.env.ANTIGRAVITY_DEBUG_DIR;
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs || 300_000;
  const modelCacheTtlMs = config.modelCacheTtlMs || 600_000;

  const tokens = createTokenSource({ ...config, log });
  const client = createAntigravityClient({ ...config, log, tokens });

  const sessionId = crypto.randomUUID();
  let modelCache = null; // { at, models, defaultModelId }
  let modelRequest = null;

  function dump(label, value) {
    if (!debugDir) return;
    try {
      fs.mkdirSync(debugDir, { recursive: true });
      const file = path.join(debugDir, 'antigravity-' + process.pid + '.jsonl');
      fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), label, value }) + '\n');
    } catch { /* diagnostics must never break a request */ }
  }

  async function catalogue({ force = false } = {}) {
    if (!force && modelCache && Date.now() - modelCache.at < modelCacheTtlMs) return modelCache;
    if (!modelRequest) {
      modelRequest = client.fetchModels()
        .then(({ models, defaultModelId }) => {
          modelCache = { at: Date.now(), models, defaultModelId };
          return modelCache;
        })
        .finally(() => { modelRequest = null; });
    }
    return modelRequest;
  }

  async function chatModels() {
    const cache = await catalogue();
    return Object.values(cache.models).filter((m) => isChatModel(m.id));
  }

  function sendJson(res, status, payload) {
    const text = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  }

  function sendError(res, status, message, type = 'upstream_error') {
    sendJson(res, status, { error: { message: String(message), type, code: type } });
  }

  async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) throw new Error('request body too large');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) return {};
    try { return JSON.parse(text); } catch (err) { throw new Error('invalid JSON body: ' + err.message); }
  }

  function upstreamStatus(err) {
    if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600) return err.status;
    return 502;
  }

  /* ---------------------------------------------------------------- routes */

  async function handleModels(req, res, url) {
    const force = url.searchParams.get('refresh') === '1';
    const models = await chatModels();
    sendJson(res, 200, openAiModelList(Object.fromEntries(models.map((m) => [m.id, m]))));
  }

  async function handleQuota(res) {
    const quota = await client.fetchQuota();
    sendJson(res, 200, { quota });
  }

  function handleHealth(res) {
    sendJson(res, 200, {
      ok: true,
      upstream: client.host,
      auth: 'antigravity-keyring',
      token: tokens.state(),
      models: modelCache ? Object.keys(modelCache.models).length : null,
      modelsFetchedAt: modelCache ? new Date(modelCache.at).toISOString() : null,
      defaultModelId: modelCache ? modelCache.defaultModelId : null,
      pid: process.pid,
    });
  }

  async function handleChat(req, res, body) {
    if (!body || typeof body.model !== 'string' || !body.model) {
      return sendError(res, 400, 'missing "model"', 'invalid_request_error');
    }
    const buildOptions = {
      log,
      sessionId,
      maxOutputTokensCap: config.maxOutputTokensCap,
    };
    let upstream;
    try {
      upstream = await buildUpstreamRequest(body, buildOptions);
    } catch (err) {
      return sendError(res, 400, 'could not translate the request: ' + err.message, 'invalid_request_error');
    }
    dump('request', { openai: redactForDump(body), upstream });
    if (upstream.meta.stream) return handleChatStream(req, res, upstream);
    return handleChatOnce(req, res, upstream);
  }

  const openAiId = () => 'chatcmpl-ag-' + crypto.randomBytes(12).toString('hex');

  async function handleChatOnce(req, res, upstream) {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      const response = await client.openStream({ model: upstream.model, request: upstream.request, signal: controller.signal });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        log('upstream error ' + response.status + ': ' + text.slice(0, 300));
        return sendError(res, response.status, text.slice(0, 1200), 'upstream_error');
      }
      let content = '';
      let reasoning = '';
      let finishReason = null;
      let usage;
      const toolCalls = [];
      for await (const event of parseGenerationStream(response.body)) {
        if (event.type === 'text') content += event.text;
        else if (event.type === 'thought') reasoning += event.text;
        else if (event.type === 'usage') usage = event.usage;
        else if (event.type === 'finish') finishReason = event.reason;
        else if (event.type === 'toolCall') {
          const id = makeToolCallId(event.call.id, event.thoughtSignature);
          upstream.meta.toolNames.set(id, event.call.name);
          toolCalls.push({
            id,
            type: 'function',
            function: { name: event.call.name, arguments: JSON.stringify(event.call.args ?? {}) },
          });
        }
      }
      const payload = openAiCompletion({
        id: openAiId(),
        model: upstream.model,
        content,
        reasoning: reasoning || undefined,
        toolCalls,
        finishReason: finishReasonToOpenAi(finishReason, toolCalls.length > 0),
        usage: openAiUsage(usage),
      });
      dump('response', { openai: payload });
      sendJson(res, 200, payload);
    } catch (err) {
      log('request failed: ' + (err && err.message ? err.message : err));
      if (!res.headersSent) sendError(res, upstreamStatus(err), err.message, 'proxy_error');
      else res.end();
    }
  }

  async function handleChatStream(req, res, upstream) {
    const controller = new AbortController();
    const id = openAiId();
    const created = Math.floor(Date.now() / 1000);
    let closed = false;
    let idleTimer = null;

    const finish = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      if (!closed) { closed = true; try { res.end(); } catch { /* already gone */ } }
    };
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        log('stream idle for ' + streamIdleTimeoutMs + 'ms - aborting upstream');
        controller.abort();
        finish();
      }, streamIdleTimeoutMs);
      idleTimer.unref?.();
    };

    res.on('close', () => {
      if (closed) return;
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      controller.abort();
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (chunk) => {
      if (closed) return;
      res.write('data: ' + JSON.stringify(chunk) + '\n\n');
    };

    try {
      const response = await client.openStream({ model: upstream.model, request: upstream.request, signal: controller.signal });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        log('upstream stream error ' + response.status + ': ' + text.slice(0, 300));
        write({ error: { message: text.slice(0, 1200) || ('upstream HTTP ' + response.status), type: 'upstream_error' } });
        return finish();
      }

      let finishReason = null;
      let usage;
      let toolIndex = 0;
      let sawRole = false;
      let sawToolCall = false;
      const emitRole = () => {
        if (sawRole) return;
        sawRole = true;
        write(openAiChunk({ id, model: upstream.model, created, delta: { role: 'assistant', content: '' } }));
      };

      armIdle();
      for await (const event of parseGenerationStream(response.body)) {
        armIdle();
        if (event.type === 'text') {
          if (!event.text) continue;
          emitRole();
          write(openAiChunk({ id, model: upstream.model, created, delta: { content: event.text } }));
        } else if (event.type === 'thought') {
          if (!event.text) continue;
          emitRole();
          write(openAiChunk({ id, model: upstream.model, created, delta: { reasoning_content: event.text } }));
        } else if (event.type === 'toolCall') {
          emitRole();
          sawToolCall = true;
          const callId = makeToolCallId(event.call.id, event.thoughtSignature);
          upstream.meta.toolNames.set(callId, event.call.name);
          write(openAiChunk({
            id,
            model: upstream.model,
            created,
            delta: {
              tool_calls: [{
                index: toolIndex++,
                id: callId,
                type: 'function',
                function: { name: event.call.name, arguments: JSON.stringify(event.call.args ?? {}) },
              }],
            },
          }));
        } else if (event.type === 'usage') {
          usage = event.usage;
        } else if (event.type === 'finish') {
          finishReason = event.reason;
        }
      }
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      const reason = finishReasonToOpenAi(finishReason, sawToolCall);
      emitRole();
      const finalUsage = openAiUsage(usage);
      write(openAiChunk({ id, model: upstream.model, created, delta: {}, finishReason: reason, usage: finalUsage }));
      dump('stream', { model: upstream.model, finishReason: reason, usage: finalUsage });
      if (!closed) res.write('data: [DONE]\n\n');
      finish();
    } catch (err) {
      if (controller.signal.aborted) return finish();
      log('stream failed: ' + (err && err.message ? err.message : err));
      write({ error: { message: err.message || String(err), type: 'proxy_error' } });
      finish();
    }
  }

  function redactForDump(body) {
    const copy = JSON.parse(JSON.stringify(body ?? {}));
    if (Array.isArray(copy.messages)) {
      for (const message of copy.messages) {
        if (Array.isArray(message.content)) {
          message.content = message.content.map((part) => {
            if (part && part.image_url) return { type: 'image_url', image_url: { url: '<redacted image>' } };
            return part;
          });
        }
      }
    }
    return copy;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
        return handleHealth(res);
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') return await handleModels(req, res, url);
      if (req.method === 'GET' && url.pathname === '/v1/quota') return await handleQuota(res);
      if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
        const body = await readJsonBody(req);
        return await handleChat(req, res, body);
      }
      return sendError(res, 404, 'no route ' + req.method + ' ' + url.pathname, 'not_found');
    } catch (err) {
      log('unhandled: ' + (err && err.stack ? err.stack : err));
      if (!res.headersSent) sendError(res, 500, err && err.message ? err.message : String(err), 'proxy_error');
      else res.end();
    }
  });

  return {
    server,
    client,
    tokens,
    catalogue,
    listen: (listenPort = port, listenHost = host) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenPort, listenHost, () => {
        server.removeListener('error', reject);
        const address = server.address();
        resolve({ port: address.port, host: address.address });
      });
    }),
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
