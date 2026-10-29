import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { getAlertConfig, runAlerts, updateAlertConfig } from "./alerts";
import { updateSignupConfig } from "./signupsettings";
import { getMonitoring } from "./monitoring";
import type { MailMessage } from "../mail/smtp";
import { ApiError } from "../types";

const T0 = new Date("2026-10-22T10:00:00.000Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

function freshDb(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  seedDatabase(db);
  return db;
}
function setup(over: Parameters<typeof updateAlertConfig>[0] = {}) {
  const db = freshDb();
  updateSignupConfig({ consoleMode: true }, db);
  updateAlertConfig({ enabled: true, recipients: "a@example.com, B@Example.com", minSeverity: "warning", intervalMin: 15, ...over }, db);
  const sent: MailMessage[] = [];
  const deps = (now: Date) => ({ now, deliver: async (_d: Db, m: MailMessage) => void sent.push(m) });
  return { db, sent, deps };
}
const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
};
/** Provoque un nouveau problème : un réseau en erreur. */
let n = 0;
const breakNetwork = (db: Db, name: string) => {
  const p = db.prepare("SELECT id FROM projects ORDER BY id LIMIT 1").get() as { id: number };
  db.prepare("INSERT INTO networks (project_id, cidr, name, version, status, used_ips, reserved_ips, capacity, created_at) VALUES (?, ?, ?, 4, 'error', 0, 0, 254, '2026-01-01')").run(p.id, `10.250.${n++}.0/24`, name);
};

test("alertes : configuration validée, destinataires normalisés, obligatoires pour activer", () => {
  const db = freshDb();
  assert.equal(getAlertConfig(db).enabled, false);
  assert.equal(codeOf(() => updateAlertConfig({ enabled: true }, db)), "alertsInvalidConfig");
  assert.equal(codeOf(() => updateAlertConfig({ recipients: "pas-un-mail" }, db)), "alertsInvalidConfig");
  assert.equal(codeOf(() => updateAlertConfig({ intervalMin: 1 }, db)), "alertsInvalidConfig");
  assert.equal(codeOf(() => updateAlertConfig({ minSeverity: "info" }, db)), "alertsInvalidConfig");
  const c = updateAlertConfig({ recipients: "A@x.fr; a@x.fr b@x.fr", locale: "en" }, db);
  assert.deepEqual(c.recipients, ["a@x.fr", "b@x.fr"]);
  assert.equal(c.locale, "en");
});

test("alertes : désactivées = rien ; sans moyen d'envoi = erreur consignée", async () => {
  const db = freshDb();
  assert.equal((await runAlerts(db, { now: T0 })).skipped, "disabled");
  updateAlertConfig({ enabled: true, recipients: "a@x.fr" }, db);
  const r = await runAlerts(db, { now: T0 }, { force: true });
  assert.equal(r.error, "signupNotConfigured");
  assert.equal(getAlertConfig(db).lastRun?.error, "signupNotConfigured");
});

test("alertes : un seul message pour tous, pas de renvoi tant que le problème dure, renvoi s'il revient", async () => {
  const { db, sent, deps } = setup();
  breakNetwork(db, "Labo");
  const total = getMonitoring(db).findings.filter((f) => f.severity !== "info").length;
  assert.ok(total >= 1);

  const r1 = await runAlerts(db, deps(T0));
  assert.equal(r1.fresh, total);
  assert.equal(r1.sent, 2);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((m) => m.to).sort(), ["a@example.com", "b@example.com"]);
  assert.match(sent[0].text, /Labo/);

  assert.equal((await runAlerts(db, deps(at(5)))).skipped, "notDue");
  const r2 = await runAlerts(db, deps(at(16)));
  assert.equal(r2.fresh, 0);
  assert.equal(sent.length, 2, "rien de nouveau : aucun message");

  breakNetwork(db, "Labo 2");
  const r3 = await runAlerts(db, deps(at(32)));
  assert.equal(r3.fresh, 1);
  assert.equal(sent.length, 4);
  assert.match(sent[2].text, /Labo 2/);

  // le problème « Labo 2 » disparaît puis revient : il est signalé de nouveau
  db.prepare("UPDATE networks SET status = 'active' WHERE name = 'Labo 2'").run();
  assert.equal((await runAlerts(db, deps(at(48)))).fresh, 0);
  db.prepare("UPDATE networks SET status = 'error' WHERE name = 'Labo 2'").run();
  assert.equal((await runAlerts(db, deps(at(64)))).fresh, 1);
});

test("alertes : échec d'envoi = rien de marqué, le passage suivant réessaie ; gravité minimale respectée", async () => {
  const { db, sent, deps } = setup();
  breakNetwork(db, "Labo");
  const failing = { now: T0, deliver: async () => { throw new ApiError("mailUnreachable", 502); } };
  const origErr = console.error;
  console.error = () => {};
  let r;
  try {
    r = await runAlerts(db, failing);
  } finally {
    console.error = origErr;
  }
  assert.equal(r.sent, 0);
  assert.equal(r.error, "mailUnreachable");
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM alert_state").get() as { c: number }).c, 0);
  const ok = await runAlerts(db, deps(at(16)));
  assert.ok(ok.fresh >= 1 && ok.sent === 2 && sent.length === 2);

  const { db: db2, sent: s2, deps: d2 } = setup({ minSeverity: "critical" });
  const crit = getMonitoring(db2).findings.filter((f) => f.severity === "critical").length;
  const r2 = await runAlerts(db2, d2(T0));
  assert.equal(r2.fresh, crit);
  if (crit === 0) assert.equal(s2.length, 0);
});

