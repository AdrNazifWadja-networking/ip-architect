# Contribuer

Merci de votre intérêt ! 

1. Forkez le dépôt et créez une branche (`feature/ma-fonction`).
2. `npm install`, puis `npm run dev` (http://localhost:3000).
3. Avant d'ouvrir une *pull request* : `npm test` et `npm run build` doivent passer.
4. Toute nouvelle route API commence par `guard("viewer|editor|admin")` (vérifié par les tests), journalise avec `audit()` et déclare ses messages d'erreur en français **et** en anglais (`src/lib/i18n`).
5. Toute nouvelle fonction se documente dans `src/lib/docs` (FR + EN) et dans la table de l'API.

Pour une faille de sécurité, voir `SECURITY.md` (pas de ticket public).

## Licence des contributions

Le projet est publié sous **GNU AGPL v3** (voir `LICENSE`). En soumettant une contribution (pull request), vous certifiez en être l'auteur ou avoir le droit de la proposer, et vous acceptez :

1. qu'elle soit distribuée sous la licence AGPL-3.0 du projet ;
2. que l'auteur du projet puisse aussi la distribuer sous d'autres licences, y compris commerciales (cela permet de proposer plus tard une version commerciale sans redemander l'accord de chaque contributeur).

Si cette seconde condition ne vous convient pas, dites-le dans votre pull request avant qu'elle soit fusionnée.
