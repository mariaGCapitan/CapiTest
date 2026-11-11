"""Pruebas del servidor: python -m unittest server/test_api.py (desde la raíz, con Flask instalado)."""

import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import app as srv
import db

H = {'X-CapiTest': '1'}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.tmp.name) / 't.db')
        self.app = srv.create_app(database=self.path, secure=False, behind_proxy=False)
        con = db.connect(self.path)
        for u, admin in (('maria', 1), ('pepe', 0)):
            con.execute('INSERT INTO usuarios (usuario, nombre, hash, admin, cambiar_clave, creado) VALUES (?, ?, ?, ?, 0, 0)',
                        (u, u.title(), srv.hash_password('clave-de-prueba'), admin))
        con.close()

    def tearDown(self):
        self.tmp.cleanup()

    def client(self, user=None):
        c = self.app.test_client()
        if user:
            r = c.post('/api/login', json={'usuario': user, 'clave': 'clave-de-prueba'}, headers=H)
            self.assertEqual(r.status_code, 200)
        return c

    def sync(self, c, since=0, changes=()):
        r = c.post('/api/sync', json={'since': since, 'changes': list(changes)}, headers=H)
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        return r.get_json()


def item(kind, id_, updated, **doc):
    return {'kind': kind, 'id': id_, 'updated': updated, 'doc': doc}


