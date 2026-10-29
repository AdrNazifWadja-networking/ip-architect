import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { createNetwork, listNetworks } from "./queries";
import { createVrf } from "./vrf";
import { applyPlan, createPlan, deletePlan, getPlan, listPlans, updatePlan } from "./planning";
import { simulateFit, simulateFree, simulateMerge, simulateSplit } from "./simulator";
import { activateProject, createProject } from "./projects";
import { cidrOverlap } from "../ip/cidr";
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
const site = (db: Db) => (db.prepare("SELECT id FROM sites ORDER BY id LIMIT 1").get() as { id: number }).id;

test("plans : création, validations, liste, détail", () => {
  const db = freshDb();
  const sid = site(db);
  const p = createPlan(
    {
      name: "  Agence Kpalimé ",
      parentCidr: "10.200.0.5/16",
      description: "  ",
      items: [
        { name: "Utilisateurs", hosts: 200, siteId: sid, vlan: 10 },
        { name: "Serveurs", hosts: 50 },
        { name: "Lien WAN", prefix: 30 },
      ],
    },
    db,
  );
  assert.equal(p.name, "Agence Kpalimé");
  assert.equal(p.parentCidr, "10.200.0.0/16", "CIDR normalisé");
  assert.equal(p.description, null);
  assert.equal(p.status, "draft");
  assert.deepEqual(p.items.map((i) => i.position), [1, 2, 3]);
  assert.equal(p.items[0].siteName !== null, true);
  assert.equal(listPlans(db).length, 1);
  assert.equal(listPlans(db)[0].itemCount, 3);

  assert.equal(code(() => createPlan({ name: "", parentCidr: "10.0.0.0/8" }, db)), "nameRequired");
  assert.equal(code(() => createPlan({ name: "x", parentCidr: "nimporte" }, db)), "invalidCidr");
  assert.equal(code(() => createPlan({ name: "x", parentCidr: "10.0.0.0/8", vrfId: 9999 }, db)), "vrfNotFound");
  const bad = (item: object) => code(() => createPlan({ name: "x", parentCidr: "10.0.0.0/16", items: [item as never] }, db));
  assert.equal(bad({ name: "a" }), "planItemSize");
  assert.equal(bad({ name: "a", hosts: 5, prefix: 24 }), "planItemSize");
  assert.equal(bad({ name: "a", hosts: 0 }), "planHostsInvalid");
  assert.equal(bad({ name: "a", hosts: 2.5 }), "planHostsInvalid");
  assert.equal(bad({ name: "a", prefix: 8 }), "planPrefixInvalid", "plus grand que le bloc");
  assert.equal(bad({ name: "a", prefix: 40 }), "planPrefixInvalid");
  assert.equal(bad({ name: "a", hosts: 5, vlan: 5000 }), "invalidVlan");
  assert.equal(bad({ name: "a", hosts: 5, siteId: 99999 }), "siteNotFound");
  assert.equal(bad({ name: "", hosts: 5 }), "nameRequired");
  assert.equal(code(() => createPlan({ name: "x", parentCidr: "2001:db8::/48", items: [{ name: "a", hosts: 10 }] }, db)), "planHostsV6");
  assert.equal(code(() => getPlan(9999, db)), "planNotFound");
  assert.equal(listPlans(db).length, 1, "aucune création partielle après une erreur");
});

test("plans : modification d'un brouillon (items remplacés), rien d'écrit en cas d'erreur", () => {
  const db = freshDb();
  const p = createPlan({ name: "P", parentCidr: "10.200.0.0/16", items: [{ name: "a", hosts: 10 }] }, db);
  const q = updatePlan(p.id, { name: "P2", items: [{ name: "b", hosts: 20 }, { name: "c", prefix: 28 }] }, db);
  assert.equal(q.name, "P2");
  assert.deepEqual(q.items.map((i) => i.name), ["b", "c"]);
  assert.equal(code(() => updatePlan(p.id, { items: [{ name: "z", hosts: -1 }] }, db)), "planHostsInvalid");
  assert.deepEqual(getPlan(p.id, db).items.map((i) => i.name), ["b", "c"], "inchangé");
  assert.equal(code(() => updatePlan(p.id, {}, db)), "invalidBody");
  // déplacer le bloc vers un parent trop petit pour un préfixe existant
  assert.equal(code(() => updatePlan(p.id, { parentCidr: "10.200.0.0/29" }, db)), "planPrefixInvalid");
  const r = updatePlan(p.id, { description: "  note  ", parentCidr: "10.201.0.0/16" }, db);
  assert.equal(r.description, "note");
  assert.equal(r.parentCidr, "10.201.0.0/16");
});

