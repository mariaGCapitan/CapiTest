"""Servidor de CapiTest: cuentas de profesorado y sincronización entre dispositivos."""

import hashlib
import hmac
import os
import re
import secrets
import threading
from pathlib import Path

from flask import Flask, abort, g, jsonify, make_response, request, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix

import correo
import db

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_FILES = {'index.html', 'manual.html', 'manifest.webmanifest', 'sw.js'}
PUBLIC_DIRS = {'css', 'js', 'vendor', 'img', 'icons'}

COOKIE = 'capitest_sesion'
SESSION_DAYS = 30
MIN_PASSWORD = 10
LOCK_SECONDS = 15 * 60
MAX_FAILS = {'usuario': 8, 'ip': 30}
USER_RE = re.compile(r'^[a-z0-9._-]{3,40}$')
MAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
EDUCAAND_RE = re.compile(r'^[a-z0-9._-]+@g\.educaand\.es$')
INVITE_DAYS = 7
RESET_HOURS = 2

N, R, P = 2 ** 15, 8, 1
CSP = ("default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
       "media-src 'self' blob:; connect-src 'self' blob: data:; manifest-src 'self'; worker-src 'self'; "
       "frame-src blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")


def hash_password(password):
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(password.encode(), salt=salt, n=N, r=R, p=P, maxmem=128 * 1024 * 1024)
    return f'scrypt${N}${R}${P}${salt.hex()}${h.hex()}'


def check_password(password, stored):
    try:
        _, n, r, p, salt, h = stored.split('$')
        got = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p),
                             maxmem=128 * 1024 * 1024)
        return hmac.compare_digest(got.hex(), h)
    except (ValueError, TypeError):
        return False


DUMMY = hash_password(secrets.token_hex(16))


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def temp_password():
    abc = 'abcdefghijkmnpqrstuvwxyz23456789'
    groups = [''.join(secrets.choice(abc) for _ in range(4)) for _ in range(3)]
    return '-'.join(groups)


