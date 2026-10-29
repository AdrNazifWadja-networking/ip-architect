import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { getActiveProject, listNetworks, listSites } from "./queries";
import { allocateAddress, getNetwork, listAddresses, listVlans } from "./ipam";
import { createReservation, createScope, getScope, listReservations } from "./dhcp";
import { createVrf, getVrf } from "./vrf";
import {
  updateAddress,
  updateNetwork,
  updateReservation,
  updateScope,
  updateVlan,
  updateVrf,
} from "./edit";
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

function newNetwork(db: Db, cidr: string, used = 0, reserved = 0, capacity = 254, vrfId: number | null = null): number {
  const project = getActiveProject(db);
  const res = db
    .prepare(
      `INSERT INTO networks (project_id, site_id, cidr, version, name, vlan, vrf_id, status, used_ips, reserved_ips, capacity, created_at)
       VALUES (?, NULL, ?, ?, 'test', NULL, ?, 'active', ?, ?, ?, ?)`,
    )
    .run(project.id, cidr, cidr.includes(":") ? 6 : 4, vrfId, used, reserved, capacity, new Date().toISOString());
  return Number(res.lastInsertRowid);
}

/* --------------------------------- Réseaux -------------------------------- */

test("updateNetwork : un champ absent reste inchangé, null efface", () => {
  const db = freshDb();
  const site = listSites(db)[0];
  const id = newNetwork(db, "10.50.0.0/24", 5, 3);
  const a = updateNetwork(id, { name: "  Nouveau nom ", siteId: site.id, vlan: 99, status: "maintenance" }, db);
  assert.deepEqual([a.name, a.siteId, a.vlan, a.status], ["Nouveau nom", site.id, 99, "maintenance"]);
  assert.deepEqual([a.usedIps, a.reservedIps, a.cidr], [5, 3, "10.50.0.0/24"]);
  const b = updateNetwork(id, { siteId: null, vlan: null }, db);
  assert.deepEqual([b.siteId, b.vlan, b.name], [null, null, "Nouveau nom"]);
});

test("updateNetwork : refus des entrées invalides, rien n'est écrit", () => {
  const db = freshDb();
  const id = newNetwork(db, "10.50.0.0/24", 5, 3);
  const before = JSON.stringify(getNetwork(id, db));
  const c = (input: object) => code(() => updateNetwork(id, input, db));
  assert.equal(c({}), "invalidBody");
  assert.equal(c({ name: " " }), "nameRequired");
  assert.equal(c({ name: "x".repeat(81) }), "nameTooLong");
  assert.equal(c({ siteId: 99999 }), "siteNotFound");
  assert.equal(c({ vlan: 0 }), "invalidVlan");
  assert.equal(c({ vlan: 4095 }), "invalidVlan");
  assert.equal(c({ status: "cassé" }), "invalidStatus");
  assert.equal(c({ usedIps: -1 }), "invalidCounters");
  assert.equal(c({ usedIps: 1.5 }), "invalidCounters");
  assert.equal(c({ usedIps: 200, reservedIps: 100 }), "tooManyAddresses");
  assert.equal(c({ vrfId: 99999 }), "vrfNotFound");
  // une erreur sur un champ n'empêche pas… mais n'applique pas non plus les autres champs valides
  assert.equal(c({ name: "valide", vlan: 0 }), "invalidVlan");
  assert.equal(JSON.stringify(getNetwork(id, db)), before);
  assert.equal(code(() => updateNetwork(99999, { name: "x" }, db)), "networkNotFound");
});

test("updateNetwork : compteurs jamais sous l'inventaire IPAM", () => {
  const db = freshDb();
  const id = newNetwork(db, "10.50.0.0/24", 2, 1);
  allocateAddress(id, { address: "10.50.0.10" }, db); // used (compteur 3)
  allocateAddress(id, { address: "10.50.0.11" }, db); // used (compteur 4)
  allocateAddress(id, { address: "10.50.0.12", status: "reserved" }, db); // reserved (compteur 2)
  const n = getNetwork(id, db);
  assert.deepEqual([n.usedIps, n.reservedIps], [4, 2]);
  assert.equal(code(() => updateNetwork(id, { usedIps: 1 }, db)), "countersBelowInventory");
  assert.equal(code(() => updateNetwork(id, { reservedIps: 0 }, db)), "countersBelowInventory");
  assert.equal(updateNetwork(id, { usedIps: 2, reservedIps: 1 }, db).usedIps, 2);
  assert.equal(code(() => updateNetwork(id, { usedIps: 1 }, db)), "countersBelowInventory");
});

