// One Antigravity generation mapped to editor-agnostic stream events.
//
// The transport core exposes `openStream` plus an SSE event parser that is already
// verified against the real endpoint; this module turns those upstream events into the
// small vocabulary the VS Code provider needs and translates failures into messages a
// user can act on.
import { httpError, transportError } from '../../plugin/src/errors.mjs';
import { citationText, encodeToolCallId, groundingText, mapFinishReason } from '../../plugin/src/gemini.mjs';

export interface StreamResponse {
  ok: boolean;
  status: number;
  headers?: Headers;
  text(): Promise<string>;
  body: AsyncIterable<Uint8Array> | null;
}

export interface GenerationClient {
  openStream(options: { model: string; request: object; signal: AbortSignal }): Promise<StreamResponse>;
  streamEvents(body: AsyncIterable<Uint8Array>): AsyncGenerator<Record<string, any>>;
}

export interface ThrottleLike {
  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  noteRateLimit?(retryAfterMs?: number): void;
}

export type GenerationEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'toolCall'; callId: string; name: string; input: object }
  | { type: 'image'; mimeType: string; data: Uint8Array };

export interface GenerationOptions {
  client: GenerationClient;
  wireModel: string;
  request: object;
  signal: AbortSignal;
  throttle?: ThrottleLike;
  log?: (message: string) => void;
}

/** A failure that already carries a user-facing message and a stable code. */
export class AntigravityFailure extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'AntigravityFailure';
  }
}

function classify(error: unknown, signal: AbortSignal): AntigravityFailure {
  if (signal.aborted) return new AntigravityFailure('The Antigravity request was cancelled.', 'ABORTED');
  const failure = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: string; message?: string })
    : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (failure?.code && error instanceof Error && error.name === 'LlmError') {
    return new AntigravityFailure(message, failure.code);
  }
  const transport = transportError(error, signal);
  return new AntigravityFailure(transport.message, transport.code);
}

/**
 * Run one generation and yield its output.
 *
 * Text and thinking are streamed as they arrive; a tool call is emitted whole because
 * Gemini sends `functionCall` as a complete part. The call id carries the thought
 * signature so the next turn can replay the call exactly as Gemini requires.
 */
export async function* generate(options: GenerationOptions): AsyncGenerator<GenerationEvent> {
  const { client, wireModel, request, signal, throttle, log = () => {} } = options;
  if (signal.aborted) throw new AntigravityFailure('The Antigravity request was cancelled.', 'ABORTED');

  let response: StreamResponse;
  try {
    const send = () => client.openStream({ model: wireModel, request, signal });
    response = throttle ? await throttle.run(send, signal) : await send();
  } catch (error) {
    throw classify(error, signal);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const failure = httpError(response.status, body, response.headers);
    if (response.status === 429 && throttle?.noteRateLimit) throttle.noteRateLimit(failure.failure?.providerRetryAfterMs);
    throw new AntigravityFailure(failure.message, failure.code);
  }
  if (!response.body) throw new AntigravityFailure('Antigravity returned an empty response body.', 'EMPTY_RESPONSE');

  let visible = false;
  let finishMessage = '';
  let grounding = '';
  let lastCandidate: Record<string, unknown> | null = null;
  let finished = false;

  try {
    for await (const event of client.streamEvents(response.body)) {
      if (signal.aborted) return;
      switch (event.type) {
        case 'text':
          if (event.text) {
            visible = true;
            yield { type: 'text', text: String(event.text) };
          }
          break;
        case 'thought':
          if (event.text) {
            visible = true;
            yield { type: 'thinking', text: String(event.text) };
          }
          break;
        case 'toolCall': {
          const call = event.call ?? {};
          visible = true;
          yield {
            type: 'toolCall',
            callId: encodeToolCallId(call.id, event.thoughtSignature),
            name: String(call.name ?? ''),
            input: (call.args && typeof call.args === 'object' ? call.args : {}) as object,
          };
          break;
        }
        case 'media': {
          const inline = event.part?.inlineData ?? event.part?.fileData;
          const mimeType = String(inline?.mimeType ?? '');
          if (inline?.data && mimeType.startsWith('image/')) {
            visible = true;
            yield { type: 'image', mimeType, data: Buffer.from(String(inline.data), 'base64') };
          } else if (inline?.data) {
            log('skipping unsupported inline media: ' + (mimeType || 'unknown'));
          }
          break;
        }
        case 'grounding':
          grounding = groundingText(event.metadata);
          break;
        case 'citations':
          grounding = citationText(event.metadata);
          break;
        case 'finishMessage':
          finishMessage = String(event.message ?? '');
          break;
        case 'candidate':
          lastCandidate = event.candidate ?? null;
          break;
        case 'finish':
          lastCandidate = { ...(lastCandidate ?? {}), finishReason: event.reason };
          break;
        default:
          break;
      }
    }
  } catch (error) {
    throw classify(error, signal);
  } finally {
    if (!finished) {
      // Abandoned iteration (cancellation) must not leave the connection open.
      const body = response.body as unknown as { cancel?: () => Promise<void> };
      try { await body?.cancel?.(); } catch { /* already closed */ }
    }
  }

  finished = true;
  if (signal.aborted) return;

  if (grounding) yield { type: 'text', text: grounding };

  if (!visible && finishMessage) {
    // Refusals and RECITATION arrive as HTTP 200 with empty content and a finishMessage;
    // reporting them as an empty answer would hide the cause.
    throw new AntigravityFailure(finishMessage, 'EMPTY_RESPONSE');
  }
  const reason = mapFinishReason(lastCandidate, visible) as { kind: string; failure?: { message?: string } };
  if (reason.kind === 'error') {
    throw new AntigravityFailure(reason.failure?.message || 'The model returned an empty response.', 'EMPTY_RESPONSE');
  }
  finished = true;
}
