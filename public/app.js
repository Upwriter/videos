const $ = (id) => document.getElementById(id);
const usd = (v) => `US$ ${Number(v || 0).toFixed(2)}`;
const fmtDur = (s) => {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}min` : m ? `${m}min ${r ? `${r}s` : ''}`.trim() : `${r}s`;
};
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STATUS = {
  planning: 'planejando', planned: 'planejado', running: 'gerando', paused: 'pausado', cancelled: 'cancelado',
  completed: 'concluído', completed_with_errors: 'concluído com erros', error: 'erro',
};
const SCENE_STATUS = { pending: 'aguardando', submitted: 'enviada', generating: 'gerando', downloading: 'baixando', done: 'concluída', error: 'erro' };

let cfg = {};
let state = null;
let imageDataUrl = null;
let dismissedResume = false;

async function api(url, body, method = 'POST') {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Erro ${res.status}`); e.code = data.code; throw e; }
  return data;
}

function showError(msg) {
  $('formError').textContent = msg || '';
  $('formError').classList.toggle('hidden', !msg);
}

// ---------- init ----------
async function init() {
  cfg = await api('/api/config', null, 'GET');
  $('sceneSec').textContent = cfg.sceneSeconds;
  $('style').innerHTML = cfg.styles.map((s) => `<option value="${s.id}" ${s.id === 'cinematografico' ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
  $('keys').innerHTML = [
    ['fal.ai', cfg.hasFalKey], ['API de texto', cfg.hasTextKey],
  ].map(([n, ok]) => `<span class="px-2 py-1 rounded-full ${ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}">${n}: ${ok ? 'ok' : 'falta chave no .env'}</span>`).join('');
  if (cfg.lastOutputDir) $('outputDir').value = cfg.lastOutputDir;

  const { state: s, logs } = await api('/api/state', null, 'GET');
  $('log').textContent = (logs || []).join('\n');
  if (s) applyState(s, true);
  connectSSE();
  updateMode();
  updateStats();
}

function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => { const s = JSON.parse(e.data); if (s) applyState(s); });
  es.addEventListener('log', (e) => {
    const log = $('log');
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
    log.textContent += (log.textContent ? '\n' : '') + JSON.parse(e.data);
    if (atBottom) log.scrollTop = log.scrollHeight;
  });
}

// ---------- form ----------
const mode = () => document.querySelector('input[name=generationMode]:checked').value;
const format = () => document.querySelector('input[name=format]:checked').value;

function updateMode() {
  const img = mode() === 'imagem';
  $('scriptSection').classList.toggle('hidden', img);
  $('imgOptional').textContent = img ? '(obrigatória)' : '(opcional)';
  $('planBtn').textContent = img ? 'Criar roteiro visual e calcular orçamento' : 'Analisar roteiro e calcular orçamento';
  const auto = $('duration').querySelector('option[value=auto]');
  auto.disabled = img;
  if (img && $('duration').value === 'auto') $('duration').value = '60';
}
document.querySelectorAll('input[name=generationMode]').forEach((r) => r.addEventListener('change', updateMode));

$('duration').addEventListener('change', () => {
  $('customDuration').classList.toggle('hidden', $('duration').value !== 'custom');
  updateStats();
});
$('customDuration').addEventListener('input', updateStats);
$('style').addEventListener('change', () => $('customStyle').classList.toggle('hidden', $('style').value !== 'personalizado'));

function durationSeconds() {
  const v = $('duration').value;
  if (v === 'auto') return null;
  if (v === 'custom') return Number($('customDuration').value) || null;
  return Number(v);
}

function updateStats() {
  const words = ($('script').value.trim().match(/\S+/g) || []).length;
  const minutes = words / (cfg.wordsPerMinute || 140);
  const sec = durationSeconds() ?? minutes * 60;
  const scenes = words || durationSeconds() ? Math.max(1, durationSeconds() ? Math.ceil(sec / (cfg.sceneSeconds || 10)) : Math.round(sec / (cfg.sceneSeconds || 10))) : 0;
  const cost = scenes * (cfg.sceneSeconds || 10) * (cfg.costPerSecond || 0);
  $('scriptStats').textContent = `${words} palavras · ~${fmtDur(minutes * 60)} de fala · ~${scenes} cenas · ~${usd(cost)} (estimativa rápida)`;
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
  imageDataUrl = null; $('file').value = '';
  $('dropEmpty').classList.remove('hidden'); $('dropPreview').classList.add('hidden');
});
$('file').addEventListener('change', () => setImage($('file').files[0]));
['dragover', 'dragenter'].forEach((ev) => $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('border-violet-500'); }));
['dragleave', 'drop'].forEach((ev) => $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.remove('border-violet-500'); }));
$('drop').addEventListener('drop', (e) => setImage(e.dataTransfer.files[0]));

// ---------- pasta ----------
$('pickFolder').addEventListener('click', async () => {
  $('pickFolder').disabled = true;
  try {
    const { path } = await api('/api/pick-folder');
    if (path) $('outputDir').value = path;
  } catch (e) { showError(e.message); } finally { $('pickFolder').disabled = false; }
});
$('loadFolder').addEventListener('click', async () => {
  try {
    const { state: s } = await api('/api/load', { outputDir: $('outputDir').value });
    dismissedResume = true;
    applyState(s, true);
    showError('');
  } catch (e) { showError(e.message); }
});

// ---------- planejar ----------
$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  if (mode() === 'imagem' && !imageDataUrl) return showError('O modo "Apenas imagem" exige uma imagem.');
  if ($('duration').value === 'custom' && !durationSeconds()) return showError('Informe a duração personalizada em segundos.');
  const body = {
    outputDir: $('outputDir').value,
    generationMode: mode(),
    script: $('script').value,
    imageDataUrl,
    refMode: $('refMode').value,
    format: format(),
    style: $('style').value,
    customStyle: $('customStyle').value,
    durationSeconds: durationSeconds(),
    continuity: $('continuity').checked,
  };
  $('planBtn').disabled = true;
  $('planBtn').textContent = 'Analisando com a IA… (pode levar alguns minutos em roteiros longos)';
  $('progressPanel').classList.remove('hidden');
  try {
    let res;
    try {
      res = await api('/api/plan', body);
    } catch (err) {
      if (err.code !== 'EXISTS' || !confirm(`${err.message}\n\nDeseja SOBRESCREVER o projeto desta pasta? (os MP4 já baixados com o mesmo nome serão substituídos)`)) throw err;
      res = await api('/api/plan', { ...body, overwrite: true });
    }
    dismissedResume = true;
    applyState(res.state, true);
    $('budgetPanel').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    showError(err.message);
  } finally {
    $('planBtn').disabled = false;
    updateMode();
  }
});

// ---------- orçamento ----------
function renderBudget(s) {
  const b = s.budget;
  $('bScenes').textContent = b.scenes;
  $('bDuration').textContent = fmtDur(b.seconds);
  $('bUnit').textContent = usd(b.costPerScene);
  $('bTotal').textContent = usd(b.total);
  $('bConfirmTotal').textContent = usd(b.total);
  $('bNote').textContent = `${s.settings.resolution}, sem áudio, ${s.settings.sceneSeconds}s por cena a US$ ${Number(b.costPerSecond).toFixed(4).replace(/0+$/, '')}/s (${s.settings.format}). `
    + (b.pendingScenes < b.scenes ? `Restante a gerar: ${b.pendingScenes} cenas ≈ ${usd(b.pendingCost)}.` : '');
  $('sceneEditor').innerHTML = s.scenes.map((sc) => `
    <div class="p-3 space-y-1">
      <div class="text-xs text-zinc-400"><b class="text-zinc-200">${esc(sc.file)}</b> · ${esc(sc.narration)}</div>
      <textarea data-i="${sc.i}" rows="2" ${sc.status === 'done' ? 'disabled' : ''} class="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs">${esc(sc.prompt)}</textarea>
    </div>`).join('');
  $('confirmBudget').checked = !!s.confirmedBudget;
  $('startBtn').disabled = !s.confirmedBudget;
}

$('saveScenes').addEventListener('click', async () => {
  const scenes = [...$('sceneEditor').querySelectorAll('textarea:not([disabled])')].map((t) => ({ i: Number(t.dataset.i), prompt: t.value }));
  try { const { state: s } = await api('/api/scenes', { scenes }, 'PUT'); applyState(s, true); } catch (e) { alert(e.message); }
});
$('confirmBudget').addEventListener('change', async () => {
  if ($('confirmBudget').checked) {
    try { await api('/api/confirm'); $('startBtn').disabled = false; } catch (e) { alert(e.message); $('confirmBudget').checked = false; }
  } else $('startBtn').disabled = true;
});
$('startBtn').addEventListener('click', async () => {
  try { await api('/api/start'); $('progressPanel').scrollIntoView({ behavior: 'smooth' }); } catch (e) { alert(e.message); }
});

// ---------- progresso ----------
$('pauseBtn').addEventListener('click', () => api('/api/pause').catch((e) => alert(e.message)));
$('resumeBtn').addEventListener('click', () => api('/api/start').catch((e) => alert(e.message)));
$('cancelBtn').addEventListener('click', () => {
  if (confirm('Cancelar a geração? O progresso fica salvo e você pode retomar depois.')) api('/api/cancel').catch((e) => alert(e.message));
});
$('retryBtn').addEventListener('click', () => api('/api/retry-failed').catch((e) => alert(e.message)));
$('openFolderBtn').addEventListener('click', () => api('/api/open-folder').catch((e) => alert(e.message)));
$('resumeView').addEventListener('click', () => {
  dismissedResume = true;
  $('resumeBanner').classList.add('hidden');
  showPanels(state, true);
  $('progressPanel').scrollIntoView({ behavior: 'smooth' });
});
$('resumeDismiss').addEventListener('click', () => {
  dismissedResume = true;
  $('resumeBanner').classList.add('hidden');
  $('budgetPanel').classList.add('hidden');
  $('progressPanel').classList.add('hidden');
});

function showPanels(s, rebuildBudget) {
  if (!s?.scenes?.length) return;
  $('budgetPanel').classList.remove('hidden');
  $('progressPanel').classList.remove('hidden');
  if (rebuildBudget) renderBudget(s);
}

function applyState(s, rebuild = false) {
  const first = !state;
  state = s;
  if (!s) return;

  const done = s.scenes.filter((x) => x.status === 'done').length;
  const total = s.scenes.length;
  const unfinished = total && done < total && !s.running;

  if (first && unfinished && !dismissedResume) {
    $('resumeInfo').textContent = `${s.settings.outputDir} — ${done}/${total} cenas prontas (${STATUS[s.status] || s.status}).`;
    $('resumeBanner').classList.remove('hidden');
    $('outputDir').value = s.settings.outputDir;
  } else if (rebuild || dismissedResume || s.running || $('resumeBanner').classList.contains('hidden')) {
    $('resumeBanner').classList.add('hidden');
    showPanels(s, rebuild || first);
  }

  // números do orçamento sempre atualizados (sem refazer os textareas)
  if (!rebuild && s.budget) {
    $('bConfirmTotal').textContent = usd(s.budget.total);
    $('bNote').textContent = $('bNote').textContent.replace(/Restante.*$/, '') + (s.budget.pendingScenes < s.budget.scenes ? `Restante a gerar: ${s.budget.pendingScenes} cenas ≈ ${usd(s.budget.pendingCost)}.` : '');
  }

  // progresso
  $('bar').style.width = `${total ? (done / total) * 100 : 0}%`;
  $('progressText').textContent = `${done} / ${total} cenas concluídas`;
  const cur = s.currentIndex ? s.scenes[s.currentIndex - 1] : null;
  $('currentText').textContent = s.running && cur ? `Cena ${cur.i}: ${SCENE_STATUS[cur.status] || cur.status}${cur.falStatus ? ` (${cur.falStatus})` : ''}` : '';
  $('spentText').textContent = s.budget ? `Gasto estimado: ${usd(done * s.budget.costPerScene)} de ${usd(s.budget.total)}` : '';
  $('statusBadge').textContent = s.pauseRequested && s.running ? 'pausando…' : STATUS[s.status] || s.status;

  $('pauseBtn').classList.toggle('hidden', !s.running);
  $('cancelBtn').classList.toggle('hidden', !s.running && ['completed', 'cancelled', 'planned'].includes(s.status));
  $('resumeBtn').classList.toggle('hidden', s.running || !s.confirmedBudget || done === total || s.status === 'planned');
  $('resumeBtn').textContent = done > 0 ? `Continuar (a partir da cena ${(s.scenes.find((x) => x.status !== 'done') || {}).i || ''})` : 'Iniciar';
  $('retryBtn').classList.toggle('hidden', s.running || !s.scenes.some((x) => x.status === 'error'));
  $('startBtn').classList.toggle('hidden', s.running || done > 0);
  $('confirmBudget').disabled = s.running;

  $('sceneList').innerHTML = s.scenes.map((sc) => `
    <div class="scene-row flex items-center gap-2 px-2 py-1 rounded bg-zinc-950" data-status="${sc.status}" title="${esc(sc.error || sc.narration)}">
      <span class="dot w-2 h-2 rounded-full bg-zinc-600 shrink-0"></span>
      <span class="font-mono">${esc(sc.file)}</span>
      <span class="text-zinc-500 truncate">${esc(sc.error ? `erro: ${sc.error}` : SCENE_STATUS[sc.status] || sc.status)}</span>
    </div>`).join('');
}

init().catch((e) => showError(`Falha ao iniciar: ${e.message}`));
