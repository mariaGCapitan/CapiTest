// Lectura de la hoja: busca las cuatro marcas negras, calcula la perspectiva,
// lee el QR y mide cuánto está relleno cada círculo.

import { SHEET, markCenters, bubbleLayout } from './layout.js';

export const WORK = 1600; // lado mayor de la imagen con la que se trabaja

/* ---------- Imagen ---------- */

function toGray(img) {
  const { data } = img;
  const g = new Uint8ClampedArray(img.width * img.height);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  return g;
}

// Umbral adaptativo (Bradley): oscuro respecto a su entorno, así da igual la luz de la clase.
function binarize(g, w, h) {
  const s = Math.max(16, Math.round(Math.max(w, h) / 16));
  const half = s >> 1;
  const W1 = w + 1;
  const ii = new Uint32Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += g[y * w + x];
      ii[(y + 1) * W1 + x + 1] = ii[y * W1 + x + 1] + row;
    }
  }
  const b = new Uint8Array(w * h);
  const T = 0.85;
  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - half), y2 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - half), x2 = Math.min(w - 1, x + half);
      const count = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum = ii[(y2 + 1) * W1 + x2 + 1] - ii[y1 * W1 + x2 + 1] - ii[(y2 + 1) * W1 + x1] + ii[y1 * W1 + x1];
      b[y * w + x] = g[y * w + x] * count < sum * T ? 1 : 0;
    }
  }
  return b;
}

