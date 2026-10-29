import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { getNetwork, listAddresses } from "./ipam";
import {
  createReservation,
  createScope,
  deleteReservation,
  deleteScope,
  exportScopeConfig,
  getScope,
  listReservations,
  listScopes,
} from "./dhcp";
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

/** Réseau IPv4 / IPv6 de test, vide, avec des compteurs à 0. */
function newNetwork(db: Db, cidr: string, capacity = 254): number {
  const project = db.prepare("SELECT id FROM projects LIMIT 1").get() as { id: number };
  const res = db
    .prepare(
      `INSERT INTO networks (project_id, site_id, cidr, version, name, vlan, status, used_ips, reserved_ips, capacity, created_at)
       VALUES (?, NULL, ?, ?, 'test', NULL, 'active', 0, 0, ?, ?)`,
    )
    .run(project.id, cidr, cidr.includes(":") ? 6 : 4, capacity, new Date().toISOString());
  return Number(res.lastInsertRowid);
}

test("la démo contient des plages cohérentes avec l'IPAM", () => {
  const db = freshDb();
  const scopes = listScopes({}, db);
  assert.ok(scopes.length >= 10, "plages de démonstration attendues");
  for (const s of scopes) {
    const net = getNetwork(s.networkId, db);
    const rows = listAddresses(s.networkId, db);
    assert.ok(net.reservedIps >= rows.filter((a) => a.status === "reserved").length, `${net.cidr} : invariant des compteurs`);
    assert.equal(s.poolSize, 121); // .100 -> .220
    assert.equal(s.conflictCount, 0, "les hôtes de démo sont hors plage dynamique");
    assert.equal(s.distributable, s.poolSize - 0);
  }
  assert.ok(scopes.some((s) => s.reservationCount === 2));
});

test("créer une plage : valeurs normalisées, DNS dédoublonnés", () => {
  const db = freshDb();
  const net = newNetwork(db, "10.50.0.0/24");
  const s = createScope(
    {
      networkId: net,
      name: "  Wifi invités ",
      rangeStart: "10.50.0.100",
      rangeEnd: "10.50.0.199",
      gateway: "10.50.0.1",
      dns: "1.1.1.1, 9.9.9.9 1.1.1.1\n2001:4860:4860:0:0:0:0:8888",
      leaseSeconds: 3600,
    },
    db,
  );
  assert.equal(s.name, "Wifi invités");
  assert.equal(s.poolSize, 100);
  assert.deepEqual(s.dns, ["1.1.1.1", "9.9.9.9", "2001:4860:4860::8888"]);
  assert.equal(s.enabled, true);
  assert.equal(s.leaseSeconds, 3600);
  assert.equal(getScope(s.id, db).networkCidr, "10.50.0.0/24");
});

test("créer une plage : refus des entrées invalides", () => {
  const db = freshDb();
  const net = newNetwork(db, "10.50.0.0/24");
  const v6 = newNetwork(db, "2001:db8:50::/64", 1000);
  const base = { networkId: net, name: "p", rangeStart: "10.50.0.10", rangeEnd: "10.50.0.20" };
  assert.equal(code(() => createScope({ ...base, name: " " }, db)), "nameRequired");
  assert.equal(code(() => createScope({ ...base, name: "x".repeat(81) }, db)), "nameTooLong");
  assert.equal(code(() => createScope({ ...base, networkId: 99999 }, db)), "networkNotFound");
  assert.equal(code(() => createScope({ ...base, networkId: v6 }, db)), "dhcpIpv4Only");
  assert.equal(code(() => createScope({ ...base, rangeStart: "abc" }, db)), "invalidAddress");
  assert.equal(code(() => createScope({ ...base, rangeStart: "2001:db8::1" }, db)), "invalidAddress");
  assert.equal(code(() => createScope({ ...base, rangeStart: "10.51.0.10" }, db)), "addressOutsideNetwork");
  assert.equal(code(() => createScope({ ...base, rangeStart: "10.50.0.0" }, db)), "addressNotAssignable");
  assert.equal(code(() => createScope({ ...base, rangeEnd: "10.50.0.255" }, db)), "addressNotAssignable");
  assert.equal(code(() => createScope({ ...base, rangeStart: "10.50.0.30" }, db)), "invalidRange");
  assert.equal(code(() => createScope({ ...base, gateway: "nope" }, db)), "invalidGateway");
  assert.equal(code(() => createScope({ ...base, gateway: "10.99.0.1" }, db)), "addressOutsideNetwork");
  assert.equal(code(() => createScope({ ...base, dns: "1.1.1.1, pas-une-ip" }, db)), "invalidDns");
  assert.equal(code(() => createScope({ ...base, dns: "1.1.1.1 2.2.2.2 3.3.3.3 4.4.4.4 5.5.5.5" }, db)), "tooManyDns");
  assert.equal(code(() => createScope({ ...base, leaseSeconds: 30 }, db)), "invalidLease");
  assert.equal(code(() => createScope({ ...base, leaseSeconds: 99_999_999 }, db)), "invalidLease");
  assert.equal(code(() => createScope({ ...base, leaseSeconds: 3600.5 }, db)), "invalidLease");
  assert.equal(listScopes({ q: "p" }, db).filter((s) => s.networkId === net).length, 0, "aucune plage créée par erreur");
});

