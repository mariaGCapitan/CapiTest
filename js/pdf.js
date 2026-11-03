// Versiones barajadas y PDF con el examen de cada alumno o alumna y su hoja de respuestas.

import { SHEET, bubbleLayout } from './layout.js';
import { uid, shuffle, range, LETTERS, penaltyText } from './util.js';
import { nopt as examNopt } from './grading.js';

const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

// Reutiliza las versiones ya impresas si las preguntas no han cambiado;
// si cambian, crea una tanda nueva y las hojas antiguas dejan de valer.
export function buildPrint(exam, group, reserves) {
  const qids = exam.questions.map(q => q.id);
  const nopt = examNopt(exam);
  const prev = exam.printed;
  const nopts = Object.fromEntries(exam.questions.map(q => [q.id, q.options.length]));
  const reusable = prev && prev.nopt === nopt && sameSet(prev.qids, qids)
    && qids.every(id => prev.nopts?.[id] === nopts[id]);
  const batch = reusable ? prev.batch : uid(4);
  const sheets = reusable ? { ...prev.sheets } : {};
  const make = (sheetId, studentId) => {
    if (sheets[sheetId]) return;
    const order = exam.shuffleQ ? shuffle(qids) : qids.slice();
    const perm = {};
    for (const q of exam.questions) perm[q.id] = exam.shuffleO ? shuffleOptions(q) : range(q.options.length);
    sheets[sheetId] = { sheetId, studentId, order, perm };
  };
  for (const s of group?.students || []) make(s.id, s.id);
  for (let i = 1; i <= reserves; i++) make('R' + i, null);
  return { at: Date.now(), batch, nopt, qids, nopts, sheets, reserves, changed: !!prev && !reusable };
}

// Verdadero/Falso no se baraja, y «Ninguna/Todas las anteriores» se quedan en su sitio.
const FIXED = /^(ninguna|todas|ambas|ninguno|todos)\b.*\b(anteriores|correctas|incorrectas)\b|^(ninguna|todas) (es|son) (correctas?|v[áa]lidas?)/i;
function shuffleOptions(q) {
  const idx = range(q.options.length);
  const texts = q.options.map(o => o.text.trim().toLowerCase());
  if (texts.length === 2 && texts.includes('verdadero') && texts.includes('falso')) return [texts.indexOf('verdadero'), texts.indexOf('falso')];
  const fixed = idx.filter(i => FIXED.test(texts[i]));
  const free = shuffle(idx.filter(i => !fixed.includes(i)));
  return idx.map(i => (fixed.includes(i) ? i : free.shift()));
}

export const qrText =(exam, sheetId) => `CT1|${exam.id}|${exam.printed.batch}|${sheetId}`;

export function parseQR(text) {
  const m = /^CT1\|([^|]+)\|([^|]+)\|([^|]+)$/.exec(text || '');
  return m ? { examId: m[1], batch: m[2], sheetId: m[3] } : null;
}

/* ---------- Texto compatible con las fuentes del PDF ---------- */

const MAP = {
  '‘': "'", '’': "'", '‚': "'", '“': '"', '”': '"', '„': '"',
  '–': '-', '—': '-', '−': '-', '…': '...', '•': '·', '€': 'EUR',
  '→': '->', '←': '<-', '⇒': '=>', '≤': '<=', '≥': '>=', '≠': '!=',
  ' ': ' ', '​': '', '\t': '    ',
};
export const pdfText = s => String(s ?? '')
  .replace(/[‘’‚“”„–—−…•€→←⇒≤≥≠ ​\t]/g, c => MAP[c])
  .replace(/[^\n\x20-\x7E\xA1-\xFF]/g, '?');

/* ---------- PDF ---------- */

const PT = 0.3528; // mm por punto
const M = { left: 20, right: 190, top: 22, bottom: 280 };

