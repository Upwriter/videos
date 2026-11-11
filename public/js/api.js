const PW_KEY = 'meus-videos:password';

export const getPassword = () => { try { return localStorage.getItem(PW_KEY) || ''; } catch { return ''; } };
export const setPassword = (v) => { try { localStorage.setItem(PW_KEY, v); } catch { /* ignore */ } };

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
  get retryable() {
    return !this.status || this.status >= 500 || this.status === 429 || this.status === 408;
  }
}

export async function api(path, body, { method = 'POST', signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      signal,
      headers: { 'Content-Type': 'application/json', 'x-app-password': getPassword() },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError(`Sem conexão com o servidor (${e.message})`, 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent('auth-required'));
    throw new ApiError(data.error || `Erro ${res.status}`, res.status, data);
  }
  return data;
}

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new DOMException('Cancelado', 'AbortError'));
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Cancelado', 'AbortError')); }, { once: true });
});

/** Repete fn em erros temporários (rede/5xx/429). */
export async function withRetry(fn, { retries = 3, baseDelayMs = 3000, signal, onRetry, isRetryable } = {}) {
  let last;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      last = e;
      const can = isRetryable ? isRetryable(e) : (e instanceof ApiError ? e.retryable : true);
      if (signal?.aborted || e.name === 'AbortError' || !can || attempt === retries) break;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      onRetry?.(e, attempt, delay);
      await sleep(delay, signal);
    }
  }
  throw last;
}
