// Monta o projeto: divide o roteiro, escreve os prompts e calcula o orçamento. Nada é gerado no fal.ai aqui.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const store = require('./services/state');
const { planNarration, countWords } = require('./services/splitter');
const llm = require('./services/llm');
const media = require('./services/media');
const { styleModifier } = require('./services/styles');
const { fileToDataUri } = require('./services/fal');

const REF_LABEL = { personagem: 'main character', produto: 'product', cenario: 'setting' };
const MAX_PROMPT = 1900;

function composePrompt(prompt, s) {
  const parts = [prompt.trim()];
  if (s.reference?.description && REF_LABEL[s.settings.refMode]) {
    parts.push(`Consistent ${REF_LABEL[s.settings.refMode]}: ${s.reference.description}`);
  }
  const mod = styleModifier(s.settings.style, s.settings.format, s.settings.customStyle);
  if (mod) parts.push(`Style: ${mod}`);
  let out = parts.join(' ');
  if (out.length > MAX_PROMPT) {
    // corta o prompt da cena, nunca o estilo
    const tail = parts.slice(1).join(' ');
    out = `${prompt.slice(0, Math.max(200, MAX_PROMPT - tail.length - 2))} ${tail}`;
  }
  return out;
}

function budget(s) {
  const costPerScene = +(s.settings.sceneSeconds * s.settings.costPerSecond).toFixed(4);
  const pending = s.scenes.filter((x) => x.status !== 'done').length;
  return {
    scenes: s.scenes.length,
    seconds: s.scenes.length * s.settings.sceneSeconds,
    costPerSecond: s.settings.costPerSecond,
    costPerScene,
    total: +(s.scenes.length * costPerScene).toFixed(2),
    pendingScenes: pending,
    pendingCost: +(pending * costPerScene).toFixed(2),
  };
}

function fileName(i, total) {
  return `${String(i).padStart(Math.max(2, String(total).length), '0')}_cena.mp4`;
}

function finalizeScenes(s, raw) {
  s.scenes = raw.map((r, idx) => {
    const i = idx + 1;
    return {
      i,
      narration: r.narration,
      prompt: r.prompt,
      finalPrompt: '',
      file: fileName(i, raw.length),
      status: 'pending',
    };
  });
  s.scenes.forEach((sc) => (sc.finalPrompt = composePrompt(sc.prompt, s)));
  s.budget = budget(s);
}

async function plan(p, log) {
  const outputDir = path.resolve(String(p.outputDir || '').trim());
  if (!p.outputDir) throw new Error('Informe a pasta de destino.');
  const generationMode = p.generationMode === 'imagem' ? 'imagem' : 'roteiro';
  const script = String(p.script || '').trim();
  if (generationMode === 'roteiro' && countWords(script) < 3) throw new Error('Cole o roteiro (mínimo de algumas palavras).');
  if (generationMode === 'imagem' && !p.imageDataUrl) throw new Error('O modo "Apenas imagem" exige uma imagem de referência.');

  fs.mkdirSync(outputDir, { recursive: true });
  const existing = store.load(outputDir);
  if (existing && existing.scenes?.some((x) => x.status === 'done') && !p.overwrite) {
    const e = new Error('Esta pasta já tem um projeto com cenas geradas. Retome-o ou escolha outra pasta.');
    e.code = 'EXISTS';
    throw e;
  }

  const format = p.format === '9:16' ? '9:16' : '16:9';
  const settings = {
    outputDir,
    generationMode,
    format,
    style: p.style || 'cinematografico',
    customStyle: p.customStyle || '',
    durationSeconds: p.durationSeconds ? Math.max(10, Number(p.durationSeconds)) : null,
    continuity: p.continuity !== false,
    refMode: p.refMode || 'geral',
    sceneSeconds: config.sceneSeconds,
    resolution: config.resolution,
    costPerSecond: config.costPerSecond,
  };
  const s = {
    version: 1,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'planning',
    settings,
    script,
    reference: null,
    bible: '',
    scenes: [],
    confirmedBudget: false,
  };
  const opts = { onProgress: (d, t) => log(`Prompts das cenas: ${d}/${t}`) };

  if (p.imageDataUrl) {
    const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(p.imageDataUrl);
    if (!m) throw new Error('Imagem inválida (use JPG, PNG ou WEBP).');
    const refDir = path.join(outputDir, '_referencia');
    fs.mkdirSync(refDir, { recursive: true });
    const orig = path.join(refDir, `original.${m[1].toLowerCase().replace('jpeg', 'jpg')}`);
    fs.writeFileSync(orig, Buffer.from(m[2], 'base64'));
    const norm = path.join(refDir, 'referencia.jpg');
    log('Ajustando a imagem de referência ao formato do vídeo…');
    await media.normalizeImage(orig, norm, format);
    log('Analisando a imagem de referência com a IA…');
    const description = await llm.describeReference(fileToDataUri(orig), settings.refMode);
    s.reference = { file: path.relative(outputDir, norm), description };
  }

  const ctx = {
    sceneSeconds: settings.sceneSeconds,
    format,
    refMode: settings.refMode,
    refDescription: s.reference?.description || '',
  };

  let raw;
  if (generationMode === 'imagem') {
    const n = Math.min(config.maxScenes, Math.ceil((settings.durationSeconds || 60) / settings.sceneSeconds));
    log(`Criando roteiro visual de ${n} cenas a partir da imagem…`);
    raw = await llm.imageOnlyScenes(fileToDataUri(path.join(outputDir, s.reference.file)), n, ctx, opts);
  } else {
    const target = settings.durationSeconds ? Math.ceil(settings.durationSeconds / settings.sceneSeconds) : null;
    const { scenes: chunks, words } = planNarration(script, {
      wordsPerMinute: config.wordsPerMinute,
      sceneSeconds: settings.sceneSeconds,
      targetScenes: target,
      maxScenes: config.maxScenes,
    });
    const n = Math.min(config.maxScenes, Math.max(chunks.length, target || 0));
    log(`Roteiro: ${words} palavras → ${n} cenas de ${settings.sceneSeconds}s.`);
    // Se a duração pedida exige mais cenas que trechos de narração, cada trecho vira várias cenas (partes).
    const items = Array.from({ length: n }, (_, k) => {
      const c = Math.floor((k * chunks.length) / n);
      return { i: k + 1, narration: chunks[c], chunk: c };
    });
    items.forEach((it) => {
      const same = items.filter((x) => x.chunk === it.chunk);
      it.parts = same.length;
      it.part = same.indexOf(it) + 1;
    });
    log('Criando bíblia visual (continuidade de personagens e cenários)…');
    s.bible = await llm.buildBible({ script, refDescription: ctx.refDescription, refMode: settings.refMode });
    ctx.bible = s.bible;
    raw = await llm.writeScenePrompts(items, ctx, opts);
  }

  finalizeScenes(s, raw);
  s.status = 'planned';
  store.save(s);
  store.setLast(outputDir);
  log(`Planejamento concluído: ${s.scenes.length} cenas, custo estimado US$ ${s.budget.total.toFixed(2)}.`);
  return s;
}

module.exports = { plan, composePrompt, budget };
