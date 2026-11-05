// language: JavaScript (ESM), file: src/openai.mjs, runtime: Node >= 20
// Translation between the OpenAI chat-completions protocol (what DSH speaks) and the
// Gemini-shaped request/response of Antigravity's v1internal API.
//
// OpenAI messages -> {contents, systemInstruction, tools, toolConfig, generationConfig}
// Antigravity parts -> OpenAI deltas (text / reasoning_content / tool_calls) and usage.

const IMAGE_MIME = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i;

/** Gemini enum spelling for a JSON-schema type. */
function upperType(type) {
  if (typeof type !== 'string') return undefined;
  const map = {
    object: 'OBJECT', string: 'STRING', number: 'NUMBER', integer: 'INTEGER',
    boolean: 'BOOLEAN', array: 'ARRAY', null: 'NULL',
  };
  return map[type.toLowerCase()] || (type.toUpperCase() === type ? type : undefined);
}

const SCHEMA_KEYS = new Set(['type', 'description', 'enum', 'items', 'properties', 'required', 'nullable', 'anyOf', 'format']);

/**
 * OpenAI/JSON-Schema tool parameters -> Gemini `parameters`.
 * Gemini rejects unknown keywords, so the conversion is an allowlist, not a copy.
 * Nested objects without properties degrade to STRING; a top-level no-argument schema is
 * dropped by convertTools instead (see there).
 */
export function convertSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 12) return { type: 'STRING' };

  if (Array.isArray(schema.anyOf)) {
    const nullable = schema.anyOf.some((option) => option && option.type === 'null');
    const options = schema.anyOf.filter((option) => option && typeof option === 'object' && option.type !== 'null');
    if (options.length === 1) {
      const single = convertSchema(options[0], depth + 1);
      if (nullable) single.nullable = true;
      return single;
    }
    const out = { anyOf: options.map((option) => convertSchema(option, depth + 1)) };
    if (schema.description) out.description = String(schema.description);
    if (nullable) out.nullable = true;
    return out;
  }

  const type = upperType(schema.type) ||
    (schema.properties ? 'OBJECT' : schema.items ? 'ARRAY' : 'STRING');
  const out = { type };

  if (typeof schema.description === 'string' && schema.description) out.description = schema.description;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    out.enum = schema.enum.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
  }
  if (type === 'ARRAY') {
    out.items = convertSchema(schema.items || { type: 'string' }, depth + 1);
  }
  if (type === 'OBJECT') {
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
    if (props && Object.keys(props).length > 0) {
      out.properties = {};
      for (const [key, value] of Object.entries(props)) {
        out.properties[key] = convertSchema(value, depth + 1);
      }
      const required = Array.isArray(schema.required)
        ? schema.required.filter((name) => Object.prototype.hasOwnProperty.call(out.properties, name))
        : [];
      if (required.length > 0) out.required = required;
    } else {
      // Gemini rejects OBJECT without properties; a free-form object is a JSON string in practice.
      out.type = 'STRING';
      out.description = out.description || 'JSON object encoded as a string';
      delete out.properties;
    }
  }
  if (schema.nullable === true) out.nullable = true;
  return out;
}

/** True for `{}` / `{type:'object'}` / `{type:'object', properties:{}}` — a no-argument tool. */
function isEmptyObjectSchema(schema) {
  if (schema === undefined || schema === null) return true;
  if (typeof schema !== 'object' || Array.isArray(schema)) return false;
  const type = typeof schema.type === 'string' ? schema.type.toLowerCase() : (schema.properties ? 'object' : undefined);
  if (type !== 'object') return false;
  const properties = schema.properties;
  return !properties || typeof properties !== 'object' || Object.keys(properties).length === 0;
}

/** OpenAI `tools` -> Gemini `tools`. Entries that are not functions are ignored. */
export function convertTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const declarations = [];
  for (const tool of tools) {
    const fn = tool && (tool.type === 'function' ? tool.function : tool.type ? null : tool);
    if (!fn || typeof fn.name !== 'string' || !fn.name) continue;
    const declaration = { name: fn.name };
    if (typeof fn.description === 'string' && fn.description) declaration.description = fn.description;
    // A no-argument tool must be declared WITHOUT `parameters`: Gemini also accepts an
    // OBJECT schema, but Anthropic rejects it (`input_schema.type: Input should be 'object'`)
    // when Antigravity forwards an empty-properties object, so omitting is the only shape
    // both families accept — and the one that keeps the model from inventing arguments.
    if (!isEmptyObjectSchema(fn.parameters)) {
      declaration.parameters = convertSchema(fn.parameters);
    }
    declarations.push(declaration);
  }
  if (declarations.length === 0) return null;
  return [{ functionDeclarations: declarations }];
}

