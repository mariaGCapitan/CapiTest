// Visor de cámara: busca la hoja en directo y, cuando está quieta, hace la lectura completa.

import { quickFind, analyze } from './omr.js';

const PREVIEW = 720; // resolución de la búsqueda en directo

export class Scanner {
  constructor(video, overlay, msg, onCapture) {
    Object.assign(this, { video, overlay, msg, onCapture });
    this.work = document.createElement('canvas');
    this.full = document.createElement('canvas');
    this.running = false;
    this.paused = false;
    this.last = null;
    this.stable = 0;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play();
    this.running = true;
    this.say('Encuadra la hoja entera, con los cuatro cuadrados de las esquinas a la vista.');
    this.loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach(t => t.stop());
    this.video.srcObject = null;
  }

  resume() {
    this.paused = false;
    this.stable = 0;
    this.last = null;
    this.say('Siguiente hoja…');
    this.loop();
  }

  say(t) { this.msg.textContent = t; }

  loop() {
    clearTimeout(this.timer);
    if (!this.running || this.paused) return;
    try { this.tick(); } catch (e) { console.error(e); }
    if (this.running && !this.paused) this.timer = setTimeout(() => this.loop(), 150);
  }

  tick() {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw) return;
    const s = Math.min(1, PREVIEW / Math.max(vw, vh));
    const w = Math.round(vw * s), h = Math.round(vh * s);
    this.work.width = w; this.work.height = h;
    const ctx = this.work.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(this.video, 0, 0, w, h);
    const pts = quickFind(ctx.getImageData(0, 0, w, h));
    this.drawOverlay(pts, w, h);
    if (!pts) { this.stable = 0; this.last = null; this.say('Buscando los cuatro cuadrados de las esquinas…'); return; }
    const moved = this.last ? Math.max(...pts.map((p, i) => Math.hypot(p[0] - this.last[i][0], p[1] - this.last[i][1]))) : Infinity;
    this.last = pts;
    this.stable = moved < Math.max(w, h) * 0.012 ? this.stable + 1 : 0;
    if (this.stable < 2) { this.say('Hoja encontrada. No te muevas…'); return; }
    this.capture();
  }

  capture() {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    this.full.width = vw; this.full.height = vh;
    this.full.getContext('2d', { willReadFrequently: true }).drawImage(this.video, 0, 0, vw, vh);
    const an = analyze(this.full);
    if (!an.ok) { this.say(an.reason); this.stable = 0; return; }
    this.paused = true;
    if (navigator.vibrate) navigator.vibrate(60);
    this.onCapture(an);
  }

  drawOverlay(pts, w, h) {
    const o = this.overlay;
    o.width = w; o.height = h;
    const ctx = o.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (!pts) return;
    ctx.strokeStyle = this.stable >= 1 ? '#51cf66' : '#ffd43b';
    ctx.lineWidth = 4;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
    ctx.closePath();
    ctx.stroke();
  }
}

// Lectura desde una foto guardada (o hecha con la app de cámara).
export async function analyzeFile(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  const c = document.createElement('canvas');
  const s = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0, c.width, c.height);
  return analyze(c);
}
