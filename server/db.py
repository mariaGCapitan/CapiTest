"""Base de datos de CapiTest (SQLite): un solo archivo, fuera de la carpeta del código."""

import json
import re
import sqlite3
import time

VERSION = 3

SCHEMA = """
CREATE TABLE usuarios (
  id INTEGER PRIMARY KEY,
  usuario TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nombre TEXT NOT NULL,
  hash TEXT NOT NULL,
  admin INTEGER NOT NULL DEFAULT 0,
  activo INTEGER NOT NULL DEFAULT 1,
  cambiar_clave INTEGER NOT NULL DEFAULT 1,
  creado INTEGER NOT NULL
);
CREATE TABLE sesiones (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  creada INTEGER NOT NULL,
  expira INTEGER NOT NULL
);
-- Cada grupo, examen, resultado de un alumno/a y ajustes es un documento JSON propio de un profe.
-- rev crece con cada cambio: cada dispositivo pide lo que haya desde la última rev que vio.
CREATE TABLE items (
  user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('group', 'exam', 'result', 'settings')),
  id TEXT NOT NULL,
  doc TEXT,
  updated INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, id)
);
CREATE INDEX items_rev ON items(user_id, rev);
CREATE TABLE contador (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL);
INSERT INTO contador VALUES (1, 0);
CREATE TABLE fallos (clave TEXT PRIMARY KEY, n INTEGER NOT NULL, hasta INTEGER NOT NULL);
-- Registro de accesos y administración. Nunca guarda contraseñas ni notas.
CREATE TABLE eventos (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  usuario TEXT,
  accion TEXT NOT NULL,
  ip TEXT
);
"""

# Las migraciones solo añaden: si una actualización vuelve atrás, el código anterior sigue funcionando.
SCHEMA_2 = """
ALTER TABLE usuarios ADD COLUMN correo TEXT;
-- Enlace de un solo uso para que cada profe elija su contraseña. Se guarda solo la huella del enlace.
CREATE TABLE invitaciones (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira INTEGER NOT NULL
);
"""

# Peticiones de «Registrarme» que esperan a que administración las acepte o las rechace.
SCHEMA_3 = """
CREATE TABLE solicitudes (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  correo TEXT NOT NULL UNIQUE,
  usuario TEXT NOT NULL,
  creada INTEGER NOT NULL
);
"""

KINDS = ('group', 'exam', 'result', 'settings')
ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,40}(/[A-Za-z0-9_-]{1,40})?$')
PAGE_ROWS = 200
PAGE_BYTES = 8 * 1024 * 1024
MAX_FUTURE_MS = 86_400_000


