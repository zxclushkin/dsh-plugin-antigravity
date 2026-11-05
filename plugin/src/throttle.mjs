// language: JavaScript (ESM), file: src/throttle.mjs, runtime: Node >= 20 (DSH host)
// Gentle request guard shared by the adapter and the tool sub-calls.
//
// Why: the adapter talks to the operator's personal Antigravity plan. A local agent loop can
// easily produce bursts no human IDE session would; keeping concurrency low, spacing requests
// and pausing after a 429 keeps the traffic shaped like normal IDE use.
export function createThrottle(options = {}) {
  const log = options.log || (() => {});
  const maxConcurrent = Number.isInteger(options.maxConcurrent) && options.maxConcurrent > 0 ? options.maxConcurrent : 2;
  const minIntervalMs = Number.isFinite(options.minIntervalMs) && options.minIntervalMs > 0 ? options.minIntervalMs : 0;
  const cooldownMs = Number.isFinite(options.cooldownMs) && options.cooldownMs > 0 ? options.cooldownMs : 60_000;
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))));

  let active = 0;
  let lastStart = 0;
  let cooldownUntil = 0;
  const waiting = [];

  function wake() {
    while (waiting.length > 0 && active < maxConcurrent) {
      const resolve = waiting.shift();
      resolve();
    }
  }

  async function acquire(signal) {
    for (;;) {
      if (signal && signal.aborted) {
        const error = new Error('request aborted while waiting for a slot');
        error.code = 'ABORTED';
        throw error;
      }
      const cooldownLeft = cooldownUntil - now();
      if (cooldownLeft > 0) {
        await sleep(Math.min(cooldownLeft, 5_000));
        continue;
      }
      const gap = minIntervalMs - (now() - lastStart);
      if (gap > 0) {
        await sleep(gap);
        continue;
      }
      if (active < maxConcurrent) {
        active += 1;
        lastStart = now();
        let released = false;
        return () => {
          if (released) return;
          released = true;
          active = Math.max(0, active - 1);
          wake();
        };
      }
      await new Promise((resolve) => { waiting.push(resolve); });
    }
  }

  return {
    maxConcurrent,
    minIntervalMs,
    cooldownMs,
    /** Run one network operation under the shared limits. */
    async run(operation, signal) {
      const release = await acquire(signal);
      try {
        return await operation();
      } finally {
        release();
      }
    },
    /** A 429/QUOTA response pauses every request for the reported (capped) delay. */
    noteRateLimit(retryAfterMs) {
      const delay = Math.min(Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : cooldownMs, cooldownMs);
      const until = now() + delay;
      if (until > cooldownUntil) {
        cooldownUntil = until;
        log('rate limit: pausing requests for ' + Math.round(delay / 1000) + 's');
      }
    },
    state() {
      return {
        maxConcurrent,
        minIntervalMs,
        cooldownMs,
        active,
        queued: waiting.length,
        cooldownUntil: cooldownUntil > now() ? new Date(cooldownUntil).toISOString() : null,
      };
    },
  };
}
