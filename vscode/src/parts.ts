// Structural (duck-typed) view of the VS Code chat part classes.
//
// The provider never imports the `vscode` module at runtime: everything it needs is a
// class constructor injected through {@link ChatApi}. That keeps the provider testable
// in plain Node and immune to class-identity differences between bundles.

export interface TextPartLike {
  readonly value: string;
}

export interface ToolCallPartLike {
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ToolResultPartLike {
  readonly callId: string;
  readonly content: ReadonlyArray<unknown>;
}

export interface DataPartLike {
  readonly mimeType: string;
  readonly data: Uint8Array;
}

/** What the tool-call constructor returns: a response part VS Code can render. */
export interface CreatedToolCallPart {
  readonly callId: string;
  readonly name: string;
  readonly input: object;
}

/** Minimal surface of the `vscode` namespace the provider constructs parts with. */
export interface ChatApi {
  readonly LanguageModelTextPart: new (value: string) => TextPartLike;
  readonly LanguageModelToolCallPart: new (callId: string, name: string, input: object) => CreatedToolCallPart;
  readonly LanguageModelDataPart: { image(data: Uint8Array, mime: string): DataPartLike };
  readonly LanguageModelChatMessageRole: { readonly User: number; readonly Assistant: number };
  readonly LanguageModelChatToolMode: { readonly Auto: number; readonly Required: number };
}

type Bag = Record<string, unknown>;

function bag(part: unknown): Bag | undefined {
  return part && typeof part === 'object' ? (part as Bag) : undefined;
}

export function isTextPart(part: unknown): part is TextPartLike {
  return typeof bag(part)?.value === 'string';
}

export function isToolCallPart(part: unknown): part is ToolCallPartLike {
  const value = bag(part);
  return !!value && typeof value.callId === 'string' && typeof value.name === 'string' && 'input' in value;
}

export function isToolResultPart(part: unknown): part is ToolResultPartLike {
  const value = bag(part);
  return !!value && typeof value.callId === 'string' && Array.isArray(value.content);
}

export function isDataPart(part: unknown): part is DataPartLike {
  const value = bag(part);
  return !!value && typeof value.mimeType === 'string' && (value.data instanceof Uint8Array || value.data instanceof ArrayBuffer);
}

export function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}
