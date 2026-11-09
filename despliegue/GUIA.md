# Instalar CapiTest en Luna

## Qué se instala

- **Máquina virtual:** Debian 13, con 2 núcleos, 2 GB de memoria y 20 GB de disco.
- **Aplicación:** servidor en Python (Flask y gunicorn) en el puerto 8443, con conexión cifrada.
- **Datos:** base de datos SQLite en `/var/lib/capitest/capitest.db`.
- **Copias:** una diaria a las 03:30 y otra antes de cada actualización, en `/var/backups/capitest`. Se guardan 14 días.
- **Actualizaciones:** cada 5 minutos la máquina consulta GitHub. Si hay una versión nueva, la instala. Si no arranca, vuelve a la anterior y no la reintenta.
- **Cortafuegos:** solo las direcciones de `PERMITIDOS` llegan a la aplicación.

## Antes de empezar

Hay que acordar con quien administra Luna y el VPS:

1. La máquina virtual y su dirección IP interna, que debe ser fija: el proxy apunta a ella.
2. El subdominio, por ejemplo `capitest.informatica.iesgrancapitan.org`.
3. La entrada en el proxy del VPS, a partir de `proxy-apache.conf`.
4. La dirección desde la que el VPS llega a la máquina. Es el valor de `PERMITIDOS`.

Y conviene mirar en el panel de Proxmox de Luna:

- **Espacio libre** en el almacenamiento donde irá el disco. Hacen falta 20 GB.
- **Copias de seguridad:** si la máquina nueva entra en las copias programadas de Luna. Las copias de `/var/backups/capitest` están dentro de la propia máquina y no la protegen si se pierde su disco.

## Instalación

El código tiene que estar antes en la rama `main` de GitHub, porque la máquina lo descarga de allí.

1. Crea la máquina en Luna con **Crear VM**:
   - **General:** nombre `capitest` y **Start at boot** marcado, para que arranque sola si Luna se reinicia.
   - **OS:** la imagen de Debian 13 (netinst).
   - **Disks:** 20 GB. **CPU:** 2 núcleos. **Memory:** 2048 MB.
   - **Network:** el puente que indique quien administra Luna.

   Instala Debian sin escritorio, con **SSH server** y **Standard system utilities** marcados. Después entra por la consola como root.
2. Instala git y descarga el script:

   ```bash
   apt-get update && apt-get install -y git curl
   curl -fsSLO https://raw.githubusercontent.com/mariaGCapitan/CapiTest/main/despliegue/instalar.sh
   ```

3. Ejecútalo, sustituyendo la dirección por la del VPS:

   ```bash
   PERMITIDOS="IP_DEL_VPS" bash instalar.sh
   ```

4. La primera vez muestra una clave. Pégala en GitHub, en **Settings › Deploy keys › Add deploy key**, sin marcar **Allow write access**, y repite el paso 3.
5. Crea tu cuenta de administración con tu usuario de Séneca. Te pedirá la contraseña. Si vas a traer los datos de otra instalación, sáltate este paso: tu cuenta viene con ellos.

   ```bash
   runuser -u capitest -- python3 /opt/capitest/server/gestionar.py --db /var/lib/capitest/capitest.db crear-admin USUARIO "Tu nombre"
   ```

6. Pide que activen el subdominio y entra desde el navegador. Las demás cuentas se crean en **Tu cuenta › Gestionar profesorado**: CapiTest prepara un correo con un enlace de un solo uso, válido 7 días, para que cada profe elija su contraseña.

El enlace de invitación usa la dirección desde la que tengas abierto CapiTest. Crea las cuentas desde el subdominio definitivo: un enlace hecho desde `https://IP_DE_LA_VM:8443` solo funciona dentro del centro.

## Probar antes de tener el proxy

Dentro del centro, repite el paso 3 añadiendo la dirección de tu ordenador, separada por un espacio:

```bash
PERMITIDOS="IP_DEL_VPS IP_DE_TU_ORDENADOR" bash instalar.sh
```

Abre `https://IP_DE_LA_VM:8443`. El navegador avisará del certificado, que es propio de la máquina. Al terminar, vuelve a ejecutarlo solo con la dirección del VPS.

## Traer los datos de otra instalación

Desde el ordenador donde está la copia, envíala a la máquina. `USUARIO` es el que creaste al instalar Debian:

```bash
scp ARCHIVO.db.gz USUARIO@IP_DE_LA_VM:/tmp/
```

En la máquina, como root, déjala con las demás copias:

```bash
install -m 600 /tmp/ARCHIVO.db.gz /var/backups/capitest/ && rm /tmp/ARCHIVO.db.gz
```

Sigue con **Recuperar una copia**, en **Tareas habituales**. Las cuentas conservan sus contraseñas. Cada profe tendrá que iniciar sesión en la dirección nueva.

## Tareas habituales

Ver si está en marcha y sus últimos mensajes:

```bash
systemctl status capitest
```

```bash
journalctl -u capitest -n 50
```

Ver las últimas actualizaciones:

```bash
journalctl -u capitest-actualizar -n 30
```

Poner una contraseña temporal desde la consola:

```bash
runuser -u capitest -- python3 /opt/capitest/server/gestionar.py --db /var/lib/capitest/capitest.db clave USUARIO
```

Recuperar una copia:

```bash
systemctl stop capitest capitest-actualizar.timer
```

```bash
gunzip -c /var/backups/capitest/ARCHIVO.db.gz > /var/lib/capitest/capitest.db
```

```bash
rm -f /var/lib/capitest/capitest.db-wal /var/lib/capitest/capitest.db-shm
```

```bash
chown capitest:capitest /var/lib/capitest/capitest.db && chmod 640 /var/lib/capitest/capitest.db
```

```bash
systemctl start capitest capitest-actualizar.timer
```

## Pasar el repositorio a privado

Cuando CapiTest funcione en Luna, cambia el repositorio a privado en GitHub. La clave de solo lectura sigue valiendo y GitHub Pages deja de publicar la aplicación. A partir de ahí, el paso 2 de la instalación necesita copiar `instalar.sh` a la máquina a mano.

## Datos personales

Con servidor, CapiTest convierte los nombres en seudónimos del centro en el navegador, antes de guardarlos. La lista de cada grupo se importa con la hoja «Mis alumnos y alumnas» de Séneca, descargada como Hoja Microsoft Excel. Un seudónimo sigue siendo un dato personal, así que antes de usar datos reales hace falta el visto bueno del centro.
