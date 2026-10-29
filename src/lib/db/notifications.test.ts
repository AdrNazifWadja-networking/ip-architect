import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { createNetwork, deleteNetwork } from "./queries";
import { createUser } from "./users";
import { fingerprint, getNotifications, markRead, pruneReads } from "./notifications";
import { dictionaries } from "../i18n";
import { requiredAccess } from "../auth/policy";
import { ApiError } from "../types";

function freshDb(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  seedDatabase(db);
  return db;
}
function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
}
/** Un réseau en erreur = un contrôle « critique » de la supervision. */
const broken = (db: Db, cidr: string) => createNetwork({ cidr, name: `KO ${cidr}`, status: "error" }, db);

test("notifications : seuls les critiques et avertissements, non lus d'abord, nombre total exact", () => {
  const db = freshDb();
  const base = getNotifications(null, db);
  assert.equal(base.unread, base.total);
  assert.ok(base.items.every((i) => i.severity === "critical" || i.severity === "warning"));
  broken(db, "10.201.0.0/24");
  const after = getNotifications(null, db);
  assert.equal(after.total, base.total + 1);
  assert.equal(after.items[0].severity, "critical", "les critiques passent devant");
});

test("notifications : marquer lu, par compte ; un autre compte garde ses non lus", async () => {
  const db = freshDb();
  broken(db, "10.201.0.0/24");
  const a = (await createUser({ username: "alice", displayName: "A", password: "Correct-Horse-42", role: "viewer" }, db)).id;
  const b = (await createUser({ username: "bob", displayName: "B", password: "Correct-Horse-42", role: "viewer" }, db)).id;
  const before = getNotifications(a, db);
  assert.ok(before.unread >= 1);
  const one = before.items[0];
  const r = markRead(a, [one.id], db);
  assert.equal(r.unread, before.unread - 1);
  assert.ok(!r.items.some((i) => i.id === one.id && !i.read), "l'élément lu ne figure plus parmi les non lus");
  assert.equal(r.total, before.total);
  assert.equal(getNotifications(b, db).unread, before.unread, "bob n'est pas affecté");
  assert.equal(markRead(a, "all", db).unread, 0);
  assert.equal(getNotifications(a, db).total, before.total, "lu ne veut pas dire supprimé");
  assert.equal(getNotifications(null, db).unread, before.unread, "l'application ouverte (compte 0) est distincte");
});

test("notifications : un nouveau problème, ou une aggravation, est non lu", () => {
  const db = freshDb();
  markRead(null, "all", db);
  assert.equal(getNotifications(null, db).unread, 0);
  broken(db, "10.202.0.0/24");
  assert.equal(getNotifications(null, db).unread, 1);
  const f = { kind: "capacity", severity: "warning", params: { cidr: "10.0.0.0/24", pct: 85, used: 200, capacity: 254 }, href: "/ipam/1" } as const;
  assert.equal(fingerprint(1, f), fingerprint(1, { ...f, params: { ...f.params, pct: 86, used: 201 } }), "les valeurs qui bougent ne changent pas l'identité");
  assert.notEqual(fingerprint(1, f), fingerprint(1, { ...f, severity: "critical" }), "avertissement -> critique = nouvelle notification");
});

test("notifications : un problème corrigé disparaît", () => {
  const db = freshDb();
  const n = broken(db, "10.203.0.0/24");
  const withIt = getNotifications(null, db).total;
  deleteNetwork(n.id, db);
  assert.equal(getNotifications(null, db).total, withIt - 1);
});

test("notifications : identifiants invalides refusés, inconnus ignorés (rien de arbitraire stocké)", () => {
  const db = freshDb();
  for (const bad of [undefined, null, [], "x", [1], new Array(201).fill("a")]) assert.equal(code(() => markRead(null, bad, db)), "invalidBody");
  markRead(null, ["n'importe quoi <script>"], db);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM notification_reads").get() as { c: number }).c, 0);
});

test("notifications : purge des comptes supprimés et des marques de plus de 90 jours", async () => {
  const db = freshDb();
  broken(db, "10.204.0.0/24");
  const u = (await createUser({ username: "carl", displayName: "C", password: "Correct-Horse-42", role: "viewer" }, db)).id;
  markRead(u, "all", db);
  db.prepare("DELETE FROM users WHERE id = ?").run(u);
  pruneReads(db);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM notification_reads WHERE user_id = ?").get(u) as { c: number }).c, 0);
  markRead(null, "all", db, new Date("2026-01-01T00:00:00Z"));
  pruneReads(db, new Date("2026-06-01T00:00:00Z"));
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM notification_reads").get() as { c: number }).c, 0);
});

test("notifications : politique d'accès (lecteur) et textes FR/EN complets", () => {
  assert.equal(requiredAccess("GET", "/api/notifications"), "viewer");
  assert.equal(requiredAccess("POST", "/api/notifications/read"), "viewer");
  for (const d of Object.values(dictionaries)) {
    for (const k of Object.keys(d.monitoring.findings)) if (k !== "title" && k !== "none" && k !== "fix") assert.ok(typeof (d.monitoring.findings as Record<string, string>)[k] === "string");
    assert.ok(d.notifCenter.title && d.header.menu.title);
  }
});
