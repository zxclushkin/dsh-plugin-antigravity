// language: JavaScript (ESM), file: src/status.mjs, runtime: Node >= 20 (DSH host)
// Host half of the settings GUI: a small JSON API the Client section reads, plus a test
// image-generation action. Routes are plain node:http handlers registered on the harness
// web server, so the browser reaches them same-origin without extra RPC plumbing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageMarkdown } from './imagegen.mjs';

const CACHE_MS = 60_000;
/** Durable attachment objects live here; the GUI may preview them by absolute path. */
const ATTACHMENTS_ROOT = path.join(os.homedir(), '.dsh', 'attachments');

/** Content type from magic bytes (durable objects have no file extension). */
function sniffImageType(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 3 && bytes.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  return null;
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req, limit = 1 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

/** Snapshot of account, quota, catalogue and effective plugin configuration. */
export function createStatusService({ client, adapter, config, log, meta }) {
  let cached = null;
  let cachedAt = 0;

  async function build() {
    const [account, quotas, catalogue] = await Promise.all([
      retryOnce(() => (client.fetchAccount ? client.fetchAccount() : Promise.resolve({}))),
      client.fetchQuotaBuckets
        ? retryOnce(() => client.fetchQuotaBuckets()).catch((error) => ({ error: error.message }))
        : Promise.resolve([]),
      adapter.loadCatalogue().catch((error) => ({ error: error.message })),
    ]);
    const models = [];
    if (catalogue && catalogue.models) {
      for (const model of Object.values(catalogue.models)) {
        models.push({
          id: model.id,
          name: model.name,
          kind: 'chat',
          contextWindow: model.contextWindow || null,
          maxTokens: model.maxTokens || null,
          input: model.supportsImages ? ['text', 'image'] : ['text'],
          thinking: Boolean(model.supportsThinking),
          recommended: Boolean(model.recommended),
        });
      }
    }
    if (catalogue && catalogue.imageModels) {
      for (const model of Object.values(catalogue.imageModels)) {
        models.push({
          id: model.id,
          name: model.name,
          kind: 'image',
          contextWindow: model.contextWindow || null,
          maxTokens: model.maxTokens || null,
          input: ['text', 'image'],
          thinking: false,
          recommended: false,
        });
      }
    }
    return {
      ok: true,
      at: new Date().toISOString(),
      plugin: meta ? meta() : {},
      upstream: client.host,
      credentialTarget: config.credentialTarget,
      userAgent: config.userAgent,
      debugDir: config.debugDir || null,
      features: config.features || {},
      limits: {
        maxConcurrentRequests: config.maxConcurrentRequests,
        minRequestIntervalMs: config.minRequestIntervalMs,
        rateLimitCooldownMs: config.rateLimitCooldownMs,
      },
      account: account || {},
      accountsError: account && account.error ? account.error : undefined,
      quotas: Array.isArray(quotas) ? quotas : [],
      quotasError: quotas && quotas.error ? quotas.error : undefined,
      models,
      modelsError: catalogue && catalogue.error ? catalogue.error : undefined,
    };
  }

  return {
    async snapshot({ refresh = false } = {}) {
      if (!refresh && cached && Date.now() - cachedAt < CACHE_MS) return { ...cached, cached: true };
      const value = await build();
      // A transient network failure must not be cached: the settings page would then show the
      // same stale error for a minute even though a retry succeeds.
      const degraded = Boolean(value.quotasError || value.accountsError || value.modelsError);
      if (!degraded) {
        cached = value;
        cachedAt = Date.now();
      }
      return { ...value, cached: false };
    },
    invalidate() { cached = null; cachedAt = 0; },
  };
}

/** One retry for a flaky first network call (token mint / DNS warm-up). */
async function retryOnce(operation) {
  try {
    return await operation();
  } catch (error) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return operation();
  }
}

/** Media file name guard: basename only, known image extensions. */
function safeMediaName(name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  if (!/\.(jpe?g|png|webp|gif)$/i.test(name)) return null;
  return name;
}

/** Features the GUI may change live (everything else stays a profile-patch decision). */
const EDITABLE_FEATURES = {
  googleSearch: 'boolean',
  googleSearchTool: 'boolean',
  includeThoughts: 'boolean',
  imageGen: 'boolean',
  imageOutput: 'boolean',
  durableImages: 'boolean',
  defaultThinkingLevel: 'string',
  imageAspectRatio: 'string',
};

function validateFeaturePatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'features must be an object' };
  const patch = {};
  for (const [key, value] of Object.entries(raw)) {
    const type = EDITABLE_FEATURES[key];
    if (type === undefined) return { error: 'feature "' + key + '" is not editable from the GUI' };
    if (typeof value !== type) return { error: 'feature "' + key + '" must be a ' + type };
    patch[key] = value;
  }
  if (Object.keys(patch).length === 0) return { error: 'no feature values supplied' };
  return { patch };
}

/**
 * Routes for the settings GUI.
 * @returns {Array<{kind:'exact', path: string, method: string, handler: Function}>}
 */
