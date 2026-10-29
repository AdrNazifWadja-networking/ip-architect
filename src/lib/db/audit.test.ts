import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { createNetwork } from "./queries";
import { createSite } from "./sites";
import { createUser, login } from "./users";
import { AUDIT_MAX_ROWS, auditLabel, cleanDetail, listAudit, listAuditForExport, listAuditUsers, pruneAudit, recordAudit } from "./audit";
import { createBackup, getAppSettings, getDatabaseInfo, updateAppSettings } from "./appsettings";
import { auditCsv } from "../auditCsv";
import { auditFiltersFrom } from "../auditFilters";
import { parseCsv } from "../csv/csv";
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from "../auditTypes";
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
const at = (iso: string) => new Date(iso);

test("journal : enregistrement, nettoyage du détail, adresse IP validée, action inconnue refusée", () => {
  const db = freshDb();
  recordAudit({ action: "create", entity: "network", entityId: 7, detail: "  10.0.0.0/24\n— LAN\t\u0007 test  ", userId: 3, username: "alice", ip: "203.0.113.9" }, db, at("2026-10-21T10:00:00Z"));
  recordAudit({ action: "login", entity: "session", ip: "<script>alert(1)</script>" }, db);
  const rows = listAudit({}, db).rows;
  assert.equal(rows.length, 2);
  const r = rows.find((x) => x.action === "create")!;
  assert.equal(r.detail, "10.0.0.0/24 — LAN test");
  assert.equal(r.username, "alice");
  assert.equal(r.at, "2026-10-21T10:00:00.000Z");
  assert.equal(r.ip, "203.0.113.9");
  assert.equal(rows.find((x) => x.action === "login")!.ip, null, "une IP douteuse n'est pas stockée");
  assert.ok(r.projectName, "projet actif renseigné");
  assert.throws(() => recordAudit({ action: "hack", entity: "network" }, db));
  assert.throws(() => recordAudit({ action: "create", entity: "nope" }, db));
  assert.equal(cleanDetail("x".repeat(500))!.length, 300);
  assert.equal(cleanDetail("   "), null);
});

test("journal : filtres (texte, compte, action, objet, dates UTC), pagination, valeurs invalides ignorées", () => {
  const db = freshDb();
  const days = ["2026-10-01", "2026-10-02", "2026-10-03"];
  days.forEach((d, i) => {
    recordAudit({ action: "create", entity: "site", detail: `Site ${i}`, username: "alice" }, db, at(`${d}T23:59:59.999Z`));
    recordAudit({ action: "delete", entity: "vlan", detail: `100% _vlan_ ${i}`, username: "bob" }, db, at(`${d}T00:00:00.000Z`));
  });
  assert.equal(listAudit({}, db).total, 6);
  assert.equal(listAudit({ user: "alice" }, db).total, 3);
  assert.equal(listAudit({ action: "delete" }, db).total, 3);
  assert.equal(listAudit({ entity: "site" }, db).total, 3);
  assert.equal(listAudit({ action: "pirate", entity: "n'importe quoi" }, db).total, 6, "filtre inconnu ignoré (jamais d'injection)");
  assert.equal(listAudit({ q: "site 1" }, db).total, 1);
  assert.equal(listAudit({ q: "BOB" }, db).total, 3, "recherche aussi sur le compte, sans casse");
  assert.equal(listAudit({ q: "100%" }, db).total, 3, "% littéral, pas un joker");
  assert.equal(listAudit({ q: "%" }, db).total, 3);
  assert.equal(listAudit({ q: "_vlan_" }, db).total, 3);
  // bornes de jour incluses (00:00:00.000 et 23:59:59.999)
  assert.equal(listAudit({ from: "2026-10-02", to: "2026-10-02" }, db).total, 2);
  assert.equal(listAudit({ from: "2026-10-03" }, db).total, 2);
  assert.equal(listAudit({ from: "pas-une-date", to: "2026-13-45" }, db).total, 6);
  // pagination
  for (let i = 0; i < 120; i++) recordAudit({ action: "update", entity: "network", detail: `n${i}` }, db);
  const p1 = listAudit({}, db);
  assert.equal(p1.pageSize, 50); assert.equal(p1.total, 126); assert.equal(p1.pages, 3); assert.equal(p1.rows.length, 50);
  assert.equal(p1.rows[0].detail, "n119", "les plus récentes d'abord");
  assert.equal(listAudit({ page: 3 }, db).rows.length, 26);
  assert.equal(listAudit({ page: 99 }, db).page, 3, "page hors limites ramenée à la dernière");
  assert.equal(listAudit({ page: -4 }, db).page, 1);
  assert.deepEqual(listAuditUsers(db), ["alice", "bob"]);
  assert.equal(listAuditForExport({ user: "alice" }, db).rows.length, 3);
});

