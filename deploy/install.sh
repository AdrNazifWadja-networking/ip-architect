#!/usr/bin/env bash
# IP Architect — installation (ou mise à jour) sur un serveur Debian / Ubuntu.
#
#   git clone <dépôt> && cd ip-architect
#   sudo ./deploy/install.sh                      # HTTP sur le port 80 (Nginx)
#   sudo ./deploy/install.sh --domain ipam.exemple.org --letsencrypt
#
# Relancer le script après un « git pull » met l'application à jour (les données ne sont jamais touchées).
set -euo pipefail

APP_USER=ip-architect
APP_DIR=/opt/ip-architect
DATA_DIR=/var/lib/ip-architect
CONF_DIR=/etc/ip-architect
PORT=3000
DOMAIN="_"
WEB=nginx          # nginx | none
LETSENCRYPT=0
NODE_MAJOR=22

usage() {
  cat <<USAGE
Usage : sudo ./deploy/install.sh [options]
  --domain NOM        nom de domaine du serveur (défaut : toutes les adresses)
  --letsencrypt       certificat HTTPS gratuit (nécessite --domain et un DNS déjà pointé vers ce serveur)
  --no-web            n'installe pas Nginx (l'application écoute alors sur 127.0.0.1:${PORT} seulement)
  --port N            port interne de l'application (défaut : ${PORT})
  -h, --help          cette aide
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:?}"; shift 2 ;;
    --letsencrypt) LETSENCRYPT=1; shift ;;
    --no-web) WEB=none; shift ;;
    --port) PORT="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Option inconnue : $1" >&2; usage; exit 1 ;;
  esac
done

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mErreur : %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "à lancer en root : sudo ./deploy/install.sh"
command -v apt-get >/dev/null || die "ce script gère Debian et Ubuntu (apt). Sur une autre distribution, utilisez Docker (voir docs/INSTALL.md)."
[ "$LETSENCRYPT" -eq 0 ] || { [ "$DOMAIN" != "_" ] || die "--letsencrypt demande --domain"; [ "$WEB" = nginx ] || die "--letsencrypt demande Nginx"; }

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$SRC/package.json" ] || die "package.json introuvable dans $SRC"

export DEBIAN_FRONTEND=noninteractive
log "Paquets système"
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl gnupg rsync openssl python3 make g++

node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR" ]; }
if ! node_ok; then
  log "Node.js ${NODE_MAJOR} (dépôt officiel NodeSource)"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
node_ok || die "Node.js ${NODE_MAJOR} ou plus est requis"

if [ "$WEB" = nginx ]; then
  log "Nginx"
  apt-get install -y --no-install-recommends nginx
fi

log "Utilisateur et dossiers"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$DATA_DIR"
install -d -m 755 "$APP_DIR"
install -d -m 750 -o root -g "$APP_USER" "$CONF_DIR"

log "Copie de l'application dans ${APP_DIR}"
rsync -a --delete --exclude node_modules --exclude .next --exclude .git --exclude data --exclude '*.db' --exclude '*.db-*' "$SRC"/ "$APP_DIR"/
chown -R root:root "$APP_DIR"
# Next écrit son cache dans .next au démarrage : ce dossier appartient au service
install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR/.next"

log "Dépendances et compilation (quelques minutes)"
( cd "$APP_DIR" && npm ci --no-audit --no-fund && npm run build )
chown -R "$APP_USER":"$APP_USER" "$APP_DIR/.next"

ENV_FILE="$CONF_DIR/env"
if [ ! -f "$ENV_FILE" ]; then
  log "Configuration (${ENV_FILE})"
  SETUP_CODE="$(openssl rand -hex 6)"
  SECURE=0; [ "$LETSENCRYPT" -eq 1 ] && SECURE=1
  cat > "$ENV_FILE" <<ENV
