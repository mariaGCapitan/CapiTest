// Seudónimos del alumnado con el formato del centro: «ARI. MON., F.».
// La conversión ocurre en el navegador: el nombre real nunca llega al servidor.

const PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'i', 'da', 'do', 'dos', 'van', 'von']);
const FORMAT = /^\p{Lu}{1,3}\.( \p{Lu}{1,3}\.)?, \p{Lu}{1,3}\.\d?$/u;

const upper = s => s.toLocaleUpperCase('es');
const firstLetters = (word, n) => upper([...word].slice(0, n).join(''));

export const isPseudonym = name => FORMAT.test(String(name).trim());

// Devuelve { value } o { error }.
export function toPseudonym(name) {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return { error: 'Está vacío' };
  if (isPseudonym(clean)) return { value: clean };
  const cut = clean.indexOf(',');
  if (cut < 0) return { error: 'Falta la coma: escribe «Apellidos, Nombre»' };
  const surnames = clean.slice(0, cut).split(/[\s-]+/)
    .filter(w => w && !PARTICLES.has(w.toLocaleLowerCase('es')))
    .map(w => w.replace(/[^\p{L}]/gu, ''))
    .filter(Boolean);
  const given = clean.slice(cut + 1).trim().replace(/[^\p{L} ]/gu, '').trim();
  if (!surnames.length) return { error: 'Faltan los apellidos' };
  if (!given) return { error: 'Falta el nombre' };
  const parts = surnames.slice(0, 2).map(w => `${firstLetters(w, 3)}.`).join(' ');
  return { value: `${parts}, ${firstLetters(given, 1)}.` };
}

// Nombres de la hoja «Mis alumnos y alumnas» de Séneca. El correo de la otra columna no se lee.
export function parseSeneca(rows) {
  const head = rows.findIndex(r => String(r[0] ?? '').trim().toLowerCase() === 'alumno');
  if (head < 0) return null;
  const names = rows.slice(head + 1).map(r => String(r[0] ?? '').trim()).filter(Boolean);
  return names.length ? names : null;
}

// Analiza una lista. existing son los seudónimos que ya están en el grupo.
export function checkList(names, existing = []) {
  const taken = new Set(existing);
  const seen = new Map();
  const rows = names.map(name => {
    const { value, error } = toPseudonym(name);
    if (value) seen.set(value, (seen.get(value) || 0) + 1);
    return { value: value || '', error: error || '' };
  });
  for (const r of rows) {
    if (r.error) continue;
    if (seen.get(r.value) > 1) r.error = 'Seudónimo repetido: cambia uno para distinguirlos';
    else if (taken.has(r.value)) r.existing = true;
  }
  return rows;
}
