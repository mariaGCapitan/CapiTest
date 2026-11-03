import { db, askPersistence } from './db.js';
import {
  $, $$, esc, uid, toast, LETTERS, fmtNota, fmtDate, PENALTIES, penaltyText,
  canShareFiles, shareFile, downloadFile, readFile, prepareImage, safeName,
} from './util.js';
import { maxQuestions } from './layout.js';
import { importExamFile, MAX_OPTS } from './import.js';
import { buildPrint, examPDF, parseQR } from './pdf.js';
import { grade, summary, questionStats, versionFor, nopt } from './grading.js';
import { readBubbles, drawReading, MARKED, DOUBT } from './omr.js';
import { Scanner, analyzeFile } from './scan.js';
import { examExcel } from './excel.js';

const state = { groups: [], exams: [], settings: {}, scanner: null, pdf: null };

/* ---------- Datos ---------- */

async function load() {
  state.groups = await db.all('groups');
  state.exams = await db.all('exams');
  state.settings = (await db.getMeta('settings')) || {};
}
const groupById = id => state.groups.find(g => g.id === id);
const examById = id => state.exams.find(e => e.id === id);

async function saveExam(e) {
  e.updated = Date.now();
  await db.put('exams', e);
  const i = state.exams.findIndex(x => x.id === e.id);
  if (i < 0) state.exams.push(e); else state.exams[i] = e;
}
async function saveGroup(g) {
  await db.put('groups', g);
  const i = state.groups.findIndex(x => x.id === g.id);
  if (i < 0) state.groups.push(g); else state.groups[i] = g;
}

/* ---------- Estructura ---------- */

const main = () => $('#main');

