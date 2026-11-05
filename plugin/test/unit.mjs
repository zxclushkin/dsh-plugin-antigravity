// language: JavaScript (ESM), file: plugin/test/unit.mjs, runtime: Node >= 20
// Offline checks for the native DSH adapter: protocol translation, chunk protocol,
// model metadata, error classification. No network, no Antigravity installation.
//   node plugin/test/unit.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { apply, Config, inject, name } from '../index.mjs';
import { toModelInfo, prettyModelName, AntigravityAdapter } from '../src/adapter.mjs';
import {
  buildContents, buildGenerateRequest, convertSchema, convertThinking, convertToolDeclarations,
  decodeToolCallId, encodeToolCallId, groundingText, mapFinishReason, mapUsage,
} from '../src/gemini.mjs';
import { AntigravityError, httpError, transportError } from '../src/errors.mjs';
import { createImageGenerator, imageMarkdown } from '../src/imagegen.mjs';
import { createSearchTool, groundedSearch, SEARCH_TOOL_NAME } from '../src/search.mjs';
import { createStatusRoutes, createStatusService } from '../src/status.mjs';
import { createThrottle } from '../src/throttle.mjs';
import { imageToolDefinition, IMAGE_TOOL_NAME } from '../src/tool.mjs';

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log('ok   ' + label);
  } catch (error) {
    console.error('FAIL ' + label + ': ' + (error && error.message ? error.message : error));
    process.exitCode = 1;
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    passed++;
    console.log('ok   ' + label);
  } catch (error) {
    console.error('FAIL ' + label + ': ' + (error && error.message ? error.message : error));
    process.exitCode = 1;
  }
}

/* ---------------------------------------------------------- plugin contract */

check('plugin exports name/inject/Config/apply', () => {
  assert.equal(typeof name, 'string');
  assert.deepEqual(inject, ['llm', 'tools']);
  assert.equal(typeof apply, 'function');
  assert.equal(Config['~standard'].version, 1);
});

check('Config applies defaults and validates features', () => {
  const { value } = Config['~standard'].validate({});
  assert.equal(value.enabled, true);
  assert.equal(value.userAgent, 'antigravity/2.29.0');
  assert.deepEqual(value.features, {});
  const withFeatures = Config['~standard'].validate({
    features: { googleSearch: true, imageAspectRatio: '16:9', thinkingBudgets: { low: 512 } },
  });
  assert.equal(withFeatures.issues, undefined);
  assert.equal(withFeatures.value.features.googleSearch, true);
  assert.equal(withFeatures.value.features.thinkingBudgets.low, 512);
});

check('Config rejects bad input', () => {
  assert.ok(Config['~standard'].validate({ nope: 1 }).issues);
  assert.ok(Config['~standard'].validate({ features: { googleSearch: 'yes' } }).issues);
  assert.ok(Config['~standard'].validate({ features: { defaultThinkingLevel: 'extreme' } }).issues);
  assert.ok(Config['~standard'].validate({ features: { unknown: true } }).issues);
});

/* ------------------------------------------------------------ model metadata */

check('model names are derived from ids', () => {
  assert.equal(prettyModelName('gemini-3-flash'), 'Gemini 3 Flash');
  assert.equal(prettyModelName('claude-opus-5-5-high'), 'Claude Opus 5.5 (High)');
  assert.equal(prettyModelName('gpt-oss-120b-medium'), 'GPT-OSS 120B (Medium)');
  assert.equal(prettyModelName('gemini-2.5-flash-lite'), 'Gemini 2.5 Flash Lite');
});

check('catalogue entry becomes valid harness model info', () => {
  const info = toModelInfo({
    id: 'gemini-3-flash', supportsImages: true, supportsThinking: true,
    contextWindow: 1048576, maxTokens: 65536, kind: 'chat',
  });
  assert.equal(info.provider, 'antigravity');
  assert.equal(info.id, 'gemini-3-flash');
  assert.equal(info.name, 'Gemini 3 Flash');
  assert.deepEqual(info.inputModalities, ['text', 'image']);
  assert.deepEqual(info.context, { contextWindow: 1048576 });
  assert.equal(info.defaultMaxTokens, 65536);
  assert.equal(info.reasoning.defaultEffort, 'medium');
  assert.deepEqual(info.reasoning.efforts.map((effort) => effort.id), ['low', 'medium', 'high']);
  const image = toModelInfo({ id: 'gemini-3.1-flash-image', kind: 'image', supportsImages: true, contextWindow: 1000, maxTokens: 100 });
  assert.equal(image.reasoning, undefined);
  assert.deepEqual(image.inputModalities, ['text', 'image']);
});

/* --------------------------------------------------------------- schemas */

