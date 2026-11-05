// language: JavaScript (ESM), file: src/gemini.mjs, runtime: Node >= 20 (DSH host)
// Translation between the harness message/stream vocabulary and Antigravity's
// Gemini-shaped v1internal protocol.
//
// Harness side (see @deepseek-ai/dsh-llm): messages of role system/developer/user/
// assistant/tool whose content is a list of blocks — {type:'text'}, {type:'reasoning'},
// {type:'tool-call', id, name, arguments} (arguments is a JSON string), {type:'tool'}.
// Upstream side: {contents, systemInstruction, tools, toolConfig, generationConfig}.

/* --------------------------------------------------------------- tool schema */

const SCHEMA_KEYS = new Set(['type', 'description', 'enum', 'items', 'properties', 'required', 'nullable', 'anyOf', 'format']);

/** Gemini enum spelling for a JSON-schema type. */
function upperType(type) {
  if (typeof type !== 'string') return undefined;
  const map = {
    object: 'OBJECT', string: 'STRING', number: 'NUMBER', integer: 'INTEGER',
    boolean: 'BOOLEAN', array: 'ARRAY', null: 'NULL',
  };
  return map[type.toLowerCase()] || (type === type.toUpperCase() ? type : undefined);
}

/**
 * OpenAI/JSON-Schema -> Gemini `Schema`.
 * Gemini rejects unknown keywords, so this is an allowlist rather than a copy.
 * A top-level no-argument schema is dropped by {@link convertToolDeclarations} —
 * Anthropic rejects an empty-properties OBJECT and Gemini invents arguments for it.
 */
