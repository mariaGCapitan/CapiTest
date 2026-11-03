// Nota y estadísticas. Las respuestas se guardan por pregunta y por opción original,
// así que si cambia la clave, la penalización o se anula una pregunta, la nota se recalcula sola.
// Valor de cada respuesta: índice de la opción original, null (en blanco) o 'M' (varias marcadas).

export const nopt = exam => Math.max(2, ...exam.questions.map(q => q.options.length));

export function grade(exam, answers) {
  let c = 0, w = 0, b = 0;
  const qs = exam.questions.filter(q => !q.annulled);
  for (const q of qs) {
    const a = answers[q.id];
    if (a === null || a === undefined || a === 'M') b++;
    else if (a === q.correct) c++;
    else w++;
  }
  const N = qs.length;
  const raw = c - w * (exam.penalty || 0);
  const nota = N ? Math.max(0, raw) / N * 10 : 0;
  return { c, w, b, N, nota };
}

export function summary(exam) {
  const res = Object.values(exam.results || {});
  const notas = res.map(r => grade(exam, r.answers).nota);
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
      if (a === null || a === undefined || a === 'M') blank++;
      else { counts[a] = (counts[a] || 0) + 1; if (a === q.correct) ok++; }
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
