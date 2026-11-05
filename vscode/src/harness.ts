// VS Code chat messages -> the message vocabulary the Antigravity transport speaks.
//
// The transport core is shared with the DSH plugin (../plugin/src), so it expects the
// harness shapes: text / image blocks, tool calls with a JSON-string argument payload and
// tool results as their own `tool` messages. This module performs that projection once.
import type * as vscode from 'vscode';
import { isDataPart, isTextPart, isToolCallPart, isToolResultPart, toBytes, type ChatApi } from './parts.js';

export interface HarnessTextBlock {
  type: 'text';
  text: string;
}

export interface HarnessImageBlock {
  type: 'image';
  mimeType: string;
  /** base64, already in the shape the transport forwards to Gemini `inlineData`. */
  data: string;
}

export interface HarnessToolCallBlock {
  type: 'tool-call';
  id: string;
  name: string;
  /** JSON string: the transport replays it as the Gemini functionCall args object. */
  arguments: string;
}

export type HarnessBlock = HarnessTextBlock | HarnessImageBlock | HarnessToolCallBlock;

export interface HarnessMessage {
  role: 'user' | 'assistant' | 'tool';
  content: HarnessBlock[];
  toolCallId?: string;
}

export interface HarnessTool {
  name: string;
  description: string;
  parameters?: unknown;
}

function textOf(part: unknown): string | undefined {
  if (isTextPart(part)) return part.value;
  if (isDataPart(part) && part.mimeType.startsWith('text/')) {
    return Buffer.from(toBytes(part.data)).toString('utf8');
  }
  return undefined;
}

/** Flatten one tool result payload (text parts, text data parts, prompt-tsx JSON). */
export function flattenToolResult(content: ReadonlyArray<unknown>): string {
  const chunks: string[] = [];
  for (const part of content) {
    const text = textOf(part);
    if (text !== undefined) {
      chunks.push(text);
      continue;
    }
    if (part && typeof part === 'object' && 'value' in part) {
      const value = (part as { value: unknown }).value;
      if (typeof value === 'string') chunks.push(value);
      else if (value !== undefined) {
        try {
          chunks.push(JSON.stringify(value));
        } catch {
          // A non-serialisable prompt-tsx value is not worth failing a tool result over.
        }
      }
    }
  }
  return chunks.join('\n');
}

/**
 * Project VS Code's request messages onto the transport's message list.
 *
 * Tool results become standalone `tool` messages because Gemini answers a functionCall
 * with functionResponse parts in the following turn; everything else stays user/assistant.
 */
export function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  api: ChatApi,
): HarnessMessage[] {
  const out: HarnessMessage[] = [];

  for (const message of messages) {
    const parts: ReadonlyArray<unknown> = message.content ?? [];
    const assistant = message.role === api.LanguageModelChatMessageRole.Assistant;

    if (assistant) {
      const blocks: HarnessBlock[] = [];
      for (const part of parts) {
        if (isTextPart(part)) {
          if (part.value) blocks.push({ type: 'text', text: part.value });
          continue;
        }
        if (isToolCallPart(part)) {
          blocks.push({
            type: 'tool-call',
            id: part.callId,
            name: part.name,
            arguments: JSON.stringify(part.input ?? {}),
          });
        }
        // Assistant data parts (for example images echoed back by the UI) are not replayed:
        // Gemini would need a signature that VS Code does not preserve.
      }
      if (blocks.length > 0) out.push({ role: 'assistant', content: blocks });
      continue;
    }

    for (const part of parts) {
      if (!isToolResultPart(part)) continue;
      out.push({
        role: 'tool',
        toolCallId: part.callId,
        content: [{ type: 'text', text: flattenToolResult(part.content) }],
      });
    }

    const blocks: HarnessBlock[] = [];
    for (const part of parts) {
      if (isToolResultPart(part)) continue;
      if (isTextPart(part)) {
        if (part.value) blocks.push({ type: 'text', text: part.value });
        continue;
      }
      if (isDataPart(part) && part.mimeType.startsWith('image/')) {
        blocks.push({
          type: 'image',
          mimeType: part.mimeType,
          data: Buffer.from(toBytes(part.data)).toString('base64'),
        });
      }
      // Remaining data parts (cache markers, proprietary payloads) have no Gemini analogue.
    }
    if (blocks.length > 0) out.push({ role: 'user', content: blocks });
  }

  return out;
}

/** VS Code tool declarations -> the transport's `{name, description, parameters}` tools. */
export function convertTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): HarnessTool[] {
  if (!tools || tools.length === 0) return [];
  const out: HarnessTool[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string' || !tool.name) continue;
    const declaration: HarnessTool = {
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
    };
    if (tool.inputSchema && typeof tool.inputSchema === 'object') declaration.parameters = tool.inputSchema;
    out.push(declaration);
  }
  return out;
}
