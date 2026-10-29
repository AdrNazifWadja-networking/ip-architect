import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { createNetwork, deleteNetwork, listNetworks } from "./queries";
import { getNetwork } from "./ipam";
import { countGlobalNetworks, createVrf, deleteVrf, exportVrfConfig, getVrf, listVrfs, moveNetworkToVrf } from "./vrf";
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

test("la démo contient des VRF et seuls des réseaux de démo y sont rattachés", () => {
  const db = freshDb();
  const names = listVrfs({}, db).map((v) => v.name);
  assert.deepEqual(names, ["CORP", "DMZ", "GUEST", "MGMT"]);
  const corp = listVrfs({ q: "corp" }, db)[0];
  assert.equal(corp.rd, "65000:10");
  assert.deepEqual(corp.rtImport, ["65000:10", "65000:40"]);
  assert.equal(corp.networkCount, 20); // 5 sites x (VLAN 10 + 20) x (IPv4 + IPv6)
  assert.ok(corp.ipv4UsagePct !== null && corp.ipv4UsagePct > 0);
  assert.equal(countGlobalNetworks(db), 5); // VLAN 60 : 5 sites, IPv4 seulement
  assert.equal(listNetworks({ vrf: "none" }, db).length, 5);
  assert.equal(listNetworks({ vrf: corp.id }, db).length, 20);
  assert.ok(listNetworks({ vrf: corp.id }, db).every((n) => n.vrfName === "CORP"));
});

test("créer une VRF : valeurs normalisées", () => {
  const db = freshDb();
  const v = createVrf(
    { name: " PROD ", rd: "65000:0200", rtImport: "65000:200, 65000:200 10.0.0.1:5", rtExport: ["65000:200"], description: " Prod " },
    db,
  );
  assert.equal(v.name, "PROD");
  assert.equal(v.rd, "65000:200");
  assert.deepEqual(v.rtImport, ["65000:200", "10.0.0.1:5"]); // doublon retiré
  assert.deepEqual(v.rtExport, ["65000:200"]);
  assert.equal(v.description, "Prod");
  assert.equal(v.networkCount, 0);
  assert.equal(v.ipv4UsagePct, null);
  // VRF-Lite : sans RD ni route target
  const lite = createVrf({ name: "lite" }, db);
  assert.equal(lite.rd, null);
  assert.deepEqual(lite.rtImport, []);
});

test("créer une VRF : refus des entrées invalides et des doublons", () => {
  const db = freshDb();
  const c = (i: Parameters<typeof createVrf>[0]) => code(() => createVrf(i, db));
  assert.equal(c({ name: "  " }), "nameRequired");
  assert.equal(c({ name: "avec espace" }), "invalidVrfName");
  assert.equal(c({ name: "x".repeat(33) }), "invalidVrfName");
  assert.equal(c({ name: "corp" }), "vrfNameTaken"); // insensible à la casse
  assert.equal(c({ name: "N1", rd: "abc" }), "invalidRd");
  assert.equal(c({ name: "N1", rd: "65000:10" }), "rdTaken");
  assert.equal(c({ name: "N1", rd: "65000:1", rtImport: "65000:1, zz" }), "invalidRt");
  assert.equal(c({ name: "N1", rd: "65000:1", rtExport: "1:1 1:2 1:3 1:4 1:5 1:6 1:7 1:8 1:9" }), "tooManyRt");
  assert.equal(c({ name: "N1", rtExport: "65000:1" }), "rtNeedsRd");
  assert.equal(c({ name: "N1", description: "x".repeat(201) }), "textTooLong");
  assert.equal(listVrfs({ q: "N1" }, db).length, 0, "aucune VRF créée par erreur");
});

