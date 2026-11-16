# Versión de desarrollo de CapiTest en el Mac: la misma Debian y el mismo servidor que en Luna.
FROM debian:trixie-slim
ENV TZ=Europe/Madrid DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-flask gunicorn openssl sqlite3 tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY arrancar.sh /arrancar.sh
WORKDIR /opt/capitest/server
CMD ["sh", "/arrancar.sh"]