export function examPDF(exam, group, settings, { duplex }) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  doc.deletePage(1);
  const people = (group?.students || []).map(s => ({ sheetId: s.id, name: s.name }));
  for (let i = 1; i <= (exam.printed.reserves || 0); i++) people.push({ sheetId: 'R' + i, name: null });

  for (const p of people) {
    const v = exam.printed.sheets[p.sheetId];
    const label = p.name || `Hoja de reserva ${p.sheetId}`;
    doc.addPage();
    drawAnswerSheet(doc, exam, settings, v, p);
    if (duplex) doc.addPage();
    const before = doc.getNumberOfPages();
    drawQuestions(doc, exam, v, label);
    const qPages = doc.getNumberOfPages() - before + 1;
    if (duplex && qPages % 2) doc.addPage();
  }
  return doc.output('blob');
}

function drawAnswerSheet(doc, exam, settings, v, person) {
  const nopt = exam.printed.nopt;
  doc.setFillColor(0, 0, 0);
  for (const [x, y] of SHEET.marks) doc.rect(x, y, SHEET.markSize, SHEET.markSize, 'F');

  const L = 24, W = SHEET.qr.x - L - 6;
  let y = 30;
  doc.setTextColor(110);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(pdfText([settings.centro, settings.profesor].filter(Boolean).join(' · ') || 'CapiTest'), L, 24, { maxWidth: W });
  doc.setTextColor(0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  const title = doc.splitTextToSize(pdfText(exam.title), W).slice(0, 2);
  doc.text(title, L, y);
  y += title.length * 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(pdfText(exam.module || ''), L, y, { maxWidth: W });
  y += 9;
  doc.setFontSize(10);
  doc.text('Alumno/a:', L, y);
  if (person.name) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text(pdfText(person.name), L + 19, y, { maxWidth: W - 19 });
  } else {
    doc.setDrawColor(120);
    doc.setLineWidth(0.2);
    doc.line(L + 19, y + 1, L + W, y + 1);
    doc.setFontSize(8);
    doc.setTextColor(110);
    doc.text(`Hoja de reserva ${person.sheetId}`, L, y + 6);
    doc.setTextColor(0);
  }
  drawQR(doc, qrText(exam, person.sheetId), SHEET.qr.x, SHEET.qr.y, SHEET.qr.size);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(60);
  const inst = 'Rellena por completo el círculo de la respuesta elegida con bolígrafo negro o azul oscuro. '
    + 'Marca una sola respuesta por pregunta; si marcas dos, la pregunta cuenta como en blanco. '
    + 'Si te equivocas, pide otra hoja. No dobles la hoja ni escribas cerca de los cuadrados negros. '
    + penaltyText(exam.penalty);
  doc.text(doc.splitTextToSize(pdfText(inst), 166), L, 62);
  doc.setTextColor(0);

  const lay = bubbleLayout(exam.printed.qids.length, nopt);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  for (const x of lay.colX) {
    for (let j = 0; j < nopt; j++) {
      doc.text(LETTERS[j], x + SHEET.numW + j * SHEET.optW + SHEET.optW / 2, SHEET.grid.top - 2.2, { align: 'center' });
    }
  }
  doc.setFontSize(9);
  doc.setLineWidth(0.25);
  doc.setDrawColor(70);
  lay.items.forEach((it, i) => {
    const qid = v.order[i];
    const count = v.perm[qid].length;
    doc.setFont('helvetica', 'bold');
    doc.text(String(it.n), it.x + SHEET.numW - 2.5, it.y + 1.1, { align: 'right' });
    it.opts.forEach((o, j) => {
      if (j < count) doc.circle(o.x, o.y, SHEET.r, 'S');
    });
    if (it.n % 5 === 0 && it.n !== lay.items.length && (i + 1) % lay.rows !== 0) {
      doc.setDrawColor(200);
      doc.line(it.x + 2, it.y + SHEET.rowH / 2, it.x + SHEET.numW + nopt * SHEET.optW, it.y + SHEET.rowH / 2);
      doc.setDrawColor(70);
    }
  });
}

function drawQR(doc, text, x, y, size) {
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const c = size / n;
  doc.setFillColor(0, 0, 0);
  for (let r = 0; r < n; r++) {
    let run = -1;
    for (let col = 0; col <= n; col++) {
      const dark = col < n && qr.isDark(r, col);
      if (dark && run < 0) run = col;
      if (!dark && run >= 0) {
        doc.rect(x + run * c, y + r * c, (col - run) * c + 0.02, c + 0.02, 'F');
        run = -1;
      }
    }
  }
}

