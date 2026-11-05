// language: JavaScript (ESM), file: plugin/test/gateway.mjs, runtime: Node >= 20
// End-to-end exercise of the Antigravity gateway without DSH in the loop. Needs a real
// Antigravity installation and login (it spends the account's quota).
//   node plugin/test/gateway.mjs                     # everything
//   node plugin/test/gateway.mjs models              # only list models
//   AG_MODEL=claude-sonnet-5-5-low node plugin/test/gateway.mjs
import { createAntigravityProxy } from '../src/server.mjs';
import { makeToolCallId, decodeToolCallId, convertSchema } from '../src/openai.mjs';

const PORT = Number(process.env.AG_TEST_PORT || 8733);
const log = (msg) => console.error('[gw] ' + msg);
const proxy = createAntigravityProxy({ port: PORT, host: '127.0.0.1', log, debugDir: process.env.AG_DEBUG_DIR });

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}

async function jsonPost(pathname, body) {
  const res = await fetch('http://127.0.0.1:' + PORT + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dummy' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}

async function streamPost(pathname, body, onChunk) {
  const res = await fetch('http://127.0.0.1:' + PORT + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dummy' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('HTTP ' + res.status + ': ' + text.slice(0, 400));
  }
  let content = '', reasoning = '';
  const toolCalls = new Map();
  let finish = null, usage = null, chunks = 0;
  let buffer = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        if (chunk.error) throw new Error('stream error: ' + JSON.stringify(chunk.error).slice(0, 300));
        chunks++;
        const delta = chunk.choices?.[0]?.delta || {};
        if (typeof delta.content === 'string') content += delta.content;
        if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
        for (const call of delta.tool_calls || []) {
          const acc = toolCalls.get(call.index) || { id: '', name: '', arguments: '' };
          if (call.id) acc.id = call.id;
          if (call.function?.name) acc.name = call.function.name;
          if (call.function?.arguments) acc.arguments += call.function.arguments;
          toolCalls.set(call.index, acc);
        }
        if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
        if (chunk.usage) usage = chunk.usage;
        onChunk?.(chunk);
      }
    }
  }
  return { content, reasoning, toolCalls: [...toolCalls.values()], finish, usage, chunks };
}

async function main() {
  const which = process.argv[2];
  await proxy.listen(PORT, '127.0.0.1');
  log('listening on ' + PORT);

  try {
    const health = await (await fetch('http://127.0.0.1:' + PORT + '/health')).json();
    record('health', health.ok === true, 'upstream=' + health.upstream);

    const modelsRes = await (await fetch('http://127.0.0.1:' + PORT + '/v1/models', {
      headers: { Authorization: 'Bearer dummy' },
    })).json();
    const ids = (modelsRes.data || []).map((m) => m.id);
    record('models list', ids.length > 0, ids.length + ' models');
    console.log('  ids: ' + ids.join(', '));
    if (which === 'models') return;

    const model = process.env.AG_MODEL || (ids.includes('gemini-3-flash') ? 'gemini-3-flash' : ids[0]);
    log('using model ' + model);

    // 1. non-streaming text
    const plain = await jsonPost('/v1/chat/completions', {
      model,
      messages: [
        { role: 'system', content: 'You are a terse test bot. Answer with one word.' },
        { role: 'user', content: 'Reply with the single word: PONG' },
      ],
      max_tokens: 64,
      temperature: 0,
    });
    const plainText = plain.json?.choices?.[0]?.message?.content || '';
    record('non-stream text', plain.status === 200 && /PONG/i.test(plainText),
      'status=' + plain.status + ' text=' + JSON.stringify(plainText.slice(0, 80)) +
      ' usage=' + JSON.stringify(plain.json?.usage));

    // 2. streaming text
    const streamed = await streamPost('/v1/chat/completions', {
      model,
      stream: true,
      messages: [{ role: 'user', content: 'Count from 1 to 5, separated by spaces, no other text.' }],
      max_tokens: 128,
      temperature: 0,
    });
    record('stream text', streamed.content.length > 0 && streamed.chunks > 1,
      'chunks=' + streamed.chunks + ' finish=' + streamed.finish +
      ' text=' + JSON.stringify(streamed.content.slice(0, 60)) + ' usage=' + JSON.stringify(streamed.usage));

    // 3. streaming tool call
    const tools = [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get the current weather for a city',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: 'City name' },
            units: { type: 'string', enum: ['c', 'f'] },
          },
          required: ['city'],
          additionalProperties: false,
        },
      },
    }];
    const question = 'What is the weather in Moscow? Use the get_weather tool.';
    const first = await streamPost('/v1/chat/completions', {
      model,
      stream: true,
      messages: [{ role: 'user', content: question }],
      tools,
      tool_choice: 'auto',
      max_tokens: 256,
      temperature: 0,
    });
    const call = first.toolCalls[0];
    record('stream tool_call', Boolean(call && call.name === 'get_weather'),
      'finish=' + first.finish + ' calls=' + JSON.stringify(first.toolCalls));

    if (call) {
      // 4. round-trip the tool result back to the model (history replay incl. thoughtSignature).
      const openAiCall = { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } };
      const second = await streamPost('/v1/chat/completions', {
        model,
        stream: true,
        messages: [
          { role: 'user', content: question },
          { role: 'assistant', content: null, tool_calls: [openAiCall] },
          { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ tempC: -3, sky: 'snow' }) },
        ],
        tools,
        max_tokens: 256,
        temperature: 0,
      });
      record('tool round-trip', second.content.length > 0,
        'finish=' + second.finish + ' text=' + JSON.stringify(second.content.slice(0, 120)));
    }

    // 5. unit checks for the translation helpers
    const schema = convertSchema({
      type: 'object',
      properties: { a: { type: 'string', default: 'x' }, b: { type: 'array', items: { type: 'integer' } } },
      required: ['a', 'missing'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    });
    record('schema conversion', schema.type === 'OBJECT' && !('additionalProperties' in schema) &&
      schema.properties.b.items.type === 'INTEGER' && JSON.stringify(schema.required) === '["a"]',
      JSON.stringify(schema));
    const sig = 'EmcKZQFpFH0Tabc+/def==';
    const id = makeToolCallId('call_123', sig);
    const back = decodeToolCallId(id);
    record('tool id encode/decode', back.upstreamId === 'call_123' && back.signature === sig, id.slice(0, 40) + '…');
  } finally {
    await proxy.close();
    const failed = results.filter((r) => !r.ok);
    console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
    if (failed.length > 0) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('FATAL: ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