class Auth(Base):
    def test_sin_sesion(self):
        c = self.client()
        self.assertEqual(c.get('/api/me').status_code, 401)
        self.assertEqual(c.post('/api/sync', json={}, headers=H).status_code, 401)

    def test_login_malo_igual_para_usuario_inexistente(self):
        c = self.client()
        a = c.post('/api/login', json={'usuario': 'maria', 'clave': 'mal'}, headers=H)
        b = c.post('/api/login', json={'usuario': 'nadie', 'clave': 'mal'}, headers=H)
        self.assertEqual((a.status_code, a.get_json()), (b.status_code, b.get_json()))

    def test_bloqueo_tras_varios_fallos(self):
        c = self.client()
        for _ in range(8):
            c.post('/api/login', json={'usuario': 'maria', 'clave': 'mal'}, headers=H)
        r = c.post('/api/login', json={'usuario': 'maria', 'clave': 'clave-de-prueba'}, headers=H)
        self.assertEqual(r.status_code, 429)

    def test_sin_cabecera_propia_no_entra(self):
        self.assertEqual(self.client().post('/api/login', json={}).status_code, 403)

    def test_token_no_se_guarda_en_claro(self):
        c = self.client('maria')
        tok = c.get_cookie(srv.COOKIE).value
        con = db.connect(self.path)
        self.assertNotEqual(con.execute('SELECT token FROM sesiones').fetchone()[0], tok)
        self.assertTrue(c.get_cookie(srv.COOKIE).http_only)

    def nueva(self, adm):
        return adm.post('/api/usuarios', json={'usuario': 'nueva', 'nombre': 'Nueva', 'correo': 'n@ejemplo.es'}, headers=H).get_json()

    def test_invitacion_de_un_solo_uso(self):
        r = self.nueva(self.client('maria'))
        c = self.client()
        self.assertEqual(c.post('/api/invitacion/ver', json={'token': r['token']}, headers=H).get_json()['usuario'], 'nueva')
        self.assertEqual(c.post('/api/invitacion', json={'token': r['token'], 'nueva': 'corta'}, headers=H).status_code, 400)
        self.assertEqual(c.post('/api/invitacion', json={'token': r['token'], 'nueva': 'una-clave-larga'}, headers=H).status_code, 200)
        self.assertFalse(c.get('/api/me').get_json()['user']['cambiarClave'])
        self.sync(c)
        otro = self.client()
        self.assertEqual(otro.post('/api/invitacion', json={'token': r['token'], 'nueva': 'otra-clave-larga'}, headers=H).status_code, 404)
        self.assertEqual(otro.post('/api/login', json={'usuario': 'nueva', 'clave': 'una-clave-larga'}, headers=H).status_code, 200)

    def test_sin_invitacion_no_se_puede_entrar(self):
        r = self.nueva(self.client('maria'))
        self.assertNotIn('clave', r)
        c = self.client()
        self.assertEqual(c.post('/api/login', json={'usuario': 'nueva', 'clave': r['token']}, headers=H).status_code, 401)

    def test_invitacion_caducada_y_guardada_con_huella(self):
        r = self.nueva(self.client('maria'))
        con = db.connect(self.path)
        self.assertNotEqual(con.execute('SELECT token FROM invitaciones').fetchone()[0], r['token'])
        con.execute('UPDATE invitaciones SET expira = 1')
        self.assertEqual(self.client().post('/api/invitacion/ver', json={'token': r['token']}, headers=H).status_code, 404)

    def test_nueva_invitacion_anula_la_anterior_y_las_sesiones(self):
        adm = self.client('maria')
        r = self.nueva(adm)
        c = self.client()
        c.post('/api/invitacion', json={'token': r['token'], 'nueva': 'una-clave-larga'}, headers=H)
        uid = next(u['id'] for u in adm.get('/api/usuarios').get_json()['usuarios'] if u['usuario'] == 'nueva')
        r2 = adm.post(f'/api/usuarios/{uid}', json={'invitar': True}, headers=H).get_json()
        self.assertEqual(c.get('/api/me').status_code, 401)
        self.assertEqual(r2['correo'], 'n@ejemplo.es')
        self.assertEqual(self.client().post('/api/login', json={'usuario': 'nueva', 'clave': 'una-clave-larga'}, headers=H).status_code, 401)

    def uid(self, adm, usuario):
        return next(u['id'] for u in adm.get('/api/usuarios').get_json()['usuarios'] if u['usuario'] == usuario)

    def test_editar_cuenta_mantiene_datos_y_sesion(self):
        adm, c = self.client('maria'), self.client('pepe')
        self.sync(c, changes=[item('exam', 'e', 1, title='x')])
        uid = self.uid(adm, 'pepe')
        r = adm.post(f'/api/usuarios/{uid}', json={'editar': True, 'usuario': 'jose', 'nombre': 'José', 'correo': 'j@ejemplo.es'}, headers=H)
        self.assertEqual(r.status_code, 200)
        me = c.get('/api/me').get_json()['user']
        self.assertEqual((me['usuario'], me['id']), ('jose', uid))
        self.assertEqual(len(self.sync(c)['changes']), 1)

    def test_editar_rechaza_datos_malos_y_usuario_repetido(self):
        adm = self.client('maria')
        uid = self.uid(adm, 'pepe')
        for d in ({'usuario': 'maria', 'nombre': 'x'}, {'usuario': 'a b', 'nombre': 'x'}, {'usuario': 'pepe', 'nombre': ''},
                  {'usuario': 'pepe', 'nombre': 'x', 'correo': 'mal'}):
            self.assertEqual(adm.post(f'/api/usuarios/{uid}', json={'editar': True, **d}, headers=H).status_code, 400, d)

    def test_no_cambia_su_propio_usuario(self):
        adm = self.client('maria')
        uid = self.uid(adm, 'maria')
        r = adm.post(f'/api/usuarios/{uid}', json={'editar': True, 'usuario': 'otra', 'nombre': 'Maria'}, headers=H)
        self.assertEqual(r.status_code, 400)

    def test_borrar_cuenta_borra_sus_datos(self):
        adm, c = self.client('maria'), self.client('pepe')
        self.sync(c, changes=[item('exam', 'e', 1, title='x')])
        self.sync(adm, changes=[item('exam', 'e', 1, title='mio')])
        uid = self.uid(adm, 'pepe')
        self.assertEqual(adm.post(f'/api/usuarios/{uid}/borrar', json={'usuario': 'otro'}, headers=H).status_code, 400)
        self.assertEqual(adm.post(f'/api/usuarios/{uid}/borrar', json={'usuario': 'pepe'}, headers=H).status_code, 200)
        self.assertEqual(c.get('/api/me').status_code, 401)
        con = db.connect(self.path)
        self.assertEqual(con.execute('SELECT count(*) FROM items').fetchone()[0], 1)
        self.assertEqual(con.execute('SELECT count(*) FROM sesiones WHERE user_id = ?', (uid,)).fetchone()[0], 0)

    def test_no_se_borra_a_si_misma_ni_lo_hace_otro_profe(self):
        adm, c = self.client('maria'), self.client('pepe')
        mine = self.uid(adm, 'maria')
        self.assertEqual(adm.post(f'/api/usuarios/{mine}/borrar', json={'usuario': 'maria'}, headers=H).status_code, 400)
        self.assertEqual(c.post(f'/api/usuarios/{mine}/borrar', json={'usuario': 'maria'}, headers=H).status_code, 403)

    def test_correo_obligatorio(self):
        adm = self.client('maria')
        r = adm.post('/api/usuarios', json={'usuario': 'nueva', 'nombre': 'Nueva', 'correo': 'mal'}, headers=H)
        self.assertEqual(r.status_code, 400)

    def test_migra_una_base_antigua(self):
        path = str(Path(self.tmp.name) / 'vieja.db')
        con = db.connect(path)
        con.executescript(db.SCHEMA + 'PRAGMA user_version = 1;')
        con.execute("INSERT INTO usuarios (usuario, nombre, hash, creado) VALUES ('a', 'A', 'x', 0)")
        con.close()
        db.migrate(path)
        db.migrate(path)
        con = db.connect(path)
        self.assertEqual(con.execute('PRAGMA user_version').fetchone()[0], db.VERSION)
        self.assertEqual(con.execute('SELECT correo FROM usuarios').fetchone()[0], None)
        self.assertEqual(con.execute('SELECT COUNT(*) FROM solicitudes').fetchone()[0], 0)

    def test_solo_admin_gestiona(self):
        c = self.client('pepe')
        self.assertEqual(c.get('/api/usuarios').status_code, 403)
        self.assertEqual(c.post('/api/usuarios', json={'usuario': 'xxx', 'nombre': 'X', 'correo': 'x@ejemplo.es'}, headers=H).status_code, 403)

    def test_desactivar_corta_la_sesion(self):
        adm, c = self.client('maria'), self.client('pepe')
        uid = next(u['id'] for u in adm.get('/api/usuarios').get_json()['usuarios'] if u['usuario'] == 'pepe')
        adm.post(f'/api/usuarios/{uid}', json={'activo': False}, headers=H)
        self.assertEqual(c.get('/api/me').status_code, 401)