test("updateNetwork : changer de VRF contrôle le chevauchement à destination", () => {
  const db = freshDb();
  const lab = createVrf({ name: "LAB" }, db).id;
  const a = newNetwork(db, "10.60.0.0/24");
  const b = newNetwork(db, "10.60.0.0/24", 0, 0, 254, lab); // même CIDR, autre VRF : autorisé
  assert.equal(code(() => updateNetwork(b, { vrfId: null }, db)), "overlap");
  assert.equal(getNetwork(b, db).vrfId, lab);
  assert.equal(code(() => updateNetwork(a, { vrfId: lab }, db)), "overlap");
  assert.equal(getNetwork(a, db).vrfId, null);
  // déplacement valide, et combiné avec d'autres champs dans la même requête
  const other = createVrf({ name: "OTHER" }, db).id;
  const moved = updateNetwork(a, { vrfId: other, name: "déplacé" }, db);
  assert.deepEqual([moved.vrfId, moved.name], [other, "déplacé"]);
  // un déplacement refusé n'applique pas non plus les autres champs
  assert.equal(code(() => updateNetwork(b, { vrfId: other, name: "ne doit pas passer" }, db)), "overlap");
  assert.equal(getNetwork(b, db).name, "test");
});

/* ---------------------------------- VLANs --------------------------------- */

test("updateVlan : renommer, puis changer numéro et site tant qu'aucun réseau ne l'utilise", () => {
  const db = freshDb();
  const sites = listSites(db);
  const free = listVlans({}, db).find((v) => v.networkCount === 0) ?? (() => {
    const project = getActiveProject(db);
    db.prepare("INSERT INTO vlans (project_id, site_id, number, name, created_at) VALUES (?, ?, 777, 'libre', ?)").run(
      project.id,
      sites[0].id,
      new Date().toISOString(),
    );
    return listVlans({}, db).find((v) => v.number === 777)!;
  })();

  assert.equal(updateVlan(free.id, { name: "  Renommé " }, db).name, "Renommé");
  const moved = updateVlan(free.id, { number: 778, siteId: sites[1].id }, db);
  assert.deepEqual([moved.number, moved.siteId, moved.name], [778, sites[1].id, "Renommé"]);
  assert.equal(updateVlan(free.id, { siteId: null }, db).siteId, null);
  assert.equal(code(() => updateVlan(free.id, { number: 0 }, db)), "invalidVlan");
  assert.equal(code(() => updateVlan(free.id, { name: "" }, db)), "nameRequired");
  assert.equal(code(() => updateVlan(free.id, { siteId: 99999 }, db)), "siteNotFound");
  assert.equal(code(() => updateVlan(free.id, {}, db)), "invalidBody");
  assert.equal(code(() => updateVlan(99999, { name: "x" }, db)), "vlanNotFound");
});

test("updateVlan : un VLAN utilisé par des réseaux n'est que renommable ; unicité par site", () => {
  const db = freshDb();
  const used = listVlans({}, db).find((v) => v.networkCount > 0)!;
  assert.equal(updateVlan(used.id, { name: "Nouveau nom" }, db).name, "Nouveau nom");
  assert.equal(updateVlan(used.id, { number: used.number }, db).number, used.number, "même numéro = pas un changement");
  assert.equal(code(() => updateVlan(used.id, { number: used.number + 1 }, db)), "vlanLocked");
  assert.equal(code(() => updateVlan(used.id, { siteId: null }, db)), "vlanLocked");
  // même site : renommer vers un numéro déjà pris est refusé
  const sameSite = listVlans({}, db).filter((v) => v.siteId === used.siteId && v.id !== used.id && v.networkCount === 0);
  const project = getActiveProject(db);
  db.prepare("INSERT INTO vlans (project_id, site_id, number, name, created_at) VALUES (?, ?, 900, 'a', ?)").run(project.id, used.siteId, "x");
  const a = listVlans({}, db).find((v) => v.number === 900)!;
  assert.equal(code(() => updateVlan(a.id, { number: used.number }, db)), "vlanExists");
  void sameSite;
});

/* ------------------------------ Plages DHCP ------------------------------- */

function scopeFixture(db: Db) {
  const net = newNetwork(db, "10.50.0.0/24");
  const s = createScope({ networkId: net, name: "A", rangeStart: "10.50.0.100", rangeEnd: "10.50.0.150", gateway: "10.50.0.1", dns: "1.1.1.1", leaseSeconds: 3600 }, db);
  return { net, s };
}

