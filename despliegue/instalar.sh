#!/usr/bin/env bash
# Instala CapiTest en una Debian limpia. Se ejecuta como root y se puede repetir sin peligro.
#
#   PERMITIDOS="IP_DEL_VPS" bash instalar.sh
#
# PERMITIDOS: direcciones que pueden llegar a la aplicación (separadas por espacios).
# REPO y RAMA: de dónde sale el código. Con un repositorio git@ se crea una clave de solo lectura.
set -euo pipefail

REPO="${REPO:-git@github.com:mariaGCapitan/CapiTest.git}"
RAMA="${RAMA:-main}"
PERMITIDOS="${PERMITIDOS:-}"
CODIGO=/opt/capitest
DATOS=/var/lib/capitest
CONFIG=/etc/capitest
CLAVE=/root/.ssh/capitest_github

[ "$(id -u)" = 0 ] || { echo "Hay que ejecutarlo como root."; exit 1; }
[ -n "$PERMITIDOS" ] || { echo 'Falta PERMITIDOS, por ejemplo: PERMITIDOS="10.0.0.1" bash instalar.sh'; exit 1; }

echo "== Paquetes"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3-flask gunicorn git sqlite3 nftables unattended-upgrades curl openssl >/dev/null

echo "== Usuario y carpetas"
id capitest >/dev/null 2>&1 || useradd --system --home-dir "$DATOS" --shell /usr/sbin/nologin capitest
install -d -o capitest -g capitest -m 750 "$DATOS"
install -d -o root -g capitest -m 750 "$CONFIG"
install -d -o root -g root -m 700 /var/backups/capitest

GIT_SSH=""
if [[ "$REPO" == git@* ]]; then
  install -d -m 700 /root/.ssh
  [ -f "$CLAVE" ] || ssh-keygen -q -t ed25519 -N '' -C capitest-luna -f "$CLAVE"
  GIT_SSH="ssh -i $CLAVE -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
  if ! GIT_SSH_COMMAND="$GIT_SSH" git ls-remote "$REPO" >/dev/null 2>&1; then
    echo
    echo "GitHub aún no reconoce esta máquina. En el repositorio entra en"
    echo "Settings > Deploy keys > Add deploy key, deja SIN marcar «Allow write access» y pega:"
    echo
    cat "$CLAVE.pub"
    echo
    echo "Después ejecuta otra vez este script."
    exit 2
  fi
fi

echo "== Código"
if [ -d "$CODIGO/.git" ]; then
  GIT_SSH_COMMAND="$GIT_SSH" git -C "$CODIGO" fetch -q origin "$RAMA"
else
  GIT_SSH_COMMAND="$GIT_SSH" git clone -q --branch "$RAMA" "$REPO" "$CODIGO"
fi
git -C "$CODIGO" reset -q --hard "origin/$RAMA"

echo "== Configuración"
cat > "$CONFIG/capitest.env" <<CONF
CAPITEST_DB=$DATOS/capitest.db
CAPITEST_SECURE=1
CAPITEST_PROXY=1
CONF
cat > "$CONFIG/actualizar.env" <<CONF
RAMA=$RAMA
GIT_SSH_COMMAND="$GIT_SSH"
CONF
if [ ! -f "$CONFIG/tls.crt" ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 -subj "/CN=capitest-luna" \
    -keyout "$CONFIG/tls.key" -out "$CONFIG/tls.crt" 2>/dev/null
fi
chown root:capitest "$CONFIG"/tls.*
chmod 640 "$CONFIG/tls.key"

echo "== Cortafuegos"
reglas=""
for ip in $PERMITIDOS; do reglas+="    ip saddr $ip tcp dport 8443 accept"$'\n'; done
cat > /etc/nftables.conf <<CONF
#!/usr/sbin/nft -f
flush ruleset
table inet filtro {
  chain entrada {
    type filter hook input priority 0; policy drop;
    iif lo accept
    ct state established,related accept
    ip protocol icmp accept
    ip6 nexthdr icmpv6 accept
    tcp dport 22 accept
$reglas  }
}
CONF
systemctl enable -q nftables
systemctl restart nftables

echo "== Servicios"
install -m 644 "$CODIGO"/despliegue/capitest*.service "$CODIGO"/despliegue/capitest*.timer /etc/systemd/system/
systemctl daemon-reload
runuser -u capitest -- sh -c "umask 027; python3 '$CODIGO/server/gestionar.py' --db '$DATOS/capitest.db' migrar"
chmod -f 640 "$DATOS"/capitest.db* || true
systemctl enable -q --now unattended-upgrades capitest.service capitest-actualizar.timer capitest-copia.timer
systemctl restart capitest.service

for _ in $(seq 1 20); do
  { curl -fsk https://127.0.0.1:8443/api/status || curl -fs http://127.0.0.1:8443/api/status || curl -fs http://127.0.0.1/api/status; } >/dev/null && break
  sleep 1
done
{ curl -fsk https://127.0.0.1:8443/api/status || curl -fs http://127.0.0.1:8443/api/status || curl -fs http://127.0.0.1/api/status; } >/dev/null || { echo "CapiTest no ha arrancado: journalctl -u capitest"; exit 1; }

echo
echo "CapiTest está en marcha."
echo "Si es la primera vez, crea tu cuenta:"
echo "  runuser -u capitest -- python3 $CODIGO/server/gestionar.py --db $DATOS/capitest.db crear-admin USUARIO \"Tu nombre\""
