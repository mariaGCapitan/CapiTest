// Conexión con el servidor del centro. Sin servidor (GitHub Pages) todo sigue siendo local.
// Con servidor, cada cambio se guarda primero en el dispositivo y se sube después:
// así se puede corregir sin red y nada se pierde si la conexión falla.

import { db } from './db.js';

const HEADERS = { 'Content-Type': 'application/json', 'X-CapiTest': '1' };
const BATCH_BYTES = 8 * 1024 * 1024;
const BATCH_ITEMS = 100;
const EVERY_MS = 60000;

export const net = { server: false, user: null, state: 'off', pending: 0, lastSync: 0 };
let apply = async () => {};
let onState = () => {};
let onAuth = () => {};
let running = false, again = false, timer = null, debounce = null, seq = Date.now();

export class ApiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}
class NetworkError extends Error {}

export async function api(path, body, { timeout = 60000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(`api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: ctrl.signal,
    }).catch(e => { throw new NetworkError(e.message); });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new ApiError(data?.error || 'El servidor no ha podido atender la petición', r.status);
    return data;
  } finally {
    clearTimeout(t);
  }
}

function setState(state) {
  net.state = state;
  onState();
}

// Devuelve 'local', 'ready', 'login', 'password' o 'needs-network'.
export async function detect() {
  const status = await api('status', undefined, { timeout: 6000 }).catch(() => null);
  const reached = status?.app === 'CapiTest';
  const session = await db.getMeta('session');
  const known = await db.getMeta('serverMode');
  // Si ya se usó con servidor, un fallo del proxy no debe parecer «sin servidor»: sería ocultar los datos.
  if (!reached && !known) return 'local';
  net.server = true;
  await refreshPending();
  if (!reached) {
    if (!session) return 'needs-network';
    net.user = session;
    setState('offline');
    return 'ready';
  }
  await db.setMeta('serverMode', true);
  try {
    const { user } = await api('me');
    return await signedIn(user);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return 'login';
    if (session) { net.user = session; setState('offline'); return 'ready'; }
    return 'needs-network';
  }
}

async function signedIn(user) {
  net.user = user;
  const owner = await db.getMeta('session');
  // Un cambio de nombre de usuario sigue siendo la misma persona: no se borra lo que tenga sin subir.
  const same = owner && (owner.id && user.id ? owner.id === user.id : owner.usuario === user.usuario);
  if (owner && !same) await db.clearAll();
  await db.setMeta('serverMode', true);
  await db.setMeta('session', user);
  return user.cambiarClave ? 'password' : 'ready';
}

export async function login(usuario, clave) {
  const { user } = await api('login', { usuario, clave });
  return signedIn(user);
}

export async function acceptInvite(token, nueva) {
  const { user } = await api('invitacion', { token, nueva });
  return signedIn(user);
}

export async function changePassword(actual, nueva) {
  await api('clave', { actual, nueva });
  net.user = { ...net.user, cambiarClave: false };
  await db.setMeta('session', net.user);
}

export async function logout() {
  stop();
  try { await api('logout', {}); } catch { /* sin conexión: la sesión caduca sola */ }
  await db.clearAll();
  await db.setMeta('serverMode', true);
  net.user = null;
  net.pending = 0;
}

async function refreshPending() {
  net.pending = (await db.all('outbox')).length;
}

// Apunta un cambio para subirlo. Sin servidor no hace nada.
export async function queue(kind, id, doc, updated, deleted = false) {
  if (!net.server) return;
  await db.put('outbox', { key: `${kind}:${id}`, kind, id, doc: deleted ? null : doc, updated, deleted, seq: ++seq });
  await refreshPending();
  onState();
  clearTimeout(debounce);
  debounce = setTimeout(run, 1200);
}

function nextBatch(pending) {
  const batch = [];
  let size = 0;
  for (const p of pending) {
    const n = JSON.stringify(p.doc || '').length;
    if (batch.length && (size + n > BATCH_BYTES || batch.length >= BATCH_ITEMS)) break;
    batch.push(p);
    size += n;
  }
  return batch;
}

export async function run() {
  if (!net.server || !net.user || net.user.cambiarClave) return;
  if (running) { again = true; return; }
  running = true;
  setState('syncing');
  try {
    let since = (await db.getMeta('since')) || 0;
    const incoming = [];
    for (;;) {
      const pending = await db.all('outbox');
      const batch = nextBatch(pending);
      const res = await api('sync', {
        since,
        changes: batch.map(({ kind, id, doc, updated, deleted }) => ({ kind, id, doc, updated, deleted })),
      }, { timeout: 120000 });
      for (const p of batch) {
        const cur = await db.get('outbox', p.key);
        if (cur && cur.seq === p.seq) await db.del('outbox', p.key);
      }
      incoming.push(...res.changes);
      since = res.rev;
      if (!res.more && batch.length === pending.length) break;
    }
    const waiting = new Set((await db.all('outbox')).map(p => p.key));
    const fresh = incoming.filter(c => !waiting.has(`${c.kind}:${c.id}`));
    if (fresh.length) await apply(fresh);
    await db.setMeta('since', since);
    await refreshPending();
    net.lastSync = Date.now();
    setState('ok');
  } catch (e) {
    await refreshPending();
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      setState('auth');
      onAuth(e.status);
    } else {
      if (!(e instanceof NetworkError)) console.error(e);
      setState(e instanceof NetworkError ? 'offline' : 'error');
    }
  } finally {
    running = false;
    if (again) { again = false; setTimeout(run, 0); }
  }
}

export function start(handlers) {
  apply = handlers.apply;
  onState = handlers.onState;
  onAuth = handlers.onAuth;
  if (timer) return;
  timer = setInterval(() => { if (document.visibilityState === 'visible') run(); }, EVERY_MS);
  window.addEventListener('online', run);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') run(); });
}

function stop() {
  clearTimeout(debounce);
}
