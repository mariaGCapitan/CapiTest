import { db, askPersistence } from './db.js';
import {
  $, $$, esc, uid, toast, LETTERS, fmtNota, fmtNum, parseNum, fmtDate, PENALTIES, penaltyText,
  canShareFiles, shareFile, downloadFile, readFile, loadImage, prepareImage, safeName,
} from './util.js';
import { maxQuestions, LAYOUT } from './layout.js';
import { importExamFile, MAX_OPTS, OPEN_LINES } from './import.js';
import { buildPrint, examPDF, parseQR } from './pdf.js';
import { grade, summary, questionStats, versionFor, nopt, testPoints, multiOf, qScore } from './grading.js';
import { readBubbles, drawReading, MARKED, DOUBT } from './omr.js';
import { Scanner, analyzeFile } from './scan.js';
import { examExcel } from './excel.js';
import { checkList, parseSeneca, toPseudonym } from './seudonimo.js';
import { net, api, ApiError, detect, login, logout, changePassword, acceptInvite, queue, run as runSync, start as startSync } from './sync.js';

const state = { groups: [], exams: [], settings: {}, scanner: null, pdf: null };

/* ---------- Datos ---------- */

async function load() {
  state.groups = await db.all('groups');
  state.exams = await db.all('exams');
  state.settings = (await db.getMeta('settings')) || {};
}
const groupById = id => state.groups.find(g => g.id === id);
const examById = id => state.exams.find(e => e.id === id);

// En el servidor las notas van aparte del examen: dos móviles pueden corregir a la vez sin pisarse.
const examDoc = ({ results, ...rest }) => rest;

async function saveExam(e) {
  e.updated = Date.now();
  await db.put('exams', e);
  const i = state.exams.findIndex(x => x.id === e.id);
  if (i < 0) state.exams.push(e); else state.exams[i] = e;
  await queue('exam', e.id, examDoc(e), e.updated);
}
async function saveGroup(g) {
  g.updated = Date.now();
  await db.put('groups', g);
  const i = state.groups.findIndex(x => x.id === g.id);
  if (i < 0) state.groups.push(g); else state.groups[i] = g;
  await queue('group', g.id, g, g.updated);
}
async function saveResult(exam, sid) {
  const r = exam.results[sid];
  const now = Date.now();
  if (r) r.updated = now;
  await db.put('exams', exam);
  await queue('result', `${exam.id}/${sid}`, r || null, now, !r);
}
async function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch, updated: Date.now() };
  await db.setMeta('settings', state.settings);
  await queue('settings', 'ajustes', state.settings, state.settings.updated);
}

// Los objetos se cambian en su sitio: una pantalla abierta sigue apuntando al mismo examen.
function replaceInPlace(target, doc) {
  for (const k of Object.keys(target)) if (k !== 'results') delete target[k];
  Object.assign(target, doc);
}

async function applyRemote(items) {
  const rank = { group: 0, settings: 1, exam: 2, result: 3 };
  const touched = new Set();
  for (const c of [...items].sort((a, b) => rank[a.kind] - rank[b.kind])) {
    // Un documento defectuoso no debe impedir que entren los demás.
    try {
      if (c.kind === 'group') {
        if (c.deleted) {
          state.groups = state.groups.filter(g => g.id !== c.id);
          await db.del('groups', c.id);
        } else {
          const doc = { students: [], ...c.doc, id: c.id };
          const g = groupById(c.id);
          if (g) replaceInPlace(g, doc); else state.groups.push(doc);
          await db.put('groups', groupById(c.id));
        }
      } else if (c.kind === 'settings') {
        state.settings = c.doc;
        await db.setMeta('settings', c.doc);
      } else if (c.kind === 'exam') {
        if (c.deleted) {
          state.exams = state.exams.filter(e => e.id !== c.id);
          touched.delete(c.id);
          await db.del('exams', c.id);
        } else {
          const doc = { questions: [], ...c.doc, id: c.id };
          const e = examById(c.id);
          if (e) replaceInPlace(e, doc); else state.exams.push({ ...doc, results: {} });
          touched.add(c.id);
        }
      } else {
        const cut = c.id.indexOf('/');
        const exam = examById(c.id.slice(0, cut)), sid = c.id.slice(cut + 1);
        if (!exam) continue;
        if (c.deleted) delete exam.results[sid]; else exam.results[sid] = c.doc;
        touched.add(exam.id);
      }
    } catch (e) {
      console.error('No se ha podido aplicar', c.kind, c.id, e);
    }
  }
  for (const id of touched) await db.put('exams', examById(id));
  // Nunca se redibuja debajo de alguien que está escribiendo o corrigiendo.
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (!state.scanner && !$('.modal') && !$('#qf') && !$('#result')?.childElementCount && !typing) route();
}

function showSync() {
  const el = $('#syncstate');
  if (!el) return;
  el.hidden = !net.server;
  // Los usuarios de Séneca empiezan por la inicial del nombre y la del primer apellido.
  el.textContent = (net.user?.usuario || '').slice(0, 2).toUpperCase();
  const bad = ['auth', 'error'].includes(net.state);
  el.className = bad ? 'bad' : net.state === 'offline' ? 'offline' : net.state === 'syncing' ? 'busy' : net.pending ? 'pending' : '';
  el.title = syncText();
  el.setAttribute('aria-label', syncText());
  const t = $('#synctext');
  if (t) t.textContent = syncText();
}
function syncText() {
  const n = net.pending ? ` ${net.pending} cambio(s) sin subir.` : '';
  if (net.state === 'offline') return `Sin conexión con el servidor.${n}`;
  if (net.state === 'syncing') return 'Sincronizando…';
  if (net.state === 'auth') return `La sesión ha caducado.${n}`;
  if (net.state === 'error') return `El servidor ha dado un error.${n}`;
  return n ? n.trim() : 'Todo guardado en el servidor.';
}

// Logos de los exámenes: sin elegir (null) salen los del centro; false = sin logo.
const DEFAULT_LOGOS = { logoL: 'img/logo_junta.png', logoR: 'img/logo_gc.png' };
const logoCache = {};
async function printSettings() {
  const s = { ...state.settings };
  for (const k of ['logoL', 'logoR']) {
    if (s[k] === false) { s[k] = null; continue; }
    if (s[k]) continue;
    if (!logoCache[k]) {
      const data = await readFile(await (await fetch(DEFAULT_LOGOS[k])).blob());
      const img = await loadImage(data);
      logoCache[k] = { data, w: img.naturalWidth, h: img.naturalHeight, fmt: 'PNG' };
    }
    s[k] = logoCache[k];
  }
  return s;
}

/* ---------- Estructura ---------- */

const main = () => $('#main');

function setHeader(title, back, actions = '') {
  $('#title').innerHTML = (back ? `<a class="back" href="${back}" aria-label="Volver">‹</a>` : '<img class="mini" src="icons/logo-capitest.png" alt="">') + `<span>${esc(title)}</span>`;
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
  // Pinchar fuera no cierra la ventana: solo se cierra con sus botones.
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
  if (parts[0] === 'invitacion' && parts[1] && net.server) return viewInvite(parts[1]);
  if (state.gate) return state.gate();
  main().innerHTML = '';
  window.scrollTo(0, 0);
  switch (parts[0]) {
    case '': case 'examenes': return viewExams();
    case 'grupos': return viewGroups();
    case 'grupo': return viewGroup(parts[1]);
    case 'examen':
      if (parts[2] === 'pregunta') return viewQuestion(parts[1], parts[3]);
      if (parts[2] === 'abierta') return viewOpen(parts[1], parts[3]);
      return viewExam(parts[1], parts[2] || 'preguntas');
    case 'ajustes': return viewSettings();
    case 'cuenta': return viewAccount();
    case 'profesorado': return viewUsers();
    default: location.hash = '#/';
  }
}

/* ---------- Exámenes ---------- */

function viewExams() {
  setHeader('Exámenes');
  setNav('examenes');
  const list = [...state.exams].sort((a, b) => (b.created || 0) - (a.created || 0));
  const mods = [...new Set(list.map(e => e.module || 'Sin módulo'))];
  let html = `<div class="row"><button class="btn primary grow" id="new">+ Nuevo examen</button>
    ${net.server ? '' : '<label class="btn">Importar<input type="file" id="impx" accept=".json,application/json" hidden></label>'}</div>`;
  if (!list.length) {
    html += `<p class="empty">Todavía no hay exámenes.<br>Crea uno y sube el archivo de Moodle (XML o GIFT).</p>`;
  }
  const tonos = ['azul', 'magenta', 'naranja', 'verde'];
  mods.forEach((m, i) => {
    const tono = `var(--${tonos[i % 4]})`;
    html += `<h2 class="section" style="color:${tono}">${esc(m)}</h2>`;
    for (const e of list.filter(x => (x.module || 'Sin módulo') === m)) {
      const g = groupById(e.groupId);
      const total = g?.students.length || 0;
      const done = Object.keys(e.results || {}).length;
      html += `<div class="examrow"><a class="card" style="border-left:4px solid ${tono}" href="#/examen/${e.id}">
        <div class="card-title">${esc(e.title)}</div>
        <div class="muted">${esc(g?.name || 'Sin grupo')} · ${e.questions.length} preguntas · ${done}/${total} corregidos</div>
      </a><button class="iconbtn" data-delexam="${e.id}" aria-label="Borrar ${esc(e.title)}">🗑️</button></div>`;
    }
  });
  main().innerHTML = html;
  $('#new').onclick = () => examForm(null);
  $$('[data-delexam]').forEach(b => (b.onclick = async () => {
    if (await deleteExam(examById(b.dataset.delexam))) viewExams();
  }));
  if (!net.server) $('#impx').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await importData(file);
  };
}

