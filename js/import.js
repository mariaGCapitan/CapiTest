// Importación del examen base desde Moodle XML o GIFT.
// Cada pregunta queda como { text, code, image, options: [{ text }], correct, optsCode }.

import { uid, loadImage } from './util.js';

export const MAX_OPTS = 5;

export async function importExamFile(file) {
  const raw = await file.text();
  const isXml = /^\s*(<\?xml|<quiz)/i.test(raw) || /\.xml$/i.test(file.name);
  const res = isXml ? await parseMoodleXML(raw) : await parseGIFT(raw);
  return res;
}

/* ---------- Moodle XML ---------- */

async function parseMoodleXML(raw) {
  const doc = new DOMParser().parseFromString(raw, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('El archivo XML está dañado o no es de Moodle.');
  const questions = [], warnings = [];
  let category = '';
  let n = 0;
  for (const qn of doc.querySelectorAll('quiz > question')) {
    const type = qn.getAttribute('type');
    if (type === 'category') {
      category = (child(qn, 'category')?.querySelector('text')?.textContent || '').split('/').pop().replace(/^\$course\$|^\$system\$/, '').trim();
      continue;
    }
    n++;
    const name = child(qn, 'name')?.querySelector('text')?.textContent?.trim() || `Pregunta ${n}`;
    if (type !== 'multichoice' && type !== 'truefalse') {
      warnings.push(`«${name}»: es de tipo «${type}», no de opción múltiple. No se importa.`);
      continue;
    }
    const qt = child(qn, 'questiontext');
    const files = filesOf(qt);
    const parts = await htmlToParts(qt?.querySelector('text')?.textContent || '', files);
    if (parts.extraImages) warnings.push(`«${name}»: tiene varias imágenes; solo se usa la primera.`);
    if (parts.missingImage) warnings.push(`«${name}»: una imagen no viene dentro del archivo; no se importa.`);

    const answers = [];
    for (const a of qn.querySelectorAll(':scope > answer')) {
      const ap = await htmlToParts(a.querySelector('text')?.textContent || '', filesOf(a));
      if (ap.image) warnings.push(`«${name}»: las imágenes en las respuestas no se imprimen.`);
      answers.push({ text: ap.code ? ap.code : ap.text, isCode: !!ap.code || ap.allCode, fraction: parseFloat(a.getAttribute('fraction') || '0') });
    }
    if (type === 'truefalse') {
      for (const a of answers) {
        const t = a.text.trim().toLowerCase();
        if (t === 'true') a.text = 'Verdadero';
        if (t === 'false') a.text = 'Falso';
      }
    } else if (child(qn, 'single')?.textContent.trim() === 'false') {
      warnings.push(`«${name}»: en Moodle admite varias respuestas; aquí solo cuenta como correcta la de más valor.`);
    }
    const q = buildQuestion(name, parts, answers, warnings);
    if (q) questions.push(q);
  }
  return { questions, warnings, title: category };
}

const child = (el, tag) => el ? [...el.children].find(c => c.tagName === tag) : null;

function filesOf(el) {
  const map = {};
  if (!el) return map;
  for (const f of el.querySelectorAll(':scope > file')) {
    const name = f.getAttribute('name');
    const ext = (name.split('.').pop() || '').toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[ext];
    if (mime) map[name] = `data:${mime};base64,${f.textContent.replace(/\s+/g, '')}`;
  }
  return map;
}

/* ---------- GIFT ---------- */

async function parseGIFT(raw) {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n').filter(l => !/^\s*\/\//.test(l));
  // Bloques separados por líneas en blanco, uniendo los que dejen llaves sin cerrar.
  const blocks = [];
  let cur = [];
  const flush = () => { if (cur.join('').trim()) blocks.push(cur.join('\n')); cur = []; };
  for (const l of lines) {
    if (!l.trim() && balance(cur.join('\n')) === 0) flush();
    else cur.push(l);
  }
  flush();

  const questions = [], warnings = [];
  let title = '';
  let n = 0;
  for (let b of blocks) {
    const cat = b.match(/^\s*\$CATEGORY:\s*(.*)$/m);
    if (cat) {
      title = cat[1].split('/').pop().replace(/^\$course\$|^\$system\$/, '').trim();
      b = b.replace(/^\s*\$CATEGORY:.*$/m, '');
      if (!b.trim()) continue;
    }
    n++;
    let name = `Pregunta ${n}`;
    const tm = b.match(/^\s*::((?:\\.|[^:])*)::/);
    if (tm) { name = unescapeGift(tm[1]).trim() || name; b = b.slice(tm[0].length); }
    const open = findUnescaped(b, '{');
    const close = open >= 0 ? findUnescaped(b, '}', open + 1) : -1;
    if (open < 0 || close < 0) {
      warnings.push(`«${name}»: no tiene respuestas entre llaves. No se importa.`);
      continue;
    }
    let pre = b.slice(0, open), post = b.slice(close + 1);
    const ans = b.slice(open + 1, close).trim();

    let format = 'moodle';
    const fm = pre.match(/^\s*\[(html|markdown|plain|moodle)\]/i);
    if (fm) { format = fm[1].toLowerCase(); pre = pre.slice(fm[0].length); }
    let body = pre.trimEnd();
    if (post.trim()) body = `${body} _____ ${post.trim()}`;
    body = unescapeGift(body).trim();

    let answers;
    if (/^(T|TRUE|F|FALSE)\b/i.test(ans)) {
      const isTrue = /^T/i.test(ans);
      answers = [{ text: 'Verdadero', fraction: isTrue ? 100 : 0 }, { text: 'Falso', fraction: isTrue ? 0 : 100 }];
    } else if (ans.startsWith('#')) {
      warnings.push(`«${name}»: es numérica. No se importa.`); continue;
    } else if (!ans) {
      warnings.push(`«${name}»: es de ensayo. No se importa.`); continue;
    } else {
      const items = splitAnswers(ans);
      if (items.some(a => a.text.includes('->'))) { warnings.push(`«${name}»: es de emparejar. No se importa.`); continue; }
      if (!items.some(a => a.wrong)) { warnings.push(`«${name}»: es de respuesta corta. No se importa.`); continue; }
      answers = items.map(a => ({ text: a.text, fraction: a.fraction }));
      if (answers.filter(a => a.fraction > 0).length > 1) warnings.push(`«${name}»: tiene varias respuestas con valor; solo cuenta como correcta la de más valor.`);
    }

    let parts;
    if (format === 'html') parts = await htmlToParts(body, {});
    else if (format === 'markdown') parts = markdownToParts(body);
    else parts = { text: body, code: '', image: null };
    if (parts.missingImage) warnings.push(`«${name}»: las imágenes de GIFT no viajan en el archivo; no se importa la imagen.`);

    const fixed = answers.map(a => {
      const t = format === 'html' ? htmlText(a.text) : a.text;
      const code = format === 'markdown' ? t.match(/^`([^`]*)`$/) : null;
      return { text: code ? code[1] : t, isCode: !!code, fraction: a.fraction };
    });
    const q = buildQuestion(name, parts, fixed, warnings);
    if (q) questions.push(q);
  }
  return { questions, warnings, title };
}

function balance(s) {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '{') d++;
    else if (s[i] === '}') d--;
  }
  return d;
}

function findUnescaped(s, ch, from = 0) {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === ch) return i;
  }
  return -1;
}

function unescapeGift(s) {
  return s.replace(/\\n/g, '\n').replace(/\\([:~=#{}\\])/g, '$1');
}

// Separa «=correcta ~incorrecta ~%50%parcial #comentario».
function splitAnswers(s) {
  const out = [];
  let cur = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { if (cur) cur.raw += c + (s[i + 1] ?? ''); i++; continue; }
    if (c === '=' || c === '~') {
      if (cur) out.push(cur);
      cur = { raw: '', wrong: c === '~' };
      continue;
    }
    if (cur) cur.raw += c;
  }
  if (cur) out.push(cur);
  return out.map(a => {
    let t = a.raw;
    const fb = findUnescaped(t, '#');
    if (fb >= 0) t = t.slice(0, fb);
    let fraction = a.wrong ? 0 : 100;
    const w = t.match(/^\s*%(-?[\d.]+)%/);
    if (w) { fraction = parseFloat(w[1]); t = t.slice(w[0].length); }
    return { text: unescapeGift(t).trim(), fraction, wrong: a.wrong };
  });
}

/* ---------- Texto, código e imagen ---------- */

const htmlText = html => {
  const d = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  return d.body.textContent.replace(/ /g, ' ').trim();
};

// Saca del HTML de Moodle el texto, los bloques <pre> como código y la primera imagen.
async function htmlToParts(html, files) {
  const d = new DOMParser().parseFromString(`<div id="r">${html}</div>`, 'text/html');
  const root = d.getElementById('r');
  const text = [], code = [];
  let image = null, extraImages = false, missingImage = false;
  const imgs = [...root.querySelectorAll('img')];
  for (const img of imgs) {
    const src = decodeURIComponent((img.getAttribute('src') || '').replace('@@PLUGINFILE@@/', ''));
    const data = files[src] || (src.startsWith('data:') ? src : null);
    if (!data) { missingImage = true; continue; }
    if (image) { extraImages = true; continue; }
    image = data;
  }
  imgs.forEach(i => i.remove());
  for (const pre of root.querySelectorAll('pre')) {
    code.push(pre.textContent.replace(/\n$/, ''));
    pre.remove();
  }
  const onlyCode = root.children.length === 1 && root.firstElementChild.tagName === 'CODE' && !root.textContent.replace(root.firstElementChild.textContent, '').trim();
  root.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  root.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, tr').forEach(el => el.append('\n'));
  root.querySelectorAll('li').forEach(el => el.prepend('• '));
  const plain = root.textContent.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (plain) text.push(plain);
  return {
    text: text.join('\n'),
    code: code.join('\n\n'),
    image: image ? await toPrintable(image) : null,
    extraImages, missingImage, allCode: onlyCode,
  };
}

function markdownToParts(md) {
  const code = [];
  let text = md.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, c) => { code.push(c.replace(/\n$/, '')); return ''; });
  const missingImage = /!\[[^\]]*\]\([^)]+\)/.test(text);
  text = text.replace(/!\[[^\]]*\]\([^)]+\)/g, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), code: code.join('\n\n'), image: null, missingImage };
}

// Pasa cualquier imagen (GIF, SVG, WebP…) a PNG o JPEG reducido, que es lo que admite el PDF.
async function toPrintable(dataUrl) {
  try {
    const img = await loadImage(dataUrl);
    const max = 1400;
    const w0 = img.naturalWidth || 800, h0 = img.naturalHeight || 600;
    const s = Math.min(1, max / Math.max(w0, h0));
    const w = Math.round(w0 * s), h = Math.round(h0 * s);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const jpg = dataUrl.startsWith('data:image/jpeg');
    return { data: c.toDataURL(jpg ? 'image/jpeg' : 'image/png', 0.85), w, h, fmt: jpg ? 'JPEG' : 'PNG' };
  } catch {
    return null;
  }
}

function buildQuestion(name, parts, answers, warnings) {
  if (answers.length < 2) { warnings.push(`«${name}»: tiene menos de dos respuestas. No se importa.`); return null; }
  if (answers.length > MAX_OPTS) { warnings.push(`«${name}»: tiene ${answers.length} respuestas y caben como máximo ${MAX_OPTS}. No se importa.`); return null; }
  if (!parts.text && !parts.code && !parts.image) { warnings.push(`«${name}»: no tiene enunciado. No se importa.`); return null; }
  let correct = 0;
  answers.forEach((a, i) => { if (a.fraction > answers[correct].fraction) correct = i; });
  if (!(answers[correct].fraction > 0)) { warnings.push(`«${name}»: ninguna respuesta está marcada como correcta. No se importa.`); return null; }
  return {
    id: uid(6),
    name,
    text: parts.text,
    code: parts.code || '',
    image: parts.image || null,
    options: answers.map(a => ({ text: a.text })),
    optsCode: answers.every(a => a.isCode),
    correct,
  };
}
