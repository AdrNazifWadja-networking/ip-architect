import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { createNetwork } from "./queries";
import { recordAudit } from "./audit";
import {
  createWebhook, deleteWebhook, getDelivery, getWebhook, listDeliveries, listWebhooks, pruneDeliveries, queueTest, queueWebhooks, regenerateSecret,
  retryDelivery, updateWebhook,
} from "./webhooks";
import { deliverDue, sign } from "../webhooks/dispatcher";
import { checkWebhookUrl, isBlockedAddress } from "../webhooks/url";
import { eventMatches, isEventPattern } from "../webhookTypes";
import { ApiError } from "../types";

function freshDb(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  seedDatabase(db);
  return db;
}
const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
};
const T0 = new Date("2026-10-26T09:00:00Z");
const pid = (db: Db) => (db.prepare("SELECT id FROM projects ORDER BY id LIMIT 1").get() as { id: number }).id;

test("adresses : http/https seulement, sans identifiants ; lien-local, multicast et métadonnées refusés ; privé et localhost permis", () => {
  assert.equal(checkWebhookUrl("https://hooks.example.com/a?b=1"), null);
  assert.equal(checkWebhookUrl("http://192.168.1.10:5678/hook"), null);
  assert.equal(checkWebhookUrl("http://localhost:3001/x"), null);
  assert.equal(checkWebhookUrl("http://10.0.0.5/x"), null);
  for (const bad of ["", "ftp://x.test/", "javascript:alert(1)", "http://u:p@x.test/", "pas une url", "https://" + "a".repeat(600) + ".com"]) assert.equal(checkWebhookUrl(bad), "invalid", bad);
  for (const blocked of ["http://169.254.169.254/latest/meta-data", "http://[fe80::1]/x", "http://0.0.0.0/", "http://224.0.0.1/", "http://[::ffff:169.254.169.254]/", "http://[fd00:ec2::254]/"]) {
    assert.equal(checkWebhookUrl(blocked), "blocked", blocked);
  }
  assert.ok(isBlockedAddress("::ffff:a9fe:a9fe") && isBlockedAddress("169.254.1.1") && !isBlockedAddress("169.253.1.1") && !isBlockedAddress("8.8.8.8"));
});

test("abonnements : motifs valides, correspondance exacte, par objet et générale", () => {
  assert.ok(isEventPattern("*") && isEventPattern("network.*") && isEventPattern("network.create") && isEventPattern("plan.apply") && isEventPattern("csv.import"));
  assert.ok(!isEventPattern("user.create") && !isEventPattern("network") && !isEventPattern("webhook.test") && !isEventPattern("nope.*") && !isEventPattern(3));
  assert.ok(eventMatches(["*"], "vlan.delete"));
  assert.ok(eventMatches(["network.*"], "network.update") && !eventMatches(["network.*"], "networkX.update") && !eventMatches(["network.*"], "address.update"));
  assert.ok(eventMatches(["vlan.delete"], "vlan.delete") && !eventMatches(["vlan.delete"], "vlan.create"));
});

test("CRUD : validation, secret montré une fois, limite par projet, régénération, suppression", () => {
  const db = freshDb();
  const r = createWebhook({ name: "Chat", url: "https://hooks.example.com/x", events: ["network.*", "vlan.delete", "network.*"] }, db);
  assert.match(r.secret, /^whsec_[0-9a-f]{48}$/);
  assert.deepEqual(r.webhook.events, ["network.*", "vlan.delete"]);
  assert.ok(!JSON.stringify(listWebhooks(db)).includes(r.secret), "le secret ne figure pas dans la liste");
  assert.equal(code(() => createWebhook({ name: "", url: "https://a.test/" }, db)), "webhookNameRequired");
  assert.equal(code(() => createWebhook({ name: "x".repeat(61), url: "https://a.test/" }, db)), "webhookNameTooLong");
  assert.equal(code(() => createWebhook({ name: "x", url: "ftp://a.test/" }, db)), "webhookUrlInvalid");
  assert.equal(code(() => createWebhook({ name: "x", url: "http://169.254.169.254/" }, db)), "webhookUrlBlocked");
  assert.equal(code(() => createWebhook({ name: "x", url: "https://a.test/", events: [] }, db)), "webhookEventsInvalid");
  assert.equal(code(() => createWebhook({ name: "x", url: "https://a.test/", events: ["user.create"] }, db)), "webhookEventsInvalid");
  assert.deepEqual(createWebhook({ name: "all", url: "https://a.test/", events: ["vlan.create", "*"] }, db).webhook.events, ["*"]);
  const u = updateWebhook(r.webhook.id, { active: false, name: "Chat 2" }, db);
  assert.equal(u.active, false);
  assert.equal(code(() => updateWebhook(r.webhook.id, {}, db)), "invalidBody");
  assert.equal(code(() => updateWebhook(9999, { name: "z" }, db)), "webhookNotFound");
  const s = regenerateSecret(r.webhook.id, db);
  assert.notEqual(s, r.secret);
  for (let i = 0; i < 8; i++) createWebhook({ name: `w${i}`, url: "https://a.test/" }, db);
  assert.equal(code(() => createWebhook({ name: "de trop", url: "https://a.test/" }, db)), "webhookLimit");
  deleteWebhook(r.webhook.id, db);
  assert.equal(code(() => getWebhook(r.webhook.id, db)), "webhookNotFound");
});

