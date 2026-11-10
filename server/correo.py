"""Envío de correos con una cuenta de Gmail (u otro servidor SMTP).

Se configura en /etc/capitest/correo.env:

  CAPITEST_URL=https://direccion-publica/          dirección con la que se entra en CapiTest
  CAPITEST_SMTP_USUARIO=cuenta@gmail.com
  CAPITEST_SMTP_CLAVE=contraseña de aplicación de Google (16 letras)

Opcionales: CAPITEST_SMTP_SERVIDOR (smtp.gmail.com) y CAPITEST_SMTP_PUERTO (587).
"""

import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr


def config():
    usuario = os.environ.get('CAPITEST_SMTP_USUARIO', '').strip()
    clave = os.environ.get('CAPITEST_SMTP_CLAVE', '').replace(' ', '')
    url = os.environ.get('CAPITEST_URL', '').strip()
    if not (usuario and clave and url):
        return None
    return {
        'usuario': usuario, 'clave': clave, 'url': url if url.endswith('/') else url + '/',
        'servidor': os.environ.get('CAPITEST_SMTP_SERVIDOR', 'smtp.gmail.com'),
        'puerto': int(os.environ.get('CAPITEST_SMTP_PUERTO', '587')),
    }


def enviar(destino, asunto, texto, cfg=None):
    cfg = cfg or config()
    if not cfg:
        raise RuntimeError('El correo no está configurado')
    msg = EmailMessage()
    msg['From'] = formataddr(('CapiTest', cfg['usuario']))
    msg['To'] = destino
    msg['Subject'] = asunto
    msg.set_content(texto)
    ctx = ssl.create_default_context()
    if cfg['puerto'] == 465:
        with smtplib.SMTP_SSL(cfg['servidor'], 465, context=ctx, timeout=20) as s:
            s.login(cfg['usuario'], cfg['clave'])
            s.send_message(msg)
    else:
        with smtplib.SMTP(cfg['servidor'], cfg['puerto'], timeout=20) as s:
            s.starttls(context=ctx)
            s.login(cfg['usuario'], cfg['clave'])
            s.send_message(msg)
