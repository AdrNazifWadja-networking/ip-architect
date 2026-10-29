/**
 * Planificateur des scans programmés : un minuteur dans le processus du serveur (démarré par src/instrumentation.ts).
 * Toutes les 60 secondes, runDueSchedules lance au plus un scan en retard (un seul scan à la fois sur le serveur).
 * Si le serveur est arrêté, rien ne part ; au redémarrage, les scans en retard repartent un par un.
 */
import { getDb } from "../db";
import { runDueSchedules } from "../db/scans";

const TICK_MS = 60_000;
const G = globalThis as unknown as { __ipaScanTimer?: ReturnType<typeof setInterval> };

export function startScanScheduler(): void {
  if (G.__ipaScanTimer) return;
  G.__ipaScanTimer = setInterval(() => {
    try {
      runDueSchedules(getDb());
    } catch (e) {
      console.error("scans programmés : passage en erreur", e instanceof Error ? e.message.slice(0, 200) : e);
    }
  }, TICK_MS);
  G.__ipaScanTimer.unref?.();
}
