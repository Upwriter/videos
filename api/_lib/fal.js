const config = require('./config');
const { httpError } = require('./http');

const QUEUE = 'https://queue.fal.run';

async function falFetch(url, opts = {}) {
  if (!config.falKey) throw httpError(500, 'FAL_KEY não configurada.');
  let res;
  try {
    res = await fetch(url, {
      ...opts,
      headers: { Authorization: `Key ${config.falKey}`, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    throw httpError(502, `Falha de rede com o fal.ai: ${e.message}`);
  }
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail || body).slice(0, 500);
    // 4xx do fal = erro de entrada/job (repassa como 4xx/422 para o cliente não insistir); 5xx/429 = temporário
    const retryable = res.status >= 500 || [408, 429].includes(res.status);
    throw httpError(retryable ? 502 : 422, `fal.ai HTTP ${res.status}: ${detail}`, { falStatus: res.status });
  }
  return body;
}

/** Só aceita URLs da fila do fal.ai (evita o proxy ser usado para outros destinos). */
function assertQueueUrl(u) {
  let url;
  try { url = new URL(u); } catch { throw httpError(400, 'URL inválida'); }
  if (url.origin !== QUEUE) throw httpError(400, 'URL não pertence ao fal.ai');
  return url.toString();
}

module.exports = { falFetch, assertQueueUrl, QUEUE };
