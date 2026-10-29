# IP Architect

Plateforme de conception et de gestion d'architectures IP (IPAM) : dashboard, sous-réseaux IPv4/IPv6 avec détection de chevauchement, calculateur CIDR.

**Stack :** Next.js 14 (App Router) · TypeScript · Tailwind CSS · SQLite (`better-sqlite3`) · Recharts · lucide-react

## Démarrage

Prérequis : **Node.js 22 (LTS)**. Évitez Node 24 : `better-sqlite3` (module natif) n'y a pas de binaire prêt à l'emploi dans la version utilisée ici, et `npm install` tente alors de le compiler, ce qui exige les outils C++ de Visual Studio.

```bash
npm install
npm run dev
```

Puis ouvrir http://localhost:3000. La base SQLite est créée automatiquement dans `data/ip-architect.db`
et remplie avec des données de démonstration au premier lancement.

## Scripts

| Commande            | Rôle                                                        |
| ------------------- | ----------------------------------------------------------- |
| `npm run dev`       | Serveur de développement                                    |
| `npm run build`     | Build de production                                         |
| `npm start`         | Lance le build de production                                |
| `npm test`          | Tests : calcul IP, allocation, traductions, VLANs/IPAM, DHCP, VRF, modifications, sites et projets, CSV, supervision, rapports, planification, simulateur, authentification, journal d'audit et paramètres (base en mémoire) |
| `npm run typecheck` | Vérification TypeScript                                     |
| `npm run seed`      | Réinitialise la base avec les données de démonstration      |
| `npm run user:reset -- <identifiant>` | Secours : recrée un administrateur et fixe son mot de passe |
| `npm run alerts:send` | Envoie les alertes par e-mail (à planifier avec cron)        |
| `npm run rename:cities` | Une fois : renomme les villes françaises de la démo en villes togolaises dans une base existante |

## Ce qui est fonctionnel (phase 1)

- **Dashboard** : KPIs, utilisation des adresses, répartition IPv4/IPv6, top 5 sites, évolution (instantané enregistré chaque jour), réseaux par statut, alertes récentes. Tout est calculé depuis SQLite.
- **Réseaux** : liste filtrable (recherche, statut, version), création avec aperçu CIDR en direct, **détection de chevauchement**, suppression.
- **Calculateur IP** : réseau, broadcast, masque, wildcard, plage d'hôtes, découpage en sous-réseaux, test d'appartenance. IPv4 et IPv6 (BigInt).
- **Barre de statut** : sonde réelle `/api/health` (API, base de données, temps de réponse).
- Recherche globale (`⌘K` / `Ctrl+K`) : ouvre la liste des réseaux filtrée.

## Ce qui est fonctionnel (phase 2)

- **VLANs** (`/vlans`) : liste filtrable (texte, site), création, suppression. Un numéro de VLAN (1 à 4094) est unique par site ; les VLAN « globaux » (sans site) sont uniques entre eux. Un VLAN encore utilisé par des réseaux ne peut pas être supprimé. Le nombre de réseaux rattachés (même site, même numéro) est calculé.
- **IPAM** (`/ipam`) : liste des réseaux avec utilisation et nombre d'adresses inventoriées ; clic sur un réseau (ou sur son CIDR dans la page Réseaux) pour ouvrir son détail :
  - **grille d'occupation** (IPv4 jusqu'à 1 024 adresses, soit un /22) : libre / utilisée / réservée, clic sur une case libre pour préremplir le formulaire ;
  - **allocation** d'une adresse précise, ou de la **première adresse libre** si le champ est vide, en « utilisée » ou « réservée », avec nom d'hôte et description ;
  - **libération** d'une adresse ;
  - refus clairs : adresse invalide, hors réseau, adresse réseau ou broadcast, déjà inventoriée, réseau plein.
- **Compteurs** : `used_ips` / `reserved_ips` d'un réseau (ceux du dashboard) restent la référence et valent toujours **au moins** le nombre d'adresses inventoriées. Allouer ou libérer une adresse les met à jour dans la même transaction ; la différence s'affiche comme « adresses non inventoriées » (hôtes connus seulement par leur nombre).
- **Base existante** : au premier démarrage avec cette version, la table des adresses est créée et des adresses de démonstration sont ajoutées **une seule fois**, uniquement aux réseaux de démonstration (vos propres réseaux ne sont jamais modifiés). `npm run seed` repart d'une base neuve (attention : cela efface vos données).

## Ce qui est fonctionnel (phase 3)

- **DHCP** (`/dhcp`) : plages de distribution IPv4, rattachées à un réseau.
  - Création : réseau, nom (unique), première et dernière adresse, passerelle, jusqu'à 4 serveurs DNS, durée de bail, état actif/désactivé.
  - Contrôles : adresses attribuables et dans le réseau (ni adresse réseau, ni broadcast), début ≤ fin, **aucun chevauchement** entre deux plages d'un même réseau, DNS valides (IPv4 ou IPv6), bail de 1 minute à 365 jours. Les réseaux IPv6 sont refusés.
  - Indicateurs : taille de la plage, adresses distribuables, **conflits IPAM** (adresses inventoriées qui tombent dans la plage dynamique), avertissement si la passerelle est dans la plage.
  - **Réservations MAC → IP** (`/dhcp/<id>`) : l'adresse MAC est normalisée (`aa:bb:cc:dd:ee:ff`, acceptée avec `:`, `-`, `.` ou sans séparateur) ; chaque réservation est aussi inventoriée dans l'IPAM (statut « réservée ») et le compteur du réseau suit. Supprimer une réservation, ou la plage entière, libère ces adresses.
  - **Export de configuration** : texte prêt à coller pour **ISC dhcpd** (`dhcpd.conf`) ou **Cisco IOS** (pool, adresses exclues, un pool « host » par réservation), à copier ou à télécharger. Le fichier généré reste en anglais, quelle que soit la langue de l'interface.
  - Ce module décrit la configuration voulue : il ne parle pas à un serveur DHCP et ne voit donc pas les baux réellement distribués.
- **Base existante** : au premier démarrage, les tables DHCP sont créées et 15 plages de démonstration (VLAN 10, 50 et 60 de chaque site de démo, avec 2 réservations chacune) sont ajoutées **une seule fois**. Vos réseaux ne sont jamais modifiés.

## Ce qui est fonctionnel (phase 4)

