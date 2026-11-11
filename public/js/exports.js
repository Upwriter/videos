// Exportação dos prompts (modo "apenas gerar prompts").
import { STYLES } from './styles.js';

const styleLabel = (st) => (st.style === 'personalizado' ? `Personalizado (${st.customStyle})` : STYLES[st.style]?.label || st.style);

const ts = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;

export function promptRows(s, withStyle = true) {
  const d = s.settings.sceneSeconds;
  return s.scenes.map((sc) => ({
    cena: sc.i,
    inicio: ts((sc.i - 1) * d),
    fim: ts(sc.i * d),
    arquivo: sc.file,
    narracao: sc.narration || '',
    prompt: withStyle ? sc.finalPrompt : sc.prompt,
  }));
}

function header(s) {
  const st = s.settings;
  return [
    `Projeto: ${st.folderName || 'Meus vídeos'} — ${new Date(s.createdAt).toLocaleString('pt-BR')}`,
    `Cenas: ${s.scenes.length} × ${st.sceneSeconds}s · Formato ${st.format} · Estilo ${styleLabel(st)}${st.continuity ? ' · continuidade (cada cena começa no último quadro da anterior)' : ''}`,
    s.reference?.description ? `Referência (${st.refMode}): ${s.reference.description}` : '',
    s.bible ? `Bíblia visual: ${s.bible}` : '',
  ].filter(Boolean).join('\n');
}

export function toTxt(s, withStyle) {
  const body = promptRows(s, withStyle)
    .map((r) => `Cena ${String(r.cena).padStart(2, '0')} (${r.inicio}–${r.fim}) — ${r.arquivo}\nNarração: ${r.narracao}\nPrompt: ${r.prompt}`)
    .join('\n\n');
  return `${header(s)}\n\n${'='.repeat(60)}\n\n${body}\n`;
}

/** Só os prompts, um por bloco — bom para colar em outra ferramenta. */
export function toPlain(s, withStyle) {
  return promptRows(s, withStyle).map((r) => r.prompt).join('\n\n');
}

export function toCsv(s, withStyle) {
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = promptRows(s, withStyle);
  const lines = [Object.keys(rows[0] || { cena: 0 }).join(';'), ...rows.map((r) => Object.values(r).map(q).join(';'))];
  return `﻿${lines.join('\r\n')}\r\n`; // BOM + ";" para abrir certo no Excel em português
}

export function toJson(s, withStyle) {
  return JSON.stringify({
    projeto: s.settings.folderName || 'Meus vídeos',
    criadoEm: s.createdAt,
    configuracoes: {
      formato: s.settings.format,
      estilo: styleLabel(s.settings),
      segundosPorCena: s.settings.sceneSeconds,
      continuidade: s.settings.continuity,
      modoReferencia: s.reference ? s.settings.refMode : null,
    },
    referencia: s.reference?.description || null,
    bibliaVisual: s.bible || null,
    cenas: promptRows(s, withStyle),
  }, null, 2);
}