/** OpenAI `tool_choice` -> Gemini `toolConfig`. */
export function convertToolChoice(choice) {
  if (!choice) return null;
  if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (choice === 'required') return { functionCallingConfig: { mode: 'ANY' } };
  if (choice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
  if (typeof choice === 'object' && choice.function && typeof choice.function.name === 'string') {
    return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.function.name] } };
  }
  return null;
}

/* ------------------------------------------------------------ tool call ids */

const TOOL_ID_SEP = '_s.';

/** Encode a Gemini thoughtSignature inside the tool_call id so it survives history replay. */
export function makeToolCallId(upstreamId, signature) {
  const base = String(upstreamId || 'call_' + Math.random().toString(36).slice(2, 10));
  if (!signature) return base;
  const encoded = Buffer.from(signature, 'utf8').toString('base64url');
  return base + TOOL_ID_SEP + encoded;
}

/** Split our tool_call id back into the upstream id and the replayed thoughtSignature. */
export function decodeToolCallId(id) {
  const text = String(id || '');
  const at = text.indexOf(TOOL_ID_SEP);
  if (at < 0) return { upstreamId: text || undefined, signature: undefined };
  return {
    upstreamId: text.slice(0, at) || undefined,
    signature: Buffer.from(text.slice(at + TOOL_ID_SEP.length), 'base64url').toString('utf8'),
  };
}

/* ------------------------------------------------------------- request side */

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('');
  }
  return '';
}

async function imagePart(part, log) {
  const url = part?.image_url && typeof part.image_url === 'object' ? part.image_url.url : part?.image_url;
  if (typeof url !== 'string' || !url) return null;
  const data = IMAGE_MIME.exec(url);
  if (data) return { inlineData: { mimeType: data[1], data: data[2] } };
  if (/^https?:\/\//i.test(url)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return null;
      const mime = (res.headers.get('content-type') || 'image/png').split(';')[0];
      const buf = Buffer.from(await res.arrayBuffer());
      return { inlineData: { mimeType: mime, data: buf.toString('base64') } };
    } catch (err) {
      log('could not fetch image ' + url.slice(0, 80) + ': ' + err.message);
      return null;
    }
  }
  return null;
}

/**
 * Build the Antigravity generate request from an OpenAI chat-completions body.
 * @returns {Promise<{model: string, request: object, meta: {stream: boolean, toolNames: Map<string,string>}}>}
 */