test("file d'attente : une entrée du journal met en file un envoi par webhook abonné et actif, du bon projet", () => {
  const db = freshDb();
  const p = pid(db);
  const a = createWebhook({ name: "A", url: "https://a.test/", events: ["network.create"] }, db).webhook;
  const b = createWebhook({ name: "B", url: "https://b.test/", events: ["vlan.*"] }, db).webhook;
  const c = createWebhook({ name: "C", url: "https://c.test/" }, db).webhook;
  updateWebhook(c.id, { active: false }, db);

  const n = createNetwork({ cidr: "172.27.0.0/24", name: "Wh" }, db);
  recordAudit({ action: "create", entity: "network", entityId: n.id, detail: "172.27.0.0/24 — Wh", username: "alice", changes: { status: ["active", "inactive"] } }, db, T0);
  const fa = listDeliveries(a.id, 10, db), fb = listDeliveries(b.id, 10, db), fc = listDeliveries(c.id, 10, db);
  assert.equal(fa.length, 1);
  assert.equal(fa[0].event, "network.create");
  assert.equal(fb.length + fc.length, 0);
  const payload = JSON.parse((db.prepare("SELECT payload FROM webhook_deliveries WHERE id = ?").get(fa[0].id) as { payload: string }).payload);
  assert.equal(payload.event, "network.create");
  assert.equal(payload.project.id, p);
  assert.deepEqual(payload.actor, { username: "alice" });
  assert.deepEqual(payload.object, { type: "network", id: n.id, label: "172.27.0.0/24 — Wh" });
  assert.deepEqual(payload.changes, { status: ["active", "inactive"] });
  assert.match(payload.id, /^[0-9a-f-]{36}$/);

  // objets non concernés : comptes, connexions, webhooks eux-mêmes ; import CSV et application de plan : oui
  recordAudit({ action: "login", entity: "session", username: "alice" }, db, T0);
  recordAudit({ action: "create", entity: "user", entityId: 1 }, db, T0);
  recordAudit({ action: "update", entity: "webhook", entityId: a.id }, db, T0);
  assert.equal(listDeliveries(c.id, 10, db).length, 0);
  assert.equal(listDeliveries(a.id, 10, db).length, 1);
  const all = createWebhook({ name: "D", url: "https://d.test/" }, db).webhook;
  recordAudit({ action: "import", entity: "csv" }, db, T0);
  recordAudit({ action: "apply", entity: "plan", entityId: 1 }, db, T0);
  assert.deepEqual(listDeliveries(all.id, 10, db).map((d) => d.event).sort(), ["csv.import", "plan.apply"]);
  // un autre projet n'est jamais notifié
  const p2 = Number(db.prepare("INSERT INTO projects (name, created_at) VALUES ('P2', ?)").run(T0.toISOString()).lastInsertRowid);
  assert.equal(queueWebhooks(db, { event: "network.create", projectId: p2, entity: "network" }, T0), 0);
});

test("envoi : en-têtes signés (HMAC du timestamp + corps), succès sur 2xx, corps inchangé", async () => {
  const db = freshDb();
  const { webhook, secret } = createWebhook({ name: "S", url: "https://hooks.example.com/in" }, db);
  recordAudit({ action: "delete", entity: "vlan", entityId: 3, detail: "VLAN 30" }, db, T0);
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const r = await deliverDue(db, { fetchImpl, resolve: async () => ["93.184.216.34"], now: () => T0 });
  assert.deepEqual(r, { success: 1, retry: 0, failed: 0 });
  const { url, init } = calls[0];
  assert.equal(url, "https://hooks.example.com/in");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "manual");
  const h = init.headers as Record<string, string>;
  assert.equal(h["X-IPA-Event"], "vlan.delete");
  assert.equal(h["X-IPA-Timestamp"], String(Math.floor(T0.getTime() / 1000)));
  const expected = "sha256=" + createHmac("sha256", secret).update(`${h["X-IPA-Timestamp"]}.${init.body as string}`).digest("hex");
  assert.equal(h["X-IPA-Signature"], expected);
  assert.equal(h["X-IPA-Signature"], sign(secret, h["X-IPA-Timestamp"], init.body as string));
  assert.equal(JSON.parse(init.body as string).id, h["X-IPA-Delivery"]);
  const d = listDeliveries(webhook.id, 5, db)[0];
  assert.equal(d.status, "success");
  assert.equal(d.responseCode, 204);
  assert.equal(d.attempts, 1);
  assert.equal(getWebhook(webhook.id, db).success, 1);
});

