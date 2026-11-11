// API de texto (OpenAI Chat Completions) — descreve a referência, cria a "bíblia visual"
// e escreve o prompt visual de cada cena. Quantidade/ordem das cenas vem do splitter.
const config = require('../config');
const { withRetry, NonRetryableError } = require('./retry');

const BATCH = 15;

async function chatJSON(messages, { signal } = {}) {
  if (!config.openaiKey) throw new NonRetryableError('OPENAI_API_KEY não configurada no arquivo .env');
  return withRetry(async () => {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${config.openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.openaiModel, messages, response_format: { type: 'json_object' } }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = `OpenAI HTTP ${res.status}: ${body?.error?.message || 'erro'}`;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new NonRetryableError(msg);
      throw new Error(msg);
    }
    const content = body.choices?.[0]?.message?.content || '{}';
    try { return JSON.parse(content); } catch { throw new Error('Resposta da IA não é JSON válido'); }
  }, { retries: config.maxRetries, signal });
}

const REF_MODE_HINT = {
  personagem: 'the MAIN CHARACTER. Describe face, hair, age, body type, clothing and distinctive features so the same person can be redrawn consistently.',
  produto: 'the PRODUCT. Describe shape, colors, materials, labels/branding layout and size so the same product can be redrawn consistently.',
  cenario: 'the SETTING/ENVIRONMENT. Describe location, architecture, objects, colors and lighting so the same place can be redrawn consistently.',
  inicial: 'the OPENING FRAME of the video. Describe subject, composition, setting and lighting.',
  geral: 'a GENERAL VISUAL REFERENCE. Describe its mood, color palette, lighting and visual style.',
};

async function describeReference(dataUrl, refMode, opts) {
  const out = await chatJSON([
    { role: 'system', content: 'You describe reference images for AI video generation. Answer JSON: {"description": "..."} in English, max 70 words, concrete visual facts only.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: `This image is ${REF_MODE_HINT[refMode] || REF_MODE_HINT.geral}` },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  ], opts);
  return String(out.description || '').trim();
}

async function buildBible({ script, refDescription, refMode }, opts) {
  const out = await chatJSON([
    {
      role: 'system',
      content: 'You are a film director preparing a visual continuity bible for an AI-generated video. Answer JSON: {"bible": "..."} in English, max 80 words: recurring characters (fixed appearance and clothing), main locations and color palette. No art-style words, no camera directions.',
    },
    {
      role: 'user',
      content: `Script (may be truncated):\n${script.slice(0, 12000)}\n\n${refDescription ? `Reference (${refMode}): ${refDescription}` : ''}`,
    },
  ], opts);
  return String(out.bible || '').trim();
}

const SCENE_RULES = `Rules for every prompt:
- English, one single continuous shot of about {SEC} seconds, max 450 characters.
- Describe: subject + concrete action, setting, camera movement/framing, lighting/mood.
- Visualize what the narration talks about (literal or metaphorical), so scenes follow the story in order.
- Keep recurring characters/locations exactly as in the continuity bible.
- NO on-screen text, subtitles, captions, logos or speech bubbles. NO art-style words (style is added later).
- Each prompt must be different from the previous one (vary action, angle or framing).`;

/** scenes: [{ i, narration, part, parts }] → mesmo array com .prompt preenchido */
async function writeScenePrompts(scenes, ctx, opts = {}) {
  const out = [];
  for (let b = 0; b < scenes.length; b += BATCH) {
    const batch = scenes.slice(b, b + BATCH);
    const prev = out.slice(-2).map((s) => `#${s.i}: ${s.prompt}`).join('\n');
    const res = await chatJSON([
      {
        role: 'system',
        content: `You are a video director turning a narrated script into shot prompts for an AI video model.\n${SCENE_RULES.replace('{SEC}', ctx.sceneSeconds)}\nAnswer JSON: {"scenes":[{"i": <number>, "prompt": "..."}]} with exactly one item per input scene, same "i" values.`,
      },
      {
        role: 'user',
        content: [
          ctx.bible ? `Continuity bible: ${ctx.bible}` : '',
          ctx.refDescription ? `Reference ${ctx.refMode}: ${ctx.refDescription}` : '',
          `Aspect ratio: ${ctx.format}.`,
          prev ? `Previous shots (for continuity):\n${prev}` : '',
          'Scenes (parts > 1 mean the same narration is covered by several consecutive shots — make each part a new beat):',
          JSON.stringify(batch.map(({ i, narration, part, parts }) => ({ i, narration, ...(parts > 1 ? { part: `${part}/${parts}` } : {}) }))),
        ].filter(Boolean).join('\n\n'),
      },
    ], opts);
    const byI = new Map((res.scenes || []).map((s) => [Number(s.i), String(s.prompt || '').trim()]));
    for (const s of batch) {
      // rede de segurança determinística: nunca deixar cena sem prompt
      const prompt = byI.get(s.i) || `Cinematic shot illustrating: ${s.narration.slice(0, 300)}`;
      out.push({ ...s, prompt });
    }
    opts.onProgress?.(Math.min(scenes.length, b + BATCH), scenes.length);
  }
  return out;
}

/** Modo 2 — apenas imagem: IA cria o roteiro visual (n cenas) a partir da foto. */
async function imageOnlyScenes(dataUrl, n, ctx, opts = {}) {
  const out = [];
  for (let b = 0; b < n; b += BATCH) {
    const count = Math.min(BATCH, n - b);
    const prev = out.slice(-2).map((s) => `#${s.i}: ${s.prompt}`).join('\n');
    const res = await chatJSON([
      {
        role: 'system',
        content: `You create a visual storyboard for an AI video (product/influencer content) from a single reference image.\n${SCENE_RULES.replace('{SEC}', ctx.sceneSeconds)}\nThe reference is ${REF_MODE_HINT[ctx.refMode] || REF_MODE_HINT.geral}\nBuild a coherent progression (hook → details/usage → lifestyle → closing). Answer JSON: {"scenes":[{"i": <number>, "beat": "<short description in Portuguese>", "prompt": "..."}]}.`,
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Total scenes in video: ${n}. Write scenes i=${b + 1}..${b + count}. Aspect ratio ${ctx.format}.${prev ? `\nPrevious shots:\n${prev}` : ''}` },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ], opts);
    const byI = new Map((res.scenes || []).map((s) => [Number(s.i), s]));
    for (let k = 0; k < count; k++) {
      const i = b + k + 1;
      const s = byI.get(i) || (res.scenes || [])[k] || {};
      out.push({
        i,
        narration: String(s.beat || `Cena ${i}`).trim(),
        prompt: String(s.prompt || `${ctx.refDescription || 'The subject from the reference image'}, new camera angle, gentle movement.`).trim(),
      });
    }
    opts.onProgress?.(out.length, n);
  }
  return out;
}

module.exports = { describeReference, buildBible, writeScenePrompts, imageOnlyScenes };