check('JSON schema becomes a Gemini schema', () => {
  const schema = convertSchema({
    type: 'object',
    additionalProperties: false,
    properties: {
      city: { type: 'string', description: 'City name' },
      units: { type: 'string', enum: ['c', 'f'] },
      layers: { type: 'array', items: { type: 'integer' } },
      nested: { type: 'object', properties: { flag: { type: 'boolean', default: true } }, required: ['flag', 'ghost'] },
    },
    required: ['city', 'ghost'],
    default: {},
    examples: [{}],
  });
  assert.equal(schema.type, 'OBJECT');
  assert.equal(schema.properties.city.type, 'STRING');
  assert.deepEqual(schema.properties.units.enum, ['c', 'f']);
  assert.equal(schema.properties.layers.items.type, 'INTEGER');
  assert.deepEqual(schema.required, ['city']);
  assert.equal('additionalProperties' in schema, false);
  assert.equal('default' in schema, false);
  assert.deepEqual(schema.properties.nested.required, ['flag']);
});

check('no-argument tools are declared without parameters', () => {
  const tools = convertToolDeclarations([
    { name: 'ping' },
    { name: 'ping2', parameters: { type: 'object', properties: {} } },
    { name: 'get', parameters: { type: 'object', properties: { id: { type: 'string' } } } },
    { name: 'deferred', deferLoading: true, parameters: { type: 'object', properties: { x: { type: 'string' } } } },
  ]);
  assert.equal(tools.length, 3);
  assert.equal(tools[0].parameters, undefined);
  assert.equal(tools[1].parameters, undefined);
  assert.equal(tools[2].parameters.type, 'OBJECT');
  assert.deepEqual(tools[2].parameters.properties.id, { type: 'STRING' });
});

/* -------------------------------------------------------------- thinking */

check('reasoning effort maps to thinkingConfig', () => {
  const levelModel = { thinkingStyle: 'level' };
  assert.deepEqual(convertThinking('low', levelModel, {}), { includeThoughts: true, thinkingLevel: 'LOW' });
  assert.deepEqual(convertThinking('high', levelModel, {}), { includeThoughts: true, thinkingLevel: 'HIGH' });
  assert.equal(convertThinking(undefined, levelModel, {}), undefined);
  const budgetModel = { thinkingStyle: 'budget' };
  assert.deepEqual(convertThinking('medium', budgetModel, {}), { includeThoughts: true, thinkingBudget: 4096 });
  assert.deepEqual(convertThinking('low', budgetModel, { thinkingBudgets: { low: 77 } }), { includeThoughts: true, thinkingBudget: 77 });
  assert.deepEqual(convertThinking(undefined, levelModel, { defaultThinkingLevel: 'high' }),
    { includeThoughts: true, thinkingLevel: 'HIGH' });
});

/* --------------------------------------------------------------- tool ids */

check('thoughtSignature survives a tool-call id round-trip', () => {
  const signature = 'EmcKZQFpFH0T+/abc==';
  const id = encodeToolCallId('call_123', signature);
  const back = decodeToolCallId(id);
  assert.equal(back.upstreamId, 'call_123');
  assert.equal(back.signature, signature);
  assert.equal(encodeToolCallId('call_456', undefined), 'call_456');
  assert.equal(decodeToolCallId('call_456').signature, undefined);
});

/* -------------------------------------------------------------- messages */

await checkAsync('harness messages become Gemini contents', async () => {
  const callId = encodeToolCallId('call_77', 'SIG');
  const { contents, systemInstruction } = await buildContents({
    system: 'be terse',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'second system line' }] },
      { role: 'user', content: [{ type: 'text', text: 'weather in Moscow?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'reasoning', text: 'inner monologue' },
          { type: 'tool-call', id: callId, name: 'get_weather', arguments: '{"city":"Moscow"}' },
        ],
      },
      { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: '{"tempC":-3}' }], isError: false },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'thanks' },
          { type: 'image', attachment: { attachmentId: 'sha256:x', width: 10, height: 10, mediaType: 'image/png' } },
        ],
      },
    ],
  }, async (block) => ({ mimeType: block.attachment.mediaType, data: 'AAAA' }));

  assert.deepEqual(systemInstruction.parts[0].text, 'be terse\n\nsecond system line');
  assert.deepEqual(contents.map((entry) => entry.role), ['user', 'model', 'user']);
  assert.deepEqual(contents[0].parts[0], { text: 'weather in Moscow?' });
  assert.equal(contents[1].parts[0].text, 'Checking.');
  assert.equal(contents[1].parts.length, 2, 'reasoning blocks are not replayed');
  const call = contents[1].parts[1].functionCall;
  assert.equal(call.name, 'get_weather');
  assert.equal(call.id, 'call_77');
  assert.deepEqual(call.args, { city: 'Moscow' });
  assert.equal(contents[1].parts[1].thoughtSignature, 'SIG');
  const response = contents[2].parts[0].functionResponse;
  assert.equal(response.name, 'get_weather');
  assert.equal(response.id, 'call_77');
  assert.deepEqual(response.response, { tempC: -3 });
  assert.deepEqual(contents[2].parts[0].functionResponse, response);
  assert.deepEqual(contents[2].parts[1], { text: 'thanks' });
  assert.deepEqual(contents[2].parts[2], { inlineData: { mimeType: 'image/png', data: 'AAAA' } });
});

/* --------------------------------------------------------------- request */