export async function buildUpstreamRequest(body, options = {}) {
  const log = options.log || (() => {});
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemParts = [];
  const contents = [];
  const toolNames = new Map(); // our tool_call id -> function name

  // Pre-pass: tool results only carry a tool_call_id, so the names come from the assistant turns.
  for (const message of messages) {
    if (!message || message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const name = call && call.function && call.function.name;
      if (call && call.id && typeof name === 'string' && name) toolNames.set(call.id, name);
    }
  }

  const pushContent = (role, parts) => {
    if (parts.length === 0) return;
    const last = contents[contents.length - 1];
    // Gemini wants alternating roles; merging keeps a tool-result burst inside one user turn.
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role;

    if (role === 'system' || role === 'developer') {
      const text = textFromContent(message.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (role === 'tool' || role === 'function') {
      const id = message.tool_call_id || message.name;
      const name = toolNames.get(id) || message.name || 'unknown_function';
      let payload;
      const raw = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      try { payload = JSON.parse(raw); } catch { payload = { result: raw }; }
      const response = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload
        : { result: payload };
      const { upstreamId } = decodeToolCallId(id);
      const part = { functionResponse: { name, response } };
      if (upstreamId) part.functionResponse.id = upstreamId;
      pushContent('user', [part]);
      continue;
    }

    if (role === 'assistant') {
      const parts = [];
      const text = textFromContent(message.content);
      if (text) parts.push({ text });
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const call of calls) {
        const fn = call && call.function ? call.function : null;
        if (!fn || typeof fn.name !== 'string') continue;
        toolNames.set(call.id, fn.name);
        let args = {};
        if (typeof fn.arguments === 'string' && fn.arguments.trim()) {
          try { args = JSON.parse(fn.arguments); } catch { args = { _raw: fn.arguments }; }
        } else if (fn.arguments && typeof fn.arguments === 'object') {
          args = fn.arguments;
        }
        const { upstreamId, signature } = decodeToolCallId(call.id);
        const part = { functionCall: { name: fn.name, args } };
        if (upstreamId) part.functionCall.id = upstreamId;
        if (signature) part.thoughtSignature = signature; // required by Gemini for replayed calls
        parts.push(part);
      }
      pushContent('model', parts);
      continue;
    }

    // user (and anything unknown is treated as user content)
    if (Array.isArray(message.content)) {
      const parts = [];
      for (const part of message.content) {
        if (!part || typeof part !== 'object') continue;
        if (typeof part.text === 'string') parts.push({ text: part.text });
        else if (part.type === 'image_url' || part.image_url) {
          const converted = await imagePart(part, log);
          if (converted) parts.push(converted);
        }
      }
      pushContent('user', parts);
    } else {
      const text = textFromContent(message.content);
      if (text) pushContent('user', [{ text }]);
    }
  }

  const generationConfig = {};
  const maxOut = Number(body.max_completion_tokens || body.max_tokens || 0);
  if (Number.isFinite(maxOut) && maxOut > 0) {
    generationConfig.maxOutputTokens = Math.min(maxOut, options.maxOutputTokensCap || maxOut);
  }
  if (typeof body.temperature === 'number') generationConfig.temperature = body.temperature;
  if (typeof body.top_p === 'number') generationConfig.topP = body.top_p;
  if (body.stop !== undefined && body.stop !== null) {
    const stop = Array.isArray(body.stop) ? body.stop : [body.stop];
    const sequences = stop.filter((s) => typeof s === 'string' && s).slice(0, 5);
    if (sequences.length > 0) generationConfig.stopSequences = sequences;
  }
  const responseFormat = body.response_format;
  if (responseFormat && responseFormat.type === 'json_object') {
    generationConfig.responseMimeType = 'application/json';
  }

  const effort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort.toLowerCase() : null;
  if (effort) {
    const thinkingConfig = { includeThoughts: true };
    if (effort === 'none' || effort === 'off' || effort === 'minimal') thinkingConfig.thinkingLevel = 'LOW';
    else if (effort === 'low') thinkingConfig.thinkingLevel = 'LOW';
    else thinkingConfig.thinkingLevel = 'HIGH';
    generationConfig.thinkingConfig = thinkingConfig;
  }

  const request = {};
  if (contents.length > 0) request.contents = contents;
  if (systemParts.length > 0) request.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
  const tools = convertTools(body.tools);
  if (tools) request.tools = tools;
  const toolConfig = convertToolChoice(body.tool_choice);
  if (toolConfig) request.toolConfig = toolConfig;
  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;
  request.sessionId = options.sessionId || undefined;
  if (!request.sessionId) delete request.sessionId;

  return {
    model: body.model,
    request,
    meta: { stream: body.stream === true, toolNames },
  };
}

/* ------------------------------------------------------------ response side */

const FINISH_MAP = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  BLOCKLIST: 'content_filter',
  PROHIBITED_CONTENT: 'content_filter',
  SPII: 'content_filter',
  MALFORMED_FUNCTION_CALL: 'stop',
  OTHER: 'stop',
};

export function finishReasonToOpenAi(reason, hadToolCalls) {
  if (hadToolCalls && (!reason || reason === 'STOP')) return 'tool_calls';
  return FINISH_MAP[String(reason || '').toUpperCase()] || 'stop';
}

export function openAiUsage(usageMetadata) {
  if (!usageMetadata || typeof usageMetadata !== 'object') return undefined;
  const prompt = Number(usageMetadata.promptTokenCount) || 0;
  const completion = (Number(usageMetadata.candidatesTokenCount) || 0) +
    (Number(usageMetadata.thoughtsTokenCount) || 0);
  const cached = Number(usageMetadata.cachedContentTokenCount) || 0;
  const total = Number(usageMetadata.totalTokenCount) || prompt + completion;
  const usage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };
  if (cached > 0) usage.prompt_tokens_details = { cached_tokens: cached };
  return usage;
}

/** OpenAI `GET /v1/models` payload from the Antigravity catalogue. */
export function openAiModelList(models, { created = Math.floor(Date.now() / 1000) } = {}) {
  const data = Object.values(models).map((m) => ({
    id: m.id,
    object: 'model',
    created,
    owned_by: m.provider ? 'antigravity-' + m.provider.toLowerCase() : 'antigravity',
  }));
  return { object: 'list', data };
}

/** Full OpenAI chat.completion object for a non-streaming request. */
export function openAiCompletion({ id, model, content, reasoning, toolCalls, finishReason, usage }) {
  const message = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls && toolCalls.length > 0) {
    message.tool_calls = toolCalls;
    if (!message.content) message.content = null;
  }
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** One OpenAI chat.completion.chunk. */
export function openAiChunk({ id, model, created, delta, finishReason, usage }) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: delta || {}, finish_reason: finishReason ?? null, logprobs: null }],
  };
  if (usage) chunk.usage = usage;
  return chunk;
}
