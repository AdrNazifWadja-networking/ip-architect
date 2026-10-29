import { randomBytes, randomUUID } from "node:crypto";
import { getDb, type Db } from "./index";
import { getActiveProject } from "./queries";
import { sanitizeChanges, type ChangeSet } from "../changeTypes";
import { checkWebhookUrl } from "../webhooks/url";
import { ApiError } from "../types";
import {
  DELIVERIES_PER_HOOK_MAX,
  DELIVERY_RETENTION_DAYS,
  TEST_EVENT,
  WEBHOOKS_PER_PROJECT_MAX,
  WEBHOOK_ENTITIES,
  WEBHOOK_NAME_MAX,
  eventMatches,
  isEventPattern,
  type CreateWebhookInput,
  type DeliveryInfo,
  type DeliveryStatus,
  type UpdateWebhookInput,
  type WebhookInfo,
} from "../webhookTypes";

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

interface RawHook {
  id: number;
  project_id: number;
  name: string;
  url: string;
  secret: string;
  events: string;
  active: number;
  created_at: string;
}

/** Webhook avec son secret : réservé au dispatcher, jamais renvoyé par l'API (sauf à la création / régénération). */
export interface WebhookSecretRow {
  id: number;
  projectId: number;
  name: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
}

function parseEvents(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter(isEventPattern) : [];
  } catch {
    return [];
  }
}

const newSecret = () => `whsec_${randomBytes(24).toString("hex")}`;

function cleanName(raw: unknown): string {
  const name = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!name) throw new ApiError("webhookNameRequired", 422);
  if (name.length > WEBHOOK_NAME_MAX) throw new ApiError("webhookNameTooLong", 422, { max: WEBHOOK_NAME_MAX });
  return name;
}

function cleanUrl(raw: unknown): string {
  const problem = checkWebhookUrl(raw);
  if (problem === "invalid") throw new ApiError("webhookUrlInvalid", 422);
  if (problem === "blocked") throw new ApiError("webhookUrlBlocked", 422);
  return (raw as string).trim();
}

function cleanEvents(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(isEventPattern)) throw new ApiError("webhookEventsInvalid", 422);
  const list = [...new Set(raw as string[])];
  return list.includes("*") ? ["*"] : list;
}

const SELECT_INFO = `
  SELECT h.*,
    (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id = h.id AND d.status = 'pending') AS pending,
    (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id = h.id AND d.status = 'failed') AS failed,
    (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id = h.id AND d.status = 'success') AS success,
    (SELECT status FROM webhook_deliveries d WHERE d.webhook_id = h.id ORDER BY d.id DESC LIMIT 1) AS last_status,
    (SELECT COALESCE(delivered_at, created_at) FROM webhook_deliveries d WHERE d.webhook_id = h.id ORDER BY d.id DESC LIMIT 1) AS last_at
  FROM webhooks h`;

function mapInfo(r: RawHook & { pending: number; failed: number; success: number; last_status: DeliveryStatus | null; last_at: string | null }): WebhookInfo {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    events: parseEvents(r.events),
    active: r.active === 1,
    createdAt: r.created_at,
    pending: r.pending,
    failed: r.failed,
    success: r.success,
    lastStatus: r.last_status,
    lastAt: r.last_at,
  };
}

export function listWebhooks(db: Db = getDb()): WebhookInfo[] {
  const project = getActiveProject(db);
  return (db.prepare(`${SELECT_INFO} WHERE h.project_id = ? ORDER BY h.id`).all(project.id) as never[]).map(mapInfo);
}

export function getWebhook(id: number, db: Db = getDb()): WebhookInfo {
  const project = getActiveProject(db);
  const r = db.prepare(`${SELECT_INFO} WHERE h.id = ? AND h.project_id = ?`).get(id, project.id) as never;
  if (!r) throw new ApiError("webhookNotFound", 404);
  return mapInfo(r);
}

export function getWebhookWithSecret(id: number, db: Db): WebhookSecretRow | null {
  const r = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as RawHook | undefined;
  return r ? { id: r.id, projectId: r.project_id, name: r.name, url: r.url, secret: r.secret, events: parseEvents(r.events), active: r.active === 1 } : null;
}

