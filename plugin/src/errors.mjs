// language: JavaScript (ESM), file: src/errors.mjs, runtime: Node >= 20 (DSH host)
// Errors that the DSH `llm` service can classify without importing its classes.
//
// `normalizeLlmFailure` in @deepseek-ai/dsh-llm trusts an error's own `failure`
// snapshot when its `code` agrees with the error's own `code`:
//   "Cross-package copies preserve own data but not class identity. Trust the
//    carried facts only when both own properties agree after validation."
// That is the documented seam for an adapter shipped outside the harness package,
// so this plugin needs zero imports from the installation.

/** Codes the harness already understands; consumers route on these, never on message text. */
export const ERROR_CODES = {
  AUTH: 'AUTH',
  MISSING_CREDENTIAL: 'MISSING_CREDENTIAL',
  INVALID_CREDENTIAL: 'INVALID_CREDENTIAL',
  RATE_LIMIT: 'RATE_LIMIT',
  QUOTA: 'QUOTA',
  TIMEOUT: 'TIMEOUT',
  TRANSPORT: 'TRANSPORT',
  SERVER: 'SERVER',
  INVALID_REQUEST: 'INVALID_REQUEST',
  CONTEXT_WINDOW_EXCEEDED: 'CONTEXT_WINDOW_EXCEEDED',
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  UNSUPPORTED_CONTENT: 'UNSUPPORTED_CONTENT',
  UNKNOWN_MODEL: 'UNKNOWN_MODEL',
  ABORTED: 'ABORTED',
};

/**
 * One adapter failure. Carries `code` twice on purpose: as an own property on the
 * error and inside its own `failure` snapshot, which is exactly what the harness
 * checks when the error crosses a package boundary.
 */
export class AntigravityError extends Error {
  constructor(message, code, facts = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.failure = Object.freeze({
      message: String(message || 'Antigravity adapter failed'),
      code,
      ...(facts.status === undefined ? {} : { status: facts.status }),
      ...(facts.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: facts.providerRetryAfterMs }),
      ...(facts.requestId === undefined ? {} : { requestId: facts.requestId }),
    });
  }
}

/** Build an aborted failure that the harness turns into `{ kind: 'aborted' }`. */
export function abortedError(reason = 'request aborted') {
  return new AntigravityError(reason, ERROR_CODES.ABORTED);
}

/** Retry-After style delay from an Antigravity error body or headers, in ms. */
function retryAfterMs(bodyText, headers) {
  const fromHeader = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  if (fromHeader) {
    const seconds = Number(fromHeader);
    if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  }
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(String(bodyText || ''));
  if (match) return Math.round(Number(match[1]) * 1000);
  return undefined;
}

/**
 * Classify an upstream HTTP failure into harness codes.
 * @param {number} status HTTP status from the Antigravity endpoint.
 * @param {string} bodyText raw error body (v1internal returns JSON).
 * @param {Headers} [headers] response headers, used for Retry-After.
 */
export function httpError(status, bodyText, headers) {
  const detail = String(bodyText || '');
  const short = detail.replace(/\s+/g, ' ').slice(0, 600);
  const facts = { status, providerRetryAfterMs: retryAfterMs(detail, headers) };
  const message = 'Antigravity request failed: HTTP ' + status + ' ' + short;
  if (status === 401) return new AntigravityError('Antigravity access token was rejected; sign in to Antigravity again (' + short + ')', ERROR_CODES.AUTH, facts);
  if (status === 403) return new AntigravityError(message, ERROR_CODES.AUTH, facts);
  if (status === 429) {
    const code = /QUOTA_EXHAUSTED|quota/i.test(detail) ? ERROR_CODES.QUOTA : ERROR_CODES.RATE_LIMIT;
    return new AntigravityError(message, code, facts);
  }
  if (status === 408 || status === 504) return new AntigravityError(message, ERROR_CODES.TIMEOUT, facts);
  if (status === 413) return new AntigravityError(message, ERROR_CODES.CONTEXT_WINDOW_EXCEEDED, facts);
  if (status === 400 || status === 422) {
    if (/context|token count|too long|exceeds/i.test(detail)) {
      return new AntigravityError(message, ERROR_CODES.CONTEXT_WINDOW_EXCEEDED, facts);
    }
    if (/thought_signature|thoughtSignature/i.test(detail)) {
      return new AntigravityError(message, ERROR_CODES.INVALID_REQUEST, facts);
    }
    return new AntigravityError(message, ERROR_CODES.INVALID_REQUEST, facts);
  }
  if (status >= 500) return new AntigravityError(message, ERROR_CODES.SERVER, facts);
  return new AntigravityError(message, ERROR_CODES.INVALID_REQUEST, facts);
}

/** Wrap a fetch/transport rejection (DNS, TLS, socket, abort) as a harness failure. */
export function transportError(error, signal) {
  if (signal && signal.aborted) return abortedError('Antigravity request aborted');
  const message = error && error.message ? error.message : String(error);
  if (/abort/i.test(message)) return abortedError(message);
  if (/timeout|timed out/i.test(message)) return new AntigravityError('Antigravity request timed out: ' + message, ERROR_CODES.TIMEOUT);
  return new AntigravityError('Antigravity transport failure: ' + message, ERROR_CODES.TRANSPORT);
}
