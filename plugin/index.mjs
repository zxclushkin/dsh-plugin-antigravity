// language: JavaScript (ESM), file: index.mjs, runtime: DSH host (Node >= 20)
// DSH plugin: mounts a localhost OpenAI-compatible gateway in front of Google Antigravity's
// "Cloud Code" private API. The harness reaches it through a normal dsh-llm-pi-ai route
// (api: openai-completions).
//
// No key is asked for: the gateway reuses the credentials of the installed Antigravity app
// (Windows Credential Manager target `gemini:antigravity`) and mints access tokens itself.
import { createAntigravityProxy, DEFAULT_PROXY_PORT } from './src/server.mjs';

export const name = 'antigravity-gateway';

/** No required services: the plugin owns only its own HTTP listener. */
export const inject = [];

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isBool = (value) => typeof value === 'boolean';
const isStr = (value) => typeof value === 'string' && value.length > 0;
const isPositiveInt = (value) => Number.isInteger(value) && value > 0;
const isNonNegativeInt = (value) => Number.isInteger(value) && value >= 0;

const STRING_KEYS = ['host', 'upstreamHost', 'userAgent', 'project', 'debugDir', 'credentialTarget',
  'languageServerPath', 'clientId', 'clientSecret'];
const POSITIVE_INT_KEYS = ['port', 'requestTimeoutMs', 'streamIdleTimeoutMs', 'modelCacheTtlMs'];

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'antigravity',
    validate(value) {
      const raw = value ?? {};
      if (!isObject(raw)) {
        return { issues: [{ message: 'config must be an object', path: [] }] };
      }
      const known = new Set(['enabled', 'maxOutputTokensCap', ...STRING_KEYS, ...POSITIVE_INT_KEYS]);
      const issues = [];
      for (const key of Object.keys(raw)) {
        if (!known.has(key)) issues.push({ message: 'unknown key', path: [key] });
      }
      if (raw.enabled !== undefined && !isBool(raw.enabled)) {
        issues.push({ message: 'enabled must be a boolean', path: ['enabled'] });
      }
      if (raw.maxOutputTokensCap !== undefined && !isNonNegativeInt(raw.maxOutputTokensCap)) {
        issues.push({ message: 'maxOutputTokensCap must be a non-negative integer', path: ['maxOutputTokensCap'] });
      }
      for (const key of STRING_KEYS) {
        if (raw[key] !== undefined && !isStr(raw[key])) {
          issues.push({ message: key + ' must be a non-empty string', path: [key] });
        }
      }
      for (const key of POSITIVE_INT_KEYS) {
        if (raw[key] !== undefined && !isPositiveInt(raw[key])) {
          issues.push({ message: key + ' must be a positive integer', path: [key] });
        }
      }
      if (isStr(raw.debugDir) && raw.debugDir.length === 0) {
        issues.push({ message: 'debugDir must be a non-empty string', path: ['debugDir'] });
      }
      if (issues.length > 0) return { issues };
      return {
        value: {
          enabled: raw.enabled ?? true,
          host: raw.host ?? '127.0.0.1',
          port: raw.port ?? DEFAULT_PROXY_PORT,
          upstreamHost: raw.upstreamHost ?? 'https://daily-cloudcode-pa.googleapis.com',
          userAgent: raw.userAgent ?? 'antigravity/2.29.0',
          project: raw.project,
          requestTimeoutMs: raw.requestTimeoutMs ?? 300000,
          streamIdleTimeoutMs: raw.streamIdleTimeoutMs ?? 300000,
          debugDir: raw.debugDir ?? process.env.ANTIGRAVITY_DEBUG_DIR,
          modelCacheTtlMs: raw.modelCacheTtlMs ?? 600000,
          credentialTarget: raw.credentialTarget ?? 'gemini:antigravity',
          languageServerPath: raw.languageServerPath,
          clientId: raw.clientId,
          clientSecret: raw.clientSecret,
          maxOutputTokensCap: raw.maxOutputTokensCap ?? 0,
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
  const log = (message) => ctx.logger.info('antigravity: ' + message);
  const proxy = createAntigravityProxy({ ...config, log });
  let address;
  try {
    address = await proxy.listen(config.port, config.host);
  } catch (error) {
    // A busy port is a non-fatal startup outcome for an optional entry: warn, keep the app alive.
    ctx.logger.error('antigravity: could not listen on ' + config.host + ':' + config.port +
      ' - ' + (error && error.message ? error.message : error));
    return;
  }
  ctx.logger.info('antigravity: gateway listening on http://' + address.host + ':' + address.port +
    '/v1 (upstream ' + config.upstreamHost + ')');
  return async () => {
    ctx.logger.info('antigravity: closing gateway on port ' + address.port);
    await proxy.close();
  };
}
