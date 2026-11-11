// POST /api/fal  { action: 'submit' | 'status' | 'result', ... }
// Proxy fino para a fila do fal.ai: a chave nunca vai para o navegador.
const config = require('./_lib/config');
const { handler, httpError } = require('./_lib/http');
const { falFetch, assertQueueUrl, QUEUE } = require('./_lib/fal');

function sanitizeInput(kind, raw = {}) {
  const prompt = String(raw.prompt || '').trim().slice(0, 2000);
  if (!prompt) throw httpError(400, 'Prompt vazio');
  const input = {
    prompt,
    prompt_expansion_mode: config.promptExpansion,
    duration: Math.min(15, Math.max(1, Number(raw.duration) || config.sceneSeconds)),
    resolution: config.resolution, // resolução definida no servidor (controle de custo)
    enable_safety_checker: true,
  };
  if (kind === 'i2v') {
    const img = String(raw.image_url || '');
    if (!/^data:image\/(png|jpe?g|webp);base64,/.test(img)) throw httpError(400, 'image_url inválida');
    input.image_url = img;
  } else {
    input.aspect_ratio = ['16:9', '9:16'].includes(raw.aspect_ratio) ? raw.aspect_ratio : '16:9';
  }
  return input;
}

module.exports = handler(async (b) => {
  switch (b.action) {
    case 'submit': {
      const kind = b.kind === 'i2v' ? 'i2v' : 't2v';
      const model = kind === 'i2v' ? config.falI2V : config.falT2V;
      const r = await falFetch(`${QUEUE}/${model}`, { method: 'POST', body: JSON.stringify(sanitizeInput(kind, b.input)) });
      if (!r.request_id) throw httpError(502, 'fal.ai não retornou request_id');
      return { requestId: r.request_id, statusUrl: r.status_url, responseUrl: r.response_url, model };
    }
    case 'status': {
      try {
        const st = await falFetch(assertQueueUrl(b.statusUrl));
        return { status: st.status, queuePosition: st.queue_position ?? null };
      } catch (e) {
        if (e.status === 422) e.jobFailed = true; // job não encontrado/inválido → cliente reenvia
        throw e;
      }
    }
    case 'result': {
      try {
        const r = await falFetch(assertQueueUrl(b.responseUrl));
        const videoUrl = r?.video?.url;
        if (!videoUrl) throw httpError(422, 'Resposta do fal.ai sem vídeo');
        return { videoUrl };
      } catch (e) {
        if (e.status === 422) e.jobFailed = true; // geração falhou (ex.: filtro de conteúdo)
        throw e;
      }
    }
    default:
      throw httpError(400, 'Ação desconhecida');
  }
});