class Sync(Base):
    def test_datos_separados_por_profe(self):
        a, b = self.client('maria'), self.client('pepe')
        self.sync(a, changes=[item('exam', 'abc', 1, title='Suyo')])
        self.assertEqual(self.sync(b)['changes'], [])
        self.sync(b, changes=[item('exam', 'abc', 1, title='Mío')])
        self.assertEqual(self.sync(a)['changes'][0]['doc']['title'], 'Suyo')

    def test_otro_dispositivo_recibe_cambios(self):
        a, b = self.client('maria'), self.client('maria')
        r = self.sync(a, changes=[item('group', 'g1', 5, name='FUHA')])
        self.assertEqual(r['changes'], [])
        got = self.sync(b)
        self.assertEqual(got['changes'][0]['doc']['name'], 'FUHA')
        self.assertEqual(self.sync(b, since=got['rev'])['changes'], [])

    def test_gana_la_version_mas_reciente(self):
        a = self.client('maria')
        self.sync(a, changes=[item('exam', 'e', 200, title='nuevo')])
        r = self.sync(a, changes=[item('exam', 'e', 100, title='viejo')])
        self.assertEqual(len(r['rejected']), 1)
        self.assertEqual(r['changes'][0]['doc']['title'], 'nuevo')

    def test_dos_moviles_con_alumnado_distinto(self):
        a, b = self.client('maria'), self.client('maria')
        ra = self.sync(a)
        rb = self.sync(b)
        self.sync(a, since=ra['rev'], changes=[item('result', 'e/s1', 10, answers={})])
        self.sync(b, since=rb['rev'], changes=[item('result', 'e/s2', 11, answers={})])
        ids = {x['id'] for x in self.sync(self.client('maria'))['changes']}
        self.assertEqual(ids, {'e/s1', 'e/s2'})

    def test_borrar_examen_borra_notas_y_rechaza_las_tardias(self):
        a, b = self.client('maria'), self.client('maria')
        self.sync(a, changes=[item('exam', 'e', 1, title='x'), item('result', 'e/s1', 1, answers={})])
        since = self.sync(b)['rev']
        self.sync(a, changes=[{'kind': 'exam', 'id': 'e', 'updated': 9, 'deleted': True}])
        got = {x['id']: x['deleted'] for x in self.sync(b, since=since)['changes']}
        self.assertEqual(got, {'e': True, 'e/s1': True})
        r = self.sync(a, changes=[item('result', 'e/s2', 20, answers={})])
        self.assertEqual(r['rejected'], [{'kind': 'result', 'id': 'e/s2'}])

    def test_reloj_adelantado_no_bloquea_para_siempre(self):
        a = self.client('maria')
        self.sync(a, changes=[item('exam', 'e', int(time.time() * 1000) + 10 ** 12, title='futuro')])
        con = db.connect(self.path)
        self.assertLess(con.execute('SELECT updated FROM items').fetchone()[0], int(time.time() * 1000) + 2 * 86400000)

    def test_datos_no_validos(self):
        a = self.client('maria')
        for bad in ({'kind': 'x', 'id': 'e', 'updated': 1, 'doc': {}}, {'kind': 'exam', 'id': '../x', 'updated': 1, 'doc': {}},
                    {'kind': 'exam', 'id': 'e', 'updated': 'a', 'doc': {}}, {'kind': 'exam', 'id': 'e', 'updated': 1}):
            self.assertEqual(a.post('/api/sync', json={'changes': [bad]}, headers=H).status_code, 400)
        self.assertEqual(self.sync(a)['changes'], [])

    def test_paginas(self):
        a = self.client('maria')
        self.sync(a, changes=[item('result', f'e/s{i}', 1, answers={}) for i in range(450)])
        b, since, seen, more = self.client('maria'), 0, set(), True
        while more:
            r = self.sync(b, since=since)
            seen |= {x['id'] for x in r['changes']}
            since, more = r['rev'], r['more']
        self.assertEqual(len(seen), 450)


    def test_pagina_con_rechazo_no_salta_datos(self):
        a = self.client('maria')
        self.sync(a, changes=[item('exam', 'e', 900, title='nuevo'), item('exam', 'g', 1, text='x' * (9 * 1024 * 1024))])
        r = self.sync(a, changes=[item('exam', 'e', 100, title='viejo')])
        self.assertTrue(r['more'])
        self.assertEqual(r['rev'], 1)
        r2 = self.sync(a, since=r['rev'])
        self.assertEqual({x['id'] for x in r2['changes']}, {'g'})