test("alertes : le message ne contient pas d'adresse de destinataire autre que le sien et reste borné", async () => {
  const { db, sent, deps } = setup();
  for (let i = 0; i < 60; i++) breakNetwork(db, `Réseau ${i}`);
  await runAlerts(db, deps(T0));
  assert.ok(sent[0].text.length < 40_000);
  assert.match(sent[0].text, /autre\(s\)/);
  assert.ok(!sent[0].text.includes("b@example.com"));
});

test("alertes par projet : chaque contact ne reçoit que son projet, les destinataires communs reçoivent tout", async () => {
  const { db, sent, deps } = setup({ recipients: "ops@example.com" });
  const ids = (db.prepare("SELECT id FROM projects ORDER BY id").all() as { id: number }[]).map((p) => p.id);
  db.prepare("INSERT INTO projects (name, created_at) VALUES ('Client B', '2026-01-01')").run();
  const b = (db.prepare("SELECT id FROM projects WHERE name = 'Client B'").get() as { id: number }).id;
  db.prepare("INSERT INTO networks (project_id, cidr, name, version, status, used_ips, reserved_ips, capacity, created_at) VALUES (?, '10.99.0.0/24', 'Réseau-B', 4, 'error', 0, 0, 254, '2026-01-01')").run(b);
  const cfg = updateAlertConfig({ projectRecipients: [{ projectId: b, recipients: "Contact@Client-B.com" }, { projectId: ids[0], recipients: "" }] }, db);
  assert.deepEqual(cfg.projectRecipients.find((p) => p.projectId === b)!.recipients, ["contact@client-b.com"]);
  assert.equal(codeOf(() => updateAlertConfig({ projectRecipients: [{ projectId: 99999, recipients: "a@b.fr" }] }, db)), "projectNotFound");
  assert.equal(codeOf(() => updateAlertConfig({ projectRecipients: [{ projectId: b, recipients: "pas-un-mail" }] }, db)), "alertsInvalidConfig");

  await runAlerts(db, deps(T0));
  const to = (addr: string) => sent.filter((m) => m.to === addr);
  assert.equal(to("contact@client-b.com").length, 1);
  assert.match(to("contact@client-b.com")[0].text, /Réseau-B/);
  assert.ok(!/Entreprise Globale/.test(to("contact@client-b.com")[0].text), "le contact de B ne voit pas les autres projets");
  assert.equal(to("ops@example.com").length, 1);
  assert.match(to("ops@example.com")[0].text, /Réseau-B/);
  assert.ok(to("ops@example.com")[0].text.length > to("contact@client-b.com")[0].text.length);
  // rien de nouveau : plus rien n'est envoyé
  await runAlerts(db, deps(at(16)));
  assert.equal(sent.length, 2);
});

test("alertes par projet : sans aucun destinataire commun, activation possible avec un contact de projet ; projet sans destinataire non marqué", async () => {
  const db = freshDb();
  updateSignupConfig({ consoleMode: true }, db);
  const first = (db.prepare("SELECT id FROM projects ORDER BY id LIMIT 1").get() as { id: number }).id;
  assert.equal(codeOf(() => updateAlertConfig({ enabled: true }, db)), "alertsInvalidConfig");
  updateAlertConfig({ enabled: true, minSeverity: "warning", projectRecipients: [{ projectId: first, recipients: "x@y.fr" }] }, db);
  db.prepare("INSERT INTO projects (name, created_at) VALUES ('Sans contact', '2026-01-01')").run();
  const orphan = (db.prepare("SELECT id FROM projects WHERE name = 'Sans contact'").get() as { id: number }).id;
  db.prepare("INSERT INTO networks (project_id, cidr, name, version, status, used_ips, reserved_ips, capacity, created_at) VALUES (?, '10.98.0.0/24', 'Orphelin', 4, 'error', 0, 0, 254, '2026-01-01')").run(orphan);
  const sent: MailMessage[] = [];
  const r = await runAlerts(db, { now: T0, deliver: async (_d, m) => void sent.push(m) });
  assert.ok(sent.every((m) => m.to === "x@y.fr" && !/Orphelin/.test(m.text)));
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM alert_state WHERE project_id = ?").get(orphan) as { c: number }).c, 0);
  assert.ok(r.sent >= 0);
  // un contact est ajouté : le problème est enfin signalé
  updateAlertConfig({ projectRecipients: [{ projectId: orphan, recipients: "late@y.fr" }] }, db);
  await runAlerts(db, { now: at(16), deliver: async (_d, m) => void sent.push(m) });
  assert.ok(sent.some((m) => m.to === "late@y.fr" && /Orphelin/.test(m.text)));
});