test("chevauchement et nom unique", () => {
  const db = freshDb();
  const net = newNetwork(db, "10.50.0.0/24");
  createScope({ networkId: net, name: "A", rangeStart: "10.50.0.100", rangeEnd: "10.50.0.150" }, db);
  const o = (start: string, end: string, name = "B") =>
    code(() => createScope({ networkId: net, name, rangeStart: start, rangeEnd: end }, db));
  assert.equal(o("10.50.0.150", "10.50.0.160"), "scopeOverlap"); // touche la fin
  assert.equal(o("10.50.0.90", "10.50.0.100"), "scopeOverlap"); // touche le début
  assert.equal(o("10.50.0.110", "10.50.0.120"), "scopeOverlap"); // contenue
  assert.equal(o("10.50.0.50", "10.50.0.200"), "scopeOverlap"); // englobante
  assert.equal(o("10.50.0.151", "10.50.0.160"), null); // adjacente : autorisée
  assert.equal(o("10.50.0.170", "10.50.0.180", "a"), "scopeNameTaken"); // nom insensible à la casse
});

test("réservations : MAC normalisée, inventoriée dans l'IPAM, compteurs à jour", () => {
  const db = freshDb();
  const net = newNetwork(db, "10.50.0.0/24");
  const s = createScope({ networkId: net, name: "A", rangeStart: "10.50.0.100", rangeEnd: "10.50.0.150" }, db);

  const r = createReservation(s.id, { mac: "AA-BB-CC-DD-EE-01", address: "10.50.0.240", hostname: " imprimante " }, db);
  assert.equal(r.mac, "aa:bb:cc:dd:ee:01");
  assert.equal(r.hostname, "imprimante");
  assert.equal(getNetwork(net, db).reservedIps, 1);
  const inv = listAddresses(net, db);
  assert.equal(inv.length, 1);
  assert.deepEqual([inv[0].address, inv[0].status, inv[0].hostname], ["10.50.0.240", "reserved", "imprimante"]);

  assert.equal(getScope(s.id, db).reservationCount, 1);
  assert.equal(getScope(s.id, db).conflictCount, 0, "une réservation n'est jamais un conflit avec sa propre plage");
});

test("réservations : refus des entrées invalides et des doublons", () => {
  const db = freshDb();
  const net = newNetwork(db, "10.50.0.0/24");
  const s = createScope({ networkId: net, name: "A", rangeStart: "10.50.0.100", rangeEnd: "10.50.0.150" }, db);
  createReservation(s.id, { mac: "aa:bb:cc:dd:ee:01", address: "10.50.0.240" }, db);

  const c = (mac: string, address: string) => code(() => createReservation(s.id, { mac, address }, db));
  assert.equal(c("zz", "10.50.0.241"), "invalidMac");
  assert.equal(c("aa:bb:cc:dd:ee:02", "abc"), "invalidAddress");
  assert.equal(c("aa:bb:cc:dd:ee:02", "10.60.0.5"), "addressOutsideNetwork");
  assert.equal(c("aa:bb:cc:dd:ee:02", "10.50.0.255"), "addressNotAssignable");
  assert.equal(c("AA:BB:CC:DD:EE:01", "10.50.0.241"), "macTaken");
  assert.equal(c("aa:bb:cc:dd:ee:02", "10.50.0.240"), "addressTaken");
  assert.equal(code(() => createReservation(99999, { mac: "aa:bb:cc:dd:ee:02", address: "10.50.0.241" }, db)), "scopeNotFound");
  assert.equal(listReservations(s.id, db).length, 1);
  assert.equal(getNetwork(net, db).reservedIps, 1, "les refus ne touchent pas aux compteurs");
});

test("une adresse déjà inventoriée dans la plage est comptée comme conflit", () => {
  const db = freshDb();
  const net = newNetwork(db, "10.50.0.0/24");
  const s = createScope({ networkId: net, name: "A", rangeStart: "10.50.0.100", rangeEnd: "10.50.0.110" }, db);
  const ins = db.prepare(
    "INSERT INTO ip_addresses (network_id, address, status, hostname, description, created_at) VALUES (?, ?, 'used', NULL, NULL, ?)",
  );
  ins.run(net, "10.50.0.105", "x");
  ins.run(net, "10.50.0.9", "x"); // hors plage : pas un conflit
  db.prepare("UPDATE networks SET used_ips = 2 WHERE id = ?").run(net);
  const after = getScope(s.id, db);
  assert.equal(after.conflictCount, 1);
  assert.equal(after.distributable, 10); // 11 adresses - 1 conflit
});

