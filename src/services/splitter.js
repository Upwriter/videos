// Divisão determinística do roteiro em blocos de narração de ~N segundos.
// A IA de texto só escreve o prompt visual de cada bloco; quem decide QUANTAS cenas existem
// e qual trecho vai em cada uma é este módulo (evita cenas vazias/duplicadas).

function countWords(text) {
  return ((text || '').trim().match(/\S+/g) || []).length;
}

function splitSentences(text) {
  return (text || '')
    .replace(/\r/g, '')
    .split(/(?<=[.!?…:;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Quebra frases muito longas em pedaços (primeiro por vírgula, depois por palavras).
function breakLong(unit, maxWords) {
  if (countWords(unit) <= maxWords) return [unit];
  const parts = unit.split(/(?<=,)\s+/);
  const out = [];
  let buf = '';
  for (const p of parts) {
    const cand = buf ? `${buf} ${p}` : p;
    if (countWords(cand) > maxWords && buf) {
      out.push(buf);
      buf = p;
    } else buf = cand;
  }
  if (buf) out.push(buf);
  // ainda longo? corta por palavras
  return out.flatMap((u) => {
    const w = u.split(/\s+/);
    if (w.length <= maxWords) return [u];
    const chunks = [];
    for (let i = 0; i < w.length; i += maxWords) chunks.push(w.slice(i, i + maxWords).join(' '));
    return chunks;
  });
}

/**
 * @returns {{ words:number, naturalScenes:number, scenes:string[] }}
 *   scenes = narração de cada cena. Se targetScenes > unidades disponíveis, devolve menos
 *   blocos e o chamador pede à IA cenas visuais extras (ver llm.expandScenes).
 */
function planNarration(text, { wordsPerMinute, sceneSeconds, targetScenes, maxScenes }) {
  const words = countWords(text);
  const wordsPerScene = (wordsPerMinute * sceneSeconds) / 60; // ~23 palavras a 140 ppm / 10 s
  const naturalScenes = Math.max(1, Math.round(words / wordsPerScene));
  let n = Math.min(maxScenes, Math.max(1, targetScenes || naturalScenes));

  const per = words / n;
  const units = splitSentences(text).flatMap((s) => breakLong(s, Math.max(4, Math.ceil(per))));
  if (units.length === 0) return { words, naturalScenes, scenes: [] };
  n = Math.min(n, units.length);

  // Particionamento balanceado: cada unidade vai para o bloco onde cai o seu "ponto médio" acumulado.
  const target = words / n;
  const buckets = Array.from({ length: n }, () => []);
  let acc = 0;
  for (const u of units) {
    const w = countWords(u);
    const mid = acc + w / 2;
    const idx = Math.min(n - 1, Math.floor(mid / target));
    buckets[idx].push(u);
    acc += w;
  }
  const scenes = buckets.map((b) => b.join(' ').trim()).filter(Boolean);
  return { words, naturalScenes, scenes };
}

module.exports = { countWords, planNarration };
