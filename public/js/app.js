import { api, setPassword, getPassword } from './api.js';
import { STYLES, composePrompt } from './styles.js';
import { countWords } from './splitter.js';
import { fsSupported, pickDirectory, getSavedDirectory, ensurePermission, readFile, writeFile, downloadBlob } from './storage.js';
import { toTxt, toCsv, toJson, toPlain, promptRows } from './exports.js';
import { plan, persist, saveReferenceFile, loadSaved, recover, importFromFolder, budget, setSceneMedia, imageUsesReference, STATE_FILE } from './project.js';
import { Runner } from './runner.js';

const $ = (id) => document.getElementById(id);
const usd = (v) => `US$ ${Number(v || 0).toFixed(2)}`;
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDur = (s) => {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}min` : m ? `${m}min ${r ? `${r}s` : ''}`.trim() : `${r}s`;
};

const STATUS = {
  planning: 'planejando', planned: 'planejado', running: 'gerando', paused: 'pausado', cancelled: 'cancelado',
  completed: 'concluído', completed_with_errors: 'concluído com erros', error: 'erro',
};
const SCENE_STATUS = { pending: 'aguardando', submitted: 'enviada', generating: 'gerando', downloading: 'baixando', done: 'concluída', error: 'erro' };

let cfg = {};
let state = null;
let dir = null;
let imageDataUrl = null;

// ---------- log ----------
function log(msg) {
  const el = $('log');
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  el.textContent += `${el.textContent ? '\n' : ''}[${new Date().toLocaleTimeString('pt-BR')}] ${msg}`;
  if (atBottom) el.scrollTop = el.scrollHeight;
  $('progressPanel').classList.remove('hidden');
}

const runner = new Runner({ log, onChange: (s) => render(s) });

function showError(msg) {
  $('formError').textContent = msg || '';
  $('formError').classList.toggle('hidden', !msg);
}

// ---------- senha ----------
async function loadConfig() {
  cfg = await api('/api/config', null, { method: 'GET' });
  if (cfg.misconfigured) {
    showError('Servidor sem APP_PASSWORD configurada. Defina essa variável na Vercel e faça um novo deploy.');
  }
  $('authModal').classList.toggle('hidden', !cfg.authRequired || cfg.authOk || cfg.misconfigured);
  if (cfg.authRequired && !cfg.authOk && getPassword()) $('authMsg').textContent = 'Senha incorreta. Tente de novo.';
  $('keys').innerHTML = [['fal.ai', cfg.hasFalKey], ['API de texto', cfg.hasTextKey]]
    .map(([n, ok]) => `<span class="px-2 py-1 rounded-full ${ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}">${n}: ${ok ? 'ok' : 'falta chave'}</span>`).join('');
  $('sceneSec').textContent = cfg.sceneSeconds;
}
$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  setPassword($('authPassword').value);
  await loadConfig();
});
window.addEventListener('auth-required', () => {
  $('authMsg').textContent = 'Sessão sem senha válida. Digite a senha.';
  $('authModal').classList.remove('hidden');
});

// ---------- init ----------
async function init() {
  $('style').innerHTML = Object.entries(STYLES).map(([id, s]) => `<option value="${id}" ${id === 'cinematografico' ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
  $('browserWarn').classList.toggle('hidden', fsSupported);
  if (!fsSupported) { $('pickFolder').disabled = true; $('importFolder').disabled = true; }
  await loadConfig();

  if (fsSupported) {
    dir = (await getSavedDirectory().catch(() => null)) || null;
    showFolder();
  }
  const saved = await loadSaved().catch(() => null);
  if (saved?.scenes?.length) {
    state = await recover(saved, dir);
    const done = state.scenes.filter((x) => x.status === 'done').length;
    if (done < state.scenes.length && state.confirmedBudget) {
      $('resumeInfo').textContent = `${state.settings.folderName ? `Pasta "${state.settings.folderName}" — ` : ''}${done}/${state.scenes.length} cenas prontas (${STATUS[state.status] || state.status}).`;
      $('resumeBanner').classList.remove('hidden');
    } else {
      render(state, true);
    }
  }
  updateMode();
  updateMediaUi();
}

function showFolder() {
  $('folderName').innerHTML = dir ? `Pasta: <b>${esc(dir.name)}</b>` : '<span class="text-zinc-500">nenhuma pasta escolhida</span>';
}

