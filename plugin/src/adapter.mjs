// language: JavaScript (ESM), file: src/adapter.mjs, runtime: Node >= 20 (DSH host)
// Native DSH LLM adapter for Google Antigravity models.
//
// Implements the duck-typed adapter contract of @deepseek-ai/dsh-llm without
// importing it: providerInfo / providerRetryPolicy / listModels / resolveModel /
// prepareCall / stream / imageRequestTarget. Streams harness `StreamChunk`s
// (text-delta, reasoning-delta, tool-call-delta, usage, finish) and never speaks
// the OpenAI protocol — there is no local HTTP hop.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AntigravityError, ERROR_CODES, httpError, transportError, abortedError } from './errors.mjs';
import {
  buildGenerateRequest, citationText, encodeToolCallId, groundingText, mapFinishReason, mapUsage,
  reasoningEffortsFor,
} from './gemini.mjs';

const PROVIDER = 'antigravity';

// Models that answer but are not usable as chat/image models: IDE tab completions,
// internal chat_* routers (400 INVALID_ARGUMENT) and Antigravity's tiered routers.
const NOT_A_MODEL = /^(tab_|chat_)|-tiered$/i;
const IMAGE_MODEL = /-image$/i;

const CAP = new Set(['claude', 'gemini', 'sonnet', 'opus', 'flash', 'lite', 'pro', 'thinking', 'image']);
const cap = (word) => word[0].toUpperCase() + word.slice(1);

/** Human model name derived from the wire id (Antigravity's own displayName aliases models). */
export function prettyModelName(id) {
  const tokens = String(id).split('-');
  const words = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = tokens[i + 1];
    if (/^\d+$/.test(token) && /^\d+$/.test(next || '')) { words.push(token + '.' + next); i++; continue; }
    if (token === 'gpt' && next === 'oss') { words.push('GPT-OSS'); i++; continue; }
    if (/^\d+b$/i.test(token)) { words.push(token.toUpperCase()); continue; }
    if (['medium', 'high', 'low'].includes(token)) { words.push('(' + cap(token) + ')'); continue; }
    if (CAP.has(token)) { words.push(cap(token)); continue; }
    words.push(token);
  }
  return words.join(' ');
}

function defaultMediaDir() {
  return path.join(os.tmpdir(), 'dsh-antigravity-media');
}

/** One catalogue entry -> harness model metadata. */
export function toModelInfo(entry) {
  const input = ['text'];
  if (entry.supportsImages || entry.kind === 'image') input.push('image');
  const info = {
    provider: PROVIDER,
    id: entry.id,
    name: prettyModelName(entry.id),
    description: entry.kind === 'image' ? 'Antigravity image model' : 'Antigravity model',
    inputModalities: input,
    context: { contextWindow: entry.contextWindow || 1_048_576 },
    defaultMaxTokens: entry.maxTokens || 65_536,
  };
  const reasoning = entry.kind === 'image' ? undefined : reasoningEffortsFor(entry);
  if (reasoning) info.reasoning = reasoning;
  return info;
}

export class AntigravityAdapter {
  /**
   * @param {object} deps
   * @param {object} deps.client Antigravity API client (src/antigravity.mjs).
   * @param {object} deps.config resolved plugin config.
   * @param {() => object | undefined} deps.getAttachments lazy attachment-service getter.
   * @param {(message: string) => void} [deps.log]
   */
  constructor({ client, config, getAttachments, log }) {
    this.client = client;
    this.config = config;
    this.features = config.features || {};
    this.getAttachments = getAttachments || (() => undefined);
    this.log = log || (() => {});
    this.catalogue = null;
    this.catalogueAt = 0;
    this.catalogueRequest = null;
    this.mediaDir = this.features.mediaOutputDir || defaultMediaDir();
  }

  providerInfo(provider) {
    return { id: provider, name: 'Antigravity' };
  }

  // Called unconditionally at registration; undefined means the default retry policy.
  providerRetryPolicy() {
    return undefined;
  }

  // Images are normalized by the attachment service; keep the source geometry.
  imageRequestTarget(_provider, _model, image) {
    const width = Number(image && image.width) > 0 ? Number(image.width) : 1024;
    const height = Number(image && image.height) > 0 ? Number(image.height) : 1024;
    const bytes = Number(image && image.bytes) > 0 ? Number(image.bytes) : 4 * 1024 * 1024;
    return { width, height, maxBytes: Math.min(bytes, this.features.imageMaxBytes || 4 * 1024 * 1024) };
  }

  /* ------------------------------------------------------------- catalogue */