export function convertSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 14) return { type: 'STRING' };

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
    out.enum = schema.enum.map((value) => (typeof value === 'string' ? value : JSON.stringify(value)));
  }
  if (type === 'ARRAY') {
    out.items = convertSchema(schema.items || { type: 'string' }, depth + 1);
  }
  if (type === 'OBJECT') {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
    if (properties && Object.keys(properties).length > 0) {
      out.properties = {};
      for (const [key, value] of Object.entries(properties)) {
        out.properties[key] = convertSchema(value, depth + 1);
      }
      const required = Array.isArray(schema.required)
        ? schema.required.filter((name) => Object.prototype.hasOwnProperty.call(out.properties, name))
        : [];
      if (required.length > 0) out.required = required;
    } else {
      // Nested empty object: a free-form object is a JSON string in practice.
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

/**
 * Harness tool declarations -> Gemini `functionDeclarations`.
 * `tools` here are the harness ones: {name, description, parameters?, deferLoading?}.
 */
export function convertToolDeclarations(tools) {
  const declarations = [];
  for (const tool of tools || []) {
    if (!tool || typeof tool.name !== 'string' || !tool.name) continue;
    if (tool.deferLoading === true) continue;
    const declaration = { name: tool.name };
    if (typeof tool.description === 'string' && tool.description) declaration.description = tool.description;
    // No-argument tools are declared WITHOUT parameters: the only shape Gemini and
    // Anthropic-via-Antigravity both accept without inventing arguments.
    if (!isEmptyObjectSchema(tool.parameters)) declaration.parameters = convertSchema(tool.parameters);
    declarations.push(declaration);
  }
  return declarations;
}

/** Gemini `responseSchema` (structured output) — keeps the bounds Gemini accepts. */
export function convertResponseSchema(schema) {
  const converted = convertSchema(schema);
  return converted;
}

/* --------------------------------------------------------------- thinking */

/** Effort ids the harness may pass in `options.reasoningEffort`. */
export const REASONING_EFFORT_IDS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Levels surfaced in the DSH model picker for thinking-capable Google models. */
export function reasoningEffortsFor(model) {
  if (!model.supportsThinking) return undefined;
  return {
    efforts: [
      { id: 'low', name: 'Low' },
      { id: 'medium', name: 'Medium' },
      { id: 'high', name: 'High' },
    ],
    defaultEffort: 'medium',
  };
}

/**
 * Map a harness reasoning effort to Gemini `thinkingConfig`.
 * Verified live on the Antigravity endpoint: `thinkingBudget` must be > 0 (0 is a
 * 400), -1 means dynamic, and `thinkingLevel` LOW/MEDIUM/HIGH are all accepted.
 */
const DEFAULT_THINKING_BUDGETS = { low: 1024, medium: 4096, high: 16384 };

export function convertThinking(effort, model, features) {
  const chosen = effort ?? features.defaultThinkingLevel;
  if (chosen === undefined) return undefined;
  const level = thinkingLevelOf(chosen);
  if (level === undefined) return undefined;
  const thinkingConfig = { includeThoughts: features.includeThoughts !== false };
  if (model.thinkingStyle === 'budget') {
    const budgets = { ...DEFAULT_THINKING_BUDGETS, ...(features.thinkingBudgets || {}) };
    thinkingConfig.thinkingBudget = budgets[level];
  } else {
    thinkingConfig.thinkingLevel = level.toUpperCase();
  }
  return thinkingConfig;
}

function thinkingLevelOf(chosen) {
  switch (chosen) {
    case 'minimal':
    case 'off':
      // Gemini has no true "off"; LOW is the smallest accepted level.
      return 'low';
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'xhigh':
    case 'max':
      return 'high';
    default:
      return undefined;
  }
}

/* --------------------------------------------------------------- messages */

const TOOL_ID_SEP = '__sig_';

/** Encode a Gemini thoughtSignature inside the harness tool-call id so it survives replay. */
export function encodeToolCallId(upstreamId, signature) {
  const base = String(upstreamId || 'call_' + Math.random().toString(36).slice(2, 10));
  if (!signature) return base;
  return base + TOOL_ID_SEP + Buffer.from(signature, 'utf8').toString('base64url');
}

/** Split an encoded tool-call id back into upstream id and replayed signature. */
export function decodeToolCallId(id) {
  const text = String(id || '');
  const at = text.indexOf(TOOL_ID_SEP);
  if (at < 0) return { upstreamId: text || undefined, signature: undefined };
  return {
    upstreamId: text.slice(0, at) || undefined,
    signature: Buffer.from(text.slice(at + TOOL_ID_SEP.length), 'base64url').toString('utf8'),
  };
}

function flattenText(message) {
  return (message.content || [])
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * Build `contents`, `systemInstruction` and the tool-name map.
 * @param {object} options GenerateOptions from the harness.
 * @param {(block: object) => Promise<{mimeType: string, data: string} | null>} resolveImage
 *   turns one harness image block into Gemini inlineData, or null when unavailable.
 */
export async function buildContents(options, resolveImage) {
  const systemParts = [];
  if (typeof options.system === 'string' && options.system) systemParts.push(options.system);
  const contents = [];
  const toolNames = new Map();

  // Tool names are needed when a later tool-role message answers an earlier call.
  for (const message of options.messages || []) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content || []) {
      if (block && block.type === 'tool-call' && typeof block.name === 'string') toolNames.set(block.id, block.name);
    }
  }

  const push = (role, parts) => {
    if (parts.length === 0) return;
    const last = contents[contents.length - 1];
    // Gemini wants alternating roles; merging also keeps a tool-result burst in one user turn.
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };

  for (const message of options.messages || []) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role;

    if (role === 'system' || role === 'developer') {
      const text = flattenText(message);
      if (text) systemParts.push(text);
      continue;
    }

    if (role === 'tool') {
      const callId = message.toolCallId;
      const name = toolNames.get(callId) || 'unknown_function';
      const text = flattenText(message);
      let response;
      try {
        const parsed = JSON.parse(text);
        response = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { result: parsed };
      } catch {
        response = { result: text };
      }
      const { upstreamId } = decodeToolCallId(callId);
      const part = { functionResponse: { name, response } };
      if (upstreamId) part.functionResponse.id = upstreamId;
      push('user', [part]);
      continue;
    }

    if (role === 'assistant') {
      const parts = [];
      for (const block of message.content || []) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') {
          if (block.text) parts.push({ text: block.text });
        } else if (block.type === 'tool-call') {
          let args = {};
          if (typeof block.arguments === 'string' && block.arguments.trim()) {
            try { args = JSON.parse(block.arguments); } catch { args = { _raw: block.arguments }; }
          } else if (block.arguments && typeof block.arguments === 'object') {
            args = block.arguments;
          }
          const { upstreamId, signature } = decodeToolCallId(block.id);
          const part = { functionCall: { name: block.name, args } };
          if (upstreamId) part.functionCall.id = upstreamId;
          // Gemini rejects a replayed functionCall that lost its thoughtSignature.
          if (signature) part.thoughtSignature = signature;
          parts.push(part);
        }
        // reasoning blocks are not replayed: their signatures are unrecoverable, and
        // Gemini re-derives reasoning on the next turn anyway.
      }
      push('model', parts);
      continue;
    }

    // user and any unknown role
    const parts = [];
    for (const block of message.content || []) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') {
        if (block.text) parts.push({ text: block.text });
      } else if (block.type === 'image') {
        const inline = await resolveImage(block);
        if (inline) parts.push({ inlineData: inline });
      }
      // file blocks never reach an adapter: the harness projects them to text handles.
    }
    push('user', parts);
  }

  return {
    contents,
    systemInstruction: systemParts.length > 0 ? { parts: [{ text: systemParts.join('\n\n') }] } : undefined,
    toolNames,
  };
}

/* --------------------------------------------------------------- request */

/**
 * Assemble the v1internal request body for one generation.
 * @returns {{request: object, model: string}}
 */