class Web(Base):
    def test_no_sirve_servidor_ni_base_de_datos(self):
        c = self.client()
        for p in ('/server/app.py', '/server/db.py', '/.git/config', '/despliegue/instalar.sh', '/capitest-pruebas.db', '/js/../server/app.py', '/js/%2e%2e/server/app.py', '/js//../server/app.py'):
            self.assertEqual(c.get(p).status_code, 404, p)

    def test_sirve_la_aplicacion_con_cabeceras(self):
        c = self.client()
        r = c.get('/')
        self.assertEqual(r.status_code, 200)
        self.assertIn("frame-ancestors 'none'", r.headers['Content-Security-Policy'])
        self.assertEqual(c.get('/js/app.js').status_code, 200)

class Olvido(Base):
    def test_sin_correo_configurado(self):
        r = self.client().post('/api/olvido', json={'usuario': 'pepe'}, headers=H)
        self.assertEqual(r.status_code, 503)

    def test_envia_enlace_y_no_desvela_usuarios(self):
        import correo
        enviados = []
        cfg = {'usuario': 'a@b.c', 'clave': 'x', 'url': 'https://capitest/', 'servidor': 's', 'puerto': 587}
        orig_cfg, orig_env = correo.config, correo.enviar
        correo.config = lambda: cfg
        correo.enviar = lambda destino, asunto, texto, c=None: enviados.append((destino, texto))
        try:
            con = db.connect(self.path)
            con.execute("UPDATE usuarios SET correo = 'pepe@x.es' WHERE usuario = 'pepe'")
            con.close()
            c = self.client()
            r1 = c.post('/api/olvido', json={'usuario': 'pepe'}, headers=H)
            r2 = c.post('/api/olvido', json={'usuario': 'nadie'}, headers=H)
            self.assertEqual((r1.status_code, r1.get_json()), (r2.status_code, r2.get_json()))
            for _ in range(50):
                if enviados:
                    break
                time.sleep(0.05)
            self.assertEqual(len(enviados), 1)
            destino, texto = enviados[0]
            self.assertEqual(destino, 'pepe@x.es')
            token = texto.split('#/invitacion/')[1].split()[0]
            # La contraseña vieja sigue valiendo hasta que se usa el enlace.
            self.client('pepe')
            r = c.post('/api/invitacion', json={'token': token, 'nueva': 'otra-clave-larga'}, headers=H)
            self.assertEqual(r.status_code, 200)
            r = c.post('/api/invitacion', json={'token': token, 'nueva': 'otra-clave-larga'}, headers=H)
            self.assertEqual(r.status_code, 404)
        finally:
            correo.config, correo.enviar = orig_cfg, orig_env