async function deleteExam(exam) {
  if (!confirm(`¿Borrar el examen «${exam.title}» y todas sus notas? No se puede deshacer.`)) return false;
  await db.del('exams', exam.id);
  state.exams = state.exams.filter(x => x.id !== exam.id);
  await queue('exam', exam.id, null, Date.now(), true);
  toast(`Examen «${exam.title}» borrado`);
  return true;
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
      ${modules.length ? `<label class="field"><span>Módulo</span>
        <select name="modsel">
          ${modules.map(m => `<option ${m === e.module ? 'selected' : ''}>${esc(m)}</option>`).join('')}
          <option value="__new">Nuevo módulo…</option>
        </select>
      </label>` : ''}
      <label class="field" id="modnew" ${modules.length ? 'hidden' : ''}><span>${modules.length ? 'Nombre del módulo nuevo' : 'Módulo'}</span>
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
  if (f.modsel) f.modsel.onchange = () => { s.querySelector('#modnew').hidden = f.modsel.value !== '__new'; };
  f.pen.onchange = () => { s.querySelector('#pencustom').hidden = f.pen.value !== 'custom'; };
  s.querySelector('[data-close]').onclick = closeModal;
  if (exam) s.querySelector('#delexam').onclick = async () => {
    if (!(await deleteExam(exam))) return;
    closeModal();
    location.hash = '#/';
  };
  f.onsubmit = async ev => {
    ev.preventDefault();
    const module = !f.modsel || f.modsel.value === '__new' ? f.modnew.value.trim() : f.modsel.value;
    if (!module) return toast('Escribe el módulo');
    const penalty = f.pen.value === 'custom' ? parseFloat(String(f.penc.value).replace(',', '.')) : parseFloat(f.pen.value);
    if (!(penalty >= 0)) return toast('La penalización no es válida');
    let imported = null;
    if (!exam && f.file.files[0]) {
      try { imported = await importExamFile(f.file.files[0]); } catch (err) { return toast(err.message); }
    }
    const title = f.elements.title.value.trim() || imported?.title || '';
    if (!title) return toast('Escribe el título del examen');
    const target = exam || { id: uid(6), created: Date.now(), questions: [], results: {}, printed: null };
    Object.assign(target, { title, module, groupId: f.group.value, penalty, shuffleQ: f.sq.checked, shuffleO: f.so.checked });
    if (imported) { target.questions = imported.questions; target.open = imported.open; }
    await saveExam(target);
    closeModal();
    if (exam) { toast('Datos del examen guardados'); route(); return; }
    if (!imported) toast(`Examen «${title}» creado`);
    location.hash = `#/examen/${target.id}`;
    if (imported) setTimeout(() => importSummary(imported, target), 50);
  };
}

