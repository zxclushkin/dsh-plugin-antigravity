// Test doubles: VS Code part classes and an Antigravity client that streams canned SSE.
import { parseGenerationStream } from '../../plugin/src/antigravity.mjs';

export class TextPart {
  constructor(readonly value: string) {}
}

export class ToolCallPart {
  constructor(readonly callId: string, readonly name: string, readonly input: object) {}
}

export class ToolResultPart {
  constructor(readonly callId: string, readonly content: unknown[]) {}
}

export class DataPart {
  constructor(readonly mimeType: string, readonly data: Uint8Array) {}
  static image(data: Uint8Array, mime: string): DataPart {
    return new DataPart(mime, data);
  }
  static text(value: string, mime = 'text/plain'): DataPart {
    return new DataPart(mime, Buffer.from(value, 'utf8'));
  }
}

export const api = {
  LanguageModelTextPart: TextPart as unknown as new (value: string) => { value: string },
  LanguageModelToolCallPart: ToolCallPart,
  LanguageModelDataPart: DataPart,
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
} as any;

export const user = (content: unknown[]) => ({ role: 1, content, name: undefined });
export const assistant = (content: unknown[]) => ({ role: 2, content, name: undefined });

export function sse(events: unknown[]): Uint8Array[] {
  return events.map((event) => Buffer.from('data: ' + JSON.stringify(event) + '\r\n\r\n', 'utf8'));
}

export function textEvent(text: string, extra: Record<string, unknown> = {}): unknown {
  return { response: { candidates: [{ content: { parts: [{ text }] }, ...extra }] } };
}

export function toolEvent(name: string, args: object, options: { id?: string; signature?: string } = {}): unknown {
  const part: Record<string, unknown> = { functionCall: { name, args, ...(options.id ? { id: options.id } : {}) } };
  if (options.signature) part.thoughtSignature = options.signature;
  return { response: { candidates: [{ content: { parts: [part] } }] } };
}

export interface FakeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  body: AsyncIterable<Uint8Array>;
}

export class FakeClient {
  requests: Array<{ model: string; request: any; signal: AbortSignal }> = [];
  constructor(private readonly respond: (call: { model: string; request: any }) => FakeResponse) {}

  async openStream(options: { model: string; request: any; signal: AbortSignal }): Promise<FakeResponse> {
    this.requests.push(options);
    return this.respond({ model: options.model, request: options.request });
  }

  streamEvents(body: AsyncIterable<Uint8Array>) {
    return parseGenerationStream(body);
  }
}

export function streamResponse(chunks: Uint8Array[]): FakeResponse {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    body: (async function* () { yield* chunks; })(),
  };
}

export function errorResponse(status: number, body: string): FakeResponse {
  return {
    ok: false,
    status,
    text: async () => body,
    body: (async function* () {})() as AsyncIterable<Uint8Array>,
  };
}
