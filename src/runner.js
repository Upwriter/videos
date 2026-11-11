// Executor sequencial: gera cada cena no fal.ai, baixa o MP4 e salva o estado após cada passo.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const config = require('./config');
const store = require('./services/state');
const fal = require('./services/fal');
const media = require('./services/media');
const { withRetry, NonRetryableError } = require('./services/retry');
const { budget } = require('./planner');

const LABEL = {
  pending: 'aguardando', submitted: 'enviada', generating: 'gerando', downloading: 'baixando', done: 'concluída', error: 'erro',
};

class Runner extends EventEmitter {
  constructor() {
    super();
    this.state = null;
    this.running = false;
    this.logs = [];
  }

  log(msg) {
    const line = `[${new Date().toLocaleTimeString('pt-BR')}] ${msg}`;
    this.logs.push(line);
    if (this.logs.length > 300) this.logs.shift();
    try {
      if (this.state) fs.appendFileSync(path.join(this.state.settings.outputDir, '_log.txt'), `${line}\n`);
    } catch { /* ignore */ }
    this.emit('log', line);
  }

  attach(state) {
    if (this.running) throw new Error('Há uma geração em andamento. Pause ou cancele antes.');
    // execução interrompida (app fechado) → vira "pausado" para retomada
    if (['running', 'planning'].includes(state.status)) state.status = state.scenes.length ? 'paused' : 'planned';
    for (const sc of state.scenes) {
      const exists = fs.existsSync(path.join(state.settings.outputDir, sc.file));
      if (sc.status === 'done' && !exists) sc.status = 'pending';
      if (['submitted', 'downloading'].includes(sc.status)) sc.status = sc.responseUrl ? 'generating' : 'pending';
    }
    state.budget = budget(state);
    this.state = state;
    store.save(state);
    this.update();
  }

  update() {
    if (this.state) this.state.budget = budget(this.state);
    this.emit('update', this.state);
  }

  save() {
    if (!this.state) return;
    this.state.budget = budget(this.state);
    store.save(this.state);
    this.update();
  }

  async start() {
    const s = this.state;
    if (!s) throw new Error('Nenhum projeto carregado.');
    if (this.running) throw new Error('Já está em execução.');
    if (!s.confirmedBudget) throw new Error('Confirme o orçamento antes de gerar.');
    if (!config.falKey) throw new Error('FAL_KEY não configurada no arquivo .env');

    this.running = true;
    this.pauseReq = false;
    this.cancelReq = false;
    this.abort = new AbortController();
    s.status = 'running';
    this.save();
    this.log(`Iniciando/retomando geração (${s.budget.pendingScenes} cenas pendentes).`);

    (async () => {
      try {
        for (const sc of s.scenes) {
          if (sc.status === 'done') continue;
          if (this.cancelReq) { s.status = 'cancelled'; break; }
          if (this.pauseReq) { s.status = 'paused'; break; }
          s.currentIndex = sc.i;
          await this.runScene(sc);
        }
        if (s.status === 'running') {
          s.status = s.scenes.some((x) => x.status === 'error') ? 'completed_with_errors' : 'completed';
          s.currentIndex = null;
          this.log(s.status === 'completed' ? 'Todas as cenas foram geradas!' : 'Finalizado com cenas em erro — use "Tentar novamente".');
        } else {
          this.log(s.status === 'paused' ? 'Geração pausada.' : 'Geração cancelada (o progresso foi salvo).');
        }
      } catch (e) {
        s.status = 'error';
        this.log(`Erro inesperado: ${e.message}`);
      } finally {
        this.running = false;
        this.save();
      }
    })();
  }

  pause() {
    if (!this.running) return;
    this.pauseReq = true;
    this.log('Pausa solicitada — a cena atual termina e a execução para.');
    this.update();
  }

  cancel() {
    if (!this.running) {
      if (this.state && !['completed'].includes(this.state.status)) { this.state.status = 'cancelled'; this.save(); }
      return;
    }
    this.cancelReq = true;
    this.abort?.abort();
    this.log('Cancelando…');
  }

  retryFailed() {
    for (const sc of this.state?.scenes || []) {
      if (sc.status === 'error') Object.assign(sc, { status: 'pending', error: null, requestId: null, statusUrl: null, responseUrl: null, videoUrl: null });
    }
    this.save();
  }