await checkAsync('generate request carries tools, thinking and config', async () => {
  const { request } = await buildGenerateRequest({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'get_weather', description: 'd', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
    reasoningEffort: 'high',
    temperature: 0.3,
    maxTokens: 2048,
    stop: ['END'],
  }, { id: 'gemini-3-flash', thinkingStyle: 'level' }, { googleSearch: true }, async () => null);

  // The endpoint rejects googleSearch together with functionDeclarations: tools win.
  assert.equal(request.tools.length, 1);
  assert.equal(request.tools[0].functionDeclarations[0].name, 'get_weather');
  assert.equal(request.toolConfig, undefined);
  assert.equal(request.generationConfig.temperature, 0.3);
  assert.equal(request.generationConfig.maxOutputTokens, 2048);
  assert.deepEqual(request.generationConfig.stopSequences, ['END']);
  assert.deepEqual(request.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: 'HIGH' });

  const grounded = await buildGenerateRequest({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }, { id: 'gemini-3-flash', thinkingStyle: 'level' }, { googleSearch: true }, async () => null);
  assert.deepEqual(grounded.request.tools, [{ googleSearch: {} }]);
});

await checkAsync('structured output and image config', async () => {
  const structured = await buildGenerateRequest({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'json please' }] }],
  }, { id: 'gemini-3-flash', thinkingStyle: 'level' }, {
    responseSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  }, async () => null);
  assert.equal(structured.request.generationConfig.responseMimeType, 'application/json');
  assert.equal(structured.request.generationConfig.responseSchema.type, 'OBJECT');

  const image = await buildGenerateRequest({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a red circle' }] }],
    maxTokens: 4096,
  }, { id: 'gemini-3.1-flash-image', kind: 'image' }, {}, async () => null);
  assert.deepEqual(image.request.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
  assert.deepEqual(image.request.generationConfig.imageConfig, { aspectRatio: '1:1' });
});

/* -------------------------------------------------------------- response */

check('usage and finish mapping', () => {
  assert.deepEqual(
    mapUsage({ promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, cachedContentTokenCount: 40, totalTokenCount: 125 }),
    { inputTokens: 100, outputTokens: 25, totalTokens: 125, cacheReadTokens: 40 },
  );
  assert.deepEqual(mapFinishReason({ finishReason: 'STOP' }, true), { kind: 'stop' });
  assert.deepEqual(mapFinishReason({ finishReason: 'MAX_TOKENS' }, true), { kind: 'max-tokens' });
  assert.deepEqual(mapFinishReason({}, false),
    { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'model returned a completed response with no content' } });
  assert.equal(groundingText({ groundingChunks: [{ web: { uri: 'https://a.example', title: 'A' } }] }),
    '\n\nSources:\n[1] A — https://a.example');
  assert.equal(groundingText(null), '');
});

check('errors carry harness failure facts', () => {
  const error = httpError(401, '{"error":{"message":"bad token"}}');
  assert.equal(error.code, 'AUTH');
  assert.equal(error.failure.code, 'AUTH');
  assert.equal(error.failure.status, 401);
  assert.equal(httpError(429, '{"error":{"message":"QUOTA_EXHAUSTED"}}').code, 'QUOTA');
  assert.equal(httpError(503, 'MODEL_CAPACITY_EXHAUSTED').code, 'SERVER');
  assert.equal(httpError(400, 'Request contains an invalid argument.').code, 'INVALID_REQUEST');
  assert.equal(transportError(new Error('socket hang up')).code, 'TRANSPORT');
  assert.equal(transportError(new Error('The operation was aborted'), { aborted: true }).code, 'ABORTED');
  assert.ok(new AntigravityError('x', 'AUTH') instanceof Error);
});

/* ------------------------------------------------------- adapter streaming */

function stubClient(events, models) {
  return {
    host: 'stub',
    fetchModels: async () => ({ models, defaultModelId: 'gemini-3-flash' }),
    async *streamEvents() { for (const event of events) yield event; },
    async openStream() { return { ok: true, status: 200, body: {} }; },
  };
}

async function collectChunks(adapter, options) {
  const chunks = [];
  for await (const chunk of adapter.stream(options)) chunks.push(chunk);
  return chunks;
}

