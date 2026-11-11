// POST /api/ai  { action: 'describe' | 'bible' | 'scene-prompts' | 'image-scenes', ... }
const { handler, httpError } = require('./_lib/http');
const llm = require('./_lib/llm');

const MAX_BATCH = 10;
const isImage = (u) => typeof u === 'string' && /^data:image\/(png|jpe?g|webp);base64,/.test(u);

module.exports = handler(async (b) => {
  const ctx = b.ctx || {};
  switch (b.action) {
    case 'describe':
      if (!isImage(b.imageDataUrl)) throw httpError(400, 'Imagem inválida');
      return { description: await llm.describeReference(b.imageDataUrl, b.refMode) };
    case 'bible':
      return { bible: await llm.buildBible({ script: b.script || '', refDescription: b.refDescription, refMode: b.refMode }) };
    case 'scene-prompts': {
      const scenes = Array.isArray(b.scenes) ? b.scenes.slice(0, MAX_BATCH) : [];
      if (!scenes.length) throw httpError(400, 'Nenhuma cena enviada');
      return { scenes: await llm.scenePrompts(scenes, ctx, b.previous || []) };
    }
    case 'image-scenes': {
      if (!isImage(b.imageDataUrl)) throw httpError(400, 'Imagem inválida');
      const count = Math.min(MAX_BATCH, Math.max(1, Number(b.count) || 1));
      return { scenes: await llm.imageScenes(b.imageDataUrl, { n: Number(b.n), from: Number(b.from), count }, ctx, b.previous || []) };
    }
    default:
      throw httpError(400, 'Ação desconhecida');
  }
});
