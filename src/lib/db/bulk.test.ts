import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { createNetwork, listNetworks } from "./queries";
import { getNetwork } from "./ipam";
import { createField } from "./meta";
import { createVrf } from "./vrf";
import { BULK_MAX, BulkError, bulkDeleteNetworks, bulkUpdateNetworks } from "./bulk";
import { ApiError } from "../types";

function freshDb(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  seedDatabase(db);
  return db;
}
function failure(fn: () => unknown): { code: string; cidr?: string } | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof BulkError) return { code: e.cause.code, cidr: e.cidr };
    if (e instanceof ApiError) return { code: e.code };
    throw e;
  }
}
const trio = (db: Db) => ["172.27.0.0/24", "172.27.1.0/24", "172.27.2.0/24"].map((cidr, i) => createNetwork({ cidr, name: `B${i}`, tags: i === 0 ? ["a"] : [] }, db).id);

test("masse : statut, VLAN et site appliqués à tous ; étiquettes ajoutées/retirées sans toucher aux autres", () => {
  const db = freshDb();
  const [x, y, z] = trio(db);
  bulkUpdateNetworks([x, y, z], { status: "maintenance", vlan: 77, addTags: ["Prod", "a"], removeTags: [] }, db);
  for (const id of [x, y, z]) {
    const n = getNetwork(id, db);
    assert.equal(n.status, "maintenance");
    assert.equal(n.vlan, 77);
  }
  assert.deepEqual(getNetwork(x, db).tags.map((t) => t.name), ["a", "Prod"]); // pas de doublon avec « a »
  bulkUpdateNetworks([x, y], { removeTags: ["PROD"] }, db);
  assert.deepEqual(getNetwork(x, db).tags.map((t) => t.name), ["a"]);
  assert.deepEqual(getNetwork(z, db).tags.map((t) => t.name), ["a", "Prod"]);
  bulkUpdateNetworks([x], { vlan: null }, db);
  assert.equal(getNetwork(x, db).vlan, null);
});

test("masse : champs personnalisés fusionnés ; tout ou rien si une valeur est refusée", () => {
  const db = freshDb();
  createField({ entity: "network", key: "owner", label: "O", type: "text" }, db);
  createField({ entity: "network", key: "n", label: "N", type: "number" }, db);
  const [x, y] = trio(db);
  bulkUpdateNetworks([x, y], { customFields: { owner: "NOC" } }, db);
  assert.equal(getNetwork(y, db).customFields.owner, "NOC");
  const f = failure(() => bulkUpdateNetworks([x, y], { status: "error", customFields: { n: "zz" } }, db));
  assert.equal(f?.code, "invalidFieldValue");
  assert.equal(f?.cidr, "172.27.0.0/24");
  assert.equal(getNetwork(x, db).status, "active"); // rien n'a bougé
});

test("masse : changement de VRF refusé en bloc si l'un des réseaux chevauche la VRF de destination", () => {
  const db = freshDb();
  const [x, y] = trio(db);
  const v = createVrf({ name: "MASS" }, db);
  createNetwork({ cidr: "172.27.1.0/25", name: "gêneur", vrfId: v.id }, db);
  const f = failure(() => bulkUpdateNetworks([x, y], { vrfId: v.id }, db));
  assert.equal(f?.code, "overlap");
  assert.equal(f?.cidr, "172.27.1.0/24");
  assert.equal(getNetwork(x, db).vrfId, null);
  bulkUpdateNetworks([x], { vrfId: v.id }, db);
  assert.equal(getNetwork(x, db).vrfName, "MASS");
});

test("masse : sélection et corps validés (vide, trop grande, id invalide, clé inconnue, réseau d'un autre projet)", () => {
  const db = freshDb();
  const [x] = trio(db);
  assert.equal(failure(() => bulkUpdateNetworks([], { status: "active" }, db))?.code, "bulkNoSelection");
  assert.equal(failure(() => bulkUpdateNetworks(Array.from({ length: BULK_MAX + 1 }, (_, i) => i + 1), { status: "active" }, db))?.code, "bulkTooMany");
  assert.equal(failure(() => bulkUpdateNetworks(["1"], { status: "active" }, db))?.code, "invalidId");
  assert.equal(failure(() => bulkUpdateNetworks([x], {}, db))?.code, "invalidBody");
  assert.equal(failure(() => bulkUpdateNetworks([x], { name: "pirate" } as never, db))?.code, "invalidBody");
  assert.equal(failure(() => bulkUpdateNetworks([x], { status: "nope" }, db))?.code, "invalidStatus");
  assert.equal(failure(() => bulkUpdateNetworks([x, 987654], { status: "error" }, db))?.code, "networkNotFound");
  assert.equal(getNetwork(x, db).status, "active");
  // doublons dans la sélection : traités une seule fois
  assert.deepEqual(bulkUpdateNetworks([x, x], { status: "inactive" }, db), [x]);
});

test("masse : suppression tout ou rien, adresses supprimées avec les réseaux", () => {
  const db = freshDb();
  const before = listNetworks({}, db).length;
  const [x, y] = trio(db);
  assert.equal(failure(() => bulkDeleteNetworks([x, 987654], db))?.code, "networkNotFound");
  assert.equal(listNetworks({}, db).length, before + 3);
  bulkDeleteNetworks([x, y], db);
  assert.equal(listNetworks({}, db).length, before + 1);
});
