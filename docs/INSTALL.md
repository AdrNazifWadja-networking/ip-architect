# Installation d'IP Architect

Trois façons de l'installer, de la plus simple à la plus manuelle. La base de données est un **fichier SQLite** : aucun serveur de base de données à installer.

## 1. Sur un serveur Debian / Ubuntu (recommandé)

Un seul script installe Node.js 22, compile l'application, crée un service systemd et configure Nginx. Testé sur Ubuntu Server 26.04 ; prévu pour Ubuntu 22.04 / 24.04 / 26.04 et Debian 12.

### Prérequis du serveur

| Élément | Minimum |
|---|---|
| Système | Debian ou Ubuntu Server 64 bits, avec systemd |
| Ressources | 2 processeurs, **2 Go de RAM** (la compilation en demande autant ; avec 1 Go, ajoutez du swap, voir plus bas), 10 Go de disque |
| Accès | Un compte avec `sudo` (ou root) |
| Internet | Nécessaire **pendant l'installation** : paquets de la distribution, dépôt NodeSource, registre npm, GitHub et Google Fonts (les polices sont téléchargées à la compilation) |
| Réseau | Port 80 libre (et 443 pour HTTPS). Pour une machine virtuelle : réseau en mode « pont » (bridged) pour y accéder depuis un autre poste |
| Outils | `git` (`sudo apt-get install -y git`). Le script installe lui-même Node.js, les outils de compilation, Nginx et le reste |
| Scan réseau | La commande `ping` doit exister (`ping -c1 127.0.0.1`) ; sinon : `sudo apt-get install -y iputils-ping` |

Avec 1 Go de RAM, ajoutez d'abord du swap :
```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
```

Si un Node.js plus ancien que 22 est déjà installé par la distribution (paquets `nodejs`, `libnode-dev`), retirez-le avant : `sudo apt-get remove -y nodejs libnode-dev npm`.

### Installation

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/AdrNazifWadja-networking/ip-architect.git
cd ip-architect
sudo bash ./deploy/install.sh                              # HTTP, port 80
# ou, avec un nom de domaine et un certificat HTTPS gratuit :
sudo bash ./deploy/install.sh --domain ipam.exemple.org --letsencrypt
```

La compilation prend 5 à 10 minutes. **En SSH**, lancez l'installation dans `tmux` pour qu'une coupure de connexion ne l'interrompe pas :
```bash
sudo apt-get install -y tmux
tmux new -s install
sudo bash ./deploy/install.sh
# connexion coupée ? reconnectez-vous puis : tmux attach -t install
```

À la fin, le script affiche l'adresse du serveur et un **code d'installation**. Ouvrez l'adresse dans le navigateur d'un autre poste : l'écran de création du premier compte administrateur demande ce code. Tant que ce compte n'existe pas, la création de comptes est verrouillée. Code perdu : `sudo grep SETUP_CODE /etc/ip-architect/env`. Adresse du serveur : `hostname -I`.

Au premier démarrage, un projet de **démonstration** (« Entreprise Globale ») est chargé. Quand vous avez tout parcouru, le bouton « Commencer avec mes données » du tableau de bord le supprime et crée votre premier projet.

### Vérifier l'installation

```bash
systemctl status ip-architect --no-pager       # « active (running) »
journalctl -u ip-architect -n 30 --no-pager    # aucune erreur
curl -s http://127.0.0.1:3000/api/health       # {"api":true,"database":true,...}
```

| Élément | Emplacement |
|---|---|
| Application | `/opt/ip-architect` |
| Données (base SQLite) | `/var/lib/ip-architect/ip-architect.db` |
| Configuration | `/etc/ip-architect/env` (variables décrites dans `.env.example`) |
| Service | `systemctl status ip-architect` |
| Journaux | `journalctl -u ip-architect -f` |

Si un pare-feu est actif (`ufw status`), autorisez le web : `sudo ufw allow 80,443/tcp`.

### Mise à jour

```bash
cd ip-architect && git pull && sudo bash ./deploy/install.sh
```
La configuration et les données sont conservées (aucun nouveau code d'installation n'est généré).

### Sauvegarde

Copiez `/var/lib/ip-architect/ip-architect.db`, ou utilisez Paramètres > Sauvegarde dans l'application (la copie exclut les sessions et les secrets). Protégez ces copies : la base contient des informations sensibles.

### Options du script

`--domain NOM`, `--letsencrypt` (certificat HTTPS ; demande un nom de domaine pointant vers le serveur et les ports 80 et 443 joignables depuis Internet), `--no-web` (sans Nginx : l'application écoute alors sur 127.0.0.1:3000 pour votre propre proxy), `--port N`. Pour **Apache** à la place de Nginx, lancez avec `--no-web` et adaptez `deploy/apache.conf.example`.

**HTTPS** : sans `--letsencrypt`, mots de passe et jetons circulent en clair. Ne l'utilisez ainsi que sur un réseau de confiance ou derrière votre propre terminaison TLS ; dans ce cas, mettez `IP_ARCHITECT_SECURE_COOKIES=1` dans `/etc/ip-architect/env` puis `sudo systemctl restart ip-architect`.

### Désinstallation

```bash
sudo systemctl disable --now ip-architect
sudo rm /etc/systemd/system/ip-architect.service /etc/nginx/sites-enabled/ip-architect /etc/nginx/sites-available/ip-architect
sudo systemctl daemon-reload && sudo systemctl reload nginx
sudo rm -rf /opt/ip-architect /etc/ip-architect
# vos données restent dans /var/lib/ip-architect : supprimez-les seulement si vous n'en avez plus besoin
```

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

- *Le script répond « Permission denied »* : lancez-le avec `bash` (`sudo bash ./deploy/install.sh`).
- *Le service ne démarre pas* : `journalctl -u ip-architect -n 50 --no-pager`.
- *La compilation s'arrête (« Killed »)* : mémoire insuffisante, ajoutez du swap (voir plus haut).
- *Code d'installation perdu* : `sudo grep SETUP_CODE /etc/ip-architect/env`.
- *Mot de passe administrateur perdu* :
  ```bash
  sudo -u ip-architect bash -c 'set -a; . /etc/ip-architect/env; set +a; cd /opt/ip-architect && npm run user:reset -- <identifiant>'
  ```
