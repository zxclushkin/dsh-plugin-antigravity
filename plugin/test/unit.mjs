// language: JavaScript (ESM), file: plugin/test/unit.mjs, runtime: Node >= 20
// Offline checks: protocol translation, plugin contract, model filtering. No network,
// no Antigravity installation needed.   node plugin/test/unit.mjs
import assert from 'node:assert/strict';
import { apply, Config, inject, name } from '../index.mjs';
import {
  buildUpstreamRequest, convertSchema, convertToolChoice, convertTools, decodeToolCallId,
  finishReasonToOpenAi, makeToolCallId, openAiModelList, openAiUsage,
} from '../src/openai.mjs';
import { isChatModel } from '../src/server.mjs';

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
  assert.deepEqual(inject, []);
  assert.equal(typeof apply, 'function');
  assert.equal(Config['~standard'].version, 1);
});

check('Config applies defaults', () => {
  const { value } = Config['~standard'].validate({});
  assert.equal(value.host, '127.0.0.1');
  assert.equal(value.port, 8732);
  assert.equal(value.enabled, true);
});

check('Config rejects unknown keys and bad types', () => {
  assert.ok(Config['~standard'].validate({ nope: 1 }).issues);
  assert.ok(Config['~standard'].validate({ port: 'x' }).issues);
});

/* ------------------------------------------------------------- model filter */

check('model filter drops non-chat catalogue entries', () => {
  assert.equal(isChatModel('gemini-3-flash'), true);
  assert.equal(isChatModel('claude-opus-5-5-high'), true);
  assert.equal(isChatModel('tab_flash_lite_preview'), false);
  assert.equal(isChatModel('chat_23310'), false);
  assert.equal(isChatModel('gemini-3.1-flash-image'), false);
  assert.equal(isChatModel('gemini-3.8-flash-tiered'), false);
});

/* ------------------------------------------------------------ schema mapping */

check('JSON Schema becomes a Gemini schema', () => {
  const schema = convertSchema({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    properties: {
      city: { type: 'string', description: 'City name' },
      units: { type: 'string', enum: ['c', 'f'] },
      layers: { type: 'array', items: { type: 'integer' } },
      nested: {
        type: 'object',
        properties: { flag: { type: 'boolean', default: true } },
        required: ['flag', 'ghost'],
      },
    },
    required: ['city', 'ghost'],
    default: {},
    examples: [{}],
  });
  assert.equal(schema.type, 'OBJECT');
  assert.equal(schema.properties.city.type, 'STRING');
  assert.deepEqual(schema.properties.units.enum, ['c', 'f']);
  assert.equal(schema.properties.layers.type, 'ARRAY');
  assert.equal(schema.properties.layers.items.type, 'INTEGER');
  assert.deepEqual(schema.required, ['city']); // missing properties are dropped from required
  assert.equal('additionalProperties' in schema, false);
  assert.equal('$schema' in schema, false);
  assert.equal('default' in schema, false);
});

check('object without properties degrades to a string', () => {
  const schema = convertSchema({ type: 'object' });
  assert.equal(schema.type, 'STRING');
});

check('nullable and anyOf survive', () => {
  const schema = convertSchema({ anyOf: [{ type: 'string' }, { type: 'null' }] });
  assert.equal(schema.type, 'STRING');
  assert.equal(schema.nullable, true);
});

/* --------------------------------------------------------------- tool calls */

check('OpenAI tools become functionDeclarations', () => {
  const tools = convertTools([
    { type: 'function', function: { name: 'get_weather', description: 'd', parameters: { type: 'object', properties: { city: { type: 'string' } } } } },
    { type: 'function', function: { name: 'noop' } },
    { type: 'not-a-function', name: 'ignored' },
  ]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].functionDeclarations.length, 2);
  assert.equal(tools[0].functionDeclarations[0].name, 'get_weather');
  assert.equal(tools[0].functionDeclarations[1].parameters, undefined);
  assert.equal(convertTools([]), null);
});

check('tool_choice maps to toolConfig', () => {
  assert.deepEqual(convertToolChoice('auto'), { functionCallingConfig: { mode: 'AUTO' } });
  assert.deepEqual(convertToolChoice('none'), { functionCallingConfig: { mode: 'NONE' } });
  assert.deepEqual(convertToolChoice('required'), { functionCallingConfig: { mode: 'ANY' } });
  assert.deepEqual(convertToolChoice({ type: 'function', function: { name: 'x' } }),
    { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['x'] } });
  assert.equal(convertToolChoice(undefined), null);
});