// ---------- form ----------
const mode = () => document.querySelector('input[name=generationMode]:checked').value;
const format = () => document.querySelector('input[name=format]:checked').value;

function updateMode() {
  const img = mode() === 'imagem';
  $('scriptSection').classList.toggle('hidden', img);
  $('imgOptional').textContent = img ? '(obrigatória)' : '(opcional)';
  $('planBtn').textContent = $('promptsOnly').checked
    ? (img ? 'Criar roteiro visual e gerar prompts' : 'Analisar roteiro e gerar prompts')
    : (img ? 'Criar roteiro visual e calcular orçamento' : 'Analisar roteiro e calcular orçamento');
  $('planBtn').classList.toggle('bg-sky-600', $('promptsOnly').checked);
  $('planBtn').classList.toggle('hover:bg-sky-500', $('promptsOnly').checked);
  $('duration').querySelector('option[value=auto]').disabled = img;
  if (img && $('duration').value === 'auto') $('duration').value = '60';
  updateStats();
}
document.querySelectorAll('input[name=generationMode]').forEach((r) => r.addEventListener('change', updateMode));
$('promptsOnly').addEventListener('change', updateMode);
$('duration').addEventListener('change', () => { $('customDuration').classList.toggle('hidden', $('duration').value !== 'custom'); updateStats(); });
$('customDuration').addEventListener('input', updateStats);
$('style').addEventListener('change', () => $('customStyle').classList.toggle('hidden', $('style').value !== 'personalizado'));

function durationSeconds() {
  const v = $('duration').value;
  if (v === 'auto') return null;
  if (v === 'custom') return Number($('customDuration').value) || null;
  return Number(v);
}

// ---------- tipo de mídia ----------
const mediaMode = () => document.querySelector('input[name=mediaMode]:checked').value;
const videoPercent = () => Number($('videoPercent').value);
const videoSceneCost = () => (cfg.sceneSeconds || 10) * (cfg.costPerSecond || 0);
// estimativa antes do planejamento: com referência de personagem/produto/cenário usa o preço do Kontext
const imageSceneCost = () => (imageDataUrl && ['personagem', 'produto', 'cenario'].includes($('refMode').value) ? cfg.imageI2ICost : cfg.imageT2ICost) ?? 0.05;

function updateMediaUi() {
  const pct = videoPercent();
  $('mixedBox').classList.toggle('hidden', mediaMode() !== 'mixed');
  $('videoPercentLabel').textContent = `${pct}% vídeo · ${100 - pct}% imagem`;
  $('mmVideo').textContent = `MiniMax H3 Max Turbo ${cfg.resolution || '480P'} · ${usd(videoSceneCost())}/cena`;
  $('mmImage').textContent = `Sem vídeo · ${usd(imageSceneCost())}/cena`;
  document.querySelectorAll('.js-sec').forEach((el) => (el.textContent = cfg.sceneSeconds || 10));
  updateStats();
}
document.querySelectorAll('input[name=mediaMode]').forEach((r) => r.addEventListener('change', updateMediaUi));
$('videoPercent').addEventListener('input', updateMediaUi);
$('refMode').addEventListener('change', updateMediaUi);

function estimate(scenes) {
  const m = mediaMode();
  const v = m === 'video' ? scenes : m === 'image' ? 0 : Math.min(scenes, Math.max(1, Math.round((scenes * videoPercent()) / 100)));
  return { v, i: scenes - v, total: v * videoSceneCost() + (scenes - v) * imageSceneCost() };
}

function updateStats() {
  const sec = cfg.sceneSeconds || 10;
  const words = countWords($('script').value);
  const speech = (words / (cfg.wordsPerMinute || 140)) * 60;
  const fixed = durationSeconds();
  const scenes = fixed ? Math.ceil(fixed / sec) : words ? Math.max(1, Math.round(speech / sec)) : 0;
  const e = estimate(scenes);
  const mix = mediaMode() === 'video' ? '' : ` (${e.v} vídeo · ${e.i} imagem)`;
  $('scriptStats').textContent = `${words} palavras · ~${fmtDur(speech)} de fala · ~${scenes} cenas${mix} · ~${usd(e.total)} (estimativa rápida)`;
}
let statsT;
$('script').addEventListener('input', () => { clearTimeout(statsT); statsT = setTimeout(updateStats, 200); });

