// Excel con las notas, las respuestas y el análisis de cada pregunta.

import { grade, questionStats, testPoints, multiOf } from './grading.js';
import { LETTERS, fmtNum, safeName, plural } from './util.js';

export function examExcel(exam, group) {
  const XLSX = window.XLSX;
  const names = Object.fromEntries((group?.students || []).map(s => [s.id, s.name]));
  const results = exam.results || {};
  const students = [...(group?.students || [])];
  for (const [sid, r] of Object.entries(results)) if (!names[sid]) students.push({ id: sid, name: r.name || '(fuera del grupo)' });

  const open = exam.open || [];
  const N = exam.questions.length;
  const r2 = x => Math.round(x * 100) / 100;
  const extra = open.length ? [`Test (sobre ${fmtNum(testPoints(exam))})`, ...open.map((q, i) => `P${N + i + 1} (sobre ${fmtNum(q.points)})`), 'Falta nota a mano'] : [];
  const anyMulti = exam.questions.some(multiOf);
  const notas = [['Alumno/a', 'Nota', ...extra, 'Aciertos', ...(anyMulti ? ['En parte'] : []), 'Errores', 'En blanco', 'Hoja']];
  for (const s of students) {
    const r = results[s.id];
    if (!r) { notas.push([s.name, 'Sin corregir', ...extra.map(() => ''), ...(anyMulti ? [''] : []), '', '', '', '']); continue; }
    const g = grade(exam, r.answers, r.open);
    const byHand = open.length ? [r2(g.test), ...open.map(q => (typeof r.open?.[q.id] === 'number' ? r.open[q.id] : '')), g.pending ? plural(g.pending, 'pregunta', 'preguntas') : ''] : [];
    notas.push([s.name, r2(g.nota), ...byHand, g.c, ...(anyMulti ? [g.p] : []), g.w, g.b, r.sheetId.startsWith('R') ? `Reserva ${r.sheetId}` : 'Personal']);
  }

  const qs = exam.questions;
  const key = q => (multiOf(q) || [q.correct]).map(i => LETTERS[i]).join('');
  const letter = (q, a) => (a === null || a === undefined ? '' : a === 'M' ? 'Varias' : Array.isArray(a) ? a.map(i => LETTERS[i]).join('') : LETTERS[a]);
  const resp = [['Alumno/a', ...qs.map((_, i) => `P${i + 1}`)], ['CLAVE', ...qs.map(q => (q.annulled ? 'Anulada' : key(q)))]];
  for (const s of students) {
    const r = results[s.id];
    if (r) resp.push([s.name, ...qs.map(q => letter(q, r.answers[q.id]))]);
  }

  const nmax = Math.max(...qs.map(q => q.options.length));
  const preg = [['Nº', 'Pregunta', 'Correcta', '% aciertos', '% errores', '% en blanco', ...LETTERS.slice(0, nmax).split(''), 'Anulada']];
  for (const [i, st] of questionStats(exam).entries()) {
    const pc = x => (st.n ? Math.round(x / st.n * 1000) / 10 : '');
    const enun = (st.q.text || st.q.code || '').replace(/\s+/g, ' ').slice(0, 120);
    preg.push([i + 1, enun, key(st.q), pc(st.ok), pc(st.wrong), pc(st.blank),
      ...LETTERS.slice(0, nmax).split('').map((_, j) => (j < st.q.options.length ? st.counts[j] : '')), st.q.annulled ? 'Sí' : '']);
  }

  const wb = XLSX.utils.book_new();
  const add = (rows, name, cols) => {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = cols.map(wch => ({ wch }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  add(notas, 'Notas', [34, 12, ...extra.map(() => 13), 10, 10, 10, 14]);
  add(resp, 'Respuestas', [34, ...qs.map(() => 7)]);
  add(preg, 'Preguntas', [5, 60, 9, 11, 11, 12, ...Array(nmax).fill(5), 9]);
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  return { blob, filename: `CapiTest_${safeName(exam.title)}.xlsx` };
}
