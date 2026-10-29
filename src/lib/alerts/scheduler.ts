/**
 * Planificateur des alertes : un minuteur dans le processus du serveur (démarré par src/instrumentation.ts).
 * Toutes les 60 secondes il demande un passage ; runAlerts décide si c'est l'heure (délai choisi par l'administrateur).
 * Un seul minuteur par processus. Si le serveur est arrêté, aucune alerte ne part : voir `npm run alerts:send` pour un cron externe.
 */
import { getDb } from "../db";
import { runAlerts } from "../db/alerts";

const TICK_MS = 60_000;
const G = globalThis as unknown as { __ipaAlertTimer?: ReturnType<typeof setInterval> };

export function startAlertScheduler(): void {
  if (G.__ipaAlertTimer) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runAlerts(getDb());
    } catch (e) {
      console.error("alertes : passage en erreur", e instanceof Error ? e.message.slice(0, 200) : e);
    } finally {
      running = false;
    }
  };
  G.__ipaAlertTimer = setInterval(() => void tick(), TICK_MS);
  G.__ipaAlertTimer.unref?.();
}