test("updateScope : modifications partielles, effacement du DNS et de la passerelle", () => {
  const db = freshDb();
  const { s } = scopeFixture(db);
  const a = updateScope(s.id, { name: " Wifi ", leaseSeconds: 7200, enabled: false }, db);
  assert.deepEqual([a.name, a.leaseSeconds, a.enabled, a.rangeStart, a.rangeEnd, a.gateway], ["Wifi", 7200, false, "10.50.0.100", "10.50.0.150", "10.50.0.1"]);
  assert.deepEqual(a.dns, ["1.1.1.1"]);
  const b = updateScope(s.id, { rangeStart: "10.50.0.110", rangeEnd: "10.50.0.200", dns: "9.9.9.9, 8.8.8.8", gateway: null }, db);
  assert.deepEqual([b.rangeStart, b.rangeEnd, b.gateway, b.poolSize], ["10.50.0.110", "10.50.0.200", null, 91]);
  assert.deepEqual(b.dns, ["9.9.9.9", "8.8.8.8"]);
  assert.deepEqual(updateScope(s.id, { dns: "" }, db).dns, []);
});

test("updateScope : mêmes refus qu'à la création, et la plage elle-même n'est pas un chevauchement", () => {
  const db = freshDb();
  const { net, s } = scopeFixture(db);
  createScope({ networkId: net, name: "B", rangeStart: "10.50.0.200", rangeEnd: "10.50.0.220" }, db);
  const c = (input: object) => code(() => updateScope(s.id, input, db));
  assert.equal(c({ rangeEnd: "10.50.0.200" }), "scopeOverlap");
  assert.equal(c({ rangeEnd: "10.50.0.199" }), null, "adjacent à B : autorisé");
  assert.equal(c({ rangeStart: "10.50.0.99", rangeEnd: "10.50.0.140" }), null, "s'agrandir sur soi-même : autorisé");
  assert.equal(c({ name: "b" }), "scopeNameTaken");
  assert.equal(c({ name: "A" }), null, "garder son propre nom");
  assert.equal(c({ rangeStart: "10.50.0.190" }), "invalidRange");
  assert.equal(c({ rangeStart: "10.51.0.1" }), "addressOutsideNetwork");
  assert.equal(c({ rangeEnd: "10.50.0.255" }), "addressNotAssignable");
  assert.equal(c({ gateway: "pas-une-ip" }), "invalidGateway");
  assert.equal(c({ dns: "1.1.1.1 2.2.2.2 3.3.3.3 4.4.4.4 5.5.5.5" }), "tooManyDns");
  assert.equal(c({ dns: "pas-une-ip" }), "invalidDns");
  assert.equal(c({ leaseSeconds: 10 }), "invalidLease");
  assert.equal(c({}), "invalidBody");
  assert.equal(code(() => updateScope(99999, { name: "x" }, db)), "scopeNotFound");
  const before = JSON.stringify(getScope(s.id, db));
  assert.equal(c({ name: "valide", rangeEnd: "10.50.0.230" }), "scopeOverlap");
  assert.equal(JSON.stringify(getScope(s.id, db)), before, "refus = aucune écriture");
});

test("updateReservation : MAC, nom et description ; l'IPAM reste synchronisé", () => {
  const db = freshDb();
  const { net, s } = scopeFixture(db);
  const r1 = createReservation(s.id, { mac: "aa:bb:cc:dd:ee:01", address: "10.50.0.240", hostname: "imprimante" }, db);
  const r2 = createReservation(s.id, { mac: "aa:bb:cc:dd:ee:02", address: "10.50.0.241" }, db);

  const u = updateReservation(s.id, r1.id, { mac: "AA-BB-CC-DD-EE-09", hostname: "  printer  ", description: "RDC" }, db);
  assert.deepEqual([u.mac, u.hostname, u.description, u.address], ["aa:bb:cc:dd:ee:09", "printer", "RDC", "10.50.0.240"]);
  const inv = listAddresses(net, db).find((a) => a.address === "10.50.0.240")!;
  assert.deepEqual([inv.hostname, inv.description, inv.status], ["printer", "RDC", "reserved"]);
  assert.equal(updateReservation(s.id, r1.id, { hostname: null, description: null }, db).hostname, null);
  assert.equal(listAddresses(net, db).find((a) => a.address === "10.50.0.240")!.hostname, null);

  assert.equal(code(() => updateReservation(s.id, r1.id, { mac: "zz" }, db)), "invalidMac");
  assert.equal(code(() => updateReservation(s.id, r1.id, { mac: "aa:bb:cc:dd:ee:02" }, db)), "macTaken");
  assert.equal(code(() => updateReservation(s.id, r1.id, { mac: "aa:bb:cc:dd:ee:09" }, db)), null, "garder sa propre MAC");
  assert.equal(code(() => updateReservation(s.id, 99999, { hostname: "x" }, db)), "reservationNotFound");
  assert.equal(code(() => updateReservation(99999, r2.id, { hostname: "x" }, db)), "scopeNotFound");
  assert.equal(code(() => updateReservation(s.id, r2.id, {}, db)), "invalidBody");
  assert.equal(listReservations(s.id, db).length, 2);
});

/* ----------------------------------- VRF ---------------------------------- */

