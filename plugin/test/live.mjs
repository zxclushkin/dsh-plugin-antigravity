// language: JavaScript (ESM), file: plugin/test/live.mjs, runtime: Node >= 20
// Live checks for the native adapter against the real Antigravity API. Needs an installed,
// signed-in Antigravity app and spends its quota.
//
//   node plugin/test/live.mjs                            # default (cheap) suite
//   $env:AG_MATRIX_TEST='1'; node plugin/test/live.mjs   # + model/mode matrix
//   $env:AG_IMAGE_TEST='1'; node plugin/test/live.mjs    # + image generation/editing
//
// Every check prints `PASS name — detail` or `FAIL name — detail`; optional checks that are
// not enabled (or not reachable) print `SKIP name — reason` and are not counted. The process
// exits non-zero only when a recorded check failed.
//
// Default mode is the cheap smoke suite. AG_MATRIX_TEST adds the per-model matrix: the Google
// thinking tiers (level and 2.5 budget style), tool calling for each vendor, groundedSearch,
// and throttle serialization. AG_IMAGE_TEST adds the image checks: generation, the image
// model through the adapter with tools attached (they must be dropped), and image editing via
// `reference_path`. One image costs ~1.5k output tokens and the image model has its own
// quota, so image checks stay opt-in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAntigravityClient, createTokenSource } from '../src/antigravity.mjs';
import { AntigravityAdapter } from '../src/adapter.mjs';
import { createImageGenerator } from '../src/imagegen.mjs';
import { imageToolDefinition } from '../src/tool.mjs';
import { createStatusService } from '../src/status.mjs';
import { Config } from '../index.mjs';

const MEDIA_DIR = path.join(os.tmpdir(), 'dsh-antigravity-live-test');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MATRIX = process.env.AG_MATRIX_TEST === '1';
const IMAGE_TEST = process.env.AG_IMAGE_TEST === '1';
const baseConfig = {
  credentialTarget: 'gemini:antigravity',
  upstreamHost: 'https://daily-cloudcode-pa.googleapis.com',
  userAgent: 'antigravity/2.29.0',
  requestTimeoutMs: 300_000,
  modelCacheTtlMs: 0,
  features: { mediaOutputDir: MEDIA_DIR },
};
const tokens = createTokenSource({ ...baseConfig, log: (message) => console.error('[token] ' + message) });
const client = createAntigravityClient({ ...baseConfig, tokens, log: (message) => console.error('[api] ' + message) });
const log = (message) => console.error('[adapter] ' + message);
const adapter = new AntigravityAdapter({ client, config: baseConfig, log, getAttachments: () => undefined });

const results = [];
const skips = [];
const failuresSeen = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}

function skip(name, reason) {
  skips.push({ name, reason });
  console.log('SKIP ' + name + ' — ' + reason);
}

function describeError(error) {
  const code = error && error.code ? error.code : 'ERROR';
  const message = error && error.message ? String(error.message) : String(error);
  return code + ': ' + message.replace(/\s+/g, ' ').slice(0, 180);
}

/** One-line summary of a stream result for the check detail. */
function streamSummary(out) {
  return 'text=' + JSON.stringify(out.text.replace(/\s+/g, ' ').slice(0, 60)) +
    ' reasoningChars=' + out.reasoning.length +
    ' usage=' + JSON.stringify(out.usage) +
    ' finish=' + JSON.stringify(out.finish && out.finish.reason);
}

function requireText(out) {
  if (!out.text) {
    throw new Error('empty text (finish=' + JSON.stringify(out.finish && out.finish.reason) +
      ', reasoningChars=' + out.reasoning.length + ')');
  }
}

async function collect(target, options) {
  const chunks = [];
  for await (const chunk of target.stream(options)) chunks.push(chunk);
  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
  const reasoning = chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join('');
  const toolCalls = chunks.filter((chunk) => chunk.type === 'tool-call-delta');
  const usage = chunks.find((chunk) => chunk.type === 'usage')?.usage;
  const finish = chunks[chunks.length - 1];
  return { chunks, text, reasoning, toolCalls, usage, finish };
}

