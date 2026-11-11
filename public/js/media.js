// Processamento de imagem/vídeo no navegador (substitui o ffmpeg da versão local).

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Não foi possível ler a imagem'));
    img.src = src;
  });
}

function toJpeg(canvas, q = 0.88) {
  return canvas.toDataURL('image/jpeg', q);
}

/** Recorta no centro para o formato do vídeo e redimensiona (1280x720 ou 720x1280). */
export async function normalizeImage(src, format) {
  const img = await loadImage(src);
  const vertical = format === '9:16';
  const [W, H] = vertical ? [720, 1280] : [1280, 720];
  const target = W / H;
  let sw = img.naturalWidth;
  let sh = img.naturalHeight;
  if (sw / sh > target) sw = sh * target; else sh = sw / target;
  const sx = (img.naturalWidth - sw) / 2;
  const sy = (img.naturalHeight - sh) / 2;
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
  c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
  return toJpeg(c);
}

/** Reduz para enviar à IA de texto (descrição). */
export async function shrinkImage(src, max = 1024) {
  const img = await loadImage(src);
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = Object.assign(document.createElement('canvas'), {
    width: Math.round(img.naturalWidth * k),
    height: Math.round(img.naturalHeight * k),
  });
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return toJpeg(c, 0.85);
}

function once(el, ok, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Tempo esgotado (${ok})`)), timeoutMs);
    el.addEventListener(ok, () => { clearTimeout(t); resolve(); }, { once: true });
    el.addEventListener('error', () => { clearTimeout(t); reject(new Error('Vídeo ilegível no navegador')); }, { once: true });
  });
}

/** Último quadro de um MP4 (Blob/File) como JPEG data URL — usado na continuidade. */
export async function lastFrame(blob) {
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  try {
    v.src = url;
    await once(v, 'loadeddata');
    v.currentTime = Math.max(0, v.duration - 0.05);
    await once(v, 'seeked');
    const c = Object.assign(document.createElement('canvas'), { width: v.videoWidth, height: v.videoHeight });
    c.getContext('2d').drawImage(v, 0, 0);
    return toJpeg(c);
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}
