// POST /api/fal  { action: 'submit' | 'status' | 'result', ... }
// Proxy fino para a fila do fal.ai: a chave nunca vai para o navegador.
// kind: 't2v' | 'i2v' (vídeo MiniMax) | 't2i' (imagem FLUX 2 Flex) | 'i2i' (imagem FLUX Kontext com referência)
const config = require('./_lib/config');
const { handler, httpError } = require('./_lib/http');
const { falFetch, assertQueueUrl, QUEUE } = require('./_lib/fal');

const KINDS = ['t2v', 'i2v', 't2i', 'i2i'];
const MODEL = { t2v: () => config.falT2V, i2v: () => config.falI2V, t2i: () => config.imageT2I, i2i: () => config.imageI2I };

function imageUrl(raw) {
  const img = String(raw.image_url || '');
  if (!/^data:image\/(png|jpe?g|webp);base64,/.test(img)) throw httpError(400, 'image_url inválida');
  return img;
}

function sanitizeInput(kind, raw = {}) {
  const prompt = String(raw.prompt || '').trim().slice(0, 2000);
  if (!prompt) throw httpError(400, 'Prompt vazio');
  const vertical = raw.aspect_ratio === '9:16';

  if (kind === 't2i') {
    // 1024x576 ≈ 0,6 MP → cobrado como 1 MP (o mínimo)
    return { prompt, image_size: vertical ? 'portrait_16_9' : 'landscape_16_9', output_format: 'jpeg', enable_safety_checker: true };
  }
  if (kind === 'i2i') {
    return { prompt, image_url: imageUrl(raw), aspect_ratio: vertical ? '9:16' : '16:9', output_format: 'jpeg', num_images: 1 };
  }

  const input = {
    prompt,
    prompt_expansion_mode: config.promptExpansion,
    duration: Math.min(15, Math.max(1, Number(raw.duration) || config.sceneSeconds)),
    resolution: config.resolution, // resolução definida no servidor (controle de custo)
    enable_safety_checker: true,
  };
  if (kind === 'i2v') input.image_url = imageUrl(raw);
  else input.aspect_ratio = vertical ? '9:16' : '16:9';
  return input;
}

module.exports = handler(async (b) => {
  switch (b.action) {
    case 'submit': {
      const kind = KINDS.includes(b.kind) ? b.kind : 't2v';
      const model = MODEL[kind]();
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
        const url = r?.video?.url || r?.images?.[0]?.url || r?.image?.url;
        if (!url) throw httpError(422, 'Resposta do fal.ai sem vídeo/imagem');
        if (r?.has_nsfw_concepts?.[0]) throw httpError(422, 'Imagem bloqueada pelo filtro de conteúdo do fal.ai');
        return { url, videoUrl: url };
      } catch (e) {
        if (e.status === 422) e.jobFailed = true; // geração falhou (ex.: filtro de conteúdo)
        throw e;
      }
    }
    default:
      throw httpError(400, 'Ação desconhecida');
  }
});
