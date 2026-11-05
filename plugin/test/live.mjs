// language: JavaScript (ESM), file: plugin/test/live.mjs, runtime: Node >= 20
// Live checks for the native adapter against the real Antigravity API. Needs an installed,
// signed-in Antigravity app and spends its quota.
//
//   node plugin/test/live.mjs                            # default (cheap) suite
//   $env:AG_MATRIX_TEST='1'; node plugin/test/live.mjs   # + model/mode matrix
//   $env:AG_IMAGE_TEST='1'; node plugin/test/live.mjs    # + image generation
//   $env:AG_IMAGE_TEST='1'; $env:AG_MATRIX_TEST='1'; node plugin/test/live.mjs  # everything
//
// Every check prints `PASS name — detail` or `FAIL name — detail`; optional checks that are
// not enabled (or not reachable) print `SKIP name — reason` and are not counted. The process
// exits non-zero only when a recorded check failed.
//
// Default mode is the cheap smoke suite: catalogue/metadata, text, reasoning, tool calling and
// replay, structured output, grounding, both agent tools, throttle/status config, errors.
// AG_MATRIX_TEST adds the per-model matrix: the Google thinking tiers (level and the 2.5 token
// budget style), tool calling per vendor, groundedSearch, throttle serialization, and one
// image edit through `referencePath` using an existing image (one image of quota).
// AG_IMAGE_TEST adds image generation, the image model through the adapter with tools attached
// (they must be dropped) and an edit whose reference is the freshly generated image. One image
// costs ~1.5k output tokens and the image model has its own quota, so image checks stay opt-in;
// a QUOTA wall there is reported as SKIP, not as a product failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAntigravityClient, createTokenSource } from '../src/antigravity.mjs';
import { AntigravityAdapter } from '../src/adapter.mjs';
import { createImageGenerator } from '../src/imagegen.mjs';
import { createSearchTool, SEARCH_TOOL_NAME, DEFAULT_SEARCH_MODEL } from '../src/search.mjs';
import { createThrottle } from '../src/throttle.mjs';
import { imageToolDefinition } from '../src/tool.mjs';
import { createStatusService } from '../src/status.mjs';
import { Config } from '../index.mjs';

const MEDIA_DIR = path.join(os.tmpdir(), 'dsh-antigravity-live-test');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MATRIX = process.env.AG_MATRIX_TEST === '1';
const IMAGE_TEST = process.env.AG_IMAGE_TEST === '1';
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'plugin', 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
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
// Same throttle the plugin builds in index.mjs, so the live suite exercises production shaping.
const throttle = createThrottle({ maxConcurrent: 2, minIntervalMs: 0, cooldownMs: 60_000, log });
const adapter = new AntigravityAdapter({ client, config: baseConfig, log, throttle, getAttachments: () => undefined });

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
    throttle,
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
 * Client wrapper that counts concurrent `openStream` calls (a request is "in flight" from the
 * call to the point the response headers arrive — exactly the window the throttle guards).
 * With maxConcurrentRequests=1 the peak must stay at 1.
 */
function concurrentProbeClient(base) {
  let active = 0;
  let peak = 0;
  return {
    peak: () => peak,
    client: {
      ...base,
      async openStream(options) {
        active++;
        peak = Math.max(peak, active);
        try {
          return await base.openStream(options);
        } finally {
          active--;
        }
      },
    },
  };
}