function importSummary(res, exam = null) {
  const nOpen = res.open?.length || 0;
  // Dos apartados: las preguntas que se corrigen a mano y lo que hay que revisar.
  const HAND = '. Se imprime con espacio para responder y se corrige a mano.';
  const hand = res.warnings.filter(w => w.endsWith(HAND)).map(w => w.slice(0, -HAND.length).replace(': es ', ': '));
  const check = res.warnings.filter(w => !w.endsWith(HAND));
  const s = modal(`<h3>Examen importado</h3>
    <p><b>${res.questions.length}</b> preguntas de test importadas${nOpen ? ` y <b>${nOpen}</b> para corregir a mano` : ''}.</p>
    ${hand.length ? `<div class="banner info"><b>Se corrigen a mano (${hand.length})</b><ul class="small">${hand.map(w => `<li>${esc(w)}</li>`).join('')}</ul><span class="small">Se imprimen con espacio para responder.</span></div>` : ''}
    ${check.length ? `<div class="banner warn"><b>Revisa estas preguntas (${check.length})</b><ul class="small">${check.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
    <div class="row end"><button class="btn primary" data-close>${nOpen && exam ? 'Repartir la nota' : 'Vale'}</button></div>`);
  s.querySelector('[data-close]').onclick = () => {
    closeModal();
    if (nOpen && exam) pointsDialog(exam);
  };
}

/* ---------- Preguntas para corregir a mano ---------- */

const shortText = q => (q.text || q.code || '').replace(/\s+/g, ' ').slice(0, 70);
const openSum = exam => (exam.open || []).reduce((a, q) => a + (+q.points || 0), 0);
// El reparto vale si el test y las preguntas abiertas suman 10.
const pointsOk = exam => !exam.open?.length || (exam.testPoints != null && Math.abs(exam.testPoints + openSum(exam) - 10) < 1e-6);

function pointsDialog(exam, done = route) {
  const open = exam.open || [];
  const N = exam.questions.length;
  const s = modal(`<h3>Reparto de la nota</h3>
    <p class="small" style="margin-top:0">Hay ${open.length === 1 ? 'una pregunta' : `${open.length} preguntas`} para corregir a mano. Entre el test y ${open.length === 1 ? 'ella' : 'ellas'} tienen que sumar 10.</p>
    <form id="ptf">
      <label class="field"><span>¿Cuánto vale la parte de test sobre 10?</span>
        <input type="text" inputmode="decimal" name="tp" value="${exam.testPoints != null ? fmtNum(exam.testPoints) : ''}" placeholder="Por ejemplo: 7" required></label>
      ${open.map((q, i) => `<label class="field"><span>Pregunta ${N + i + 1}: ${esc(shortText(q))}</span>
        <input type="text" inputmode="decimal" data-pt="${q.id}" value="${q.points ? fmtNum(q.points) : ''}" required></label>`).join('')}
      <p class="small" id="ptsum" style="font-weight:600"></p>
      <button type="button" class="btn small" id="ptfair">Repartir a partes iguales (${N + open.length} preguntas)</button>
      <div class="row end"><button type="button" class="btn" data-close>Más tarde</button><button class="btn primary">Guardar</button></div>
    </form>`);
  const f = s.querySelector('#ptf');
  const read = () => {
    const tp = parseNum(f.tp.value);
    const pts = Object.fromEntries([...s.querySelectorAll('[data-pt]')].map(i => [i.dataset.pt, parseNum(i.value)]));
    const total = tp + Object.values(pts).reduce((a, b) => a + b, 0);
    return { tp, pts, total };
  };
  // Marca en rojo cada casilla con un valor que no vale y dice cuál es. Devuelve los fallos.
  const check = () => {
    const bad = [];
    const tpv = parseNum(f.tp.value);
    const tpBad = f.tp.value.trim() !== '' && !(tpv >= 0 && tpv <= 10);
    f.tp.classList.toggle('mal', tpBad);
    if (tpBad) bad.push('el test tiene que valer entre 0 y 10');
    s.querySelectorAll('[data-pt]').forEach((i, k) => {
      const wrong = i.value.trim() !== '' && !(parseNum(i.value) > 0);
      i.classList.toggle('mal', wrong);
      if (wrong) bad.push(`la pregunta ${N + k + 1} tiene que valer más de 0`);
    });
    return bad;
  };
  const show = () => {
    const bad = check();
    const { total } = read();
    const el = s.querySelector('#ptsum');
    if (bad.length) {
      el.textContent = 'Revisa lo marcado en rojo: ' + bad.join('; ') + '.';
      el.style.color = 'var(--bad)';
      return;
    }
    if (!Number.isFinite(total)) { el.textContent = ''; return; }
    const ok = Math.abs(total - 10) < 1e-6;
    el.textContent = ok ? 'Suman 10. Correcto.' : `Suman ${fmtNum(total)}: ${total < 10 ? 'faltan' : 'sobran'} ${fmtNum(Math.abs(10 - total))}.`;
    el.style.color = ok ? 'var(--ok)' : 'var(--bad)';
  };
  // Todas las preguntas valen lo mismo: cada una a mano vale 10 / total (con dos decimales)
  // y el test se lleva el resto, para que la suma sea exactamente 10.
  const fair = () => {
    const each = Math.round(10 / (N + open.length) * 100) / 100;
    s.querySelectorAll('[data-pt]').forEach(i => { i.value = fmtNum(each); });
    f.tp.value = fmtNum(10 - each * open.length);
    show();
  };
  s.querySelector('#ptfair').onclick = fair;
  f.oninput = show;
  // La primera vez sale ya propuesto el reparto a partes iguales.
  if (exam.testPoints == null && open.every(q => !q.points)) fair(); else show();
  s.querySelector('[data-close]').onclick = () => { closeModal(); done(); };
  f.onsubmit = async ev => {
    ev.preventDefault();
    const { tp, pts, total } = read();
    // Las casillas vacías también cuentan como fallo al guardar.
    f.tp.classList.toggle('mal', !(tp >= 0 && tp <= 10));
    s.querySelectorAll('[data-pt]').forEach(i => i.classList.toggle('mal', !(parseNum(i.value) > 0)));
    const first = s.querySelector('.mal');
    if (first) {
      first.focus();
      show();
      return toast(first === f.tp ? 'El test tiene que valer entre 0 y 10' : 'La pregunta marcada en rojo tiene que valer más de 0');
    }
    if (Math.abs(total - 10) > 1e-6) return toast(`Suman ${fmtNum(total)} y tienen que sumar 10`);
    exam.testPoints = tp;
    for (const q of open) q.points = pts[q.id];
    await saveExam(exam);
    toast('Reparto de la nota guardado');
    closeModal();
    done();
  };
}

function viewOpen(examId, qid) {
  const exam = examById(examId);
  if (!exam) { location.hash = '#/'; return; }
  exam.open ||= [];
  const isNew = qid === 'nueva';
  const orig = exam.open.find(q => q.id === qid);
  if (!isNew && !orig) { location.hash = `#/examen/${examId}`; return; }
  const q = orig ? structuredClone(orig) : { id: uid(6), text: '', code: '', image: null, points: 0, lines: OPEN_LINES };
  const num = exam.questions.length + (isNew ? exam.open.length + 1 : exam.open.indexOf(orig) + 1);
  setNav('examenes');
  setHeader(`Pregunta ${num} · a mano`, `#/examen/${examId}/preguntas`);
  const render = () => {
    main().innerHTML = `<form id="qf">
      <p class="muted small" style="margin-top:0">Se imprime después del test, con líneas para responder, y se corrige a mano.</p>
      <label class="field"><span>Enunciado</span><textarea name="text" rows="5">${esc(q.text)}</textarea></label>
      <label class="field"><span>Código (opcional)</span><textarea name="code" class="code" rows="5" spellcheck="false" autocapitalize="off">${esc(q.code)}</textarea></label>
      <div class="field"><span class="muted small" style="font-weight:600">Imagen (opcional)</span>
        ${q.image ? `<img class="imgprev" src="${q.image.data}" alt="Imagen de la pregunta"><button type="button" class="btn small danger" id="rmimg">Quitar imagen</button>`
          : `<input type="file" accept="image/*" id="img">`}
      </div>
      <label class="field"><span>Líneas para responder</span><input type="number" name="lines" min="0" max="40" value="${q.lines}"></label>
      <p class="muted small">Lo que vale se pone en «Reparto de la nota», en la pestaña Preguntas.</p>
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
      q.lines = Math.max(0, Math.min(40, parseInt(f.lines.value, 10) || 0));
    };
    $('#img')?.addEventListener('change', async e => {
      collect();
      if (e.target.files[0]) q.image = await prepareImage(e.target.files[0]);
      render();
    });
    if ($('#rmimg')) $('#rmimg').onclick = () => { collect(); q.image = null; render(); };
    if ($('#del')) $('#del').onclick = async () => {
      if (!confirm('¿Borrar esta pregunta? Habrá que repartir de nuevo la nota.')) return;
      exam.open = exam.open.filter(x => x.id !== q.id);
      await saveExam(exam);
      toast('Pregunta borrada');
      location.hash = `#/examen/${examId}/preguntas`;
    };
    f.onsubmit = async ev => {
      ev.preventDefault();
      collect();
      if (!q.text && !q.code && !q.image) return toast('La pregunta necesita enunciado, código o imagen');
      const at = exam.open.findIndex(x => x.id === q.id);
      if (at < 0) exam.open.push(q); else exam.open[at] = q;
      await saveExam(exam);
      toast(at < 0 ? 'Pregunta añadida' : 'Pregunta guardada');
      location.hash = `#/examen/${examId}/preguntas`;
      if (!pointsOk(exam)) setTimeout(() => pointsDialog(exam), 50);
    };
  };
  render();
}

// Casillas para poner la nota de cada pregunta abierta. Vacía = sin nota todavía.
function openInputs(container, exam, scores, onChange) {
  const open = exam.open || [];
  if (!open.length) { container.innerHTML = ''; return; }
  const N = exam.questions.length;
  container.innerHTML = `<div class="abiertas">
    <div class="small" style="font-weight:600;margin-bottom:8px">Nota a mano${pointsOk(exam) ? '' : ' · <span style="color:var(--bad)">falta repartir la nota en la pestaña Preguntas</span>'}</div>
    ${open.map((q, i) => `<label class="abierta"><span><b>P${N + i + 1}</b> <span class="muted small">${esc(shortText(q))}</span></span>
      <span class="nowrap"><input type="text" inputmode="decimal" autocomplete="off" data-open="${q.id}" value="${typeof scores[q.id] === 'number' ? fmtNum(scores[q.id]) : ''}" placeholder="–" aria-label="Nota de la pregunta ${N + i + 1}"> / ${fmtNum(q.points)}</span></label>`).join('')}
  </div>`;
  $$('[data-open]', container).forEach(inp => (inp.oninput = () => {
    const q = open.find(x => x.id === inp.dataset.open);
    const v = parseNum(inp.value);
    const empty = inp.value.trim() === '';
    const bad = !empty && !(v >= 0 && v <= q.points + 1e-9);
    inp.classList.toggle('bad', bad);
    if (empty || bad) delete scores[q.id]; else scores[q.id] = v;
    onChange();
  }));
}

const gradeText = (exam, gr) => `${gr.c} bien · ${gr.p ? `${gr.p} en parte · ` : ''}${gr.w} mal · ${gr.b} en blanco` + (exam.open?.length
  ? ` · test ${fmtNum(gr.test)} + a mano ${fmtNum(gr.manual)}${gr.pending ? ` (faltan ${gr.pending})` : ''}` : '');

function importDialog(exam) {
  const s = modal(`<h3>Importar preguntas</h3>
    <form id="imf">
      <label class="field"><span>Archivo de Moodle (XML o GIFT)</span>
        <input type="file" name="file" accept=".xml,.gift,.txt,text/xml,text/plain" required></label>
      ${exam.questions.length || exam.open?.length ? `
      <label class="check"><input type="radio" name="mode" value="replace" checked><span>Sustituir las ${exam.questions.length + (exam.open?.length || 0)} preguntas actuales</span></label>
      <label class="check"><input type="radio" name="mode" value="add"><span>Añadirlas al final</span></label>` : ''}
      <div class="row end"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary">Importar</button></div>
    </form>`);
  s.querySelector('[data-close]').onclick = closeModal;
  const f = s.querySelector('#imf');
  f.onsubmit = async ev => {
    ev.preventDefault();
    let res;
    try { res = await importExamFile(f.file.files[0]); } catch (err) { return toast(err.message); }
    if (!res.questions.length && !res.open.length) { importSummary(res); return; }
    const add = f.mode && f.mode.value === 'add';
    exam.questions = add ? [...exam.questions, ...res.questions] : res.questions;
    exam.open = add ? [...(exam.open || []), ...res.open] : res.open;
    await saveExam(exam);
    route();
    setTimeout(() => importSummary(res, exam), 50);
  };
}

/* ---------- Un examen ---------- */

function printState(exam, group) {
  const p = exam.printed;
  if (!p) return 'never';
  if (p.layout !== LAYOUT) return 'layout';
  const qids = exam.questions.map(q => q.id);
  const same = p.nopt === nopt(exam) && p.qids.length === qids.length && qids.every(id => p.qids.includes(id))
    && exam.questions.every(q => p.nopts?.[q.id] === q.options.length)
    && exam.questions.every(q => !!multiOf(q) === (p.multis || []).includes(q.id));
  if (!same) return 'stale';
  if ((group?.students || []).some(s => !p.sheets[s.id])) return 'partial';
  return 'ok';
}

function viewExam(id, tab) {
  const exam = examById(id);
  if (!exam) { location.hash = '#/'; return; }
  setNav('examenes');
  setHeader(exam.title, '#/', net.server ? '' : '<button class="btn small" id="xpt">Exportar</button>');
  if (!net.server) $('#xpt').onclick = () => {
    if (!exam.printed && !confirm('Aún no has generado el PDF de este examen. Para corregirlo en otro dispositivo, exporta después de generar el PDF. ¿Exportar igualmente?')) return;
    if (exam.printed && printState(exam, groupById(exam.groupId)) === 'stale' && !confirm('Las preguntas han cambiado desde el último PDF. Genera el PDF otra vez antes de exportar. ¿Exportar igualmente?')) return;
    const g = groupById(exam.groupId);
    exportData({ groups: g ? [g] : [], exams: [exam] }, `CapiTest_examen_${safeName(exam.title)}.json`);
  };
  const tabs = [['preguntas', 'Preguntas'], ['imprimir', 'Imprimir'], ['corregir', 'Corregir'], ['notas', 'Notas']];
  main().innerHTML = `<div class="seg">${tabs.map(([k, t]) => `<a href="#/examen/${id}/${k}" class="${k === tab ? 'on' : ''} ${!exam.printed && (k === 'corregir' || k === 'notas') ? 'off' : ''}">${t}</a>`).join('')}<a href="#" id="edit">Datos</a></div><div id="tab"></div>`;
  $('#edit').onclick = e => { e.preventDefault(); examForm(exam); };
  const el = $('#tab');
  ({ preguntas: tabQuestions, imprimir: tabPrint, corregir: tabScan, notas: tabGrades }[tab] || tabQuestions)(exam, el);
}

function tabQuestions(exam, el) {
  const n = exam.questions.length;
  const max = maxQuestions(nopt(exam));
  const g = groupById(exam.groupId);
  let html = `<p class="muted">${esc(exam.module)} · ${esc(g?.name || 'Sin grupo')} · ${penaltyText(exam.penalty)}</p>`;
  if (!g) html += `<div class="banner warn">Este examen no tiene grupo. Elígelo en la pestaña Datos.</div>`;
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
        <span class="badge ok">✓ ${keyLetters(q)}</span>${multiOf(q) ? '<span class="badge">varias respuestas</span>' : ''}
        <span class="badge">${q.options.length} opciones</span>
        ${q.code ? '<span class="badge">código</span>' : ''}${q.image ? '<span class="badge">imagen</span>' : ''}
        ${q.annulled ? '<span class="badge bad">anulada</span>' : ''}
      </a>
      <div class="tools">
        <button class="iconbtn" data-up="${i}" aria-label="Subir" ${i ? '' : 'disabled'}>▲</button>
        <button class="iconbtn" data-down="${i}" aria-label="Bajar" ${i < n - 1 ? '' : 'disabled'}>▼</button>
        <button class="iconbtn" data-del="${i}" aria-label="Borrar pregunta ${i + 1}">🗑️</button>
      </div>
    </div>`).join('');
  const open = exam.open || [];
  if (open.length) {
    html += `<h2 class="section">Para corregir a mano</h2>
      ${pointsOk(exam) ? `<p class="muted small">Test: ${fmtNum(testPoints(exam))} puntos · a mano: ${fmtNum(openSum(exam))} puntos. Se imprimen después del test, con líneas para responder.</p>`
        : '<div class="banner warn">Falta repartir la nota entre el test y estas preguntas.</div>'}
      <button class="btn block" id="pts" style="margin-bottom:12px">Reparto de la nota</button>
      ${open.map((q, i) => `<div class="card q">
        <div class="num">${n + i + 1}</div>
        <a class="body" href="#/examen/${exam.id}/abierta/${q.id}" style="color:inherit;text-decoration:none">
          <div class="txt">${esc(q.text || q.code)}</div>
          <span class="badge warn">a mano</span><span class="badge">${q.points ? `${fmtNum(q.points)} ${q.points === 1 ? 'punto' : 'puntos'}` : 'sin valor'}</span>
          <span class="badge">${q.lines} líneas</span>${q.code ? '<span class="badge">código</span>' : ''}${q.image ? '<span class="badge">imagen</span>' : ''}
        </a>
        <div class="tools">
          <button class="iconbtn" data-oup="${i}" aria-label="Subir" ${i ? '' : 'disabled'}>▲</button>
          <button class="iconbtn" data-odown="${i}" aria-label="Bajar" ${i < open.length - 1 ? '' : 'disabled'}>▼</button>
          <button class="iconbtn" data-odel="${i}" aria-label="Borrar pregunta ${n + i + 1}">🗑️</button>
        </div>
      </div>`).join('')}`;
  }
  html += `<a class="btn small" style="margin-top:8px" href="#/examen/${exam.id}/abierta/nueva">+ Pregunta para corregir a mano</a>`;
  el.innerHTML = html;
  $('#imp').onclick = () => importDialog(exam);
  if ($('#pts')) $('#pts').onclick = () => pointsDialog(exam);
  const omove = async (i, d) => {
    [open[i], open[i + d]] = [open[i + d], open[i]];
    await saveExam(exam);
    tabQuestions(exam, el);
  };
  $$('[data-oup]', el).forEach(b => (b.onclick = () => omove(+b.dataset.oup, -1)));
  $$('[data-odown]', el).forEach(b => (b.onclick = () => omove(+b.dataset.odown, 1)));
  $$('[data-odel]', el).forEach(b => (b.onclick = async () => {
    const i = +b.dataset.odel;
    if (!confirm(`¿Borrar la pregunta ${n + i + 1}? Habrá que repartir de nuevo la nota.`)) return;
    open.splice(i, 1);
    await saveExam(exam);
    toast('Pregunta borrada');
    tabQuestions(exam, el);
  }));
  const move = async (i, d) => {
    const q = exam.questions;
    [q[i], q[i + d]] = [q[i + d], q[i]];
    await saveExam(exam);
    tabQuestions(exam, el);
  };
  $$('[data-up]', el).forEach(b => (b.onclick = () => move(+b.dataset.up, -1)));
  $$('[data-down]', el).forEach(b => (b.onclick = () => move(+b.dataset.down, 1)));
  $$('[data-del]', el).forEach(b => (b.onclick = async () => {
    const i = +b.dataset.del;
    const warn = exam.printed ? '\n\nEl examen ya está impreso: las hojas impresas dejarán de valer y habrá que generar el PDF otra vez.' : '';
    if (!confirm(`¿Borrar la pregunta ${i + 1}?${warn}`)) return;
    exam.questions.splice(i, 1);
    await saveExam(exam);
    toast('Pregunta borrada');
    tabQuestions(exam, el);
  }));
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
  let multi = !!q.multi;

  const render = () => {
    main().innerHTML = `<form id="qf">
      <label class="field"><span>Enunciado</span><textarea name="text" rows="4">${esc(q.text)}</textarea></label>
      <label class="field"><span>Código (opcional)</span><textarea name="code" class="code" rows="5" spellcheck="false" autocapitalize="off">${esc(q.code)}</textarea></label>
      <div class="field"><span class="muted small" style="font-weight:600">Imagen (opcional)</span>
        ${q.image ? `<img class="imgprev" src="${q.image.data}" alt="Imagen de la pregunta"><button type="button" class="btn small danger" id="rmimg">Quitar imagen</button>`
          : `<input type="file" accept="image/*" id="img">`}
      </div>
      <h2 class="section">Respuestas · ${multi ? 'marca todas las correctas' : 'marca la correcta'}</h2>
      <label class="check"><input type="checkbox" id="multi" ${multi ? 'checked' : ''}><span>Varias respuestas correctas (puntúa como Moodle: cada correcta suma su parte, cada incorrecta resta la suya y la pregunta no baja de 0)</span></label>
      ${q.options.map((o, i) => `<div class="opt">
          <input type="${multi ? 'checkbox' : 'radio'}" name="correct" value="${i}" ${(multi ? (q.multi || []).includes(i) : q.correct === i) ? 'checked' : ''} aria-label="Correcta ${LETTERS[i]}">
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
      if (multi) {
        q.multi = $$('input[name=correct]', f).filter(x => x.checked).map(x => +x.value);
        q.correct = q.multi[0] ?? 0;
      } else {
        q.correct = +(f.correct.value || 0);
        delete q.multi;
      }
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
    $('#multi').onchange = e => {
      collect();
      multi = e.target.checked;
      if (multi) q.multi = [q.correct]; else { q.correct = q.multi?.[0] ?? 0; delete q.multi; }
      render();
    };
    $$('[data-rm]').forEach(b => (b.onclick = () => {
      collect();
      const i = +b.dataset.rm;
      q.options.splice(i, 1);
      if (q.correct === i) q.correct = 0; else if (q.correct > i) q.correct--;
      if (q.multi) q.multi = q.multi.filter(x => x !== i).map(x => (x > i ? x - 1 : x));
      render();
    }));
    if ($('#del')) $('#del').onclick = async () => {
      if (!confirm('¿Borrar esta pregunta?')) return;
      exam.questions = exam.questions.filter(x => x.id !== q.id);
      await saveExam(exam);
      toast('Pregunta borrada');
      location.hash = `#/examen/${examId}/preguntas`;
    };
    f.onsubmit = async ev => {
      ev.preventDefault();
      collect();
      if (!q.text && !q.code && !q.image) return toast('La pregunta necesita enunciado, código o imagen');
      if (q.options.some(o => !o.text)) return toast('Rellena todas las respuestas o quita las que sobren');
      if (multi && q.multi.length < 2) return toast('Marca al menos dos respuestas correctas, o quita «Varias respuestas correctas»');
      if (multi && q.multi.length === q.options.length) return toast('Al menos una respuesta tiene que ser incorrecta');
      const at = exam.questions.findIndex(x => x.id === q.id);
      if (at < 0) exam.questions.push(q); else exam.questions[at] = q;
      await saveExam(exam);
      toast(at < 0 ? 'Pregunta añadida' : 'Pregunta guardada');
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
  if (!pointsOk(exam)) html += `<div class="banner warn">Falta repartir la nota entre el test y las preguntas para corregir a mano (pestaña Preguntas).</div>`;
  if (st === 'stale') html += `<div class="banner warn">Las preguntas han cambiado desde la última impresión. Al generar el PDF se crean versiones nuevas y las hojas impresas antes dejan de valer.</div>`;
  if (st === 'partial') html += `<div class="banner info">Hay alumnado nuevo en el grupo. Al generar el PDF se le crea su versión; las del resto no cambian.</div>`;
  if (st === 'ok') html += `<div class="banner ok">Versiones creadas el ${fmtDate(exam.printed.at)}. Si vuelves a generar el PDF, cada alumno o alumna conserva su misma versión.</div>`;
  html += `<div class="card">
      <p style="margin-top:0"><b>${n}</b> preguntas${exam.open?.length ? ` de test y <b>${exam.open.length}</b> para corregir a mano` : ''} · <b>${g?.students.length || 0}</b> alumnos/as de ${esc(g?.name || '—')}<br>
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
      const blob = examPDF(exam, g, await printSettings(), { duplex });
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
      ${canShareFiles() ? '<button class="btn grow" id="share">Compartir</button>' : ''}
      <button class="btn grow" id="dl">Descargar</button>
      <button class="btn grow" id="open">Vista previa</button>
    </div></div>`;
  if ($('#share')) $('#share').onclick = () => shareFile(state.pdf.blob, state.pdf.filename, state.pdf.filename);
  $('#dl').onclick = () => downloadFile(state.pdf.blob, state.pdf.filename);
  $('#open').onclick = () => window.open(URL.createObjectURL(state.pdf.blob), '_blank');
}

/* ---------- Corregir ---------- */

const keyLetters = q => (multiOf(q) || [q.correct]).map(i => LETTERS[i]).join(', ');

// Lo leído en la hoja, en el orden impreso: índice impreso, null o 'M'.
// En las preguntas de varias respuestas, la lista de índices impresos marcados.
function fillsToPrinted(exam, v, fills) {
  return v.order.map((qid, i) => {
    const n = v.perm[qid].length;
    const f = fills[i] || [];
    const marked = [];
    f.forEach((x, j) => { if (x >= MARKED) marked.push(j); });
    const half = f.some(x => x >= DOUBT && x < MARKED);
    if (multiOf(exam.questions.find(q => q.id === qid) || {})) {
      const m = marked.filter(j => j < n);
      return { qid, p: m.length ? m : null, doubt: half };
    }
    const doubt = marked.length > 1 || half;
    let p = null;
    if (marked.length === 1 && marked[0] < n) p = marked[0];
    else if (marked.length) p = 'M';
    return { qid, p, doubt };
  });
}
const printedToAnswers = (v, printed) => Object.fromEntries(printed.map(({ qid, p }) =>
  [qid, Array.isArray(p) ? (p.length ? p.map(j => v.perm[qid][j]).sort((a, b) => a - b) : null)
    : p === null || p === 'M' ? p : v.perm[qid][p]]));
const answersToPrinted = (v, answers) => v.order.map(qid => {
  const a = answers[qid];
  if (Array.isArray(a)) return { qid, p: a.map(i => v.perm[qid].indexOf(i)).sort((x, y) => x - y), doubt: false };
  return { qid, p: a === null || a === undefined ? null : a === 'M' ? 'M' : v.perm[qid].indexOf(a), doubt: false };
});

// Rejilla de respuestas en el orden en que las vio el alumno o alumna; se toca para corregir.
function answerGrid(container, exam, v, printed, onChange) {
  let pick = null; // pregunta de varias respuestas que se está corrigiendo (índice en la hoja)
  const draw = () => {
    container.innerHTML = `<div class="grid">${printed.map((x, i) => {
      const q = exam.questions.find(qq => qq.id === x.qid);
      if (!q) return '';
      const orig = printedToAnswers(v, [x])[x.qid];
      const sc = qScore(q, orig);
      const cls = q.annulled ? 'off' : sc.kind === 'b' ? 'blank' : sc.kind === 'c' ? 'ok' : sc.pts > 0 ? 'part' : 'bad';
      const txt = x.p === null ? '–' : x.p === 'M' ? 'Varias' : Array.isArray(x.p) ? x.p.map(j => LETTERS[j]).join('') : LETTERS[x.p];
      return `<button type="button" class="chip ${cls} ${x.doubt || x.p === 'M' ? 'doubt' : ''}" data-i="${i}"><b>${i + 1}</b>${txt}</button>`;
    }).join('')}</div>
    ${pick === null ? '' : `<div class="banner info"><b>Pregunta ${pick + 1}: marca lo que tiene la hoja</b> (puede haber varias)
      <div class="row">${Array.from({ length: v.perm[printed[pick].qid].length }, (_, j) => `<label class="check"><input type="checkbox" data-m="${j}" ${(Array.isArray(printed[pick].p) ? printed[pick].p : []).includes(j) ? 'checked' : ''}><span>${LETTERS[j]}</span></label>`).join('')}
      <button type="button" class="btn small" id="mdone">Hecho</button></div></div>`}
    <div class="legend"><span><i style="background:var(--ok)"></i>Bien</span>${exam.questions.some(multiOf) ? '<span><i style="background:var(--warn)"></i>En parte</span>' : ''}<span><i style="background:var(--bad)"></i>Mal</span>
      <span><i style="background:var(--blank)"></i>En blanco</span><span><i style="background:var(--warn)"></i>Dudosa: compruébala</span></div>
    <p class="muted small">Toca una pregunta para cambiar la respuesta leída.</p>`;
    $$('.chip', container).forEach(b => (b.onclick = () => {
      const x = printed[+b.dataset.i];
      const n = v.perm[x.qid].length;
      if (multiOf(exam.questions.find(q => q.id === x.qid) || {})) {
        // Varias respuestas: debajo de la rejilla salen las casillas para marcar lo que tiene la hoja.
        pick = pick === +b.dataset.i ? null : +b.dataset.i;
        draw();
        return;
      }
      x.p = x.p === null ? 0 : x.p === 'M' ? null : x.p + 1 >= n ? null : x.p + 1;
      x.doubt = false;
      draw();
      onChange();
    }));
    $$('[data-m]', container).forEach(c => (c.onchange = () => {
      const x = printed[pick];
      const m = $$('[data-m]', container).filter(k => k.checked).map(k => +k.dataset.m);
      x.p = m.length ? m : null;
      x.doubt = false;
      draw();
      onChange();
    }));
    if ($('#mdone', container)) $('#mdone', container).onclick = () => { pick = null; draw(); };
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
    <p class="muted small">Consejos: hoja sobre la mesa y bien iluminada, sin sombras del móvil; que se vean los cuatro cuadrados de las esquinas. Si en papel falta alguno, imprime de nuevo la hoja.</p>`;
  $('#startcam').onclick = async () => {
    if (!navigator.mediaDevices?.getUserMedia) return toast('Este navegador no deja usar la cámara. Prueba «Desde una foto»');
    $('#cam').innerHTML = `<div class="vbox"><video playsinline muted></video><canvas class="ov"></canvas></div><div class="scan-msg">Abriendo la cámara…</div>`;
    $('#startcam').hidden = true;
    stopScanner();
    const sc = new Scanner($('#cam video'), $('#cam canvas'), $('#cam .scan-msg'), an => handleScan(exam, an));
    state.scanner = sc;
    try {
      await sc.start();
      fitCamera();
    } catch (e) {
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

// Ajusta el visor para que entre en pantalla con el mensaje y los botones a la vista.
function fitCamera() {
  const cam = $('#cam'), box = $('#cam .vbox'), v = $('#cam video');
  if (!cam || !box || !v || !v.videoWidth) return;
  const maxH = Math.min(window.innerHeight * 0.55, 560);
  let w = cam.clientWidth, h = w * v.videoHeight / v.videoWidth;
  if (h > maxH) { h = maxH; w = h * v.videoWidth / v.videoHeight; }
  box.style.width = `${w}px`;
  box.style.height = `${h}px`;
}
window.addEventListener('resize', fitCamera);

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
  const printed = fillsToPrinted(exam, v, fills);
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
    ${doubts ? `<div class="banner warn">Hay ${doubts} pregunta(s) dudosa(s): con varias marcas, con el círculo a medio rellenar o tachado. Compruébalas con la hoja.</div>` : ''}
    <div id="grid"></div>
    <div id="openin"></div>
    <details><summary class="muted small">Ver la foto leída</summary><img class="snap" src="${photo}" alt="Foto de la hoja con las marcas leídas"></details>
    <div class="row"><button class="btn grow" id="discard">Descartar</button><button class="btn primary grow" id="save">Guardar${state.scanner ? ' y seguir' : ''}</button></div>
  </div>`;
  const scores = { ...(reserve ? {} : exam.results[v.studentId]?.open || {}) };
  const upd = () => {
    const gr = grade(exam, printedToAnswers(v, printed), scores);
    $('#nota').textContent = fmtNota(gr.nota);
    $('#nota').className = 'nota ' + (gr.nota >= 5 ? 'ok' : 'bad');
    $('#detail').textContent = gradeText(exam, gr);
  };
  answerGrid($('#grid'), exam, v, printed, upd);
  openInputs($('#openin'), exam, scores, upd);
  upd();
  r.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const next = () => { r.innerHTML = ''; state.scanner?.resume(); };
  $('#discard').onclick = next;
  $('#save').onclick = async () => {
    const sid = reserve ? $('#who').value : v.studentId;
    if (!sid) return toast('Elige de quién es la hoja');
    if (reserve && exam.results[sid] && !confirm('Esa persona ya tiene nota. ¿Sustituirla?')) return;
    const name = students.find(s => s.id === sid)?.name || '';
    const open = reserve ? { ...(exam.results[sid]?.open || {}), ...scores } : scores;
    exam.results[sid] = { sheetId, answers: printedToAnswers(v, printed), open, at: Date.now(), name };
    await saveResult(exam, sid);
    toast(`Guardado: ${name}`);
    const c = $('#count');
    if (c) c.textContent = `${Object.keys(exam.results).length} de ${students.length} corregidos.`;
    next();
  };
}

/* ---------- Notas ---------- */

function tabGrades(exam, el) {
  const g = groupById(exam.groupId);
  // Sin PDF generado no hay hojas que corregir, así que tampoco notas.
  if (!exam.printed && !Object.keys(exam.results || {}).length) {
    el.innerHTML = `<p class="empty">Las notas aparecen cuando generes el PDF del examen y corrijas las hojas.<br><a href="#/examen/${exam.id}/imprimir">Ir a Imprimir</a></p>`;
    return;
  }
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
      ${canShareFiles() ? '<button class="btn grow" id="xshare">Enviar Excel</button>' : ''}
      <button class="btn grow" id="xdl">Descargar Excel</button>
    </div>
    <table class="list">
      <thead><tr><th>Alumno/a</th><th class="num">Nota</th><th class="num">✓ ${exam.questions.some(multiOf) ? '½ ' : ''}✗ –</th></tr></thead>
      <tbody>${students.map(s => {
        const r = exam.results[s.id];
        if (!r) return `<tr data-sid="${s.id}"><td>${esc(s.name)}</td><td class="num muted">—</td><td class="num muted small">sin corregir</td></tr>`;
        const gr = grade(exam, r.answers, r.open);
        return `<tr data-sid="${s.id}"><td>${esc(s.name)}</td><td class="num" style="font-weight:700;color:var(${gr.nota >= 5 ? '--ok' : '--bad'})">${fmtNota(gr.nota)}</td><td class="num small">${gr.c} ${exam.questions.some(multiOf) ? gr.p + ' ' : ''}${gr.w} ${gr.b}${gr.pending ? `<br><span style="color:var(--warn)">falta${gr.pending > 1 ? 'n' : ''} ${gr.pending} a mano</span>` : ''}</td></tr>`;
      }).join('')}</tbody>
    </table>
    <h2 class="section">Preguntas</h2>
    <p class="muted small">Porcentaje de aciertos en tu numeración original. Si una pregunta estaba mal planteada, anúlala y las notas se recalculan.</p>
    ${stats.map((s, i) => `<div class="card ${s.q.annulled ? 'annulled' : ''}">
      <div class="row"><b>P${i + 1}</b><span class="grow small" style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(s.q.text || s.q.code)}</span>
        <button class="btn small" data-annul="${s.q.id}">${s.q.annulled ? 'Recuperar' : 'Anular'}</button></div>
      <div class="bar ${s.pct < 0.3 ? 'low' : s.pct < 0.5 ? 'mid' : ''}" style="margin:8px 0 4px"><i style="width:${Math.round(s.pct * 100)}%"></i></div>
      <div class="muted small">${s.n ? Math.round(s.pct * 100) + ' % aciertos · ' : ''}correcta ${keyLetters(s.q)} · ${s.q.options.map((_, j) => `${LETTERS[j]}: ${s.counts[j] || 0}`).join(' · ')} · blanco: ${s.blank}</div>
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
    <div id="o2"></div>
    <div class="row" style="margin-top:12px">
      ${r ? '<button class="btn danger" id="rm">Borrar nota</button>' : ''}<span class="grow"></span>
      <button class="btn" data-close>Cancelar</button><button class="btn primary" id="ok">Guardar</button>
    </div>`);
  const scores = { ...(r?.open || {}) };
  const upd = () => {
    const gr = grade(exam, printedToAnswers(v, printed), scores);
    s.querySelector('#nn').textContent = fmtNota(gr.nota);
    s.querySelector('#det').textContent = gradeText(exam, gr);
  };
  answerGrid(s.querySelector('#g2'), exam, v, printed, upd);
  openInputs(s.querySelector('#o2'), exam, scores, upd);
  upd();
  s.querySelector('[data-close]').onclick = closeModal;
  if (s.querySelector('#rm')) s.querySelector('#rm').onclick = async () => {
    if (!confirm('¿Borrar la nota de esta persona?')) return;
    delete exam.results[sid];
    await saveResult(exam, sid);
    toast('Nota borrada');
    closeModal();
    done();
  };
  s.querySelector('#ok').onclick = async () => {
    exam.results[sid] = { sheetId: r?.sheetId || v.sheetId || sid, answers: printedToAnswers(v, printed), open: scores, at: Date.now(), name, manual: true };
    await saveResult(exam, sid);
    toast(`Nota guardada: ${name}`);
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
    ${list.length ? '<div style="height:12px"></div>' : `<p class="empty">Crea un grupo por cada clase e importa su lista de alumnado${net.server ? ' de Séneca' : ''}.</p>`}
    ${list.map(g => `<a class="card" href="#/grupo/${g.id}"><div class="card-title">${esc(g.name)}</div><div class="muted">${g.students.length} alumnos/as</div></a>`).join('')}`;
  $('#ng').onclick = () => {
    const s = modal(`<h3>Nuevo grupo</h3><form id="gf">
      <label class="field"><span>Nombre</span><input type="text" name="name" placeholder="Por ejemplo: 1.º ASIR A - 26/27" required></label>
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
      if (net.server) setTimeout(() => senecaDialog(g, true), 50);
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
      ${net.server ? '<button class="btn grow" id="seneca">Importar de Séneca</button>' : `<button class="btn grow" id="paste">Pegar lista</button>
      <button class="btn grow" id="xls">Importar Excel o CSV</button>`}
    </div>
    <div class="card">
      <div class="row"><b class="grow">${g.students.length} alumnos/as</b>${g.students.length > 1 ? '<button class="btn small" id="sort">Ordenar A-Z</button>' : ''}</div>
      <ul class="students">${g.students.map(s => `<li><span>${esc(s.name)}</span><button class="iconbtn" data-rn="${s.id}" aria-label="Renombrar">✎</button><button class="iconbtn" data-del="${s.id}" aria-label="Quitar">✕</button></li>`).join('')}</ul>
      <form id="addf" class="row" style="margin-top:10px"><input type="text" name="n" class="grow" placeholder="${net.server ? 'Apellidos, Nombre' : 'Añadir alumno/a'}"><button class="btn">Añadir</button></form>
    </div>
    <div class="row">${net.server ? '' : '<button class="btn grow" id="xptg">Exportar grupo</button>'}<button class="btn danger grow" id="delg">Borrar grupo</button></div>`;
  if (!net.server) $('#xptg').onclick = () => exportData({ groups: [g] }, `CapiTest_grupo_${safeName(g.name)}.json`);
  $('#gname').onchange = async e => { g.name = e.target.value.trim() || g.name; await saveGroup(g); setHeader(g.name, '#/grupos'); };
  $('#addf').onsubmit = async e => {
    e.preventDefault();
    const n = personName(e.target.n.value.trim(), g);
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
    toast(`${s.name} quitado del grupo`);
    viewGroup(id);
  }));
  $$('[data-rn]').forEach(b => (b.onclick = async () => {
    const s = g.students.find(x => x.id === b.dataset.rn);
    const typed = prompt('Nombre', s.name);
    if (!typed || !typed.trim()) return;
    const n = personName(typed.trim(), g, s);
    if (!n) return;
    s.name = n;
    await saveGroup(g);
    viewGroup(id);
  }));
  if (net.server) $('#seneca').onclick = () => senecaDialog(g);
  else {
    $('#paste').onclick = () => pasteDialog(g);
    $('#xls').onclick = () => sheetDialog(g);
  }
  $('#delg').onclick = async () => {
    const used = state.exams.filter(e => e.groupId === g.id);
    if (used.length) return alert(`No se puede borrar: lo usan ${used.length} examen(es). Bórralos o cámbiales el grupo antes.`);
    if (!confirm(`¿Borrar el grupo «${g.name}»?`)) return;
    await db.del('groups', g.id);
    state.groups = state.groups.filter(x => x.id !== g.id);
    await queue('group', g.id, null, Date.now(), true);
    toast(`Grupo «${g.name}» borrado`);
    location.hash = '#/grupos';
  };
}

// Con servidor, cada nombre se guarda como seudónimo. Sin servidor, tal como se escribe.
function personName(typed, g, self = null) {
  if (!net.server) return typed;
  const { value, error } = toPseudonym(typed);
  if (error) { toast(error); return null; }
  if (g.students.some(s => s !== self && s.name === value)) { toast(`${value} ya está en el grupo`); return null; }
  return value;
}

// Muestra el resultado antes de guardar. Devuelve los seudónimos en orden (null = quitado) o null si se cancela.
function reviewNames(names, existing = []) {
  return new Promise(done => {
    const rows = names.map((name, i) => ({ i, name }));
    const s = modal(`<h3>Revisa los seudónimos</h3>
      <p class="muted small">La conversión se hace en este dispositivo. Al servidor solo llega la columna de la derecha.</p>
      <div id="sdn"></div>
      <div class="row end" style="margin-top:12px"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="ok">Guardar</button></div>`);
    const typed = new Map();
    const current = r => (typed.has(r.i) ? typed.get(r.i) : r.name);
    const check = () => checkList(rows.map(current), existing);
    const refresh = () => {
      const res = check();
      rows.forEach((r, k) => {
        const el = s.querySelector(`[data-row="${r.i}"]`);
        const v = res[k];
        el.querySelector('input').classList.toggle('bad', !!v.error);
        el.querySelector('.msg').textContent = v.error || (v.existing ? 'Ya está en el grupo: no se añade.' : '');
        if (v.value && !typed.has(r.i)) el.querySelector('input').value = v.value;
      });
      const bad = res.filter(v => v.error).length;
      const b = s.querySelector('#ok');
      b.disabled = bad > 0 || !rows.length;
      b.textContent = bad ? `Faltan ${bad} por revisar` : 'Guardar';
    };
    const draw = () => {
      s.querySelector('#sdn').innerHTML = `<div class="sdn">${rows.map(r => `<div class="sdnrow" data-row="${r.i}">
        <span class="orig">${esc(r.name)}</span>
        <input type="text" value="${esc(current(r))}" aria-label="Seudónimo de ${esc(r.name)}" autocapitalize="characters" spellcheck="false">
        <button type="button" class="iconbtn" data-x="${r.i}" aria-label="Quitar">✕</button>
        <small class="msg"></small>
      </div>`).join('')}</div>`;
      $$('.sdnrow input', s).forEach(inp => (inp.oninput = () => {
        typed.set(+inp.closest('.sdnrow').dataset.row, inp.value);
        refresh();
      }));
      $$('[data-x]', s).forEach(b => (b.onclick = () => {
        rows.splice(rows.findIndex(r => r.i === +b.dataset.x), 1);
        draw();
      }));
      refresh();
    };
    draw();
    s.querySelector('[data-close]').onclick = () => { closeModal(); done(null); };
    s.querySelector('#ok').onclick = () => {
      const res = check();
      const out = names.map(() => null);
      rows.forEach((r, k) => { if (!res[k].existing) out[r.i] = res[k].value; });
      closeModal();
      done(out);
    };
  });
}

async function addNames(g, input) {
  let names = input;
  if (net.server) {
    const clean = input.map(n => n.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const res = await reviewNames(clean, g.students.map(s => s.name));
    if (!res) return;
    names = res.filter(Boolean);
  }
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
  toast(`${added} añadidos`);
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

function senecaDialog(g, isNew = false) {
  const s = modal(`<h3>${isNew ? `Alumnado de ${esc(g.name)}` : 'Importar de Séneca'}</h3>
    <p class="muted small">Sube la hoja «Mis alumnos y alumnas» descargada de Séneca en formato <b>Hoja Microsoft Excel</b>. Se suele llamar RegMisAlu.xls. Los nombres se convierten en seudónimos en este dispositivo y el correo no se guarda.</p>
    <input type="file" id="sf" accept=".xls,.xlsx">
    <div class="row end" style="margin-top:12px"><button class="btn" data-close>${isNew ? 'Cancelar: lo añadiré a mano' : 'Cancelar'}</button></div>`);
  s.querySelector('[data-close]').onclick = closeModal;
  s.querySelector('#sf').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    let names;
    try {
      const wb = window.XLSX.read(await readFile(file, 'arrayBuffer'));
      names = parseSeneca(window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' }));
    } catch { return toast('No puedo leer ese archivo'); }
    if (!names) { e.target.value = ''; return toast('Esta hoja no es la de Séneca: no encuentro la columna «Alumno»'); }
    addNames(g, names);
  };
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
    } catch { return toast('No puedo leer ese archivo'); }
    if (!rows.length) return toast('El archivo está vacío');
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
        ${[['logoL', 'Izquierda'], ['logoR', 'Derecha']].map(([k, t]) => {
          const v = st[k];
          const pick = `<label class="btn small">${v === false ? 'Elegir imagen' : 'Cambiar'}<input type="file" accept="image/*" data-logo="${k}" hidden></label>`;
          const reset = `<button class="btn small" data-deflogo="${k}">Usar el del centro</button>`;
          const rm = `<button class="btn small danger" data-rmlogo="${k}">Quitar</button>`;
          let body;
          if (v === false) body = `<p class="muted small">Sin logo</p><div class="row">${pick}${reset}</div>`;
          else if (v) body = `<img class="logo" src="${v.data}" alt="Logo ${t.toLowerCase()}"><div class="row">${pick}${reset}${rm}</div>`;
          else body = `<img class="logo" src="${DEFAULT_LOGOS[k]}" alt="Logo del centro"><div class="row">${pick}${rm}</div>`;
          return `<div class="grow"><div class="muted small" style="font-weight:600">${t}${v == null ? ' (del centro)' : ''}</div>${body}</div>`;
        }).join('')}
      </div>
      <p class="muted small" style="margin-bottom:0">Salen en la cabecera de la hoja de respuestas y del examen. Junto al logo de la izquierda va el nombre del módulo.</p>
    </div>
    <h2 class="section">Tus datos</h2>
    <div class="card">
      <p style="margin-top:0">${net.server ? 'Grupos, exámenes y notas se guardan en el <b>servidor del centro</b> y en este dispositivo, para poder corregir sin conexión.'
        : 'Grupos, exámenes y notas se guardan <b>solo en este dispositivo</b>; no se envían a ningún servidor.'}</p>
      ${standalone || net.server ? '' : `<div class="banner warn">En iPhone, añade CapiTest a la pantalla de inicio (Compartir → «Añadir a pantalla de inicio») y ábrela desde ahí. Si solo la usas desde Safari, el sistema puede borrar los datos tras unas semanas sin abrirla.</div>`}
      ${net.server ? '' : `<div class="row">
        <button class="btn grow" id="exp">Exportar copia</button>
        <label class="btn grow">Importar copia<input type="file" id="imp" accept=".json,application/json" hidden></label>
      </div>`}
      <p class="muted small">${net.server ? 'Tus datos pasan solos de un dispositivo a otro.'
        : '«Exportar copia» crea un archivo con todos tus datos. Para seguir en otro dispositivo, envíatelo y ábrelo allí con «Importar copia».'}</p>
    </div>
    ${net.server ? '' : '<button class="btn danger block" id="wipe">Borrar todos los datos de este dispositivo</button>'}
    <div class="marca"><img src="icons/logo-capitest.png" alt=""><span>CapiTest<small>María Ojeda García</small></span></div>`;
  const save = async () => {
    await saveSettings({ profesor: $('#prof').value.trim(), centro: $('#centro').value.trim() });
    toast('Guardado');
  };
  $('#prof').onchange = save;
  $('#centro').onchange = save;
  $$('[data-logo]').forEach(inp => (inp.onchange = async () => {
    if (!inp.files[0]) return;
    await saveSettings({ [inp.dataset.logo]: await prepareImage(inp.files[0], 600) });
    viewSettings();
  }));
  $$('[data-rmlogo]').forEach(b => (b.onclick = async () => {
    await saveSettings({ [b.dataset.rmlogo]: false });
    viewSettings();
  }));
  $$('[data-deflogo]').forEach(b => (b.onclick = async () => {
    await saveSettings({ [b.dataset.deflogo]: null });
    viewSettings();
  }));
  if (!net.server) $('#exp').onclick = () => exportData({ settings: state.settings, groups: state.groups, exams: state.exams }, `CapiTest_copia_${new Date().toISOString().slice(0, 10)}.json`);
  if (!net.server) $('#imp').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await importData(file);
  };
  if ($('#wipe')) $('#wipe').onclick = async () => {
    if (!confirm('¿Borrar TODOS los grupos, exámenes y notas de este dispositivo? No se puede deshacer.')) return;
    if (prompt('Escribe BORRAR para confirmar') !== 'BORRAR') return;
    await db.clearAll();
    await load();
    toast('Datos de este dispositivo borrados');
    location.hash = '#/';
  };
}

/* ---------- Copias ---------- */

function exportData(parts, filename) {
  const data = { app: 'CapiTest', version: 1, exportedAt: new Date().toISOString(), groups: [], exams: [], ...parts };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  if (canShareFiles()) shareFile(blob, filename, filename); else downloadFile(blob, filename);
}

async function importData(file) {
  let data;
  try { data = JSON.parse(await readFile(file, 'text')); } catch { return toast('El archivo no es una copia válida'); }
  if (data.app !== 'CapiTest') return toast('El archivo no es una copia de CapiTest');
  const groups = data.groups || [], exams = data.exams || [];
  const what = [groups.length && `${groups.length} grupo(s)`, exams.length && `${exams.length} examen(es)`].filter(Boolean).join(' y ') || 'nada';
  const lost = exams.map(x => {
    const here = examById(x.id);
    const a = Object.keys(here?.results || {}).length, b = Object.keys(x.results || {}).length;
    return here && a > b ? `\n· «${here.title}»: aquí tiene ${a} notas y la copia trae ${b}.` : '';
  }).join('');
  const warn = lost ? `\n\nOjo, perderías notas:${lost}` : '';
  if (!confirm(`La copia trae ${what}. Se añade a lo que ya hay; lo que coincida se sustituye.${warn}\n\n¿Seguir?`)) return;
  for (const g of groups) await saveGroup(g);
  for (const x of exams) {
    const before = Object.keys(examById(x.id)?.results || {});
    x.results = x.results || {};
    await saveExam(x);
    for (const sid of new Set([...before, ...Object.keys(x.results)])) await saveResult(x, sid);
  }
  if (data.settings) {
    const mine = Object.fromEntries(Object.entries(state.settings).filter(([, v]) => v));
    await saveSettings({ ...data.settings, ...mine });
  }
  await load();
  toast('Copia importada');
  if (exams.length === 1) location.hash = `#/examen/${exams[0].id}/corregir`;
  else if (!exams.length && groups.length === 1) location.hash = `#/grupo/${groups[0].id}`;
  else route();
}

/* ---------- Cuenta y profesorado ---------- */

function bare(title, html) {
  document.body.classList.add('noauth');
  $('#title').innerHTML = `<img class="mini" src="icons/logo-capitest.png" alt=""><span>${esc(title)}</span>`;
  $('#top-actions').innerHTML = '';
  main().innerHTML = `<div class="login card">${html}</div>`;
  $$('input[type=password]').forEach(addEye);
}

const EYE = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/><path class="tacha" d="M4 4l16 16"/></svg>';

function addEye(input) {
  const box = document.createElement('span');
  box.className = 'pass';
  input.replaceWith(box);
  box.innerHTML = `<button type="button" aria-label="Mostrar la contraseña" aria-pressed="false">${EYE}</button>`;
  box.prepend(input);
  const btn = box.querySelector('button');
  btn.onclick = e => {
    e.preventDefault();
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', show);
    btn.setAttribute('aria-label', show ? 'Ocultar la contraseña' : 'Mostrar la contraseña');
    input.focus();
  };
}

function enter() {
  state.gate = null;
  document.body.classList.remove('noauth', 'entrada');
  showSync();
  route();
  runSync();
}

function showLogin() {
  state.gate = showLogin;
  bare('CapiTest', `<div class="marca-app"><img src="icons/logo-capitest.png" alt=""><span>CapiTest</span></div>
    <form id="lf">
      <label class="field"><span>Usuario</span><input type="text" name="usuario" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
      <label class="field"><span>Contraseña</span><input type="password" name="clave" autocomplete="current-password" required></label>
      <button class="btn primary block">Entrar</button>
    </form>
    <p class="small" style="text-align:center;margin-top:16px"><a href="#" id="olvido">¿Has olvidado la contraseña?</a></p>
    <p class="small" style="text-align:center"><a href="#" id="registro">Registrarme</a></p>`);
  document.body.classList.add('entrada');
  $('#olvido').onclick = e => { e.preventDefault(); forgotDialog($('#lf').elements.usuario.value.trim()); };
  $('#registro').onclick = e => { e.preventDefault(); registerDialog(); };
  $('#lf').onsubmit = async ev => {
    ev.preventDefault();
    const f = ev.target.elements, btn = ev.target.querySelector('button');
    btn.disabled = true;
    try {
      const step = await login(f.usuario.value.trim(), f.clave.value);
      await load();
      if (step === 'password') { state.gate = viewPassword; viewPassword(true); } else enter();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'No hay conexión con el servidor');
      btn.disabled = false;
    }
  };
}

function forgotDialog(usuario) {
  const s = modal(`<h3>Contraseña olvidada</h3>
    <form id="fgf">
      <p class="small" style="margin-top:0">Escribe tu usuario de Séneca. Te llegará un correo con un enlace para elegir una contraseña nueva.</p>
      <label class="field"><span>Usuario</span><input type="text" name="usuario" value="${esc(usuario)}" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
      <div class="row end"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary">Enviar</button></div>
    </form>`);
  s.querySelector('[data-close]').onclick = closeModal;
  s.querySelector('#fgf').onsubmit = async ev => {
    ev.preventDefault();
    const btn = ev.target.querySelector('.primary');
    btn.disabled = true;
    try {
      await api('olvido', { usuario: ev.target.elements.usuario.value.trim() });
      s.querySelector('#fgf').outerHTML = `<p>Si el usuario existe y tiene correo, en unos minutos te llegará un enlace. Caduca en 2 horas.</p>
        <p class="muted small">Mira también en la carpeta de spam. Si no llega, pide a la administración un enlace nuevo.</p>
        <div class="row end"><button class="btn primary" data-close>Vale</button></div>`;
      s.querySelector('[data-close]').onclick = closeModal;
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'No hay conexión con el servidor');
      btn.disabled = false;
    }
  };
}

function registerDialog() {
  const s = modal(`<h3>Registrarme</h3>
    <form id="rgf">
      <p class="small" style="margin-top:0">La administración de CapiTest recibirá tu petición. Cuando te dé de alta, te llegará un correo con un enlace para elegir tu contraseña.</p>
      <label class="field"><span>Nombre y apellidos</span><input type="text" name="nombre" autocomplete="name" minlength="3" maxlength="80" required></label>
      <label class="field"><span>Correo de la Junta (@g.educaand.es)</span><input type="email" name="correo" autocomplete="email" autocapitalize="none" spellcheck="false" placeholder="usuario@g.educaand.es" required></label>
      <div class="row end"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary">Enviar</button></div>
    </form>`);
  s.querySelector('[data-close]').onclick = closeModal;
  s.querySelector('#rgf').onsubmit = async ev => {
    ev.preventDefault();
    const f = ev.target.elements, btn = ev.target.querySelector('.primary');
    btn.disabled = true;
    try {
      await api('registro', { nombre: f.nombre.value.trim(), correo: f.correo.value.trim() });
      s.querySelector('#rgf').outerHTML = `<p>Petición enviada. Cuando te den de alta, te llegará un correo a <b>${esc(f.correo.value.trim().toLowerCase())}</b> para elegir tu contraseña.</p>
        <p class="muted small">Mira también en la carpeta de spam.</p>
        <div class="row end"><button class="btn primary" data-close>Vale</button></div>`;
      s.querySelector('[data-close]').onclick = closeModal;
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'No hay conexión con el servidor');
      btn.disabled = false;
    }
  };
}

async function viewInvite(token) {
  history.replaceState(null, '', location.pathname + '#/');
  let info;
  try {
    info = await api('invitacion/ver', { token });
  } catch (e) {
    state.gate = () => bare('CapiTest', `<div class="banner warn">${esc(e instanceof ApiError ? e.message : 'No hay conexión con el servidor.')}</div>`);
    state.gate();
    return;
  }
  const other = net.user && net.user.usuario !== info.usuario;
  const draw = () => {
    bare('CapiTest', `<div class="marca-app"><img src="icons/logo-capitest.png" alt=""><span>CapiTest</span></div>
      <p style="margin-top:0">Hola, <b>${esc(info.nombre)}</b>. Elige tu contraseña para entrar.</p>
      ${other ? `<div class="banner warn">Se cerrará la sesión de ${esc(net.user.usuario)} en este dispositivo.</div>` : ''}
      <form id="invf">
        <label class="field"><span>Usuario</span><input type="text" name="usuario" autocomplete="username" value="${esc(info.usuario)}" readonly></label>
        <label class="field"><span>Contraseña (10 caracteres o más)</span><input type="password" name="nueva" autocomplete="new-password" minlength="10" required></label>
        <label class="field"><span>Repite la contraseña</span><input type="password" name="rep" autocomplete="new-password" required></label>
        <button class="btn primary block">Entrar</button>
      </form>`);
    document.body.classList.add('entrada');
    $('#invf').onsubmit = async ev => {
      ev.preventDefault();
      const f = ev.target.elements;
      if (f.nueva.value !== f.rep.value) return toast('Las contraseñas no coinciden');
      try {
        await acceptInvite(token, f.nueva.value);
        await load();
        enter();
      } catch (e) {
        toast(e instanceof ApiError ? e.message : 'No hay conexión con el servidor');
      }
    };
  };
  state.gate = draw;
  draw();
}

function viewPassword(first = false) {
  document.body.classList.remove('entrada');
  const forced = first === true || net.user?.cambiarClave;
  bare('Cambiar contraseña', `${forced ? '<p class="muted small" style="margin-top:0">Elige tu contraseña personal para terminar de entrar.</p>' : ''}
    <form id="pf">
      <input type="text" autocomplete="username" value="${esc(net.user?.usuario || '')}" hidden>
      <label class="field"><span>Contraseña actual</span><input type="password" name="actual" autocomplete="current-password" required></label>
      <label class="field"><span>Contraseña nueva (10 caracteres o más)</span><input type="password" name="nueva" autocomplete="new-password" minlength="10" required></label>
      <label class="field"><span>Repite la contraseña nueva</span><input type="password" name="rep" autocomplete="new-password" required></label>
      <div class="row end">${forced ? '' : '<button type="button" class="btn" id="cancel">Cancelar</button>'}<button class="btn primary">Guardar</button></div>
    </form>`);
  if ($('#cancel')) $('#cancel').onclick = enter;
  $('#pf').onsubmit = async ev => {
    ev.preventDefault();
    const f = ev.target.elements;
    if (f.nueva.value !== f.rep.value) return toast('Las contraseñas nuevas no coinciden');
    try {
      await changePassword(f.actual.value, f.nueva.value);
      toast('Contraseña cambiada');
      enter();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'No hay conexión con el servidor');
    }
  };
}

function viewAccount() {
  if (!net.user) { location.hash = '#/'; return; }
  setHeader('Tu cuenta', '#/');
  setNav('');
  main().innerHTML = `<div class="card">
      <div class="card-title">${esc(net.user.nombre)}</div>
      <div class="muted">${esc(net.user.usuario)}</div>
    </div>
    <div class="card">
      <p style="margin-top:0" id="synctext"></p>
      <button class="btn block" id="syncnow">Sincronizar ahora</button>
    </div>
    <button class="btn block" id="chpass">Cambiar contraseña</button>
    ${net.user.admin ? '<a class="btn block" style="margin-top:8px" href="#/profesorado">Gestionar profesorado</a>' : ''}
    <button class="btn danger block" style="margin-top:8px" id="out">Cerrar sesión</button>`;
  showSync();
  $('#syncnow').onclick = async () => { await runSync(); showSync(); if (net.state === 'ok') toast('Sincronizado'); };
  $('#chpass').onclick = () => { state.gate = viewPassword; state.gate(); };
  $('#out').onclick = async () => {
    await runSync();
    if (net.pending && !confirm(`Hay ${net.pending} cambio(s) sin subir al servidor y se perderán. ¿Cerrar sesión igualmente?`)) return;
    await logout();
    await load();
    location.hash = '#/';
    showLogin();
  };
}

function showInvite(u) {
  const url = `${location.origin}${location.pathname}#/invitacion/${u.token}`;
  const body = `Hola, ${u.nombre.split(' ')[0]}:

Ya tienes cuenta en CapiTest, la aplicación para crear y corregir exámenes tipo test con el móvil.

Tu usuario: ${u.usuario}

Entra desde este enlace y elige tu contraseña:
${url}

El enlace caduca en 7 días y solo se puede usar una vez.`;
  const mail = `mailto:${encodeURIComponent(u.correo || '')}?subject=${encodeURIComponent('Tu cuenta de CapiTest')}&body=${encodeURIComponent(body)}`;
  const s = modal(u.enviado ? `<h3>Cuenta lista</h3>
    <p>CapiTest ha enviado el correo a <b>${esc(u.correo)}</b> con el enlace para elegir la contraseña.</p>
    <p class="muted small">Si no le llega, que mire en spam. También puedes copiar el enlace y dárselo tú; no se volverá a mostrar.</p>
    <button class="btn block" id="copy">Copiar el enlace</button>
    <div class="row end" style="margin-top:12px"><button class="btn primary" data-close>Hecho</button></div>` : `<h3>Cuenta lista</h3>
    <p>Envía el aviso a <b>${esc(u.correo || u.usuario)}</b>. El enlace no se volverá a mostrar.</p>
    <a class="btn primary block" id="mail" href="${esc(mail)}">Preparar el correo</a>
    <button class="btn block" style="margin-top:8px" id="copy">Copiar el enlace</button>
    <div class="row end" style="margin-top:12px"><button class="btn" data-close>Hecho</button></div>`);
  s.querySelector('#copy').onclick = async () => {
    try { await navigator.clipboard.writeText(url); toast('Enlace copiado'); } catch { prompt('Copia el enlace', url); }
  };
  s.querySelector('[data-close]').onclick = () => { closeModal(); viewUsers(); };
}

// Estado de la cuenta: invitación pendiente o caducada, o última entrada.
function userState(u, ahora) {
  const day = ts => new Date(ts * 1000).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
  if (u.invitacion && u.cambiar_clave) {
    return u.invitacion > ahora
      ? `<span class="badge warn">Invitación enviada</span> aún no ha elegido contraseña · el enlace caduca el ${day(u.invitacion)}`
      : '<span class="badge bad">Enlace caducado</span> pulsa «Nueva invitación» para enviarle otro';
  }
  return u.ultimo_acceso
    ? `<span class="badge ok">Activa</span> último acceso: ${fmtDate(u.ultimo_acceso * 1000)}`
    : '<span class="badge">Sin entrar todavía</span>';
}

async function viewUsers() {
  if (!net.user?.admin) { location.hash = '#/cuenta'; return; }
  setHeader('Profesorado', '#/cuenta');
  setNav('');
  let list, ahora, sol;
  try {
    ({ usuarios: list, ahora, solicitudes: sol = [] } = await api('usuarios'));
  } catch {
    main().innerHTML = '<p class="empty">Para gestionar el profesorado hace falta conexión con el servidor.</p>';
    return;
  }
  main().innerHTML = `${sol.length ? `<h2 class="section">Solicitudes pendientes</h2>
    ${sol.map(r => `<div class="card">
      <div class="card-title">${esc(r.nombre)}</div>
      <div class="muted small">${esc(r.correo)} · usuario: ${esc(r.usuario)}</div>
      <div class="small" style="margin-top:4px"><span class="badge warn">Pide acceso</span> ${fmtDate(r.creada * 1000)}</div>
      <div class="acciones">
        <button class="btn small primary" data-ok="${r.id}">Aceptar</button>
        <button class="btn small danger" data-no="${r.id}">Rechazar</button>
      </div>
    </div>`).join('')}
    <h2 class="section">Cuentas</h2>` : ''}
    <button class="btn primary block" id="nu">+ Nueva cuenta</button><div style="height:12px"></div>
    ${list.map(u => `<div class="card">
      <div class="card-title">${esc(u.nombre)}</div>
      <div class="muted small">${esc(u.usuario)}${u.correo ? ` · ${esc(u.correo)}` : ''}${u.admin ? ' · administración' : ''}${u.activo ? '' : ' · desactivada'}</div>
      <div class="small" style="margin-top:4px">${userState(u, ahora)}</div>
      <div class="acciones">
        <button class="btn small" data-edit="${u.id}">Editar</button>
        ${u.usuario === net.user.usuario ? '' : `<button class="btn small" data-reset="${u.id}">Nueva invitación</button>
        <button class="btn small" data-act="${u.id}" data-on="${u.activo ? 0 : 1}">${u.activo ? 'Desactivar' : 'Activar'}</button>
        <button class="btn small danger" data-del="${u.id}">Borrar</button>`}
      </div>
    </div>`).join('')}`;
  // Nueva cuenta. Desde una solicitud, sale rellena con sus datos para revisarlos antes de crearla.
  const newUser = (r = null) => {
    const s = modal(`<h3>${r ? 'Aceptar la solicitud' : 'Nueva cuenta'}</h3><form id="uf">
      ${r ? '<p class="small" style="margin-top:0">Comprueba que el usuario coincide con el de Séneca. Al crear la cuenta, le llegará el enlace para elegir su contraseña.</p>' : ''}
      <label class="field"><span>Nombre</span><input type="text" name="nombre" value="${esc(r?.nombre || '')}" required></label>
      <label class="field"><span>Usuario de Séneca</span><input type="text" name="usuario" value="${esc(r?.usuario || '')}" autocapitalize="none" spellcheck="false" placeholder="Por ejemplo: jperlop123" required></label>
      <label class="field"><span>Correo</span><input type="email" name="correo" value="${esc(r?.correo || '')}" autocapitalize="none" spellcheck="false" required></label>
      <div class="row end"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary">Crear</button></div></form>`);
    s.querySelector('[data-close]').onclick = closeModal;
    s.querySelector('#uf').onsubmit = async ev => {
      ev.preventDefault();
      const f = ev.target.elements;
      try {
        showInvite(await api('usuarios', { nombre: f.nombre.value, usuario: f.usuario.value, correo: f.correo.value, solicitud: r?.id }));
      } catch (e) { toast(e.message); }
    };
  };
  $('#nu').onclick = () => newUser();
  $$('[data-ok]').forEach(b => (b.onclick = () => newUser(sol.find(r => r.id === +b.dataset.ok))));
  $$('[data-no]').forEach(b => (b.onclick = async () => {
    const r = sol.find(x => x.id === +b.dataset.no);
    if (!confirm(`¿Rechazar la solicitud de ${r.nombre}? No se le avisará.`)) return;
    try { await api(`solicitudes/${r.id}/rechazar`, {}); toast('Solicitud rechazada'); viewUsers(); } catch (e) { toast(e.message); }
  }));
  $$('[data-edit]').forEach(b => (b.onclick = () => {
    const u = list.find(x => x.id === +b.dataset.edit);
    const mine = u.usuario === net.user.usuario;
    const s = modal(`<h3>Editar cuenta</h3><form id="uf">
      <label class="field"><span>Nombre</span><input type="text" name="nombre" value="${esc(u.nombre)}" required></label>
      <label class="field"><span>Usuario de Séneca</span><input type="text" name="usuario" value="${esc(u.usuario)}" autocapitalize="none" spellcheck="false" ${mine ? 'readonly' : ''} required></label>
      <label class="field"><span>Correo</span><input type="email" name="correo" value="${esc(u.correo || '')}" autocapitalize="none" spellcheck="false"></label>
      <div class="row end"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary">Guardar</button></div></form>`);
    s.querySelector('[data-close]').onclick = closeModal;
    s.querySelector('#uf').onsubmit = async ev => {
      ev.preventDefault();
      const f = ev.target.elements;
      try {
        await api(`usuarios/${u.id}`, { editar: true, nombre: f.nombre.value, usuario: f.usuario.value, correo: f.correo.value });
        closeModal();
        if (mine) { net.user = { ...net.user, nombre: f.nombre.value.trim() }; await db.setMeta('session', net.user); }
        viewUsers();
      } catch (e) { toast(e.message); }
    };
  }));
  $$('[data-del]').forEach(b => (b.onclick = () => {
    const u = list.find(x => x.id === +b.dataset.del);
    const s = modal(`<h3>Borrar a ${esc(u.nombre)}</h3>
      <div class="banner bad">Se borrarán su cuenta y <b>todos sus grupos, exámenes y notas</b>. No se puede deshacer.</div>
      <label class="field"><span>Escribe ${esc(u.usuario)} para confirmar</span><input type="text" id="sure" autocapitalize="none" spellcheck="false" autocomplete="off"></label>
      <div class="row end"><button class="btn" data-close>Cancelar</button><button class="btn danger" id="ok" disabled>Borrar</button></div>`);
    const sure = s.querySelector('#sure'), ok = s.querySelector('#ok');
    sure.oninput = () => { ok.disabled = sure.value.trim().toLowerCase() !== u.usuario; };
    s.querySelector('[data-close]').onclick = closeModal;
    ok.onclick = async () => {
      try {
        await api(`usuarios/${u.id}/borrar`, { usuario: sure.value });
        closeModal();
        toast(`${u.nombre} borrado`);
        viewUsers();
      } catch (e) { toast(e.message); }
    };
  }));
  $$('[data-reset]').forEach(b => (b.onclick = async () => {
    const u = list.find(x => x.id === +b.dataset.reset);
    if (!confirm(`¿Crear una invitación nueva para ${u.nombre}? Su contraseña dejará de valer y se cerrarán sus sesiones.`)) return;
    try {
      showInvite(await api(`usuarios/${u.id}`, { invitar: true }));
    } catch (e) { toast(e.message); }
  }));
  $$('[data-act]').forEach(b => (b.onclick = async () => {
    try { await api(`usuarios/${b.dataset.act}`, { activo: b.dataset.on === '1' }); viewUsers(); } catch (e) { toast(e.message); }
  }));
}

/* ---------- Arranque ---------- */

async function init() {
  await load();
  askPersistence();
  window.addEventListener('hashchange', route);
  startSync({
    apply: applyRemote,
    onState: showSync,
    onAuth: status => {
      if (status === 401) showLogin();
      else { state.gate = viewPassword; viewPassword(true); }
    },
  });
  const step = await detect();
  await load();
  showSync();
  const invite = location.hash.match(/^#\/invitacion\/([\w-]+)$/);
  if (invite && net.server) viewInvite(invite[1]);
  else if (step === 'login') showLogin();
  else if (step === 'password') { state.gate = viewPassword; viewPassword(true); }
  else if (step === 'needs-network') bare('CapiTest', '<p class="empty">Para entrar hace falta conexión con el servidor del centro.</p>');
  else { route(); runSync(); }
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
init();