NODE_ENV=production
PORT=${PORT}
DATABASE_PATH=${DATA_DIR}/ip-architect.db
# Code à saisir pour créer le premier compte administrateur (la page de création du compte le demande).
IP_ARCHITECT_SETUP_CODE=${SETUP_CODE}
# L'application est derrière Nginx : elle peut se fier à X-Forwarded-For / X-Forwarded-Proto.
IP_ARCHITECT_TRUST_PROXY=$([ "$WEB" = nginx ] && echo 1 || echo 0)
# Cookies « Secure » : à 1 uniquement si le site est servi en HTTPS.
IP_ARCHITECT_SECURE_COOKIES=${SECURE}
ENV
  chown root:"$APP_USER" "$ENV_FILE"; chmod 640 "$ENV_FILE"
  NEW_CODE="$SETUP_CODE"
else
  log "Configuration existante conservée (${ENV_FILE})"
  NEW_CODE=""
fi

log "Service systemd"
sed -e "s#@APP_DIR@#${APP_DIR}#g" -e "s#@DATA_DIR@#${DATA_DIR}#g" -e "s#@CONF_DIR@#${CONF_DIR}#g" -e "s#@APP_USER@#${APP_USER}#g" \
  "$SRC/deploy/ip-architect.service" > /etc/systemd/system/ip-architect.service
systemctl daemon-reload
systemctl enable ip-architect >/dev/null
systemctl restart ip-architect

if [ "$WEB" = nginx ]; then
  log "Configuration Nginx"
  sed -e "s#@DOMAIN@#${DOMAIN}#g" -e "s#@PORT@#${PORT}#g" "$SRC/deploy/nginx.conf" > /etc/nginx/sites-available/ip-architect
  ln -sf /etc/nginx/sites-available/ip-architect /etc/nginx/sites-enabled/ip-architect
  # le site par défaut de Nginx occuperait le port 80 : on le retire seulement s'il est l'exemple fourni
  if [ -L /etc/nginx/sites-enabled/default ] && [ "$DOMAIN" = "_" ]; then rm -f /etc/nginx/sites-enabled/default; fi
  nginx -t
  systemctl enable nginx >/dev/null
  systemctl reload nginx || systemctl restart nginx
  if [ "$LETSENCRYPT" -eq 1 ]; then
    log "Certificat Let's Encrypt"
    apt-get install -y --no-install-recommends certbot python3-certbot-nginx
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
    sed -i 's/^IP_ARCHITECT_SECURE_COOKIES=.*/IP_ARCHITECT_SECURE_COOKIES=1/' "$ENV_FILE"
    systemctl restart ip-architect
  fi
fi

log "Vérification"
OK=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then OK=1; break; fi
  sleep 2
done
[ "$OK" -eq 1 ] || { journalctl -u ip-architect -n 30 --no-pager || true; die "l'application ne répond pas (voir journalctl -u ip-architect)"; }

SCHEME=http; [ "$LETSENCRYPT" -eq 1 ] && SCHEME=https
HOST="$DOMAIN"; [ "$HOST" = "_" ] && HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ "$WEB" = nginx ] || HOST="127.0.0.1:${PORT}"
printf '\n\033[1;32mIP Architect est installé.\033[0m\n'
echo "  Adresse        : ${SCHEME}://${HOST}/"
[ -z "$NEW_CODE" ] || echo "  Code d'installation (à saisir à la création du premier administrateur) : ${NEW_CODE}"
echo "  Configuration  : ${ENV_FILE}"
echo "  Données        : ${DATA_DIR}  (à sauvegarder : copiez ip-architect.db, ou utilisez Paramètres > Sauvegarde)"
echo "  Journaux       : journalctl -u ip-architect -f"
if [ "$WEB" = nginx ] && [ "$LETSENCRYPT" -eq 0 ]; then
  echo "  Attention      : sans HTTPS, mots de passe et jetons circulent en clair. Relancez avec --domain et --letsencrypt."
fi