/** Existing reference image for editing: a fresh render first, then media/, then the fixture. */
function referenceImage(generated) {
  const candidates = [...generated];
  try {
    const mediaDir = path.join(REPO_ROOT, 'media');
    if (fs.existsSync(mediaDir)) {
      for (const name of fs.readdirSync(mediaDir).sort().reverse()) {
        if (/\.(jpe?g|png|webp)$/i.test(name)) candidates.push(path.join(mediaDir, name));
      }
    }
  } catch { /* media dir is optional */ }
  candidates.push(path.join(REPO_ROOT, '.tmp', 'image-test.png'));
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
async function matrixSection(chat, tools, model) {
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
  const searchModel = available.has(DEFAULT_SEARCH_MODEL) ? DEFAULT_SEARCH_MODEL
    : (available.has('gemini-3-flash') ? 'gemini-3-flash' : chat[0].id);
  await matrixCase('matrix groundedSearch', async () => {
    const found = await import('../src/search.mjs')
      .then((module) => module.groundedSearch({
        client, model: searchModel,
        query: 'What notable AI model releases happened this month?',
        signal: AbortSignal.timeout(180_000), throttle,
      }));
    const sources = Array.isArray(found && found.sources) ? found.sources : [];
    if (!found || !found.text || sources.length === 0) {
      throw new Error('no grounded sources (model=' + searchModel + ', sources=' + sources.length +
        ', text=' + JSON.stringify(String((found && found.text) || '').slice(0, 80)) + ')');
    }
    return 'model=' + searchModel + ' sources=' + sources.length +
      ' first=' + JSON.stringify(String((sources[0] && (sources[0].title || sources[0].uri)) || '')).slice(0, 90);
  });

  // Throttle: two parallel streams with maxConcurrent=1 must not overlap upstream calls.
  await matrixCase('matrix throttle (maxConcurrent=1)', async () => {
    const probe = concurrentProbeClient(client);
    const limiter = createThrottle({ maxConcurrent: 1, minIntervalMs: 0, cooldownMs: 60_000, log });
    const throttled = new AntigravityAdapter({
      client: probe.client, config: baseConfig, log, throttle: limiter,
      getAttachments: () => undefined,
    });
    const options = {
      provider: 'antigravity', model,
      messages: user('Reply with exactly one word: OK'), maxTokens: 512, reasoningEffort: 'low',
    };
    await Promise.all([collect(throttled, options), collect(throttled, options)]);
    const peak = probe.peak();
    if (peak <= 0) throw new Error('the instrumented client never opened an upstream stream');
    if (peak > 1) throw new Error('streams overlapped (peak upstream concurrency ' + peak + ') despite maxConcurrent=1');
    return 'peak upstream concurrency=' + peak + ' for 2 parallel streams; state=' + JSON.stringify(limiter.state());
  });

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

  // 7. adapter.lastError is filled for the GUI after a rejected request. An invalid Gemini
  // responseSchema type is a cheap, model-agnostic 400: no generation, no quota spent.
  await withFeatures({ responseSchema: { type: 'BANANA' } }, async (scoped) => {
    let caught = null;
    try {
      for await (const chunk of scoped.stream({
        provider: 'antigravity', model, messages: user('Say hi'), maxTokens: 64, reasoningEffort: 'low',
      })) { void chunk; }
    } catch (error) {
      caught = error;
    }
    record('adapter.lastError after a refused request',
      Boolean(scoped.lastError && scoped.lastError.code === 'INVALID_REQUEST' && /400/.test(scoped.lastError.message)),
      'caught=' + (caught ? describeError(caught) : 'none') + ' lastError=' + JSON.stringify(scoped.lastError));
  });

  // 8. the agent-facing tools: image_generate gains image editing, google_search is new
  const generator = createImageGenerator({ client, adapter, config: baseConfig, log, throttle });
  const imageTool = imageToolDefinition({ generator, config: baseConfig, log });
  const imageParams = (imageTool && imageTool.parameters && imageTool.parameters.properties) || {};
  record('image_generate reference_path parameter', Boolean(imageParams.reference_path && imageParams.reference_path.type === 'string'),
    'params=' + Object.keys(imageParams).join(','));

  const searchTool = createSearchTool({ client, config: baseConfig, log, throttle });
  const searchParams = (searchTool.parameters && searchTool.parameters.properties) || {};
  record('google_search tool definition',
    SEARCH_TOOL_NAME === 'google_search' && searchTool.name === 'google_search' &&
      Boolean(searchParams.query) && typeof searchTool.execute === 'function' &&
      searchTool.output && searchTool.output.schema && searchTool.output.schema.properties.answer,
    'name=' + searchTool.name + ' params=' + Object.keys(searchParams).join(',') +
    ' defaultsTo=' + DEFAULT_SEARCH_MODEL);

  try {
    const found = await searchTool.execute(
      { query: 'What are the biggest technology news headlines this week?' },
      { signal: AbortSignal.timeout(180_000) },
    );
    const sources = Array.isArray(found && found.sources) ? found.sources : [];
    const answer = String((found && found.answer) || '');
    record('google_search tool (grounded)', answer.length > 0 && sources.length > 0,
      'answer=' + JSON.stringify(answer.replace(/\s+/g, ' ').slice(0, 80)) +
      ' sources=' + sources.length +
      (sources[0] ? ' first=' + JSON.stringify(String(sources[0].title || sources[0].uri || '')).slice(0, 90) : ''));
  } catch (error) {
    // A quota wall here is a real outcome, not a blocker: report and carry on.
    if (error && (error.code === 'QUOTA' || error.code === 'RATE_LIMIT')) {
      skip('google_search tool (grounded)', 'quota/rate limit: ' + describeError(error));
    } else {
      failuresSeen.push(error);
      record('google_search tool (grounded)', false, describeError(error));
    }
  }

  // 9. config keys: throttle (top level) and search features. `Config` requires a positive
  // model cache TTL, while this suite keeps 0 so every check sees a fresh catalogue.
  const configForValidation = { ...baseConfig, modelCacheTtlMs: 600_000 };
  let validated = {};
  try {
    validated = Config['~standard'].validate({ ...configForValidation });
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
      ...configForValidation,
      maxConcurrentRequests: 4,
      minRequestIntervalMs: 50,
      rateLimitCooldownMs: 90_000,
      features: { ...baseConfig.features, googleSearchTool: false, searchModel: 'gemini-3-flash' },
    });
  } catch (error) {
    overridden = { issues: [{ message: 'Config.validate threw: ' + describeError(error) }] };
  }
  const overrideValue = overridden.value || {};
  const overrideFeatures = overrideValue.features || {};
  const overrideIssues = Array.isArray(overridden.issues) ? overridden.issues : [];
  record('throttle/search config overrides', overrideIssues.length === 0 &&
      overrideValue.maxConcurrentRequests === 4 &&
      overrideValue.minRequestIntervalMs === 50 &&
      overrideValue.rateLimitCooldownMs === 90_000 &&
      overrideFeatures.googleSearchTool === false &&
      overrideFeatures.searchModel === 'gemini-3-flash',
    'maxConcurrentRequests=' + overrideValue.maxConcurrentRequests +
    ' minRequestIntervalMs=' + overrideValue.minRequestIntervalMs +
    ' rateLimitCooldownMs=' + overrideValue.rateLimitCooldownMs +
    ' googleSearchTool=' + overrideFeatures.googleSearchTool +
    ' searchModel=' + overrideFeatures.searchModel +
    (overrideIssues.length > 0 ? ' issues=' + overrideIssues.map((issue) => issue.message).slice(0, 2).join('; ') : ''));

  // 10. settings status snapshot: plugin.{version,tools,throttle,lastError} and limits.*
  try {
    const statusService = createStatusService({
      client,
      adapter,
      config: { ...baseConfig, ...throttleDefaults },
      log,
      meta: () => ({
        version: PLUGIN_VERSION,
        tools: ['image_generate', 'google_search'],
        throttle: throttle.state(),
        lastError: adapter.lastError,
      }),
    });
    const snapshot = await statusService.snapshot({ refresh: true });
    const plugin = snapshot.plugin || {};
    const toolNames = Array.isArray(plugin.tools) ? plugin.tools : [];
    const limits = snapshot.limits || {};
    record('status snapshot (version/tools/throttle/limits)',
      Boolean(snapshot.ok) && plugin.version === PLUGIN_VERSION && toolNames.length >= 2 &&
        Boolean(plugin.throttle) && typeof plugin.throttle.maxConcurrent === 'number' &&
        Boolean(limits) && limits.maxConcurrentRequests === 2 && 'lastError' in plugin,
      'version=' + String(plugin.version) +
      ' tools=' + toolNames.join(',') +
      ' throttle=' + JSON.stringify(plugin.throttle).slice(0, 140) +
      ' limits=' + JSON.stringify(limits) +
      ' models=' + (Array.isArray(snapshot.models) ? snapshot.models.length : 'missing') +
      ' lastError=' + JSON.stringify(plugin.lastError || null).slice(0, 120));
  } catch (error) {
    failuresSeen.push(error);
    record('status snapshot (version/tools/throttle/limits)', false, describeError(error));
  }

  // 11. images. Order matters for quota: in the full run generation and the edit (using the
  // fresh image as reference) go first, the more redundant adapter-path check last.
  const generated = [];
  if (IMAGE_TEST && image) {
    try {
      const drawn = await generator.generate({ prompt: 'A red apple on a white table, soft studio light.', aspectRatio: '16:9' });
      const saved = drawn.images[0];
      const bytes = saved ? fs.statSync(saved.path).size : 0;
      if (saved) generated.push(saved.path);
      record('image generation (imageGen)', bytes > 1000,
        saved ? 'file=' + saved.path + ' (' + bytes + ' bytes)' : 'no image');
    } catch (error) {
      imageFailure('image generation (imageGen)', error);
    }
  } else if (IMAGE_TEST) {
    skip('image checks', 'the account advertises no image model');
  } else if (!MATRIX) {
    console.log('SKIP image checks (set AG_IMAGE_TEST=1 to spend image quota)');
  }

  // Image editing via reference_path: the full image run edits its fresh render, matrix mode
  // edits an existing image (one image of quota), so the path is covered in both runs.
  if ((IMAGE_TEST || MATRIX) && image) {
    const editReference = referenceImage(generated);
    if (editReference) {
      try {
        const edited = await generator.generate({
          prompt: 'Repaint this picture as a watercolor painting; keep the subject and composition.',
          referencePath: editReference,
          count: 1,
        });
        const saved = edited.images[0];
        const bytes = saved ? fs.statSync(saved.path).size : 0;
        record('image editing (reference_path)', bytes > 1000,
          'reference=' + path.basename(editReference) +
          (saved ? ' file=' + saved.path + ' (' + bytes + ' bytes)' : ' no image'));
      } catch (error) {
        imageFailure('image editing (reference_path)', error);
      }
    } else {
      skip('image editing (reference_path)', 'no reference image available (no media/ or .tmp fixture)');
    }
  }

  if (IMAGE_TEST && image) {
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
  }

  // 12. model/mode matrix (opt-in)
  if (MATRIX) await matrixSection(chat, tools, model);

  // 13. unknown model failure
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
