# Contribuer

Merci de votre intérêt ! 

1. Forkez le dépôt et créez une branche (`feature/ma-fonction`).
2. `npm install`, puis `npm run dev` (http://localhost:3000).
3. Avant d'ouvrir une *pull request* : `npm test` et `npm run build` doivent passer.
4. Toute nouvelle route API commence par `guard("viewer|editor|admin")` (vérifié par les tests), journalise avec `audit()` et déclare ses messages d'erreur en français **et** en anglais (`src/lib/i18n`).
5. Toute nouvelle fonction se documente dans `src/lib/docs` (FR + EN) et dans la table de l'API.

Pour une faille de sécurité, voir `SECURITY.md` (pas de ticket public).