const catalogue = {
  'gemini-3-flash': { id: 'gemini-3-flash', supportsImages: true, supportsThinking: true, contextWindow: 1048576, maxTokens: 65536 },
};
const ask = { provider: 'antigravity', model: 'gemini-3-flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };

await checkAsync('stream emits harness chunks (text, reasoning, tool call)', async () => {
  const events = [
    { type: 'text', text: 'Hello ' },
    { type: 'thought', text: 'thinking' },
    { type: 'text', text: 'world' },
    { type: 'toolCall', call: { name: 'ping', args: { a: 1 }, id: 'call_9' }, thoughtSignature: 'SIG' },
    { type: 'usage', usage: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } },
    { type: 'candidate', candidate: { finishReason: 'STOP' } },
  ];
  const adapter = new AntigravityAdapter({ client: stubClient(events, catalogue), config: { features: {} } });
  const chunks = await collectChunks(adapter, ask);
  assert.deepEqual(chunks.map((chunk) => chunk.type),
    ['text-delta', 'reasoning-delta', 'text-delta', 'tool-call-delta', 'usage', 'finish']);
  assert.equal(chunks[0].text, 'Hello ');
  assert.equal(chunks[1].text, 'thinking');
  assert.equal(chunks[3].name, 'ping');
  assert.equal(chunks[3].argumentsDelta, '{"a":1}');
  assert.equal(decodeToolCallId(chunks[3].id).signature, 'SIG');
  assert.deepEqual(chunks[4].usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  assert.deepEqual(chunks[5].reason, { kind: 'stop' });
});

await checkAsync('stream reports empty responses as failures', async () => {
  const events = [{ type: 'candidate', candidate: { finishReason: 'STOP' } }];
  const adapter = new AntigravityAdapter({ client: stubClient(events, catalogue), config: { features: {} } });
  const chunks = await collectChunks(adapter, ask);
  assert.equal(chunks[chunks.length - 1].reason.kind, 'error');
  assert.equal(chunks[chunks.length - 1].reason.failure.code, 'EMPTY_RESPONSE');
});

await checkAsync('stream saves generated media and links it', async () => {
  const events = [
    { type: 'media', part: { inlineData: { mimeType: 'image/jpeg', data: Buffer.from('jpegbytes').toString('base64') } } },
    { type: 'candidate', candidate: { finishReason: 'STOP' } },
  ];
  const imageCatalogue = { 'gemini-3.1-flash-image': { id: 'gemini-3.1-flash-image', supportsImages: true, kind: 'image' } };
  const adapter = new AntigravityAdapter({
    client: stubClient(events, imageCatalogue),
    config: { features: { mediaOutputDir: 'C:/lab/antigravity/.tmp/test-media' } },
  });
  const chunks = await collectChunks(adapter, { ...ask, model: 'gemini-3.1-flash-image' });
  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
  assert.match(text, /!\[[^\]]+\]\(.+\.jpeg\)/);
  assert.match(text, /\(C:\/lab\/antigravity\/\.tmp\/test-media\//); // forward slashes for markdown
});

await checkAsync('listModels and resolveModel expose the catalogue', async () => {
  const adapter = new AntigravityAdapter({ client: stubClient([], catalogue), config: { features: {} } });
  const models = await adapter.listModels('antigravity');
  assert.deepEqual(models, [{
    provider: 'antigravity',
    id: 'gemini-3-flash',
    name: 'Gemini 3 Flash',
    description: 'Antigravity model',
    inputModalities: ['text', 'image'],
  }]);
  const info = await adapter.resolveModel('antigravity', 'gemini-3-flash');
  assert.equal(info.id, 'gemini-3-flash');
  assert.equal(info.context.contextWindow, 1048576);
  await assert.rejects(() => adapter.resolveModel('antigravity', 'nope'), /does not offer model/);
  assert.equal(adapter.providerRetryPolicy('antigravity'), undefined);
  assert.deepEqual(adapter.providerInfo('antigravity'), { id: 'antigravity', name: 'Antigravity' });
  // Context compaction calls these before a model switch; a missing method fails the switch.
  assert.equal(typeof adapter.imageRequestPricing, 'function');
  assert.equal(adapter.imageRequestPricing('antigravity', 'gemini-3-flash'), undefined);
  assert.equal(typeof adapter.imageRequestTarget, 'function');
  assert.deepEqual(adapter.imageRequestTarget('antigravity', 'gemini-3-flash', { width: 10, height: 20, bytes: 100 }),
    { width: 10, height: 20, maxBytes: 100 });
  const prepared = await adapter.prepareCall('antigravity', 'gemini-3-flash');
  assert.equal(prepared.model.id, 'gemini-3-flash');
  assert.equal(typeof prepared.stream, 'function');
});

/* ------------------------------------------------------------ image tool */

check('image tool definition fits the harness schema subset', () => {
  const generator = { aspectRatios: ['1:1', '16:9'] };
  const tool = imageToolDefinition({ generator, config: { features: {} }, log: () => {} });
  assert.equal(tool.name, IMAGE_TOOL_NAME);
  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(tool.parameters.required, ['prompt']);
  assert.deepEqual(tool.parameters.properties.aspect_ratio.enum, ['1:1', '16:9']);
  assert.ok(tool.parameters.properties.prompt.description);
  assert.equal(typeof tool.output.render, 'function');
  assert.equal(tool.output.schema.type, 'object');
  // The registry subset is type/oneOf/properties/required/additionalProperties/items/enum/const.
  const allowed = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title']);
  const walk = (node) => {
    for (const key of Object.keys(node)) assert.ok(allowed.has(key), 'unsupported schema keyword ' + key);
    for (const child of Object.values(node.properties || {})) walk(child);
    if (node.items) walk(node.items);
  };
  walk(tool.parameters);
  walk(tool.output.schema);
  const blocks = tool.output.render({}, { images: [{ path: 'C:/tmp/a.png' }], text: 'a cat' });
  const text = blocks.map((block) => block.text).join('\n');
  assert.match(text, /a cat/);
  assert.match(text, /!\[a\.png\]\(C:\/tmp\/a\.png\)/);
  assert.match(text, /C:\/tmp\/a\.png/);
});

function imageStub(events) {
  return {
    host: 'stub',
    fetchModels: async () => ({ models: {}, imageModels: { 'gemini-3.1-flash-image': {} }, defaultModelId: null }),
    async openStream() { return { ok: true, status: 200, body: {} }; },
    async *streamEvents() { for (const event of events) yield event; },
  };
}

await checkAsync('image generator saves the generated image', async () => {
  const dir = 'C:/lab/antigravity/.tmp/test-imagegen';
  const events = [
    { type: 'text', text: 'Here is a cat.' },
    { type: 'media', part: { inlineData: { mimeType: 'image/jpeg', data: Buffer.from('jpegbytes').toString('base64') } } },
    { type: 'candidate', candidate: { finishReason: 'STOP' } },
  ];
  const generator = createImageGenerator({
    client: imageStub(events),
    adapter: { loadCatalogue: async () => ({ imageModels: { 'gemini-3.1-flash-image': {} } }) },
    config: { features: { mediaOutputDir: dir } },
    log: () => {},
  });
  const result = await generator.generate({ prompt: 'a cat', aspectRatio: '16:9' });
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].mimeType, 'image/jpeg');
  assert.ok(fs.existsSync(result.images[0].path));
  assert.ok(result.images[0].bytes > 0);
  assert.equal(result.text, 'Here is a cat.');
  const basename = result.images[0].path.split(/[\\/]/).pop();
  assert.equal(imageMarkdown(result.images[0].path),
    '![' + basename + '](' + result.images[0].path.replace(/\\/g, '/') + ')');
});