test("réessais : 1 min, 5 min, 30 min, 2 h puis abandon ; pas d'envoi avant l'heure ; renvoi manuel", async () => {
  const db = freshDb();
  const { webhook } = createWebhook({ name: "R", url: "https://hooks.example.com/in" }, db);
  recordAudit({ action: "create", entity: "site", entityId: 1 }, db, T0);
  let status = 500;
  const fetchImpl = (async () => new Response("", { status })) as unknown as typeof fetch;
  const resolve = async () => ["93.184.216.34"];
  const at = (ms: number) => ({ fetchImpl, resolve, now: () => new Date(T0.getTime() + ms) });
  const next = () => listDeliveries(webhook.id, 1, db)[0];

  assert.deepEqual(await deliverDue(db, at(0)), { success: 0, retry: 1, failed: 0 });
  assert.equal(next().nextAttemptAt, new Date(T0.getTime() + 60_000).toISOString());
  assert.equal(next().responseCode, 500);
  assert.deepEqual(await deliverDue(db, at(30_000)), { success: 0, retry: 0, failed: 0 }); // trop tôt
  assert.equal((await deliverDue(db, at(60_000))).retry, 1);
  assert.equal(next().nextAttemptAt, new Date(T0.getTime() + 60_000 + 300_000).toISOString());
  assert.equal((await deliverDue(db, at(360_000))).retry, 1);
  assert.equal((await deliverDue(db, at(360_000 + 1_800_000))).retry, 1);
  assert.equal(next().attempts, 4);
  assert.deepEqual(await deliverDue(db, at(360_000 + 1_800_000 + 7_200_000)), { success: 0, retry: 0, failed: 1 });
  assert.equal(next().status, "failed");
  assert.equal(next().attempts, 5);
  assert.equal(next().nextAttemptAt, null);

  // renvoi manuel : repart à zéro, réussit quand la destination répond
  status = 200;
  const id = next().id;
  assert.equal(retryDelivery(webhook.id, id, db, T0).status, "pending");
  assert.equal((await deliverDue(db, at(0))).success, 1);
  assert.equal(code(() => retryDelivery(webhook.id, 99999, db)), "deliveryNotFound");
});

test("erreurs d'envoi : redirection non suivie, réseau, délai, nom DNS vers une adresse interdite, webhook désactivé", async () => {
  const db = freshDb();
  const { webhook } = createWebhook({ name: "E", url: "https://hooks.example.com/in" }, db);
  const ok = async () => ["93.184.216.34"];
  const one = async (impl: typeof fetch, resolve = ok) => {
    recordAudit({ action: "create", entity: "site", entityId: 1 }, db, T0);
    await deliverDue(db, { fetchImpl: impl, resolve, now: () => T0 });
    return listDeliveries(webhook.id, 1, db)[0];
  };
  assert.equal((await one((async () => new Response("", { status: 302, headers: { location: "http://169.254.169.254/" } })) as unknown as typeof fetch)).error, "redirect");
  assert.equal((await one((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch)).error, "network");
  assert.equal((await one((async () => { const e = new Error("x"); e.name = "AbortError"; throw e; }) as unknown as typeof fetch)).error, "timeout");
  let called = false;
  const spy = (async () => { called = true; return new Response("", { status: 200 }); }) as unknown as typeof fetch;
  assert.equal((await one(spy, async () => ["169.254.169.254"])).error, "blocked-address");
  assert.equal((await one(spy, async () => { throw new Error("ENOTFOUND"); })).error, "dns");
  assert.equal(called, false, "aucun appel sortant vers une adresse interdite");
  updateWebhook(webhook.id, { active: false }, db);
  recordAudit({ action: "create", entity: "site", entityId: 1 }, db, T0); // désactivé : rien n'est mis en file
  const pendingBefore = (db.prepare("SELECT COUNT(*) AS c FROM webhook_deliveries WHERE status = 'pending'").get() as { c: number }).c;
  await deliverDue(db, { fetchImpl: spy, resolve: ok, now: () => new Date(T0.getTime() + 10 * 3600_000) });
  assert.equal(called, false);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM webhook_deliveries WHERE status = 'pending'").get() as { c: number }).c, 0, `${pendingBefore} en attente passés en échec (désactivé)`);
});

test("test d'envoi : événement webhook.test hors abonnements ; purge de l'historique", async () => {
  const db = freshDb();
  const { webhook } = createWebhook({ name: "T", url: "https://hooks.example.com/in", events: ["vlan.create"] }, db);
  const id = queueTest(webhook.id, db, T0);
  assert.equal(getDelivery(id, db)!.event, "webhook.test");
  const r = await deliverDue(db, { fetchImpl: (async () => new Response("", { status: 200 })) as unknown as typeof fetch, resolve: async () => ["1.2.3.4"], now: () => T0 }, id);
  assert.equal(r.success, 1);
  assert.equal(queueWebhooks(db, { event: "webhook.test", projectId: pid(db), entity: "webhook" }, T0), 0);
  // purge : plus de 14 jours
  db.prepare("UPDATE webhook_deliveries SET created_at = ? WHERE id = ?").run("2026-09-01T00:00:00.000Z", id);
  assert.equal(pruneDeliveries(db, T0), 1);
  assert.equal(listDeliveries(webhook.id, 10, db).length, 0);
});