check('thoughtSignature survives a tool_call id round-trip', () => {
  const signature = 'EmcKZQFpFH0T+/abc==';
  const id = makeToolCallId('call_123', signature);
  const back = decodeToolCallId(id);
  assert.equal(back.upstreamId, 'call_123');
  assert.equal(back.signature, signature);
  const plain = makeToolCallId('call_456', undefined);
  assert.equal(plain, 'call_456');
  assert.equal(decodeToolCallId(plain).signature, undefined);
});

/* ----------------------------------------------------------- request mapping */

await checkAsync('messages become contents/systemInstruction/tools', async () => {
  const callId = makeToolCallId('call_77', 'SIG');
  const { model, request, meta } = await buildUpstreamRequest({
    model: 'gemini-3-flash',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'weather in Moscow?' },
      { role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: 'get_weather', arguments: '{"city":"Moscow"}' } }] },
      { role: 'tool', tool_call_id: callId, content: '{"tempC":-3}' },
    ],
    tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    tool_choice: 'auto',
    max_tokens: 2048,
    temperature: 0.2,
    stop: 'END',
    stream: true,
  }, { sessionId: 's1' });

  assert.equal(model, 'gemini-3-flash');
  assert.equal(meta.stream, true);
  assert.equal(request.systemInstruction.parts[0].text, 'be terse');
  assert.deepEqual(request.contents.map((c) => c.role), ['user', 'model', 'user']);
  const call = request.contents[1].parts[0].functionCall;
  assert.equal(call.name, 'get_weather');
  assert.equal(call.id, 'call_77');
  assert.deepEqual(call.args, { city: 'Moscow' });
  assert.equal(request.contents[1].parts[0].thoughtSignature, 'SIG');
  const response = request.contents[2].parts[0].functionResponse;
  assert.equal(response.name, 'get_weather');
  assert.equal(response.id, 'call_77');
  assert.deepEqual(response.response, { tempC: -3 });
  assert.equal(request.generationConfig.maxOutputTokens, 2048);
  assert.equal(request.generationConfig.temperature, 0.2);
  assert.deepEqual(request.generationConfig.stopSequences, ['END']);
  assert.deepEqual(request.toolConfig, { functionCallingConfig: { mode: 'AUTO' } });
  assert.equal(request.sessionId, 's1');
});

await checkAsync('reasoning_effort becomes thinkingConfig', async () => {
  const { request } = await buildUpstreamRequest({
    model: 'gemini-3-flash',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'low',
  });
  assert.deepEqual(request.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: 'LOW' });
});

await checkAsync('max tokens are capped when a cap is set', async () => {
  const { request } = await buildUpstreamRequest({
    model: 'x', messages: [{ role: 'user', content: 'hi' }], max_tokens: 999999,
  }, { maxOutputTokensCap: 4096 });
  assert.equal(request.generationConfig.maxOutputTokens, 4096);
});

await checkAsync('image data URLs become inlineData', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const { request } = await buildUpstreamRequest({
    model: 'gemini-3-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: png } }] }],
  });
  const parts = request.contents[0].parts;
  assert.equal(parts[0].text, 'what is this?');
  assert.deepEqual(parts[1], { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } });
});

/* ---------------------------------------------------------- response mapping */

check('finish reasons map to OpenAI', () => {
  assert.equal(finishReasonToOpenAi('STOP', false), 'stop');
  assert.equal(finishReasonToOpenAi('STOP', true), 'tool_calls');
  assert.equal(finishReasonToOpenAi('MAX_TOKENS', false), 'length');
  assert.equal(finishReasonToOpenAi('SAFETY', false), 'content_filter');
  assert.equal(finishReasonToOpenAi(null, false), 'stop');
});

check('usage includes thinking and cache tokens', () => {
  const usage = openAiUsage({
    promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5,
    cachedContentTokenCount: 40, totalTokenCount: 125,
  });
  assert.equal(usage.prompt_tokens, 100);
  assert.equal(usage.completion_tokens, 25);
  assert.equal(usage.total_tokens, 125);
  assert.equal(usage.prompt_tokens_details.cached_tokens, 40);
  assert.equal(openAiUsage(undefined), undefined);
});

check('model list uses the OpenAI envelope', () => {
  const list = openAiModelList({ 'gemini-3-flash': { id: 'gemini-3-flash', provider: 'GOOGLE' } });
  assert.equal(list.object, 'list');
  assert.equal(list.data[0].id, 'gemini-3-flash');
  assert.equal(list.data[0].object, 'model');
});

console.log('\n' + passed + ' checks passed');
