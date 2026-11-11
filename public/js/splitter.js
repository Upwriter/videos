// Divisão determinística do roteiro em blocos de narração de ~N segundos.
// A IA só escreve o prompt visual de cada bloco; a quantidade e a ordem das cenas saem daqui.

export function countWords(text) {
  return ((text || '').trim().match(/\S+/g) || []).length;
}

function splitSentences(text) {
  return (text || '')
    .replace(/\r/g, '')
    .split(/(?<=[.!?…:;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function breakLong(unit, maxWords) {
  if (countWords(unit) <= maxWords) return [unit];
  const out = [];
  let buf = '';
  for (const p of unit.split(/(?<=,)\s+/)) {
    const cand = buf ? `${buf} ${p}` : p;
    if (countWords(cand) > maxWords && buf) { out.push(buf); buf = p; } else buf = cand;
  }
  if (buf) out.push(buf);
  return out.flatMap((u) => {
    const w = u.split(/\s+/);
    if (w.length <= maxWords) return [u];
    const chunks = [];
    for (let i = 0; i < w.length; i += maxWords) chunks.push(w.slice(i, i + maxWords).join(' '));
    return chunks;
  });
}

export function planNarration(text, { wordsPerMinute, sceneSeconds, targetScenes, maxScenes }) {
  const words = countWords(text);
  const wordsPerScene = (wordsPerMinute * sceneSeconds) / 60;
  const naturalScenes = Math.max(1, Math.round(words / wordsPerScene));
  let n = Math.min(maxScenes, Math.max(1, targetScenes || naturalScenes));

  const units = splitSentences(text).flatMap((s) => breakLong(s, Math.max(4, Math.ceil(words / n))));
  if (!units.length) return { words, naturalScenes, scenes: [] };
  n = Math.min(n, units.length);

  // particionamento balanceado pelo "ponto médio" acumulado de cada unidade
  const target = words / n;
  const buckets = Array.from({ length: n }, () => []);
  let acc = 0;
  for (const u of units) {
    const w = countWords(u);
    buckets[Math.min(n - 1, Math.floor((acc + w / 2) / target))].push(u);
    acc += w;
  }
  return { words, naturalScenes, scenes: buckets.map((b) => b.join(' ').trim()).filter(Boolean) };
}