test("plans : le bloc exclut les réseaux existants de la même VRF seulement", () => {
  const db = freshDb();
  createNetwork({ cidr: "10.210.0.0/24", name: "Existant" }, db);
  const vrf = createVrf({ name: "TEST-VRF" }, db);
  const g = createPlan({ name: "G", parentCidr: "10.210.0.0/16" }, db);
  assert.deepEqual(g.taken, ["10.210.0.0/24"]);
  const v = createPlan({ name: "V", parentCidr: "10.210.0.0/16", vrfId: vrf.id }, db);
  assert.deepEqual(v.taken, []);
});

test("plans : appliquer crée les réseaux aux emplacements calculés, fige le plan, tout ou rien", () => {
  const db = freshDb();
  const sid = site(db);
  createNetwork({ cidr: "10.220.0.0/24", name: "Déjà là" }, db);
  const p = createPlan(
    {
      name: "Appli",
      parentCidr: "10.220.0.0/23",
      items: [
        { name: "Petit", hosts: 10, vlan: 30 },
        { name: "Grand", hosts: 100, siteId: sid },
      ],
    },
    db,
  );
  const before = listNetworks({}, db).length;
  const done = applyPlan(p.id, {}, db);
  assert.equal(done.status, "applied");
  assert.deepEqual(done.items.map((i) => i.appliedCidr), ["10.220.1.128/28", "10.220.1.0/25"]);
  const nets = listNetworks({}, db);
  assert.equal(nets.length, before + 2);
  const grand = nets.find((n) => n.name === "Grand")!;
  assert.equal(grand.cidr, "10.220.1.0/25");
  assert.equal(grand.status, "inactive", "statut par défaut : non encore déployé");
  assert.equal(nets.find((n) => n.name === "Petit")!.vlan, 30);

  // figé
  assert.equal(code(() => applyPlan(p.id, {}, db)), "planLocked");
  assert.equal(code(() => updatePlan(p.id, { items: [] }, db)), "planLocked");
  assert.equal(updatePlan(p.id, { name: "Renommé" }, db).name, "Renommé", "le nom reste modifiable");

  // plus de place : rien n'est créé
  const q = createPlan({ name: "Trop", parentCidr: "10.220.0.0/24", items: [{ name: "x", hosts: 10 }] }, db);
  const n1 = listNetworks({}, db).length;
  assert.equal(code(() => applyPlan(q.id, {}, db)), "planCannotApply");
  assert.equal(listNetworks({}, db).length, n1);
  assert.equal(getPlan(q.id, db).status, "draft");
  const empty = createPlan({ name: "Vide", parentCidr: "10.230.0.0/24" }, db);
  assert.equal(code(() => applyPlan(empty.id, {}, db)), "planNoItems");
  assert.equal(code(() => applyPlan(empty.id, { status: "zzz" as never }, db)), "planNoItems", "le vide est testé d'abord");
  const ok = createPlan({ name: "Actif", parentCidr: "10.231.0.0/24", items: [{ name: "act", hosts: 5 }] }, db);
  assert.equal(code(() => applyPlan(ok.id, { status: "zzz" as never }, db)), "invalidStatus");
  applyPlan(ok.id, { status: "active" }, db);
  assert.equal(listNetworks({}, db).find((n) => n.name === "act")!.status, "active");
});

test("plans : tout ou rien aussi si createNetwork échoue en cours de route (annulation complète)", () => {
  const db = freshDb();
  const p = createPlan({ name: "T", parentCidr: "10.240.0.0/24", items: [{ name: "a", hosts: 10 }, { name: "b", hosts: 10 }] }, db);
  // un réseau apparaît entre-temps dans la même plage : l'allocation recalculée l'évite, donc on force l'échec autrement
  db.prepare("UPDATE plan_items SET vlan = 5000 WHERE plan_id = ? AND position = 2").run(p.id);
  const n0 = listNetworks({}, db).length;
  assert.equal(code(() => applyPlan(p.id, {}, db)), "invalidVlan");
  assert.equal(listNetworks({}, db).length, n0, "le premier réseau n'est pas resté créé");
  assert.equal(getPlan(p.id, db).status, "draft");
});

test("plans : suppression (les réseaux créés restent), isolement par projet", () => {
  const db = freshDb();
  const p = createPlan({ name: "S", parentCidr: "10.250.0.0/24", items: [{ name: "keep", hosts: 5 }] }, db);
  applyPlan(p.id, {}, db);
  deletePlan(p.id, db);
  assert.equal(listPlans(db).length, 0);
  assert.ok(listNetworks({}, db).some((n) => n.name === "keep"));
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM plan_items").get() as { c: number }).c, 0, "items supprimés en cascade");
  const mine = createPlan({ name: "Mien", parentCidr: "10.251.0.0/24" }, db);
  const other = createProject({ name: "Autre" }, db);
  activateProject(other.id, db);
  assert.equal(listPlans(db).length, 0);
  assert.equal(code(() => getPlan(mine.id, db)), "planNotFound");
  assert.equal(code(() => deletePlan(mine.id, db)), "planNotFound");
});

