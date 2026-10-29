import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { createNetwork, getActiveProject, listNetworks } from "./queries";
import { createSite } from "./sites";
import { createVlan, allocateAddress } from "./ipam";
import { createScope } from "./dhcp";
import { createVrf } from "./vrf";
import { updateNetwork } from "./edit";
import { createProject, activateProject } from "./projects";
import {
  DEFAULT_CRIT_PCT,
  DEFAULT_WARN_PCT,
  forecastFromHistory,
  getMonitoring,
  getProbeTargets,
  getThresholds,
  setThresholds,
} from "./monitoring";
import { ApiError } from "../types";

function emptyDb(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  seedDatabase(db);
  const p = createProject({ name: "Vide" }, db);
  activateProject(p.id, db);
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

const kinds = (db: Db) => getMonitoring(db).findings.map((f) => f.kind);

test("seuils : défauts, modification, validation, valeurs corrompues ignorées", () => {
  const db = emptyDb();
  assert.deepEqual(getThresholds(db), { warnPct: DEFAULT_WARN_PCT, critPct: DEFAULT_CRIT_PCT });
  assert.deepEqual(setThresholds({ warnPct: 70, critPct: 95 }, db), { warnPct: 70, critPct: 95 });
  assert.deepEqual(getThresholds(db), { warnPct: 70, critPct: 95 });
  assert.deepEqual(setThresholds({ critPct: 99 }, db), { warnPct: 70, critPct: 99 });
  for (const bad of [{ warnPct: 90, critPct: 90 }, { warnPct: 95, critPct: 90 }, { warnPct: 0, critPct: 90 }, { warnPct: 50, critPct: 101 }, { warnPct: 50.5, critPct: 90 }, { warnPct: "50", critPct: 90 }]) {
    assert.equal(code(() => setThresholds(bad, db)), "invalidThresholds", JSON.stringify(bad));
  }
  assert.deepEqual(setThresholds({ warnPct: 98 }, db), { warnPct: 98, critPct: 99 });
});

test("seuils : une valeur enregistrée incohérente retombe sur les défauts", () => {
  const db = emptyDb();
  db.prepare("INSERT INTO settings (key, value) VALUES ('monitor_warn_pct', '95'), ('monitor_crit_pct', '10')").run();
  assert.deepEqual(getThresholds(db), { warnPct: 80, critPct: 90 });
  db.prepare("UPDATE settings SET value = 'abc' WHERE key = 'monitor_warn_pct'").run();
  assert.deepEqual(getThresholds(db), { warnPct: 80, critPct: 90 });
});

test("capacité : avertissement et critique selon les seuils, réservées comptées, inactifs ignorés", () => {
  const db = emptyDb();
  createNetwork({ cidr: "10.0.0.0/24", name: "ok", usedIps: 100 }, db); // 39 % de 254
  createNetwork({ cidr: "10.0.1.0/24", name: "warn", usedIps: 180, reservedIps: 30 }, db); // 82,7 %
  createNetwork({ cidr: "10.0.2.0/24", name: "crit", usedIps: 200, reservedIps: 40 }, db); // 94,5 %
  createNetwork({ cidr: "10.0.3.0/24", name: "inactif", usedIps: 250, status: "inactive" }, db);
  const m = getMonitoring(db);
  const cap = m.findings.filter((f) => f.kind === "capacity");
  assert.deepEqual(cap.map((f) => [f.params.name, f.severity]), [["crit", "critical"], ["warn", "warning"]]);
  assert.equal(cap[0].params.pct, 94.5);
  assert.equal(cap[0].params.used, 240);
  assert.deepEqual(m.capacity.map((c) => [c.name, c.level]), [["crit", "critical"], ["warn", "warning"], ["ok", "ok"]]);
  assert.equal(m.status, "critical");
  // seuils relevés : plus aucun avertissement
  setThresholds({ warnPct: 96, critPct: 99 }, db);
  assert.equal(getMonitoring(db).findings.filter((f) => f.kind === "capacity").length, 0);
  // seuils abaissés : le réseau « ok » (39 %) devient un avertissement
  setThresholds({ warnPct: 30, critPct: 60 }, db);
  assert.deepEqual(getMonitoring(db).capacity.map((c) => c.level), ["critical", "critical", "warning"]);
});

test("projet vide : tout est ok, aucune prévision", () => {
  const db = emptyDb();
  const m = getMonitoring(db);
  assert.equal(m.status, "ok");
  assert.deepEqual(m.counts, { critical: 0, warning: 0, info: 0 });
  assert.equal(m.findings.length, 0);
  assert.equal(m.forecast, null);
});

test("cohérence : réseau en erreur / maintenance / sans site, VLAN non défini, VLAN inutilisé", () => {
  const db = emptyDb();
  const site = createSite({ name: "S" }, db);
  createVlan({ number: 10, name: "def", siteId: site.id }, db);
  createVlan({ number: 99, name: "orphelin", siteId: site.id }, db);
  const a = createNetwork({ cidr: "10.1.0.0/24", name: "A", siteId: site.id, vlan: 10 }, db); // VLAN défini : rien
  createNetwork({ cidr: "10.1.1.0/24", name: "B", siteId: site.id, vlan: 20 }, db); // VLAN 20 non défini
  createNetwork({ cidr: "10.1.2.0/24", name: "C", siteId: site.id, status: "error" }, db);
  createNetwork({ cidr: "10.1.3.0/24", name: "D", siteId: site.id, status: "maintenance" }, db);
  createNetwork({ cidr: "10.1.4.0/24", name: "E" }, db); // sans site
  void a;
  const m = getMonitoring(db);
  const by = (k: string) => m.findings.filter((f) => f.kind === k);
  assert.equal(by("vlanUndefined").length, 1);
  assert.equal(by("vlanUndefined")[0].params.vlan, 20);
  assert.deepEqual(by("vlanUnused").map((f) => f.params.vlan), [99]);
  assert.equal(by("networkError")[0].severity, "critical");
  assert.equal(by("networkMaintenance")[0].severity, "info");
  assert.equal(by("networkNoSite").length, 1);
  assert.deepEqual(m.counts, { critical: 1, warning: 1, info: 3 });
  // critique d'abord, information en dernier
  assert.deepEqual(m.findings.map((f) => f.severity), ["critical", "warning", "info", "info", "info"]);
});

test("VLAN identifié par (site, numéro) : le même numéro sur un autre site ne compte pas comme défini", () => {
  const db = emptyDb();
  const s1 = createSite({ name: "S1" }, db);
  const s2 = createSite({ name: "S2" }, db);
  createVlan({ number: 10, name: "v", siteId: s1.id }, db);
  createNetwork({ cidr: "10.2.0.0/24", name: "sur S2", siteId: s2.id, vlan: 10 }, db);
  assert.ok(kinds(db).includes("vlanUndefined"));
});

test("noms d'hôte en double : même VRF seulement, casse ignorée", () => {
  const db = emptyDb();
  const n1 = createNetwork({ cidr: "10.3.0.0/24", name: "n1" }, db);
  const n2 = createNetwork({ cidr: "10.3.1.0/24", name: "n2" }, db);
  allocateAddress(n1.id, { address: "10.3.0.10", hostname: "Serveur-A" }, db);
  allocateAddress(n2.id, { address: "10.3.1.10", hostname: "serveur-a" }, db);
  allocateAddress(n2.id, { address: "10.3.1.11", hostname: "unique" }, db);
  const dup = getMonitoring(db).findings.filter((f) => f.kind === "duplicateHostname");
  assert.equal(dup.length, 1);
  assert.equal(dup[0].params.hostname, "serveur-a");
  assert.equal(dup[0].params.n, 2);
  assert.match(String(dup[0].params.addresses), /10\.3\.0\.10/);
  // dans deux VRF différentes, le même nom est légitime
  const vrf = createVrf({ name: "A" }, db);
  updateNetwork(n2.id, { vrfId: vrf.id }, db);
  assert.equal(getMonitoring(db).findings.filter((f) => f.kind === "duplicateHostname").length, 0);
});

test("adresse statique dans une plage DHCP active : signalée ; plage désactivée ou adresse hors plage : non", () => {
  const db = emptyDb();
  const net = createNetwork({ cidr: "10.4.0.0/24", name: "n" }, db);
  const scope = createScope({ networkId: net.id, name: "P", rangeStart: "10.4.0.100", rangeEnd: "10.4.0.200" }, db);
  allocateAddress(net.id, { address: "10.4.0.1", hostname: "gw" }, db); // hors plage
  allocateAddress(net.id, { address: "10.4.0.150", hostname: "statique" }, db); // dans la plage
  allocateAddress(net.id, { address: "10.4.0.9", hostname: "x" }, db);
  let f = getMonitoring(db).findings.filter((x) => x.kind === "staticInDhcpPool");
  assert.deepEqual(f.map((x) => x.params.address), ["10.4.0.150"]);
  assert.equal(f[0].href, `/dhcp/${scope.id}`);
  db.prepare("UPDATE dhcp_scopes SET enabled = 0").run();
  f = getMonitoring(db).findings.filter((x) => x.kind === "staticInDhcpPool");
  assert.equal(f.length, 0);
});

test("prévision : régression linéaire, jours avant saturation, pas assez de données, tendance plate ou baissière", () => {
  const day = (i: number) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
  const series = (f: (i: number) => number, n = 30) => Array.from({ length: n }, (_, i) => ({ day: day(i), ipv4: f(i) }));
  const up = forecastFromHistory(series((i) => 40 + i)); // +1 point/jour, 69 % à la fin
  assert.ok(up);
  assert.equal(up!.trend, "rising");
  assert.ok(Math.abs(up!.slopePerDay - 1) < 1e-9);
  assert.equal(up!.currentPct, 69);
  assert.equal(up!.daysToFull, 31);
  assert.equal(forecastFromHistory(series((i) => 50))!.trend, "flat");
  assert.equal(forecastFromHistory(series((i) => 50))!.daysToFull, null);
  const down = forecastFromHistory(series((i) => 80 - i));
  assert.equal(down!.trend, "falling");
  assert.equal(down!.daysToFull, null);
  assert.equal(forecastFromHistory(series((i) => 40 + i, 6)), null, "6 relevés : insuffisant");
  assert.equal(forecastFromHistory([]), null);
  // déjà saturé
  assert.equal(forecastFromHistory(series((i) => 100))!.daysToFull, 0);
  // croissance très lente : au-delà de 10 ans = pas de saturation prévisible
  assert.equal(forecastFromHistory(series((i) => 10 + i * 0.02))!.daysToFull, null);
  // relevés non triés ou avec trous : triés et pente calculée sur les vraies dates
  const gaps = [0, 2, 4, 6, 8, 10, 12].map((i) => ({ day: day(i), ipv4: 20 + i * 2 })).reverse();
  assert.ok(Math.abs(forecastFromHistory(gaps)!.slopePerDay - 2) < 1e-9);
});

test("prévision : lue depuis usage_history du projet actif", () => {
  const db = emptyDb();
  const pid = getActiveProject(db).id;
  const ins = db.prepare("INSERT INTO usage_history (project_id, day, ipv4, ipv6, active) VALUES (?, ?, ?, 0, 0)");
  for (let i = 0; i < 10; i++) ins.run(pid, new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), 50 + i * 2);
  const f = getMonitoring(db).forecast!;
  assert.equal(f.points, 10);
  assert.equal(f.trend, "rising");
  assert.equal(f.daysToFull, Math.ceil((100 - 68) / 2));
});

test("sonde : cibles = adresses inventoriées, limitées, 404 hors projet, 422 si aucune adresse", () => {
  const db = emptyDb();
  const n = createNetwork({ cidr: "10.9.0.0/16", name: "grand" }, db);
  assert.equal(code(() => getProbeTargets(n.id, db)), "noAddressToProbe");
  for (let i = 1; i <= 70; i++) allocateAddress(n.id, { address: `10.9.0.${i}`, hostname: i === 3 ? "h3" : undefined }, db);
  const t = getProbeTargets(n.id, db);
  assert.equal(t.total, 70);
  assert.equal(t.targets.length, 64);
  assert.deepEqual(t.targets.slice(0, 3).map((x) => x.address), ["10.9.0.1", "10.9.0.2", "10.9.0.3"]);
  assert.equal(t.targets[2].hostname, "h3");
  assert.equal(code(() => getProbeTargets(999999, db)), "networkNotFound");
  // un réseau d'un autre projet n'est pas testable
  const other = createProject({ name: "Autre" }, db);
  activateProject(other.id, db);
  assert.equal(code(() => getProbeTargets(n.id, db)), "networkNotFound");
  void listNetworks;
});