export function createWebhook(input: CreateWebhookInput, db: Db = getDb()): { webhook: WebhookInfo; secret: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApiError("invalidBody", 400);
  const project = getActiveProject(db);
  const name = cleanName(input.name);
  const url = cleanUrl(input.url);
  const events = has(input, "events") ? cleanEvents(input.events) : ["*"];
  const active = input.active === false ? 0 : 1;
  const n = (db.prepare("SELECT COUNT(*) AS c FROM webhooks WHERE project_id = ?").get(project.id) as { c: number }).c;
  if (n >= WEBHOOKS_PER_PROJECT_MAX) throw new ApiError("webhookLimit", 409, { max: WEBHOOKS_PER_PROJECT_MAX });
  const secret = newSecret();
  const res = db
    .prepare("INSERT INTO webhooks (project_id, name, url, secret, events, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(project.id, name, url, secret, JSON.stringify(events), active, new Date().toISOString());
  return { webhook: getWebhook(Number(res.lastInsertRowid), db), secret };
}

export function updateWebhook(id: number, input: UpdateWebhookInput, db: Db = getDb()): WebhookInfo {
  if (!input || typeof input !== "object" || Array.isArray(input) || !["name", "url", "events", "active"].some((k) => has(input, k))) {
    throw new ApiError("invalidBody", 400);
  }
  const cur = getWebhook(id, db);
  const name = has(input, "name") ? cleanName(input.name) : cur.name;
  const url = has(input, "url") ? cleanUrl(input.url) : cur.url;
  const events = has(input, "events") ? cleanEvents(input.events) : cur.events;
  const active = has(input, "active") ? (input.active ? 1 : 0) : cur.active ? 1 : 0;
  db.prepare("UPDATE webhooks SET name = ?, url = ?, events = ?, active = ? WHERE id = ?").run(name, url, JSON.stringify(events), active, id);
  return getWebhook(id, db);
}

export function deleteWebhook(id: number, db: Db = getDb()): void {
  getWebhook(id, db);
  db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
}

/** Nouveau secret (l'ancien cesse de fonctionner). Renvoyé une seule fois. */
export function regenerateSecret(id: number, db: Db = getDb()): string {
  getWebhook(id, db);
  const secret = newSecret();
  db.prepare("UPDATE webhooks SET secret = ? WHERE id = ?").run(secret, id);
  return secret;
}

/* ------------------------------- Envois ------------------------------- */

interface RawDelivery {
  id: number;
  event: string;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: string | null;
  response_code: number | null;
  error: string | null;
  created_at: string;
  delivered_at: string | null;
}

const mapDelivery = (r: RawDelivery): DeliveryInfo => ({
  id: r.id,
  event: r.event,
  status: r.status,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  responseCode: r.response_code,
  error: r.error,
  createdAt: r.created_at,
  deliveredAt: r.delivered_at,
});

export function listDeliveries(webhookId: number, limit = 50, db: Db = getDb()): DeliveryInfo[] {
  getWebhook(webhookId, db);
  const n = Math.max(1, Math.min(200, Math.floor(limit) || 50));
  return (db.prepare("SELECT id, event, status, attempts, next_attempt_at, response_code, error, created_at, delivered_at FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT ?").all(webhookId, n) as RawDelivery[]).map(mapDelivery);
}

export function retryDelivery(webhookId: number, deliveryId: number, db: Db = getDb(), now: Date = new Date()): DeliveryInfo {
  getWebhook(webhookId, db);
  const r = db.prepare("SELECT id FROM webhook_deliveries WHERE id = ? AND webhook_id = ?").get(deliveryId, webhookId);
  if (!r) throw new ApiError("deliveryNotFound", 404);
  db.prepare("UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, error = NULL, response_code = NULL, delivered_at = NULL WHERE id = ?").run(now.toISOString(), deliveryId);
  return mapDelivery(db.prepare("SELECT * FROM webhook_deliveries WHERE id = ?").get(deliveryId) as RawDelivery);
}

export interface WebhookEvent {
  event: string;
  projectId: number | null;
  username?: string | null;
  entity: string;
  entityId?: number | null;
  detail?: string | null;
  changes?: ChangeSet | null;
}

function payloadFor(db: Db, uid: string, ev: WebhookEvent, now: Date): string {
  const project = ev.projectId != null ? (db.prepare("SELECT id, name FROM projects WHERE id = ?").get(ev.projectId) as { id: number; name: string } | undefined) : undefined;
  return JSON.stringify({
    id: uid,
    event: ev.event,
    createdAt: now.toISOString(),
    project: project ?? null,
    actor: ev.username ? { username: ev.username } : null,
    object: { type: ev.entity, id: ev.entityId ?? null, label: ev.detail ?? null },
    changes: sanitizeChanges(ev.changes) ?? null,
  });
}

/**
 * Met en file un envoi par webhook actif du projet qui s'abonne à l'événement. Ne lève jamais (appelé depuis le journal
 * d'audit : un webhook ne doit pas faire échouer l'action). Retourne le nombre d'envois créés.
 */
export function queueWebhooks(db: Db, ev: WebhookEvent, now: Date = new Date()): number {
  try {
    if (ev.projectId == null || ev.event === TEST_EVENT || !(WEBHOOK_ENTITIES as readonly string[]).includes(ev.entity) && ev.event !== "csv.import") return 0;
    const hooks = db.prepare("SELECT id, events FROM webhooks WHERE project_id = ? AND active = 1").all(ev.projectId) as { id: number; events: string }[];
    let n = 0;
    for (const h of hooks) {
      if (!eventMatches(parseEvents(h.events), ev.event)) continue;
      const uid = randomUUID();
      db.prepare("INSERT INTO webhook_deliveries (webhook_id, uid, event, payload, status, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)").run(
        h.id, uid, ev.event, payloadFor(db, uid, ev, now), now.toISOString(), now.toISOString(),
      );
      n++;
    }
    return n;
  } catch (e) {
    console.error("webhooks : mise en file impossible", e instanceof Error ? e.message : e);
    return 0;
  }
}

/** Envoi de test : un événement `webhook.test` (hors abonnements), mis en file pour ce seul webhook. Retourne l'identifiant de l'envoi. */
export function queueTest(webhookId: number, db: Db = getDb(), now: Date = new Date()): number {
  const hook = getWebhook(webhookId, db);
  const project = getActiveProject(db);
  const uid = randomUUID();
  const payload = JSON.stringify({
    id: uid,
    event: TEST_EVENT,
    createdAt: now.toISOString(),
    project,
    actor: null,
    object: { type: "webhook", id: hook.id, label: hook.name },
    changes: null,
  });
  const res = db.prepare("INSERT INTO webhook_deliveries (webhook_id, uid, event, payload, status, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)").run(
    webhookId, uid, TEST_EVENT, payload, now.toISOString(), now.toISOString(),
  );
  return Number(res.lastInsertRowid);
}

export function getDelivery(id: number, db: Db): DeliveryInfo | null {
  const r = db.prepare("SELECT id, event, status, attempts, next_attempt_at, response_code, error, created_at, delivered_at FROM webhook_deliveries WHERE id = ?").get(id) as RawDelivery | undefined;
  return r ? mapDelivery(r) : null;
}

/** Purge : envois de plus de 14 jours, puis au-delà de 1000 par webhook. */
export function pruneDeliveries(db: Db, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - DELIVERY_RETENTION_DAYS * 86_400_000).toISOString();
  let n = Number(db.prepare("DELETE FROM webhook_deliveries WHERE created_at < ?").run(cutoff).changes);
  for (const h of db.prepare("SELECT id FROM webhooks").all() as { id: number }[]) {
    n += Number(
      db.prepare("DELETE FROM webhook_deliveries WHERE webhook_id = ? AND id <= (SELECT id FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)").run(h.id, h.id, DELIVERIES_PER_HOOK_MAX).changes,
    );
  }
  return n;
}