export async function buildGenerateRequest(options, model, features, resolveImage) {
  const { contents, systemInstruction } = await buildContents(options, resolveImage);
  const request = {};
  if (contents.length > 0) request.contents = contents;
  if (systemInstruction) request.systemInstruction = systemInstruction;

  const declarations = convertToolDeclarations(options.tools);
  const serverTools = serverToolDeclarations(features);
  const tools = serverToolDeclarations(features);
  if (declarations.length > 0) {
    // The endpoint rejects googleSearch together with functionDeclarations (HTTP 400, even
    // with include_server_side_tool_invocations), so a tool-using agent turn cannot ground.
    request.tools = [{ functionDeclarations: declarations }];
  } else if (tools.length > 0) {
    request.tools = tools;
  }

  const generationConfig = {};
  if (typeof options.temperature === 'number') generationConfig.temperature = options.temperature;
  if (typeof options.maxTokens === 'number' && options.maxTokens > 0) {
    const caps = [options.maxTokens];
    if (Number(model.maxTokens) > 0) caps.push(Number(model.maxTokens));
    if (Number(features.maxOutputTokensCap) > 0) caps.push(Number(features.maxOutputTokensCap));
    generationConfig.maxOutputTokens = Math.min(...caps);
  }
  if (Array.isArray(options.stop) && options.stop.length > 0) {
    generationConfig.stopSequences = options.stop.filter((value) => typeof value === 'string' && value).slice(0, 5);
  }
  const thinkingConfig = convertThinking(options.reasoningEffort, model, features);
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  if (features.responseMimeType) generationConfig.responseMimeType = features.responseMimeType;
  if (features.responseSchema) {
    generationConfig.responseMimeType = features.responseMimeType || 'application/json';
    generationConfig.responseSchema = convertResponseSchema(features.responseSchema);
  }
  if (model.outputModalities && features.imageOutput !== false) {
    generationConfig.responseModalities = model.outputModalities;
  }
  if (model.kind === 'image') {
    generationConfig.responseModalities = ['TEXT', 'IMAGE'];
    // Verified live: without imageConfig the image model answers 200 with a finishMessage
    // instead of pixels; with it, an inlineData/jpeg part is produced.
    generationConfig.imageConfig = { aspectRatio: features.imageAspectRatio || '1:1' };
  }
  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;
  if (features.safetySettings) request.safetySettings = features.safetySettings;

  return { model: model.id, request };
}

/** Server-side Google tools enabled in the plugin config. Only Google Search is real:
 *  googleMaps/urlContext/codeExecution are accepted by the endpoint but silently ignored. */
export function serverToolDeclarations(features) {
  const tools = [];
  if (features.googleSearch) tools.push({ googleSearch: {} });
  return tools;
}

/* --------------------------------------------------------------- response */

/** Harness usage shape from Gemini `usageMetadata`. */
export function mapUsage(usageMetadata) {
  if (!usageMetadata || typeof usageMetadata !== 'object') return undefined;
  const input = Number(usageMetadata.promptTokenCount) || 0;
  const output = (Number(usageMetadata.candidatesTokenCount) || 0) +
    (Number(usageMetadata.thoughtsTokenCount) || 0);
  const cached = Number(usageMetadata.cachedContentTokenCount) || 0;
  const total = Number(usageMetadata.totalTokenCount) || input + output;
  const usage = { inputTokens: input, outputTokens: output, totalTokens: total };
  if (cached > 0) usage.cacheReadTokens = cached;
  return usage;
}

/** Harness finish reason from a Gemini candidate. */
export function mapFinishReason(candidate, hadVisibleContent) {
  const reason = String((candidate && candidate.finishReason) || '').toUpperCase();
  if (reason === 'MAX_TOKENS') return { kind: 'max-tokens' };
  if (reason === 'SAFETY' || reason === 'RECITATION' || reason === 'BLOCKLIST' ||
    reason === 'PROHIBITED_CONTENT' || reason === 'SPII') {
    return { kind: 'stop' };
  }
  if (reason === 'MALFORMED_FUNCTION_CALL') {
    return { kind: 'error', failure: { code: 'INVALID_REQUEST', message: 'model produced a malformed function call' } };
  }
  if (!hadVisibleContent) {
    return { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'model returned a completed response with no content' } };
  }
  return { kind: 'stop' };
}

/** Serialized grounding/citation markers appended to assistant text. */
export function groundingText(metadata) {
  if (!metadata || typeof metadata !== 'object') return '';
  const chunks = Array.isArray(metadata.groundingChunks) ? metadata.groundingChunks : [];
  const sources = [];
  for (const chunk of chunks) {
    const web = chunk && chunk.web;
    if (web && typeof web.uri === 'string') sources.push({ title: web.title || web.uri, uri: web.uri });
  }
  if (sources.length === 0) return '';
  const lines = sources.slice(0, 10).map((source, index) => '[' + (index + 1) + '] ' + source.title + ' — ' + source.uri);
  return '\n\nSources:\n' + lines.join('\n');
}

/** Serialized citation list from `citationMetadata.citations`. */
export function citationText(metadata) {
  const citations = metadata && Array.isArray(metadata.citations) ? metadata.citations : [];
  const uris = [...new Set(citations.map((citation) => citation && citation.uri).filter((uri) => typeof uri === 'string'))];
  if (uris.length === 0) return '';
  return '\n\nSources:\n' + uris.slice(0, 10).map((uri, index) => '[' + (index + 1) + '] ' + uri).join('\n');
}
