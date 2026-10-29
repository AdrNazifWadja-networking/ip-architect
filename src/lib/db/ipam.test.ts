import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { listNetworks } from "./queries";
import {
  allocateAddress,
  createVlan,
  deleteVlan,
  getNetwork,
  listAddresses,
  listVlans,
  releaseAddress,
} from "./ipam";
import { ApiError } from "../types";

/** Base en mémoire, schéma + données de démo : n'affecte jamais le vrai fichier data/ip-architect.db. */
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

/** Un réseau de démo IPv4 sans adresse inventoriée n'existe pas : on en crée un vide, avec des compteurs à 0. */
function emptyNetwork(db: Db, cidr: string, used = 0, reserved = 0, capacity = 254): number {
  const project = db.prepare("SELECT id FROM projects LIMIT 1").get() as { id: number };
  const res = db
    .prepare(
      `INSERT INTO networks (project_id, site_id, cidr, version, name, vlan, status, used_ips, reserved_ips, capacity, created_at)
       VALUES (?, NULL, ?, ?, 'test', NULL, 'active', ?, ?, ?, ?)`,
    )
    .run(project.id, cidr, cidr.includes(":") ? 6 : 4, used, reserved, capacity, new Date().toISOString());
  return Number(res.lastInsertRowid);
}

test("les données de démo respectent l'invariant compteurs ≥ adresses inventoriées", () => {
  const db = freshDb();
  let withAddresses = 0;
  for (const n of listNetworks({}, db)) {
    const list = listAddresses(n.id, db);
    const used = list.filter((a) => a.status === "used").length;
    const reserved = list.filter((a) => a.status === "reserved").length;
    assert.ok(n.usedIps >= used, `${n.cidr}: used_ips ${n.usedIps} < ${used}`);
    assert.ok(n.reservedIps >= reserved, `${n.cidr}: reserved_ips ${n.reservedIps} < ${reserved}`);
    if (list.length > 0) withAddresses++;
  }
  assert.ok(withAddresses > 0, "la démo doit contenir des adresses inventoriées");
});

test("allocation sans adresse : première IP libre, compteur incrémenté", () => {
  const db = freshDb();
  const id = emptyNetwork(db, "172.20.0.0/24");
  const a = allocateAddress(id, { hostname: "  srv-1  " }, db);
  assert.equal(a.address, "172.20.0.1");
  assert.equal(a.hostname, "srv-1"); // espaces retirés
  assert.equal(a.status, "used");
  assert.equal(allocateAddress(id, {}, db).address, "172.20.0.2");
  assert.equal(getNetwork(id, db).usedIps, 2);
});

test("allocation d'une adresse précise, en forme canonique, et réservation", () => {
  const db = freshDb();
  const id = emptyNetwork(db, "2001:db8:99::/64", 0, 0, 1000);
  const a = allocateAddress(id, { address: "2001:0DB8:99:0:0:0:0:00A", status: "reserved" }, db);
  assert.equal(a.address, "2001:db8:99::a");
  assert.equal(getNetwork(id, db).reservedIps, 1);
  assert.equal(getNetwork(id, db).usedIps, 0);
});

test("refus : doublon, hors réseau, adresse réseau/broadcast, adresse invalide, statut invalide", () => {
  const db = freshDb();
  const id = emptyNetwork(db, "172.20.0.0/24");
  allocateAddress(id, { address: "172.20.0.50" }, db);
  assert.equal(code(() => allocateAddress(id, { address: "172.20.0.50" }, db)), "addressTaken");
  assert.equal(code(() => allocateAddress(id, { address: "172.21.0.5" }, db)), "addressOutsideNetwork");
  assert.equal(code(() => allocateAddress(id, { address: "2001:db8::1" }, db)), "addressOutsideNetwork");
  assert.equal(code(() => allocateAddress(id, { address: "172.20.0.0" }, db)), "addressNotAssignable");
  assert.equal(code(() => allocateAddress(id, { address: "172.20.0.255" }, db)), "addressNotAssignable");
  assert.equal(code(() => allocateAddress(id, { address: "pas-une-ip" }, db)), "invalidAddress");
  assert.equal(code(() => allocateAddress(id, { status: "autre" as never }, db)), "invalidAddressStatus");
  assert.equal(code(() => allocateAddress(id, { hostname: "x".repeat(101) }, db)), "textTooLong");
  assert.equal(code(() => allocateAddress(999999, {}, db)), "networkNotFound");
  // un refus ne laisse aucune trace : le compteur n'a bougé que pour l'allocation réussie
  assert.equal(getNetwork(id, db).usedIps, 1);
});

test("réseau plein : refus quand les compteurs atteignent la capacité, ou quand toutes les IP sont prises", () => {
  const db = freshDb();
  const full = emptyNetwork(db, "10.250.0.0/30", 2, 0, 2); // compteurs = capacité
  assert.equal(code(() => allocateAddress(full, {}, db)), "networkFull");

  const tiny = emptyNetwork(db, "10.251.0.0/30", 0, 0, 2);
  allocateAddress(tiny, {}, db);
  allocateAddress(tiny, {}, db);
  assert.equal(code(() => allocateAddress(tiny, {}, db)), "networkFull");
  assert.deepEqual(
    listAddresses(tiny, db).map((a) => a.address),
    ["10.251.0.1", "10.251.0.2"],
  );
});