await checkAsync('image refusal is reported as a failure', async () => {
  const generator = createImageGenerator({
    client: imageStub([{ type: 'finishMessage', message: 'Unable to show the generated image.' }]),
    adapter: { loadCatalogue: async () => ({ imageModels: { 'gemini-3.1-flash-image': {} } }) },
    config: { features: { mediaOutputDir: 'C:/lab/antigravity/.tmp/test-imagegen' } },
    log: () => {},
  });
  await assert.rejects(() => generator.generate({ prompt: 'a cat' }), (error) => {
    assert.equal(error.code, 'EMPTY_RESPONSE');
    assert.match(error.message, /Unable to show/);
    return true;
  });
  const badRatio = createImageGenerator({
    client: imageStub([]),
    adapter: { loadCatalogue: async () => ({ imageModels: {} }) },
    config: { features: {} },
    log: () => {},
  });
  await assert.rejects(() => badRatio.generate({ prompt: 'x', aspectRatio: '7:3' }), /unsupported aspect ratio/);
  await assert.rejects(() => badRatio.generate({ prompt: '  ' }), /must not be empty/);
});

/* --------------------------------------------------------- settings GUI API */

function statusStub() {
  return {
    host: 'https://example.invalid',
    fetchAccount: async () => ({ project: 'demo-project', tier: 'free-tier', tierName: 'Antigravity', paidTier: undefined }),
    fetchQuotaBuckets: async () => [
      { modelId: 'gemini-3-flash', remainingFraction: 0.97, resetTime: '2026-11-05T13:00:00Z' },
      { modelId: 'gemini-3.1-flash-image', remainingFraction: 0.2, resetTime: '2026-11-05T13:00:00Z' },
    ],
    loadCatalogue: async () => ({
      models: { 'gemini-3-flash': { id: 'gemini-3-flash', name: 'Gemini 3 Flash', contextWindow: 1048576, maxTokens: 65536, supportsImages: true, supportsThinking: true } },
      imageModels: { 'gemini-3.1-flash-image': { id: 'gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image' } },
    }),
    fetchModels: async () => ({ models: {}, imageModels: {}, defaultModelId: null }),
    async openStream() { return { ok: true, status: 200, body: {} }; },
    async *streamEvents() {},
  };
}

const guiConfig = {
  credentialTarget: 'gemini:antigravity',
  userAgent: 'antigravity/2.29.0',
  features: { googleSearch: false, imageGen: true, mediaOutputDir: 'C:/lab/antigravity/.tmp/gui-media' },
};

function mockResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers || {}; return this; },
    end(body) { if (body !== undefined) this.body += Buffer.isBuffer(body) ? body.toString('utf8') : String(body); },
  };
}

function mockGet(url) {
  return { method: 'GET', url };
}

function mockPost(url, body) {
  const buffer = Buffer.from(JSON.stringify(body));
  return {
    method: 'POST',
    url,
    async *[Symbol.asyncIterator]() { yield buffer; },
  };
}

await checkAsync('status service reports account, quota and catalogue', async () => {
  const service = createStatusService({ client: statusStub(), adapter: statusStub(), config: guiConfig, log: () => {} });
  const snapshot = await service.snapshot();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.account.project, 'demo-project');
  assert.equal(snapshot.quotas.length, 2);
  assert.equal(snapshot.quotas[0].remainingFraction, 0.97);
  assert.equal(snapshot.models.length, 2);
  assert.equal(snapshot.models.filter((model) => model.kind === 'image').length, 1);
  assert.equal(snapshot.features.imageGen, true);
  assert.equal(snapshot.cached, false);
  const cached = await service.snapshot();
  assert.equal(cached.cached, true);
  const refreshed = await service.snapshot({ refresh: true });
  assert.equal(refreshed.cached, false);
});

