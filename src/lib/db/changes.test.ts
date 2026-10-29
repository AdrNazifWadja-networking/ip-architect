import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { listAudit, listAuditForExport, recordAudit } from "./audit";
import { snapshot, trackChanges } from "./changes";
import { updateNetwork, updateVlan } from "./edit";
import { deleteNetwork } from "./queries";
import { createUser } from "./users";
import { updateAiConfig } from "./aisettings";
import { updateSignupConfig } from "./signupsettings";
import { updateAppSettings, createBackup } from "./appsettings";
import { auditCsv } from "../auditCsv";
import { changesSummary, diffSnapshots, MAX_CHANGE_FIELDS, MAX_CHANGE_VALUE, MAX_CHANGES_JSON, parseChanges, sanitizeChanges } from "../changeTypes";
import { dictionaries } from "../i18n";

function freshDb(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  seedDatabase(db);
  return db;
}
const firstNetwork = (db: Db) => db.prepare("SELECT id FROM networks ORDER BY id LIMIT 1").get() as { id: number };

test("diff : seuls les champs qui changent, null = création ou suppression, égalité stricte", () => {
  assert.equal(diffSnapshots(null, null), null);
  assert.equal(diffSnapshots({ a: 1, b: "x" }, { a: 1, b: "x" }), null);
  assert.deepEqual(diffSnapshots({ a: 1, b: "x", c: null }, { a: 2, b: "x", c: "n" }), { a: [1, 2], c: [null, "n"] });
  assert.deepEqual(diffSnapshots({ a: 1, b: "x" }, null), { a: [1, null], b: ["x", null] });
  assert.deepEqual(diffSnapshots(null, { a: true }), { a: [null, true] });
  assert.deepEqual(diffSnapshots({ n: 0 }, { n: false }), { n: [0, false] }, "0 et false sont différents");
});

test("sanitize : jamais de secret, valeurs bornées, formes invalides écartées", () => {
  const c = sanitizeChanges({
    name: ["a", "b"],
    password: ["x", "y"],
    passwordHash: ["x", "y"],
    apiKey: ["k1", "k2"],
    smtpPassword: ["p", "q"],
    token: ["t", "u"],
    sessionId: [1, 2],
    secretWord: ["s", "t"],
    ok_field: [1, 2],
    "bad name": [1, 2],
    obj: [{ a: 1 }, 2],
    arr: [[1], 2],
    short: [1],
    same: ["z", "z"],
    nan: [NaN, 1],
    long: ["x".repeat(500), "y"],
    ctl: ["a\nb\u0000c", "d"],
  })!;
  assert.deepEqual(Object.keys(c).sort(), ["ctl", "long", "name", "ok_field"]);
  assert.equal((c.long[0] as string).length, MAX_CHANGE_VALUE);
  assert.ok((c.long[0] as string).endsWith("…"));
  assert.equal(c.ctl[0], "a b c");
  assert.equal(sanitizeChanges(null), null);
  assert.equal(sanitizeChanges([["a", "b"]]), null);
  assert.equal(sanitizeChanges("x"), null);
  assert.equal(sanitizeChanges({}), null);
  assert.equal(sanitizeChanges({ password: ["a", "b"] }), null, "rien d'exploitable");
  // plafonds : nombre de champs et taille totale
  const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`f${i}`, [i, i + 1]]));
  assert.equal(Object.keys(sanitizeChanges(many)!).length, MAX_CHANGE_FIELDS);
  const fat = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, ["a".repeat(190), "b".repeat(190)]]));
  assert.ok(JSON.stringify(sanitizeChanges(fat)).length <= MAX_CHANGES_JSON);
});

test("parse : JSON invalide ou détourné -> null ; résumé lisible", () => {
  assert.equal(parseChanges(null), null);
  assert.equal(parseChanges(""), null);
  assert.equal(parseChanges("{pas du json"), null);
  assert.equal(parseChanges('{"a":"b"}'), null);
  assert.equal(parseChanges('{"password":["a","b"]}'), null, "une base modifiée à la main ne peut pas afficher un secret");
  const c = parseChanges('{"name":["A","B"],"vlan":[null,20]}')!;
  assert.equal(changesSummary(c), "name: A → B ; vlan: ∅ → 20");
  assert.equal(changesSummary(null), "");
});