- **VRF** (`/vrf`) : une VRF est un espace d'adressage isolé. **Le même CIDR peut exister dans deux VRF différentes** (ex. `10.1.10.0/24` dans CORP et dans GUEST) sans être signalé comme un chevauchement ; dans une même VRF, le chevauchement reste refusé. Les réseaux sans VRF forment la table de routage globale.
  - Création : nom (lettres, chiffres, `-`, `_`, 32 caractères max, repris tel quel dans la configuration), route distinguisher optionnel (`65000:100`, `4200000001:100` ou `10.0.0.1:100`, selon la RFC 4364), route targets import/export (8 par liste, exigent un RD ; sans RD la VRF est une VRF-Lite), description. Nom et RD sont uniques.
  - **Rattacher un réseau** : à sa création (champ VRF) ou à tout moment depuis la colonne VRF de la page Réseaux (menu déroulant dans le tableau, filtre VRF dans la barre d'outils). Un déplacement qui créerait un chevauchement dans la VRF de destination est refusé.
  - Une VRF qui contient encore des réseaux ne peut pas être supprimée.
  - Détail (`/vrf/<id>`) : réseaux rattachés, utilisation IPv4, route targets, et **configuration Cisco IOS-XE** (`vrf definition`, familles IPv4/IPv6, route targets) à copier ou à télécharger.
  - Les pages IPAM et DHCP affichent la VRF des réseaux pour distinguer deux réseaux de même CIDR.
- **Base existante** : au premier démarrage, la colonne `vrf_id` est ajoutée aux réseaux (valeur vide = globale : rien ne change pour vos réseaux) et 4 VRF de démonstration (CORP, DMZ, MGMT, GUEST) sont créées et rattachées **aux seuls réseaux de démonstration**.
- Ce module décrit l'architecture voulue : il ne configure aucun routeur et ne fait pas de routage.

## Ce qui est fonctionnel (phase 5 : modification)

Tout ce qui se crée peut maintenant se modifier (icône crayon dans chaque ligne, ou bouton « Modifier » dans l'en-tête des pages de détail). Les mêmes contrôles qu'à la création s'appliquent, un refus n'écrit rien, et un champ absent reste inchangé.

- **Réseaux** : nom, site, VLAN, statut, VRF, compteurs d'IP utilisées/réservées. Le CIDR est figé (supprimez puis recréez pour le changer). Les compteurs ne peuvent pas descendre sous le nombre d'adresses déjà inventoriées dans l'IPAM, ni dépasser la capacité. Un changement de VRF qui créerait un chevauchement à destination est refusé.
- **VLANs** : nom, numéro et site. Tant que des réseaux utilisent le VLAN, seul son nom est modifiable (les réseaux le retrouvent par site et numéro). Le numéro reste unique par site.
- **Plages DHCP** : nom, première et dernière adresse, passerelle, DNS, bail, état. Le réseau est figé. Pas de chevauchement avec les autres plages du réseau (la plage ne se chevauche pas elle-même : on peut l'agrandir).
- **Réservations DHCP** (modification en ligne) : adresse MAC, nom d'hôte, description, avec synchronisation de l'inventaire IPAM. Pour changer l'IP, supprimez puis recréez la réservation.
- **VRF** : nom, route distinguisher, route targets, description. Retirer le RD exige de retirer aussi les route targets (VRF-Lite).
- **Adresses IPAM** (modification en ligne) : type utilisée/réservée (les compteurs du réseau suivent), nom d'hôte, description. Une adresse créée par une réservation DHCP reste « réservée ».
- Pas de changement de schéma : aucune migration, aucune donnée de démo ajoutée.

## Ce qui est fonctionnel (phase 6 : sites et projets)

- **Sites** (`/sites`) : création, modification, suppression, recherche. Chaque site a un nom (unique dans le projet), une adresse et une description facultatives, le nombre de réseaux et de VLANs, l'utilisation IPv4 moyenne, et un lien vers ses réseaux (`/reseaux?site=<id>`). Un site qui contient encore des réseaux ou des VLANs ne se supprime pas (409) : déplacez-les d'abord.
- **Projets** (`/projets`) : espaces de travail indépendants (réseaux, sites, VLANs, DHCP, VRF). Création (le projet est vide, sans donnée de démo), modification, **activation** (toutes les pages montrent alors ce projet ; le menu latéral rappelle son nom et mène à cette page) et suppression. Supprimer un projet supprime tout son contenu, avec confirmation chiffrée ; le projet actif ne se supprime pas.
- **Migration automatique** : `projects` et `sites` gagnent des colonnes facultatives (description, adresse, date de création) et une table `settings` retient le projet actif. Vos données existantes sont conservées telles quelles : **redémarrez le serveur** (`Ctrl+C`, `npm run dev`) pour que la migration s'exécute.

## Ce qui est fonctionnel (phase 7 : import/export CSV, supervision, rapports)

- **Import / export CSV** (`/import-export`) : 7 types de données (sites, VRF, VLANs, réseaux, adresses, plages DHCP, réservations DHCP). L'export est un fichier UTF-8 avec BOM (Excel affiche les accents), séparateur `;` par défaut (ou `,` / tabulation), en-têtes techniques identiques dans toutes les langues, et un gabarit d'exemple par type. L'import passe par **les mêmes contrôles que l'interface** : il commence par une **simulation** (rien n'est écrit, vous voyez exactement ce qui se passerait, ligne par ligne), puis l'import réel est **tout ou rien** : une seule erreur annule tout. Une ligne déjà présente est ignorée (réimport possible) ou signalée en erreur, au choix. Les lignes se rattachent par nom de site / VRF / plage et par CIDR. Ordre conseillé pour restaurer un projet : sites, VRF, VLANs, réseaux, adresses, plages, réservations. Les cellules de texte commençant par `=`, `+`, `-` ou `@` sont protégées contre l'exécution de formules par Excel.
- **Supervision** (`/supervision`) : contrôles calculés en direct, rien n'est stocké. Capacité de chaque réseau comparée à deux seuils réglables (80 % / 90 % par défaut), cohérence des données (VLAN référencé mais non défini ou inutilisé, réseau en erreur ou en maintenance ou sans site, nom d'hôte en double, adresse statique dans une plage DHCP active), **prévision** de saturation (tendance linéaire de l'historique quotidien, à partir de 7 jours de relevés), et **sonde de joignabilité** : un ping des adresses inventoriées d'un réseau (64 maximum par lancement). La sonde exécute la commande `ping` du système qui héberge le serveur (jamais par un shell ; seules des adresses déjà enregistrées dans l'IPAM peuvent être testées) ; si elle n'existe pas, la page l'indique.
- **Rapports** (`/rapports`) : synthèse, par site, réseaux, DHCP, VLANs, VRF. Chaque rapport s'exporte en CSV (en-têtes dans la langue courante) et s'**imprime** proprement (bouton « Imprimer / PDF » : menu masqué, thème clair forcé ; choisissez « Enregistrer au format PDF » dans la fenêtre d'impression). Capacités et occupations ne portent que sur l'IPv4.
- Pas de nouvelle table ni de migration : aucun redémarrage particulier n'est nécessaire au-delà du rechargement habituel.

## Ce qui est fonctionnel (phase 8 : planification et simulateur)

- **Planification** (`/planification`) : un plan = un bloc parent (éventuellement dans une VRF) + une liste de besoins (nom, nombre d'hôtes **ou** préfixe, site, VLAN). Les réseaux sont placés automatiquement (VLSM : les plus gros besoins d'abord, au premier emplacement libre aligné, en évitant les réseaux existants de la même VRF) et l'éditeur montre l'aperçu en direct pendant la saisie. Un plan **brouillon** ne réserve rien : l'emplacement est recalculé à chaque affichage. **Appliquer** crée réellement les réseaux (même contrôles que la page Réseaux), **tout ou rien** : si un seul besoin n'a pas de place, rien n'est créé. Le plan est ensuite figé (seuls son nom et sa description restent modifiables) ; le supprimer conserve les réseaux créés. Besoin en hôtes : le plus petit bloc offrant ce nombre d'adresses utilisables (minimum un /30) ; IPv4 uniquement, en IPv6 on indique le préfixe.
- **Simulateur** (`/simulateur`) : « et si… ? » en **lecture seule** (rien n'est écrit). *Découper* un réseau en sous-réseaux plus petits (adresses inventoriées par sous-réseau, plages DHCP à cheval à redécouper, conflits) ; *Agréger* des réseaux (résumé de routes exact, plus petit bloc unique, adresses en trop, réseaux existants qui gêneraient) ; *Espace libre* d'un bloc et premier emplacement pour un préfixe ; *Vérifier un CIDR* (peut-on le créer ? chevauchements bloquants dans la même VRF, simple information dans une autre VRF, emplacement proche suggéré).
- **Migration automatique** : deux nouvelles tables (`plans`, `plan_items`), créées au démarrage sans toucher à vos données. **Redémarrez le serveur** pour qu'elles soient créées.

## Ce qui est fonctionnel (phase 9 : utilisateurs et connexion)

- **Tant qu'aucun compte n'existe, l'application reste ouverte** (comme avant). Sur `/utilisateurs`, créer le **premier compte** (toujours administrateur) **active la connexion pour tout le monde** : à partir de là, chaque page et chaque route de l'API exige une session. Créez ce premier compte vous-même dès l'installation si le serveur est joignable par d'autres personnes : tant qu'il n'existe pas, le premier visiteur pourrait le créer.
- **Trois rôles** : *lecteur* (consulte tout, lance des simulations, change son mot de passe), *éditeur* (+ crée, modifie, supprime les données, importe, change de projet actif), *administrateur* (+ comptes, création/renommage/suppression de projets, seuils de supervision, configuration de l'assistant IA et de l'inscription par e-mail). La règle est écrite une seule fois (`src/lib/auth/policy.ts`) ; un test vérifie que chaque route de l'API et chaque page s'y conforme.
- **Sécurité** : mots de passe hachés avec scrypt (sel aléatoire, comparaison à temps constant), 10 caractères minimum, ni répétitifs ni contenant l'identifiant ; sessions par jeton aléatoire de 256 bits (seul son hash est en base), cookie `HttpOnly` + `SameSite=Lax` (et `Secure` derrière HTTPS), expiration après 8 h d'inactivité ou 7 jours ; même message d'erreur pour identifiant inconnu, mauvais mot de passe et compte désactivé ; **5 échecs bloquent 15 minutes** ; toute écriture dont l'en-tête `Origin` désigne un autre site est refusée ; le rôle est relu en base à chaque requête (un changement s'applique tout de suite) ; désactiver, supprimer ou réinitialiser le mot de passe d'un compte ferme ses sessions.
- **Garde-fous** : impossible de retirer, désactiver ou supprimer le dernier administrateur actif, ni de modifier son propre rôle ou état. Chacun change son mot de passe dans « Mon compte » (l'ancien est exigé ; ses autres sessions sont fermées).
- **Mot de passe administrateur perdu** : sur le serveur, `npm run user:reset -- <identifiant>` recrée ou réinitialise un compte administrateur et affiche un mot de passe aléatoire, une seule fois (à changer ensuite dans « Mon compte »).
- **Limites connues** : la limitation des tentatives est en mémoire (elle repart à zéro au redémarrage du serveur) et se base aussi sur l'en-tête `X-Forwarded-For`, qu'un client peut falsifier si le serveur n'est pas derrière un proxy de confiance ; pas de double authentification ; ne l'exposez pas sur Internet sans HTTPS.
- Deux nouvelles tables (`users`, `user_sessions`) sont créées au démarrage, sans toucher à vos données : **redémarrez le serveur**.

## Ce qui est fonctionnel (phase 10 : paramètres et journal d'audit)

- **Journal d'audit** (`/audit-logs`, administrateur) : une ligne pour chaque action **réussie** qui modifie des données (création, modification, suppression, activation d'un projet, application d'un plan, import CSV réel, réglages, sauvegarde), plus les connexions, déconnexions, **échecs de connexion** et changements de mot de passe. Chaque ligne indique la date (UTC), le compte, l'action, l'objet (libellé lisible, conservé même après suppression de l'objet), le projet et l'adresse IP. **Jamais de mot de passe, de jeton ni de valeur saisie** : pour une modification, seuls les *noms* des champs changés sont écrits. Les simulations, sondes, refus (401/403) et erreurs de validation ne sont pas journalisés. Filtres (texte, compte, action, objet, dates), pagination, export CSV (50 000 lignes au plus, protégé contre les formules Excel). Le journal ne se modifie pas : seule la purge automatique le réduit (durée de conservation réglable, 365 jours par défaut ; plafond de 200 000 lignes). Il survit à la suppression d'un compte ou d'un projet. Une écriture impossible dans le journal n'annule jamais l'action déjà réussie (l'erreur est tracée dans la console du serveur).
- **Paramètres** (`/parametres`, administrateur) : nom de l'organisation (affiché en tête des rapports), seuils de supervision, durée de conservation du journal, informations sur la base (fichier, taille, version de SQLite, nombre de lignes par table) et **sauvegarde** : téléchargement d'une copie cohérente de la base (`.db`, compacte, sans les sessions ouvertes). **Cette copie contient les comptes et les empreintes de mots de passe : gardez-la comme un secret.** (La clé d'API de l'assistant IA, le mot de passe SMTP et les inscriptions en attente en sont retirés.) Pour restaurer, arrêtez le serveur et remplacez `data/ip-architect.db` par la copie. Les réglages se valident ensemble : une valeur invalide n'en enregistre aucune.
- **Limites connues** : l'adresse IP du journal vient de l'en-tête `X-Forwarded-For` (falsifiable sans proxy de confiance) ; le journal est dans la même base que les données, donc un administrateur disposant du fichier peut l'altérer : pour une preuve opposable, exportez-le régulièrement ailleurs.
- Une nouvelle table (`audit_log`) est créée au démarrage, sans toucher à vos données : **redémarrez le serveur**.


## Ce qui est fonctionnel (phase 11 : Assistant IA)

- **Assistant IA** (`/assistant-ia`) : on pose des questions en langage courant (« quels réseaux sont presque saturés ? », « découpe 10.1.0.0/16 en /24 », « où est l'adresse 10.1.10.15 ? »). L'assistant **ne calcule et n'invente rien** : pour tout chiffre, adresse ou découpage, le modèle appelle des **outils en lecture seule** branchés sur le moteur exact de l'application (rapports, liste et détail des réseaux, recherche d'adresse, VLANs, sites, VRF, plages DHCP, supervision, calcul de sous-réseau en BigInt, simulateur). Les outils consultés sont affichés sous chaque réponse. **Il ne peut rien modifier** : aucun outil n'écrit, et il indique la page de l'application qui permet le changement.
- **Services gratuits ou locaux** : un seul client « compatible OpenAI » pour **Ollama** (local, privé : `http://localhost:11434/v1`), **Google Gemini** (clé gratuite Google AI Studio : `https://generativelanguage.googleapis.com/v1beta/openai`) ou toute autre API compatible. Le modèle doit savoir **appeler des outils** (ex. `qwen3:8b`, `llama3.1:8b`, ou un modèle Gemini). Les offres gratuites ont des limites par modèle et par projet ; **vérifiez la politique de données de l'offre gratuite avant d'y envoyer des données sensibles**.
- **Configuration** (administrateur, même page) : service, adresse, modèle (liste remplie par « Tester la connexion »), clé d'API, activation. Un guide de démarrage pas à pas est affiché sur la page.
- **Confidentialité et sécurité** : les questions et les données d'adressage nécessaires à la réponse (noms, CIDR, adresses, statuts) sont envoyées au service choisi. La **clé d'API** est stockée dans la table `settings`, n'est **jamais renvoyée** par l'API (seulement « une clé est enregistrée ») et est **retirée des sauvegardes** (copie recompactée pour qu'elle ne subsiste pas dans les pages libres). Les noms et descriptions saisis par les utilisateurs sont traités comme des **données non fiables** (injection de consignes) : ils ne sont jamais placés en rôle système et le prompt interdit de leur obéir ; l'absence d'outil d'écriture limite de toute façon les dégâts. Le journal d'audit enregistre « Question à l'assistant » avec le service, le modèle et les outils utilisés, **jamais le texte de la question**. Les erreurs du service ne sont jamais renvoyées telles quelles (traduites en messages).
- **Limites** : 20 questions par 5 minutes et par utilisateur, 20 messages par conversation, 4 000 caractères par message, 6 tours d'outils par question, délai de 90 s, réponses du service plafonnées à 2 Mo, aucune redirection suivie. L'historique de conversation reste dans le navigateur (non conservé côté serveur). La qualité des réponses dépend du modèle choisi : un petit modèle local répond moins bien qu'un gros modèle en ligne.
- Aucune nouvelle table : la configuration utilise la table `settings`. Pas de nouvelle dépendance.

## Ce qui est fonctionnel (phase 12 : notifications et menu de l'en-tête)

- **Cloche de notifications** : la pastille et la liste reprennent les **contrôles de supervision en cours** (critiques et avertissements), calculés à la demande sur vos données réelles : capacité dépassée, réseau en erreur, VLAN non défini, noms d'hôte en double, adresse fixe dans une plage DHCP. Chaque ligne indique la gravité, le message traduit et renvoie à la page où corriger. Un problème corrigé disparaît tout seul. La liste se rafraîchit toutes les minutes (onglet visible) et à l'ouverture.
- **Lu / non lu, par compte** : « Marquer comme lu » (une notification ou toutes). Chaque compte a ses propres marques (l'application ouverte, sans compte, a les siennes). Un nouveau problème, ou un problème qui s'aggrave (avertissement -> critique), est de nouveau non lu ; les valeurs qui bougent sans cesse (pourcentage, compteurs) ne comptent pas dans l'identité d'un problème. Marquer « lu » n'est pas journalisé (ce n'est pas une modification des données d'adressage) et reste possible pour un lecteur. Les marques de plus de 90 jours et celles des comptes supprimés sont purgées. Une table (`notification_reads`) est créée au démarrage : **redémarrez le serveur**.
- **Menu de l'engrenage** : Mon compte et mot de passe, Supervision et seuils ; pour un administrateur (ou l'application ouverte) : Paramètres, Journal d'audit, configuration de l'Assistant IA ; déconnexion (utile sur petit écran, où le bloc du compte de l'en-tête est masqué). Les pages d'administration vérifient de toute façon le rôle côté serveur.
- **À savoir** : l'ancienne cloche comptait les lignes d'une table `alerts` que seul le jeu de démonstration remplit (aucun code ne crée d'alertes) ; la cloche utilise maintenant la supervision. Le bloc « Alertes récentes » et l'indicateur « Alertes » du Dashboard lisent encore cette table de démonstration. Le jeu de démonstration produit beaucoup de notifications (noms d'hôte en double) : « Tout marquer comme lu » les écarte.

## Ce qui est fonctionnel (phase 13 : inscription par e-mail)

- **Inscription en libre-service** (`/inscription`, lien « Créer un compte » sur la page de connexion) : la personne saisit son e-mail, un identifiant, son nom et un mot de passe ; un **code à 6 chiffres** lui est envoyé par e-mail, **valable 2 minutes**. Le bon code crée le compte et ouvre la session. **Délai dépassé** (ou 5 essais faux) : la demande est supprimée et il faut **recommencer l'inscription** (la page l'indique avec un bouton). Le décompte affiché est indicatif : c'est le serveur qui fait foi.
- **L'administrateur garde tous ses droits** : un compte créé ainsi est **toujours « Lecteur »** (jamais éditeur ni administrateur) ; seul un administrateur peut changer un rôle, désactiver ou supprimer un compte. L'inscription est **fermée par défaut**, ne s'ouvre que si un administrateur l'active (**Paramètres > Inscription par e-mail**) et **n'existe pas tant qu'aucun compte n'existe** (application encore ouverte). Option : limiter aux **domaines** autorisés (ex. `monentreprise.com`).
- **Envoi des e-mails** : client SMTP **intégré, sans nouvelle dépendance** (pas de `npm install`). TLS (port 465) ou STARTTLS (port 587) ; le certificat du serveur est toujours vérifié ; les identifiants ne partent **jamais en clair** (STARTTLS absent = envoi refusé ; « aucune sécurité » n'est accepté que vers la machine locale). Réglages, message de test et guide Gmail (mot de passe d'application) dans **Paramètres**. **Mode console** (test) : le code est écrit dans la console du serveur au lieu d'être envoyé, pour essayer sans serveur de mail ; à ne pas laisser actif.
- **Sécurité** : code non stocké en clair (SHA-256 salé), comparaison à temps constant, usage unique, 5 essais ; mot de passe haché (scrypt) dès la demande ; limites de débit (3 demandes par adresse et par 10 min, 10 par IP et par heure, 30 vérifications par IP et par 10 min, en mémoire) ; une **adresse déjà utilisée n'est pas révélée** (même réponse ; son propriétaire reçoit un message l'en informant) ; adresses validées strictement (aucune injection d'en-têtes) ; origine vérifiée ; le **mot de passe SMTP** n'est jamais renvoyé ni conservé dans les sauvegardes (qui ne contiennent pas non plus les inscriptions en attente) ; le journal d'audit note la création du compte (« inscription par e-mail ») et la connexion, jamais le code ni les secrets.
- **Adresse e-mail des comptes** : facultative pour les comptes créés par un administrateur (champ dans le formulaire, colonne dans la liste, ✓ = vérifiée), unique sans tenir compte de la casse ; la modifier la rend non vérifiée.
- **Limites connues** : un identifiant déjà pris est signalé (les identifiants ne sont pas secrets) ; pas de « code renvoyé » ni de réinitialisation du mot de passe par e-mail ; la connexion se fait toujours avec l'identifiant ; limites de débit remises à zéro au redémarrage ; le client SMTP a été testé contre un faux serveur (TLS, STARTTLS, AUTH PLAIN/LOGIN), pas contre un fournisseur réel.
- Une nouvelle table (`signup_requests`) et deux colonnes (`users.email`, `users.email_verified_at`, NULL pour les comptes existants) sont ajoutées au démarrage, sans toucher à vos données : **redémarrez le serveur**.

## Ce qui est fonctionnel (phase 14 : documentation)

- **Documentation** (`/documentation`, lien « Besoin d'aide ? » du menu, tout compte connecté) : guide complet en français et en anglais, avec **sommaire**, **recherche** (tous les mots saisis doivent être présents, y compris dans le tableau de l'API) et impression propre. Quatre parties : *Démarrer* (installation, notions de base, scénarios pas à pas), *Modules* (une section par page du menu), *Administration* (utilisateurs et rôles, mot de passe, paramètres et sauvegarde, journal d'audit, inscription par e-mail et SMTP avec exemple Gmail, notifications, sécurité), *Référence* (interface, **tableau de l'API**, dépannage, limites connues). Chaque section de module a un bouton qui ouvre la page décrite.
- **Le contenu ne peut pas dériver du code** : `npm test` vérifie que le français et l'anglais ont les mêmes sections et la même structure, que chaque lien mène à une vraie page, que chaque module du menu est documenté, que le tableau de l'API correspond **exactement** aux fichiers `route.ts` (aucune route inventée ni oubliée), que le rôle affiché vient de `policy.ts`, et que les commandes `npm run …` citées existent.
- **Ajouter ou corriger une page de documentation** : éditer `src/lib/docs/content.fr.ts` et `content.en.ts` (mêmes `id` et mêmes blocs dans les deux) ; une nouvelle route d'API se déclare dans `src/lib/docs/api.ts`.
- Aucune nouvelle table, aucune dépendance : pas de migration.

## Ce qui est fonctionnel (phase 15 : jetons d'API, OpenAPI, historique avant/après)

- **Jetons d'API** (`/jetons-api`, menu Paramètres) : un script ou un outil d'automatisation appelle l'API avec `Authorization: Bearer ipa_…` au nom de votre compte, sans mot de passe ni cookie. Le jeton (256 bits aléatoires) **n'est montré qu'une fois** ; seul son hash SHA-256 est stocké. Droits au choix : *lecture seule* ou *lecture et écriture* (**jamais administrateur** : comptes, projets, réglages et sauvegardes exigent une session de navigateur). Les droits sont **plafonnés en permanence par ceux du propriétaire** : un compte rétrogradé, désactivé ou supprimé réduit ou coupe ses jetons aussitôt. Expiration au choix (90 jours par défaut, 730 au plus, ou aucune), 20 jetons actifs au plus par compte, révocation immédiate (la ligne est conservée), « dernière utilisation » mise à jour au plus une fois par minute. Un jeton ne peut ni créer ni lister des jetons, ni changer un mot de passe. Un jeton présenté mais invalide donne 401 (jamais de repli sur le cookie). Un administrateur voit et peut révoquer tous les jetons.
- **Contrat OpenAPI 3.0** : `GET /api/openapi` (JSON, `?lang=fr|en`), généré depuis la liste réelle des routes et leur politique d'accès (le rôle requis de chaque route y figure) ; importable dans Swagger UI, Postman, Insomnia ou un générateur de client. Les corps de requête sont décrits en texte dans chaque opération, pas par un schéma détaillé.
- **Historique avant / après** (Journal d'audit) : chaque modification, suppression ou réglage garde désormais les **valeurs avant et après** des champs utiles (noms lisibles : site, VRF…), dépliables dans le journal et présentes dans l'export CSV. Les champs sont choisis un par un : **jamais de mot de passe, de jeton, de clé d'API, d'adresse e-mail ni d'empreinte**. Une action faite par jeton porte le badge « API » et le début du jeton utilisé.
- Une table (`api_tokens`) et deux colonnes (`audit_log.changes`, `audit_log.via`) sont ajoutées au démarrage, sans toucher à vos données : **redémarrez le serveur**.
- **Limites connues** : les sauvegardes contiennent les empreintes des jetons (jamais les jetons) : après une restauration, révoquez ceux que vous ne reconnaissez plus ; l'historique ne concerne que les actions faites après la mise à jour.

## Ce qui est fonctionnel (phase 16 : mode TP)

- **Mode TP** (`/tp`, menu Outils) : exercices d'adressage **corrigés automatiquement** pour l'enseignement. Un **enseignant** (rôle Éditeur ou Administrateur) crée, publie et supprime des exercices, voit les résultats de tous et les exporte en CSV (`/api/tp/:id/results?format=csv`). Un **étudiant** (rôle Lecteur) voit les exercices publiés, remet ses réponses, reçoit une note sur 100 et un commentaire par réponse. Il n'y a pas de nouveau rôle : les comptes créés par l'inscription par e-mail (Lecteur, domaines autorisés) conviennent pour une classe.
- **Deux types d'exercices** : *Découpage VLSM* (un bloc IPv4 et des besoins en hôtes ; l'étudiant donne un sous-réseau par besoin ; le moteur vérifie adresse réseau, appartenance au bloc, absence de chevauchement, taille suffisante et économie d'adresses : une réponse trop grande vaut la moitié des points ; à la création, l'application vérifie que les besoins tiennent dans le bloc) et *Calcul de sous-réseaux* (adresses avec masque, ex. `192.168.37.141/27` ; réseau, broadcast, première et dernière adresse, nombre d'hôtes, masque au choix de l'enseignant ; **questions tirées au hasard à partir du compte de l'étudiant** : chacun a les siennes, stables d'une tentative à l'autre).
- **Règles** : tentatives limitées (3 par défaut, 10 au plus), **la meilleure note compte** ; date limite facultative ; **la bonne réponse n'est jamais envoyée à l'étudiant** avant d'être dévoilée (option « montrer la solution une fois les tentatives épuisées ou la date passée ») ; l'énoncé est figé dès qu'une remise existe ; un brouillon est introuvable pour un étudiant ; supprimer un compte étudiant conserve ses notes sous son nom ; sans compte (application ouverte) personne ne peut remettre.
- **Correction** : les bonnes réponses viennent du même moteur que le Calculateur IP et la Planification (`calcSubnet`, `allocateBlocks`), jamais d'une table saisie à la main. Elle accepte toute réponse valide, pas seulement celle de référence (en VLSM : n'importe quel emplacement correct). Masque accepté en `255.255.255.224`, `/27` ou `27`.
- **Journal** : création, modification (avant/après) et suppression d'un exercice sont journalisées. Les remises ne le sont pas (elles sont elles-mêmes la trace : date, compte, réponses, note).
- Deux tables (`tp_exercises`, `tp_submissions`) sont créées au démarrage sans toucher à vos données : **redémarrez le serveur**.
- **Limites connues** : pas de projet « bac à sable » par étudiant (la correction porte sur les réponses remises, pas sur des données saisies dans l'IPAM) ; pas de classes ni de groupes (tous les étudiants voient tous les exercices publiés) ; pas de duplication d'exercice ; IPv4 seulement ; la note d'une remise n'est pas recalculée si le moteur change ensuite.

## Ce qui est fonctionnel (phase 17 : PME — Docker, alertes e-mail, mot de passe oublié)

- **Mot de passe oublié** : lien sur la page de connexion (visible dès que l'envoi d'e-mails est configuré). Code à 6 chiffres, 10 minutes, 5 essais, usage unique ; réponse identique que l'adresse existe ou non ; le changement ferme toutes les sessions du compte. Routes publiques `/api/auth/reset/start` et `/verify`.
- **Alertes par e-mail** (Paramètres > Alertes par e-mail) : les nouveaux problèmes de supervision de tous les projets partent dans un seul message ; un problème déjà signalé n'est pas renvoyé tant qu'il dure, mais l'est s'il disparaît puis revient ; en cas d'échec d'envoi le passage suivant réessaie. Planificateur intégré au serveur (`src/instrumentation.ts`, vérification chaque minute, délai réglable 5–1440 min) ; sans serveur permanent : `npm run alerts:send` (`-- --force` ignore le délai). Une table `alert_state` est créée au démarrage : **redémarrez le serveur**.
- **Docker** : `docker compose up -d --build` puis http://localhost:3000. Base dans le volume `ipa-data` (`/data`). Créer le premier administrateur : `docker compose exec ip-architect npm run user:reset -- admin` (mot de passe généré et affiché).
- **Limites** : l'image Docker et le planificateur n'ont pas pu être exécutés dans l'environnement de développement (à vérifier chez vous) ; l'envoi réel via un fournisseur SMTP n'a pas été testé.

## Ce qui est fonctionnel (phase 18 : rôles par projet)

- **Portée d'un compte** : « Tous les projets » (comportement historique, aucun changement pour vos comptes existants) ou « Projets choisis » avec un rôle Lecteur/Éditeur par projet (Utilisateurs). Les administrateurs voient tout.
- **Projet actif personnel** : chaque compte a son propre projet actif, choisi parmi ceux auxquels il a accès ; toutes les pages et routes travaillent dans ce projet, et un objet d'un autre projet est introuvable (404).
- **API** : en-tête facultatif `X-Project-Id` (documenté dans OpenAPI) ; un jeton est plafonné par le rôle de son propriétaire dans le projet visé. Colonnes `project_scope` / `active_project_id` et table `project_members` ajoutées au démarrage : **redémarrez le serveur**.
- Un compte « Projets choisis » sans projet voit la page « Aucun projet attribué » (TP, documentation et jetons restent accessibles). Une inscription libre ne reçoit aucun projet dès qu'il en existe plusieurs.
- Le changement de projet actif est désormais une action de niveau lecteur (c'est un choix d'affichage personnel). Correction d'un doublon dans le journal à la création d'un projet.
- **Alertes e-mail par projet** (phase 18b) : en plus des destinataires communs (qui reçoivent tout), chaque projet peut avoir ses propres destinataires (un contact par client) qui ne reçoivent que les problèmes de leur projet. Table `project_alert_recipients` créée au démarrage : redémarrez le serveur. Un projet sans aucun destinataire n'est pas marqué comme signalé : ses problèmes partent dès qu'une adresse est ajoutée.
- **Limites** : pas d'administrateur limité à un projet. (Le bloc « Alertes récentes » du tableau de bord affiche bien les contrôles de supervision en cours, depuis le patch 18.)

## Ce qui est fonctionnel (phase 19 : mode TP, classes et duplication)

- **Classes** (TP > Classes) : un groupe d'étudiants (comptes Lecteur) ; un exercice peut être « réservé à » une classe. Un étudiant ne voit pas, et ne peut pas remettre, un exercice d'une autre classe (introuvable) ; l'enseignant voit tout. Ajout des membres par cases à cocher (avec filtre) et/ou en collant des identifiants (les inconnus sont signalés). Supprimer une classe qui a des exercices est refusé.
- **Duplication** : bouton « Dupliquer » sur la page d'un exercice → brouillon identique (énoncé, réglages, classe), sans remises ni date limite, titre suffixé « (2) ».
- API : `GET/POST /api/tp/classes`, `PATCH/DELETE /api/tp/classes/:id`, `GET /api/tp/students`, `POST /api/tp/:id/duplicate`, champ `classId` sur les exercices. Tables `tp_classes`, `tp_class_members` et colonne `tp_exercises.class_id` créées au démarrage : **redémarrez le serveur**.
- **Limites** : toujours pas de projet « bac à sable » par étudiant (la correction porte sur les réponses remises) ; un enseignant (éditeur) voit toutes les classes ; l'export CSV des résultats n'a pas de colonne « classe ».

## Ce qui est fonctionnel (phase 20 : étiquettes et champs personnalisés)

- **Étiquettes** par projet (nom ≤ 30 caractères, 6 couleurs) posées sur les réseaux et les adresses ; saisie dans les formulaires (les nouvelles étiquettes sont créées à la volée), pastilles dans les listes, filtre `?tag=` sur la liste des réseaux, recherche texte étendue aux étiquettes.
- **Champs personnalisés** par projet et par type d'objet (réseau ou adresse) : texte, nombre, choix, oui/non ; obligatoires ou non ; définis par un administrateur dans la page « Étiquettes et champs » (`/etiquettes`).
- API : `/api/tags`, `/api/custom-fields` ; les réseaux et adresses acceptent `tags` (remplace) et `customFields` (fusion, valeur vide = effacer). Journalisés dans l'audit avec avant/après.
- **CSV** : les fichiers des réseaux et des adresses portent une colonne `tags` (séparées par `|`) et une colonne `cf_<clé>` par champ défini.
- Limites : un champ obligatoire n'est pas exigé à l'import CSV ni à l'application d'un plan ; pas de filtre par champ personnalisé.

## Ce qui est fonctionnel (phase 22 : arborescence et modification en masse)

- **Arborescence des préfixes** (`/arborescence`) : réseaux regroupés par blocs /8 puis /16 (IPv6 : /32 puis /48), par VRF, avec part d'espace alloué et utilisation cumulée.
- **Modification en masse** dans la liste des réseaux : sélection multiple, changement de statut, site, VLAN, VRF, ajout/retrait d'étiquettes, champs personnalisés ; suppression groupée. Tout ou rien (une erreur nomme le réseau en cause), 200 réseaux au plus, une entrée d'audit par réseau.
- API : `PATCH` et `DELETE /api/networks/bulk`.
- Limites : pas d'édition en masse des adresses IP ni des VLAN ; le nom et le CIDR ne changent pas en masse ; pas d'effacement en masse d'un champ personnalisé.

## Ce qui est fonctionnel (phase 23 : webhooks)

- **Webhooks** (Administration > Webhooks, administrateur) : un POST JSON signé (HMAC-SHA256, en-tête `X-IPA-Signature`) à chaque création/modification/suppression d'un réseau, d'une adresse, d'un VLAN, d'un site, d'une VRF, d'une plage ou réservation DHCP, d'un plan, d'une étiquette ou d'un champ, plus `plan.apply` et `csv.import`. Abonnement par événement (`*`, `network.*`, `vlan.delete`…), 10 webhooks par projet.
- File d'envoi durable en base : réessais à 1 min, 5 min, 30 min, 2 h (5 essais), historique consultable, renvoi manuel, bouton Tester, secret affiché une seule fois et régénérable.
- Sécurité : adresses lien-local, multicast et métadonnées du cloud refusées (aussi après résolution DNS) ; redirections non suivies ; le journal d'audit ne garde ni l'adresse complète ni le secret.
- API : `/api/webhooks` (+ `/:id`, `/:id/test`, `/:id/secret`, `/:id/deliveries`, `/:id/deliveries/:deliveryId/retry`).
- Limites : l'expéditeur tourne dans le processus du serveur (rien ne part s'il est arrêté, les envois en attente reprennent au redémarrage) ; pas de webhook pour les comptes, jetons ni réglages ; un jeton d'API ne gère pas les webhooks.

## Ce qui est fonctionnel (phase 24 : SSO et LDAP)

- **OpenID Connect** (Administration > Authentification) : bouton « Se connecter avec … » (Keycloak, Entra ID, Google, Okta, Authentik…), flux code d'autorisation avec PKCE, `state`, `nonce` et cookie de liaison ; signature du jeton vérifiée (RS256/ES256) sans dépendance.
- **LDAP / Active Directory** : identifiant et mot de passe de l'annuaire sur la page de connexion ; client LDAP v3 écrit pour l'occasion (`ldaps://` ou StartTLS, certificat toujours vérifié, valeurs de filtre échappées, mot de passe vide refusé).
- Comptes créés à la première connexion ; rôle d'après les groupes (administrateurs, éditeurs, rôle par défaut), groupes autorisés, domaines d'e-mail (OIDC), rôle recalculé à chaque connexion sans jamais rétrograder le dernier administrateur. Un compte externe n'a pas de mot de passe ici ; un compte local n'est jamais rattaché automatiquement à une identité externe.
- Les secrets (secret client, mot de passe du compte de service) ne sont jamais renvoyés ni sauvegardés ; la sauvegarde retire aussi les secrets des webhooks (qui sont désactivés dans la copie).
- API : `GET/PATCH /api/settings/sso`, `POST /api/settings/sso/test`, `GET /api/auth/options`, `GET /api/auth/oidc/start` et `/callback`.
- Limites : testé seulement contre un faux fournisseur et un faux serveur LDAP (aucun vrai annuaire dans l'environnement de développement) ; pas de SAML ni de déconnexion unique ; groupes LDAP imbriqués non résolus ; migration : colonnes `auth_source` et `external_id` ajoutées à `users` (relancez `npm run dev`).

## Ce qui est fonctionnel (phase 25 : scan réseau)

- **Scan réseau** (Outils > Scan réseau, éditeur pour lancer) : ping (ICMP) et connexions TCP sur 22, 53, 80, 135, 443, 445, 3389, 8080 au choix (aucune donnée envoyée ; un hôte qui refuse la connexion compte comme présent), DNS inverse des hôtes qui répondent, avancement en direct, annulation (résultat partiel conservé).
- Comparaison avec l'IPAM : **Nouveau** (répond, absent de l'inventaire), **Connu**, **Silencieux** (« utilisée » mais ne répond pas). Import des hôtes nouveaux en un clic (statut « utilisée », nom DNS repris, description « Scan AAAA-MM-JJ »), tout ou rien, journalisé adresse par adresse.
- Garde-fous : IPv4 privé uniquement (10/8, 172.16/12, 192.168/16, 100.64/10 ; `IP_ARCHITECT_SCAN_PUBLIC=1` lève la limite), /22 au plus, un seul scan à la fois, 32 hôtes en parallèle, noms DNS filtrés, les 5 derniers scans de chaque réseau gardés.
- API : `GET/POST/DELETE /api/networks/:id/scan`, `POST /api/networks/:id/scan/import`.
- Limites : testé avec un réseau simulé (pas sur un vrai réseau dans l'environnement de développement) ; IPv4 seulement ; pas de détection de services ; le scan s'exécute dans le processus du serveur (un redémarrage l'interrompt sans enregistrer de résultat) ; le serveur doit pouvoir joindre le réseau et disposer de la commande `ping`. Scans programmés, alertes et adresses MAC : voir la phase 26.

## Ce qui est fonctionnel (phase 26 : scans programmés, alertes, adresses MAC)

- **Scan programmé** (Scan réseau > « Scan programmé », éditeur) : un par réseau (20 par projet), toutes les heures, 6 h, 12 h, tous les jours ou toutes les semaines. Le serveur lance seul le plus en retard, un scan à la fois ; journalisé sans utilisateur.
- **Alerte hôte inconnu** : un hôte qui répond sans figurer dans l'IPAM (et non ignoré) apparaît dans la cloche et la supervision, et dans les e-mails d'alerte si leur gravité minimale est « avertissement ». « Ignorer » met un hôte légitime hors alerte (état « Ignoré », réversible).
- **Adresses MAC** : lues dans la table des voisins du serveur (`ip neigh`, `arp -an`, `arp -a` sous Windows) après chaque scan, pour les hôtes du même réseau local ; ajoutées à la description à l'import ; un **changement de MAC** entre deux scans est signalé sur la ligne.
- API : `GET/PATCH/DELETE /api/networks/:id/scan/schedule`, `POST /api/networks/:id/scan/ignore`.
- Limites : pas de fabricant déduit de la MAC ; la MAC n'existe que pour les hôtes du réseau local du serveur (pas derrière un routeur, ni depuis un conteneur Docker en réseau « bridge ») ; pas d'alerte propre sur changement de MAC (affiché, pas notifié) ; pas de webhook dédié ; les scans programmés ne partent que serveur allumé ; testé avec un réseau simulé. Mise à jour de la base : **arrêtez puis relancez `npm run dev`** (nouvelles tables `scan_schedules` et `scan_ignored`).

## Ce qui est fonctionnel (phase 27 : topologie réseau)

- **Topologie** (Outils > Topologie) : schéma des équipements (routeurs, pare-feu, switchs, bornes Wi-Fi, serveurs, postes, téléphones) et de leurs branchements avec le nom des ports. Placement automatique (routeurs en haut, puis switchs, bornes, machines), zoom, déplacement, glisser un équipement pour le placer (position gardée), panneau de détail (ports, liens, machines vues avec MAC/IP/VLAN).
- **Découvrir un réseau de l'IPAM** (éditeur) : on choisit un réseau comme pour le scan ; les hôtes qui répondent (même méthode que le scan, avec DNS inverse et MAC) sont placés sans configuration, reliés à un nuage « réseau » et à la passerelle (plage DHCP) ; type deviné prudemment (passerelle, DNS, poste Windows). Avec des identifiants SNMP, chaque hôte qui répond est essayé en SNMP et le câblage réel est lu ; une machine vue dans la table MAC d'un switch est reliée à son port.
- **Découverte SNMP v2c** à partir d'une adresse (avancé) : lecture, lecture du nom, des ports (débit, état), des voisins **LLDP et CDP** et de la table d'adresses MAC (FDB), puis parcours en largeur des voisins qui annoncent une adresse de gestion (profondeur 0 à 5). Client SNMP écrit à la main (sans dépendance, lecture seule : GET et GETBULK/GETNEXT). Les IP des machines viennent de la table ARP des routeurs.
- Saisie à la main d'équipements et de liens ; ce qui est manuel n'est jamais écrasé par une découverte. Identifiants SNMP : administrateur (communauté jamais renvoyée par l'API, retirée des sauvegardes).
- Garde-fous : IPv4 privées seulement (`IP_ARCHITECT_SCAN_PUBLIC=1` lève la limite), 200 équipements, 1 000 liens, 5 minutes, une découverte à la fois.
- API : `GET /api/topology`, `/api/topology/devices`, `/links`, `/positions`, `/credentials`, `/discover` (voir la documentation).
- Limites : **la communauté SNMP v2c circule en clair** ; pas de SNMPv3 ; LLDP et CDP seulement ; SNMP/LLDP doivent être activés sur les équipements ; testé avec de faux équipements (y compris un faux agent UDP de bout en bout), **pas avec du matériel réel** ni dans un vrai navigateur. Mise à jour de la base : **arrêtez puis relancez `npm run dev`** (nouvelles tables `snmp_credentials`, `topo_devices`, `topo_links`, `topo_clients`).

## Langues et thèmes

- **Langues : français et anglais**, via le sélecteur de l'en-tête. Le choix est mémorisé (cookie `locale`) ; à la première visite, la langue du navigateur est utilisée. Tout est traduit : interface, nombres, dates, « il y a 5 min », alertes et messages d'erreur de l'API (le serveur répond dans la langue de l'utilisateur).
- **Thèmes : clair et sombre**, via le bouton lune/soleil. Le choix est mémorisé ; sans choix, le thème du système est suivi, sans « flash » au chargement. Les couleurs sont des variables CSS (`src/app/globals.css`), les graphiques utilisent `CHART_PALETTE` (`src/components/ThemeProvider.tsx`).
- **Ajouter une langue** : copier `src/lib/i18n/en.ts` en `xx.ts`, traduire, puis l'enregistrer dans `src/lib/i18n/index.ts` (`LOCALES`, `dictionaries`, `INTL_TAG`) et ajouter son nom dans `language` de chaque dictionnaire. `npm test` vérifie que les clés et les variables `{…}` sont identiques dans toutes les langues, et TypeScript signale toute clé inexistante.
- Les données saisies (noms de sites, de réseaux, de VLAN) ne sont pas traduites : ce sont vos données.

Si vous aviez déjà lancé l'application avant cette version, la base se met à jour toute seule au démarrage : seules des données de démonstration sont ajoutées (alertes, adresses IPAM, plages DHCP et VRF des réseaux de démo), vos propres réseaux et VLAN ne sont jamais modifiés. **Après avoir copié les nouveaux fichiers, arrêtez le serveur (`Ctrl+C`) et relancez `npm run dev`** : la mise à jour de la base se fait à l'ouverture de la base, et le rechargement à chaud ne la déclenche pas.

## API

| Méthode  | Route               | Description                                   |
| -------- | ------------------- | --------------------------------------------- |
| `GET`    | `/api/networks`     | Liste (`?q=`, `?status=`, `?version=4\|6`)     |
| `POST`   | `/api/networks`     | Création (409 en cas de chevauchement)         |
| `DELETE` | `/api/networks/:id` | Suppression (ses adresses sont supprimées aussi) |
| `GET`    | `/api/sites`        | Liste détaillée (`?q=`)                        |
| `POST`   | `/api/sites`        | Création `{ name, address?, description? }` (409 si le nom existe dans le projet) |
| `GET`    | `/api/sites/:id`    | Détail                                         |
| `PATCH`  | `/api/sites/:id`    | Modification partielle (`null` efface adresse ou description) |
| `DELETE` | `/api/sites/:id`    | Suppression (409 si des réseaux ou VLANs l'utilisent) |
| `GET`    | `/api/projects`     | Liste avec compteurs et projet actif           |
| `POST`   | `/api/projects`     | Création `{ name, description? }` (projet vide, non activé) |
| `PATCH`  | `/api/projects/:id` | Modification `{ name?, description? }`         |
| `POST`   | `/api/projects/:id/activate` | Change le projet actif                |
| `DELETE` | `/api/projects/:id` | Supprime le projet et tout son contenu (409 si actif) |
| `GET`    | `/api/export/:type` | Télécharge un CSV (`?delimiter=semicolon\|comma\|tab`, `?template=1` pour le gabarit) ; types : `sites`, `vrfs`, `vlans`, `networks`, `addresses`, `dhcp_scopes`, `dhcp_reservations` |
| `POST`   | `/api/import/:type` | Importe `{ csv, dryRun?, onExisting? }` (simulation par défaut, tout ou rien) ; réponse `{ result }` avec les erreurs par ligne |
| `GET`    | `/api/monitoring`   | Résultat de la supervision (contrôles, capacité, prévision) |
| `PATCH`  | `/api/monitoring/settings` | Seuils `{ warnPct?, critPct? }` (entiers, 1 ≤ warn < crit ≤ 100) |
| `POST`   | `/api/monitoring/probe` | Ping des adresses inventoriées d'un réseau `{ networkId }` |
| `GET`    | `/api/reports/:kind` | Rapport JSON (`summary`, `sites`, `networks`, `dhcp`, `vlans`, `vrf`) ; `?format=csv` pour un CSV |
| `GET`    | `/api/plans`        | Liste des plans du projet                      |
| `POST`   | `/api/plans`        | Création `{ name, parentCidr, vrfId?, description?, items? }` (`items` : `{ name, hosts? \| prefix?, siteId?, vlan? }`) |
| `GET`    | `/api/plans/:id`    | Détail (besoins, réseaux existants dans le bloc) |
| `PATCH`  | `/api/plans/:id`    | Modification partielle (409 si le plan est appliqué et que le bloc, la VRF ou les besoins changent) |
| `DELETE` | `/api/plans/:id`    | Supprime le plan (les réseaux créés sont conservés) |
| `POST`   | `/api/plans/:id/apply` | Crée les réseaux du plan, tout ou rien `{ status? }` (défaut `inactive`) |
| `POST`   | `/api/simulator/:mode` | Simulation en lecture seule : `split`, `merge`, `free`, `fit` |
| `POST`   | `/api/auth/login`   | Connexion `{ username, password }` ; cookie de session (429 après 5 échecs) |
| `POST`   | `/api/auth/logout`  | Ferme la session                               |
| `GET`    | `/api/auth/me`      | `{ authEnabled, user }`                        |
| `POST`   | `/api/auth/password` | Change son mot de passe `{ currentPassword, newPassword }` |
| `GET`    | `/api/users`        | Liste des comptes (administrateur)             |
| `POST`   | `/api/users`        | Création `{ username, displayName, password, role? }` (le premier compte est libre et devient administrateur) |
| `PATCH`  | `/api/users/:id`    | `{ displayName?, role?, active?, password? }` (administrateur) |
| `DELETE` | `/api/users/:id`    | Suppression (administrateur ; jamais soi-même ni le dernier administrateur) |
| `GET`    | `/api/audit`        | Journal (administrateur) : `?q=`, `user`, `action`, `entity`, `from`, `to` (AAAA-MM-JJ UTC), `page` ; `?format=csv` pour l'export |
| `GET`    | `/api/settings`     | Paramètres de l'application                    |
| `PATCH`  | `/api/settings`     | `{ orgName?, auditRetentionDays?, warnPct?, critPct? }` (administrateur, tout ou rien) |
| `GET`    | `/api/settings/backup` | Télécharge une copie de la base SQLite (administrateur) |
| `GET`    | `/api/vlans`        | Liste (`?q=`, `?site=<id>`)                    |
| `POST`   | `/api/vlans`        | Création `{ number, name, siteId? }` (409 si le numéro existe sur ce site) |
| `DELETE` | `/api/vlans/:id`    | Suppression (409 si des réseaux l'utilisent)   |
| `GET`    | `/api/networks/:id/addresses` | Adresses inventoriées, triées par valeur |
| `POST`   | `/api/networks/:id/addresses` | Allocation `{ address?, status?, hostname?, description? }` ; sans `address` : première adresse libre |
| `DELETE` | `/api/networks/:id/addresses/:addressId` | Libération |
| `GET`    | `/api/dhcp/scopes` | Plages DHCP (`?q=`) |
| `POST`   | `/api/dhcp/scopes` | Création `{ networkId, name, rangeStart, rangeEnd, gateway?, dns?, leaseSeconds?, enabled? }` (409 si chevauchement ou nom pris) |
| `GET`    | `/api/dhcp/scopes/:id` | Détail d'une plage |
| `DELETE` | `/api/dhcp/scopes/:id` | Suppression (libère les adresses réservées dans l'IPAM) |
| `GET`    | `/api/dhcp/scopes/:id/reservations` | Réservations triées par adresse |
| `POST`   | `/api/dhcp/scopes/:id/reservations` | Création `{ mac, address, hostname?, description? }` (409 si MAC ou IP déjà prise) |
| `DELETE` | `/api/dhcp/scopes/:id/reservations/:reservationId` | Suppression |
| `GET`    | `/api/dhcp/scopes/:id/config` | Configuration en texte brut (`?format=isc` ou `cisco`) |
| `PATCH`  | `/api/networks/:id` | Modification partielle `{ name?, siteId?, vlan?, vrfId?, status?, usedIps?, reservedIps? }` (`null` efface un champ facultatif ; 409 si un changement de VRF crée un chevauchement) |
| `GET`    | `/api/vrfs` | Liste des VRF (`?q=`) |
| `POST`   | `/api/vrfs` | Création `{ name, rd?, rtImport?, rtExport?, description? }` (409 si nom ou RD déjà pris) |
| `GET`    | `/api/vrfs/:id` | Détail d'une VRF |
| `DELETE` | `/api/vrfs/:id` | Suppression (409 si elle contient des réseaux) |
| `GET`    | `/api/vrfs/:id/config` | Configuration Cisco IOS-XE en texte brut |
| `PATCH`  | `/api/vlans/:id` | Modification partielle `{ name?, number?, siteId? }` (409 `vlanLocked` si des réseaux utilisent le VLAN et que numéro ou site changent) |
| `PATCH`  | `/api/dhcp/scopes/:id` | Modification partielle d'une plage |
| `PATCH`  | `/api/dhcp/scopes/:id/reservations/:reservationId` | Modification `{ mac?, hostname?, description? }` |
| `PATCH`  | `/api/vrfs/:id` | Modification partielle `{ name?, rd?, rtImport?, rtExport?, description? }` |
| `PATCH`  | `/api/networks/:id/addresses/:addressId` | Modification `{ status?, hostname?, description? }` |
| `POST`   | `/api/assistant` | Question à l'assistant `{ messages: [{ role: "user"\|"assistant", content }] }` (lecteur et plus ; 20 par 5 min et par utilisateur) -> `{ answer, tools, model }` |
| `GET`    | `/api/assistant/settings` | Configuration de l'assistant, sans la clé (administrateur) |
| `PATCH`  | `/api/assistant/settings` | `{ enabled?, provider?, baseUrl?, model?, apiKey? }` (`apiKey: ""` efface la clé) |
| `POST`   | `/api/assistant/models` | Teste la connexion et liste les modèles `{ baseUrl?, apiKey? }` (administrateur) |
| `GET`    | `/api/notifications` | Notifications du compte `{ items, unread, total }` (contrôles de supervision critiques et avertissements, état lu/non lu) |
| `POST`   | `/api/notifications/read` | `{ ids: string[] }` ou `{ all: true }` : marque comme lu pour le compte courant (lecteur et plus) |
| `POST`   | `/api/auth/register/start` | Public (si l'inscription est ouverte) : `{ email, username, displayName, password }` -> envoie un code valable 2 minutes `{ expiresInMs }` |
| `POST`   | `/api/auth/register/verify` | Public : `{ email, code }` -> crée le compte « lecteur » et ouvre la session (410 si le code a expiré) |
| `GET`    | `/api/settings/signup` | Réglages d'inscription et SMTP, sans le mot de passe (administrateur) |
| `PATCH`  | `/api/settings/signup` | `{ enabled?, domains?, consoleMode?, smtpHost?, smtpPort?, smtpSecurity?, smtpUser?, smtpPassword?, smtpFrom? }` |
| `POST`   | `/api/settings/signup/test` | Message de test `{ to }` avec les réglages enregistrés (administrateur) |
| `GET`    | `/api/tokens` | Jetons du compte (`?all=1` : tous, administrateur) ; session de navigateur exigée |
| `POST`   | `/api/tokens` | Création `{ name, role?: "viewer"\|"editor", expiresInDays? }` ; le jeton en clair n'est renvoyé qu'une fois |
| `DELETE` | `/api/tokens/:id` | Révoque un jeton (le sien, ou n'importe lequel pour un administrateur) |
| `GET`    | `/api/openapi` | Contrat OpenAPI 3.0 (`?lang=fr\|en`) |
| `GET`    | `/api/tp` | Exercices du mode TP (tous pour un enseignant, les publiés pour un étudiant, avec ses tentatives) |
| `POST`   | `/api/tp` | Création `{ title, kind: "vlsm"\|"subnet", config, description?, maxAttempts?, dueAt?, published?, showSolution? }` (éditeur) |
| `GET`    | `/api/tp/:id` | Détail : énoncé, solution et résultats (enseignant) ; énoncé personnel et remises (étudiant) |
| `PATCH`  | `/api/tp/:id` | Modification partielle (409 si l'énoncé change alors que des remises existent) |
| `DELETE` | `/api/tp/:id` | Supprime l'exercice et ses remises |
| `POST`   | `/api/tp/:id/submit` | Remise `{ answers }` -> `{ attempt, score, result, attemptsLeft, best, revealed, solution }` (lecteur et plus) |
| `GET`    | `/api/tp/:id/results` | Résultats par étudiant ; `?format=csv` (éditeur) |
| `GET`    | `/api/health`       | État de l'API et de la base                   |

Ce tableau n'est qu'un extrait : la liste complète et à jour des routes est dans la page **Documentation > API** et dans le contrat `GET /api/openapi`.

Les messages d'erreur sont renvoyés dans la langue de l'utilisateur, avec un `code` stable (ex. `addressTaken`, `networkFull`, `vlanInUse`).

## Structure

```
src/
├── app/
│   ├── layout.tsx            Coque de l'application
│   ├── page.tsx              Dashboard
│   ├── reseaux/page.tsx      Gestion des réseaux
│   ├── assistant-ia/page.tsx Assistant IA (conversation + configuration)
│   ├── calculateur/page.tsx  Calculateur IP
│   ├── vlans/page.tsx        Gestion des VLANs
│   ├── ipam/page.tsx         Liste IPAM
│   ├── ipam/[id]/page.tsx    Détail d'un réseau : grille, allocation, adresses
│   ├── dhcp/page.tsx         Plages DHCP
│   ├── dhcp/[id]/page.tsx    Détail d'une plage : réservations, export de configuration
│   ├── vrf/page.tsx          Liste des VRF
│   ├── vrf/[id]/page.tsx     Détail d'une VRF : réseaux, configuration
│   ├── documentation/page.tsx Documentation (guide, administration, API)
│   ├── tp/page.tsx · tp/[id]/page.tsx · tp/nouveau/page.tsx  Mode TP
│   ├── [section]/page.tsx    Modules « en préparation »
│   └── api/                  Routes API
├── components/               layout/ · dashboard/ · networks/ · calculator/ · vlans/ · ipam/ · dhcp/ · vrf/ · ui/ · ThemeProvider.tsx
└── lib/
    ├── ip/cidr.ts            Moteur de calcul IPv4/IPv6 (+ tests)
    ├── ip/allocate.ts        Allocation d'adresses : première IP libre, adresse attribuable (+ tests)
    ├── db/csvio.ts, csv/csv.ts  Import/export CSV (+ tests)
    ├── db/monitoring.ts, monitor/ping.ts  Supervision et sonde ping (+ tests)
    ├── db/reports.ts, reportFormat.ts  Rapports et mise en forme (+ tests)
    ├── db/planning.ts, plan/  Plans d'adressage et calcul de blocs VLSM (+ tests)
    ├── db/simulator.ts       Simulateur (lecture seule)
    ├── auth/, db/users.ts    Connexion, rôles, sessions, mots de passe (+ tests)
    ├── db/signup.ts, db/signupsettings.ts, mail/, signupTypes.ts  Inscription par e-mail : code 2 min, client SMTP intégré (+ tests)
    ├── db/notifications.ts, notifTypes.ts  Notifications (contrôles de supervision, lu/non lu par compte) (+ tests)
    ├── ai/, db/aisettings.ts  Assistant IA : client compatible OpenAI, outils en lecture seule, boucle d'agent, limiteur (+ tests)
    ├── audit.ts, db/audit.ts, db/appsettings.ts  Journal d'audit, paramètres, sauvegarde (+ tests)
    ├── db/edit.ts            Modifications (réseaux, VLANs, plages, réservations, VRF, adresses) (+ tests)
    ├── dhcp/config.ts        MAC, durées de bail, génération ISC dhcpd / Cisco IOS (+ tests)
    ├── vrf/rd.ts             Route distinguisher / route target, configuration Cisco IOS-XE (+ tests)
    ├── i18n/                 Dictionnaires fr.ts / en.ts, contexte client, langue côté serveur (+ tests)
    ├── db/                   Schéma SQLite, données de démo, requêtes ; ipam.ts = VLANs + adresses · dhcp.ts = plages + réservations · vrf.ts = VRF (+ tests)
    ├── ldap/, auth/oidc.ts, auth/jwt.ts, db/sso.ts  Connexion unique : client LDAP v3 (BER écrit à la main), OpenID Connect (PKCE), JWT RS256/ES256 (+ tests)
    ├── scan/, db/scans.ts    Scan réseau : ping, ports TCP, DNS inverse, MAC, scans programmés et alertes (+ tests)
    ├── snmp/, topology/, db/topology.ts  Topologie : client SNMP v2c sans dépendance, découverte LLDP/CDP/MAC, placement automatique du schéma (+ tests)
    ├── tp/, db/tp.ts         Mode TP : moteur de correction (grade.ts), exercices et remises (+ tests)
    ├── docs/                 Documentation FR/EN (blocs de contenu, tableau de l'API, tests de cohérence avec le code)
    ├── nav.ts · types.ts · format.ts · api.ts
```

## Notes

- Le taux d'utilisation et les capacités sont calculés sur les réseaux **IPv4** ; un préfixe IPv6 (/64 = 2⁶⁴ adresses) n'a pas de capacité comparable.
- Variable optionnelle : `DATABASE_PATH` pour placer la base ailleurs.
- **Sécurité avant toute exposition publique** : `npm audit` signale des failles dans Next 14.2.x (corrigées seulement à partir de Next 15.5.24 ou 16.3.3). Les fonctions les plus touchées (optimiseur d'images, Server Actions, rewrites, middleware) ne sont pas utilisées ici, mais d'autres avis concernent toute application Next. À faire avant de publier : passer à Next 15.5.24 (`npm install next@15.5.24 react@19 react-dom@19`, puis `npm install -D @types/react@19 @types/react-dom@19`), relancer `npm run build` et `npm test`, et placer l'application derrière HTTPS.
- Ne jamais exposer le serveur sans HTTPS : les mots de passe, les jetons d'API et les communautés SNMP v2c circulent sinon en clair.
- **Durcissement (variables d'environnement)** :
  - `IP_ARCHITECT_SETUP_CODE` : code d'installation fixé par vous (sinon généré et affiché dans la console). En production, la création du premier compte l'exige et tout le reste reste fermé tant qu'aucun compte n'existe. `IP_ARCHITECT_REQUIRE_SETUP_CODE=1|0` force ou désactive ce comportement.
  - `IP_ARCHITECT_TRUST_PROXY=1` : à activer seulement derrière un reverse proxy qui ÉCRASE `X-Forwarded-For` et `X-Forwarded-Proto` (Caddy, Nginx, Traefik le font). Sans cela, l'adresse IP du client est ignorée (journal, limitation par adresse).
  - `IP_ARCHITECT_SECURE_COOKIES=1` : cookie de session toujours `Secure` (HTTPS).
  - `IP_ARCHITECT_HSTS=1` : ajoute `Strict-Transport-Security` (HTTPS uniquement : le navigateur refusera ensuite le HTTP pendant un an).
  - `IP_ARCHITECT_CSP=0` : retire la politique de sécurité de contenu si elle gênait un usage particulier.
  - En-têtes envoyés partout : `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, CSP (`'unsafe-inline'` reste autorisé pour les scripts, Next.js en a besoin sans middleware).
  - Taille des requêtes : 12 Mo au plus (64 Ko sur les routes publiques) ; les envois « chunked » sans longueur annoncée sont refusés.
  - Le changement de mot de passe est limité comme la connexion (5 essais / 15 minutes).
  - Pas encore fait : chiffrement au repos des secrets stockés (clé IA, mot de passe SMTP, secrets SSO, communautés SNMP).