test("supprimer une réservation ou une plage libère l'IPAM", () => {
  const db = freshDb();
  const net = newNetwork(db, "10.50.0.0/24");
  const s = createScope({ networkId: net, name: "A", rangeStart: "10.50.0.100", rangeEnd: "10.50.0.150" }, db);
  const r1 = createReservation(s.id, { mac: "aa:bb:cc:dd:ee:01", address: "10.50.0.240" }, db);
  createReservation(s.id, { mac: "aa:bb:cc:dd:ee:02", address: "10.50.0.241" }, db);
  assert.equal(getNetwork(net, db).reservedIps, 2);

  deleteReservation(s.id, r1.id, db);
  assert.equal(getNetwork(net, db).reservedIps, 1);
  assert.deepEqual(listAddresses(net, db).map((a) => a.address), ["10.50.0.241"]);
  assert.equal(code(() => deleteReservation(s.id, r1.id, db)), "reservationNotFound");

  deleteScope(s.id, db);
  assert.equal(getNetwork(net, db).reservedIps, 0);
  assert.equal(listAddresses(net, db).length, 0);
  assert.equal(code(() => getScope(s.id, db)), "scopeNotFound");
  const left = db.prepare("SELECT COUNT(*) AS c FROM dhcp_reservations WHERE scope_id = ?").get(s.id) as { c: number };
  assert.equal(left.c, 0);
});

test("la libération manuelle d'une adresse réservée n'empêche pas la suppression de la réservation", () => {
  const db = freshDb();
  const net = newNetwork(db, "10.50.0.0/24");
  const s = createScope({ networkId: net, name: "A", rangeStart: "10.50.0.100", rangeEnd: "10.50.0.150" }, db);
  const r = createReservation(s.id, { mac: "aa:bb:cc:dd:ee:01", address: "10.50.0.240" }, db);
  db.prepare("DELETE FROM ip_addresses WHERE network_id = ?").run(net);
  db.prepare("UPDATE networks SET reserved_ips = 0 WHERE id = ?").run(net);
  deleteReservation(s.id, r.id, db);
  assert.equal(getNetwork(net, db).reservedIps, 0, "jamais de compteur négatif");
});

test("réseau plein : aucune réservation de plus", () => {
  const db = freshDb();
  const net = newNetwork(db, "10.50.0.0/24", 1);
  const s = createScope({ networkId: net, name: "A", rangeStart: "10.50.0.100", rangeEnd: "10.50.0.150" }, db);
  createReservation(s.id, { mac: "aa:bb:cc:dd:ee:01", address: "10.50.0.240" }, db);
  assert.equal(code(() => createReservation(s.id, { mac: "aa:bb:cc:dd:ee:02", address: "10.50.0.241" }, db)), "networkFull");
});

test("export de configuration depuis la base", () => {
  const db = freshDb();
  const net = newNetwork(db, "10.50.0.0/24");
  const s = createScope(
    { networkId: net, name: "Wifi", rangeStart: "10.50.0.100", rangeEnd: "10.50.0.150", gateway: "10.50.0.1", dns: "1.1.1.1" },
    db,
  );
  createReservation(s.id, { mac: "aa:bb:cc:dd:ee:01", address: "10.50.0.240", hostname: "imprimante" }, db);
  const isc = exportScopeConfig(s.id, "isc", db);
  assert.match(isc, /range 10\.50\.0\.100 10\.50\.0\.150;/);
  assert.match(isc, /host imprimante \{/);
  assert.match(exportScopeConfig(s.id, "cisco", db), /ip dhcp pool Wifi-imprimante/);
});

test("supprimer un réseau supprime ses plages et leurs réservations (cascade)", () => {
  const db = freshDb();
  const net = newNetwork(db, "10.50.0.0/24");
  const s = createScope({ networkId: net, name: "A", rangeStart: "10.50.0.100", rangeEnd: "10.50.0.150" }, db);
  createReservation(s.id, { mac: "aa:bb:cc:dd:ee:01", address: "10.50.0.240" }, db);
  db.prepare("DELETE FROM networks WHERE id = ?").run(net);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM dhcp_scopes WHERE id = ?").get(s.id) as { c: number }).c, 0);
  const left = db.prepare("SELECT COUNT(*) AS c FROM dhcp_reservations WHERE scope_id = ?").get(s.id) as { c: number };
  assert.equal(left.c, 0);
});