function components(b, w, h, minArea, maxArea) {
  const lab = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const out = [];
  for (let i = 0; i < w * h; i++) {
    if (!b[i] || lab[i]) continue;
    let sp = 0;
    stack[sp++] = i;
    lab[i] = 1;
    let cnt = 0, minx = w, maxx = 0, miny = h, maxy = 0, sx = 0, sy = 0;
    let minS = Infinity, maxS = -Infinity, minD = Infinity, maxD = -Infinity;
    while (sp) {
      const p = stack[--sp];
      const x = p % w, y = (p - x) / w;
      cnt++; sx += x; sy += y;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      const S = x + y, D = x - y;
      if (S < minS) minS = S; if (S > maxS) maxS = S;
      if (D < minD) minD = D; if (D > maxD) maxD = D;
      if (x > 0 && b[p - 1] && !lab[p - 1]) { lab[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && b[p + 1] && !lab[p + 1]) { lab[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && b[p - w] && !lab[p - w]) { lab[p - w] = 1; stack[sp++] = p - w; }
      if (y < h - 1 && b[p + w] && !lab[p + w]) { lab[p + w] = 1; stack[sp++] = p + w; }
    }
    if (cnt >= minArea && cnt <= maxArea) out.push({ cnt, minx, maxx, miny, maxy, minS, maxS, minD, maxD, cx: sx / cnt, cy: sy / cnt });
  }
  return out;
}

// Área del octógono que encierra la mancha (caja + caja girada 45°).
function octagonArea(c) {
  let poly = [[c.minx, c.miny], [c.maxx + 1, c.miny], [c.maxx + 1, c.maxy + 1], [c.minx, c.maxy + 1]];
  const clip = (f) => {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const fa = f(a), fb = f(b);
      if (fa >= 0) out.push(a);
      if ((fa >= 0) !== (fb >= 0)) {
        const t = fa / (fa - fb);
        out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      }
    }
    poly = out;
  };
  clip(p => p[0] + p[1] - c.minS);
  clip(p => c.maxS + 2 - (p[0] + p[1]));
  clip(p => p[0] - p[1] - (c.minD - 1));
  clip(p => c.maxD + 1 - (p[0] - p[1]));
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

// Cuadrado macizo: lleno (no es un anillo como los del QR) y no redondo como un círculo relleno.
function isSquare(c) {
  const bw = c.maxx - c.minx + 1, bh = c.maxy - c.miny + 1;
  if (bw / bh < 0.45 || bw / bh > 2.2) return false;
  const D = Math.max(bw, bh, (c.maxS - c.minS + 1) / Math.SQRT2, (c.maxD - c.minD + 1) / Math.SQRT2);
  const squareness = c.cnt / (D * D / 2);
  const solidity = c.cnt / octagonArea(c);
  return solidity > 0.7 && squareness > 0.7 && squareness < 1.38;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Elige las cuatro marcas: los cuadriláteros convexos con forma de folio, del más grande al más pequeño.
// Normalmente el primero es la hoja; si algo oscuro del fondo (un portátil, el borde de la mesa) forma otro
// más grande, analyze() prueba los siguientes hasta que el QR se lee.
function pickMarkers(cands, w, h) {
  cands.sort((a, b) => b.cnt - a.cnt);
  const C = cands.slice(0, 14);
  const found = [];
  const n = C.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) {
    const set = [C[a], C[b], C[c], C[d]];
    const areas = set.map(s => s.cnt);
    if (Math.max(...areas) / Math.min(...areas) > 3) continue;
    const cx = set.reduce((s, p) => s + p.cx, 0) / 4, cy = set.reduce((s, p) => s + p.cy, 0) / 4;
    const pts = set.map(p => [p.cx, p.cy]).sort((p, q) => Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(q[1] - cy, q[0] - cx));
    let sign = 0, convex = true;
    for (let i = 0; i < 4; i++) {
      const p = pts[i], q = pts[(i + 1) % 4], r = pts[(i + 2) % 4];
      const cr = (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
      const sg = Math.sign(cr);
      if (!sg || (sign && sg !== sign)) { convex = false; break; }
      sign = sg;
    }
    if (!convex) continue;
    const s = [0, 1, 2, 3].map(i => dist(pts[i], pts[(i + 1) % 4]));
    if (s[0] / s[2] < 0.6 || s[0] / s[2] > 1.65 || s[1] / s[3] < 0.6 || s[1] / s[3] > 1.65) continue;
    const a1 = (s[0] + s[2]) / 2, a2 = (s[1] + s[3]) / 2;
    const ratio = Math.min(a1, a2) / Math.max(a1, a2);
    if (ratio < 0.45 || ratio > 0.92) continue; // folio: 180 / 267 ≈ 0,67
    const side = Math.sqrt(areas.reduce((x, y) => x + y, 0) / 4);
    const rel = side / Math.min(a1, a2); // marca de 10 mm sobre 180 mm ≈ 0,056
    if (rel < 0.03 || rel > 0.1) continue;
    let area = 0;
    for (let i = 0; i < 4; i++) area += pts[i][0] * pts[(i + 1) % 4][1] - pts[(i + 1) % 4][0] * pts[i][1];
    area = Math.abs(area) / 2;
    if (area < w * h * 0.12) continue; // la hoja tiene que ocupar buena parte de la imagen
    found.push({ pts, area });
  }
  return found.sort((x, y) => y.area - x.area);
}

/* ---------- Perspectiva ---------- */

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Homografía que lleva milímetros de la hoja a píxeles de la imagen.
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return h && [...h, 1];
}

export const project = (H, x, y) => {
  const d = H[6] * x + H[7] * y + 1;
  return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d];
};

/* ---------- Detección ---------- */

function prepare(canvas) {
  const W = canvas.width, Hh = canvas.height;
  const s = Math.min(1, WORK / Math.max(W, Hh));
  const w = Math.round(W * s), h = Math.round(Hh * s);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  return { c, w, h, s, bin: binarize(toGray(img), w, h) };
}

// Suma de una ventana cuadrada de radio r en cada píxel (bordes recortados).
function boxSum(src, w, h, r) {
  const W1 = w + 1;
  const ii = new Int32Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      ii[(y + 1) * W1 + x + 1] = ii[y * W1 + x + 1] + row;
    }
  }
  const out = new Int32Array(w * h), area = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - r), y2 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - r), x2 = Math.min(w - 1, x + r);
      out[y * w + x] = ii[(y2 + 1) * W1 + x2 + 1] - ii[y1 * W1 + x2 + 1] - ii[(y2 + 1) * W1 + x1] + ii[y1 * W1 + x1];
      area[y * w + x] = (x2 - x1 + 1) * (y2 - y1 + 1);
    }
  }
  return { out, area };
}

// Apertura morfológica: borra rayas y trazos más finos que 2r+1 píxeles (bolígrafo, bordes,
// sombras) que se peguen a los cuadrados, y deja los cuadrados como estaban.
function removeThin(bin, w, h, r) {
  const e = boxSum(bin, w, h, r);
  const eroded = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) eroded[i] = e.out[i] === e.area[i] ? 1 : 0;
  const d = boxSum(eroded, w, h, r);
  const opened = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) opened[i] = d.out[i] > 0 ? 1 : 0;
  return opened;
}