function setHeader(title, back, actions = '') {
  $('#title').innerHTML = (back ? `<a class="back" href="${back}" aria-label="Volver">‹</a>` : '') + `<span>${esc(title)}</span>`;
  $('#top-actions').innerHTML = actions;
}
function setNav(name) {
  $$('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.nav === name));
}

function modal(html) {
  closeModal();
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  m.addEventListener('click', e => { if (e.target === m) closeModal(); });
  document.body.appendChild(m);
  return m.firstElementChild;
}
function closeModal() { $('.modal')?.remove(); }

function stopScanner() {
  if (state.scanner) { state.scanner.stop(); state.scanner = null; }
}

async function route() {
  stopScanner();
  closeModal();
  state.pdf = null;
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  main().innerHTML = '';
  window.scrollTo(0, 0);
  switch (parts[0]) {
    case '': case 'examenes': return viewExams();
    case 'grupos': return viewGroups();
    case 'grupo': return viewGroup(parts[1]);
    case 'examen':
      if (parts[2] === 'pregunta') return viewQuestion(parts[1], parts[3]);
      return viewExam(parts[1], parts[2] || 'preguntas');
    case 'ajustes': return viewSettings();
    default: location.hash = '#/';
  }
}

/* ---------- Exámenes ---------- */

function viewExams() {
  setHeader('Exámenes');
  setNav('examenes');
  const list = [...state.exams].sort((a, b) => (b.created || 0) - (a.created || 0));
  const mods = [...new Set(list.map(e => e.module || 'Sin módulo'))];
  let html = `<button class="btn primary block" id="new">+ Nuevo examen</button>`;
  if (!list.length) {
    html += `<p class="empty">Todavía no hay exámenes.<br>Crea uno y sube el archivo de Moodle (XML o GIFT).</p>`;
  }
  for (const m of mods) {
    html += `<h2 class="section">${esc(m)}</h2>`;
    for (const e of list.filter(x => (x.module || 'Sin módulo') === m)) {
      const g = groupById(e.groupId);
      const total = g?.students.length || 0;
      const done = Object.keys(e.results || {}).length;
      html += `<a class="card" href="#/examen/${e.id}">
        <div class="card-title">${esc(e.title)}</div>
        <div class="muted">${esc(g?.name || 'Sin grupo')} · ${e.questions.length} preguntas · ${done}/${total} corregidos</div>
      </a>`;
    }
  }
  main().innerHTML = html;
  $('#new').onclick = () => examForm(null);
}

function examForm(exam) {
  if (!state.groups.length) {
    const s = modal(`<h3>Primero, un grupo</h3>
      <p>Para imprimir un examen con el nombre de cada alumno o alumna, antes hay que crear el grupo con su lista.</p>
      <div class="row end"><button class="btn" data-close>Cancelar</button><a class="btn primary" href="#/grupos">Ir a Grupos</a></div>`);
    s.querySelector('[data-close]').onclick = closeModal;
    return;
  }
  const modules = [...new Set(state.exams.map(e => e.module).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  const e = exam || { title: '', module: modules[0] || '', groupId: state.groups[0].id, penalty: 0.25, shuffleQ: true, shuffleO: true };
  const known = PENALTIES.some(p => Math.abs(p.v - e.penalty) < 1e-6);
  const s = modal(`<h3>${exam ? 'Datos del examen' : 'Nuevo examen'}</h3>
    <form id="ef">
      <label class="field"><span>Módulo</span>
        <select name="modsel">
          ${modules.map(m => `<option ${m === e.module ? 'selected' : ''}>${esc(m)}</option>`).join('')}
          <option value="__new" ${modules.length ? '' : 'selected'}>Otro módulo…</option>
        </select>
      </label>
      <label class="field" id="modnew" ${modules.length ? 'hidden' : ''}><span>Nombre del módulo</span>
        <input type="text" name="modnew" placeholder="Por ejemplo: Python ASIR">
      </label>
      <label class="field"><span>Título del examen</span>
        <input type="text" name="title" value="${esc(e.title)}" placeholder="${exam ? '' : 'Si lo dejas vacío, se usa la categoría del archivo'}">
      </label>
      <label class="field"><span>Grupo</span>
        <select name="group">${state.groups.map(g => `<option value="${g.id}" ${g.id === e.groupId ? 'selected' : ''}>${esc(g.name)} (${g.students.length})</option>`).join('')}</select>
      </label>
      <label class="field"><span>Penalización por error</span>
        <select name="pen">
          ${PENALTIES.map(p => `<option value="${p.v}" ${Math.abs(p.v - e.penalty) < 1e-6 ? 'selected' : ''}>${p.v ? 'Resta ' + p.t : p.t}</option>`).join('')}
          <option value="custom" ${known ? '' : 'selected'}>Otra…</option>
        </select>
      </label>
      <label class="field" id="pencustom" ${known ? 'hidden' : ''}><span>¿Cuántos aciertos quita cada error?</span>
        <input type="number" name="penc" min="0" max="2" step="0.01" placeholder="Por ejemplo: 0,2" value="${known ? '' : e.penalty}">
        <span class="muted small" style="font-weight:400;margin-top:5px">0,2 = cada 5 errores se pierde un acierto · 0,5 = cada 2 errores se pierde un acierto</span>
      </label>
      <label class="check"><input type="checkbox" name="sq" ${e.shuffleQ ? 'checked' : ''}><span>Barajar el orden de las preguntas</span></label>
      <label class="check"><input type="checkbox" name="so" ${e.shuffleO ? 'checked' : ''}><span>Barajar el orden de las respuestas</span></label>
      ${exam ? '' : `<label class="field"><span>Archivo del examen (Moodle XML o GIFT)</span>
        <input type="file" name="file" accept=".xml,.gift,.txt,text/xml,text/plain"></label>`}
      <div class="row end">
        ${exam ? '<button type="button" class="btn danger" id="delexam">Borrar</button><span class="grow"></span>' : ''}
        <button type="button" class="btn" data-close>Cancelar</button>
        <button class="btn primary">${exam ? 'Guardar' : 'Crear'}</button>
      </div>
    </form>`);
  const f = s.querySelector('#ef');
  f.modsel.onchange = () => { s.querySelector('#modnew').hidden = f.modsel.value !== '__new'; };
  f.pen.onchange = () => { s.querySelector('#pencustom').hidden = f.pen.value !== 'custom'; };
  s.querySelector('[data-close]').onclick = closeModal;
  if (exam) s.querySelector('#delexam').onclick = async () => {
    if (!confirm(`¿Borrar el examen «${exam.title}» y todas sus notas? No se puede deshacer.`)) return;
    await db.del('exams', exam.id);
    state.exams = state.exams.filter(x => x.id !== exam.id);
    closeModal();
    location.hash = '#/';
  };
  f.onsubmit = async ev => {
    ev.preventDefault();
    const module = f.modsel.value === '__new' ? f.modnew.value.trim() : f.modsel.value;
    if (!module) return toast('Escribe el módulo.');
    const penalty = f.pen.value === 'custom' ? parseFloat(String(f.penc.value).replace(',', '.')) : parseFloat(f.pen.value);
    if (!(penalty >= 0)) return toast('La penalización no es válida.');
    let imported = null;
    if (!exam && f.file.files[0]) {
      try { imported = await importExamFile(f.file.files[0]); } catch (err) { return toast(err.message); }
    }
    const title = f.elements.title.value.trim() || imported?.title || '';
    if (!title) return toast('Escribe el título del examen.');
    const target = exam || { id: uid(6), created: Date.now(), questions: [], results: {}, printed: null };
    Object.assign(target, { title, module, groupId: f.group.value, penalty, shuffleQ: f.sq.checked, shuffleO: f.so.checked });
    if (imported) target.questions = imported.questions;
    await saveExam(target);
    closeModal();
    if (exam) { route(); return; }
    location.hash = `#/examen/${target.id}`;
    if (imported) setTimeout(() => importSummary(imported), 50);
  };
}

function importSummary(res) {
  const s = modal(`<h3>Examen importado</h3>
    <p><b>${res.questions.length}</b> preguntas importadas.</p>
    ${res.warnings.length ? `<div class="banner warn"><b>Avisos (${res.warnings.length})</b><ul class="small">${res.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
    <div class="row end"><button class="btn primary" data-close>Vale</button></div>`);
  s.querySelector('[data-close]').onclick = closeModal;
}

function importDialog(exam) {
  const s = modal(`<h3>Importar preguntas</h3>
    <form id="imf">
      <label class="field"><span>Archivo de Moodle (XML o GIFT)</span>
        <input type="file" name="file" accept=".xml,.gift,.txt,text/xml,text/plain" required></label>
      ${exam.questions.length ? `
      <label class="check"><input type="radio" name="mode" value="replace" checked><span>Sustituir las ${exam.questions.length} preguntas actuales</span></label>
      <label class="check"><input type="radio" name="mode" value="add"><span>Añadirlas al final</span></label>` : ''}
      <div class="row end"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary">Importar</button></div>
    </form>`);
  s.querySelector('[data-close]').onclick = closeModal;
  const f = s.querySelector('#imf');
  f.onsubmit = async ev => {
    ev.preventDefault();
    let res;
    try { res = await importExamFile(f.file.files[0]); } catch (err) { return toast(err.message); }
    if (!res.questions.length) { importSummary(res); return; }
    const add = f.mode && f.mode.value === 'add';
    exam.questions = add ? [...exam.questions, ...res.questions] : res.questions;
    await saveExam(exam);
    route();
    setTimeout(() => importSummary(res), 50);
  };
}

/* ---------- Un examen ---------- */

function printState(exam, group) {
  const p = exam.printed;
  if (!p) return 'never';
  const qids = exam.questions.map(q => q.id);
  const same = p.nopt === nopt(exam) && p.qids.length === qids.length && qids.every(id => p.qids.includes(id))
    && exam.questions.every(q => p.nopts?.[q.id] === q.options.length);
  if (!same) return 'stale';
  if ((group?.students || []).some(s => !p.sheets[s.id])) return 'partial';
  return 'ok';
}

function viewExam(id, tab) {
  const exam = examById(id);
  if (!exam) { location.hash = '#/'; return; }
  setNav('examenes');
  setHeader(exam.title, '#/', `<button class="btn small" id="edit">Datos</button>`);
  $('#edit').onclick = () => examForm(exam);
  const tabs = [['preguntas', 'Preguntas'], ['imprimir', 'Imprimir'], ['corregir', 'Corregir'], ['notas', 'Notas']];
  main().innerHTML = `<div class="seg">${tabs.map(([k, t]) => `<a href="#/examen/${id}/${k}" class="${k === tab ? 'on' : ''}">${t}</a>`).join('')}</div><div id="tab"></div>`;
  const el = $('#tab');
  ({ preguntas: tabQuestions, imprimir: tabPrint, corregir: tabScan, notas: tabGrades }[tab] || tabQuestions)(exam, el);
}

function tabQuestions(exam, el) {
  const n = exam.questions.length;
  const max = maxQuestions(nopt(exam));
  const g = groupById(exam.groupId);
  let html = `<p class="muted">${esc(exam.module)} · ${esc(g?.name || 'Sin grupo')} · ${penaltyText(exam.penalty)}</p>`;
  if (n > max) html += `<div class="banner bad">Hay ${n} preguntas y en la hoja caben ${max}. Quita alguna para poder imprimir.</div>`;
  if (exam.printed && printState(exam, g) === 'stale') html += `<div class="banner warn">Has cambiado preguntas después de imprimir. Las hojas impresas ya no valen: vuelve a generar el PDF.</div>`;
  html += `<div class="row" style="margin-bottom:12px">
    <button class="btn primary grow" id="imp">Importar de Moodle (XML o GIFT)</button>
    <a class="btn" href="#/examen/${exam.id}/pregunta/nueva">+ Una a mano</a></div>`;
  if (!n) html += `<p class="empty">Sin preguntas todavía.<br>Exporta el banco de preguntas de Moodle en formato XML o GIFT e impórtalo aquí.</p>`;
  html += exam.questions.map((q, i) => `
    <div class="card q ${q.annulled ? 'annulled' : ''}">
      <div class="num">${i + 1}</div>
      <a class="body" href="#/examen/${exam.id}/pregunta/${q.id}" style="color:inherit;text-decoration:none">
        <div class="txt">${esc(q.text || q.code)}</div>
        <span class="badge ok">✓ ${LETTERS[q.correct]}</span>
        <span class="badge">${q.options.length} opciones</span>
        ${q.code ? '<span class="badge">código</span>' : ''}${q.image ? '<span class="badge">imagen</span>' : ''}
        ${q.annulled ? '<span class="badge bad">anulada</span>' : ''}
      </a>
      <div class="tools">
        <button class="iconbtn" data-up="${i}" aria-label="Subir" ${i ? '' : 'disabled'}>▲</button>
        <button class="iconbtn" data-down="${i}" aria-label="Bajar" ${i < n - 1 ? '' : 'disabled'}>▼</button>
      </div>
    </div>`).join('');
  el.innerHTML = html;
  $('#imp').onclick = () => importDialog(exam);
  const move = async (i, d) => {
    const q = exam.questions;
    [q[i], q[i + d]] = [q[i + d], q[i]];
    await saveExam(exam);
    tabQuestions(exam, el);
  };
  $$('[data-up]', el).forEach(b => (b.onclick = () => move(+b.dataset.up, -1)));
  $$('[data-down]', el).forEach(b => (b.onclick = () => move(+b.dataset.down, 1)));
}

function viewQuestion(examId, qid) {
  const exam = examById(examId);
  if (!exam) { location.hash = '#/'; return; }
  const isNew = qid === 'nueva';
  const orig = exam.questions.find(q => q.id === qid);
  if (!isNew && !orig) { location.hash = `#/examen/${examId}`; return; }
  const q = orig ? structuredClone(orig) : { id: uid(6), text: '', code: '', image: null, options: [{ text: '' }, { text: '' }, { text: '' }, { text: '' }], correct: 0, optsCode: false };
  const num = isNew ? exam.questions.length + 1 : exam.questions.indexOf(orig) + 1;
  setNav('examenes');
  setHeader(`Pregunta ${num}`, `#/examen/${examId}/preguntas`);

  const render = () => {
    main().innerHTML = `<form id="qf">
      <label class="field"><span>Enunciado</span><textarea name="text" rows="4">${esc(q.text)}</textarea></label>
      <label class="field"><span>Código (opcional)</span><textarea name="code" class="code" rows="5" spellcheck="false" autocapitalize="off">${esc(q.code)}</textarea></label>
      <div class="field"><span class="muted small" style="font-weight:600">Imagen (opcional)</span>
        ${q.image ? `<img class="imgprev" src="${q.image.data}" alt="Imagen de la pregunta"><button type="button" class="btn small danger" id="rmimg">Quitar imagen</button>`
          : `<input type="file" accept="image/*" id="img">`}
      </div>
      <h2 class="section">Respuestas · marca la correcta</h2>
      ${q.options.map((o, i) => `<div class="opt">
          <input type="radio" name="correct" value="${i}" ${q.correct === i ? 'checked' : ''} aria-label="Correcta ${LETTERS[i]}">
          <span class="letter">${LETTERS[i]}</span>
          <textarea name="opt${i}" rows="1" class="${q.optsCode ? 'code' : ''}">${esc(o.text)}</textarea>
          ${q.options.length > 2 ? `<button type="button" class="iconbtn" data-rm="${i}" aria-label="Quitar">✕</button>` : ''}
        </div>`).join('')}
      ${q.options.length < MAX_OPTS ? '<button type="button" class="btn small" id="addopt">+ Respuesta</button>' : ''}
      <div style="height:12px"></div>
      <label class="check"><input type="checkbox" name="optsCode" ${q.optsCode ? 'checked' : ''}><span>Las respuestas son código (letra monoespaciada)</span></label>
      ${isNew ? '' : `<label class="check"><input type="checkbox" name="annulled" ${q.annulled ? 'checked' : ''}><span>Anulada: no cuenta para la nota</span></label>`}
      <div class="row end">
        ${isNew ? '' : '<button type="button" class="btn danger" id="del">Borrar</button><span class="grow"></span>'}
        <a class="btn" href="#/examen/${examId}/preguntas">Cancelar</a>
        <button class="btn primary">Guardar</button>
      </div>
    </form>`;
    const f = $('#qf');
    const collect = () => {
      q.text = f.text.value.trim();
      q.code = f.code.value.replace(/\s+$/, '');
      q.options.forEach((o, i) => { o.text = f['opt' + i].value.trim(); });
      q.correct = +(f.correct.value || 0);
      q.optsCode = f.optsCode.checked;
      if (f.annulled) q.annulled = f.annulled.checked;
    };
    $('#img')?.addEventListener('change', async e => {
      collect();
      if (e.target.files[0]) q.image = await prepareImage(e.target.files[0]);
      render();
    });
    if ($('#rmimg')) $('#rmimg').onclick = () => { collect(); q.image = null; render(); };
    if ($('#addopt')) $('#addopt').onclick = () => { collect(); q.options.push({ text: '' }); render(); };
    $$('[data-rm]').forEach(b => (b.onclick = () => {
      collect();
      const i = +b.dataset.rm;
      q.options.splice(i, 1);
      if (q.correct === i) q.correct = 0; else if (q.correct > i) q.correct--;
      render();
    }));
    if ($('#del')) $('#del').onclick = async () => {
      if (!confirm('¿Borrar esta pregunta?')) return;
      exam.questions = exam.questions.filter(x => x.id !== q.id);
      await saveExam(exam);
      location.hash = `#/examen/${examId}/preguntas`;
    };
    f.onsubmit = async ev => {
      ev.preventDefault();
      collect();
      if (!q.text && !q.code && !q.image) return toast('La pregunta necesita enunciado, código o imagen.');
      if (q.options.some(o => !o.text)) return toast('Rellena todas las respuestas o quita las que sobren.');
      if (isNew) exam.questions.push(q);
      else exam.questions[exam.questions.indexOf(orig)] = q;
      await saveExam(exam);
      location.hash = `#/examen/${examId}/preguntas`;
    };
  };
  render();
}

/* ---------- Imprimir ---------- */

function tabPrint(exam, el) {
  const g = groupById(exam.groupId);
  const st = printState(exam, g);
  const n = exam.questions.length, max = maxQuestions(nopt(exam));
  const opts = exam.printOpts || { duplex: false, reserves: 3 };
  let html = '';
  if (!n) { el.innerHTML = `<p class="empty">Primero importa las preguntas.</p>`; return; }
  if (n > max) { el.innerHTML = `<div class="banner bad">Hay ${n} preguntas y en la hoja caben ${max}.</div>`; return; }
  if (!g || !g.students.length) html += `<div class="banner warn">El grupo no tiene alumnado; solo se imprimirán hojas de reserva.</div>`;
  if (st === 'stale') html += `<div class="banner warn">Las preguntas han cambiado desde la última impresión. Al generar el PDF se crean versiones nuevas y las hojas impresas antes dejan de valer.</div>`;
  if (st === 'partial') html += `<div class="banner info">Hay alumnado nuevo en el grupo. Al generar el PDF se le crea su versión; las del resto no cambian.</div>`;
  if (st === 'ok') html += `<div class="banner ok">Versiones creadas el ${fmtDate(exam.printed.at)}. Si vuelves a generar el PDF, cada alumno o alumna conserva su misma versión.</div>`;
  html += `<div class="card">
      <p style="margin-top:0"><b>${n}</b> preguntas · <b>${g?.students.length || 0}</b> alumnos/as de ${esc(g?.name || '—')}<br>
      <span class="muted">${exam.shuffleQ ? 'Preguntas barajadas' : 'Preguntas en orden'} · ${exam.shuffleO ? 'respuestas barajadas' : 'respuestas en orden'}</span></p>
      <label class="check"><input type="checkbox" id="duplex" ${opts.duplex ? 'checked' : ''}><span>Impresión a doble cara (la hoja de respuestas queda sola en su folio)</span></label>
      <label class="field"><span>Hojas de reserva sin nombre</span><input type="number" id="reserves" min="0" max="30" value="${opts.reserves}"></label>
      <button class="btn primary block" id="gen">Generar PDF</button>
    </div>
    <div id="out"></div>
    <p class="muted small">Cada alumno o alumna recibe la hoja de respuestas con su nombre y su código QR, y detrás su examen. Imprime al 100 % (tamaño real), sin «ajustar a la página».</p>`;
  el.innerHTML = html;
  $('#gen').onclick = async () => {
    const reserves = Math.max(0, Math.min(30, parseInt($('#reserves').value, 10) || 0));
    const duplex = $('#duplex').checked;
    exam.printOpts = { duplex, reserves };
    const btn = $('#gen');
    btn.disabled = true;
    btn.textContent = 'Generando…';
    try {
      exam.printed = buildPrint(exam, g, reserves);
      await saveExam(exam);
      const blob = examPDF(exam, g, state.settings, { duplex });
      state.pdf = { blob, filename: `CapiTest_${safeName(exam.title)}.pdf` };
      tabPrint(exam, el);
      showPdfOut();
    } catch (e) {
      console.error(e);
      toast('Error al generar el PDF: ' + e.message);
      btn.disabled = false;
      btn.textContent = 'Generar PDF';
    }
  };
  if (state.pdf) showPdfOut();
}

function showPdfOut() {
  const out = $('#out');
  if (!out || !state.pdf) return;
  const kb = Math.round(state.pdf.blob.size / 1024);
  out.innerHTML = `<div class="card"><div class="card-title">PDF listo (${kb} KB)</div>
    <div class="row" style="margin-top:10px">
      ${canShareFiles() ? '<button class="btn primary grow" id="share">Compartir</button>' : ''}
      <button class="btn grow" id="dl">Descargar</button>
      <button class="btn grow" id="open">Abrir</button>
    </div></div>`;
  if ($('#share')) $('#share').onclick = () => shareFile(state.pdf.blob, state.pdf.filename, state.pdf.filename);
  $('#dl').onclick = () => downloadFile(state.pdf.blob, state.pdf.filename);
  $('#open').onclick = () => window.open(URL.createObjectURL(state.pdf.blob), '_blank');
}

/* ---------- Corregir ---------- */

// Lo leído en la hoja, en el orden impreso: índice impreso, null o 'M'.
function fillsToPrinted(v, fills) {
  return v.order.map((qid, i) => {
    const n = v.perm[qid].length;
    const f = fills[i] || [];
    const marked = [];
    f.forEach((x, j) => { if (x >= MARKED) marked.push(j); });
    const doubt = f.some(x => x >= DOUBT && x < MARKED);
    let p = null;
    if (marked.length === 1 && marked[0] < n) p = marked[0];
    else if (marked.length) p = 'M';
    return { qid, p, doubt };
  });
}
const printedToAnswers = (v, printed) => Object.fromEntries(printed.map(({ qid, p }) =>
  [qid, p === null || p === 'M' ? p : v.perm[qid][p]]));
const answersToPrinted = (v, answers) => v.order.map(qid => {
  const a = answers[qid];
  return { qid, p: a === null || a === undefined ? null : a === 'M' ? 'M' : v.perm[qid].indexOf(a), doubt: false };
});

// Rejilla de respuestas en el orden en que las vio el alumno o alumna; se toca para corregir.
function answerGrid(container, exam, v, printed, onChange) {
  const draw = () => {
    container.innerHTML = `<div class="grid">${printed.map((x, i) => {
      const q = exam.questions.find(qq => qq.id === x.qid);
      if (!q) return '';
      const orig = x.p === null || x.p === 'M' ? x.p : v.perm[x.qid][x.p];
      const cls = q.annulled ? 'off' : orig === null ? 'blank' : orig === 'M' ? 'bad' : orig === q.correct ? 'ok' : 'bad';
      const txt = x.p === null ? '–' : x.p === 'M' ? 'Varias' : LETTERS[x.p];
      return `<button type="button" class="chip ${cls} ${x.doubt ? 'doubt' : ''}" data-i="${i}"><b>${i + 1}</b>${txt}</button>`;
    }).join('')}</div>
    <div class="legend"><span><i style="background:var(--ok)"></i>Bien</span><span><i style="background:var(--bad)"></i>Mal o varias</span>
      <span><i style="background:var(--blank)"></i>En blanco</span><span><i style="background:var(--warn)"></i>Dudosa: compruébala</span></div>
    <p class="muted small">Toca una pregunta para cambiar la respuesta leída.</p>`;
    $$('.chip', container).forEach(b => (b.onclick = () => {
      const x = printed[+b.dataset.i];
      const n = v.perm[x.qid].length;
      x.p = x.p === null ? 0 : x.p === 'M' ? null : x.p + 1 >= n ? null : x.p + 1;
      x.doubt = false;
      draw();
      onChange();
    }));
  };
  draw();
}

function tabScan(exam, el) {
  const g = groupById(exam.groupId);
  if (!exam.printed) { el.innerHTML = `<p class="empty">Primero genera el PDF en la pestaña Imprimir.</p>`; return; }
  const total = g?.students.length || 0;
  el.innerHTML = `
    <div class="cam" id="cam"><div class="placeholder">Pulsa «Abrir cámara» y enfoca la hoja de respuestas.</div></div>
    <div class="row" style="margin:12px 0">
      <button class="btn primary grow" id="startcam">Abrir cámara</button>
      <label class="btn grow">Desde una foto<input type="file" accept="image/*" id="photo" hidden></label>
    </div>
    <div id="result"></div>
    <p class="muted small" id="count">${Object.keys(exam.results).length} de ${total} corregidos.</p>
    <p class="muted small">Consejos: hoja sobre la mesa y bien iluminada, sin sombras del móvil; que se vean las cuatro esquinas negras.</p>`;
  $('#startcam').onclick = async () => {
    if (!navigator.mediaDevices?.getUserMedia) return toast('Este navegador no deja usar la cámara. Prueba «Desde una foto».');
    $('#cam').innerHTML = `<video playsinline muted></video><canvas class="ov"></canvas><div class="scan-msg">Abriendo la cámara…</div>`;
    $('#startcam').hidden = true;
    stopScanner();
    const sc = new Scanner($('#cam video'), $('#cam canvas'), $('#cam .scan-msg'), an => handleScan(exam, an));
    state.scanner = sc;
    try { await sc.start(); } catch (e) {
      console.error(e);
      state.scanner = null;
      $('#cam').innerHTML = `<div class="placeholder">No se ha podido abrir la cámara (${esc(e.name || e.message)}). Revisa el permiso de cámara del navegador.</div>`;
      $('#startcam').hidden = false;
    }
  };
  $('#photo').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    toast('Leyendo la foto…');
    const an = await analyzeFile(file);
    if (!an.ok) return showScanError(an.reason);
    handleScan(exam, an);
  };
}

function showScanError(msg) {
  const r = $('#result');
  if (!r) return;
  r.innerHTML = `<div class="banner bad">${esc(msg)}</div>${state.scanner ? '<button class="btn block" id="go">Seguir</button>' : ''}`;
  if ($('#go')) $('#go').onclick = () => { r.innerHTML = ''; state.scanner?.resume(); };
}

function handleScan(exam, an) {
  const info = parseQR(an.qr);
  if (!info) return showScanError('El código QR no es de CapiTest.');
  if (info.examId !== exam.id) {
    const other = examById(info.examId);
    return showScanError(other ? `Esta hoja es del examen «${other.title}». Ábrelo para corregirla.` : 'Esta hoja es de un examen que no está en este dispositivo.');
  }
  if (info.batch !== exam.printed.batch) return showScanError('Esta hoja es de una impresión anterior y ya no vale: las preguntas cambiaron después.');
  const v = exam.printed.sheets[info.sheetId];
  if (!v) return showScanError('No encuentro esta hoja entre las impresas.');
  const nq = exam.printed.qids.length, n = exam.printed.nopt;
  const fills = readBubbles(an, nq, n);
  drawReading(an, nq, n, fills);
  const printed = fillsToPrinted(v, fills);
  resultCard(exam, v, info.sheetId, printed, an.c.toDataURL('image/jpeg', 0.75));
}

function resultCard(exam, v, sheetId, printed, photo) {
  const g = groupById(exam.groupId);
  const students = g?.students || [];
  const r = $('#result');
  const reserve = !v.studentId;
  const st = students.find(s => s.id === v.studentId);
  const doubts = printed.filter(x => x.doubt).length;
  r.innerHTML = `<div class="card stack">
    <div class="row">
      <div class="grow">
        <div class="card-title">${reserve ? `Hoja de reserva ${esc(sheetId)}` : esc(st?.name || '(ya no está en el grupo)')}</div>
        <div class="muted small" id="detail"></div>
      </div>
      <div class="nota" id="nota"></div>
    </div>
    ${reserve ? `<label class="field"><span>¿De quién es?</span><select id="who"><option value="">Elige…</option>
      ${students.map(s => `<option value="${s.id}">${exam.results[s.id] ? '✓ ' : ''}${esc(s.name)}</option>`).join('')}</select></label>` : ''}
    ${!reserve && exam.results[v.studentId] ? '<div class="banner warn">Esta hoja ya estaba corregida. Si guardas, se sustituye.</div>' : ''}
    ${doubts ? `<div class="banner warn">Hay ${doubts} pregunta(s) dudosa(s), con el círculo a medio rellenar o tachado. Compruébalas con la hoja.</div>` : ''}
    <div id="grid"></div>
    <details><summary class="muted small">Ver la foto leída</summary><img class="snap" src="${photo}" alt="Foto de la hoja con las marcas leídas"></details>
    <div class="row"><button class="btn grow" id="discard">Descartar</button><button class="btn primary grow" id="save">Guardar${state.scanner ? ' y seguir' : ''}</button></div>
  </div>`;
  const upd = () => {
    const gr = grade(exam, printedToAnswers(v, printed));
    $('#nota').textContent = fmtNota(gr.nota);
    $('#nota').className = 'nota ' + (gr.nota >= 5 ? 'ok' : 'bad');
    $('#detail').textContent = `${gr.c} bien · ${gr.w} mal · ${gr.b} en blanco`;
  };
  answerGrid($('#grid'), exam, v, printed, upd);
  upd();
  r.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const next = () => { r.innerHTML = ''; state.scanner?.resume(); };
  $('#discard').onclick = next;
  $('#save').onclick = async () => {
    const sid = reserve ? $('#who').value : v.studentId;
    if (!sid) return toast('Elige de quién es la hoja.');
    if (reserve && exam.results[sid] && !confirm('Esa persona ya tiene nota. ¿Sustituirla?')) return;
    const name = students.find(s => s.id === sid)?.name || '';
    exam.results[sid] = { sheetId, answers: printedToAnswers(v, printed), at: Date.now(), name };
    await saveExam(exam);
    toast(`Guardado: ${name}`);
    const c = $('#count');
    if (c) c.textContent = `${Object.keys(exam.results).length} de ${students.length} corregidos.`;
    next();
  };
}

/* ---------- Notas ---------- */

function tabGrades(exam, el) {
  const g = groupById(exam.groupId);
  const students = [...(g?.students || [])];
  for (const [sid, r] of Object.entries(exam.results)) if (!students.some(s => s.id === sid)) students.push({ id: sid, name: r.name || '(fuera del grupo)' });
  const sm = summary(exam);
  const stats = questionStats(exam);
  el.innerHTML = `
    <div class="stats">
      <div class="card"><b>${sm.n}/${g?.students.length || 0}</b><span class="muted small">corregidos</span></div>
      <div class="card"><b>${sm.n ? fmtNota(sm.media) : '–'}</b><span class="muted small">media</span></div>
      <div class="card"><b>${sm.aprobados}</b><span class="muted small">aprobados</span></div>
    </div>
    <div class="row" style="margin-bottom:14px">
      ${canShareFiles() ? '<button class="btn primary grow" id="xshare">Enviar Excel</button>' : ''}
      <button class="btn grow" id="xdl">Descargar Excel</button>
    </div>
    <table class="list">
      <thead><tr><th>Alumno/a</th><th class="num">Nota</th><th class="num">✓ ✗ –</th></tr></thead>
      <tbody>${students.map(s => {
        const r = exam.results[s.id];
        if (!r) return `<tr data-sid="${s.id}"><td>${esc(s.name)}</td><td class="num muted">—</td><td class="num muted small">sin corregir</td></tr>`;
        const gr = grade(exam, r.answers);
        return `<tr data-sid="${s.id}"><td>${esc(s.name)}</td><td class="num" style="font-weight:700;color:var(${gr.nota >= 5 ? '--ok' : '--bad'})">${fmtNota(gr.nota)}</td><td class="num small">${gr.c} ${gr.w} ${gr.b}</td></tr>`;
      }).join('')}</tbody>
    </table>
    <h2 class="section">Preguntas</h2>
    <p class="muted small">Porcentaje de aciertos en tu numeración original. Si una pregunta estaba mal planteada, anúlala y las notas se recalculan.</p>
    ${stats.map((s, i) => `<div class="card ${s.q.annulled ? 'annulled' : ''}">
      <div class="row"><b>P${i + 1}</b><span class="grow small" style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(s.q.text || s.q.code)}</span>
        <button class="btn small" data-annul="${s.q.id}">${s.q.annulled ? 'Recuperar' : 'Anular'}</button></div>
      <div class="bar ${s.pct < 0.3 ? 'low' : s.pct < 0.5 ? 'mid' : ''}" style="margin:8px 0 4px"><i style="width:${Math.round(s.pct * 100)}%"></i></div>
      <div class="muted small">${s.n ? Math.round(s.pct * 100) + ' % aciertos · ' : ''}correcta ${LETTERS[s.q.correct]} · ${s.q.options.map((_, j) => `${LETTERS[j]}: ${s.counts[j] || 0}`).join(' · ')} · blanco: ${s.blank}</div>
    </div>`).join('')}`;
  const xl = () => examExcel(exam, g);
  if ($('#xshare')) $('#xshare').onclick = () => { const x = xl(); shareFile(x.blob, x.filename, exam.title); };
  $('#xdl').onclick = () => { const x = xl(); downloadFile(x.blob, x.filename); };
  $$('tr[data-sid]', el).forEach(tr => (tr.onclick = () => studentDetail(exam, tr.dataset.sid, students.find(s => s.id === tr.dataset.sid)?.name, () => tabGrades(exam, el))));
  $$('[data-annul]', el).forEach(b => (b.onclick = async () => {
    const q = exam.questions.find(x => x.id === b.dataset.annul);
    q.annulled = !q.annulled;
    await saveExam(exam);
    tabGrades(exam, el);
  }));
}

function studentDetail(exam, sid, name, done) {
  const r = exam.results[sid];
  const v = versionFor(exam, r, sid);
  const printed = r ? answersToPrinted(v, r.answers) : v.order.map(qid => ({ qid, p: null, doubt: false }));
  const s = modal(`<h3>${esc(name)}</h3>
    <div class="row" style="margin-bottom:10px"><div class="grow muted small" id="det"></div><div class="nota" id="nn"></div></div>
    ${r ? `<p class="muted small">Corregida el ${fmtDate(r.at)}${r.sheetId.startsWith('R') ? ` con la hoja de reserva ${esc(r.sheetId)}` : ''}.</p>`
      : '<p class="muted small">Sin corregir. Puedes meter las respuestas a mano en el orden de su hoja.</p>'}
    <div id="g2"></div>
    <div class="row" style="margin-top:12px">
      ${r ? '<button class="btn danger" id="rm">Borrar nota</button>' : ''}<span class="grow"></span>
      <button class="btn" data-close>Cancelar</button><button class="btn primary" id="ok">Guardar</button>
    </div>`);
  const upd = () => {
    const gr = grade(exam, printedToAnswers(v, printed));
    s.querySelector('#nn').textContent = fmtNota(gr.nota);
    s.querySelector('#det').textContent = `${gr.c} bien · ${gr.w} mal · ${gr.b} en blanco`;
  };
  answerGrid(s.querySelector('#g2'), exam, v, printed, upd);
  upd();
  s.querySelector('[data-close]').onclick = closeModal;
  if (s.querySelector('#rm')) s.querySelector('#rm').onclick = async () => {
    if (!confirm('¿Borrar la nota de esta persona?')) return;
    delete exam.results[sid];
    await saveExam(exam);
    closeModal();
    done();
  };
  s.querySelector('#ok').onclick = async () => {
    exam.results[sid] = { sheetId: r?.sheetId || v.sheetId || sid, answers: printedToAnswers(v, printed), at: Date.now(), name, manual: true };
    await saveExam(exam);
    closeModal();
    done();
  };
}

/* ---------- Grupos ---------- */

function viewGroups() {
  setHeader('Grupos');
  setNav('grupos');
  const list = [...state.groups].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  main().innerHTML = `<button class="btn primary block" id="ng">+ Nuevo grupo</button>
    ${list.length ? '<div style="height:12px"></div>' : '<p class="empty">Crea un grupo por cada clase y pega o importa su lista de alumnado.</p>'}
    ${list.map(g => `<a class="card" href="#/grupo/${g.id}"><div class="card-title">${esc(g.name)}</div><div class="muted">${g.students.length} alumnos/as</div></a>`).join('')}`;
  $('#ng').onclick = () => {
    const s = modal(`<h3>Nuevo grupo</h3><form id="gf">
      <label class="field"><span>Nombre</span><input type="text" name="name" placeholder="Por ejemplo: 1.º ASIR A" required></label>
      <div class="row end"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary">Crear</button></div></form>`);
    s.querySelector('[data-close]').onclick = closeModal;
    s.querySelector('input').focus();
    s.querySelector('#gf').onsubmit = async ev => {
      ev.preventDefault();
      const g = { id: uid(6), name: ev.target.elements.name.value.trim(), students: [] };
      if (!g.name) return;
      await saveGroup(g);
      closeModal();
      location.hash = `#/grupo/${g.id}`;
    };
  };
}

function viewGroup(id) {
  const g = groupById(id);
  if (!g) { location.hash = '#/grupos'; return; }
  setNav('grupos');
  setHeader(g.name, '#/grupos');
  main().innerHTML = `
    <label class="field"><span>Nombre del grupo</span><input type="text" id="gname" value="${esc(g.name)}"></label>
    <div class="row" style="margin-bottom:12px">
      <button class="btn grow" id="paste">Pegar lista</button>
      <button class="btn grow" id="xls">Importar Excel o CSV</button>
    </div>
    <div class="card">
      <div class="row"><b class="grow">${g.students.length} alumnos/as</b>${g.students.length > 1 ? '<button class="btn small" id="sort">Ordenar A-Z</button>' : ''}</div>
      <ul class="students">${g.students.map(s => `<li><span>${esc(s.name)}</span><button class="iconbtn" data-rn="${s.id}" aria-label="Renombrar">✎</button><button class="iconbtn" data-del="${s.id}" aria-label="Quitar">✕</button></li>`).join('')}</ul>
      <form id="addf" class="row" style="margin-top:10px"><input type="text" name="n" class="grow" placeholder="Añadir alumno/a"><button class="btn">Añadir</button></form>
    </div>
    <button class="btn danger block" id="delg">Borrar grupo</button>`;
  $('#gname').onchange = async e => { g.name = e.target.value.trim() || g.name; await saveGroup(g); setHeader(g.name, '#/grupos'); };
  $('#addf').onsubmit = async e => {
    e.preventDefault();
    const n = e.target.n.value.trim();
    if (!n) return;
    g.students.push({ id: uid(6), name: n });
    await saveGroup(g);
    viewGroup(id);
    $('#addf input').focus();
  };
  if ($('#sort')) $('#sort').onclick = async () => { g.students.sort((a, b) => a.name.localeCompare(b.name, 'es')); await saveGroup(g); viewGroup(id); };
  $$('[data-del]').forEach(b => (b.onclick = async () => {
    const s = g.students.find(x => x.id === b.dataset.del);
    if (!confirm(`¿Quitar a ${s.name} del grupo? Sus notas ya guardadas se conservan.`)) return;
    g.students = g.students.filter(x => x !== s);
    await saveGroup(g);
    viewGroup(id);
  }));
  $$('[data-rn]').forEach(b => (b.onclick = async () => {
    const s = g.students.find(x => x.id === b.dataset.rn);
    const n = prompt('Nombre', s.name);
    if (!n || !n.trim()) return;
    s.name = n.trim();
    await saveGroup(g);
    viewGroup(id);
  }));
  $('#paste').onclick = () => pasteDialog(g);
  $('#xls').onclick = () => sheetDialog(g);
  $('#delg').onclick = async () => {
    const used = state.exams.filter(e => e.groupId === g.id);
    if (used.length) return alert(`No se puede borrar: lo usan ${used.length} examen(es). Bórralos o cámbiales el grupo antes.`);
    if (!confirm(`¿Borrar el grupo «${g.name}»?`)) return;
    await db.del('groups', g.id);
    state.groups = state.groups.filter(x => x.id !== g.id);
    location.hash = '#/grupos';
  };
}

async function addNames(g, names) {
  const have = new Set(g.students.map(s => s.name.toLowerCase()));
  let added = 0;
  for (const n of names) {
    const name = n.replace(/\s+/g, ' ').trim();
    if (!name || have.has(name.toLowerCase())) continue;
    have.add(name.toLowerCase());
    g.students.push({ id: uid(6), name });
    added++;
  }
  await saveGroup(g);
  closeModal();
  toast(`${added} añadidos.`);
  viewGroup(g.id);
}

function pasteDialog(g) {
  const s = modal(`<h3>Pegar lista</h3>
    <p class="muted small">Copia la columna de nombres de Séneca, Moodle o una hoja de cálculo y pégala aquí: un nombre por línea.</p>
    <textarea id="names" rows="10" placeholder="García López, Ana&#10;Pérez Ruiz, Juan"></textarea>
    <div class="row end" style="margin-top:12px"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="ok">Añadir</button></div>`);
  s.querySelector('[data-close]').onclick = closeModal;
  s.querySelector('#ok').onclick = () => addNames(g, s.querySelector('#names').value.split('\n').map(l => l.split('\t')[0]));
}

function sheetDialog(g) {
  const s = modal(`<h3>Importar Excel o CSV</h3>
    <input type="file" id="sf" accept=".xlsx,.xls,.ods,.csv,.txt">
    <div id="map"></div>
    <div class="row end" style="margin-top:12px"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="ok" disabled>Añadir</button></div>`);
  s.querySelector('[data-close]').onclick = closeModal;
  let rows = [];
  s.querySelector('#sf').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const wb = window.XLSX.read(await readFile(file, 'arrayBuffer'));
      rows = window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
        .filter(r => r.some(c => String(c).trim()));
    } catch { return toast('No puedo leer ese archivo.'); }
    if (!rows.length) return toast('El archivo está vacío.');
    const ncol = Math.max(...rows.slice(0, 50).map(r => r.length));
    const head = rows[0].map(c => String(c));
    const looksHeader = head.some(c => /nombre|alumn|apellido/i.test(c));
    const guess = Math.max(0, head.findIndex(c => /alumn|nombre|apellido/i.test(c)));
    const colName = i => (looksHeader && head[i] ? `${String.fromCharCode(65 + i)} · ${head[i]}` : `Columna ${String.fromCharCode(65 + i)}`);
    const opts = sel => Array.from({ length: ncol }, (_, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(colName(i))}</option>`).join('');
    s.querySelector('#map').innerHTML = `
      <div class="preview"><table>${rows.slice(0, 5).map(r => `<tr>${Array.from({ length: ncol }, (_, i) => `<td>${esc(r[i])}</td>`).join('')}</tr>`).join('')}</table></div>
      <label class="check"><input type="checkbox" id="hdr" ${looksHeader ? 'checked' : ''}><span>La primera fila son títulos</span></label>
      <label class="field"><span>Columna con el nombre (o los apellidos)</span><select id="c1">${opts(guess)}</select></label>
      <label class="field"><span>Segunda columna (opcional)</span><select id="c2"><option value="">Ninguna</option>${opts(-1)}</select></label>
      <label class="field"><span>Unir las dos columnas con</span><select id="sep"><option value=", ">Coma: «Apellidos, Nombre»</option><option value=" ">Espacio: «Nombre Apellidos»</option></select></label>
      <p class="muted small" id="ex"></p>`;
    const names = () => {
      const c1 = +s.querySelector('#c1').value, c2v = s.querySelector('#c2').value, sep = s.querySelector('#sep').value;
      return rows.slice(s.querySelector('#hdr').checked ? 1 : 0)
        .map(r => [r[c1], c2v === '' ? '' : r[+c2v]].map(x => String(x ?? '').trim()).filter(Boolean).join(sep))
        .filter(Boolean);
    };
    const preview = () => {
      const n = names();
      s.querySelector('#ex').textContent = `${n.length} nombres. Ejemplo: ${n.slice(0, 2).join(' / ')}`;
    };
    $$('#map select, #map input', s).forEach(x => (x.onchange = preview));
    preview();
    const ok = s.querySelector('#ok');
    ok.disabled = false;
    ok.onclick = () => addNames(g, names());
  };
}

/* ---------- Ajustes y copias ---------- */

function viewSettings() {
  setHeader('Ajustes');
  setNav('ajustes');
  const st = state.settings;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  main().innerHTML = `
    <div class="card">
      <label class="field"><span>Profesor/a (sale en la hoja)</span><input type="text" id="prof" value="${esc(st.profesor || '')}"></label>
      <label class="field" style="margin-bottom:0"><span>Centro (sale en la hoja)</span><input type="text" id="centro" value="${esc(st.centro || '')}"></label>
    </div>
    <h2 class="section">Logos de los exámenes</h2>
    <div class="card">
      <div class="row" style="align-items:flex-start">
        ${[['logoL', 'Izquierda'], ['logoR', 'Derecha']].map(([k, t]) => `<div class="grow">
          <div class="muted small" style="font-weight:600">${t}</div>
          ${st[k] ? `<img class="logo" src="${st[k].data}" alt="Logo ${t.toLowerCase()}"><button class="btn small danger" data-rmlogo="${k}">Quitar</button>`
            : `<label class="btn small" style="margin-top:6px">Elegir imagen<input type="file" accept="image/*" data-logo="${k}" hidden></label>`}
        </div>`).join('')}
      </div>
      <p class="muted small" style="margin-bottom:0">Salen en la cabecera de la hoja de respuestas y del examen. Junto al logo de la izquierda va el nombre del módulo.</p>
    </div>
    <h2 class="section">Tus datos</h2>
    <div class="card">
      <p style="margin-top:0">Grupos, exámenes y notas se guardan <b>solo en este dispositivo</b>; no se envían a ningún servidor.</p>
      ${standalone ? '' : `<div class="banner warn">En iPhone, añade CapiTest a la pantalla de inicio (Compartir → «Añadir a pantalla de inicio») y ábrela desde ahí. Si solo la usas desde Safari, el sistema puede borrar los datos tras unas semanas sin abrirla.</div>`}
      <div class="row">
        <button class="btn primary grow" id="exp">Exportar copia</button>
        <label class="btn grow">Importar copia<input type="file" id="imp" accept=".json,application/json" hidden></label>
      </div>
      <p class="muted small">La copia es un archivo con todo. Guárdalo en tu nube o pásaselo a otro dispositivo para continuar allí.</p>
    </div>
    <button class="btn danger block" id="wipe">Borrar todos los datos de este dispositivo</button>
    <p class="muted small" style="text-align:center;margin-top:20px">CapiTest</p>`;
  const save = async () => {
    state.settings = { ...state.settings, profesor: $('#prof').value.trim(), centro: $('#centro').value.trim() };
    await db.setMeta('settings', state.settings);
    toast('Guardado.');
  };
  $('#prof').onchange = save;
  $('#centro').onchange = save;
  $$('[data-logo]').forEach(inp => (inp.onchange = async () => {
    if (!inp.files[0]) return;
    state.settings = { ...state.settings, [inp.dataset.logo]: await prepareImage(inp.files[0], 600) };
    await db.setMeta('settings', state.settings);
    viewSettings();
  }));
  $$('[data-rmlogo]').forEach(b => (b.onclick = async () => {
    state.settings = { ...state.settings, [b.dataset.rmlogo]: null };
    await db.setMeta('settings', state.settings);
    viewSettings();
  }));
  $('#exp').onclick = () => {
    const data = { app: 'CapiTest', version: 1, exportedAt: new Date().toISOString(), settings: state.settings, groups: state.groups, exams: state.exams };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const fn = `CapiTest_copia_${new Date().toISOString().slice(0, 10)}.json`;
    if (canShareFiles()) shareFile(blob, fn, 'Copia de CapiTest'); else downloadFile(blob, fn);
  };
  $('#imp').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let data;
    try { data = JSON.parse(await readFile(file, 'text')); } catch { return toast('El archivo no es una copia válida.'); }
    if (data.app !== 'CapiTest') return toast('El archivo no es una copia de CapiTest.');
    if (!confirm(`La copia tiene ${data.groups.length} grupos y ${data.exams.length} exámenes. Se añaden a los que ya hay; los que coincidan se sustituyen. ¿Seguir?`)) return;
    for (const g of data.groups) await db.put('groups', g);
    for (const x of data.exams) await db.put('exams', x);
    if (data.settings) {
      const mine = Object.fromEntries(Object.entries(state.settings).filter(([, v]) => v));
      await db.setMeta('settings', { ...data.settings, ...mine });
    }
    await load();
    toast('Copia importada.');
    viewSettings();
  };
  $('#wipe').onclick = async () => {
    if (!confirm('¿Borrar TODOS los grupos, exámenes y notas de este dispositivo? No se puede deshacer.')) return;
    if (prompt('Escribe BORRAR para confirmar') !== 'BORRAR') return;
    await db.clearAll();
    await load();
    location.hash = '#/';
  };
}

/* ---------- Arranque ---------- */

async function init() {
  await load();
  askPersistence();
  window.addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
init();
