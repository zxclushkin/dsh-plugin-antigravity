// The LanguageModelChatProvider VS Code drives.
//
// The provider is deliberately free of runtime `vscode` imports: constructors for the
// response parts arrive through `deps.api`, which keeps the whole request path testable
// in Node against the real Antigravity endpoint.
import type * as vscode from 'vscode';
import { buildGenerateRequest } from '../../plugin/src/gemini.mjs';
import { toChatInformation, type CatalogueModel, type ModelCatalogue } from './catalogue.js';
import { generate, AntigravityFailure, type GenerationClient, type ThrottleLike } from './generation.js';
import { convertMessages, convertTools } from './harness.js';
import type { ChatApi } from './parts.js';

export interface ProviderSettings {
  /** Stream the model's reasoning into the answer (VS Code has no separate thinking block). */
  showThinking: boolean;
}

export interface ProviderOptions {
  api: ChatApi;
  client: GenerationClient;
  catalogue: ModelCatalogue;
  settings: () => ProviderSettings;
  throttle: () => ThrottleLike | undefined;
  log: (message: string) => void;
}

type Listener = (event: void) => unknown;
interface Subscription {
  dispose(): void;
}

/** A minimal VS Code `Event<void>` emitter without importing the editor API. */
function createEmitter(): { event: (listener: Listener, thisArgs?: unknown, disposables?: Subscription[]) => Subscription; fire: () => void } {
  const listeners = new Set<Listener>();
  return {
    event: (listener, _thisArgs, disposables) => {
      listeners.add(listener);
      const subscription = { dispose: () => { listeners.delete(listener); } };
      disposables?.push(subscription);
      return subscription;
    },
    fire: () => {
      for (const listener of [...listeners]) {
        try { listener(); } catch { /* a listener must not break the provider */ }
      }
    },
  };
}

/**
 * Build the transport model descriptor for one catalogue entry.
 *
 * `thinkingStyle` mirrors the upstream difference the DSH plugin already encodes:
 * Gemini 2.5 reasons through a token budget, Gemini 3.x through a level.
 */
export function transportModel(entry: CatalogueModel): Record<string, unknown> {
  return {
    id: entry.id,
    kind: entry.kind,
    maxTokens: entry.maxOutputTokens,
    supportsImages: entry.supportsImages,
    thinkingStyle: /^gemini-2\.5/.test(entry.id) ? 'budget' : 'level',
  };
}

/** Only Gemini honours the forced tool-call mode on this endpoint. */
export function canForceToolCall(modelId: string): boolean {
  return /^gemini/i.test(modelId);
}

function estimateTokens(text: string): number {
  // Gemini's tokenizer is not shipped; four characters per token is the usual estimate and
  // is only used for context trimming decisions by the editor.
  return Math.max(1, Math.ceil(text.length / 4));
}

function countMessageChars(message: vscode.LanguageModelChatRequestMessage): number {
  let chars = 0;
  for (const part of message.content ?? []) {
    if (part && typeof part === 'object') {
      if (typeof (part as { value?: unknown }).value === 'string') chars += (part as { value: string }).value.length;
      if (typeof (part as { name?: unknown }).name === 'string') chars += 32;
      if (typeof (part as { data?: unknown }).data === 'object') chars += 1024; // rough image cost
    }
  }
  return chars;
}

export class AntigravityChatProvider implements vscode.LanguageModelChatProvider {
  private readonly emitter = createEmitter();

  constructor(private readonly deps: ProviderOptions) {}

  get onDidChangeLanguageModelChatInformation(): vscode.Event<void> {
    return this.emitter.event as unknown as vscode.Event<void>;
  }

  /** Called after a manual catalogue refresh (and when settings that affect the list change). */
  refreshModelList(): void {
    this.emitter.fire();
  }

  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    try {
      const models = await this.deps.catalogue.load();
      return models.map(toChatInformation);
    } catch (error) {
      // Silent probes come from the model picker before the user asked for anything: an
      // error toast there would be noise. Log it and report "no models" instead.
      if (options.silent) {
        this.deps.log('could not list models: ' + messageOf(error));
        return [];
      }
      throw new Error(friendlyMessage(error));
    }
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const { api, catalogue, log } = this.deps;
    const entry = await catalogue.find(model.id);
    if (!entry) throw new Error('Antigravity does not offer "' + model.id + '" for this account any more.');