test("instantané réseau : valeurs lisibles (site, VRF), modification suivie champ par champ", () => {
  const db = freshDb();
  const { id } = firstNetwork(db);
  const before = snapshot("network", id, db)!;
  assert.ok(before.cidr && typeof before.name === "string" && "site" in before && "vrf" in before);
  assert.ok(!("site_id" in before) && !("vrf_id" in before), "noms lisibles, pas des identifiants");
  const t = trackChanges("network", id, db);
  updateNetwork(id, { name: "Renommé", status: "maintenance" }, db);
  assert.deepEqual(t.updated(), { name: [before.name, "Renommé"], status: [before.status, "maintenance"] });
  // aucune modification effective -> pas d'historique
  const t2 = trackChanges("network", id, db);
  updateNetwork(id, { name: "Renommé" }, db);
  assert.equal(t2.updated(), null);
});

test("suppression : l'historique garde ce qui a disparu ; objet inexistant -> null sans exception", () => {
  const db = freshDb();
  const { id } = firstNetwork(db);
  const snap = snapshot("network", id, db)!;
  const t = trackChanges("network", id, db);
  deleteNetwork(id, db);
  const gone = t.removed()!;
  assert.deepEqual(gone.cidr, [snap.cidr, null]);
  assert.deepEqual(gone.name, [snap.name, null]);
  assert.equal(snapshot("network", id, db), null);
  assert.equal(trackChanges("network", 99999, db).removed(), null);
  assert.equal(snapshot("session", 1, db), null);
  assert.equal(snapshot("network", 1, { prepare() { throw new Error("boom"); } } as unknown as Db), null, "ne lève jamais");
});

test("instantané VLAN, plage DHCP, VRF, site, projet, adresse, plan : champs attendus, aucun identifiant interne", () => {
  const db = freshDb();
  const one = (sql: string) => (db.prepare(sql).get() as { id: number } | undefined)?.id;
  const cases: [Parameters<typeof snapshot>[0], string, string[]][] = [
    ["vlan", "SELECT id FROM vlans LIMIT 1", ["number", "name", "site"]],
    ["dhcpScope", "SELECT id FROM dhcp_scopes LIMIT 1", ["name", "rangeStart", "rangeEnd", "gateway", "dns", "leaseSeconds", "enabled"]],
    ["dhcpReservation", "SELECT id FROM dhcp_reservations LIMIT 1", ["mac", "address", "hostname", "description"]],
    ["vrf", "SELECT id FROM vrfs LIMIT 1", ["name", "rd", "rtImport", "rtExport", "description"]],
    ["site", "SELECT id FROM sites LIMIT 1", ["name", "address", "description"]],
    ["project", "SELECT id FROM projects LIMIT 1", ["name", "description"]],
    ["address", "SELECT id FROM ip_addresses LIMIT 1", ["address", "status", "hostname", "description", "tags", "fields"]],
  ];
  for (const [kind, sql, keys] of cases) {
    const id = one(sql);
    assert.ok(id, `${kind} : donnée de démonstration absente`);
    const s = snapshot(kind, id!, db)!;
    assert.deepEqual(Object.keys(s).sort(), [...keys].sort(), kind);
  }
  const d = snapshot("dhcpScope", one("SELECT id FROM dhcp_scopes LIMIT 1")!, db)!;
  assert.equal(typeof d.enabled, "boolean");
  // modification de VLAN suivie
  const vid = one("SELECT id FROM vlans LIMIT 1")!;
  const t = trackChanges("vlan", vid, db);
  updateVlan(vid, { name: "Nouveau nom" }, db);
  assert.equal(t.updated()!.name[1], "Nouveau nom");
});

test("instantané compte : droits et nom seulement, jamais l'e-mail ni le mot de passe", async () => {
  const db = freshDb();
  const u = await createUser({ username: "boss", displayName: "Boss", password: "Correct-Horse-42", role: "admin", email: "boss@example.com" }, db, { bootstrap: true });
  const s = snapshot("user", u.id, db)!;
  assert.deepEqual(s, { displayName: "Boss", role: "admin", active: true, projectScope: "all", projectRoles: null });
  assert.ok(!JSON.stringify(s).includes("example.com") && !JSON.stringify(s).toLowerCase().includes("hash"));
});

