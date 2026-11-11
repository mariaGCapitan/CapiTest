// Utilidades generales de la interfaz.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const LETTERS = 'ABCDE';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Identificador corto sin caracteres que se confundan (0/o, 1/l).
export function uid(n = 6) {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const r = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (const x of r) s += abc[x % abc.length];
  return s;
}

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const range = n => Array.from({ length: n }, (_, i) => i);

export const fmtNota = n => n.toFixed(2).replace('.', ',');
// Puntos sin ceros de sobra: 7 → «7», 1,5 → «1,5», 0,25 → «0,25».
export const fmtNum = n => String(Math.round((+n || 0) * 100) / 100).replace('.', ',');
// Lee un número escrito con coma o punto; NaN si no lo es.
export const parseNum = s => (String(s ?? '').trim() === '' ? NaN : Number(String(s).trim().replace(',', '.')));

export function fmtDate(ts) {
  return new Date(ts).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function safeName(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'CapiTest';
}

// Penalización: cuántos aciertos resta cada error.
export const PENALTIES = [
  { v: 0, t: 'Los errores no restan' },
  { v: 1 / 4, t: '1/4 de acierto' },
  { v: 1 / 3, t: '1/3 de acierto' },
  { v: 1 / 2, t: '1/2 acierto' },
  { v: 1, t: '1 acierto' },
];
export function penaltyText(p) {
  if (!p) return 'Los errores no restan.';
  const known = PENALTIES.find(x => Math.abs(x.v - p) < 1e-6);
  return `Cada error resta ${known ? known.t : String(+p.toFixed(3)).replace('.', ',') + ' aciertos'}. Las preguntas en blanco no restan.`;
}

let toastTimer;
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}

export const canShareFiles = () => {
  try {
    return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] }));
  } catch { return false; }
};

// Se llama directamente desde el clic: el navegador solo deja compartir en respuesta a un gesto.
export async function shareFile(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type });
  try {
    await navigator.share({ files: [file], title });
  } catch (e) {
    if (e.name !== 'AbortError') { toast('No se ha podido compartir; se descarga'); downloadFile(blob, filename); }
  }
}

export function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function readFile(file, as = 'dataURL') {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    if (as === 'arrayBuffer') r.readAsArrayBuffer(file);
    else if (as === 'text') r.readAsText(file);
    else r.readAsDataURL(file);
  });
}

export function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('No se puede abrir la imagen'));
    img.src = src;
  });
}

// Reduce la imagen de una pregunta para que el examen no ocupe demasiado.
export async function prepareImage(file, max = 1400) {
  const img = await loadImage(await readFile(file));
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const png = file.type === 'image/png';
  return { data: c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.85), w, h, fmt: png ? 'PNG' : 'JPEG' };
}