  buildInput(sc) {
    const s = this.state;
    const dir = s.settings.outputDir;
    const input = {
      prompt: sc.finalPrompt,
      prompt_expansion_mode: config.promptExpansion,
      duration: s.settings.sceneSeconds,
      resolution: s.settings.resolution,
      enable_safety_checker: true,
    };
    let image = null;
    let source = 'texto';
    if (s.settings.continuity && sc.i > 1) {
      const prev = s.scenes[sc.i - 2];
      if (prev?.lastFrame && fs.existsSync(path.join(dir, prev.lastFrame))) {
        image = path.join(dir, prev.lastFrame);
        source = `último quadro da cena ${prev.i}`;
      }
    }
    const useRefFirst = s.settings.refMode !== 'geral' || s.settings.generationMode === 'imagem';
    if (!image && sc.i === 1 && s.reference?.file && useRefFirst) {
      image = path.join(dir, s.reference.file);
      source = 'imagem de referência';
    }
    if (image) {
      input.image_url = fal.fileToDataUri(image);
      return { model: config.falI2V, input, source };
    }
    input.aspect_ratio = s.settings.format;
    return { model: config.falT2V, input, source };
  }

  setStatus(sc, status) {
    sc.status = status;
    this.save();
  }

  async runScene(sc) {
    const s = this.state;
    const dir = s.settings.outputDir;
    const dest = path.join(dir, sc.file);
    const signal = this.abort.signal;
    const total = s.scenes.length;
    sc.error = null;

    try {
      await withRetry(async (attempt) => {
        sc.attempts = (sc.attempts || 0) + 1;
        if (!sc.videoUrl) {
          if (!sc.responseUrl) {
            const { model, input, source } = this.buildInput(sc);
            this.log(`Cena ${sc.i}/${total}: enviando ao fal.ai (${source})${attempt > 1 ? ` — tentativa ${attempt}` : ''}.`);
            this.setStatus(sc, 'submitted');
            Object.assign(sc, await fal.submit(model, input), { model });
          } else {
            this.log(`Cena ${sc.i}/${total}: retomando job já enviado (${sc.requestId}).`);
          }
          this.setStatus(sc, 'generating');
          let lastSt;
          try {
            const { videoUrl } = await fal.waitResult(sc, {
              signal,
              onStatus: (st, pos) => {
                const label = st === 'IN_QUEUE' ? `na fila${pos != null ? ` (posição ${pos})` : ''}` : st === 'IN_PROGRESS' ? 'gerando' : st;
                if (label !== lastSt) { lastSt = label; sc.falStatus = label; this.update(); }
              },
            });
            sc.videoUrl = videoUrl;
          } catch (e) {
            // job falhou no fal (não é falha de rede) → próxima tentativa reenvia
            if (e instanceof NonRetryableError || /Resposta sem vídeo|Tempo limite/.test(e.message)) {
              Object.assign(sc, { requestId: null, statusUrl: null, responseUrl: null });
              if (e instanceof NonRetryableError) throw new Error(e.message); // permite novo envio
            }
            throw e;
          }
        }
        this.setStatus(sc, 'downloading');
        this.log(`Cena ${sc.i}/${total}: baixando ${sc.file}…`);
        const size = await fal.download(sc.videoUrl, dest, { signal });
        if (s.settings.continuity) {
          const frameDir = path.join(dir, '_frames');
          fs.mkdirSync(frameDir, { recursive: true });
          const frame = path.join(frameDir, sc.file.replace('.mp4', '.jpg'));
          try {
            await media.extractLastFrame(dest, frame);
            sc.lastFrame = path.relative(dir, frame);
          } catch (e) {
            this.log(`Aviso: não foi possível extrair o último quadro da cena ${sc.i} (${e.message}).`);
          }
        }
        sc.status = 'done';
        sc.sizeBytes = size;
        sc.finishedAt = new Date().toISOString();
        this.log(`Cena ${sc.i}/${total}: concluída (${(size / 1048576).toFixed(1)} MB).`);
      }, {
        retries: config.maxRetries,
        signal,
        onRetry: (e, attempt, delay) => {
          // download falhou porque a URL expirou? força novo resultado na próxima
          if (/download/i.test(e.message)) sc.videoUrl = null;
          this.log(`Cena ${sc.i}: falha (${e.message}). Nova tentativa em ${Math.round(delay / 1000)}s…`);
        },
      });
    } catch (e) {
      if (this.cancelReq || signal.aborted) {
        sc.status = sc.responseUrl ? 'generating' : 'pending';
      } else {
        sc.status = 'error';
        sc.error = e.message;
        this.log(`Cena ${sc.i}: ERRO após ${config.maxRetries} tentativas — ${e.message}`);
      }
    }
    sc.falStatus = null;
    this.save();
  }

  labels() { return LABEL; }
}

module.exports = new Runner();