function drawQuestions(doc, exam, v, label) {
  let page = 1;
  const header = () => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(110);
    doc.text(pdfText(`${exam.title} · ${label}`), M.left, 12, { maxWidth: 140 });
    doc.text(`Página ${page}`, M.right, 12, { align: 'right' });
    doc.setTextColor(0);
  };
  doc.addPage();
  header();
  let y = M.top;
  v.order.forEach((qid, i) => {
    const q = exam.questions.find(x => x.id === qid);
    if (!q) return;
    const h = renderQuestion(doc, q, i + 1, v.perm[qid], M.left, 0, false);
    if (y + h > M.bottom && y > M.top) {
      doc.addPage();
      page++;
      header();
      y = M.top;
    }
    y += renderQuestion(doc, q, i + 1, v.perm[qid], M.left, y, true) + 5;
  });
}

// Mide (draw = false) o dibuja una pregunta; devuelve su altura en mm.
function renderQuestion(doc, q, num, perm, x, y0, draw) {
  const W = M.right - x;
  const indent = 8;
  let y = y0;
  const fs = 10.5, lh = fs * PT * 1.25;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(fs);
  if (draw) doc.text(`${num}.`, x, y + lh * 0.8);
  doc.setFont('helvetica', 'normal');
  if (q.text) {
    const lines = doc.splitTextToSize(pdfText(q.text), W - indent);
    if (draw) doc.text(lines, x + indent, y + lh * 0.8, { lineHeightFactor: 1.25 });
    y += lines.length * lh + 1.5;
  }
  if (q.code) y += codeBlock(doc, q.code, x + indent, y, W - indent, draw) + 2;
  if (q.image) {
    const maxW = Math.min(W - indent, 130), maxH = 75;
    const s = Math.min(maxW / q.image.w, maxH / q.image.h);
    const iw = q.image.w * s, ih = q.image.h * s;
    if (draw) doc.addImage(q.image.data, q.image.fmt, x + indent, y, iw, ih, 'img_' + q.id, 'FAST');
    y += ih + 2.5;
  }
  if (!q.text && !q.code && !q.image) y += lh;
  perm.forEach((orig, j) => {
    const opt = q.options[orig];
    const lt = `${LETTERS[j]})`;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    if (draw) doc.text(lt, x + indent, y + 4);
    if (q.optsCode) {
      y += codeLines(doc, opt.text, x + indent + 7, y, W - indent - 7, draw, false) + 1.2;
    } else {
      doc.setFont('helvetica', 'normal');
      const lines = doc.splitTextToSize(pdfText(opt.text), W - indent - 7);
      if (draw) doc.text(lines, x + indent + 7, y + 4, { lineHeightFactor: 1.2 });
      y += lines.length * 10 * PT * 1.2 + 1.2;
    }
  });
  return y - y0;
}

const CODE_FS = 9;
function wrapCode(doc, code, width) {
  const charW = CODE_FS * 0.6 * PT;
  const per = Math.max(10, Math.floor(width / charW));
  const out = [];
  for (const line of pdfText(code).split('\n')) {
    if (line.length <= per) { out.push(line); continue; }
    for (let i = 0; i < line.length; i += per) out.push(line.slice(i, i + per));
  }
  return out;
}

function codeLines(doc, code, x, y, width, draw, box) {
  const lines = wrapCode(doc, code, width - (box ? 5 : 0));
  const lh = CODE_FS * PT * 1.25;
  const h = lines.length * lh + (box ? 4 : 0.8);
  if (draw) {
    if (box) {
      doc.setFillColor(242, 243, 246);
      doc.setDrawColor(215);
      doc.setLineWidth(0.2);
      doc.rect(x, y, width, h, 'FD');
    }
    doc.setFont('courier', 'normal');
    doc.setFontSize(CODE_FS);
    lines.forEach((l, i) => doc.text(l, x + (box ? 2.5 : 0), y + (box ? 2 : 0) + lh * (i + 0.8)));
  }
  return h;
}

const codeBlock = (doc, code, x, y, width, draw) => codeLines(doc, code, x, y, width, draw, true);