test("le même CIDR est autorisé dans deux VRF différentes, refusé dans la même", () => {
  const db = freshDb();
  const a = createVrf({ name: "A" }, db);
  const b = createVrf({ name: "B" }, db);
  const mk = (cidr: string, vrfId: number | null) => createNetwork({ cidr, name: "t", vrfId }, db);

  const n1 = mk("172.16.0.0/16", a.id);
  assert.equal(n1.vrfName, "A");
  const n2 = mk("172.16.0.0/16", b.id); // même CIDR, autre VRF : OK
  assert.equal(n2.vrfName, "B");
  const n3 = mk("172.16.0.0/16", null); // même CIDR, VRF globale : OK
  assert.equal(n3.vrfId, null);

  assert.equal(code(() => mk("172.16.0.0/16", a.id)), "overlap");
  assert.equal(code(() => mk("172.16.5.0/24", b.id)), "overlap"); // inclus dans un réseau de la VRF B
  assert.equal(code(() => mk("172.16.0.0/16", null)), "overlap");
  assert.equal(code(() => mk("192.168.0.0/24", 999999)), "vrfNotFound");
  assert.equal(getVrf(a.id, db).networkCount, 1);
});

test("la détection de chevauchement des réseaux sans VRF reste inchangée", () => {
  const db = freshDb();
  // 10.1.10.0/24 existe déjà (démo) : en VRF globale il y a bien conflit avec la démo hors VRF (VLAN 60 : 10.1.60.0/24)
  assert.equal(code(() => createNetwork({ cidr: "10.1.60.0/24", name: "x" }, db)), "overlap");
  // mais 10.1.10.0/24 est dans CORP : la VRF globale peut le réutiliser
  assert.equal(code(() => createNetwork({ cidr: "10.1.10.0/24", name: "x" }, db)), null);
});

test("déplacer un réseau vers une VRF : contrôle du chevauchement à destination", () => {
  const db = freshDb();
  const a = createVrf({ name: "A" }, db);
  const b = createVrf({ name: "B" }, db);
  const n1 = createNetwork({ cidr: "172.20.0.0/16", name: "n1", vrfId: a.id }, db);
  const n2 = createNetwork({ cidr: "172.20.1.0/24", name: "n2", vrfId: b.id }, db);

  assert.equal(code(() => moveNetworkToVrf(n2.id, a.id, db)), "overlap"); // inclus dans n1
  assert.equal(getNetwork(n2.id, db).vrfId, b.id, "inchangé après refus");
  assert.equal(moveNetworkToVrf(n2.id, null, db).vrfId, null); // vers la VRF globale
  assert.equal(moveNetworkToVrf(n2.id, null, db).vrfId, null); // idempotent
  assert.equal(moveNetworkToVrf(n1.id, b.id, db).vrfName, "B");
  assert.equal(code(() => moveNetworkToVrf(99999, a.id, db)), "networkNotFound");
  assert.equal(code(() => moveNetworkToVrf(n1.id, 99999, db)), "vrfNotFound");
});

test("supprimer une VRF : refusée si elle contient des réseaux, sinon libre", () => {
  const db = freshDb();
  const a = createVrf({ name: "A" }, db);
  const n = createNetwork({ cidr: "172.30.0.0/24", name: "n", vrfId: a.id }, db);
  assert.equal(code(() => deleteVrf(a.id, db)), "vrfInUse");
  moveNetworkToVrf(n.id, null, db);
  deleteVrf(a.id, db);
  assert.equal(code(() => getVrf(a.id, db)), "vrfNotFound");
  assert.equal(code(() => deleteVrf(a.id, db)), "vrfNotFound");
  deleteNetwork(n.id, db);
});

test("export de configuration Cisco", () => {
  const db = freshDb();
  const v = createVrf({ name: "A", rd: "65000:7", rtExport: "65000:7", rtImport: "65000:7,65000:8", description: "Test" }, db);
  createNetwork({ cidr: "172.31.0.0/24", name: "r4", vrfId: v.id }, db);
  let out = exportVrfConfig(v.id, db);
  assert.match(out, /vrf definition A\n description Test\n rd 65000:7\n/);
  assert.match(out, /! network 172\.31\.0\.0\/24 \(r4\)/);
  assert.doesNotMatch(out, /address-family ipv6/);
  createNetwork({ cidr: "2001:db8:ffff::/64", name: "r6", vrfId: v.id }, db);
  out = exportVrfConfig(v.id, db);
  assert.match(out, /address-family ipv6/);
  assert.equal(code(() => exportVrfConfig(99999, db)), "vrfNotFound");
});
