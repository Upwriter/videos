const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const express = require('express');
const config = require('./src/config');
const store = require('./src/services/state');
const runner = require('./src/runner');
const { plan, composePrompt } = require('./src/planner');
const { STYLES } = require('./src/services/styles');
const { countWords } = require('./src/services/splitter');

const app = express();
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => async (req, res) => {
  try {
    res.json((await fn(req, res)) ?? { ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
};

// ---------- SSE ----------
const clients = new Set();
const send = (event, data) => {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(payload);
};
let stateTimer = null;
runner.on('update', () => {
  if (stateTimer) return;
  stateTimer = setTimeout(() => { stateTimer = null; send('state', publicState()); }, 250);
});
runner.on('log', (line) => send('log', line));

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

function publicState() {
  if (!runner.state) return null;
  return { ...runner.state, running: runner.running, pauseRequested: !!runner.pauseReq };
}

// ---------- API ----------
app.get('/api/config', wrap(() => ({
  hasFalKey: !!config.falKey,
  hasTextKey: !!config.openaiKey,
  sceneSeconds: config.sceneSeconds,
  costPerSecond: config.costPerSecond,
  resolution: config.resolution,
  wordsPerMinute: config.wordsPerMinute,
  styles: Object.entries(STYLES).map(([id, s]) => ({ id, label: s.label })),
  lastOutputDir: store.getLast(),
})));

app.get('/api/state', wrap(() => ({ state: publicState(), logs: runner.logs })));

app.post('/api/pick-folder', wrap(() => new Promise((resolve, reject) => {
  if (process.platform !== 'win32') return reject(new Error('Seletor de pasta disponível apenas no Windows — digite o caminho.'));
  const ps = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.FolderBrowserDialog
$f.Description = 'Escolha a pasta onde os clipes serão salvos'
$f.ShowNewFolderButton = $true
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
if ($f.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }`;
  const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true });
  let out = '';
  p.stdout.on('data', (d) => (out += d.toString('utf8')));
  p.on('error', reject);
  p.on('close', () => resolve({ path: out.trim() || null }));
})));

app.post('/api/open-folder', wrap(() => {
  const dir = runner.state?.settings.outputDir;
  if (!dir || !fs.existsSync(dir)) throw new Error('Pasta não encontrada.');
  spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
}));

app.post('/api/estimate', wrap((req) => {
  const words = countWords(req.body.script || '');
  const minutes = words / config.wordsPerMinute;
  return { words, minutes, scenes: Math.max(words ? 1 : 0, Math.round((minutes * 60) / config.sceneSeconds)) };
}));

let planning = false;
app.post('/api/plan', wrap(async (req) => {
  if (runner.running) throw new Error('Há uma geração em andamento. Pause ou cancele antes de planejar outro vídeo.');
  if (planning) throw new Error('Já existe um planejamento em andamento.');
  planning = true;
  try {
    const s = await plan(req.body, (m) => runner.log(m));
    runner.attach(s);
    return { state: publicState() };
  } finally {
    planning = false;
  }
}));

app.put('/api/scenes', wrap((req) => {
  const s = runner.state;
  if (!s || runner.running) throw new Error('Não é possível editar agora.');
  for (const { i, prompt } of req.body.scenes || []) {
    const sc = s.scenes[i - 1];
    if (sc && sc.status !== 'done' && typeof prompt === 'string' && prompt.trim()) {
      sc.prompt = prompt.trim();
      sc.finalPrompt = composePrompt(sc.prompt, s);
    }
  }
  runner.save();
  return { state: publicState() };
}));

app.post('/api/confirm', wrap(() => {
  if (!runner.state) throw new Error('Nenhum projeto carregado.');
  runner.state.confirmedBudget = true;
  runner.state.confirmedAt = new Date().toISOString();
  runner.save();
  return { state: publicState() };
}));

app.post('/api/start', wrap(async () => { await runner.start(); return { state: publicState() }; }));
app.post('/api/pause', wrap(() => { runner.pause(); }));
app.post('/api/cancel', wrap(() => { runner.cancel(); }));
app.post('/api/retry-failed', wrap(async () => {
  if (runner.running) throw new Error('Aguarde a execução atual terminar.');
  runner.retryFailed();
  await runner.start();
}));

app.post('/api/load', wrap((req) => {
  const dir = path.resolve(String(req.body.outputDir || ''));
  const s = store.load(dir);
  if (!s) throw new Error('Nenhum project_state.json encontrado nesta pasta.');
  s.settings.outputDir = dir; // a pasta pode ter sido movida
  runner.attach(s);
  store.setLast(dir);
  return { state: publicState() };
}));

// Ao iniciar: recarrega o último projeto (se existir) para permitir retomada.
const last = store.getLast();
if (last) {
  const s = store.load(last);
  if (s) {
    try { s.settings.outputDir = last; runner.attach(s); } catch (e) { console.warn('Não foi possível carregar o último projeto:', e.message); }
  }
}

app.listen(config.port, '127.0.0.1', () => {
  console.log(`\n  Flow Video Creator AI rodando em http://localhost:${config.port}\n`);
  if (!config.falKey) console.warn('  ⚠ FAL_KEY ausente no .env');
  if (!config.openaiKey) console.warn('  ⚠ OPENAI_API_KEY ausente no .env');
});
