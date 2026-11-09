#!/usr/bin/env python3
"""Tareas de administración desde la consola de la VM.

  gestionar.py crear-admin USUARIO "Nombre"   crea una cuenta de administración
  gestionar.py clave USUARIO                  pone una contraseña temporal
  gestionar.py migrar                         crea o actualiza las tablas
"""

import argparse
import getpass
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import app as srv
import db


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--db', default=os.environ.get('CAPITEST_DB'))
    sub = ap.add_subparsers(dest='orden', required=True)
    a = sub.add_parser('crear-admin')
    a.add_argument('usuario')
    a.add_argument('nombre')
    c = sub.add_parser('clave')
    c.add_argument('usuario')
    sub.add_parser('migrar')
    args = ap.parse_args()
    if not args.db:
        sys.exit('Indica la base de datos con --db o CAPITEST_DB')

    db.migrate(args.db)
    if args.orden == 'migrar':
        return
    con = db.connect(args.db)
    usuario = args.usuario.strip().lower()
    if args.orden == 'crear-admin':
        if not srv.USER_RE.match(usuario):
            sys.exit('El usuario debe tener de 3 a 40 letras sin espacios')
        clave = getpass.getpass('Contraseña (mínimo 10 caracteres): ') if sys.stdin.isatty() else sys.stdin.readline().rstrip('\n')
        if len(clave) < srv.MIN_PASSWORD:
            sys.exit('Contraseña demasiado corta')
        con.execute('INSERT INTO usuarios (usuario, nombre, hash, admin, cambiar_clave, creado) VALUES (?, ?, ?, 1, 0, ?)',
                    (usuario, args.nombre, srv.hash_password(clave), db.now()))
        db.log(con, usuario, 'administración creada desde la consola')
        print('Cuenta creada.')
    else:
        clave = srv.temp_password()
        cur = con.execute('UPDATE usuarios SET hash = ?, cambiar_clave = 1 WHERE usuario = ?',
                          (srv.hash_password(clave), usuario))
        if not cur.rowcount:
            sys.exit('No existe ese usuario')
        u = con.execute('SELECT id FROM usuarios WHERE usuario = ?', (usuario,)).fetchone()
        con.execute('DELETE FROM sesiones WHERE user_id = ?', (u['id'],))
        db.log(con, usuario, 'contraseña reiniciada desde la consola')
        print('Contraseña temporal:', clave)


if __name__ == '__main__':
    main()