test("simulateur split : enfants, adresses inventoriées, plages DHCP à cheval, conflits", () => {
  const db = freshDb();
  const net = createNetwork({ cidr: "10.60.0.0/24", name: "À découper" }, db);
  const ins = (a: string) => db.prepare("INSERT INTO ip_addresses (network_id, address, status, created_at) VALUES (?, ?, 'used', ?)").run(net.id, a, new Date().toISOString());
  ["10.60.0.10", "10.60.0.20", "10.60.0.200"].forEach(ins);
  db.prepare("INSERT INTO dhcp_scopes (network_id, name, range_start, range_end, dns, lease_seconds, enabled, created_at) VALUES (?, 'Étendue', '10.60.0.100', '10.60.0.140', '', 3600, 1, ?)").run(net.id, new Date().toISOString());
  const r = simulateSplit({ networkId: net.id, newPrefix: 26 }, db);
  assert.equal(r.count, "4");
  assert.deepEqual(r.children.map((c) => c.cidr), ["10.60.0.0/26", "10.60.0.64/26", "10.60.0.128/26", "10.60.0.192/26"]);
  assert.deepEqual(r.children.map((c) => c.inventoried), [2, 0, 0, 1]);
  assert.equal(r.usablePerChild, "62");
  assert.equal(r.spanningScopes.length, 1, "la plage .100-.140 est à cheval sur .64/26 et .128/26");
  assert.equal(r.existing!.id, net.id);
  // découpage d'un CIDR saisi : pas d'adresses, mais les conflits sont détectés (même VRF)
  const free = simulateSplit({ cidr: "10.60.0.0/23", newPrefix: 24 }, db);
  assert.equal(free.children[0].conflicts.length, 1);
  assert.equal(free.existing, null);
  // limites
  assert.equal(simulateSplit({ cidr: "10.0.0.0/8", newPrefix: 24 }, db).truncated, true);
  assert.equal(simulateSplit({ cidr: "10.0.0.0/8", newPrefix: 24 }, db).children.length, 256);
  assert.equal(code(() => simulateSplit({ cidr: "10.0.0.0/24", newPrefix: 24 }, db)), "simInvalid");
  assert.equal(code(() => simulateSplit({ cidr: "10.0.0.0/24", newPrefix: 33 }, db)), "simInvalid");
  assert.equal(code(() => simulateSplit({ cidr: "zzz", newPrefix: 26 }, db)), "invalidCidr");
  assert.equal(code(() => simulateSplit({ networkId: 99999, newPrefix: 26 }, db)), "networkNotFound");
});

test("simulateur merge : résumé exact, supernet, espace ajouté, intrus", () => {
  const db = freshDb();
  const exact = simulateMerge({ cidrs: ["10.70.0.0/25", "10.70.0.128/25"] }, db);
  assert.deepEqual(exact.summary, ["10.70.0.0/24"]);
  assert.equal(exact.exact, true);
  assert.equal(exact.supernet, "10.70.0.0/24");
  assert.equal(exact.extraAddresses, "0");

  createNetwork({ cidr: "10.71.1.0/24", name: "Voisin" }, db);
  const gap = simulateMerge({ cidrs: ["10.71.0.0/24", "10.71.3.0/24"] }, db);
  assert.equal(gap.exact, false);
  assert.equal(gap.supernet, "10.71.0.0/22");
  assert.equal(gap.extraAddresses, "512", "deux /24 absents du résumé");
  assert.deepEqual(gap.intruders.map((n) => n.cidr), ["10.71.1.0/24"]);

  const a = createNetwork({ cidr: "10.72.0.0/24", name: "A" }, db);
  const b = createNetwork({ cidr: "10.72.1.0/24", name: "B" }, db);
  const byId = simulateMerge({ networkIds: [a.id, b.id] }, db);
  assert.deepEqual(byId.summary, ["10.72.0.0/23"]);
  assert.equal(byId.intruders.length, 0);
  assert.equal(code(() => simulateMerge({ cidrs: [] }, db)), "simInvalid");
  assert.equal(code(() => simulateMerge({}, db)), "simInvalid");
  assert.equal(code(() => simulateMerge({ networkIds: [99999] }, db)), "networkNotFound");
  assert.equal(code(() => simulateMerge({ cidrs: Array.from({ length: 201 }, (_, i) => `10.${i}.0.0/24`) }, db)), "simTooMany");
  assert.equal(simulateMerge({ cidrs: ["10.0.0.0/24", "2001:db8::/64"] }, db).supernet, null, "versions mélangées");
});

