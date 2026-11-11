// OpenAI Chat Completions — cada chamada é curta (um lote de cenas) para caber no tempo de uma função da Vercel.
const config = require('./config');
const { httpError } = require('./http');

async function chatJSON(messages) {
  if (!config.openaiKey) throw httpError(500, 'OPENAI_API_KEY não configurada.');
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.openaiModel, messages, response_format: { type: 'json_object' } }),
    });
  } catch (e) {
    throw httpError(502, `Falha de rede com a OpenAI: ${e.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const retryable = res.status >= 500 || res.status === 429;
    throw httpError(retryable ? 502 : 422, `OpenAI HTTP ${res.status}: ${body?.error?.message || 'erro'}`);
  }
  try {
    return JSON.parse(body.choices?.[0]?.message?.content || '{}');
  } catch {
    throw httpError(502, 'Resposta da IA não é JSON válido');
  }
}

const REF_MODE_HINT = {
  personagem: 'the MAIN CHARACTER. Describe face, hair, age, body type, clothing and distinctive features so the same person can be redrawn consistently.',
  produto: 'the PRODUCT. Describe shape, colors, materials, labels/branding layout and size so the same product can be redrawn consistently.',
  cenario: 'the SETTING/ENVIRONMENT. Describe location, architecture, objects, colors and lighting so the same place can be redrawn consistently.',
  inicial: 'the OPENING FRAME of the video. Describe subject, composition, setting and lighting.',
  geral: 'a GENERAL VISUAL REFERENCE. Describe its mood, color palette, lighting and visual style.',
};

const SCENE_RULES = (sec) => `Rules for every prompt:
- English, one single continuous shot of about ${sec} seconds, max 450 characters.
- Describe: subject + concrete action, setting, camera movement/framing, lighting/mood.
- Visualize what the narration talks about (literal or metaphorical), so scenes follow the story in order.
- Keep recurring characters/locations exactly as in the continuity bible.
- NO on-screen text, subtitles, captions, logos or speech bubbles. NO art-style words (style is added later).
- Each prompt must be different from the previous one (vary action, angle or framing).
- Scenes with media "image" become a STILL image: describe one frozen frame (composition, pose, setting, lighting) with no camera movement or action over time.`;

async function describeReference(imageDataUrl, refMode) {
  const out = await chatJSON([
    { role: 'system', content: 'You describe reference images for AI video generation. Answer JSON: {"description": "..."} in English, max 70 words, concrete visual facts only.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: `This image is ${REF_MODE_HINT[refMode] || REF_MODE_HINT.geral}` },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    },
  ]);
  return String(out.description || '').trim();
}

async function buildBible({ script, refDescription, refMode }) {
  const out = await chatJSON([
    {
      role: 'system',
      content: 'You are a film director preparing a visual continuity bible for an AI-generated video. Answer JSON: {"bible": "..."} in English, max 80 words: recurring characters (fixed appearance and clothing), main locations and color palette. No art-style words, no camera directions.',
    },
    { role: 'user', content: `Script (may be truncated):\n${String(script).slice(0, 12000)}\n\n${refDescription ? `Reference (${refMode}): ${refDescription}` : ''}` },
  ]);
  return String(out.bible || '').trim();
}

/** scenes: [{ i, narration, part, parts }] → [{ i, prompt }] (sempre um por cena) */
async function scenePrompts(scenes, ctx, previous = []) {
  const prev = previous.slice(-2).map((s) => `#${s.i}: ${s.prompt}`).join('\n');
  const res = await chatJSON([
    {
      role: 'system',
      content: `You are a video director turning a narrated script into shot prompts for an AI video model.\n${SCENE_RULES(ctx.sceneSeconds)}\nAnswer JSON: {"scenes":[{"i": <number>, "prompt": "..."}]} with exactly one item per input scene, same "i" values.`,
    },
    {
      role: 'user',
      content: [
        ctx.bible ? `Continuity bible: ${ctx.bible}` : '',
        ctx.refDescription ? `Reference ${ctx.refMode}: ${ctx.refDescription}` : '',
        `Aspect ratio: ${ctx.format}.`,
        prev ? `Previous shots (for continuity):\n${prev}` : '',
        'Scenes (parts > 1 mean the same narration is covered by several consecutive shots — make each part a new beat):',
        JSON.stringify(scenes.map(({ i, narration, part, parts, media }) => ({ i, narration, media: media === 'image' ? 'image' : 'video', ...(parts > 1 ? { part: `${part}/${parts}` } : {}) }))),
      ].filter(Boolean).join('\n\n'),
    },
  ]);
  const byI = new Map((res.scenes || []).map((s) => [Number(s.i), String(s.prompt || '').trim()]));
  // rede de segurança: nunca devolve cena sem prompt
  return scenes.map((s) => ({ i: s.i, prompt: byI.get(s.i) || `Cinematic shot illustrating: ${String(s.narration).slice(0, 300)}` }));
}

function stillsNote(ctx, from, count) {
  if (!Array.isArray(ctx.imageScenes) || !ctx.imageScenes.length) return '';
  const here = ctx.imageScenes.filter((x) => x >= from && x < from + count);
  return here.length ? `\nThese scene numbers are STILL images (media "image"): ${here.join(', ')}.` : '';
}

/** Modo "apenas imagem": cenas from..from+count-1 de um total n. */
async function imageScenes(imageDataUrl, { n, from, count }, ctx, previous = []) {
  const prev = previous.slice(-2).map((s) => `#${s.i}: ${s.prompt}`).join('\n');
  const res = await chatJSON([
    {
      role: 'system',
      content: `You create a visual storyboard for an AI video (product/influencer content) from a single reference image.\n${SCENE_RULES(ctx.sceneSeconds)}\nThe reference is ${REF_MODE_HINT[ctx.refMode] || REF_MODE_HINT.geral}\nBuild a coherent progression (hook → details/usage → lifestyle → closing). Answer JSON: {"scenes":[{"i": <number>, "beat": "<short description in Portuguese>", "prompt": "..."}]}.`,
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: `Total scenes in video: ${n}. Write scenes i=${from}..${from + count - 1}. Aspect ratio ${ctx.format}.${stillsNote(ctx, from, count)}${prev ? `\nPrevious shots:\n${prev}` : ''}` },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    },
  ]);
  const list = res.scenes || [];
  const byI = new Map(list.map((s) => [Number(s.i), s]));
  return Array.from({ length: count }, (_, k) => {
    const i = from + k;
    const s = byI.get(i) || list[k] || {};
    return {
      i,
      narration: String(s.beat || `Cena ${i}`).trim(),
      prompt: String(s.prompt || `${ctx.refDescription || 'The subject from the reference image'}, new camera angle, gentle movement.`).trim(),
    };
  });
}

module.exports = { describeReference, buildBible, scenePrompts, imageScenes };
