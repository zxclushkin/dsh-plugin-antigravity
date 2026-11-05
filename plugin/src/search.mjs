// language: JavaScript (ESM), file: src/search.mjs, runtime: Node >= 20 (DSH host)
// Google Search grounding as an agent tool.
//
// The endpoint rejects `googleSearch` together with functionDeclarations, so a normal agent
// turn (which always carries tools) can never ground. This tool sidesteps that: it issues its
// own grounded generation without any function declarations and returns the answer with
// sources, so any model can search the web by calling `google_search`.
import { AntigravityError, ERROR_CODES, httpError, transportError } from './errors.mjs';

export const SEARCH_TOOL_NAME = 'google_search';
export const DEFAULT_SEARCH_MODEL = 'gemini-3.5-flash-lite';

/** Grounding chunks -> de-duplicated source list. */
function sourcesOf(metadata) {
  const chunks = metadata && Array.isArray(metadata.groundingChunks) ? metadata.groundingChunks : [];
  const seen = new Set();
  const sources = [];
  for (const chunk of chunks) {
    const web = chunk && chunk.web;
    if (!web || typeof web.uri !== 'string') continue;
    if (seen.has(web.uri)) continue;
    seen.add(web.uri);
    sources.push({ title: String(web.title || web.uri), uri: web.uri });
  }
  return sources;
}

/**
 * One grounded generation (server tool googleSearch, no function declarations).
 * @returns {Promise<{text: string, sources: Array<{title: string, uri: string}>, queries: string[]}>}
 */
export async function groundedSearch({ client, model, query, signal, log, throttle, retries = 2 }) {
  const request = {
    contents: [{ role: 'user', parts: [{ text: query }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: { maxOutputTokens: 4096 },
  };
  let response;
  try {
    const send = () => client.openStream({ model, request, signal, retries });
    response = throttle ? await throttle.run(send, signal) : await send();
  } catch (error) {
    throw error instanceof AntigravityError ? error : transportError(error, signal);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw httpError(response.status, body, response.headers);
  }

  let text = '';
  let sources = [];
  let queries = [];
  let finishMessage = '';
  for await (const event of client.streamEvents(response.body)) {
    if (signal && signal.aborted) throw new AntigravityError('search aborted', ERROR_CODES.ABORTED);
    if (event.type === 'text') text += event.text;
    else if (event.type === 'grounding') {
      const found = sourcesOf(event.metadata);
      if (found.length > 0) sources = found;
      if (event.metadata && Array.isArray(event.metadata.webSearchQueries)) {
        queries = event.metadata.webSearchQueries.map(String);
      }
    } else if (event.type === 'finishMessage') {
      finishMessage = event.message;
    }
  }
  if (!text.trim()) {
    throw new AntigravityError(
      finishMessage || 'grounded search returned no answer; retry with a different query',
      ERROR_CODES.EMPTY_RESPONSE,
    );
  }
  if (log && sources.length === 0) log('google_search answered without grounding sources');
  return { text: text.trim(), sources, queries };
}

/** Markdown source list appended to the tool result. */
export function sourcesMarkdown(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return '';
  return 'Sources:\n' + sources.slice(0, 10).map((source, index) => '[' + (index + 1) + '] ' + source.title + ' — ' + source.uri).join('\n');
}

/**
 * Tool definition for the harness registry (same JSON-Schema subset as image_generate).
 */
export function createSearchTool({ client, config, log, throttle }) {
  const features = (config && config.features) || {};
  const model = features.searchModel || DEFAULT_SEARCH_MODEL;
  return {
    name: SEARCH_TOOL_NAME,
    timeoutMs: 120_000,
    description:
      'Search the web with Google Search grounding and return a cited answer. Use it for '
      + 'anything that needs current facts (news, prices, releases, documentation that may have '
      + 'changed). Prefer it over guessing when the answer depends on recent information.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description: 'What to look up. A focused question or a few keywords work best.',
        },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: { type: 'string' },
          sources: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' },
                uri: { type: 'string' },
              },
              required: ['title', 'uri'],
            },
          },
        },
        required: ['answer'],
      },
      render(_args, value) {
        const blocks = [{ type: 'text', text: String(value.answer || '') }];
        const markdown = sourcesMarkdown(value.sources);
        if (markdown) blocks.push({ type: 'text', text: markdown });
        if (!value.sources || value.sources.length === 0) {
          blocks.push({ type: 'text', text: 'No grounding sources were returned for this query.' });
        }
        return blocks;
      },
    },
    async execute(args, exec) {
      const query = String((args && args.query) || '').trim();
      if (!query) throw new AntigravityError('google_search requires a non-empty query', ERROR_CODES.INVALID_REQUEST);
      const result = await groundedSearch({
        client,
        model,
        query,
        signal: exec && exec.signal,
        log,
        throttle,
      });
      return { answer: result.text, sources: result.sources };
    },
  };
}
