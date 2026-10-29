/** Appelé une fois au démarrage du serveur Next.js : lance le planificateur des alertes par e-mail et l'expéditeur des webhooks (Node uniquement). */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startAlertScheduler } = await import("./lib/alerts/scheduler");
    startAlertScheduler();
    const { startWebhookDispatcher } = await import("./lib/webhooks/dispatcher");
    startWebhookDispatcher();
    const { startScanScheduler } = await import("./lib/scan/scheduler");
    startScanScheduler();
    // installation en production : la création du premier compte exige un code, affiché ici
    const { getDb } = await import("./lib/db");
    const { setupActive, getSetupCode } = await import("./lib/auth/setup");
    const db = getDb();
    if (setupActive(db)) {
      console.log(`\n[IP Architect] Installation : ouvrez l'application et créez le premier administrateur avec le code ${getSetupCode(db)}\n`);
    }
  }
}