test("simulateur free : espace libre, premier emplacement, VRF séparées", () => {
  const db = freshDb();
  createNetwork({ cidr: "10.80.0.0/25", name: "Bas" }, db);
  createNetwork({ cidr: "10.80.0.192/26", name: "Haut" }, db);
  const r = simulateFree({ parent: "10.80.0.0/24", prefix: 26 }, db);
  assert.deepEqual(r.blocks.map((b) => b.cidr), ["10.80.0.128/26"]);
  assert.equal(r.freeAddresses, "64");
  assert.equal(r.totalAddresses, "256");
  assert.equal(r.firstFit, "10.80.0.128/26");
  assert.equal(simulateFree({ parent: "10.80.0.0/24", prefix: 25 }, db).firstFit, null);
  const vrf = createVrf({ name: "ISOLEE" }, db);
  const other = simulateFree({ parent: "10.80.0.0/24", vrfId: vrf.id }, db);
  assert.equal(other.freeAddresses, "256", "autre VRF : tout est libre");
  assert.equal(code(() => simulateFree({ parent: "10.80.0.0/24", prefix: 16 }, db)), "simInvalid");
  assert.equal(code(() => simulateFree({ parent: "10.80.0.0/24", vrfId: 9999 }, db)), "vrfNotFound");
  assert.equal(simulateFree({ parent: "2001:db8::/48", prefix: 64 }, db).firstFit, "2001:db8::/64");
});

test("simulateur fit : conflits (même VRF), information (autre VRF), suggestion", () => {
  const db = freshDb();
  const vrf = createVrf({ name: "AUTRE" }, db);
  createNetwork({ cidr: "10.90.0.0/24", name: "Global" }, db);
  createNetwork({ cidr: "10.90.1.0/24", name: "Dans VRF", vrfId: vrf.id }, db);
  const a = simulateFit({ cidr: "10.90.0.0/25" }, db);
  assert.equal(a.canCreate, false);
  assert.deepEqual(a.conflicts.map((c) => [c.cidr, c.relation]), [["10.90.0.0/24", "contains"]]);
  assert.deepEqual(a.otherVrf, []);
  const b = simulateFit({ cidr: "10.90.0.0/23" }, db);
  assert.deepEqual(b.conflicts.map((c) => c.relation), ["inside"]);
  assert.deepEqual(b.otherVrf.map((c) => c.cidr), ["10.90.1.0/24"]);
  assert.equal(b.suggestion, null, "aucun bloc libre de même taille dans le voisinage");
  const same = simulateFit({ cidr: "10.90.0.0/24" }, db);
  assert.equal(same.conflicts[0].relation, "same");
  const free = simulateFit({ cidr: "10.99.0.0/24" }, db);
  assert.equal(free.canCreate, true);
  assert.deepEqual(free.conflicts, []);
  const inVrf = simulateFit({ cidr: "10.90.0.0/24", vrfId: vrf.id }, db);
  assert.equal(inVrf.canCreate, true, "la même adresse est libre dans la VRF AUTRE");
  assert.equal(inVrf.otherVrf.length, 1);
  assert.equal(code(() => simulateFit({ cidr: "x" }, db)), "invalidCidr");
});

test("simulateur : lecture seule (aucune écriture en base)", () => {
  const db = freshDb();
  const count = () => JSON.stringify(["networks", "ip_addresses", "dhcp_scopes", "plans", "settings"].map((t) => (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c));
  const before = count();
  simulateSplit({ cidr: "10.0.0.0/16", newPrefix: 24 }, db);
  simulateMerge({ cidrs: ["10.0.0.0/24", "10.0.1.0/24"] }, db);
  simulateFree({ parent: "10.0.0.0/8", prefix: 16 }, db);
  simulateFit({ cidr: "10.1.10.0/24" }, db);
  assert.equal(count(), before);
});

test("plans : l'allocation recalcule les réseaux créés par un autre moyen (pas de chevauchement garanti)", () => {
  const db = freshDb();
  const p = createPlan({ name: "R", parentCidr: "10.150.0.0/24", items: [{ name: "a", hosts: 100 }, { name: "b", hosts: 50 }, { name: "c", hosts: 20 }] }, db);
  createNetwork({ cidr: "10.150.0.0/27", name: "Bloque le début" }, db);
  applyPlan(p.id, {}, db);
  const nets = listNetworks({}, db).filter((n) => n.cidr.startsWith("10.150."));
  for (let i = 0; i < nets.length; i++) for (let j = i + 1; j < nets.length; j++) assert.ok(!cidrOverlap(nets[i].cidr, nets[j].cidr), `${nets[i].cidr} / ${nets[j].cidr}`);
});
