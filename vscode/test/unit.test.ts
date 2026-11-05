// Offline checks for the VS Code integration: conversion, catalogue, streaming, provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelCatalogue, toChatInformation } from '../src/catalogue.js';
import { convertMessages, convertTools, flattenToolResult } from '../src/harness.js';
import { AntigravityFailure, generate } from '../src/generation.js';
import { AntigravityChatProvider, canForceToolCall, friendlyMessage, transportModel } from '../src/provider.js';
import { renderStatus } from '../src/status.js';
import {
  api, assistant, DataPart, errorResponse, FakeClient, sse, streamResponse, textEvent, toolEvent,
  ToolCallPart, ToolResultPart, user,
} from './fake.js';

/* ------------------------------------------------------------------ conversion */

test('convertMessages: text, image and tool round trip', () => {
  const messages = [
    user([{ value: 'What is on screen?' }, DataPart.image(new Uint8Array([1, 2, 3]), 'image/png')]),
    assistant([{ value: 'Let me look.' }, new ToolCallPart('call_1', 'look', { area: 'full' })]),
    user([new ToolResultPart('call_1', [{ value: 'a red square' }])]),
    user([{ value: 'Thanks!' }]),
  ];
  const harness = convertMessages(messages as any, api);
  assert.equal(harness.length, 4);
  assert.deepEqual(harness[0].content[0], { type: 'text', text: 'What is on screen?' });
  assert.deepEqual(harness[0].content[1], { type: 'image', mimeType: 'image/png', data: 'AQID' });
  assert.deepEqual(harness[1].content[1], { type: 'tool-call', id: 'call_1', name: 'look', arguments: '{"area":"full"}' });
  assert.equal(harness[2].role, 'tool');
  assert.equal(harness[2].toolCallId, 'call_1');
  assert.deepEqual(harness[3], { role: 'user', content: [{ type: 'text', text: 'Thanks!' }] });
});

test('convertMessages: parallel tool results each become a tool message', () => {
  const harness = convertMessages([user([
    new ToolResultPart('call_a', [{ value: 'one' }]),
    new ToolResultPart('call_b', [{ value: 'two' }]),
  ])] as any, api);
  assert.deepEqual(harness.map((message) => message.role), ['tool', 'tool']);
  assert.deepEqual(harness.map((message) => message.toolCallId), ['call_a', 'call_b']);
});

test('convertMessages: unknown data parts and empty text are dropped', () => {
  const harness = convertMessages([user([
    new DataPart('application/vnd.vscode.cache_control', new Uint8Array([1])),
    { value: '' },
  ])] as any, api);
  assert.equal(harness.length, 0);
});

test('flattenToolResult: joins text, text data and prompt-tsx values', () => {
  const text = flattenToolResult([
    { value: 'first' },
    DataPart.text('second'),
    { value: { ok: true } },
  ]);
  assert.equal(text, 'first\nsecond\n{"ok":true}');
});

test('convertTools: inputSchema becomes transport parameters', () => {
  const tools = convertTools([
    { name: 'get_time', description: 'Current time', inputSchema: { type: 'object', properties: { tz: { type: 'string' } } } },
    { name: 'no_args', description: '', inputSchema: { type: 'object', properties: {} } },
    { name: 'no_schema', description: 'x' },
  ] as any);
  assert.equal(tools.length, 3);
  assert.deepEqual(tools[0].parameters, { type: 'object', properties: { tz: { type: 'string' } } });
  // The schema is passed through untouched; the transport drops a no-argument schema before
  // it reaches Gemini (an empty OBJECT makes models invent arguments).
  assert.deepEqual(tools[1].parameters, { type: 'object', properties: {} });
  assert.equal(tools[2].parameters, undefined);
});

/* ------------------------------------------------------------------- catalogue */

function catalogueClient(models: Record<string, any>) {
  let calls = 0;
  return {
    calls: () => calls,
    fetchModels: async () => {
      calls += 1;
      return { models, defaultModelId: 'gemini-3-flash' };
    },
  };
}

