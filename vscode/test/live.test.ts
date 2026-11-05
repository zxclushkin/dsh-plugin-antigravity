// Live checks against the real Antigravity endpoint, using the credentials the installed
// Antigravity app already holds. Run explicitly: `npm run test:live`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAntigravityClient } from '../../plugin/src/antigravity.mjs';
import { ModelCatalogue } from '../src/catalogue.js';
import { AntigravityChatProvider } from '../src/provider.js';
import { api, DataPart, user, assistant, ToolCallPart, ToolResultPart } from './fake.js';

const log = (message: string) => console.error('[live] ' + message);
const client = createAntigravityClient({ log });
const catalogue = new ModelCatalogue(client as any, log);

const provider = new AntigravityChatProvider({
  api,
  client: client as any,
  catalogue,
  settings: () => ({ showThinking: false }),
  throttle: () => undefined,
  log,
});

function token() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => {} }),
  };
}

async function ask(modelId: string, messages: unknown[], options: any = { toolMode: api.LanguageModelChatToolMode.Auto }) {
  const parts: any[] = [];
  await provider.provideLanguageModelChatResponse(
    { id: modelId } as any,
    messages as any,
    options,
    { report: (part: any) => parts.push(part) } as any,
    token() as any,
  );
  return parts;
}

const text = (parts: any[]) => parts.filter((part) => typeof part.value === 'string').map((part) => part.value).join('');

let chatModel = '';
let chatModels: string[] = [];

test('live: the account catalogue is reachable', async () => {
  const models = await catalogue.load({ force: true });
  chatModels = models.filter((model) => model.kind === 'chat').map((model) => model.id);
  assert.ok(models.length > 0, 'expected at least one model');
  chatModel = chatModels.find((id) => /^gemini-3-flash/.test(id)) ?? chatModels[0];
  log(chatModels.length + ' chat models; using ' + chatModel);
});

test('live: a text turn answers', async () => {
  assert.ok(chatModel, 'catalogue check must run first');
  const parts = await ask(chatModel, [user([{ value: 'Reply with the single word PONG and nothing else.' }])]);
  assert.match(text(parts).toUpperCase(), /PONG/);
});

test('live: tool names with dots and dashes survive the endpoint', async () => {
  if (!process.env.AG_EXTRA) return;
  const parts = await ask(chatModel, [user([{ value: 'Call mcp.github.list_issues with repo "x/y". Do not answer in prose.' }])], {
    toolMode: api.LanguageModelChatToolMode.Auto,
    tools: [
      { name: 'mcp.github.list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'] } },
      { name: 'run-in-terminal', description: 'Run a command', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } },
    ],
  } as any);
  const call = parts.find((part) => typeof part.name === 'string');
  assert.ok(call, 'expected a tool call, got: ' + text(parts));
  log('tool name accepted: ' + call.name);
});

test('live: image input is forwarded as inlineData', async () => {
  // 32x32 solid red PNG.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAySURBVFhH7c4hAQAACMAwQtA/GV3AEwDMxM3VojL7s9jjOgAAAAAAAAAAAAAAAAAAgAHLbQx5gXL0ZQAAAABJRU5ErkJggg==', 'base64');
  const parts = await ask(chatModel, [user([{ value: 'What colour is this image? One word.' }, DataPart.image(png, 'image/png')])]);
  assert.match(text(parts).toLowerCase(), /red|красн/);
});

test('live: the image model returns an image part', async () => {
  if (!process.env.AG_IMAGE) return;
  const imageId = (await catalogue.load()).find((model) => model.kind === 'image')?.id;
  if (!imageId) return;
  const parts = await ask(imageId, [user([{ value: 'A single red dot on white, 1:1.' }])]);
  const image = parts.find((part) => part && part.mimeType && part.mimeType.startsWith('image/'));
  assert.ok(image, 'expected an image part, got: ' + text(parts));
  log('image: ' + image.mimeType + ' ' + image.data.length + ' bytes');
});

test('live: a tool call is returned and its result is answered', async () => {
  assert.ok(chatModel, 'catalogue check must run first');
  const tools = [{
    name: 'get_time',
    description: 'Return the current time in a timezone.',
    inputSchema: { type: 'object', properties: { timezone: { type: 'string' } }, required: ['timezone'] },
  }];
  const first = await ask(chatModel, [user([{ value: 'Call get_time for UTC. Do not answer in prose.' }])], {
    toolMode: api.LanguageModelChatToolMode.Auto,
    tools,
  });
  const call = first.find((part) => part.name === 'get_time');
  assert.ok(call, 'expected a get_time tool call, got: ' + text(first));
  const second = await ask(chatModel, [
    user([{ value: 'Call get_time for UTC. Do not answer in prose.' }]),
    assistant([new ToolCallPart(call.callId, call.name, call.input)]),
    user([new ToolResultPart(call.callId, [{ value: '2026-11-05T21:00:00Z' }])]),
  ], { toolMode: api.LanguageModelChatToolMode.Auto, tools });
  assert.match(text(second), /2026-11-05|21:00/);
});