    const settings = this.deps.settings();
    const tools = convertTools(options.tools);
    const harnessMessages = convertMessages(messages, api);
    const features: Record<string, unknown> = { googleSearch: false, imageOutput: true };
    if (settings.showThinking && entry.supportsThinking) {
      // Thinking has to be requested explicitly; only models that advertise it get it.
      features.includeThoughts = true;
      features.defaultThinkingLevel = 'medium';
    }

    let built: { model: string; request: Record<string, unknown> };
    try {
      built = await buildGenerateRequest(
        { messages: harnessMessages, tools },
        transportModel(entry),
        features,
        (block: { mimeType: string; data: string }) => Promise.resolve({ mimeType: block.mimeType, data: block.data }),
      ) as { model: string; request: Record<string, unknown> };
    } catch (error) {
      throw new Error('could not prepare the Antigravity request: ' + messageOf(error));
    }

    if (tools.length > 0 && options.toolMode === api.LanguageModelChatToolMode.Required && canForceToolCall(entry.id)) {
      // Gemini's "must call a tool" mode. Without it a Required turn may answer in prose.
      // Antigravity's Claude models reject tool_choice "any" (HTTP 400), so they keep Auto and
      // the prompt alone decides — better a prose answer than a failed turn.
      built.request.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
    }

    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    let reported = false;

    try {
      for await (const event of generate({
        client: this.deps.client,
        wireModel: built.model,
        request: built.request,
        signal: controller.signal,
        throttle: this.deps.throttle(),
        log,
      })) {
        if (controller.signal.aborted) break;
        if (event.type === 'text') {
          progress.report(new api.LanguageModelTextPart(event.text));
          reported = true;
        } else if (event.type === 'thinking') {
          if (settings.showThinking) {
            progress.report(new api.LanguageModelTextPart(event.text));
            reported = true;
          }
        } else if (event.type === 'toolCall') {
          progress.report(new api.LanguageModelToolCallPart(event.callId, event.name, event.input));
          reported = true;
        } else if (event.type === 'image') {
          progress.report(api.LanguageModelDataPart.image(event.data, event.mimeType));
          reported = true;
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      throw new Error(friendlyMessage(error));
    } finally {
      subscription.dispose();
    }

    if (!reported && !controller.signal.aborted) {
      throw new Error('Antigravity returned an empty answer. Try again, or switch the model.');
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    if (typeof text === 'string') return estimateTokens(text);
    return Math.max(1, Math.ceil(countMessageChars(text) / 4));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Turn transport failures into something a person can act on. */
export function friendlyMessage(error: unknown): string {
  const failure = error as AntigravityFailure | undefined;
  const message = messageOf(error);
  switch (failure?.code) {
    case 'MISSING_CREDENTIAL':
      return 'Antigravity is not signed in on this machine. Open Antigravity, sign in, then retry.';
    case 'INVALID_CREDENTIAL':
      return 'The stored Antigravity session is no longer valid. Sign in to Antigravity again, then retry.';
    case 'AUTH':
      return 'Antigravity rejected the request: ' + message;
    case 'RATE_LIMIT':
      return 'The Antigravity plan is rate-limiting requests right now. ' + message;
    case 'QUOTA':
      return 'The Antigravity quota for this model is exhausted. ' + message;
    case 'CONTEXT_WINDOW_EXCEEDED':
      return 'This conversation is larger than the model context window. Remove attachments or start a new chat.';
    case 'UNKNOWN_MODEL':
      return 'That model is not offered by this Antigravity account any more. Refresh the model list.';
    case 'SERVER':
      return 'Antigravity had a server error. Try again. ' + message;
    default:
      return message;
  }
}