test('catalogue: filters non-chat models, sorts, caches', async () => {
  const client = catalogueClient({
    'gemini-3-flash': { supportsImages: true, contextWindow: 1048576, maxTokens: 65536, recommended: true },
    'tab_completion': {},
    'chat_router': {},
    'gemini-3-pro-tiered': {},
    'gemini-3.1-flash-image': { supportsImages: true, maxTokens: 32768 },
    'claude-sonnet-5-5-low': { supportsThinking: true },
  });
  const catalogue = new ModelCatalogue(client as any);
  const models = await catalogue.load();
  assert.deepEqual(models.map((m) => m.id), [
    'gemini-3-flash', 'claude-sonnet-5-5-low', 'gemini-3.1-flash-image',
  ]);
  assert.equal(models[0].kind, 'chat');
  assert.equal(models[2].kind, 'image');
  assert.equal(models[2].supportsImages, true);
  await catalogue.load();
  assert.equal(client.calls(), 1, 'second load is served from the cache');
  await catalogue.load({ force: true });
  assert.equal(client.calls(), 2);
});

test('toChatInformation: capabilities, limits and human name', () => {
  const info = toChatInformation({
    id: 'gemini-3-flash', kind: 'chat', contextWindow: 1048576, maxOutputTokens: 65536,
    supportsImages: true, supportsThinking: true, recommended: true,
  });
  assert.equal(info.name, 'Gemini 3 Flash');
  assert.equal(info.maxInputTokens, 1048576);
  assert.equal(info.capabilities.toolCalling, true);
  assert.equal(info.capabilities.imageInput, true);
  assert.match(info.family, /gemini/);
  const image = toChatInformation({
    id: 'gemini-3.1-flash-image', kind: 'image', contextWindow: 1048576, maxOutputTokens: 32768,
    supportsImages: true, supportsThinking: false, recommended: false,
  });
  assert.equal(image.capabilities.toolCalling, false);
  assert.equal(image.detail, 'image');
});

test('transportModel: 2.5 models reason through a budget', () => {
  const base = { kind: 'chat' as const, contextWindow: 1000, maxOutputTokens: 100, supportsImages: false, supportsThinking: true, recommended: false };
  assert.equal(transportModel({ ...base, id: 'gemini-2.5-flash' }).thinkingStyle, 'budget');
  assert.equal(transportModel({ ...base, id: 'gemini-3-flash' }).thinkingStyle, 'level');
});

/* ------------------------------------------------------------------ generation */

test('generate: streams text and finishes', async () => {
  const client = new FakeClient(() => streamResponse(sse([
    textEvent('Hel'),
    textEvent('lo', { finishReason: 'STOP' }),
  ])));
  const events = [];
  for await (const event of generate({ client: client as any, wireModel: 'gemini-3-flash', request: {}, signal: new AbortController().signal })) {
    events.push(event);
  }
  assert.deepEqual(events, [{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }]);
});

test('generate: tool call keeps the thought signature in the call id', async () => {
  const client = new FakeClient(() => streamResponse(sse([
    toolEvent('get_time', { tz: 'UTC' }, { id: 'call_1', signature: 'SIG' }),
  ])));
  const events = [];
  for await (const event of generate({ client: client as any, wireModel: 'gemini-3-flash', request: {}, signal: new AbortController().signal })) {
    events.push(event);
  }
  assert.equal(events.length, 1);
  const call = events[0] as { type: string; callId: string; name: string; input: object };
  assert.equal(call.type, 'toolCall');
  assert.equal(call.name, 'get_time');
  assert.deepEqual(call.input, { tz: 'UTC' });
  assert.match(call.callId, /call_1__sig_/);
});