def create_app(database=None, secure=None, behind_proxy=None):
    app = Flask(__name__, static_folder=None)
    app.config['MAX_CONTENT_LENGTH'] = 64 * 1024 * 1024
    app.json.ensure_ascii = False
    app.json.sort_keys = False
    database = database or os.environ.get('CAPITEST_DB', str(ROOT / 'capitest-pruebas.db'))
    secure = secure if secure is not None else os.environ.get('CAPITEST_SECURE', '0') == '1'
    behind_proxy = behind_proxy if behind_proxy is not None else os.environ.get('CAPITEST_PROXY', '0') == '1'
    db.migrate(database)
    if behind_proxy:
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    def con():
        if 'con' not in g:
            g.con = db.connect(database)
        return g.con

    @app.teardown_appcontext
    def close(_exc):
        c = g.pop('con', None)
        if c is not None:
            c.close()

    def error(msg, code=400):
        return jsonify(error=msg), code

    def current_user():
        token = request.cookies.get(COOKIE)
        if not token:
            return None
        return con().execute(
            '''SELECT u.*, s.expira FROM sesiones s JOIN usuarios u ON u.id = s.user_id
               WHERE s.token = ? AND s.expira > ? AND u.activo = 1''',
            (token_hash(token), db.now()),
        ).fetchone()

    def public_user(u):
        return {'id': u['id'], 'usuario': u['usuario'], 'nombre': u['nombre'], 'admin': bool(u['admin']),
                'cambiarClave': bool(u['cambiar_clave'])}

    def body():
        data = request.get_json(silent=True)
        return data if isinstance(data, dict) else {}

    def need_user(admin=False, allow_password_change=False):
        u = current_user()
        if not u:
            abort(make_response(error('Hay que iniciar sesión', 401)))
        if u['cambiar_clave'] and not allow_password_change:
            abort(make_response(error('Hay que cambiar la contraseña', 403)))
        if admin and not u['admin']:
            abort(make_response(error('Solo para administración', 403)))
        return u

    def set_session(resp, uid):
        token = secrets.token_urlsafe(32)
        now = db.now()
        expires = now + SESSION_DAYS * 86400
        con().execute('INSERT INTO sesiones (token, user_id, creada, expira) VALUES (?, ?, ?, ?)',
                      (token_hash(token), uid, now, expires))
        con().execute('DELETE FROM sesiones WHERE expira <= ?', (now,))
        resp.set_cookie(COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True, secure=secure,
                        samesite='Strict', path='/')

    def new_invite(uid, seconds=INVITE_DAYS * 86400):
        token = secrets.token_urlsafe(32)
        con().execute('DELETE FROM invitaciones WHERE user_id = ?', (uid,))
        con().execute('INSERT INTO invitaciones (token, user_id, expira) VALUES (?, ?, ?)',
                      (token_hash(token), uid, db.now() + seconds))
        return token

    # Envía desde el servidor el correo con el enlace para elegir contraseña.
    # Añade enviado=True si ha salido; si no, la pantalla ofrece prepararlo a mano.
    def send_invite(out):
        cfg = correo.config()
        out['enviado'] = False
        if not (cfg and out.get('correo')):
            return out
        texto = (f"Hola, {out['nombre'].split(' ')[0]}:\n\n"
                 "Ya tienes cuenta en CapiTest, la aplicación para crear y corregir exámenes tipo test con el móvil.\n\n"
                 f"Tu usuario: {out['usuario']}\n\n"
                 f"Entra desde este enlace y elige tu contraseña:\n{cfg['url']}#/invitacion/{out['token']}\n\n"
                 f"El enlace caduca en {INVITE_DAYS} días y solo se puede usar una vez.")
        try:
            correo.enviar(out['correo'], 'Tu cuenta de CapiTest', texto, cfg)
            out['enviado'] = True
        except Exception as e:  # noqa: BLE001 — se apunta en el registro y se ofrece el envío a mano
            app.logger.error('No se ha podido enviar la invitación: %s', e)
        return out

    def invited_user(token):
        return con().execute(
            '''SELECT u.* FROM invitaciones i JOIN usuarios u ON u.id = i.user_id
               WHERE i.token = ? AND i.expira > ? AND u.activo = 1''',
            (token_hash(str(token)), db.now()),
        ).fetchone()

    def blocked(keys):
        now = db.now()
        return any(r and r['n'] >= MAX_FAILS[k] and r['hasta'] > now
                   for k, r in ((k, con().execute('SELECT n, hasta FROM fallos WHERE clave = ?', (v,)).fetchone())
                                for k, v in keys))

    def add_fail(keys):
        now = db.now()
        for _, v in keys:
            con().execute(
                '''INSERT INTO fallos (clave, n, hasta) VALUES (?, 1, ?)
                   ON CONFLICT (clave) DO UPDATE SET
                     n = CASE WHEN hasta > ? THEN n + 1 ELSE 1 END, hasta = excluded.hasta''',
                (v, now + LOCK_SECONDS, now))

    @app.before_request
    def csrf_guard():
        if request.path.startswith('/api/') and request.method != 'GET':
            if request.headers.get('X-CapiTest') != '1' or request.mimetype != 'application/json':
                return error('Petición no válida', 403)

    @app.after_request
    def headers(resp):
        resp.headers['Content-Security-Policy'] = CSP
        resp.headers['X-Content-Type-Options'] = 'nosniff'
        resp.headers['Referrer-Policy'] = 'no-referrer'
        resp.headers['Permissions-Policy'] = 'camera=(self), microphone=(), geolocation=()'
        resp.headers['Cache-Control'] = 'no-store' if request.path.startswith('/api/') else 'no-cache'
        return resp

    @app.errorhandler(413)
    def too_large(_e):
        return error('Los datos son demasiado grandes', 413)

    @app.get('/api/status')
    def status():
        return jsonify(app='CapiTest', api=1, correo=bool(correo.config()))

    # Contraseña olvidada: si la cuenta existe y tiene correo, se le envía un enlace de un solo uso.
    # La respuesta es siempre la misma, para no desvelar qué usuarios existen.
    @app.post('/api/olvido')
    def forgot():
        cfg = correo.config()
        if not cfg:
            return error('Este servidor no puede enviar correos. Pide a la administración un enlace nuevo.', 503)
        usuario = str(body().get('usuario', '')).strip().lower()[:80]
        ip = request.remote_addr or ''
        keys = [('usuario', f'olvido:{usuario}'), ('ip', f'olvido-ip:{ip}')]
        if blocked(keys):
            return error('Demasiadas peticiones. Espera 15 minutos.', 429)
        add_fail(keys)
        u = con().execute('SELECT * FROM usuarios WHERE usuario = ? AND activo = 1', (usuario,)).fetchone()
        if u and u['correo']:
            token = new_invite(u['id'], RESET_HOURS * 3600)
            db.log(con(), u['usuario'], 'pide cambiar la contraseña por correo', ip)
            texto = (f"Hola, {u['nombre'].split(' ')[0]}:\n\n"
                     f"Alguien ha pedido cambiar la contraseña de tu cuenta de CapiTest ({u['usuario']}).\n\n"
                     f"Para elegir una contraseña nueva, entra en este enlace:\n{cfg['url']}#/invitacion/{token}\n\n"
                     f"El enlace caduca en {RESET_HOURS} horas y solo se puede usar una vez. "
                     "Si no lo has pedido tú, no hagas nada: tu contraseña sigue igual.")
            destino = u['correo']

            def send():
                try:
                    correo.enviar(destino, 'Cambiar tu contraseña de CapiTest', texto, cfg)
                except Exception as e:  # noqa: BLE001 — se apunta en el registro del servicio
                    app.logger.error('No se ha podido enviar el correo de contraseña: %s', e)

            threading.Thread(target=send, daemon=True).start()
        elif usuario:
            db.log(con(), usuario, 'pide cambiar la contraseña (sin cuenta o sin correo)', ip)
        return jsonify(ok=True)

    # Registrarme: un profe nuevo pide acceso. Se avisa por correo a la cuenta que envía los correos
    # (la de /etc/capitest/correo.env); la cuenta se crea a mano en «Gestionar profesorado».
    @app.post('/api/registro')
    def register():
        cfg = correo.config()
        if not cfg:
            return error('Este servidor no puede enviar correos. Pide el acceso a la administración de CapiTest.', 503)
        d = body()
        nombre = ' '.join(str(d.get('nombre', '')).split())[:80]
        mail = str(d.get('correo', '')).strip().lower()[:120]
        if len(nombre) < 3:
            return error('Escribe tu nombre y apellidos')
        if not EDUCAAND_RE.match(mail):
            return error('Escribe tu correo de la Junta, que termina en @g.educaand.es')
        ip = request.remote_addr or ''
        keys = [('usuario', f'registro:{mail}'), ('ip', f'registro-ip:{ip}')]
        if blocked(keys):
            return error('Demasiadas peticiones. Espera 15 minutos.', 429)
        add_fail(keys)
        usuario = mail.split('@')[0]
        ya = con().execute('SELECT usuario FROM usuarios WHERE usuario = ? OR lower(correo) = ?',
                           (usuario, mail)).fetchone()
        db.log(con(), usuario, 'pide acceso (registrarme)', ip)
        texto = (f"{nombre} pide entrar en CapiTest.\n\n"
                 f"Correo: {mail}\n"
                 f"Usuario de Séneca (sale del correo, compruébalo): {usuario}\n\n"
                 + (f"Ojo: ya existe una cuenta con ese usuario o correo ({ya['usuario']}).\n\n" if ya else '')
                 + f"Para darle acceso, entra en {cfg['url']} con la cuenta de administración, "
                 "ve a «Gestionar profesorado» y crea la cuenta con ese usuario y ese correo. "
                 "Le llegará un enlace para elegir su contraseña.\n\n"
                 "Si no conoces a esta persona, no hagas nada.")

        def send():
            try:
                correo.enviar(cfg['usuario'], f'CapiTest: {nombre} pide acceso', texto, cfg)
            except Exception as e:  # noqa: BLE001 — se apunta en el registro del servicio
                app.logger.error('No se ha podido enviar el aviso de registro: %s', e)

        threading.Thread(target=send, daemon=True).start()
        return jsonify(ok=True)

    @app.post('/api/login')
    def login():
        d = body()
        usuario = str(d.get('usuario', '')).strip().lower()[:80]
        clave = str(d.get('clave', ''))[:200]
        ip = request.remote_addr or ''
        keys = [('usuario', f'u:{usuario}|{ip}'), ('ip', f'ip:{ip}')]
        if blocked(keys):
            db.log(con(), usuario, 'acceso bloqueado', ip)
            return error('Demasiados intentos. Espera 15 minutos.', 429)
        u = con().execute('SELECT * FROM usuarios WHERE usuario = ?', (usuario,)).fetchone()
        ok = check_password(clave, u['hash'] if u else DUMMY) and bool(u) and bool(u['activo'])
        if not ok:
            add_fail(keys)
            db.log(con(), usuario, 'acceso fallido', ip)
            return error('Usuario o contraseña incorrectos', 401)
        for _, v in keys:
            con().execute('DELETE FROM fallos WHERE clave = ?', (v,))
        db.log(con(), u['usuario'], 'acceso', ip)
        resp = jsonify(user=public_user(u))
        set_session(resp, u['id'])
        return resp

    @app.post('/api/invitacion/ver')
    def invite_info():
        ip = request.remote_addr or ''
        keys = [('ip', f'inv:{ip}')]
        if blocked(keys):
            return error('Demasiados intentos. Espera 15 minutos.', 429)
        u = invited_user(body().get('token', ''))
        if not u:
            add_fail(keys)
            return error('Este enlace ya no vale. Pide uno nuevo.', 404)
        return jsonify(usuario=u['usuario'], nombre=u['nombre'])

    @app.post('/api/invitacion')
    def accept_invite():
        d = body()
        ip = request.remote_addr or ''
        keys = [('ip', f'inv:{ip}')]
        if blocked(keys):
            return error('Demasiados intentos. Espera 15 minutos.', 429)
        u = invited_user(d.get('token', ''))
        if not u:
            add_fail(keys)
            return error('Este enlace ya no vale. Pide uno nuevo.', 404)
        nueva = str(d.get('nueva', ''))[:200]
        if len(nueva) < MIN_PASSWORD:
            return error(f'La contraseña debe tener al menos {MIN_PASSWORD} caracteres')
        con().execute('UPDATE usuarios SET hash = ?, cambiar_clave = 0 WHERE id = ?', (hash_password(nueva), u['id']))
        con().execute('DELETE FROM invitaciones WHERE user_id = ?', (u['id'],))
        con().execute('DELETE FROM sesiones WHERE user_id = ?', (u['id'],))
        db.log(con(), u['usuario'], 'contraseña elegida con invitación', ip)
        fresh = con().execute('SELECT * FROM usuarios WHERE id = ?', (u['id'],)).fetchone()
        resp = jsonify(user=public_user(fresh))
        set_session(resp, u['id'])
        return resp

    @app.post('/api/logout')
    def logout():
        token = request.cookies.get(COOKIE)
        if token:
            con().execute('DELETE FROM sesiones WHERE token = ?', (token_hash(token),))
        resp = jsonify(ok=True)
        resp.delete_cookie(COOKIE, path='/')
        return resp

    @app.get('/api/me')
    def me():
        u = need_user(allow_password_change=True)
        return jsonify(user=public_user(u))

    @app.post('/api/clave')
    def change_password():
        u = need_user(allow_password_change=True)
        d = body()
        actual, nueva = str(d.get('actual', ''))[:200], str(d.get('nueva', ''))[:200]
        if not check_password(actual, u['hash']):
            db.log(con(), u['usuario'], 'cambio de contraseña fallido', request.remote_addr)
            return error('La contraseña actual no es correcta')
        if len(nueva) < MIN_PASSWORD:
            return error(f'La contraseña nueva debe tener al menos {MIN_PASSWORD} caracteres')
        if nueva == actual:
            return error('La contraseña nueva debe ser distinta')
        con().execute('UPDATE usuarios SET hash = ?, cambiar_clave = 0 WHERE id = ?', (hash_password(nueva), u['id']))
        con().execute('DELETE FROM sesiones WHERE user_id = ?', (u['id'],))
        db.log(con(), u['usuario'], 'contraseña cambiada', request.remote_addr)
        resp = jsonify(ok=True)
        set_session(resp, u['id'])
        return resp

    @app.post('/api/sync')
    def sync():
        u = need_user()
        d = body()
        since, changes = d.get('since', 0), d.get('changes', [])
        if not isinstance(since, int) or isinstance(since, bool) or since < 0 or not isinstance(changes, list):
            return error('Datos no válidos')
        try:
            return jsonify(db.sync(con(), u['id'], since, changes))
        except ValueError as e:
            return error(str(e))

    @app.get('/api/usuarios')
    def list_users():
        need_user(admin=True)
        rows = con().execute('SELECT id, usuario, nombre, correo, admin, activo FROM usuarios ORDER BY nombre').fetchall()
        return jsonify(usuarios=[{**dict(r), 'admin': bool(r['admin']), 'activo': bool(r['activo'])} for r in rows])

    @app.post('/api/usuarios')
    def add_user():
        adm = need_user(admin=True)
        d = body()
        usuario = str(d.get('usuario', '')).strip().lower()
        nombre = str(d.get('nombre', '')).strip()[:80]
        correo = str(d.get('correo', '')).strip()[:120]
        if not USER_RE.match(usuario):
            return error('El usuario debe tener de 3 a 40 letras sin espacios')
        if not nombre:
            return error('Escribe el nombre')
        if not MAIL_RE.match(correo):
            return error('Escribe un correo válido')
        try:
            cur = con().execute('INSERT INTO usuarios (usuario, nombre, correo, hash, creado) VALUES (?, ?, ?, ?, ?)',
                                (usuario, nombre, correo, hash_password(secrets.token_hex(32)), db.now()))
        except db.sqlite3.IntegrityError:
            return error('Ese usuario ya existe')
        db.log(con(), adm['usuario'], f'crea el usuario {usuario}', request.remote_addr)
        out = dict(usuario=usuario, nombre=nombre, correo=correo, token=new_invite(cur.lastrowid))
        return jsonify(send_invite(out))

    @app.post('/api/usuarios/<int:uid>')
    def edit_user(uid):
        adm = need_user(admin=True)
        d = body()
        target = con().execute('SELECT * FROM usuarios WHERE id = ?', (uid,)).fetchone()
        if not target:
            return error('No existe', 404)
        out = {}
        if d.get('editar'):
            usuario = str(d.get('usuario', '')).strip().lower()
            nombre = str(d.get('nombre', '')).strip()[:80]
            correo = str(d.get('correo', '')).strip()[:120]
            if not USER_RE.match(usuario):
                return error('El usuario debe tener de 3 a 40 letras sin espacios')
            if not nombre:
                return error('Escribe el nombre')
            if correo and not MAIL_RE.match(correo):
                return error('Escribe un correo válido')
            if uid == adm['id'] and usuario != adm['usuario']:
                return error('No puedes cambiar tu propio usuario')
            try:
                con().execute('UPDATE usuarios SET usuario = ?, nombre = ?, correo = ? WHERE id = ?',
                              (usuario, nombre, correo or None, uid))
            except db.sqlite3.IntegrityError:
                return error('Ese usuario ya existe')
            db.log(con(), adm['usuario'], f"edita a {target['usuario']}", request.remote_addr)
        if d.get('invitar'):
            out.update(usuario=target['usuario'], nombre=target['nombre'], correo=target['correo'],
                       token=new_invite(uid))
            send_invite(out)
            con().execute('UPDATE usuarios SET hash = ?, cambiar_clave = 1 WHERE id = ?',
                          (hash_password(secrets.token_hex(32)), uid))
            con().execute('DELETE FROM sesiones WHERE user_id = ?', (uid,))
            db.log(con(), adm['usuario'], f"invita de nuevo a {target['usuario']}", request.remote_addr)
        if 'activo' in d:
            if uid == adm['id']:
                return error('No puedes desactivar tu propia cuenta')
            con().execute('UPDATE usuarios SET activo = ? WHERE id = ?', (int(bool(d['activo'])), uid))
            if not d['activo']:
                con().execute('DELETE FROM sesiones WHERE user_id = ?', (uid,))
            db.log(con(), adm['usuario'], f"{'activa' if d['activo'] else 'desactiva'} a {target['usuario']}",
                   request.remote_addr)
        return jsonify(ok=True, **out)

    @app.post('/api/usuarios/<int:uid>/borrar')
    def delete_user(uid):
        adm = need_user(admin=True)
        target = con().execute('SELECT * FROM usuarios WHERE id = ?', (uid,)).fetchone()
        if not target:
            return error('No existe', 404)
        if uid == adm['id']:
            return error('No puedes borrar tu propia cuenta')
        if str(body().get('usuario', '')).strip().lower() != target['usuario']:
            return error('El usuario escrito no coincide')
        con().execute('DELETE FROM usuarios WHERE id = ?', (uid,))
        db.log(con(), adm['usuario'], f"borra a {target['usuario']} y sus datos", request.remote_addr)
        return jsonify(ok=True)

    @app.get('/')
    def home():
        return send_from_directory(ROOT, 'index.html')

    @app.get('/<path:p>')
    def public(p):
        parts = p.split('/')
        if '..' in parts or '' in parts or '\\' in p:
            abort(404)
        if p in PUBLIC_FILES or (len(parts) > 1 and parts[0] in PUBLIC_DIRS):
            return send_from_directory(ROOT, p)
        abort(404)

    return app


app = None
if os.environ.get('CAPITEST_DB'):
    app = create_app()
