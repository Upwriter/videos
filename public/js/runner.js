// Executor no navegador: gera cada cena (via /api/fal), baixa o MP4 direto do CDN do fal.ai
// e grava na pasta escolhida. Estado salvo após cada passo → retomada exata.
import { api, withRetry, sleep, ApiError } from './api.js';
import { persist, recover, imageUsesReference } from './project.js';
import { writeFile, readFile, downloadBlob, ensurePermission } from './storage.js';
import { lastFrame, normalizeImage } from './media.js';

/** Imagem (Blob) → JPEG no formato do vídeo, para servir de 1º quadro da cena seguinte. */
async function frameFromImage(blob, format) {
  const url = URL.createObjectURL(blob);
  try { return await normalizeImage(url, format); } finally { URL.revokeObjectURL(url); }
}

const POLL_MS = 5000;
const SCENE_TIMEOUT_MS = 20 * 60 * 1000;

export class Runner {
  constructor({ log, onChange }) {
    this.log = log;
    this.onChange = onChange;
    this.running = false;
    this.pauseReq = false;
  }

  async save() {
    try { await persist(this.state, this.dir); } catch (e) { this.log(`Aviso: não foi possível salvar o estado (${e.message}).`); }
    this.onChange(this.state);
  }

  set(sc, status) {
    sc.status = status;
    return this.save();
  }

  /** dir = handle da pasta (File System Access) ou null → baixa pelo navegador (pasta Downloads). */
  async start(state, dir) {
    if (this.running) throw new Error('Já está em execução.');
    if (!state.confirmedBudget) throw new Error('Confirme o orçamento antes de gerar.');
    if (dir && !(await ensurePermission(dir))) throw new Error('Permissão para gravar na pasta negada.');
    this.state = await recover(state, dir);
    this.dir = dir;
    this.running = true;
    this.pauseReq = false;
    this.cancelReq = false;
    this.abort = new AbortController();
    await this.wake(true);
    state.status = 'running';
    await this.save();
    this.log(`Iniciando/retomando geração (${state.budget.pendingScenes} cenas pendentes).`);

    try {
      for (const sc of state.scenes) {
        if (sc.status === 'done') continue;
        if (this.cancelReq) { state.status = 'cancelled'; break; }
        if (this.pauseReq) { state.status = 'paused'; break; }
        state.currentIndex = sc.i;
        await this.runScene(sc);
      }
      if (state.status === 'running') {
        state.status = state.scenes.some((x) => x.status === 'error') ? 'completed_with_errors' : 'completed';
        this.log(state.status === 'completed' ? 'Todas as cenas foram geradas!' : 'Finalizado com cenas em erro — use "Tentar novamente".');
      } else {
        this.log(state.status === 'paused' ? 'Geração pausada.' : 'Geração cancelada (o progresso foi salvo).');
      }
    } catch (e) {
      state.status = 'error';
      this.log(`Erro inesperado: ${e.message}`);
    } finally {
      state.currentIndex = null;
      this.running = false;
      await this.wake(false);
      await this.save();
    }
  }

  pause() {
    if (!this.running) return;
    this.pauseReq = true;
    this.log('Pausa solicitada — a cena atual termina e a execução para.');
    this.onChange(this.state);
  }

  cancel() {
    if (!this.running) return;
    this.cancelReq = true;
    this.abort.abort();
    this.log('Cancelando…');
  }

  async wake(on) {
    try {
      if (on && 'wakeLock' in navigator) {
        this.lock = await navigator.wakeLock.request('screen');
        this.relock ??= () => { if (this.running && document.visibilityState === 'visible') this.wake(true); };
        document.addEventListener('visibilitychange', this.relock);
      } else if (!on) {
        await this.lock?.release();
        this.lock = null;
        document.removeEventListener('visibilitychange', this.relock);
      }
    } catch { /* wake lock é opcional */ }
  }

  async buildInput(sc) {
    const s = this.state;
    if (sc.media === 'image') {
      // imagem estática: com referência de personagem/produto/cenário → FLUX Kontext; senão FLUX 2 Flex
      if (imageUsesReference(s) && s.reference?.dataUrl) {
        return { kind: 'i2i', input: { prompt: sc.finalPrompt, image_url: s.reference.dataUrl, aspect_ratio: s.settings.format }, source: 'imagem de referência' };
      }
      return { kind: 't2i', input: { prompt: sc.finalPrompt, aspect_ratio: s.settings.format }, source: 'texto' };
    }
    const input = { prompt: sc.finalPrompt, duration: s.settings.sceneSeconds };
    let image = null;
    let source = 'texto';
    if (s.settings.continuity && sc.i > 1) {
      const prev = s.scenes[sc.i - 2];
      if (prev.status === 'done') {
        if (s.lastFrame?.i === prev.i) image = s.lastFrame.dataUrl;
        else if (this.dir) {
          const f = await readFile(this.dir, prev.file);
          if (f) image = await (prev.media === 'image' ? frameFromImage(f, s.settings.format) : lastFrame(f)).catch(() => null);
        }
        if (image) source = prev.media === 'image' ? `imagem da cena ${prev.i}` : `último quadro da cena ${prev.i}`;
      }
    }
    const useRefFirst = s.settings.refMode !== 'geral' || s.settings.generationMode === 'imagem';
    if (!image && sc.i === 1 && s.reference?.dataUrl && useRefFirst) {
      image = s.reference.dataUrl;
      source = 'imagem de referência';
    }
    if (image) return { kind: 'i2v', input: { ...input, image_url: image }, source };
    return { kind: 't2v', input: { ...input, aspect_ratio: s.settings.format }, source };
  }

