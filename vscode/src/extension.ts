// Extension entry point: wires the Antigravity transport to VS Code's chat.
import * as vscode from 'vscode';
import { createAntigravityClient } from '../../plugin/src/antigravity.mjs';
import { createThrottle } from '../../plugin/src/throttle.mjs';
import { ModelCatalogue, type CatalogueClient } from './catalogue.js';
import type { GenerationClient, ThrottleLike } from './generation.js';
import { AntigravityChatProvider, type ProviderSettings } from './provider.js';
import { renderStatus, type StatusFacts } from './status.js';

const VENDOR = 'antigravity';

interface Runtime {
  showThinking: boolean;
  throttle: ThrottleLike;
  client: ReturnType<typeof createAntigravityClient>;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Antigravity');
  context.subscriptions.push(output);

  const config = () => vscode.workspace.getConfiguration('antigravity');
  const logLevel = () => config().get<string>('logLevel', 'info');
  const log = (message: string): void => {
    if (logLevel() === 'off') return;
    output.appendLine('[' + new Date().toISOString() + '] ' + message);
  };
  const debug = (message: string): void => {
    if (logLevel() === 'debug') log(message);
  };

  const runtime: Runtime = {
    showThinking: config().get<boolean>('showThinking', false),
    throttle: createThrottle({
      maxConcurrent: config().get<number>('maxConcurrentRequests', 2),
      minIntervalMs: config().get<number>('requestSpacingMs', 250),
      log: debug,
    }),
    client: createAntigravityClient({
      upstreamHost: config().get<string>('upstreamHost', '') || undefined,
      log,
    }),
  };

  const catalogue = new ModelCatalogue(runtime.client as unknown as CatalogueClient, log);
  const settings = (): ProviderSettings => ({ showThinking: runtime.showThinking });

  const provider = new AntigravityChatProvider({
    api: {
      LanguageModelTextPart: vscode.LanguageModelTextPart,
      LanguageModelToolCallPart: vscode.LanguageModelToolCallPart,
      LanguageModelDataPart: vscode.LanguageModelDataPart,
      LanguageModelChatMessageRole: vscode.LanguageModelChatMessageRole,
      LanguageModelChatToolMode: vscode.LanguageModelChatToolMode,
    },
    client: runtime.client as unknown as GenerationClient,
    catalogue,
    settings,
    throttle: () => runtime.throttle,
    log,
  });

  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR, provider));

  context.subscriptions.push(vscode.commands.registerCommand('antigravity.refreshModels', async () => {
    try {
      const models = await catalogue.load({ force: true });
      provider.refreshModelList();
      const image = models.filter((model) => model.kind === 'image').length;
      void vscode.window.showInformationMessage(
        'Antigravity: ' + (models.length - image) + ' chat models (' + image + ' image models) for this account.',
      );
    } catch (error) {
      void vscode.window.showErrorMessage('Antigravity could not refresh the model list: ' + messageOf(error));
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('antigravity.showStatus', async () => {
    const facts = await collectStatus(runtime, catalogue, log);
    const document = await vscode.workspace.openTextDocument({
      content: renderStatus(facts),
      language: 'markdown',
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('antigravity.showLog', () => output.show(true)));

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration('antigravity')) return;
    runtime.showThinking = config().get<boolean>('showThinking', false);
    runtime.throttle = createThrottle({
      maxConcurrent: config().get<number>('maxConcurrentRequests', 2),
      minIntervalMs: config().get<number>('requestSpacingMs', 250),
      log: debug,
    });
    provider.refreshModelList();
    if (event.affectsConfiguration('antigravity.upstreamHost')) {
      log('antigravity.upstreamHost changed; reload the window to apply it');
    }
    log('settings applied');
  }));

  log('activated: model provider "' + VENDOR + '"');
}

export function deactivate(): void {
  // Everything is registered through context.subscriptions; nothing else to release.
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function collectStatus(
  runtime: Runtime,
  catalogue: ModelCatalogue,
  log: (message: string) => void,
): Promise<StatusFacts> {
  const [account, quota, models] = await Promise.all([
    runtime.client.fetchAccount().catch((error: unknown) => ({ error: messageOf(error) })),
    runtime.client.fetchQuota().catch(() => ({})),
    catalogue.describe().catch((error: unknown) => {
      log('status: catalogue unavailable: ' + messageOf(error));
      return { chat: 0, image: 0, ids: [] };
    }),
  ]);
  const state = runtime.client.tokens.state();
  const throttle = runtime.throttle as unknown as { state?: () => { maxConcurrent: number; minIntervalMs: number; cooldownUntil: string | null } };
  const shaping = throttle.state?.() ?? { maxConcurrent: 0, minIntervalMs: 0, cooldownUntil: null };
  return { account, quota, models, credential: state, throttle: shaping };
}
