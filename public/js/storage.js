// IndexedDB (estado + handle da pasta) e File System Access API (gravar na pasta do PC).
const DB = 'meus-videos';
const STORE = 'kv';

function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export const idbGet = (k) => tx('readonly', (s) => s.get(k));
export const idbSet = (k, v) => tx('readwrite', (s) => s.put(v, k));
export const idbDel = (k) => tx('readwrite', (s) => s.delete(k));

export const fsSupported = typeof window.showDirectoryPicker === 'function';

export async function pickDirectory() {
  const h = await window.showDirectoryPicker({ id: 'meus-videos', mode: 'readwrite' });
  await idbSet('dir', h);
  return h;
}

export const getSavedDirectory = () => idbGet('dir');

/** Precisa ser chamada a partir de um clique do usuário quando a permissão ainda não foi dada. */
export async function ensurePermission(h) {
  if (!h) return false;
  const opts = { mode: 'readwrite' };
  if ((await h.queryPermission(opts)) === 'granted') return true;
  return (await h.requestPermission(opts)) === 'granted';
}

export async function hasPermission(h) {
  try { return (await h.queryPermission({ mode: 'readwrite' })) === 'granted'; } catch { return false; }
}

export async function writeFile(dir, path, data) {
  const parts = path.split('/');
  let d = dir;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  const fh = await d.getFileHandle(parts.at(-1), { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

export async function readFile(dir, path) {
  try {
    const parts = path.split('/');
    let d = dir;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
    return await (await d.getFileHandle(parts.at(-1))).getFile();
  } catch {
    return null;
  }
}

export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

export const dataUrlToBlob = (u) => fetch(u).then((r) => r.blob());
export const blobToDataUrl = (b) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(b);
});
