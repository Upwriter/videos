// ffmpeg local (ffmpeg-static) usado só para: recortar a imagem de referência no formato
// escolhido e extrair o último quadro de cada clipe (continuidade). Não monta o vídeo final.
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg: ${err.trim() || code}`))));
  });
}

async function normalizeImage(input, output, format) {
  const vertical = format === '9:16';
  const [rw, rh] = vertical ? [9, 16] : [16, 9];
  const [W, H] = vertical ? [720, 1280] : [1280, 720];
  const vf = `crop=w='min(iw,ih*${rw}/${rh})':h='min(ih,iw*${rh}/${rw})',scale=${W}:${H}`;
  await run(['-i', input, '-vf', vf, '-frames:v', '1', '-q:v', '2', output]);
}

async function extractLastFrame(video, output) {
  try {
    await run(['-sseof', '-0.25', '-i', video, '-frames:v', '1', '-q:v', '2', output]);
  } catch {
    await run(['-sseof', '-1', '-i', video, '-update', '1', '-q:v', '2', output]);
  }
}

module.exports = { normalizeImage, extractLastFrame };