test("journal : conservation (jours) et plafond de lignes", () => {
  const db = freshDb();
  const now = at("2026-10-21T12:00:00Z");
  recordAudit({ action: "create", entity: "site", detail: "vieux" }, db, at("2025-01-01T00:00:00Z"));
  recordAudit({ action: "create", entity: "site", detail: "recent" }, db, at("2026-10-20T00:00:00Z"));
  assert.equal(pruneAudit(db, now), 1);
  assert.deepEqual(listAudit({}, db).rows.map((r) => r.detail), ["recent"]);
  updateAppSettings({ auditRetentionDays: 30 }, db);
  recordAudit({ action: "create", entity: "site", detail: "un mois et demi" }, db, at("2026-09-01T00:00:00Z"));
  assert.equal(pruneAudit(db, now), 1);
  assert.equal(listAudit({}, db).total, 1);
  // plafond : seules les AUDIT_MAX_ROWS plus récentes sont gardées
  const ins = db.prepare("INSERT INTO audit_log (at, action, entity) VALUES (?, 'update', 'site')");
  db.transaction(() => { for (let i = 0; i < AUDIT_MAX_ROWS + 5; i++) ins.run("2026-10-21T00:00:00.000Z"); })();
  pruneAudit(db, now);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number }).c, AUDIT_MAX_ROWS);
});

test("journal : auditLabel décrit l'objet AVANT sa suppression ; null s'il n'existe pas", () => {
  const db = freshDb();
  const n = createNetwork({ cidr: "172.31.5.0/24", name: "Test", siteId: null }, db);
  const s = createSite({ name: "Agence Z" }, db);
  assert.equal(auditLabel("network", n.id, db), "172.31.5.0/24 — Test");
  assert.equal(auditLabel("site", s.id, db), "Agence Z");
  db.prepare("DELETE FROM networks WHERE id = ?").run(n.id);
  assert.equal(auditLabel("network", n.id, db), null);
  assert.equal(auditLabel("session", 1, db), null);
  for (const e of AUDIT_ENTITIES) assert.doesNotThrow(() => auditLabel(e, 1, db));
});

test("journal : survit à la suppression d'un compte et d'un projet (aucune clé étrangère)", async () => {
  const db = freshDb();
  const u = await createUser({ username: "temp", displayName: "T", password: "Correct-Horse-42", role: "editor" }, db);
  const pid = (db.prepare("SELECT id FROM projects ORDER BY id LIMIT 1").get() as { id: number }).id;
  recordAudit({ action: "update", entity: "site", userId: u.id, username: "temp", detail: "x" }, db);
  db.prepare("DELETE FROM users WHERE id = ?").run(u.id);
  db.prepare("INSERT INTO projects (name) VALUES ('Eph')").run();
  const eph = (db.prepare("SELECT id FROM projects WHERE name = 'Eph'").get() as { id: number }).id;
  recordAudit({ action: "create", entity: "network", projectId: eph, detail: "y" }, db);
  db.prepare("DELETE FROM projects WHERE id = ?").run(eph);
  const rows = listAudit({}, db).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.detail === "x")!.username, "temp", "le nom du compte reste lisible");
  assert.equal(rows.find((r) => r.detail === "y")!.projectName, null);
  assert.ok(pid > 0);
});

test("journal : libellés traduits pour toutes les actions et tous les objets, CSV relisible et protégé", () => {
  const fr = dictionaries.fr, en = dictionaries.en;
  for (const a of AUDIT_ACTIONS) { assert.ok(fr.audit.actions[a], a); assert.ok(en.audit.actions[a], a); }
  for (const e of AUDIT_ENTITIES) { assert.ok(fr.audit.entities[e], e); assert.ok(en.audit.entities[e], e); }
  const db = freshDb();
  recordAudit({ action: "create", entity: "site", detail: "=HYPERLINK(\"http://evil\")", username: "alice" }, db);
  const rows = listAudit({}, db).rows;
  const csv = auditCsv(rows, fr, ";");
  assert.ok(csv.startsWith("﻿Date (UTC);Compte;Action;Objet;Détail;Projet;Adresse IP"));
  const back = parseCsv(csv, ";");
  assert.equal(back.length, 2);
  assert.equal(back[1][2], "Création");
  assert.equal(back[1][4], "=HYPERLINK(\"http://evil\")", "restitué tel quel à la lecture");
  assert.ok(csv.includes("'=HYPERLINK"), "mais neutralisé dans le fichier");
  assert.ok(auditCsv(rows, en, ",").includes("Creation"));
});

test("filtres d'URL : seules des valeurs textuelles, page numérique", () => {
  const f = auditFiltersFrom((k) => ({ q: "x", page: "3", user: "", from: "2026-01-01" } as Record<string, string>)[k]);
  assert.deepEqual(f, { q: "x", user: undefined, action: undefined, entity: undefined, from: "2026-01-01", to: undefined, page: 3 });
  assert.equal(auditFiltersFrom(() => "12abc").page, undefined);
  assert.equal(auditFiltersFrom(() => null).q, undefined);
});

