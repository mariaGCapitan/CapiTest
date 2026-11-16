#!/bin/sh
# Arranca CapiTest como en Luna (gunicorn con https propio), con datos de prueba en /datos.
# --reload: al cambiar el código del servidor se reinicia solo.
set -e
# El iPhone solo acepta el certificado si lleva la IP a la que se conecta y dura menos de 825 días.
# MAC_IP es la IP del Mac en la wifi; si cambia (casa, centro), se crea un certificado nuevo.
IPS="${MAC_IP:-127.0.0.1}"
if [ ! -f /datos/tls.crt ] || [ "$(cat /datos/tls.ips 2>/dev/null)" != "$IPS" ]; then
  SAN="DNS:localhost,IP:127.0.0.1"
  for ip in $IPS; do SAN="$SAN,IP:$ip"; done
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 800 \
    -subj "/CN=capitest-desarrollo" -addext "subjectAltName=$SAN" -addext "extendedKeyUsage=serverAuth" \
    -keyout /datos/tls.key -out /datos/tls.crt 2>/dev/null
  echo "$IPS" > /datos/tls.ips
  echo "Certificado nuevo para: $SAN"
fi
export CAPITEST_DB=/datos/capitest.db CAPITEST_SECURE=1 CAPITEST_PROXY=0
exec gunicorn --reload --workers 2 --worker-class gthread --threads 16 --timeout 150 \
  --bind 0.0.0.0:8443 --certfile /datos/tls.crt --keyfile /datos/tls.key app:app