await checkAsync('status route answers JSON', async () => {
  const service = createStatusService({ client: statusStub(), adapter: statusStub(), config: guiConfig, log: () => {} });
  const generator = { generate: async () => ({ images: [{ path: 'C:/tmp/x.jpeg', mimeType: 'image/jpeg', bytes: 10 }], text: '', model: 'img' }) };
  const routes = createStatusRoutes({ service, generator, config: guiConfig, log: () => {} });
  const statusRoute = routes.find((route) => route.path === '/antigravity/status');
  assert.equal(statusRoute.kind, 'exact');
  const res = mockResponse();
  await statusRoute.handler(mockGet('/antigravity/status'), res);
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.account.tier, 'free-tier');
});

await checkAsync('test-image route returns a saved image', async () => {
  const service = createStatusService({ client: statusStub(), adapter: statusStub(), config: guiConfig, log: () => {} });
  let seen = null;
  const generator = {
    generate: async (request) => {
      seen = request;
      return { images: [{ path: 'C:/lab/antigravity/.tmp/gui-media/ag-1.jpeg', mimeType: 'image/jpeg', bytes: 123 }], text: '', model: 'gemini-3.1-flash-image' };
    },
  };
  const routes = createStatusRoutes({ service, generator, config: guiConfig, log: () => {} });
  const route = routes.find((item) => item.path === '/antigravity/test-image');
  const res = mockResponse();
  await route.handler(mockPost('/antigravity/test-image', { prompt: 'a red circle' }), res);
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.images[0].name, 'ag-1.jpeg');
  assert.match(payload.images[0].markdown, /!\[ag-1\.jpeg\]/);
  assert.equal(seen.prompt, 'a red circle');

  const failure = mockResponse();
  const failing = createStatusRoutes({
    service, config: guiConfig, log: () => {},
    generator: { generate: async () => { throw new Error('QUOTA exhausted'); } },
  }).find((item) => item.path === '/antigravity/test-image');
  await failing.handler(mockPost('/antigravity/test-image', {}), failure);
  assert.equal(JSON.parse(failure.body).ok, false);
  assert.match(JSON.parse(failure.body).error, /QUOTA/);
});

await checkAsync('media route serves only image files from the output directory', async () => {
  const dir = 'C:/lab/antigravity/.tmp/gui-media';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + '/ag-test.png', Buffer.from('pngbytes'));
  const service = createStatusService({ client: statusStub(), adapter: statusStub(), config: guiConfig, log: () => {} });
  const routes = createStatusRoutes({ service, generator: {}, config: guiConfig, log: () => {} });
  const route = routes.find((item) => item.path === '/antigravity/media/');
  assert.equal(route.kind, 'prefix');
  const ok = mockResponse();
  await route.handler(mockGet('/antigravity/media/ag-test.png'), ok);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['Content-Type'], 'image/png');
  const blocked = mockResponse();
  await route.handler(mockGet('/antigravity/media/..%2Fescape.txt'), blocked);
  assert.equal(blocked.status, 404);
});

await checkAsync('config route edits features through the harness config editor', async () => {
  const service = createStatusService({ client: statusStub(), adapter: statusStub(), config: guiConfig, log: () => {} });
  const edits = [];
  const configEditor = {
    entries: () => [{ id: 'antigravity-llm' }],
    edit: async (entry, change) => {
      const next = change({ enabled: true, features: { googleSearch: false, imageGen: true } });
      edits.push({ entry, next });
    },
  };
  const routes = createStatusRoutes({
    service, generator: {}, config: guiConfig, log: () => {},
    getConfigEditor: () => configEditor,
  });
  const route = routes.find((item) => item.path === '/antigravity/config');
  const ok = mockResponse();
  await route.handler(mockPost('/antigravity/config', { features: { googleSearch: true, imageGen: false, defaultThinkingLevel: 'high' } }), ok);
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).ok, true);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].next.features.googleSearch, true);
  assert.equal(edits[0].next.features.imageGen, false);
  assert.equal(edits[0].next.features.defaultThinkingLevel, 'high');

  const rejected = mockResponse();
  await route.handler(mockPost('/antigravity/config', { features: { mediaOutputDir: 'C:/evil' } }), rejected);
  assert.equal(rejected.status, 400);
  assert.match(JSON.parse(rejected.body).error, /not editable/);

  const noEditor = mockResponse();
  const bare = createStatusRoutes({ service, generator: {}, config: guiConfig, log: () => {} })
    .find((item) => item.path === '/antigravity/config');
  await bare.handler(mockPost('/antigravity/config', { features: { imageGen: true } }), noEditor);
  assert.equal(noEditor.status, 501);
});

await checkAsync('client bundle registers the settings section', async () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  let definition = null;
  const window = { __ModuleLoader__: { load(value) { definition = value; } } };
  // The bundle is a browser script, not an ES module: evaluate it against a stub window.
  new Function('window', source)(window);
  assert.equal(definition.id, 'dsh-plugin-antigravity');
  assert.equal(typeof definition.factory, 'function');

  const React = {
    createElement: (...args) => ({ args }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  };
  const moduleExports = definition.factory((name) => {
    assert.equal(name, 'react');
    return React;
  });
  assert.deepEqual(moduleExports.inject, ['slots']);
  assert.equal(typeof moduleExports.apply, 'function');

  let injectedSlot = null;
  let registration = null;
  moduleExports.apply({
    slots: {
      inject(slot, callback) { injectedSlot = slot; callback(); },
      register(options, component) { registration = { options, component }; return () => {}; },
    },
  });
  assert.equal(injectedSlot, 'settings.section');
  assert.equal(registration.options.id, 'antigravity');
  assert.equal(registration.options.order, 30);
  assert.equal(registration.options.label, 'Antigravity');
  assert.equal(typeof registration.component, 'function');
});