class Registro(Base):
    def test_sin_correo_configurado_guarda_la_solicitud(self):
        r = self.client().post('/api/registro', json={'nombre': 'Ana Pérez', 'correo': 'ana@g.educaand.es'}, headers=H)
        self.assertEqual(r.status_code, 200)
        sol = self.client('maria').get('/api/usuarios').get_json()['solicitudes']
        self.assertEqual([(x['nombre'], x['correo'], x['usuario']) for x in sol],
                         [('Ana Pérez', 'ana@g.educaand.es', 'ana')])

    def test_aceptar_y_rechazar(self):
        anon = self.client()
        for nombre, mail in (('Ana Pérez', 'ana@g.educaand.es'), ('Luis Gil', 'lgil1@g.educaand.es')):
            anon.post('/api/registro', json={'nombre': nombre, 'correo': mail}, headers=H)
        # Repetir la petición no duplica la solicitud
        anon.post('/api/registro', json={'nombre': 'Ana Pérez López', 'correo': 'ana@g.educaand.es'}, headers=H)
        adm = self.client('maria')
        sol = {x['usuario']: x for x in adm.get('/api/usuarios').get_json()['solicitudes']}
        self.assertEqual(sorted(sol), ['ana', 'lgil1'])
        self.assertEqual(sol['ana']['nombre'], 'Ana Pérez López')
        # Solo administración ve y rechaza solicitudes
        r = self.client('pepe').post(f"/api/solicitudes/{sol['lgil1']['id']}/rechazar", json={}, headers=H)
        self.assertEqual(r.status_code, 403)
        r = adm.post(f"/api/solicitudes/{sol['lgil1']['id']}/rechazar", json={}, headers=H)
        self.assertEqual(r.status_code, 200)
        # Aceptar = crear la cuenta con sus datos; la solicitud desaparece
        a = sol['ana']
        r = adm.post('/api/usuarios', json={'nombre': a['nombre'], 'usuario': a['usuario'], 'correo': a['correo'],
                                            'solicitud': a['id']}, headers=H)
        self.assertEqual(r.status_code, 200)
        data = adm.get('/api/usuarios').get_json()
        self.assertEqual(data['solicitudes'], [])
        self.assertIn('ana', [u['usuario'] for u in data['usuarios']])
        # Si ya tiene cuenta, no se guarda otra solicitud
        anon.post('/api/registro', json={'nombre': 'Ana Pérez', 'correo': 'ana@g.educaand.es'}, headers=H)
        self.assertEqual(adm.get('/api/usuarios').get_json()['solicitudes'], [])

    def test_avisa_a_la_cuenta_de_correo(self):
        import correo
        enviados = []
        cfg = {'usuario': 'capitest@gmail.com', 'clave': 'x', 'url': 'https://capitest/', 'servidor': 's', 'puerto': 587}
        orig_cfg, orig_env = correo.config, correo.enviar
        correo.config = lambda: cfg
        correo.enviar = lambda destino, asunto, texto, c=None: enviados.append((destino, asunto, texto))
        try:
            c = self.client()
            r = c.post('/api/registro', json={'nombre': 'Ana', 'correo': 'ana@gmail.com'}, headers=H)
            self.assertEqual(r.status_code, 400)
            r = c.post('/api/registro', json={'nombre': ' Ana   Pérez ', 'correo': 'APEREZ123@g.educaand.es'}, headers=H)
            self.assertEqual(r.status_code, 200)
            for _ in range(50):
                if enviados:
                    break
                time.sleep(0.05)
            self.assertEqual(len(enviados), 1)
            destino, asunto, texto = enviados[0]
            self.assertEqual(destino, 'capitest@gmail.com')
            self.assertIn('Ana Pérez', asunto)
            self.assertIn('aperez123@g.educaand.es', texto)
            self.assertIn('aperez123\n', texto)
        finally:
            correo.config, correo.enviar = orig_cfg, orig_env