export function createStatusRoutes({ service, generator, config, log, getConfigEditor, search, allowedMediaRoots, entryId = 'antigravity-llm' }) {
  const mediaDir = (config.features && config.features.mediaOutputDir) || null;
  // Absolute image paths the preview route may serve: the media directory and the durable
  // attachment store. Everything else is refused (the route is same-origin but still guarded).
  const previewRoots = (allowedMediaRoots || [mediaDir, ATTACHMENTS_ROOT])
    .filter((root) => typeof root === 'string' && root.length > 0)
    .map((root) => path.resolve(root));

  function resolvePreviewFile(requested) {
    if (typeof requested !== 'string' || requested.length === 0) return null;
    let resolved;
    try { resolved = path.resolve(requested); } catch { return null; }
    if (!previewRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) return null;
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile() || stat.size > 40 * 1024 * 1024) return null;
      return resolved;
    } catch {
      return null;
    }
  }

  function serveImageFile(res, file) {
    try {
      const bytes = fs.readFileSync(file);
      const type = sniffImageType(bytes);
      if (!type) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end();
    }
  }

  return [
    {
      kind: 'exact',
      path: '/antigravity/status',
      method: 'GET',
      async handler(req, res) {
        const url = new URL(req.url || '/', 'http://x');
        const refresh = url.searchParams.get('refresh') === '1';
        try {
          sendJson(res, 200, await service.snapshot({ refresh }));
        } catch (error) {
          log('status route failed: ' + (error && error.message ? error.message : error));
          sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/antigravity/config',
      method: 'POST',
      async handler(req, res) {
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: 'invalid request body: ' + error.message });
        }
        const validation = validateFeaturePatch(body.features);
        if (validation.error) return sendJson(res, 400, { ok: false, error: validation.error });
        const configEditor = typeof getConfigEditor === 'function' ? getConfigEditor() : undefined;
        if (!configEditor) {
          return sendJson(res, 501, { ok: false, error: 'the harness config editor is not available in this composition' });
        }
        try {
          const entries = configEditor.entries();
          const entry = entries.find((candidate) => candidate
            && (candidate.id === entryId
              || (candidate.options && candidate.options.id === entryId)
              || (candidate.patch && candidate.patch.id === entryId)));
          if (!entry) return sendJson(res, 404, { ok: false, error: 'plugin entry "' + entryId + '" not found' });
          await configEditor.edit(entry, (current) => ({
            ...(current || {}),
            features: { ...((current && current.features) || {}), ...validation.patch },
          }));
          service.invalidate();
          log('features updated from the settings GUI: ' + JSON.stringify(validation.patch));
          sendJson(res, 200, { ok: true, features: validation.patch });
        } catch (error) {
          log('config route failed: ' + (error && error.message ? error.message : error));
          sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/antigravity/test-image',
      method: 'POST',
      async handler(req, res) {
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: 'invalid request body: ' + error.message });
        }
        const prompt = typeof body.prompt === 'string' && body.prompt.trim()
          ? body.prompt.trim()
          : 'A small red circle on a plain white background, flat vector style.';
        try {
          const result = await generator.generate({
            prompt,
            aspectRatio: body.aspect_ratio,
            count: 1,
          });
          sendJson(res, 200, {
            ok: true,
            prompt,
            images: result.images.map((image) => ({
              path: image.path,
              name: path.basename(image.path),
              mimeType: image.mimeType,
              bytes: image.bytes,
              durable: image.durable === true,
              attachmentId: image.attachmentId,
              markdown: imageMarkdown(image.path),
              // Preview works for both the media directory and durable attachment objects.
              previewUrl: '/antigravity/media/?path=' + encodeURIComponent(image.path),
            })),
            text: result.text || '',
            model: result.model,
          });
        } catch (error) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({
            ok: false,
            error: error && error.message ? error.message : String(error),
            code: error && error.code ? error.code : 'ERROR',
          }));
        }
      },
    },
    {
      kind: 'exact',
      path: '/antigravity/test-search',
      method: 'POST',
      async handler(req, res) {
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: 'invalid request body: ' + error.message });
        }
        const query = typeof body.query === 'string' && body.query.trim()
          ? body.query.trim()
          : 'Who won the most recent Formula 1 World Drivers Championship?';
        if (typeof search !== 'function') {
          return sendJson(res, 501, { ok: false, error: 'grounded search is not available in this composition' });
        }
        try {
          const result = await search(query);
          sendJson(res, 200, {
            ok: true,
            query,
            answer: result.text,
            sources: result.sources,
            queries: result.queries,
          });
        } catch (error) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({
            ok: false,
            error: error && error.message ? error.message : String(error),
            code: error && error.code ? error.code : 'ERROR',
          }));
        }
      },
    },
    {
      kind: 'prefix',
      path: '/antigravity/media/',
      method: 'GET',
      async handler(req, res) {
        const url = new URL(req.url || '/', 'http://x');
        const requestedPath = url.searchParams.get('path');
        if (requestedPath) {
          const file = resolvePreviewFile(requestedPath);
          if (!file) {
            res.writeHead(404);
            res.end();
            return;
          }
          return serveImageFile(res, file);
        }
        const name = safeMediaName(path.basename(url.pathname));
        if (!name || !mediaDir) {
          res.writeHead(404);
          res.end();
          return;
        }
        serveImageFile(res, path.join(mediaDir, name));
      },
    },
  ];
}

/** Register the GUI routes on the harness web server; returns the disposer list. */
export function registerStatusRoutes(childCtx, options) {
  const routes = createStatusRoutes(options);
  const disposers = [];
  for (const route of routes) {
    const handler = route.handler;
    const disposer = childCtx.webServer.register({
      kind: route.kind,
      path: route.path,
      handler: (req, res) => {
        if (route.method === 'POST' && req.method !== 'POST' && req.method !== undefined) {
          res.writeHead(405);
          res.end();
          return;
        }
        return handler(req, res);
      },
    });
    disposers.push(disposer);
  }
  return () => { for (const dispose of disposers) try { dispose(); } catch { /* already gone */ } };
}