// ---------- imagem ----------
function setImage(file) {
  if (!file) return;
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return showError('Formato não suportado. Use JPG, PNG ou WEBP.');
  if (file.size > 20 * 1024 * 1024) return showError('Imagem muito grande (máx. 20 MB).');
  const reader = new FileReader();
  reader.onload = () => {
    imageDataUrl = reader.result;
    $('previewImg').src = imageDataUrl;
    $('imgInfo').textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} KB`;
    $('dropEmpty').classList.add('hidden');
    $('dropPreview').classList.remove('hidden');
    showError('');
  };
  reader.readAsDataURL(file);
}
$('drop').addEventListener('click', (e) => { if (!imageDataUrl && e.target.tagName !== 'BUTTON') $('file').click(); });
$('replaceImg').addEventListener('click', (e) => { e.stopPropagation(); $('file').click(); });
$('removeImg').addEventListener('click', (e) => {
  e.stopPropagation();
  imageDataUrl = null;
  $('file').value = '';
  $('dropEmpty').classList.remove('hidden');
  $('dropPreview').classList.add('hidden');
});
$('file').addEventListener('change', () => setImage($('file').files[0]));
['dragover', 'dragenter'].forEach((ev) => $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('border-violet-500'); }));
['dragleave', 'drop'].forEach((ev) => $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.remove('border-violet-500'); }));
$('drop').addEventListener('drop', (e) => setImage(e.dataTransfer.files[0]));

// ---------- pasta ----------
$('pickFolder').addEventListener('click', async () => {
  if (runner.running) return alert('Pause a geração antes de trocar de pasta.');
  try { dir = await pickDirectory(); showFolder(); showError(''); } catch (e) { if (e.name !== 'AbortError') showError(e.message); }
});
$('importFolder').addEventListener('click', async () => {
  if (runner.running) return alert('Pause a geração antes de abrir outro projeto.');
  try {
    const d = await pickDirectory();
    const s = await importFromFolder(d);
    dir = d;
    showFolder();
    state = await recover(s, dir);
    await persist(state, dir);
    $('resumeBanner').classList.add('hidden');
    render(state, true);
    log(`Projeto carregado da pasta "${dir.name}".`);
  } catch (e) { if (e.name !== 'AbortError') showError(e.message); }
});

// ---------- planejar ----------
let planAbort = null;
$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  if (runner.running) return showError('Há uma geração em andamento. Pause ou cancele antes.');
  const promptsOnly = $('promptsOnly').checked;
  if (fsSupported && !dir && !promptsOnly) return showError('Escolha a pasta de destino primeiro.');
  if (mode() === 'imagem' && !imageDataUrl) return showError('O modo "Apenas imagem" exige uma imagem.');
  if ($('duration').value === 'custom' && !durationSeconds()) return showError('Informe a duração personalizada em segundos.');
  if (dir && !(await ensurePermission(dir))) return showError('Permissão para gravar na pasta negada.');

  // não sobrescrever projeto com cenas já geradas sem perguntar
  const doneHere = state?.scenes?.some((x) => x.status === 'done');
  const folderState = dir ? await readFile(dir, STATE_FILE) : null;
  if ((doneHere || folderState) && !confirm('Já existe um projeto salvo (neste navegador ou nesta pasta). Criar um NOVO projeto vai substituí-lo — clipes com o mesmo nome serão sobrescritos. Continuar?')) return;

  $('planBtn').disabled = true;
  $('planBtn').textContent = 'Analisando com a IA… (pode levar alguns minutos em roteiros longos)';
  planAbort = new AbortController();
  try {
    const s = await plan({
      generationMode: mode(),
      script: $('script').value,
      imageDataUrl,
      refMode: $('refMode').value,
      format: format(),
      style: $('style').value,
      customStyle: $('customStyle').value,
      durationSeconds: durationSeconds(),
      continuity: $('continuity').checked,
      folderName: dir?.name,
      promptsOnly,
      mediaMode: mediaMode(),
      videoPercent: videoPercent(),
    }, { cfg, log, signal: planAbort.signal });
    state = s;
    await persist(state, dir);
    await saveReferenceFile(state, dir).catch((err) => log(`Aviso: referência não salva na pasta (${err.message}).`));
    if (promptsOnly) await savePromptFiles();
    $('resumeBanner').classList.add('hidden');
    render(state, true);
    $(promptsOnly ? 'promptsPanel' : 'budgetPanel').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    showError(err.message);
    log(`Erro no planejamento: ${err.message}`);
  } finally {
    $('planBtn').disabled = false;
    updateMode();
  }
});

// ---------- orçamento ----------
function renderBudgetNumbers(s) {
  const b = budget(s);
  $('bScenes').textContent = b.scenes;
  $('bDuration').textContent = fmtDur(b.seconds);
  $('bUnit').innerHTML = [
    b.videos ? `${b.videos} vídeo${b.videos > 1 ? 's' : ''} × ${usd(b.videoCost)}` : '',
    b.images ? `${b.images} image${b.images > 1 ? 'ns' : 'm'} × ${usd(b.imageCost)}` : '',
  ].filter(Boolean).join('<br>');
  $('bTotal').textContent = usd(b.total);
  $('bConfirmTotal').textContent = usd(b.total);
}

function renderBudget(s) {
  renderBudgetNumbers(s);
  const busy = runner.running;
  $('sceneEditor').innerHTML = s.scenes.map((sc) => `
    <div class="p-3 space-y-1">
      <div class="flex items-center justify-between gap-2">
        <div class="text-xs text-zinc-400 min-w-0"><b class="text-zinc-200">${esc(sc.file)}</b> · ${esc(sc.narration)}</div>
        <select data-media="${sc.i}" ${sc.status === 'done' || busy ? 'disabled' : ''} class="shrink-0 bg-zinc-950 border border-zinc-700 rounded px-1 py-0.5 text-xs">
          <option value="video" ${sc.media !== 'image' ? 'selected' : ''}>🎬 vídeo</option>
          <option value="image" ${sc.media === 'image' ? 'selected' : ''}>🖼 imagem</option>
        </select>
      </div>
      <textarea data-i="${sc.i}" rows="2" ${sc.status === 'done' ? 'disabled' : ''} class="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs">${esc(sc.prompt)}</textarea>
    </div>`).join('');
}

/** Aplica no estado o que foi digitado nos prompts (sem salvar). */
function applyEditorPrompts() {
  for (const t of $('sceneEditor').querySelectorAll('textarea:not([disabled])')) {
    const sc = state.scenes[Number(t.dataset.i) - 1];
    if (sc && t.value.trim()) { sc.prompt = t.value.trim(); sc.finalPrompt = composePrompt(sc.prompt, state); }
  }
}

$('sceneEditor').addEventListener('change', async (e) => {
  const i = e.target.dataset?.media;
  if (!i || !state || runner.running) return;
  applyEditorPrompts();
  setSceneMedia(state, state.scenes[Number(i) - 1], e.target.value);
  if (state.confirmedBudget) { state.confirmedBudget = false; log('Orçamento mudou — confirme de novo antes de gerar.'); }
  await persist(state, dir);
  renderBudget(state);
  render(state);
  if (state.settings.promptsOnly) { renderPrompts(state); await savePromptFiles(); }
});

$('saveScenes').addEventListener('click', async () => {
  if (!state || runner.running) return alert('Não é possível editar durante a geração.');
  applyEditorPrompts();
  await persist(state, dir);
  if (state.settings.promptsOnly) await savePromptFiles();
  renderPrompts(state);
  log('Prompts atualizados.');
});

// ---------- apenas prompts ----------
const withStyle = () => $('withStyle').checked;
const slug = () => (state.settings.folderName || 'meus-videos').replace(/[^\w-]+/g, '_');

async function savePromptFiles() {
  if (!dir || !state) return;
  try {
    if (!(await ensurePermission(dir))) return;
    await writeFile(dir, 'prompts.txt', toTxt(state, true));
    await writeFile(dir, 'prompts.csv', toCsv(state, true));
    await writeFile(dir, 'prompts.json', toJson(state, true));
    $('promptsSaved').textContent = `Salvos também na pasta "${dir.name}": prompts.txt, prompts.csv e prompts.json.`;
    $('promptsSaved').classList.remove('hidden');
    log(`Prompts salvos na pasta "${dir.name}".`);
  } catch (e) {
    log(`Aviso: não foi possível salvar os prompts na pasta (${e.message}).`);
  }
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(t); t.select(); document.execCommand('copy'); t.remove();
  }
  const old = btn.textContent;
  btn.textContent = 'Copiado!';
  setTimeout(() => (btn.textContent = old), 1200);
}

function renderPrompts(s) {
  const rows = promptRows(s, withStyle());
  $('promptsCount').textContent = `(${rows.length} cenas)`;
  $('promptsList').innerHTML = rows.map((r) => `
    <div class="p-3 space-y-1">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs text-zinc-400"><b class="text-zinc-200">Cena ${String(r.cena).padStart(2, '0')}</b> · ${r.inicio}–${r.fim} · ${r.midia === 'imagem' ? '🖼 imagem' : '🎬 vídeo'}</span>
        <button data-copy="${r.cena}" class="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-xs">Copiar</button>
      </div>
      <div class="text-xs text-zinc-500">${esc(r.narracao)}</div>
      <div class="text-sm text-zinc-200 whitespace-pre-wrap">${esc(r.prompt)}</div>
    </div>`).join('');
}

$('promptsList').addEventListener('click', (e) => {
  const i = e.target.dataset?.copy;
  if (i) copyText(promptRows(state, withStyle())[Number(i) - 1].prompt, e.target);
});
$('withStyle').addEventListener('change', () => state && renderPrompts(state));
$('copyAll').addEventListener('click', (e) => copyText(toPlain(state, withStyle()), e.target));
$('dlTxt').addEventListener('click', () => downloadBlob(new Blob([toTxt(state, withStyle())], { type: 'text/plain;charset=utf-8' }), `${slug()}_prompts.txt`));
$('dlCsv').addEventListener('click', () => downloadBlob(new Blob([toCsv(state, withStyle())], { type: 'text/csv;charset=utf-8' }), `${slug()}_prompts.csv`));
$('dlJson').addEventListener('click', () => downloadBlob(new Blob([toJson(state, withStyle())], { type: 'application/json' }), `${slug()}_prompts.json`));
$('switchToVideo').addEventListener('click', async () => {
  if (fsSupported && !dir) return alert('Escolha a pasta de destino (item 1) antes de gerar os vídeos.');
  if (!confirm(`Passar a gerar os vídeos? Custo estimado: ${usd(budget(state).total)}. Você ainda precisa confirmar o orçamento antes de começar.`)) return;
  state.settings.promptsOnly = false;
  state.settings.folderName = dir?.name || state.settings.folderName;
  await persist(state, dir);
  await saveReferenceFile(state, dir).catch(() => {});
  render(state, true);
  $('budgetPanel').scrollIntoView({ behavior: 'smooth' });
});
$('confirmBudget').addEventListener('change', async () => {
  if (!state) return;
  state.confirmedBudget = $('confirmBudget').checked;
  state.confirmedAt = state.confirmedBudget ? new Date().toISOString() : null;
  await persist(state, dir);
  render(state);
});

async function start() {
  if (!state) return;
  if (fsSupported && !dir) return alert('Escolha a pasta de destino (ou abra o projeto da pasta) antes de continuar.');
  $('progressPanel').scrollIntoView({ behavior: 'smooth' });
  try { await runner.start(state, dir); } catch (e) { alert(e.message); }
}
$('startBtn').addEventListener('click', start);
$('resumeBtn').addEventListener('click', start);
$('pauseBtn').addEventListener('click', () => runner.pause());
$('cancelBtn').addEventListener('click', () => {
  if (confirm('Cancelar a geração? O progresso fica salvo e você pode retomar depois.')) runner.cancel();
});
$('retryBtn').addEventListener('click', () => {
  for (const sc of state.scenes) {
    if (sc.status === 'error') Object.assign(sc, { status: 'pending', error: null, requestId: null, statusUrl: null, responseUrl: null, videoUrl: null });
  }
  start();
});
$('resumeView').addEventListener('click', () => {
  $('resumeBanner').classList.add('hidden');
  render(state, true);
  $('progressPanel').scrollIntoView({ behavior: 'smooth' });
});
$('resumeDismiss').addEventListener('click', () => {
  $('resumeBanner').classList.add('hidden');
  $('budgetPanel').classList.add('hidden');
  $('progressPanel').classList.add('hidden');
});
window.addEventListener('beforeunload', (e) => { if (runner.running) { e.preventDefault(); e.returnValue = ''; } });

// ---------- render ----------
let renderT = null;
function render(s, rebuild = false) {
  if (rebuild) { renderNow(s, true); return; }
  if (renderT) return;
  renderT = setTimeout(() => { renderT = null; renderNow(state); }, 150);
}

function renderNow(s, rebuild = false) {
  if (!s?.scenes?.length) return;
  const promptsOnly = !!s.settings.promptsOnly;
  $('budgetPanel').classList.remove('hidden');
  $('progressPanel').classList.toggle('hidden', promptsOnly && !$('log').textContent);
  $('promptsPanel').classList.toggle('hidden', !promptsOnly);
  $('generateArea').classList.toggle('hidden', promptsOnly);
  $('promptsOnlyNote').classList.toggle('hidden', !promptsOnly);
  for (const id of ['progressWrap', 'sceneList']) $(id).classList.toggle('hidden', promptsOnly);
  if (rebuild) {
    renderBudget(s);
    if (promptsOnly) renderPrompts(s);
  }

  const b = budget(s);
  const running = runner.running;
  const done = s.scenes.filter((x) => x.status === 'done').length;
  const total = s.scenes.length;
  renderBudgetNumbers(s);
  const notes = [];
  if (b.videos) notes.push(`Vídeo: MiniMax H3 Max Turbo ${s.settings.resolution}, sem áudio, ${s.settings.sceneSeconds}s por cena a US$ ${Number(b.costPerSecond).toFixed(4).replace(/0+$/, '')}/s.`);
  if (b.images) notes.push(`Imagem: ${imageUsesReference(s) ? 'FLUX Kontext (mantém a referência)' : 'FLUX 2 Flex'}, ${usd(b.imageCost)} cada, exibida por ${s.settings.sceneSeconds}s na edição.`);
  if (b.images) notes.push(`Se fosse tudo em vídeo: ${usd(b.allVideoTotal)} (economia de ${usd(b.allVideoTotal - b.total)}).`);
  if (b.pendingScenes > 0 && b.pendingScenes < b.scenes) notes.push(`Restante a gerar: ${b.pendingScenes} cenas ≈ ${usd(b.pendingCost)}.`);
  $('bNote').textContent = `${notes.join(' ')} Formato ${s.settings.format}.`;
  $('confirmBudget').checked = !!s.confirmedBudget;
  $('confirmBudget').disabled = running || done > 0;
  $('startBtn').disabled = !s.confirmedBudget;
  $('startBtn').classList.toggle('hidden', running || done > 0);

  $('bar').style.width = `${total ? (done / total) * 100 : 0}%`;
  $('progressText').textContent = `${done} / ${total} cenas concluídas`;
  const cur = s.currentIndex ? s.scenes[s.currentIndex - 1] : null;
  $('currentText').textContent = running && cur ? `Cena ${cur.i}: ${SCENE_STATUS[cur.status] || cur.status}${cur.falStatus ? ` (${cur.falStatus})` : ''}` : '';
  $('spentText').textContent = `Gasto estimado: ${usd(b.spent)} de ${usd(b.total)}`;
  $('statusBadge').textContent = runner.pauseReq && running ? 'pausando…' : STATUS[s.status] || s.status;
  $('keepOpen').classList.toggle('hidden', !running);

  $('pauseBtn').classList.toggle('hidden', !running);
  $('cancelBtn').classList.toggle('hidden', !running);
  const next = s.scenes.find((x) => x.status !== 'done' && x.status !== 'error');
  $('resumeBtn').classList.toggle('hidden', running || !s.confirmedBudget || done === 0 || !next);
  $('resumeBtn').textContent = next ? `Continuar (a partir da cena ${next.i})` : 'Continuar';
  $('retryBtn').classList.toggle('hidden', running || !s.scenes.some((x) => x.status === 'error'));

  $('sceneList').innerHTML = s.scenes.map((sc) => `
    <div class="scene-row flex items-center gap-2 px-2 py-1 rounded bg-zinc-950" data-status="${sc.status}" title="${esc(sc.error || sc.narration)}">
      <span class="dot w-2 h-2 rounded-full bg-zinc-600 shrink-0"></span>
      <span class="font-mono">${esc(sc.file)}</span>
      <span class="text-zinc-500 truncate">${esc(sc.error ? `erro: ${sc.error}` : SCENE_STATUS[sc.status] || sc.status)}</span>
    </div>`).join('');
}

init().catch((e) => showError(`Falha ao iniciar: ${e.message}`));
