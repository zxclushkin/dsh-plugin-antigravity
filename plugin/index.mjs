// language: JavaScript (ESM), file: index.mjs, runtime: DSH host (Node >= 20)
// DSH plugin: a native LLM adapter for Google Antigravity models.
//
// No local HTTP gateway and no `llm-pi-ai` route: the plugin registers itself with the
// harness LLM service and streams harness chunks directly, so the model picker, retry
// policy, usage accounting and cancellation are the harness's own.
//
// Zero imports from the installation on purpose: the plugin is mounted by absolute
// path, which does not resolve `@deepseek-ai/*` package specifiers.
import fs from 'node:fs';
import path from 'node:path';
import { createAntigravityClient, createTokenSource } from './src/antigravity.mjs';
import { AntigravityAdapter } from './src/adapter.mjs';
import { createImageGenerator, DEFAULT_ASPECT_RATIOS } from './src/imagegen.mjs';
import { createStatusService, registerStatusRoutes } from './src/status.mjs';
import { registerImageTool } from './src/tool.mjs';

export const name = 'antigravity-llm';

/** The harness LLM and tool registries must exist before this plugin can register. */
export const inject = ['llm', 'tools'];

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isBool = (value) => typeof value === 'boolean';
const isStr = (value) => typeof value === 'string' && value.length > 0;
const isPositiveInt = (value) => Number.isInteger(value) && value > 0;
const isNonNegativeInt = (value) => Number.isInteger(value) && value >= 0;

const TOP_LEVEL_KEYS = new Set([
  'enabled', 'credentialTarget', 'languageServerPath', 'clientId', 'clientSecret',
  'upstreamHost', 'userAgent', 'requestTimeoutMs', 'modelCacheTtlMs', 'debugDir', 'features',
]);
const FEATURE_KEYS = new Set([
  'googleSearch', 'includeThoughts',
  'defaultThinkingLevel', 'thinkingBudgets', 'responseMimeType', 'responseSchema',
  'imageOutput', 'imageAspectRatio', 'imageMaxBytes', 'mediaOutputDir', 'safetySettings',
  'maxOutputTokensCap',
  // built-in image generation tool
  'imageGen', 'imageModel', 'imageAspectRatios', 'imageMaxOutputTokens',
]);
const FEATURE_BOOLS = ['googleSearch', 'includeThoughts', 'imageOutput', 'imageGen'];
const THINKING_LEVELS = ['low', 'medium', 'high'];
const IMAGE_RATIOS = DEFAULT_ASPECT_RATIOS;

function validateFeatures(raw, issues) {
  const out = {};
  if (raw === undefined || raw === null) return out;
  if (!isObject(raw)) {
    issues.push({ message: 'features must be an object', path: ['features'] });
    return out;
  }
  for (const key of Object.keys(raw)) {
    if (!FEATURE_KEYS.has(key)) issues.push({ message: 'unknown feature', path: ['features', key] });
  }
  for (const key of FEATURE_BOOLS) {
    if (raw[key] !== undefined && !isBool(raw[key])) {
      issues.push({ message: 'features.' + key + ' must be a boolean', path: ['features', key] });
    } else if (raw[key] !== undefined) {
      out[key] = raw[key];
    }
  }
  if (raw.defaultThinkingLevel !== undefined) {
    if (!THINKING_LEVELS.includes(raw.defaultThinkingLevel)) {
      issues.push({ message: 'features.defaultThinkingLevel must be low, medium or high', path: ['features', 'defaultThinkingLevel'] });
    } else {
      out.defaultThinkingLevel = raw.defaultThinkingLevel;
    }
  }
  if (raw.thinkingBudgets !== undefined) {
    if (!isObject(raw.thinkingBudgets)) {
      issues.push({ message: 'features.thinkingBudgets must be an object', path: ['features', 'thinkingBudgets'] });
    } else {
      out.thinkingBudgets = {};
      for (const [level, value] of Object.entries(raw.thinkingBudgets)) {
        if (!THINKING_LEVELS.includes(level) || !isPositiveInt(value)) {
          issues.push({ message: 'features.thinkingBudgets.' + level + ' must be a positive integer', path: ['features', 'thinkingBudgets', level] });
        } else {
          out.thinkingBudgets[level] = value;
        }
      }
    }
  }
  for (const key of ['responseMimeType', 'imageAspectRatio', 'mediaOutputDir', 'imageModel']) {
    if (raw[key] !== undefined) {
      if (!isStr(raw[key])) issues.push({ message: 'features.' + key + ' must be a non-empty string', path: ['features', key] });
      else out[key] = raw[key];
    }
  }
  for (const key of ['imageMaxBytes', 'maxOutputTokensCap', 'imageMaxOutputTokens']) {
    if (raw[key] !== undefined) {
      if (!isNonNegativeInt(raw[key])) issues.push({ message: 'features.' + key + ' must be a non-negative integer', path: ['features', key] });
      else out[key] = raw[key];
    }
  }
  if (raw.imageAspectRatios !== undefined) {
    if (!Array.isArray(raw.imageAspectRatios) || raw.imageAspectRatios.length === 0 ||
        raw.imageAspectRatios.some((ratio) => !isStr(ratio))) {
      issues.push({ message: 'features.imageAspectRatios must be a non-empty array of strings', path: ['features', 'imageAspectRatios'] });
    } else {
      out.imageAspectRatios = [...raw.imageAspectRatios];
    }
  }
  if (out.imageAspectRatio !== undefined && !IMAGE_RATIOS.includes(out.imageAspectRatio) &&
      !(out.imageAspectRatios || []).includes(out.imageAspectRatio)) {
    issues.push({ message: 'features.imageAspectRatio must be one of ' + IMAGE_RATIOS.join(', '), path: ['features', 'imageAspectRatio'] });
  }
  if (raw.responseSchema !== undefined) {
    if (!isObject(raw.responseSchema)) issues.push({ message: 'features.responseSchema must be an object', path: ['features', 'responseSchema'] });
    else out.responseSchema = raw.responseSchema;
  }
  if (raw.safetySettings !== undefined) {
    if (!Array.isArray(raw.safetySettings)) issues.push({ message: 'features.safetySettings must be an array', path: ['features', 'safetySettings'] });
    else out.safetySettings = raw.safetySettings;
  }
  return out;
}

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'antigravity',
    validate(value) {
      const raw = value ?? {};
      if (!isObject(raw)) return { issues: [{ message: 'config must be an object', path: [] }] };
      const issues = [];
      for (const key of Object.keys(raw)) {
        if (!TOP_LEVEL_KEYS.has(key)) issues.push({ message: 'unknown key', path: [key] });
      }
      const asString = ['credentialTarget', 'languageServerPath', 'clientId', 'clientSecret', 'upstreamHost', 'userAgent', 'debugDir'];
      for (const key of asString) {
        if (raw[key] !== undefined && !isStr(raw[key])) {
          issues.push({ message: key + ' must be a non-empty string', path: [key] });
        }
      }
      for (const key of ['requestTimeoutMs', 'modelCacheTtlMs']) {
        if (raw[key] !== undefined && !isPositiveInt(raw[key])) {
          issues.push({ message: key + ' must be a positive integer', path: [key] });
        }
      }
      if (raw.enabled !== undefined && !isBool(raw.enabled)) {
        issues.push({ message: 'enabled must be a boolean', path: ['enabled'] });
      }
      const features = validateFeatures(raw.features, issues);
      if (issues.length > 0) return { issues };
      return {
        value: {
          enabled: raw.enabled ?? true,
          credentialTarget: raw.credentialTarget ?? 'gemini:antigravity',
          languageServerPath: raw.languageServerPath,
          clientId: raw.clientId,
          clientSecret: raw.clientSecret,
          upstreamHost: raw.upstreamHost ?? 'https://daily-cloudcode-pa.googleapis.com',
          userAgent: raw.userAgent ?? 'antigravity/2.29.0',
          requestTimeoutMs: raw.requestTimeoutMs ?? 300_000,
          modelCacheTtlMs: raw.modelCacheTtlMs ?? 600_000,
          debugDir: raw.debugDir,
          features,
        },
      };
    },
  },
};

