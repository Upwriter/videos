class NonRetryableError extends Error {}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelado'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('Cancelado'));
    }, { once: true });
  });

async function withRetry(fn, { retries = 3, baseDelayMs = 3000, signal, onRetry } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (err instanceof NonRetryableError || signal?.aborted || attempt === retries) break;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      onRetry?.(err, attempt, delay);
      await sleep(delay, signal);
    }
  }
  throw lastErr;
}

module.exports = { withRetry, sleep, NonRetryableError };