class InvitacionPorCorreo(Base):
    def test_alta_envia_correo(self):
        import correo
        enviados = []
        cfg = {'usuario': 'capitest@gmail.com', 'clave': 'x', 'url': 'https://capitest/', 'servidor': 's', 'puerto': 587}
        orig_cfg, orig_env = correo.config, correo.enviar
        correo.config = lambda: cfg
        correo.enviar = lambda destino, asunto, texto, c=None: enviados.append((destino, texto))
        try:
            c = self.client('maria')
            r = c.post('/api/usuarios', json={'nombre': 'Luis Gil', 'usuario': 'lgil123', 'correo': 'lgil123@g.educaand.es'}, headers=H)
            self.assertEqual(r.status_code, 200)
            self.assertTrue(r.get_json()['enviado'])
            self.assertEqual(enviados[0][0], 'lgil123@g.educaand.es')
            self.assertIn('https://capitest/#/invitacion/' + r.get_json()['token'], enviados[0][1])
        finally:
            correo.config, correo.enviar = orig_cfg, orig_env

    def test_sin_correo_configurado_no_envia(self):
        r = self.client('maria').post('/api/usuarios', json={'nombre': 'Luis Gil', 'usuario': 'lgil123', 'correo': 'l@x.es'}, headers=H)
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.get_json()['enviado'])


class EstadoCuentas(Base):
    def test_invitado_y_ultimo_acceso(self):
        adm = self.client('maria')
        nueva = adm.post('/api/usuarios', json={'usuario': 'nueva', 'nombre': 'Nueva', 'correo': 'n@ejemplo.es'}, headers=H).get_json()
        lista = {u['usuario']: u for u in adm.get('/api/usuarios').get_json()['usuarios']}
        self.assertIsNotNone(lista['nueva']['invitacion'])
        self.assertTrue(lista['nueva']['cambiar_clave'])
        self.assertIsNone(lista['nueva']['ultimo_acceso'])
        self.assertIsNotNone(lista['maria']['ultimo_acceso'])
        self.app.test_client().post('/api/invitacion', json={'token': nueva['token'], 'nueva': 'otra-clave-larga'}, headers=H)
        lista = {u['usuario']: u for u in adm.get('/api/usuarios').get_json()['usuarios']}
        self.assertIsNone(lista['nueva']['invitacion'])
        self.assertIsNotNone(lista['nueva']['ultimo_acceso'])


if __name__ == '__main__':
    unittest.main()