await checkAsync('image model ignores agent tools and keeps an image-sized output budget', async () => {
  const options = {
    provider: 'antigravity',
    model: 'gemini-3.1-flash-image',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'draw a cat' }] }],
    tools: [{ name: 'ping', description: 'noop' }],
    maxTokens: 256,
  };
  const buildOptions = {
    log: () => {},
    sessionId: 's',
  };
  const imageModel = {
    id: 'gemini-3.1-flash-image', kind: 'image', thinkingStyle: 'level', maxTokens: 65536,
  };
  const imageRequest = await buildGenerateRequest(
    options, imageModel, {}, async () => null);
  assert.equal(imageRequest.request.tools, undefined, 'image model must not receive function declarations');
  assert.ok(imageRequest.request.generationConfig.maxOutputTokens >= 4096,
    'image model needs an output budget large enough for the pixels');

  const chatRequest = await buildGenerateRequest(
    options,
    { id: 'gemini-3-flash', kind: 'chat', thinkingStyle: 'level', maxTokens: 65536 },
    {}, async () => null);
  assert.ok(chatRequest.request.tools, 'chat models keep the tool list');
  assert.equal(chatRequest.request.generationConfig.maxOutputTokens, 256);
});

/* ------------------------------------------------- throttle / search / editing */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

await checkAsync('throttle limits concurrency and queues the rest', async () => {
  const throttle = createThrottle({ maxConcurrent: 1 });
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const first = throttle.run(async () => { await gate; return 'a'; });
  await tick();
  const second = throttle.run(async () => 'b');
  await tick();
  assert.equal(throttle.state().active, 1);
  assert.equal(throttle.state().queued, 1);
  release();
  assert.equal(await first, 'a');
  assert.equal(await second, 'b');
  assert.equal(throttle.state().active, 0);
});

await checkAsync('throttle spaces requests and honours the 429 cooldown', async () => {
  let clock = 0;
  const slept = [];
  const throttle = createThrottle({
    maxConcurrent: 2,
    minIntervalMs: 100,
    cooldownMs: 5_000,
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
  });
  await throttle.run(async () => 1);
  await throttle.run(async () => 2);
  assert.ok(slept.some((ms) => ms >= 100), 'second request waited for the interval');

  throttle.noteRateLimit(4_000);
  assert.ok(throttle.state().cooldownUntil, 'cooldown is armed');
  slept.length = 0;
  await throttle.run(async () => 3);
  assert.ok(slept.length > 0, 'a request waits out the cooldown');
  assert.equal(throttle.state().cooldownUntil, null);
});

check('search tool fits the harness schema subset', () => {
  const tool = createSearchTool({ client: {}, config: { features: {} }, log: () => {} });
  assert.equal(tool.name, SEARCH_TOOL_NAME);
  assert.deepEqual(tool.parameters.required, ['query']);
  assert.equal(tool.output.schema.type, 'object');
  const blocks = tool.output.render({}, {
    answer: 'Paris is the capital.',
    sources: [{ title: 'Example', uri: 'https://example.com' }],
  });
  const text = blocks.map((block) => block.text).join('\n');
  assert.match(text, /Paris is the capital/);
  assert.match(text, /\[1\] Example — https:\/\/example\.com/);
});

await checkAsync('groundedSearch parses answer, sources and queries', async () => {
  const client = {
    openStream: async () => ({ ok: true, status: 200, body: {} }),
    async *streamEvents() {
      yield { type: 'text', text: 'Lando Norris ' };
      yield { type: 'text', text: 'won the 2025 title.' };
      yield {
        type: 'grounding',
        metadata: {
          webSearchQueries: ['2025 f1 champion'],
          groundingChunks: [
            { web: { uri: 'https://a.example', title: 'A' } },
            { web: { uri: 'https://a.example', title: 'A duplicate' } },
            { web: { uri: 'https://b.example', title: 'B' } },
          ],
        },
      };
    },
  };
  const result = await groundedSearch({ client, model: 'gemini-3.5-flash-lite', query: 'who won f1 2025' });
  assert.equal(result.text, 'Lando Norris won the 2025 title.');
  assert.equal(result.sources.length, 2, 'sources are de-duplicated by uri');
  assert.deepEqual(result.queries, ['2025 f1 champion']);
});