// Posibles cuatro marcas, de la más probable a la menos. La primera es la de siempre.
function sheetCandidates(bin, w, h, max = 6) {
  const minSide = Math.max(w, h) * 0.012, maxSide = Math.max(w, h) * 0.12;
  const find = b => pickMarkers(components(b, w, h, minSide * minSide * 0.6, maxSide * maxSide * 1.2).filter(isSquare), w, h);
  const plain = find(bin);
  const clean = find(removeThin(bin, w, h, Math.max(1, Math.round(Math.max(w, h) / 300))));
  const p0 = plain[0], c0 = clean[0];
  const best = !p0 ? c0 : !c0 ? p0 : c0.area > p0.area * 1.02 ? c0 : p0;
  const out = [];
  const key = q => q.pts.map(p => p.map(Math.round).join(',')).sort().join(';');
  const seen = new Set();
  for (const q of [best, ...[...plain, ...clean].sort((x, y) => y.area - x.area)]) {
    if (!q || seen.has(key(q))) continue;
    seen.add(key(q));
    out.push(q.pts);
    if (out.length >= max) break;
  }
  return out;
}

export function findSheet(bin, w, h) {
  return sheetCandidates(bin, w, h, 1)[0] || null;
}

// Para el visor en directo: solo dice si ve la hoja y dónde.
export function quickFind(imageData) {
  const { width: w, height: h } = imageData;
  return findSheet(binarize(toGray(imageData), w, h), w, h);
}

// Análisis completo de una foto (canvas a resolución completa).
export function analyze(canvas) {
  const P = prepare(canvas);
  const all = sheetCandidates(P.bin, P.w, P.h);
  if (!all.length) return { ok: false, reason: 'No encuentro los cuatro cuadrados de las esquinas. Comprueba que se imprimieron los cuatro.' };
  const ref = markCenters(); // TL, TR, BL, BR
  const srcCtx = canvas.getContext('2d', { willReadFrequently: true });
  let fallback = null;
  // Solo con las esquinas buenas se lee el QR en su sitio: si no, se prueba con el siguiente candidato.
  for (const pts of all) for (let k = 0; k < 4; k++) {
    const TL = pts[k], TR = pts[(k + 1) % 4], BR = pts[(k + 2) % 4], BL = pts[(k + 3) % 4];
    const wid = (dist(TL, TR) + dist(BL, BR)) / 2, hei = (dist(TL, BL) + dist(TR, BR)) / 2;
    if (wid > hei) continue; // la hoja va en vertical respecto a sus marcas
    const H = homography(ref, [TL, TR, BL, BR]);
    if (!H) continue;
    const qr = readQR(srcCtx, canvas, H, 1 / P.s);
    if (!qr) continue;
    const found = { ok: true, qr: qr.data, H, ...P, corners: [TL, TR, BR, BL] };
    // Con las esquinas buenas, el QR aparece justo donde debe. Si está desplazado, alguna esquina es
    // otra cosa (un portátil, el borde de la mesa): se prueba el siguiente candidato.
    if (qr.offMm <= QR_TOLERANCE_MM) return found;
    if (!fallback || qr.offMm < fallback.offMm) fallback = { found, offMm: qr.offMm };
  }
  // Si ninguno cuadra del todo, el que menos se desvía (es lo que se hacía antes).
  if (fallback) return fallback.found;
  return { ok: false, reason: 'Veo la hoja, pero no consigo leer el código QR. Acerca un poco el móvil.' };
}

const QR_TOLERANCE_MM = 2.5;

function readQR(ctx, canvas, H, scale) {
  const m = 5, q = SHEET.qr;
  const pts = [[q.x - m, q.y - m], [q.x + q.size + m, q.y - m], [q.x - m, q.y + q.size + m], [q.x + q.size + m, q.y + q.size + m]]
    .map(([x, y]) => project(H, x, y).map(v => v * scale));
  const x0 = Math.max(0, Math.floor(Math.min(...pts.map(p => p[0]))));
  const y0 = Math.max(0, Math.floor(Math.min(...pts.map(p => p[1]))));
  const x1 = Math.min(canvas.width, Math.ceil(Math.max(...pts.map(p => p[0]))));
  const y1 = Math.min(canvas.height, Math.ceil(Math.max(...pts.map(p => p[1]))));
  if (x1 - x0 < 20 || y1 - y0 < 20) return null;
  const img = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
  const r = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
  if (!r) return null;
  // Distancia (en mm de la hoja) entre donde está el QR en la foto y donde debería estar según las esquinas.
  const want = [[q.x, q.y], [q.x + q.size, q.y], [q.x, q.y + q.size], [q.x + q.size, q.y + q.size]]
    .map(([x, y]) => project(H, x, y).map(v => v * scale));
  const L = r.location;
  const got = [L.topLeftCorner, L.topRightCorner, L.bottomLeftCorner, L.bottomRightCorner].map(c => [c.x + x0, c.y + y0]);
  const pxPerMm = dist(want[0], want[1]) / q.size;
  // El QR puede salir girado respecto a la hoja: se toma el emparejamiento de esquinas que mejor encaja.
  const rot = [[0, 1, 2, 3], [2, 0, 3, 1], [3, 2, 1, 0], [1, 3, 0, 2]];
  const off = Math.min(...rot.map(o => Math.max(...want.map((w, i) => dist(w, got[o[i]])))));
  return { data: r.data, offMm: off / pxPerMm };
}

