// Integração com a fila (queue) do fal.ai — submit → status → result → download.
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('../config');
const { sleep, NonRetryableError } = require('./retry');

const QUEUE = 'https://queue.fal.run';

function headers() {
  if (!config.falKey) throw new NonRetryableError('FAL_KEY não configurada no arquivo .env');
  return { Authorization: `Key ${config.falKey}`, 'Content-Type': 'application/json' };
}

async function falFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail || body).slice(0, 500);
    const msg = `fal.ai HTTP ${res.status}: ${detail}`;
    // 4xx (exceto 408/429) = erro de entrada/autorização → não adianta repetir
    if (res.status >= 400 && res.status < 500 && ![408, 429].includes(res.status)) throw new NonRetryableError(msg);
    throw new Error(msg);
  }
  return body;
}

async function submit(model, input) {
  const body = await falFetch(`${QUEUE}/${model}`, { method: 'POST', body: JSON.stringify(input) });
  if (!body.request_id) throw new Error('fal.ai não retornou request_id');
  return {
    requestId: body.request_id,
    statusUrl: body.status_url || `${QUEUE}/${model}/requests/${body.request_id}/status`,
    responseUrl: body.response_url || `${QUEUE}/${model}/requests/${body.request_id}`,
  };
}

async function waitResult({ statusUrl, responseUrl }, { signal, onStatus } = {}) {
  const started = Date.now();
  while (true) {
    if (signal?.aborted) throw new Error('Cancelado');
    if (Date.now() - started > config.sceneTimeoutMs) throw new Error('Tempo limite excedido aguardando o fal.ai');
    const st = await falFetch(statusUrl);
    onStatus?.(st.status, st.queue_position);
    if (st.status === 'COMPLETED') break;
    await sleep(config.pollIntervalMs, signal);
  }
  const result = await falFetch(responseUrl);
  const url = result?.video?.url;
  if (!url) throw new Error(`Resposta sem vídeo: ${JSON.stringify(result).slice(0, 300)}`);
  return { videoUrl: url, result };
}

async function download(url, dest, { signal } = {}) {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`Falha no download (HTTP ${res.status})`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  const size = fs.statSync(tmp).size;
  if (size < 1000) throw new Error('Arquivo baixado vazio/corrompido');
  fs.renameSync(tmp, dest);
  return size;
}

function fileToDataUri(file) {
  const ext = path.extname(file).toLowerCase().replace('.', '');
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

module.exports = { submit, waitResult, download, fileToDataUri };
