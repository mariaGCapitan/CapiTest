// Nota y estadísticas. Las respuestas se guardan por pregunta y por opción original,
// así que si cambia la clave, la penalización o se anula una pregunta, la nota se recalcula sola.
// Valor de cada respuesta: índice de la opción original, null (en blanco) o 'M' (varias marcadas).
// En las preguntas de varias respuestas (q.multi, índices originales de las correctas), la respuesta es la lista
// de opciones marcadas. Puntúa como Moodle: cada correcta marcada suma 1/correctas, cada incorrecta marcada resta
// 1/incorrectas y la pregunta nunca baja de 0. No se le aplica la penalización del examen.

export const multiOf = q => (q.multi?.length > 1 ? q.multi : null);
export const marks = a => (Array.isArray(a) ? a : typeof a === 'number' ? [a] : []);

// Puntos de una pregunta (de 0 a 1) y cómo cuenta: 'c' acierto, 'w' fallo (o parcial), 'b' en blanco.
export function qScore(q, a) {
  const multi = multiOf(q);
  if (!multi) {
    if (a === null || a === undefined || a === 'M' || Array.isArray(a)) return { kind: 'b', pts: 0 };
    return a === q.correct ? { kind: 'c', pts: 1 } : { kind: 'w', pts: 0 };
  }
  const m = marks(a);
  if (!m.length) return { kind: 'b', pts: 0 };
  const nWrong = q.options.length - multi.length;
  let pts = 0;
  for (const i of m) pts += multi.includes(i) ? 1 / multi.length : nWrong ? -1 / nWrong : 0;
  pts = Math.max(0, Math.min(1, pts));
  return { kind: pts > 1 - 1e-9 ? 'c' : 'w', pts };
}

export const nopt = exam => Math.max(2, ...exam.questions.map(q => q.options.length));

// Lo que vale el test sobre 10. Sin preguntas para corregir a mano, el test lo vale todo.
export const testPoints = exam => (exam.open?.length ? (exam.testPoints ?? 10) : 10);

// openScores: nota puesta a mano en cada pregunta abierta; si falta alguna, queda pendiente.
export function grade(exam, answers, openScores = null) {
  let c = 0, p = 0, w = 0, b = 0, raw = 0;
  const qs = exam.questions.filter(q => !q.annulled);
  for (const q of qs) {
    const { kind, pts } = qScore(q, answers[q.id]);
    // p: preguntas de varias respuestas acertadas solo en parte.
    if (kind === 'c') c++; else if (kind === 'w' && pts > 0) p++; else if (kind === 'w') w++; else b++;
    // Las de una respuesta restan la penalización del examen; las de varias ya traen su resta en pts.
    raw += multiOf(q) ? pts : kind === 'c' ? 1 : kind === 'w' ? -(exam.penalty || 0) : 0;
  }
  const N = qs.length;
  const test = N ? Math.max(0, raw) / N * testPoints(exam) : 0;
  let manual = 0, pending = 0;
  for (const q of exam.open || []) {
    const s = openScores?.[q.id];
    if (typeof s === 'number') manual += s; else pending++;
  }
  return { c, p, w, b, N, test, manual, pending, nota: Math.min(10, test + manual) };
}

export function summary(exam) {
  const res = Object.values(exam.results || {});
  const notas = res.map(r => grade(exam, r.answers, r.open).nota);
  const media = notas.length ? notas.reduce((a, b) => a + b, 0) / notas.length : 0;
  return { n: notas.length, media, aprobados: notas.filter(n => n >= 5).length };
}

export function questionStats(exam) {
  const res = Object.values(exam.results || {});
  return exam.questions.map(q => {
    const counts = q.options.map(() => 0);
    let blank = 0, ok = 0;
    for (const r of res) {
      const a = r.answers[q.id];
      const { kind } = qScore(q, a);
      if (kind === 'b') { blank++; continue; }
      for (const i of marks(a)) counts[i] = (counts[i] || 0) + 1;
      if (kind === 'c') ok++;
    }
    const n = res.length;
    return { q, n, counts, blank, ok, wrong: n - ok - blank, pct: n ? ok / n : 0 };
  });
}

// Versión de una hoja: orden de preguntas y de opciones que vio esa persona.
export function versionFor(exam, result, studentId) {
  const p = exam.printed;
  const v = p && ((result && p.sheets[result.sheetId]) || p.sheets[studentId]);
  if (v) return v;
  const order = exam.questions.map(q => q.id);
  const perm = Object.fromEntries(exam.questions.map(q => [q.id, q.options.map((_, i) => i)]));
  return { order, perm };
}