  async loadCatalogue({ force = false } = {}) {
    const ttl = this.config.modelCacheTtlMs || 600_000;
    if (!force && this.catalogue && Date.now() - this.catalogueAt < ttl) return this.catalogue;
    if (!this.catalogueRequest) {
      this.catalogueRequest = this.client.fetchModels()
        .then(({ models, defaultModelId }) => {
          const entries = {};
          for (const [id, model] of Object.entries(models)) {
            if (!NOT_A_MODEL.test(id) && !IMAGE_MODEL.test(id)) {
              entries[id] = { ...model, id, kind: 'chat' };
            }
          }
          this.catalogue = { models: entries, imageModels: imageCatalogue(models), defaultModelId };
          this.catalogueAt = Date.now();
          return this.catalogue;
        })
        .finally(() => { this.catalogueRequest = null; });
    }
    return this.catalogueRequest;
  }

  async listModels(provider) {
    const { models, imageModels } = await this.loadCatalogue();
    const all = [...Object.values(models), ...Object.values(imageModels)];
    return all.map((entry) => {
      const info = toModelInfo(entry);
      return {
        provider,
        id: info.id,
        name: info.name,
        description: info.description,
        inputModalities: info.inputModalities,
      };
    });
  }

  async resolveModel(provider, model, _signal) {
    let entry = await this.findEntry(model);
    if (!entry) {
      const refreshed = await this.loadCatalogue({ force: true });
      entry = refreshed.models[model] || refreshed.imageModels[model];
    }
    if (!entry) {
      throw new AntigravityError('Antigravity does not offer model "' + model + '" for this account', ERROR_CODES.UNKNOWN_MODEL);
    }
    return toModelInfo(entry);
  }

  async findEntry(model) {
    const { models, imageModels } = await this.loadCatalogue();
    return models[model] || imageModels[model] || undefined;
  }

  async prepareCall(provider, model, signal) {
    const info = await this.resolveModel(provider, model, signal);
    return { model: info, stream: (options) => this.stream(options) };
  }

  /* ---------------------------------------------------------------- images */

  /** Resolve one harness image block to Gemini inlineData through the attachment service. */
  async resolveImage(block, signal) {
    const ref = block && block.attachment;
    if (!ref) return null;
    const attachments = this.getAttachments();
    if (!attachments || typeof attachments.readImageRequest !== 'function') {
      throw new AntigravityError('image input requires the harness attachment service', ERROR_CODES.UNSUPPORTED_CONTENT);
    }
    const target = {
      width: Number(ref.width) > 0 ? Number(ref.width) : 1024,
      height: Number(ref.height) > 0 ? Number(ref.height) : 1024,
      maxBytes: this.features.imageMaxBytes || 4 * 1024 * 1024,
    };
    const version = await attachments.readImageRequest(ref, target, signal);
    if (!version || !version.data) return null;
    return {
      mimeType: version.mediaType || ref.mediaType || 'image/png',
      data: Buffer.from(version.data).toString('base64'),
    };
  }

  /* ---------------------------------------------------------------- stream */

