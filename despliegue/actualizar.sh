#!/usr/bin/env bash
# Comprueba si hay código nuevo y lo instala. Si la versión nueva no arranca, vuelve a la anterior.
set -uo pipefail

CODIGO=/opt/capitest
MALA=/etc/capitest/version-fallida
. /etc/capitest/actualizar.env
export GIT_SSH_COMMAND

sano() {
  for _ in $(seq 1 20); do
    { curl -fsk https://127.0.0.1:8443/api/status || curl -fs http://127.0.0.1:8443/api/status; } >/dev/null && return 0
    sleep 1
  done
  return 1
}

exec 9>/run/capitest-actualizar.lock
flock -n 9 || exit 0

git -C "$CODIGO" fetch -q origin "$RAMA" || { echo "No se ha podido consultar el repositorio."; exit 1; }
antes=$(git -C "$CODIGO" rev-parse HEAD)
nuevo=$(git -C "$CODIGO" rev-parse "origin/$RAMA")
[ "$antes" = "$nuevo" ] && exit 0
# Una versión que ya falló no se reintenta: cada intento dejaría la aplicación parada unos segundos.
[ "$(cat "$MALA" 2>/dev/null)" = "$nuevo" ] && exit 0

echo "Actualizando de ${antes:0:7} a ${nuevo:0:7}"
"$CODIGO/despliegue/copia.sh"
git -C "$CODIGO" reset -q --hard "$nuevo"
install -m 644 "$CODIGO"/despliegue/capitest*.service "$CODIGO"/despliegue/capitest*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl restart capitest.service
if sano; then
  echo "Actualizado."
  exit 0
fi

echo "La versión ${nuevo:0:7} no arranca; se vuelve a ${antes:0:7}."
echo "$nuevo" > "$MALA"
git -C "$CODIGO" reset -q --hard "$antes"
install -m 644 "$CODIGO"/despliegue/capitest*.service "$CODIGO"/despliegue/capitest*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl restart capitest.service
sano && echo "Versión anterior recuperada." || echo "ATENCIÓN: la versión anterior tampoco arranca."
exit 1
