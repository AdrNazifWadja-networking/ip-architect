# Installation d'IP Architect

Trois façons de l'installer, de la plus simple à la plus manuelle. La base de données est un **fichier SQLite** : aucun serveur de base de données à installer.

## 1. Sur un serveur Debian / Ubuntu (recommandé)

Un seul script installe Node.js 22, compile l'application, crée un service systemd et configure Nginx.

```bash
sudo apt-get install -y git
git clone https://github.com/<votre-compte>/ip-architect.git
cd ip-architect
sudo ./deploy/install.sh                                   # HTTP, port 80
# ou, avec un nom de domaine et un certificat HTTPS gratuit :
sudo ./deploy/install.sh --domain ipam.exemple.org --letsencrypt
```

À la fin, le script affiche l'adresse et un **code d'installation**. Ouvrez l'adresse dans un navigateur : l'écran de création du premier compte administrateur demande ce code. Les créations de comptes suivantes sont verrouillées tant que ce premier compte n'existe pas.

| Élément | Emplacement |
|---|---|
| Application | `/opt/ip-architect` |
| Données (base SQLite) | `/var/lib/ip-architect/ip-architect.db` |
| Configuration | `/etc/ip-architect/env` (voir `.env.example`) |
| Service | `systemctl status ip-architect` |
| Journaux | `journalctl -u ip-architect -f` |

**Mise à jour** : `cd ip-architect && git pull && sudo ./deploy/install.sh`. La configuration et les données sont conservées.

**Sauvegarde** : copiez `/var/lib/ip-architect/ip-architect.db` (ou utilisez Paramètres > Sauvegarde dans l'application).

**Options** : `--no-web` (sans Nginx : l'application écoute sur 127.0.0.1:3000 pour votre propre proxy), `--port N`. Pour **Apache** à la place de Nginx, lancez avec `--no-web` et adaptez `deploy/apache.conf.example`.

**HTTPS** : sans `--letsencrypt`, mots de passe et jetons circulent en clair. Ne l'utilisez ainsi que sur un réseau de confiance ou derrière votre propre terminaison TLS (dans ce cas, mettez `IP_ARCHITECT_SECURE_COOKIES=1` dans `/etc/ip-architect/env` puis `systemctl restart ip-architect`).

## 2. Docker

```bash
docker compose up -d --build        # puis http://localhost:3000
```

Les données vivent dans le volume `ipa-data`. Le code d'installation est affiché dans les journaux au premier démarrage : `docker compose logs ip-architect`. Derrière un proxy HTTPS, ajoutez dans `docker-compose.yml` les variables `IP_ARCHITECT_TRUST_PROXY=1` et `IP_ARCHITECT_SECURE_COOKIES=1`.

## 3. À la main (développement, Windows, macOS)

Prérequis : Node.js 22 et un compilateur C++ (pour `better-sqlite3` si aucun binaire précompilé ne convient).

```bash
npm install
npm run dev                          # développement : http://localhost:3000
npm run build && npm start           # production
```

## Dépannage

- *Le service ne démarre pas* : `journalctl -u ip-architect -n 50`.
- *Code d'installation perdu* : `grep SETUP_CODE /etc/ip-architect/env`.
- *Mot de passe administrateur perdu* : `cd /opt/ip-architect && sudo -u ip-architect env $(cat /etc/ip-architect/env | xargs) npm run user:reset`.