// Relleno de cada círculo (0 a 1) para una hoja de nq preguntas y nopt opciones.
export function readBubbles(an, nq, nopt) {
  const lay = bubbleLayout(nq, nopt);
  const rin = SHEET.r * 0.62;
  const offs = [];
  for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) {
    const dx = i / 4 * rin, dy = j / 4 * rin;
    if (dx * dx + dy * dy <= rin * rin) offs.push([dx, dy]);
  }
  const fill = (o, sx, sy) => {
    let dark = 0, tot = 0;
    for (const [dx, dy] of offs) {
      const [u, v] = project(an.H, o.x + sx + dx, o.y + sy + dy);
      const xi = Math.round(u), yi = Math.round(v);
      if (xi < 0 || yi < 0 || xi >= an.w || yi >= an.h) continue;
      tot++;
      dark += an.bin[yi * an.w + xi];
    }
    return tot ? dark / tot : 0;
  };
  // Si el papel no está del todo plano, las filas pueden quedar corridas hasta unos 2 mm. Primero se mira, en
  // cada fila con una marca clara, en qué posición destaca más esa marca; después cada fila usa la posición
  // mediana de las filas de alrededor. El papel se curva poco a poco, así que eso corrige la curva; en cambio,
  // un círculo a medio rellenar no se «arregla» solo, porque su fila sigue a sus vecinas y sale dudoso.
  const shifts = [];
  for (let a = -ROW_SHIFT_STEPS; a <= ROW_SHIFT_STEPS; a++) for (let b = -ROW_SHIFT_STEPS; b <= ROW_SHIFT_STEPS; b++) {
    shifts.push([a * ROW_SHIFT_MM / ROW_SHIFT_STEPS, b * ROW_SHIFT_MM / ROW_SHIFT_STEPS]);
  }
  const sum = f => f.reduce((x, y) => x + y, 0);
  const contrast = f => 2 * Math.max(...f) - sum(f);
  const own = lay.items.map(it => {
    let best = null;
    for (const [sx, sy] of shifts) {
      const f = it.opts.map(o => fill(o, sx, sy));
      if (Math.max(...f) >= MARKED && (!best || contrast(f) > best.c)) best = { c: contrast(f), sx, sy };
    }
    return best;
  });
  const median = v => { const w = [...v].sort((x, y) => x - y); const m = w.length >> 1; return w.length % 2 ? w[m] : (w[m - 1] + w[m]) / 2; };
  return lay.items.map((it, i) => {
    const near = own.filter((x, k) => x && Math.abs(k - i) <= ROW_NEIGHBOURS);
    if (near.length < 3) return it.opts.map(o => fill(o, 0, 0));
    const sx = median(near.map(x => x.sx)), sy = median(near.map(x => x.sy));
    return it.opts.map(o => fill(o, sx, sy));
  });
}

const ROW_NEIGHBOURS = 3;
const ROW_SHIFT_MM = 2; // una hoja doblada puede llevar los círculos hasta 2 mm de su sitio
const ROW_SHIFT_STEPS = 5; // de 0,4 en 0,4 mm

export const MARKED = 0.55, DOUBT = 0.2;

// Dibuja sobre la foto lo que ha leído, para que el profesorado lo compruebe.
export function drawReading(an, nq, nopt, fills) {
  const ctx = an.c.getContext('2d');
  const lay = bubbleLayout(nq, nopt);
  const px = Math.hypot(...[0, 1].map(k => project(an.H, 10, 0)[k] - project(an.H, 0, 0)[k])) / 10;
  ctx.lineWidth = Math.max(2, px * 0.5);
  ctx.strokeStyle = '#2f9e44';
  ctx.beginPath();
  an.corners.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
  ctx.closePath();
  ctx.stroke();
  lay.items.forEach((it, i) => it.opts.forEach((o, j) => {
    const f = fills[i][j];
    if (f < DOUBT) return;
    const [u, v] = project(an.H, o.x, o.y);
    ctx.strokeStyle = f >= MARKED ? '#2f9e44' : '#f08c00';
    ctx.beginPath();
    ctx.arc(u, v, SHEET.r * px * 1.5, 0, Math.PI * 2);
    ctx.stroke();
  }));
}