test("libération : adresse supprimée, compteur décrémenté, puis l'adresse redevient disponible", () => {
  const db = freshDb();
  const id = emptyNetwork(db, "172.20.0.0/24", 5, 0);
  const a = allocateAddress(id, {}, db);
  assert.equal(getNetwork(id, db).usedIps, 6);
  releaseAddress(id, a.id, db);
  assert.equal(getNetwork(id, db).usedIps, 5);
  assert.equal(allocateAddress(id, {}, db).address, a.address);
  assert.equal(code(() => releaseAddress(id, 999999, db)), "addressNotFound");
});

test("libérer l'adresse d'un autre réseau est refusé", () => {
  const db = freshDb();
  const a = emptyNetwork(db, "172.20.0.0/24");
  const b = emptyNetwork(db, "172.21.0.0/24");
  const addr = allocateAddress(a, {}, db);
  assert.equal(code(() => releaseAddress(b, addr.id, db)), "addressNotFound");
});

test("tri numérique des adresses (10.0.0.2 avant 10.0.0.10)", () => {
  const db = freshDb();
  const id = emptyNetwork(db, "172.20.0.0/24");
  for (const ip of ["172.20.0.10", "172.20.0.2", "172.20.0.100", "172.20.0.9"]) allocateAddress(id, { address: ip }, db);
  assert.deepEqual(
    listAddresses(id, db).map((a) => a.address),
    ["172.20.0.2", "172.20.0.9", "172.20.0.10", "172.20.0.100"],
  );
});

test("supprimer un réseau supprime ses adresses (cascade)", () => {
  const db = freshDb();
  const id = emptyNetwork(db, "172.20.0.0/24");
  allocateAddress(id, {}, db);
  db.prepare("DELETE FROM networks WHERE id = ?").run(id);
  const left = db.prepare("SELECT COUNT(*) AS c FROM ip_addresses WHERE network_id = ?").get(id) as { c: number };
  assert.equal(left.c, 0);
});

test("VLANs : création, doublon par site, VLAN global, validation", () => {
  const db = freshDb();
  const site = db.prepare("SELECT id FROM sites ORDER BY id LIMIT 1").get() as { id: number };
  const v = createVlan({ number: 77, name: "  Labo  ", siteId: site.id }, db);
  assert.equal(v.name, "Labo");
  assert.equal(v.networkCount, 0);
  assert.equal(code(() => createVlan({ number: 77, name: "Autre", siteId: site.id }, db)), "vlanExists");
  assert.equal(createVlan({ number: 77, name: "Global" }, db).siteId, null); // même numéro mais sans site : autorisé
  assert.equal(code(() => createVlan({ number: 77, name: "Global 2" }, db)), "vlanExists");
  assert.equal(code(() => createVlan({ number: 0, name: "x" }, db)), "invalidVlan");
  assert.equal(code(() => createVlan({ number: 4095, name: "x" }, db)), "invalidVlan");
  assert.equal(code(() => createVlan({ number: 1.5, name: "x" }, db)), "invalidVlan");
  assert.equal(code(() => createVlan({ number: 5, name: "   " }, db)), "nameRequired");
  assert.equal(code(() => createVlan({ number: 5, name: "x", siteId: 99999 }, db)), "siteNotFound");
});

test("VLANs : un VLAN utilisé par des réseaux ne peut pas être supprimé", () => {
  const db = freshDb();
  const used = listVlans({}, db).find((v) => v.networkCount > 0)!;
  assert.ok(used, "la démo contient des VLAN rattachés à des réseaux");
  assert.equal(code(() => deleteVlan(used.id, db)), "vlanInUse");

  const site = db.prepare("SELECT id FROM sites ORDER BY id LIMIT 1").get() as { id: number };
  const free = createVlan({ number: 88, name: "Libre", siteId: site.id }, db);
  deleteVlan(free.id, db);
  assert.equal(listVlans({ q: "Libre" }, db).length, 0);
  assert.equal(code(() => deleteVlan(free.id, db)), "vlanNotFound");
});

test("VLANs : filtres par texte et par site, compteur de réseaux", () => {
  const db = freshDb();
  const all = listVlans({}, db);
  assert.equal(all.length, 30); // 5 sites × 6 VLAN
  assert.equal(listVlans({ q: "dmz" }, db).length, 5);
  assert.equal(listVlans({ q: "20" }, db).length, 5); // numéro 20 sur chacun des 5 sites
  const site = db.prepare("SELECT id FROM sites ORDER BY id LIMIT 1").get() as { id: number };
  assert.equal(listVlans({ siteId: site.id }, db).length, 6);
  // le VLAN 10 de chaque site a un réseau IPv4 ET un réseau IPv6 rattachés
  assert.equal(all.find((v) => v.number === 10)!.networkCount, 2);
  assert.equal(all.find((v) => v.number === 50)!.networkCount, 1);
});
