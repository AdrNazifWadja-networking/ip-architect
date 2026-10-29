# Politique de sécurité

## Signaler une vulnérabilité

Merci de **ne pas** ouvrir de ticket public. Utilisez l'onglet « Security » > « Report a vulnerability » du dépôt GitHub
(signalement privé). Indiquez la version, les étapes pour reproduire et l'impact estimé. Nous répondons sous 7 jours.

## Bonnes pratiques de déploiement

- Servez toujours l'application en **HTTPS** (voir `docs/INSTALL.md`) : mots de passe et jetons API circulent sinon en clair.
- Activez `IP_ARCHITECT_TRUST_PROXY=1` **seulement** derrière un reverse proxy qui écrase `X-Forwarded-For`.
- Conservez le **code d'installation** secret jusqu'à la création du premier administrateur.
- Sauvegardez régulièrement la base (Paramètres > Sauvegarde) et protégez-la : elle contient des secrets (clé IA, mot de passe SMTP, communautés SNMP, secrets de webhooks).
- La découverte SNMP v2c envoie la communauté en clair sur le réseau : utilisez une communauté en lecture seule et un réseau d'administration.

## Limites connues

- Les secrets stockés (clé IA, SMTP, SSO, SNMP, webhooks) sont **en clair dans la base** : chiffrement au repos prévu.
- Un avis `postcss` (outil de compilation embarqué par Next.js) est signalé par `npm audit` ; il ne concerne que le traitement de notre propre CSS au build.