test("instantanés de réglages : valeurs utiles, JAMAIS la clé d'API ni le mot de passe SMTP", () => {
  const db = freshDb();
  updateAiConfig({ enabled: true, provider: "gemini", model: "gemini-3.5-flash", apiKey: "AIza-SECRET-KEY-123456" }, db);
  updateSignupConfig({ enabled: true, consoleMode: true, smtpHost: "smtp.example.com", smtpUser: "me@example.com", smtpPassword: "SMTP-SECRET-PW-987" }, db);
  const all = JSON.stringify([snapshot("assistantSettings", 0, db), snapshot("signupSettings", 0, db), snapshot("settings", 0, db)]);
  assert.ok(!all.includes("AIza-SECRET") && !all.includes("SMTP-SECRET") && !all.includes("me@example.com"), all);
  assert.ok(all.includes("gemini") && all.includes("smtp.example.com"));
  const t = trackChanges("assistantSettings", 0, db);
  updateAiConfig({ model: "gemini-3.5-flash-lite", apiKey: "AIza-ANOTHER-SECRET-999" }, db);
  const ch = t.updated()!;
  assert.deepEqual(Object.keys(ch), ["model"]);
  assert.ok(!JSON.stringify(ch).includes("SECRET"));
  const t2 = trackChanges("settings", 0, db);
  updateAppSettings({ orgName: "Acme", warnPct: 70 }, db);
  assert.deepEqual(t2.updated(), { orgName: ["", "Acme"], warnPct: [80, 70] });
});

test("journal : valeurs avant/après et origine « jeton » enregistrées, relues et validées", () => {
  const db = freshDb();
  recordAudit({ action: "update", entity: "network", entityId: 1, detail: "10.0.0.0/24", changes: { name: ["A", "B"] }, via: "token:ipa_Ab12" }, db);
  recordAudit({ action: "update", entity: "network", changes: { password: ["a", "b"] }, via: "token:<script>" }, db);
  recordAudit({ action: "update", entity: "network" }, db);
  const rows = listAudit({}, db).rows; // du plus récent au plus ancien
  assert.equal(rows[0].changes, null);
  assert.equal(rows[0].via, null);
  assert.equal(rows[1].changes, null, "un secret n'est pas écrit même si l'appelant le fournit");
  assert.equal(rows[1].via, null, "origine invalide ignorée");
  assert.deepEqual(rows[2].changes, { name: ["A", "B"] });
  assert.equal(rows[2].via, "token:ipa_Ab12");
  assert.ok(!JSON.stringify(db.prepare("SELECT changes FROM audit_log").all()).includes("password"));
});

test("journal : la recherche couvre les valeurs avant/après ; l'export CSV les contient", () => {
  const db = freshDb();
  recordAudit({ action: "update", entity: "address", detail: "x", username: "alice", changes: { hostname: ["srv-old", "srv-new"] }, via: "token:ipa_Ab12" }, db);
  recordAudit({ action: "update", entity: "address", detail: "y", username: "bob" }, db);
  assert.equal(listAudit({ q: "srv-old" }, db).total, 1);
  assert.equal(listAudit({ q: "SRV-NEW" }, db).total, 1);
  assert.equal(listAudit({ q: "zzz" }, db).total, 0);
  const csv = auditCsv(listAuditForExport({}, db).rows, dictionaries.fr);
  const [head, ...lines] = csv.replace(/^﻿/, "").trim().split(/\r?\n/);
  assert.ok(head.endsWith("Origine;Avant → après"), head);
  assert.ok(lines.some((l) => l.includes("hostname: srv-old → srv-new") && l.includes("ipa_Ab12")));
  assert.ok(lines.some((l) => l.endsWith(";;")) , "ligne sans historique : colonnes vides");
});

test("sauvegarde : l'historique du journal n'ajoute aucun secret (clé d'API, mot de passe SMTP absents de la copie)", () => {
  const db = freshDb();
  updateAiConfig({ enabled: true, provider: "gemini", model: "gemini-3.5-flash", apiKey: "AIza-SECRET-KEY-123456" }, db);
  recordAudit({ action: "update", entity: "settings", changes: trackChangesFor(db) }, db);
  const copy = createBackup(db);
  assert.ok(!copy.includes("AIza-SECRET"));
});
function trackChangesFor(db: Db) {
  const t = trackChanges("assistantSettings", 0, db);
  updateAiConfig({ model: "autre-modele" }, db);
  return t.updated();
}
