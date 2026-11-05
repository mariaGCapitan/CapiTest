// Geometría de la hoja de respuestas, en milímetros sobre un A4 vertical.
// La usan a la vez el generador del PDF y el lector de la cámara.

// Cambia LAYOUT cuando se mueva algo que lee la cámara: las hojas impresas con otra geometría dejan de valer.
export const LAYOUT = 2;

export const SHEET = {
  w: 210,
  h: 297,
  markSize: 10,
  // Esquina superior izquierda de cada marca: TL, TR, BL, BR. Las de abajo, a 24 mm del borde,
  // porque muchas impresoras no imprimen la franja inferior.
  marks: [[10, 10], [190, 10], [10, 263], [190, 263]],
  qr: { x: 160, y: 26, size: 28 },
  grid: { top: 80, bottom: 259, left: 22, right: 188 },
  rowH: 6.4,
  numW: 9,
  optW: 7.5,
  gap: 6,
  r: 1.9, // radio de cada círculo (3,8 mm de diámetro)
};

export function markCenters() {
  const h = SHEET.markSize / 2;
  return SHEET.marks.map(([x, y]) => [x + h, y + h]);
}

const rowsMax = () => Math.floor((SHEET.grid.bottom - SHEET.grid.top) / SHEET.rowH);
const colWidth = nopt => SHEET.numW + nopt * SHEET.optW;
const colsMax = nopt => Math.floor((SHEET.grid.right - SHEET.grid.left + SHEET.gap) / (colWidth(nopt) + SHEET.gap));

export const maxQuestions = nopt => rowsMax() * colsMax(nopt);

// Posición de cada pregunta y de cada círculo.
export function bubbleLayout(nq, nopt) {
  const g = SHEET.grid;
  const cols = Math.max(1, Math.ceil(nq / rowsMax()));
  if (cols > colsMax(nopt)) throw new Error(`Caben como máximo ${maxQuestions(nopt)} preguntas`);
  const rows = Math.ceil(nq / cols);
  const cw = colWidth(nopt);
  const free = g.right - g.left - cols * cw;
  const gap = cols > 1 ? Math.min(18, free / (cols - 1)) : 0;
  const x0 = g.left + (free - gap * (cols - 1)) / 2;
  const colX = Array.from({ length: cols }, (_, c) => x0 + c * (cw + gap));
  const items = [];
  for (let i = 0; i < nq; i++) {
    const c = Math.floor(i / rows), r = i % rows;
    const y = g.top + r * SHEET.rowH + SHEET.rowH / 2;
    items.push({
      n: i + 1,
      x: colX[c],
      y,
      opts: Array.from({ length: nopt }, (_, j) => ({ x: colX[c] + SHEET.numW + j * SHEET.optW + SHEET.optW / 2, y })),
    });
  }
  return { cols, rows, colX, items };
}