/** Run one case against an adapter with extra feature flags. */
async function withFeatures(features, fn) {
  const scoped = new AntigravityAdapter({
    client,
    config: { ...baseConfig, features: { ...baseConfig.features, ...features } },
    log,
    getAttachments: () => undefined,
  });
  return fn(scoped);
}

const user = (text) => [{ role: 'user', content: [{ type: 'text', text }] }];

/** Matrix cases catch their own failures so one bad model does not abort the suite. */
async function matrixCase(name, run) {
  try {
    record(name, true, await run());
  } catch (error) {
    failuresSeen.push(error);
    record(name, false, describeError(error));
  }
}

/**
 * Client wrapper that counts how many upstream response bodies are being consumed at once.
 * With `maxConcurrentRequests: 1` the adapter's throttle must keep that peak at 1.
 */
function concurrentProbeClient(base) {
  let active = 0;
  let peak = 0;
  return {
    peak: () => peak,
    client: {
      ...base,
      async openStream(options) {
        const response = await base.openStream(options);
        const source = response.body;
        const body = (async function* instrumented() {
          active++;
          peak = Math.max(peak, active);
          try {
            for await (const chunk of source) yield chunk;
          } finally {
            active--;
          }
        })();
        return {
          ok: response.ok,
          status: response.status,
          headers: response.headers,
          text: () => response.text(),
          body,
        };
      },
    },
  };
}

/** First usable reference image for the editing check: repo fixture, then a fresh render. */
function referenceImage(generated) {
  const candidates = [path.join(REPO_ROOT, '.tmp', 'image-test.png'), ...generated];
  for (const file of candidates) {
    try {
      if (file && fs.existsSync(file) && fs.statSync(file).size > 100) return file;
    } catch { /* unreadable candidate: try the next one */ }
  }
  return undefined;
}

/** Record an image check failure; a quota wall is an acceptable, reported outcome. */
function imageFailure(name, error) {
  if (error && (error.code === 'QUOTA' || error.code === 'RATE_LIMIT')) {
    skip(name, 'image quota/rate limit: ' + describeError(error));
    return;
  }
  failuresSeen.push(error);
  record(name, false, describeError(error));
}