export async function apply(ctx, config) {
  if (!config.enabled) {
    ctx.logger.info('antigravity: disabled by config');
    return;
  }
  const fileLog = createFileLogger(config.debugDir);
  const log = (message) => {
    ctx.logger.info('antigravity: ' + message);
    fileLog(message);
  };
  const tokens = createTokenSource({ ...config, log });
  const client = createAntigravityClient({ ...config, tokens, log });
  const adapter = new AntigravityAdapter({
    client,
    config,
    log,
    // The attachment service may mount after this plugin; resolve it lazily.
    getAttachments: () => ctx.get('attachments'),
  });

  const registration = ctx.llm.registerAdapter(['antigravity'], adapter);
  log('model provider registered (' + client.host + ')');

  // Built-in image generation as an agent tool: any model can draw, like the Antigravity IDE.
  const generator = createImageGenerator({ client, adapter, config, log });
  let unregisterTool;
  if (config.features.imageGen !== false) {
    unregisterTool = registerImageTool(ctx, { generator, config, log });
    log('image_generate tool registered');
  }

  // Settings GUI: a JSON API on the harness web server (the Client half reads it).
  const statusService = createStatusService({ client, adapter, config, log });
  ctx.inject(['webServer'], (child) => {
    child.effect(() => registerStatusRoutes(child, { service: statusService, generator, config, log }),
      'antigravity: settings routes');
    log('settings API registered on /antigravity/*');
  });

  // Warm the catalogue in the background so the first model-picker open is instant.
  adapter.loadCatalogue()
    .then((catalogue) => log('catalogue ready: ' + Object.keys(catalogue.models).length +
      ' chat models, ' + Object.keys(catalogue.imageModels).length + ' image models'))
    .catch((error) => {
      ctx.logger.warn('antigravity: model catalogue is not available yet: ' +
        (error && error.message ? error.message : error));
      fileLog('catalogue failed: ' + (error && error.message ? error.message : error));
    });

  return () => {
    try { registration?.(); } catch { /* already disposed */ }
    try { unregisterTool?.(); } catch { /* already disposed */ }
    log('model provider unregistered');
  };
}

/** Optional JSONL-ish line log so the mounted adapter can be verified from disk. */
function createFileLogger(debugDir) {
  if (!debugDir) return () => {};
  let file;
  try {
    fs.mkdirSync(debugDir, { recursive: true });
    file = path.join(debugDir, 'antigravity-adapter.log');
  } catch {
    return () => {};
  }
  return (message) => {
    try {
      fs.appendFileSync(file, new Date().toISOString() + ' ' + message + '\n');
    } catch { /* diagnostics must never break the plugin */ }
  };
}
