// Account model catalogue -> VS Code model metadata.
//
// Antigravity advertises every model the plan can reach (17 chat models plus image
// models on the reference account). The transport core already knows how to fetch that
// list; this module filters out the entries that are not chat models (IDE tab
// completions, internal routers, tiered aliases) and shapes the rest for the picker.
import type * as vscode from 'vscode';
import { prettyModelName } from '../../plugin/src/adapter.mjs';

/** IDE tab-completion models, internal routers and tiered aliases answer, but not as chat models. */
const NOT_A_MODEL = /^(tab_|chat_)|-tiered$/i;
const IMAGE_MODEL = /-image$/i;

const DEFAULT_CONTEXT_WINDOW = 1_048_576;
const DEFAULT_MAX_OUTPUT = 65_536;

export interface RawModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  supportsImages?: boolean;
  supportsThinking?: boolean;
  recommended?: boolean;
}

export interface CatalogueClient {
  fetchModels(): Promise<{ models: Record<string, RawModel>; defaultModelId: string | null }>;
}

export interface CatalogueModel {
  id: string;
  kind: 'chat' | 'image';
  contextWindow: number;
  maxOutputTokens: number;
  supportsImages: boolean;
  supportsThinking: boolean;
  recommended: boolean;
}

function familyOf(id: string): string {
  if (id.startsWith('claude')) return 'antigravity-claude';
  if (id.startsWith('gpt-oss')) return 'antigravity-gpt-oss';
  if (IMAGE_MODEL.test(id)) return 'antigravity-image';
  return 'antigravity-gemini';
}

function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return Math.round(tokens / 100_000) / 10 + 'M';
  return Math.round(tokens / 1024) + 'K';
}

/** Catalogue entry -> the metadata VS Code renders in the model picker. */
export function toChatInformation(model: CatalogueModel): vscode.LanguageModelChatInformation {
  const tooltip = [
    model.id,
    'context ' + contextLabel(model.contextWindow),
    model.supportsImages ? 'image input' : undefined,
    model.kind === 'image' ? 'generates images' : undefined,
  ].filter(Boolean).join(' · ');
  return {
    id: model.id,
    name: prettyModelName(model.id),
    family: familyOf(model.id),
    version: 'antigravity',
    tooltip,
    detail: model.kind === 'image' ? 'image' : undefined,
    maxInputTokens: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    capabilities: {
      toolCalling: model.kind === 'chat',
      imageInput: model.supportsImages,
    },
  };
}

/**
 * Cached view of the account's catalogue. The model picker asks for this list on every
 * open, so it is cached for ten minutes; the refresh command forces a reload and fires
 * `onDidChangeLanguageModelChatInformation`.
 */
export class ModelCatalogue {
  private models: CatalogueModel[] = [];
  private loadedAt = 0;
  private inflight: Promise<CatalogueModel[]> | undefined;

  constructor(
    private readonly client: CatalogueClient,
    private readonly log: (message: string) => void = () => {},
    private readonly ttlMs = 600_000,
  ) {}

  get isLoaded(): boolean {
    return this.models.length > 0;
  }

  async load({ force = false }: { force?: boolean } = {}): Promise<CatalogueModel[]> {
    if (!force && this.models.length > 0 && Date.now() - this.loadedAt < this.ttlMs) return this.models;
    if (!this.inflight) {
      this.inflight = this.fetch()
        .then((models) => {
          this.models = models;
          this.loadedAt = Date.now();
          return models;
        })
        .finally(() => { this.inflight = undefined; });
    }
    return this.inflight;
  }

  async find(id: string): Promise<CatalogueModel | undefined> {
    const models = await this.load();
    return models.find((model) => model.id === id) ?? (await this.load({ force: true })).find((model) => model.id === id);
  }

  /** Human summary for the status command. */
  async describe(): Promise<{ chat: number; image: number; ids: string[] }> {
    const models = await this.load();
    return {
      chat: models.filter((model) => model.kind === 'chat').length,
      image: models.filter((model) => model.kind === 'image').length,
      ids: models.map((model) => model.id),
    };
  }

  private async fetch(): Promise<CatalogueModel[]> {
    const { models } = await this.client.fetchModels();
    const out: CatalogueModel[] = [];
    for (const [id, raw] of Object.entries(models)) {
      if (!id || NOT_A_MODEL.test(id)) continue;
      const image = IMAGE_MODEL.test(id);
      out.push({
        id,
        kind: image ? 'image' : 'chat',
        contextWindow: Number(raw.contextWindow) > 0 ? Number(raw.contextWindow) : DEFAULT_CONTEXT_WINDOW,
        maxOutputTokens: Number(raw.maxTokens) > 0 ? Number(raw.maxTokens) : DEFAULT_MAX_OUTPUT,
        supportsImages: Boolean(raw.supportsImages) || image,
        supportsThinking: Boolean(raw.supportsThinking) && !image,
        recommended: Boolean(raw.recommended),
      });
    }
    // Recommended models first, then chat before image, then by name: the picker keeps this order.
    out.sort((a, b) => {
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      if (a.kind !== b.kind) return a.kind === 'chat' ? -1 : 1;
      return prettyModelName(a.id).localeCompare(prettyModelName(b.id));
    });
    this.log('catalogue: ' + out.length + ' models (' + out.filter((m) => m.kind === 'image').length + ' image)');
    return out;
  }
}
