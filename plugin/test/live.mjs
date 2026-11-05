// language: JavaScript (ESM), file: plugin/test/live.mjs, runtime: Node >= 20
// Live checks for the native adapter against the real Antigravity API. Needs an installed,
// signed-in Antigravity app and spends its quota.
//   node plugin/test/live.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAntigravityClient, createTokenSource } from '../src/antigravity.mjs';
import { AntigravityAdapter } from '../src/adapter.mjs';
import { createImageGenerator } from '../src/imagegen.mjs';

const MEDIA_DIR = path.join(os.tmpdir(), 'dsh-antigravity-live-test');
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
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
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

async function main() {
  // 1. catalogue + metadata
  const models = await adapter.listModels('antigravity');
  const chat = models.filter((model) => model.id && !/-image$/.test(model.id));
  const image = models.find((model) => /-image$/.test(model.id));
  record('catalogue', chat.length > 0,
    chat.length + ' chat models' + (image ? ', image model: ' + image.id : ', no image model'));
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

  // 6. Google Search grounding (works only on turns without function declarations)
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

  // 7. built-in image generation (the same generator the image_generate tool uses)
  if (process.env.AG_IMAGE_TEST === '1' && image) {
    const generator = createImageGenerator({ client, adapter, config: baseConfig, log });
    try {
      const drawn = await generator.generate({ prompt: 'A photo of a cat sitting on a windowsill.', aspectRatio: '16:9' });
      const bytes = drawn.images[0] ? fs.statSync(drawn.images[0].path).size : 0;
      record('image generation (imageGen)', bytes > 1000,
        drawn.images[0] ? 'file=' + drawn.images[0].path + ' (' + bytes + ' bytes)' : 'no image');
    } catch (error) {
      record('image generation (imageGen)', false, error.code + ': ' + String(error.message).slice(0, 120));
    }
  } else if (image) {
    console.log('SKIP image generation (set AG_IMAGE_TEST=1 to spend image quota)');
  }

  // 8. unknown model failure
  let unknown = null;
  try { await adapter.resolveModel('antigravity', 'definitely-not-a-model'); } catch (error) { unknown = error; }
  record('unknown model error', Boolean(unknown && unknown.code === 'UNKNOWN_MODEL'), unknown ? unknown.code : 'no error');

  const failed = results.filter((entry) => !entry.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' live checks passed');
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('FATAL: ' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