  async *stream(options) {
    const signal = options.signal;
    if (signal && signal.aborted) throw abortedError();
    const entry = await this.findEntry(options.model);
    if (!entry) throw new AntigravityError('unknown Antigravity model "' + options.model + '"', ERROR_CODES.UNKNOWN_MODEL);
    const info = toModelInfo(entry);
    const model = {
      ...entry,
      ...info,
      // Gemini 2.5 reasons through a token budget; Gemini 3.x through a level.
      thinkingStyle: /^gemini-2\.5/.test(entry.id) ? 'budget' : 'level',
    };

    const { request, model: wireModel } = await buildGenerateRequest(
      options, model, this.features, (block) => this.resolveImage(block, signal),
    );
    if (this.features.googleSearch && Array.isArray(options.tools) && options.tools.length > 0 &&
        !this.groundingSkipped) {
      // The endpoint rejects googleSearch together with functionDeclarations; tool-using
      // turns therefore cannot ground. Say it once instead of failing every request.
      this.groundingSkipped = true;
      this.log('googleSearch grounding is skipped on turns that pass tools (endpoint limitation)');
    }

    let response;
    try {
      response = await this.client.openStream({ model: wireModel, request, signal });
    } catch (error) {
      throw classifyFailure(error, signal);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw httpError(response.status, text, response.headers);
    }

    const index = { text: undefined, reasoning: undefined, next: 0 };
    let grounding = '';
    let usage;
    let lastCandidate = null;
    let lastFinishMessage = '';
    let visible = false;
    let finishEmitted = false;

    const delta = (kind, text) => {
      if (index[kind] === undefined) index[kind] = index.next++;
      return kind === 'text'
        ? { type: 'text-delta', index: index[kind], text }
        : { type: 'reasoning-delta', index: index[kind], text };
    };

    try {
      for await (const event of this.client.streamEvents(response.body)) {
        if (signal && signal.aborted) throw abortedError();
        if (event.type === 'text') {
          if (!event.text) continue;
          visible = true;
          yield delta('text', event.text);
        } else if (event.type === 'thought') {
          if (!event.text) continue;
          visible = true;
          yield delta('reasoning', event.text);
        } else if (event.type === 'toolCall') {
          visible = true;
          const id = encodeToolCallId(event.call.id, event.thoughtSignature);
          const argumentsJson = JSON.stringify(event.call.args || {});
          yield {
            type: 'tool-call-delta',
            index: index.next++,
            id,
            name: event.call.name,
            argumentsDelta: argumentsJson,
          };
        } else if (event.type === 'code') {
          visible = true;
          const language = event.language || 'python';
          const payload = event.kind === 'result'
            ? '\n\nOutput:\n```\n' + (event.text || '') + '\n```\n\n'
            : '\n\n```' + language + '\n' + (event.text || '') + '\n```\n\n';
          yield delta('text', payload);
        } else if (event.type === 'media') {
          const saved = await this.persistMedia(event.part, signal);
          if (saved) {
            visible = true;
            yield delta('text', '\n\n![' + saved.kind + '](' + saved.file + ')\n\n');
          }
        } else if (event.type === 'grounding') {
          grounding = groundingText(event.metadata);
        } else if (event.type === 'citations') {
          grounding = citationText(event.metadata);
        } else if (event.type === 'finishMessage') {
          lastFinishMessage = event.message;
        } else if (event.type === 'finish') {
          lastCandidate = { ...(lastCandidate || {}), finishReason: event.reason };
        } else if (event.type === 'usage') {
          usage = mapUsage(event.usage);
        } else if (event.type === 'candidate') {
          lastCandidate = event.candidate;
        }
      }
      if (grounding) yield delta('text', grounding);
      yield { type: 'usage', usage: usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      if (!visible && lastFinishMessage) {
        // Image generation and RECITATION report failures as HTTP 200 + empty content + a
        // finishMessage; a successful empty answer would hide the cause from the user.
        finishEmitted = true;
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { code: ERROR_CODES.EMPTY_RESPONSE, message: lastFinishMessage } },
        };
        return;
      }
      const reason = visible
        ? mapFinishReason(lastCandidate, true)
        : mapFinishReason(lastCandidate, false);
      finishEmitted = true;
      yield { type: 'finish', reason };
    } catch (error) {
      if (signal && signal.aborted) throw abortedError();
      throw classifyFailure(error, signal);
    } finally {
      if (!finishEmitted) {
        // An abandoned iterator (harness cancellation) must not leave the connection open.
        try { await response.body?.cancel?.(); } catch { /* already closed */ }
      }
    }
  }

  /** Persist one generated image/audio part and return its absolute path. */
  async persistMedia(part, signal) {
    const inline = part && (part.inlineData || part.fileData);
    if (!inline) return null;
    if (!inline.data) return null;
    const mimeType = String(inline.mimeType || 'image/jpeg');
    const extension = mimeType.split('/')[1]?.split(';')[0] || 'bin';
    const kind = mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('audio/') ? 'audio' : 'media';
    const dir = this.mediaDir;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'ag-' + crypto.randomBytes(8).toString('hex') + '.' + extension);
      fs.writeFileSync(file, Buffer.from(inline.data, 'base64'));
      if (signal && signal.aborted) return null;
      return { file, kind };
    } catch (error) {
      this.log('could not save generated media: ' + error.message);
      return null;
    }
  }
}

/** Classify a failure thrown by the API client into harness failure facts. */
function classifyFailure(error, signal) {
  if (error instanceof AntigravityError) return error;
  if (error && Number.isInteger(error.status) && error.status >= 400) {
    return httpError(error.status, String(error.body || error.message || ''), error.headers);
  }
  return transportError(error, signal);
}

/** Image-generation models advertised by the account, keyed by id. */
function imageCatalogue(models) {  const out = {};
  for (const [id, model] of Object.entries(models || {})) {
    if (!IMAGE_MODEL.test(id)) continue;
    out[id] = { ...model, id, kind: 'image', supportsImages: true };
  }
  return out;
}