test('generate: HTTP 429 becomes a QUOTA failure', async () => {
  const client = new FakeClient(() => errorResponse(429, '{"error":{"status":"RESOURCE_EXHAUSTED","message":"quota"}}'));
  await assert.rejects(
    (async () => { for await (const _ of generate({ client: client as any, wireModel: 'm', request: {}, signal: new AbortController().signal })) { /* drain */ } })()
    , (error: AntigravityFailure) => error.code === 'QUOTA' || error.code === 'RATE_LIMIT',
  );
});

test('generate: an empty answer with a finishMessage is an error, not silence', async () => {
  const client = new FakeClient(() => streamResponse(sse([
    { response: { candidates: [{ content: { parts: [] }, finishMessage: 'blocked by policy' }] } },
  ])));
  await assert.rejects(
    (async () => { for await (const _ of generate({ client: client as any, wireModel: 'm', request: {}, signal: new AbortController().signal })) { /* drain */ } })()
    , /blocked by policy/,
  );
});

/* -------------------------------------------------------------------- provider */

function providerFor(respond: (call: { model: string; request: any }) => any, models: Record<string, any> = {
  'gemini-3-flash': { supportsImages: true, contextWindow: 1000000, maxTokens: 65536 },
}) {
  const client = new FakeClient(respond);
  const catalogue = new ModelCatalogue(catalogueClient(models) as any);
  const provider = new AntigravityChatProvider({
    api,
    client: client as any,
    catalogue,
    settings: () => ({ showThinking: false }),
    throttle: () => undefined,
    log: () => {},
  });
  return { provider, client, catalogue };
}

function token() {
  const listeners: Array<() => void> = [];
  return {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => void) => {
      listeners.push(listener);
      return { dispose: () => { listeners.splice(listeners.indexOf(listener), 1); } };
    },
    cancel: () => { for (const listener of [...listeners]) listener(); },
  };
}

function collect(provider: AntigravityChatProvider, messages: any[], options: any, cancellation = token()) {
  const parts: any[] = [];
  const progress = { report: (part: any) => parts.push(part) };
  return { parts, promise: provider.provideLanguageModelChatResponse({ id: 'gemini-3-flash' } as any, messages, options, progress as any, cancellation as any), cancellation };
}

test('provider: advertises model metadata', async () => {
  const { provider } = providerFor(() => streamResponse([]));
  const models = await provider.provideLanguageModelChatInformation({ silent: true }, token() as any);
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'gemini-3-flash');
});

test('provider: streams text parts', async () => {
  const { provider, client } = providerFor(() => streamResponse(sse([
    textEvent('PO'), textEvent('NG', { finishReason: 'STOP' }),
  ])));
  const { parts, promise } = collect(provider, [user([{ value: 'say pong' }])], { toolMode: api.LanguageModelChatToolMode.Auto });
  await promise;
  assert.deepEqual(parts.map((part) => part.value), ['PO', 'NG']);
  assert.equal(client.requests[0].model, 'gemini-3-flash');
  assert.deepEqual(client.requests[0].request.contents, [{ role: 'user', parts: [{ text: 'say pong' }] }]);
});

test('provider: reports tool calls with the encoded id', async () => {
  const { provider } = providerFor(() => streamResponse(sse([
    toolEvent('get_time', { tz: 'UTC' }, { id: 'call_9', signature: 'SIG' }),
  ])));
  const { parts, promise } = collect(provider, [user([{ value: 'time?' }])], { toolMode: api.LanguageModelChatToolMode.Auto });
  await promise;
  assert.equal(parts.length, 1);
  assert.equal(parts[0].name, 'get_time');
  assert.match(parts[0].callId, /call_9__sig_/);
  assert.deepEqual(parts[0].input, { tz: 'UTC' });
});

test('provider: Required tool mode asks the endpoint to force a call', async () => {
  const { provider, client } = providerFor(() => streamResponse(sse([textEvent('done', { finishReason: 'STOP' })])));
  const { promise } = collect(provider, [user([{ value: 'go' }])], {
    toolMode: api.LanguageModelChatToolMode.Required,
    tools: [{ name: 'get_time', description: 'time', inputSchema: { type: 'object', properties: {} } }],
  });
  await promise;
  const request = client.requests[0].request;
  assert.equal(request.tools.length, 1);
  assert.deepEqual(request.toolConfig, { functionCallingConfig: { mode: 'ANY' } });
});