  /** Aguarda o job no fal.ai; erro com jobFailed=true significa "reenviar". */
  async waitResult(sc, signal) {
    const started = Date.now();
    let last;
    while (true) {
      if (Date.now() - started > SCENE_TIMEOUT_MS) throw Object.assign(new Error('Tempo limite aguardando o fal.ai'), { jobFailed: true });
      const st = await withRetry(() => api('/api/fal', { action: 'status', statusUrl: sc.statusUrl }, { signal }), { signal, retries: 5 });
      const label = st.status === 'IN_QUEUE' ? `na fila${st.queuePosition != null ? ` (posição ${st.queuePosition})` : ''}` : st.status === 'IN_PROGRESS' ? 'gerando' : st.status;
      if (label !== last) { last = label; sc.falStatus = label; this.onChange(this.state); }
      if (st.status === 'COMPLETED') break;
      await sleep(sc.media === 'image' ? 2500 : POLL_MS, signal);
    }
    const r = await api('/api/fal', { action: 'result', responseUrl: sc.responseUrl }, { signal });
    return r.url || r.videoUrl;
  }

  async runScene(sc) {
    const s = this.state;
    const total = s.scenes.length;
    const { signal } = this.abort;
    sc.error = null;
    try {
      await withRetry(async (attempt) => {
        sc.attempts = (sc.attempts || 0) + 1;
        if (!sc.videoUrl) {
          if (!sc.responseUrl) {
            const { kind, input, source } = await this.buildInput(sc);
            this.log(`Cena ${sc.i}/${total}: enviando ao fal.ai (${source})${attempt > 1 ? ` — tentativa ${attempt}` : ''}.`);
            await this.set(sc, 'submitted');
            Object.assign(sc, await api('/api/fal', { action: 'submit', kind, input }, { signal }));
          } else {
            this.log(`Cena ${sc.i}/${total}: retomando job já enviado (${sc.requestId}).`);
          }
          await this.set(sc, 'generating');
          try {
            sc.videoUrl = await this.waitResult(sc, signal);
          } catch (e) {
            if (e.jobFailed || e.data?.jobFailed) {
              Object.assign(sc, { requestId: null, statusUrl: null, responseUrl: null }); // próxima tentativa reenvia
              throw new Error(e.message);
            }
            throw e;
          }
        }
        await this.set(sc, 'downloading');
        this.log(`Cena ${sc.i}/${total}: baixando ${sc.file}…`);
        let blob;
        try {
          const res = await fetch(sc.videoUrl, { signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          blob = await res.blob();
          if (blob.size < 1000) throw new Error('arquivo vazio');
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          sc.videoUrl = null; // URL pode ter expirado → busca o resultado de novo
          throw new Error(`Falha no download: ${e.message}`);
        }
        if (sc.media === 'image') {
          const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
          sc.file = sc.file.replace(/\.\w+$/, `.${ext}`);
        }
        if (this.dir) await writeFile(this.dir, sc.file, blob);
        else downloadBlob(blob, sc.file);
        if (s.settings.continuity) {
          try {
            const dataUrl = sc.media === 'image' ? await frameFromImage(blob, s.settings.format) : await lastFrame(blob);
            s.lastFrame = { i: sc.i, dataUrl };
          } catch (e) {
            this.log(`Aviso: não foi possível extrair o último quadro da cena ${sc.i} (${e.message}).`);
          }
        }
        sc.status = 'done';
        sc.sizeBytes = blob.size;
        sc.finishedAt = new Date().toISOString();
        this.log(`Cena ${sc.i}/${total}: concluída (${(blob.size / 1048576).toFixed(1)} MB).`);
      }, {
        signal,
        isRetryable: (e) => !(e instanceof ApiError) || e.retryable || e.status === 0,
        onRetry: (e, n, d) => this.log(`Cena ${sc.i}: falha (${e.message}). Nova tentativa em ${Math.round(d / 1000)}s…`),
      });
    } catch (e) {
      if (this.cancelReq || signal.aborted) {
        sc.status = sc.responseUrl ? 'generating' : 'pending';
      } else {
        sc.status = 'error';
        sc.error = e.message;
        this.log(`Cena ${sc.i}: ERRO — ${e.message}`);
      }
    }
    sc.falStatus = null;
    await this.save();
  }
}