test("updateVrf : modifications partielles et refus", () => {
  const db = freshDb();
  const v = createVrf({ name: "LAB", rd: "65000:900", rtImport: "65000:900", rtExport: "65000:900", description: "d" }, db);
  const a = updateVrf(v.id, { name: "LAB2", description: null }, db);
  assert.deepEqual([a.name, a.rd, a.description, a.rtImport], ["LAB2", "65000:900", null, ["65000:900"]]);
  const b = updateVrf(v.id, { rd: "65000:901", rtImport: "65000:1, 65000:2", rtExport: [] }, db);
  assert.deepEqual([b.rd, b.rtImport, b.rtExport], ["65000:901", ["65000:1", "65000:2"], []]);

  const other = createVrf({ name: "OTHER", rd: "65000:555" }, db);
  const c = (input: object) => code(() => updateVrf(v.id, input, db));
  assert.equal(c({ name: "other" }), "vrfNameTaken");
  assert.equal(c({ name: "LAB2" }), null);
  assert.equal(c({ rd: "65000:555" }), "rdTaken");
  assert.equal(c({ rd: "pas-un-rd" }), "invalidRd");
  assert.equal(c({ rtImport: "nope" }), "invalidRt");
  assert.equal(c({ name: "nom invalide" }), "invalidVrfName");
  assert.equal(c({ rd: null }), "rtNeedsRd", "retirer le RD alors que des route targets existent");
  assert.equal(c({ rd: null, rtImport: [], rtExport: [] }), null, "VRF-Lite : RD et route targets retirés ensemble");
  assert.equal(getVrf(v.id, db).rd, null);
  assert.equal(c({}), "invalidBody");
  assert.equal(code(() => updateVrf(99999, { name: "x" }, db)), "vrfNotFound");
  void other;
});

/* --------------------------------- Adresses ------------------------------- */

test("updateAddress : nom, description et type ; les compteurs suivent le changement de type", () => {
  const db = freshDb();
  const id = newNetwork(db, "10.50.0.0/24", 1, 1);
  const a = allocateAddress(id, { address: "10.50.0.10", hostname: "srv" }, db); // used -> 2
  const u = updateAddress(id, a.id, { hostname: " srv-01 ", description: "web" }, db);
  assert.deepEqual([u.hostname, u.description, u.status], ["srv-01", "web", "used"]);
  assert.deepEqual([getNetwork(id, db).usedIps, getNetwork(id, db).reservedIps], [2, 1]);

  const r = updateAddress(id, a.id, { status: "reserved" }, db);
  assert.equal(r.status, "reserved");
  assert.deepEqual([getNetwork(id, db).usedIps, getNetwork(id, db).reservedIps], [1, 2]);
  updateAddress(id, a.id, { status: "used" }, db);
  assert.deepEqual([getNetwork(id, db).usedIps, getNetwork(id, db).reservedIps], [2, 1]);
  updateAddress(id, a.id, { hostname: null }, db);
  assert.equal(listAddresses(id, db)[0].hostname, null);

  assert.equal(code(() => updateAddress(id, a.id, { status: "libre" as never }, db)), "invalidAddressStatus");
  assert.equal(code(() => updateAddress(id, a.id, {}, db)), "invalidBody");
  assert.equal(code(() => updateAddress(id, 99999, { hostname: "x" }, db)), "addressNotFound");
  assert.equal(code(() => updateAddress(99999, a.id, { hostname: "x" }, db)), "networkNotFound");
});

test("updateAddress : une adresse gérée par une réservation DHCP garde son type, nom et description restent synchronisés", () => {
  const db = freshDb();
  const { net, s } = scopeFixture(db);
  const r = createReservation(s.id, { mac: "aa:bb:cc:dd:ee:01", address: "10.50.0.240", hostname: "imprimante" }, db);
  const addr = listAddresses(net, db).find((x) => x.address === "10.50.0.240")!;
  assert.equal(code(() => updateAddress(net, addr.id, { status: "used" }, db)), "addressManagedByDhcp");
  assert.equal(getNetwork(net, db).reservedIps, 1, "refus = compteurs inchangés");
  updateAddress(net, addr.id, { hostname: "printer-2", description: "étage 2" }, db);
  const res = listReservations(s.id, db).find((x) => x.id === r.id)!;
  assert.deepEqual([res.hostname, res.description], ["printer-2", "étage 2"]);
  assert.equal(updateAddress(net, addr.id, { status: "reserved" }, db).status, "reserved", "même type : pas un changement");
});

test("les listes restent cohérentes après modification (smoke)", () => {
  const db = freshDb();
  const total = listNetworks({}, db).length;
  const first = listNetworks({}, db)[0];
  updateNetwork(first.id, { name: "renommé" }, db);
  assert.equal(listNetworks({}, db).length, total);
  assert.equal(listNetworks({ q: "renommé" }, db).length, 1);
});