/** Per-model matrix: thinking styles, vendor tool calling, groundedSearch, throttle. */
async function matrixSection(chat, tools) {
  console.log('\n--- model matrix (AG_MATRIX_TEST=1) ---');
  const available = new Set(chat.map((entry) => entry.id));
  const need = (id, label) => {
    if (available.has(id)) return true;
    skip(label, 'model ' + id + ' is not advertised by this account');
    return false;
  };
  const WEATHER = 'What is the weather in Moscow? Use the get_weather tool.';

  if (need('gemini-3.8-flash-high', 'matrix gemini-3.8-flash-high + reasoning')) {
    await matrixCase('matrix gemini-3.8-flash-high + reasoning', async () => {
      const out = await collect(adapter, {
        provider: 'antigravity', model: 'gemini-3.8-flash-high',
        messages: user('Which is larger: 2^40 or 40!? Think step by step, then answer with one word.'),
        maxTokens: 4096, reasoningEffort: 'high',
      });
      requireText(out);
      return streamSummary(out);
    });
  }

  if (need('gemini-3-flash', 'matrix gemini-3-flash + tools + reasoning')) {
    await matrixCase('matrix gemini-3-flash + tools + reasoning', async () => {
      const out = await collect(adapter, {
        provider: 'antigravity', model: 'gemini-3-flash', messages: user(WEATHER),
        tools, maxTokens: 2048, reasoningEffort: 'medium',
      });
      const call = out.toolCalls[0];
      if (!call || call.name !== 'get_weather') throw new Error('no get_weather call; ' + streamSummary(out));
      return 'call=' + call.name + ' args=' + call.argumentsDelta.slice(0, 60);
    });
  }

  if (need('gemini-2.5-flash', 'matrix gemini-2.5-flash (thinkingBudget)')) {
    // Gemini 2.5 reasons through a token budget instead of a level; keep the budget inside
    // maxOutputTokens or the whole answer can be spent on thoughts.
    await matrixCase('matrix gemini-2.5-flash (thinkingBudget)', () => withFeatures(
      { thinkingBudgets: { high: 2048 }, maxOutputTokensCap: 8192 },
      async (scoped) => {
        const out = await collect(scoped, {
          provider: 'antigravity', model: 'gemini-2.5-flash',
          messages: user('What is 837 multiplied by 213? Think first, then answer with just the number.'),
          maxTokens: 8192, reasoningEffort: 'high',
        });
        requireText(out);
        return streamSummary(out);
      },
    ));
  }

  if (need('claude-sonnet-5-5-low', 'matrix claude-sonnet-5-5-low + reasoning')) {
    await matrixCase('matrix claude-sonnet-5-5-low + reasoning', async () => {
      const out = await collect(adapter, {
        provider: 'antigravity', model: 'claude-sonnet-5-5-low',
        messages: user('Which is larger: 2^40 or 17*23? Think first, then answer with one word.'),
        maxTokens: 2048, reasoningEffort: 'high',
      });
      requireText(out);
      return streamSummary(out);
    });
  }

  if (need('claude-opus-5-5-medium', 'matrix claude-opus-5-5-medium + tools + reasoning')) {
    await matrixCase('matrix claude-opus-5-5-medium + tools + reasoning', async () => {
      const out = await collect(adapter, {
        provider: 'antigravity', model: 'claude-opus-5-5-medium', messages: user(WEATHER),
        tools, maxTokens: 2048, reasoningEffort: 'medium',
      });
      const call = out.toolCalls[0];
      if (!call || call.name !== 'get_weather') throw new Error('no get_weather call; ' + streamSummary(out));
      return 'call=' + call.name + ' args=' + call.argumentsDelta.slice(0, 60);
    });
  }

  if (need('gpt-oss-120b-medium', 'matrix gpt-oss-120b + tools')) {
    await matrixCase('matrix gpt-oss-120b + tools', async () => {
      const out = await collect(adapter, {
        provider: 'antigravity', model: 'gpt-oss-120b-medium', messages: user(WEATHER),
        tools, maxTokens: 2048, reasoningEffort: 'low',
      });
      const call = out.toolCalls[0];
      if (!call || call.name !== 'get_weather') throw new Error('no get_weather call; ' + streamSummary(out));
      return 'call=' + call.name + ' args=' + call.argumentsDelta.slice(0, 60);
    });
  }

  // Grounded sub-request used by the google_search tool (runs without functionDeclarations).
  let searchModule = null;
  try { searchModule = await import('../src/search.mjs'); } catch { /* reported by the default check */ }
  const searchModel = available.has('gemini-3.5-flash-lite') ? 'gemini-3.5-flash-lite'
    : (available.has('gemini-3-flash') ? 'gemini-3-flash' : chat[0].id);
  if (searchModule && typeof searchModule.groundedSearch === 'function') {
    await matrixCase('matrix groundedSearch', async () => {
      const found = await searchModule.groundedSearch({
        client, model: searchModel,
        query: 'What were the biggest technology news headlines this week?',
        signal: AbortSignal.timeout(180_000),
      });
      const sources = Array.isArray(found && found.sources) ? found.sources : [];
      if (!found || !found.text || sources.length === 0) {
        throw new Error('no grounded sources (model=' + searchModel + ', sources=' + sources.length +
          ', text=' + JSON.stringify(String((found && found.text) || '').slice(0, 80)) + ')');
      }
      return 'model=' + searchModel + ' sources=' + sources.length +
        ' first=' + JSON.stringify(String((sources[0] && (sources[0].uri || sources[0].title)) || '')).slice(0, 90);
    });
  } else {
    skip('matrix groundedSearch', 'src/search.mjs does not export groundedSearch');
  }

  // Throttle: two parallel streams with maxConcurrentRequests=1 must not overlap upstream.
  if (need(process.env.AG_MODEL || 'gemini-3-flash', 'matrix throttle (maxConcurrentRequests=1)')) {
    await matrixCase('matrix throttle (maxConcurrentRequests=1)', async () => {
      const probe = concurrentProbeClient(client);
      const throttled = new AntigravityAdapter({
        client: probe.client,
        config: { ...baseConfig, maxConcurrentRequests: 1, minRequestIntervalMs: 0, rateLimitCooldownMs: 60_000 },
        log,
        getAttachments: () => undefined,
      });
      const options = {
        provider: 'antigravity', model: process.env.AG_MODEL || 'gemini-3-flash',
        messages: user('Reply with exactly one word: OK'), maxTokens: 512, reasoningEffort: 'low',
      };
      await Promise.all([collect(throttled, options), collect(throttled, options)]);
      const peak = probe.peak();
      if (peak <= 0) throw new Error('the instrumented client never opened an upstream stream');
      if (peak > 1) throw new Error('streams overlapped (peak upstream concurrency ' + peak + ') despite maxConcurrentRequests=1');
      return 'peak upstream concurrency=' + peak + ' for 2 parallel streams';
    });
  }

  // 429/cooldown is only covered if the account happens to hit it; never forced.
  const limited = failuresSeen.find((error) => error && (error.code === 'RATE_LIMIT' || error.code === 'QUOTA'));
  if (limited) {
    const classified = Boolean(limited.failure && limited.failure.code === limited.code);
    record('matrix 429/cooldown classification', classified,
      describeError(limited) + ' failure=' + JSON.stringify(limited.failure || null).slice(0, 140));
  } else {
    skip('matrix 429/cooldown classification', 'no 429/QUOTA encountered (not forced)');
  }
}