test("paramètres : valeurs par défaut, modification partielle, validations, rien d'écrit en cas d'erreur", () => {
  const db = freshDb();
  const d = getAppSettings(db);
  assert.equal(d.orgName, ""); assert.equal(d.auditRetentionDays, 365);
  assert.deepEqual(d.thresholds, { warnPct: 80, critPct: 90 });
  const u = updateAppSettings({ orgName: "  Ma\u0000 Société \n", auditRetentionDays: 90, warnPct: 70, critPct: 85 }, db);
  assert.equal(u.orgName, "Ma Société"); assert.equal(u.auditRetentionDays, 90); assert.deepEqual(u.thresholds, { warnPct: 70, critPct: 85 });
  assert.equal(updateAppSettings({ critPct: 95 }, db).thresholds.warnPct, 70, "champ absent inchangé");
  // un seuil invalide n'enregistre RIEN, pas même le nom
  assert.equal(code(() => updateAppSettings({ orgName: "Autre", warnPct: 99, critPct: 50 }, db)), "invalidThresholds");
  assert.equal(getAppSettings(db).orgName, "Ma Société");
  assert.equal(code(() => updateAppSettings({ auditRetentionDays: 5 }, db)), "invalidRetention");
  assert.equal(code(() => updateAppSettings({ auditRetentionDays: 10000 }, db)), "invalidRetention");
  assert.equal(code(() => updateAppSettings({ auditRetentionDays: 90.5 }, db)), "invalidRetention");
  assert.equal(code(() => updateAppSettings({ auditRetentionDays: "90" }, db)), "invalidRetention");
  assert.equal(code(() => updateAppSettings({ orgName: "x".repeat(81) }, db)), "nameTooLong");
  assert.equal(code(() => updateAppSettings({ orgName: 12 }, db)), "invalidBody");
  assert.equal(code(() => updateAppSettings({}, db)), "invalidBody");
  assert.equal(updateAppSettings({ orgName: "" }, db).orgName, "", "nom effaçable");
});

test("base : informations et sauvegarde (copie SQLite valide, sans les sessions, comptes conservés)", async () => {
  const db = freshDb();
  await createUser({ username: "root", displayName: "Root", password: "Correct-Horse-42", role: "admin" }, db);
  await login("root", "Correct-Horse-42", { ip: null }, db);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM user_sessions").get() as { c: number }).c, 1);
  const info = getDatabaseInfo(db);
  assert.ok(info.sqliteVersion.length > 0);
  assert.ok(info.counts.find((c) => c.table === "networks")!.rows > 0);
  assert.equal(info.counts.find((c) => c.table === "users")!.rows, 1);
  const buf = createBackup(db);
  assert.equal(buf.subarray(0, 15).toString("latin1"), "SQLite format 3", "en-tête SQLite");
  // la copie s'ouvre, contient les données et le compte, mais plus aucune session ; la base d'origine garde la sienne
  const tmp = path.join(process.cwd(), `.audit-test-${process.pid}.db`);
  fs.writeFileSync(tmp, buf);
  try {
    const copy = new Database(tmp);
    assert.equal((copy.prepare("SELECT COUNT(*) AS c FROM user_sessions").get() as { c: number }).c, 0);
    assert.equal((copy.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c, 1);
    assert.equal((copy.prepare("SELECT COUNT(*) AS c FROM networks").get() as { c: number }).c, info.counts.find((c) => c.table === "networks")!.rows);
    copy.close();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM user_sessions").get() as { c: number }).c, 1);
});

test("politique : journal et sauvegarde = administrateur ; réglages lisibles par tous, modifiables par un administrateur", () => {
  assert.equal(requiredAccess("GET", "/api/audit"), "admin");
  assert.equal(requiredAccess("GET", "/api/settings/backup"), "admin");
  assert.equal(requiredAccess("PATCH", "/api/settings"), "admin");
  assert.equal(requiredAccess("GET", "/api/settings"), "viewer");
});

test("couverture : chaque gestionnaire d'écriture appelle audit() (hors simulations et sondes)", () => {
  const root = path.join(process.cwd(), "src", "app", "api");
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : e.name === "route.ts" && files.push(p); } };
  walk(root);
  const exempt = ["/simulator/", "/monitoring/probe", "/assistant/models", "/notifications/read", "/auth/register/start", "/settings/signup/test", "/settings/sso/test", "/tp/[id]/submit", "/auth/reset/start"];
  let checked = 0;
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join("/");
    if (exempt.some((x) => `/${rel}`.includes(x))) continue;
    const src = fs.readFileSync(f, "utf8");
    const handlers = [...src.matchAll(/export async function (POST|PATCH|PUT|DELETE)\(/g)];
    handlers.forEach((m, i) => {
      const body = src.slice(m.index!, i + 1 < handlers.length ? handlers[i + 1].index! : src.length);
      assert.ok(body.includes("audit("), `${m[1]} /api/${rel} : aucune entrée de journal`);
      checked++;
    });
  }
  assert.ok(checked >= 30, `${checked} gestionnaires vérifiés`);
});
