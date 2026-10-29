/**
 * Un passage des alertes par e-mail, en ligne de commande : `npm run alerts:send` (option --force : ignore le délai).
 * Utile pour un cron/planificateur Windows si le serveur web ne tourne pas en continu.
 */
import { getDb } from "../src/lib/db";
import { runAlerts } from "../src/lib/db/alerts";

runAlerts(getDb(), {}, { force: process.argv.includes("--force") })
  .then((r) => {
    console.log(r.skipped ? `ignoré (${r.skipped})` : `nouveaux : ${r.fresh}, e-mails envoyés : ${r.sent}${r.error ? `, erreur : ${r.error}` : ""}`);
    process.exit(r.error ? 1 : 0);
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