def connect(path):
    con = sqlite3.connect(path, timeout=20, isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA foreign_keys = ON')
    con.execute('PRAGMA journal_mode = WAL')
    con.execute('PRAGMA synchronous = NORMAL')
    return con


def _statements(sql):
    current = ''
    for line in sql.splitlines(keepends=True):
        current += line
        if sqlite3.complete_statement(current):
            yield current
            current = ''


def migrate(path):
    con = connect(path)
    try:
        # BEGIN IMMEDIATE: los dos procesos del servidor arrancan a la vez y solo uno debe migrar.
        con.execute('BEGIN IMMEDIATE')
        version = con.execute('PRAGMA user_version').fetchone()[0]
        for number, sql in ((1, SCHEMA), (2, SCHEMA_2), (3, SCHEMA_3)):
            if version < number:
                for statement in _statements(sql):
                    con.execute(statement)
        con.execute(f'PRAGMA user_version = {max(version, VERSION)}')
        con.execute('COMMIT')
    except Exception:
        con.execute('ROLLBACK')
        raise
    finally:
        con.close()


def now():
    return int(time.time())


def log(con, usuario, accion, ip=None):
    con.execute('INSERT INTO eventos (at, usuario, accion, ip) VALUES (?, ?, ?, ?)', (now(), usuario, accion, ip))


def _next_rev(con):
    return con.execute('UPDATE contador SET rev = rev + 1 WHERE id = 1 RETURNING rev').fetchone()[0]


def _valid(c):
    return (isinstance(c, dict) and c.get('kind') in KINDS and isinstance(c.get('id'), str)
            and ID_RE.match(c['id']) and isinstance(c.get('updated'), int) and not isinstance(c.get('updated'), bool)
            and c['updated'] >= 0 and (bool(c.get('deleted')) or isinstance(c.get('doc'), dict)))


def _row_out(r):
    return {
        'kind': r['kind'], 'id': r['id'], 'updated': r['updated'], 'deleted': bool(r['deleted']),
        'doc': json.loads(r['doc']) if r['doc'] else None,
    }


def _store(con, uid, kind, id_, doc, updated, deleted):
    con.execute(
        '''INSERT INTO items (user_id, kind, id, doc, updated, deleted, rev) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id, kind, id) DO UPDATE SET
             doc = excluded.doc, updated = excluded.updated, deleted = excluded.deleted, rev = excluded.rev''',
        (uid, kind, id_, doc, updated, int(deleted), _next_rev(con)),
    )


def sync(con, uid, since, changes):
    """Aplica los cambios del dispositivo y devuelve lo que este aún no tiene.

    Entre dos versiones gana la más reciente. Las notas son documentos separados del examen:
    dos móviles pueden corregir a la vez a alumnado distinto sin pisarse.
    """
    limit = int(time.time() * 1000) + MAX_FUTURE_MS
    accepted, rejected, back = [], [], []
    con.execute('BEGIN IMMEDIATE')
    try:
        first = con.execute('SELECT rev FROM contador').fetchone()[0]
        for c in changes:
            if not _valid(c):
                raise ValueError('Cambio no válido')
            kind, id_ = c['kind'], c['id']
            updated = min(c['updated'], limit)
            deleted = bool(c.get('deleted'))
            key = {'kind': kind, 'id': id_}
            old = con.execute('SELECT * FROM items WHERE user_id = ? AND kind = ? AND id = ?', (uid, kind, id_)).fetchone()
            orphan = False
            if kind == 'result':
                exam = con.execute("SELECT deleted FROM items WHERE user_id = ? AND kind = 'exam' AND id = ?",
                                   (uid, id_.split('/')[0])).fetchone()
                orphan = bool(exam and exam['deleted'])
            if orphan or (old and old['updated'] > updated):
                rejected.append(key)
                if old:
                    back.append(_row_out(old))
                elif orphan:
                    back.append({**key, 'updated': updated, 'deleted': True, 'doc': None})
                continue
            doc = None if deleted else json.dumps(c['doc'], ensure_ascii=False, separators=(',', ':'))
            _store(con, uid, kind, id_, doc, updated, deleted)
            accepted.append(key)
            if kind == 'exam' and deleted:
                rows = con.execute("SELECT id FROM items WHERE user_id = ? AND kind = 'result' AND deleted = 0 AND id LIKE ?",
                                   (uid, id_ + '/%')).fetchall()
                for r in rows:
                    _store(con, uid, 'result', r['id'], None, updated, True)
        last = con.execute('SELECT rev FROM contador').fetchone()[0]
        con.execute('COMMIT')
    except Exception:
        con.execute('ROLLBACK')
        raise

    rows = con.execute(
        '''SELECT * FROM items WHERE user_id = ? AND rev > ? AND NOT (rev > ? AND rev <= ?)
           ORDER BY rev LIMIT ?''',
        (uid, since, first, last, PAGE_ROWS + 1),
    ).fetchall()
    out, size, more, rev = list(back), 0, False, since
    for i, r in enumerate(rows):
        size += len(r['doc'] or '')
        if i >= PAGE_ROWS or (out and size > PAGE_BYTES):
            more = True
            break
        out.append(_row_out(r))
        rev = r['rev']
    if not more:
        rev = max(rev, last, since)
    return {'rev': rev, 'more': more, 'accepted': accepted, 'rejected': rejected, 'changes': out}