async function main() {
  // 1. catalogue + metadata
  const models = await adapter.listModels('antigravity');
  const chat = models.filter((model) => model.id && !/-image$/.test(model.id));
  const image = models.find((model) => /-image$/.test(model.id));
  record('catalogue', chat.length > 0,
    chat.length + ' chat models' + (image ? ', image model: ' + image.id : ', no image model'));
  if (MATRIX) console.log('catalogue models: ' + chat.map((entry) => entry.id).join(' '));
  const first = await adapter.resolveModel('antigravity', chat[0].id);
  record('model metadata', first.context.contextWindow > 0 && first.defaultMaxTokens > 0,
    first.id + ' ctx=' + first.context.contextWindow + ' maxTokens=' + first.defaultMaxTokens +
    ' efforts=' + (first.reasoning ? first.reasoning.efforts.map((effort) => effort.id).join('/') : 'none'));

  const model = process.env.AG_MODEL || (chat.find((entry) => entry.id === 'gemini-3-flash') || chat[0]).id;
  console.log('using model ' + model);

  // 2. text + usage
  const plain = await collect(adapter, {
    provider: 'antigravity', model, messages: user('Reply with exactly one word: PONG'),
    maxTokens: 512, reasoningEffort: 'low',
  });
  record('text stream', /PONG/i.test(plain.text) && plain.usage?.totalTokens > 0,
    JSON.stringify(plain.text.slice(0, 40)) + ' usage=' + JSON.stringify(plain.usage) +
    ' finish=' + JSON.stringify(plain.finish?.reason));

  // 3. reasoning deltas
  const thinking = await collect(adapter, {
    provider: 'antigravity', model,
    messages: user('Which is larger: 2^40 or 17*23? Think first, then answer with one word.'),
    maxTokens: 2048, reasoningEffort: 'high',
  });
  record('reasoning deltas', thinking.reasoning.length > 0 && thinking.text.length > 0,
    'reasoningChars=' + thinking.reasoning.length + ' text=' + JSON.stringify(thinking.text.slice(0, 40)));

  // 4. tool call + replayed thoughtSignature
  const tools = [
    {
      name: 'get_weather',
      description: 'Get the current weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name' } },
        required: ['city'],
        additionalProperties: false,
      },
    },
    { name: 'ping', description: 'Ping the server (no arguments).' },
  ];
  const question = 'What is the weather in Moscow? Use the get_weather tool.';
  const firstTurn = await collect(adapter, {
    provider: 'antigravity', model, messages: user(question), tools, maxTokens: 1024, reasoningEffort: 'low',
  });
  const call = firstTurn.toolCalls[0];
  record('tool call', Boolean(call && call.name === 'get_weather' && call.argumentsDelta.includes('Moscow')),
    call ? call.name + ' args=' + call.argumentsDelta.slice(0, 60) : 'no tool call; text=' + JSON.stringify(firstTurn.text.slice(0, 120)));

  if (call) {
    const replay = await collect(adapter, {
      provider: 'antigravity',
      model,
      messages: [
        ...user(question),
        { role: 'assistant', content: [{ type: 'tool-call', id: call.id, name: call.name, arguments: call.argumentsDelta }] },
        { role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: JSON.stringify({ tempC: -3, sky: 'snow' }) }], isError: false },
      ],
      tools,
      maxTokens: 1024,
      reasoningEffort: 'low',
    });
    record('tool round-trip (thoughtSignature replay)', replay.text.length > 0,
      'finish=' + JSON.stringify(replay.finish?.reason) + ' text=' + JSON.stringify(replay.text.slice(0, 120)));
  }

  // 5. structured output via responseSchema (config-level: the harness has no response_format)
  await withFeatures({
    responseSchema: {
      type: 'object',
      properties: { city: { type: 'string' }, population: { type: 'integer' } },
      required: ['city', 'population'],
    },
  }, async (scoped) => {
    const structured = await collect(scoped, {
      provider: 'antigravity', model, messages: user('Capital of France with its population.'),
      maxTokens: 1024, reasoningEffort: 'low',
    });
    let parsed = null;
    try { parsed = JSON.parse(structured.text); } catch { /* not JSON */ }
    record('structured output (responseSchema)', Boolean(parsed && parsed.city), JSON.stringify(structured.text.slice(0, 120)));
  });

  // 6. Google Search grounding at the adapter level (works only on turns without declarations)
  await withFeatures({ googleSearch: true }, async (scoped) => {
    const grounded = await collect(scoped, {
      provider: 'antigravity', model,
      messages: user('Who won the 2025 Formula 1 World Drivers Championship?'),
      maxTokens: 2048, reasoningEffort: 'low',
    });
    record('googleSearch grounding', grounded.text.length > 0 && /Sources:/.test(grounded.text),
      (/(Sources:)/.test(grounded.text) ? 'sources=yes' : 'sources=no') +
      ' text=' + JSON.stringify(grounded.text.slice(0, 100)));
  });

  // 7. the agent-facing tools: image_generate gains image editing, google_search is new
  const generator = createImageGenerator({ client, adapter, config: baseConfig, log });
  const imageTool = imageToolDefinition({ generator, config: baseConfig, log });
  const imageParams = (imageTool && imageTool.parameters && imageTool.parameters.properties) || {};
  record('image_generate reference_path parameter', Boolean(imageParams.reference_path && imageParams.reference_path.type === 'string'),
    'params=' + Object.keys(imageParams).join(','));

  let searchModule = null;
  let searchTool = null;
  try {
    searchModule = await import('../src/search.mjs');
  } catch (error) {
    failuresSeen.push(error);
    record('google_search tool definition', false, 'cannot import ../src/search.mjs: ' + describeError(error));
  }
  if (searchModule) {
    try {
      searchTool = searchModule.createSearchTool({ client, adapter, config: baseConfig, log });
      const parameters = (searchTool && searchTool.parameters) || {};
      const properties = parameters.properties || {};
      const shapeOk = searchModule.SEARCH_TOOL_NAME === 'google_search' &&
        searchTool.name === 'google_search' &&
        Boolean(properties.query) &&
        typeof searchTool.execute === 'function';
      record('google_search tool definition', shapeOk,
        'name=' + String(searchTool && searchTool.name) +
        ' SEARCH_TOOL_NAME=' + String(searchModule.SEARCH_TOOL_NAME) +
        ' params=' + Object.keys(properties).join(',') +
        ' execute=' + typeof (searchTool && searchTool.execute));
    } catch (error) {
      failuresSeen.push(error);
      record('google_search tool definition', false, describeError(error));
    }
  }

  if (searchTool) {
    try {
      const query = 'What are the biggest technology news headlines this week?';
      const found = await searchTool.execute({ query }, { signal: AbortSignal.timeout(180_000) });
      const sources = Array.isArray(found && found.sources) ? found.sources : [];
      record('google_search tool (grounded)', Boolean(found && found.text && sources.length > 0),
        'text=' + JSON.stringify(String((found && found.text) || '').replace(/\s+/g, ' ').slice(0, 80)) +
        ' sources=' + sources.length +
        (sources[0] ? ' first=' + JSON.stringify(String(sources[0].uri || sources[0].title || '')).slice(0, 90) : ''));
    } catch (error) {
      // A quota wall here is a real outcome, not a blocker: report and carry on.
      if (error && (error.code === 'QUOTA' || error.code === 'RATE_LIMIT')) {
        skip('google_search tool (grounded)', 'quota/rate limit: ' + describeError(error));
      } else {
        failuresSeen.push(error);
        record('google_search tool (grounded)', false, describeError(error));
      }
    }
  }

  // 8. throttle config: explicit keys are accepted and the documented defaults are applied
  let validated = {};
  try {
    validated = Config['~standard'].validate({ ...baseConfig });
  } catch (error) {
    validated = { issues: [{ message: 'Config.validate threw: ' + describeError(error) }] };
  }
  const throttleDefaults = validated.value || {};
  const throttleIssues = Array.isArray(validated.issues) ? validated.issues : [];
  record('throttle config defaults', throttleIssues.length === 0 &&
      throttleDefaults.maxConcurrentRequests === 2 &&
      throttleDefaults.minRequestIntervalMs === 0 &&
      throttleDefaults.rateLimitCooldownMs === 60_000,
    'maxConcurrentRequests=' + throttleDefaults.maxConcurrentRequests +
    ' minRequestIntervalMs=' + throttleDefaults.minRequestIntervalMs +
    ' rateLimitCooldownMs=' + throttleDefaults.rateLimitCooldownMs +
    (throttleIssues.length > 0 ? ' issues=' + throttleIssues.map((issue) => issue.message).slice(0, 2).join('; ') : ''));

  let overridden = {};
  try {
    overridden = Config['~standard'].validate({
      ...baseConfig,
      maxConcurrentRequests: 4,
      minRequestIntervalMs: 50,
      rateLimitCooldownMs: 90_000,
    });
  } catch (error) {
    overridden = { issues: [{ message: 'Config.validate threw: ' + describeError(error) }] };
  }
  const throttleValue = overridden.value || {};
  const overrideIssues = Array.isArray(overridden.issues) ? overridden.issues : [];
  record('throttle config overrides', overrideIssues.length === 0 &&
      throttleValue.maxConcurrentRequests === 4 &&
      throttleValue.minRequestIntervalMs === 50 &&
      throttleValue.rateLimitCooldownMs === 90_000,
    'maxConcurrentRequests=' + throttleValue.maxConcurrentRequests +
    ' minRequestIntervalMs=' + throttleValue.minRequestIntervalMs +
    ' rateLimitCooldownMs=' + throttleValue.rateLimitCooldownMs +
    (overrideIssues.length > 0 ? ' issues=' + overrideIssues.map((issue) => issue.message).slice(0, 2).join('; ') : ''));

  // 9. settings status snapshot: version, tool list and throttle state are the new fields
  try {
    const statusService = createStatusService({
      client,
      adapter,
      config: { ...baseConfig, ...throttleDefaults },
      log,
    });
    const snapshot = await statusService.snapshot({ refresh: true });
    const version = typeof snapshot.version === 'string'
      ? snapshot.version
      : (snapshot.plugin && typeof snapshot.plugin.version === 'string' ? snapshot.plugin.version : undefined);
    const tools = Array.isArray(snapshot.tools) ? snapshot.tools
      : (Array.isArray(snapshot.registeredTools) ? snapshot.registeredTools : null);
    const throttle = (snapshot.throttle && typeof snapshot.throttle === 'object') ? snapshot.throttle
      : ((snapshot.throttling && typeof snapshot.throttling === 'object') ? snapshot.throttling : null);
    const toolNames = tools
      ? tools.map((entry) => (typeof entry === 'string' ? entry : (entry && (entry.name || entry.id)))).filter(Boolean)
      : [];
    record('status snapshot (version/tools/throttle)', Boolean(version) && toolNames.length > 0 && Boolean(throttle),
      'version=' + String(version) +
      ' models=' + (Array.isArray(snapshot.models) ? snapshot.models.length : 'missing') +
      ' tools=' + (toolNames.length > 0 ? toolNames.join(',') : 'missing') +
      ' throttle=' + JSON.stringify(throttle).slice(0, 120));
  } catch (error) {
    failuresSeen.push(error);
    record('status snapshot (version/tools/throttle)', false, describeError(error));
  }

  // 10. built-in image generation and editing (the same generator the image_generate tool uses)
  if (IMAGE_TEST && image) {
    const generated = [];
    try {
      const drawn = await generator.generate({ prompt: 'A photo of a cat sitting on a windowsill.', aspectRatio: '16:9' });
      const saved = drawn.images[0];
      const bytes = saved ? fs.statSync(saved.path).size : 0;
      if (saved) generated.push(saved.path);
      record('image generation (imageGen)', bytes > 1000,
        saved ? 'file=' + saved.path + ' (' + bytes + ' bytes)' : 'no image');
    } catch (error) {
      imageFailure('image generation (imageGen)', error);
    }

    // The image model is a one-shot generator: the adapter must drop the agent's declarations.
    try {
      const picture = await collect(adapter, {
        provider: 'antigravity', model: image.id,
        messages: user('A blue ceramic mug on a wooden table, soft studio light.'),
        tools, maxTokens: 4096,
      });
      const match = /!\[[^\]]*\]\(([^)]+)\)/.exec(picture.text);
      const file = match ? match[1] : null;
      const bytes = file && fs.existsSync(file) ? fs.statSync(file).size : 0;
      record('image model via adapter (tools dropped)', Boolean(match) && bytes > 1000,
        file ? 'file=' + file + ' (' + bytes + ' bytes)'
          : 'no image markdown; text=' + JSON.stringify(picture.text.slice(0, 120)) +
            ' finish=' + JSON.stringify(picture.finish && picture.finish.reason));
    } catch (error) {
      imageFailure('image model via adapter (tools dropped)', error);
    }

    const reference = referenceImage(generated);
    if (reference) {
      try {
        const edited = await generator.generate({
          prompt: 'Repaint this picture as a watercolor painting; keep the subject and composition.',
          referencePath: reference,
          count: 1,
        });
        const saved = edited.images[0];
        const bytes = saved ? fs.statSync(saved.path).size : 0;
        record('image editing (reference_path)', bytes > 1000,
          'reference=' + path.basename(reference) +
          (saved ? ' file=' + saved.path + ' (' + bytes + ' bytes)' : ' no image'));
      } catch (error) {
        imageFailure('image editing (reference_path)', error);
      }
    } else {
      skip('image editing (reference_path)', 'no reference image available (no .tmp/image-test.png and no generated image)');
    }
  } else if (IMAGE_TEST) {
    skip('image checks', 'the account advertises no image model');
  } else {
    console.log('SKIP image checks (set AG_IMAGE_TEST=1 to spend image quota)');
  }

  // 11. model/mode matrix (opt-in)
  if (MATRIX) await matrixSection(chat, tools);

  // 12. unknown model failure
  let unknown = null;
  try { await adapter.resolveModel('antigravity', 'definitely-not-a-model'); } catch (error) { unknown = error; }
  record('unknown model error', Boolean(unknown && unknown.code === 'UNKNOWN_MODEL'), unknown ? unknown.code : 'no error');

  const failed = results.filter((entry) => !entry.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' live checks passed' +
    (skips.length > 0 ? ', ' + skips.length + ' skipped' : '') +
    ' (modes: ' + ['default', MATRIX ? 'matrix' : '', IMAGE_TEST ? 'image' : ''].filter(Boolean).join('+') + ')');
  if (failed.length > 0) {
    console.log('failed: ' + failed.map((entry) => entry.name).join('; '));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('FATAL: ' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