test('provider: forced tool mode is only sent to Gemini models', async () => {
  const { provider, client } = providerFor(() => streamResponse(sse([textEvent('done', { finishReason: 'STOP' })])));
  const { promise } = collect(provider, [user([{ value: 'go' }])], {
    toolMode: api.LanguageModelChatToolMode.Required,
    tools: [{ name: 'get_time', description: 'time', inputSchema: { type: 'object', properties: {} } }],
  });
  await promise;
  assert.deepEqual(client.requests[0].request.toolConfig, { functionCallingConfig: { mode: 'ANY' } });

  const claude = providerFor(() => streamResponse(sse([textEvent('done', { finishReason: 'STOP' })])));
  const result = collect(claude.provider, [user([{ value: 'go' }])], {
    toolMode: api.LanguageModelChatToolMode.Required,
    tools: [{ name: 'get_time', description: 'time', inputSchema: { type: 'object', properties: {} } }],
  });
  // The fake catalogue only knows gemini-3-flash, so exercise the helper directly.
  assert.equal(canForceToolCall('claude-sonnet-5-5-low'), false);
  assert.equal(canForceToolCall('gemini-3-flash'), true);
  await result.promise;
});

test('provider: translated 429 is actionable', async () => {
  const { provider } = providerFor(() => errorResponse(429, '{"error":{"status":"RESOURCE_EXHAUSTED"}}'));
  const { promise } = collect(provider, [user([{ value: 'go' }])], { toolMode: api.LanguageModelChatToolMode.Auto });
  await assert.rejects(promise, (error: Error) => /quota|rate-limit/i.test(error.message));
});

test('provider: cancellation stops without an error', async () => {
  const cancellation = token();
  const { provider } = providerFor(() => streamResponse(sse([textEvent('a'), textEvent('b', { finishReason: 'STOP' })])));
  cancellation.cancel();
  const { promise } = collect(provider, [user([{ value: 'go' }])], { toolMode: api.LanguageModelChatToolMode.Auto }, cancellation);
  await promise;
});

test('provider: token counts are estimated', async () => {
  const { provider } = providerFor(() => streamResponse([]));
  assert.equal(await provider.provideTokenCount({} as any, 'abcd', token() as any), 1);
  assert.equal(await provider.provideTokenCount({} as any, 'a'.repeat(100), token() as any), 25);
});

test('friendlyMessage: credential failures tell the user what to do', () => {
  const missing = new AntigravityFailure('no credential', 'MISSING_CREDENTIAL');
  assert.match(friendlyMessage(missing), /sign in/i);
  const auth = new AntigravityFailure('401', 'AUTH');
  assert.match(friendlyMessage(auth), /Antigravity rejected/);
});

/* ---------------------------------------------------------------------- status */

test('renderStatus: account, quota and models', () => {
  const markdown = renderStatus({
    account: { project: 'proj-1', tierName: 'Pro', paidTier: 'Pro' },
    quota: { 'gemini-3-flash': 0.5 },
    models: { chat: 2, image: 1, ids: ['gemini-3-flash', 'claude-sonnet-5-5-low', 'gemini-3.1-flash-image'] },
    credential: { cached: true, expiresAt: '2026-01-01T00:00:00Z', clientCandidates: 2 },
    throttle: { maxConcurrent: 2, minIntervalMs: 250, cooldownUntil: null },
  }, new Date('2026-01-01T00:00:00Z'));
  assert.match(markdown, /# Antigravity/);
  assert.match(markdown, /\| Pro \|/);
  assert.match(markdown, /2 chat, 1 image/);
  assert.match(markdown, /50%/);
  assert.match(markdown, /gemini-3-flash/);
});
