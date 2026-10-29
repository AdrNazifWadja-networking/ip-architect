/**
 * Expéditeur des webhooks : lit la file `webhook_deliveries` et envoie chaque événement en POST JSON signé.
 *
 * Signature : en-tête X-IPA-Signature = « sha256= » + HMAC-SHA256(secret, `${X-IPA-Timestamp}.${corps}`) en hexadécimal.
 * Réussite = réponse 2xx. Sinon (erreur réseau, délai de 10 s dépassé, autre code, redirection) : nouvelle tentative
 * après 1 min, 5 min, 30 min, 2 h, puis abandon (5 essais). Les redirections ne sont jamais suivies.
 * Le contenu de la réponse n'est ni lu ni conservé : seul le code HTTP l'est.
 */
import { createHmac } from "node:crypto";
import dns from "node:dns/promises";
import { getDb, type Db } from "../db";
import { getWebhookWithSecret, pruneDeliveries } from "../db/webhooks";
import { DELIVERY_MAX_ATTEMPTS, RETRY_DELAYS_S } from "../webhookTypes";
import { parseIp } from "../ip/cidr";
import { isBlockedAddress } from "./url";

const TIMEOUT_MS = 10_000;
const BATCH = 20;
const TICK_MS = 5_000;

export interface DeliverDeps {
  fetchImpl?: typeof fetch;
  /** Adresses IP d'un nom d'hôte (injectable pour les tests). */
  resolve?: (host: string) => Promise<string[]>;
  now?: () => Date;
}

export function sign(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

async function defaultResolve(host: string): Promise<string[]> {
  const list = await dns.lookup(host, { all: true });
  return list.map((x) => x.address);
}

interface Due {
  id: number;
  webhook_id: number;
  uid: string;
  event: string;
  payload: string;
  attempts: number;
}

/** Envoie une livraison ; met à jour son état. Ne lève jamais. */
async function deliverOne(db: Db, d: Due, deps: DeliverDeps): Promise<"success" | "retry" | "failed"> {
  const now = (deps.now ?? (() => new Date()))();
  const fail = (error: string, code: number | null): "retry" | "failed" => {
    const attempts = d.attempts + 1;
    if (attempts >= DELIVERY_MAX_ATTEMPTS) {
      db.prepare("UPDATE webhook_deliveries SET status = 'failed', attempts = ?, next_attempt_at = NULL, response_code = ?, error = ? WHERE id = ?").run(attempts, code, error, d.id);
      return "failed";
    }
    const next = new Date(now.getTime() + RETRY_DELAYS_S[attempts - 1] * 1000).toISOString();
    db.prepare("UPDATE webhook_deliveries SET attempts = ?, next_attempt_at = ?, response_code = ?, error = ? WHERE id = ?").run(attempts, next, code, error, d.id);
    return "retry";
  };

  const hook = getWebhookWithSecret(d.webhook_id, db);
  if (!hook || !hook.active) {
    db.prepare("UPDATE webhook_deliveries SET status = 'failed', next_attempt_at = NULL, error = 'inactive' WHERE id = ?").run(d.id);
    return "failed";
  }

  let url: URL;
  try {
    url = new URL(hook.url);
  } catch {
    return fail("invalid-url", null);
  }
  // le nom d'hôte ne doit pas désigner une adresse interdite (métadonnées du cloud…), même via le DNS
  try {
    const literal = url.hostname.replace(/^\[|\]$/g, "");
    const addrs = parseIp(literal) ? [literal] : await (deps.resolve ?? defaultResolve)(url.hostname);
    if (addrs.length === 0 || addrs.some(isBlockedAddress)) return fail("blocked-address", null);
  } catch {
    return fail("dns", null);
  }

  const timestamp = String(Math.floor(now.getTime() / 1000));
  const body = d.payload;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await (deps.fetchImpl ?? fetch)(hook.url, {
      method: "POST",
      redirect: "manual",
      signal: ctl.signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "IP-Architect-Webhook/1",
        "X-IPA-Event": d.event,
        "X-IPA-Delivery": d.uid,
        "X-IPA-Timestamp": timestamp,
        "X-IPA-Signature": sign(hook.secret, timestamp, body),
      },
      body,
    });
    if (res.status >= 200 && res.status < 300) {
      db.prepare("UPDATE webhook_deliveries SET status = 'success', attempts = ?, next_attempt_at = NULL, response_code = ?, error = NULL, delivered_at = ? WHERE id = ?").run(d.attempts + 1, res.status, now.toISOString(), d.id);
      return "success";
    }
    return fail(res.status >= 300 && res.status < 400 ? "redirect" : "http", res.status);
  } catch (e) {
    return fail((e as Error).name === "AbortError" ? "timeout" : "network", null);
  } finally {
    clearTimeout(timer);
  }
}

/** Traite les envois dus (au plus 20 par passage). Retourne les compteurs. */
export async function deliverDue(db: Db = getDb(), deps: DeliverDeps = {}, only?: number): Promise<{ success: number; retry: number; failed: number }> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const due = (only !== undefined
    ? db.prepare("SELECT id, webhook_id, uid, event, payload, attempts FROM webhook_deliveries WHERE id = ? AND status = 'pending'").all(only)
    : db.prepare("SELECT id, webhook_id, uid, event, payload, attempts FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?").all(now, BATCH)) as Due[];
  const out = { success: 0, retry: 0, failed: 0 };
  for (const d of due) out[await deliverOne(db, d, deps)]++;
  return out;
}

const G = globalThis as unknown as { __ipaWebhookTimer?: ReturnType<typeof setInterval> };

/** Un minuteur par processus (démarré par instrumentation.ts) : un passage toutes les 5 secondes. */
export function startWebhookDispatcher(): void {
  if (G.__ipaWebhookTimer) return;
  let running = false;
  let ticks = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const db = getDb();
      await deliverDue(db);
      if (++ticks % 720 === 0) pruneDeliveries(db); // environ toutes les heures
    } catch (e) {
      console.error("webhooks : passage en erreur", e instanceof Error ? e.message.slice(0, 200) : e);
    } finally {
      running = false;
    }
  };
  G.__ipaWebhookTimer = setInterval(() => void tick(), TICK_MS);
  G.__ipaWebhookTimer.unref?.();
}