await checkAsync('image generator sends a reference image when editing', async () => {
  const dir = 'C:/lab/antigravity/.tmp/test-imagegen';
  fs.mkdirSync(dir, { recursive: true });
  const reference = dir + '/reference.png';
  fs.writeFileSync(reference, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  let sent = null;
  const client = {
    async openStream(request) {
      sent = request;
      return { ok: true, status: 200, body: {} };
    },
    async *streamEvents() {
      yield { type: 'media', part: { inlineData: { mimeType: 'image/jpeg', data: Buffer.from('out').toString('base64') } } };
    },
  };
  const generator = createImageGenerator({
    client,
    adapter: { loadCatalogue: async () => ({ imageModels: { 'gemini-3.1-flash-image': {} } }) },
    config: { features: { mediaOutputDir: dir } },
    log: () => {},
  });
  const result = await generator.generate({ prompt: 'make it blue', referencePath: reference });
  assert.equal(result.images.length, 1);
  const parts = sent.request.contents[0].parts;
  assert.equal(parts[0].inlineData.mimeType, 'image/png');
  assert.equal(parts[0].inlineData.data, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));
  assert.equal(parts[1].text, 'make it blue');
  assert.equal(sent.retries, 2, 'tool sub-calls keep a couple of retries');
  await assert.rejects(() => generator.generate({ prompt: 'x', referencePath: dir + '/missing.png' }), /does not exist/);
  fs.writeFileSync(dir + '/bad.txt', 'x');
  await assert.rejects(() => generator.generate({ prompt: 'x', referencePath: dir + '/bad.txt' }), /must be a \.png/);
});

await checkAsync('adapter records the last failure and arms the cooldown', async () => {
  const throttle = createThrottle({ maxConcurrent: 1, cooldownMs: 1_000 });
  const failingClient = {
    host: 'stub',
    fetchModels: async () => ({ models: { 'gemini-3-flash': { id: 'gemini-3-flash' } }, defaultModelId: null }),
    async openStream() {
      const error = new Error('upstream 429');
      error.status = 429;
      error.body = '{"error":{"message":"QUOTA_EXHAUSTED"}}';
      throw error;
    },
    async *streamEvents() {},
  };
  const adapter = new AntigravityAdapter({ client: failingClient, config: { features: {} }, throttle, log: () => {} });
  await assert.rejects(() => collectChunks(adapter, {
    provider: 'antigravity', model: 'gemini-3-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }));
  assert.equal(adapter.lastError.code, 'QUOTA');
  assert.ok(throttle.state().cooldownUntil, 'the failure armed the shared cooldown');
});

await checkAsync('config accepts the new throttle keys and search feature', async () => {
  const result = Config['~standard'].validate({
    maxConcurrentRequests: 3,
    minRequestIntervalMs: 250,
    rateLimitCooldownMs: 30_000,
    features: { googleSearchTool: true, searchModel: 'gemini-3.5-flash-lite' },
  });
  assert.equal(result.issues, undefined);
  assert.equal(result.value.maxConcurrentRequests, 3);
  assert.equal(result.value.minRequestIntervalMs, 250);
  assert.equal(result.value.rateLimitCooldownMs, 30_000);
  assert.equal(result.value.features.googleSearchTool, true);
  assert.ok(Config['~standard'].validate({ maxConcurrentRequests: 0 }).issues);
  assert.ok(Config['~standard'].validate({ minRequestIntervalMs: -1 }).issues);
});

await checkAsync('status snapshot exposes version, tools, limits and last error', async () => {
  const service = createStatusService({
    client: statusStub(),
    adapter: statusStub(),
    config: { ...guiConfig, maxConcurrentRequests: 2, minRequestIntervalMs: 0, rateLimitCooldownMs: 60_000 },
    log: () => {},
    meta: () => ({ version: '0.5.0', tools: ['image_generate', 'google_search'], throttle: { active: 0, queued: 0 }, lastError: null }),
  });
  const snapshot = await service.snapshot();
  assert.equal(snapshot.plugin.version, '0.5.0');
  assert.deepEqual(snapshot.plugin.tools, ['image_generate', 'google_search']);
  assert.equal(snapshot.limits.maxConcurrentRequests, 2);
  assert.equal(snapshot.limits.rateLimitCooldownMs, 60_000);
});

await checkAsync('test-search route returns answer and sources', async () => {
  const service = createStatusService({ client: statusStub(), adapter: statusStub(), config: guiConfig, log: () => {} });
  const routes = createStatusRoutes({
    service,
    generator: {},
    config: guiConfig,
    log: () => {},
    search: async (query) => ({
      text: 'answer for ' + query,
      sources: [{ title: 'Example', uri: 'https://example.com' }],
      queries: ['f1 2025'],
    }),
  });
  const route = routes.find((item) => item.path === '/antigravity/test-search');
  const ok = mockResponse();
  await route.handler(mockPost('/antigravity/test-search', { query: 'f1' }), ok);
  assert.equal(ok.status, 200);
  const payload = JSON.parse(ok.body);
  assert.equal(payload.answer, 'answer for f1');
  assert.equal(payload.sources.length, 1);
  assert.deepEqual(payload.queries, ['f1 2025']);

  const bare = createStatusRoutes({ service, generator: {}, config: guiConfig, log: () => {} })
    .find((item) => item.path === '/antigravity/test-search');
  const unavailable = mockResponse();
  await bare.handler(mockPost('/antigravity/test-search', { query: 'x' }), unavailable);
  assert.equal(unavailable.status, 501);
});

console.log('\n' + passed + ' checks passed');
