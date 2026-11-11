// Planejamento do projeto (divisão + IA) e persistência (IndexedDB + project_state.json na pasta).
import { api, withRetry } from './api.js';
import { planNarration, countWords } from './splitter.js';
import { composePrompt } from './styles.js';
import { normalizeImage, shrinkImage } from './media.js';
import { idbGet, idbSet, idbDel, writeFile, readFile, hasPermission, dataUrlToBlob, blobToDataUrl } from './storage.js';

const BATCH = 8;
export const STATE_FILE = 'project_state.json';
const REF_FILE = '_referencia/referencia.jpg';

export function budget(s) {
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

const fileName = (i, total) => `${String(i).padStart(Math.max(2, String(total).length), '0')}_cena.mp4`;

const ai = (body, signal, log) => withRetry(() => api('/api/ai', body, { signal }), {
  signal,
  onRetry: (e, n, d) => log?.(`IA: ${e.message}. Tentando de novo em ${Math.round(d / 1000)}s…`),
});

export async function plan(p, { cfg, log, signal }) {
  const generationMode = p.generationMode === 'imagem' ? 'imagem' : 'roteiro';
  const script = String(p.script || '').trim();
  if (generationMode === 'roteiro' && countWords(script) < 3) throw new Error('Cole o roteiro (mínimo de algumas palavras).');
  if (generationMode === 'imagem' && !p.imageDataUrl) throw new Error('O modo "Apenas imagem" exige uma imagem de referência.');

  const format = p.format === '9:16' ? '9:16' : '16:9';
  const settings = {
    generationMode,
    format,
    style: p.style || 'cinematografico',
    customStyle: p.customStyle || '',
    durationSeconds: p.durationSeconds ? Math.max(10, Number(p.durationSeconds)) : null,
    continuity: p.continuity !== false,
    refMode: p.refMode || 'geral',
    sceneSeconds: cfg.sceneSeconds,
    resolution: cfg.resolution,
    costPerSecond: cfg.costPerSecond,
    folderName: p.folderName || null,
  };
  const s = {
    version: 2,
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

  let smallRef = null;
  if (p.imageDataUrl) {
    log('Ajustando a imagem de referência ao formato do vídeo…');
    const dataUrl = await normalizeImage(p.imageDataUrl, format);
    smallRef = await shrinkImage(p.imageDataUrl, 1024);
    log('Analisando a imagem de referência com a IA…');
    const { description } = await ai({ action: 'describe', imageDataUrl: smallRef, refMode: settings.refMode }, signal, log);
    s.reference = { dataUrl, description, file: REF_FILE };
  }

  const ctx = { sceneSeconds: settings.sceneSeconds, format, refMode: settings.refMode, refDescription: s.reference?.description || '' };
  const raw = [];

  if (generationMode === 'imagem') {
    const n = Math.min(cfg.maxScenes, Math.ceil((settings.durationSeconds || 60) / settings.sceneSeconds));
    log(`Criando roteiro visual de ${n} cenas a partir da imagem…`);
    for (let from = 1; from <= n; from += BATCH) {
      const count = Math.min(BATCH, n - from + 1);
      const { scenes } = await ai({ action: 'image-scenes', imageDataUrl: smallRef, n, from, count, ctx, previous: raw.slice(-2) }, signal, log);
      raw.push(...scenes);
      log(`Prompts das cenas: ${raw.length}/${n}`);
    }
  } else {
    const target = settings.durationSeconds ? Math.ceil(settings.durationSeconds / settings.sceneSeconds) : null;
    const { scenes: chunks, words } = planNarration(script, {
      wordsPerMinute: cfg.wordsPerMinute, sceneSeconds: settings.sceneSeconds, targetScenes: target, maxScenes: cfg.maxScenes,
    });
    const n = Math.min(cfg.maxScenes, Math.max(chunks.length, target || 0));
    log(`Roteiro: ${words} palavras → ${n} cenas de ${settings.sceneSeconds}s.`);
    // duração maior que o texto → um trecho de narração cobre várias cenas (partes)
    const items = Array.from({ length: n }, (_, k) => ({ i: k + 1, narration: chunks[Math.floor((k * chunks.length) / n)], chunk: Math.floor((k * chunks.length) / n) }));
    items.forEach((it) => {
      const same = items.filter((x) => x.chunk === it.chunk);
      it.parts = same.length;
      it.part = same.indexOf(it) + 1;
    });
    log('Criando bíblia visual (continuidade de personagens e cenários)…');
    ({ bible: s.bible } = await ai({ action: 'bible', script, refDescription: ctx.refDescription, refMode: settings.refMode }, signal, log));
    ctx.bible = s.bible;
    for (let b = 0; b < items.length; b += BATCH) {
      const batch = items.slice(b, b + BATCH).map(({ i, narration, part, parts }) => ({ i, narration, part, parts }));
      const { scenes } = await ai({ action: 'scene-prompts', scenes: batch, ctx, previous: raw.slice(-2) }, signal, log);
      const byI = new Map(scenes.map((x) => [x.i, x.prompt]));
      batch.forEach((it) => raw.push({ i: it.i, narration: it.narration, prompt: byI.get(it.i) || `Cinematic shot illustrating: ${it.narration}` }));
      log(`Prompts das cenas: ${raw.length}/${n}`);
    }
  }

  s.scenes = raw.map((r, idx) => ({
    i: idx + 1,
    narration: r.narration,
    prompt: r.prompt,
    finalPrompt: '',
    file: fileName(idx + 1, raw.length),
    status: 'pending',
  }));
  s.scenes.forEach((sc) => (sc.finalPrompt = composePrompt(sc.prompt, s)));
  s.status = 'planned';
  s.budget = budget(s);
  log(`Planejamento concluído: ${s.scenes.length} cenas, custo estimado US$ ${s.budget.total.toFixed(2)}.`);
  return s;
}

/** Versão para o project_state.json (sem imagens em base64). */
function forFolder(s) {
  const { lastFrame, ...rest } = s;
  return { ...rest, reference: s.reference ? { file: s.reference.file, description: s.reference.description } : null };
}

export async function persist(s, dir) {
  s.updatedAt = new Date().toISOString();
  s.budget = budget(s);
  await idbSet('project', s);
  if (dir && (await hasPermission(dir))) {
    await writeFile(dir, STATE_FILE, JSON.stringify(forFolder(s), null, 2));
  }
}

export async function saveReferenceFile(s, dir) {
  if (dir && s.reference?.dataUrl) await writeFile(dir, REF_FILE, await dataUrlToBlob(s.reference.dataUrl));
}

export const loadSaved = () => idbGet('project');
export const clearSaved = () => idbDel('project');

/** Abre um project_state.json de uma pasta (ex.: retomar em outro navegador/PC). */
export async function importFromFolder(dir) {
  const f = await readFile(dir, STATE_FILE);
  if (!f) throw new Error(`Não há ${STATE_FILE} nesta pasta.`);
  const s = JSON.parse(await f.text());
  if (s.reference?.file) {
    const img = await readFile(dir, s.reference.file);
    if (img) s.reference.dataUrl = await blobToDataUrl(img);
  }
  s.settings.folderName = dir.name;
  return s;
}

/** Normaliza um estado interrompido (aba fechada no meio). */
export async function recover(s, dir) {
  if (['running', 'planning'].includes(s.status)) s.status = s.scenes.length ? 'paused' : 'planned';
  for (const sc of s.scenes) {
    if (['submitted', 'downloading', 'generating'].includes(sc.status)) sc.status = sc.responseUrl ? 'generating' : 'pending';
    if (sc.status === 'done' && dir && (await hasPermission(dir)) && !(await readFile(dir, sc.file))) sc.status = 'pending';
  }
  s.budget = budget(s);
  return s;
}
