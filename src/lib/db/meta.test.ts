import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { createNetwork, listNetworks } from "./queries";
import { allocateAddress, getNetwork, listAddresses } from "./ipam";
import { updateAddress, updateNetwork } from "./edit";
import { createField, createTag, deleteField, deleteTag, listFields, listTags, updateField, updateTag } from "./meta";
import { snapshot } from "./changes";
import { ApiError } from "../types";

function freshDb(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  seedDatabase(db);
  return db;
}
const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
};

test("étiquettes : création, noms uniques sans casse, couleur contrôlée, renommage, suppression", () => {
  const db = freshDb();
  const t = createTag({ name: "Production", color: "red" }, db);
  assert.equal(t.color, "red");
  assert.equal(code(() => createTag({ name: "production" }, db)), "tagExists");
  assert.equal(code(() => createTag({ name: "  " }, db)), "tagNameRequired");
  assert.equal(code(() => createTag({ name: "a,b" }, db)), "tagNameInvalid");
  assert.equal(code(() => createTag({ name: "x".repeat(31) }, db)), "tagNameTooLong");
  assert.equal(code(() => createTag({ name: "ok", color: "pink" }, db)), "invalidTagColor");
  assert.equal(updateTag(t.id, { name: "Prod", color: "blue" }, db).name, "Prod");
  assert.equal(code(() => updateTag(t.id, {}, db)), "invalidBody");
  assert.equal(code(() => updateTag(9999, { name: "z" }, db)), "tagNotFound");
  deleteTag(t.id, db);
  assert.equal(listTags(db).length, 0);
});

test("champs : définition validée (clé, type, options, doublons, limite) ; type et clé figés", () => {
  const db = freshDb();
  const f = createField({ entity: "network", key: "owner", label: "Propriétaire", type: "text" }, db);
  assert.equal(f.required, false);
  assert.equal(code(() => createField({ entity: "network", key: "owner", label: "x", type: "text" }, db)), "fieldKeyExists");
  createField({ entity: "address", key: "owner", label: "x", type: "text" }, db); // même clé, autre objet : permis
  assert.equal(code(() => createField({ entity: "network", key: "Bad Key", label: "x", type: "text" }, db)), "invalidFieldKey");
  assert.equal(code(() => createField({ entity: "vlan", key: "k", label: "x", type: "text" }, db)), "invalidFieldEntity");
  assert.equal(code(() => createField({ entity: "network", key: "k", label: "x", type: "date" }, db)), "invalidFieldType");
  assert.equal(code(() => createField({ entity: "network", key: "k", label: "x", type: "choice" }, db)), "invalidFieldOptions");
  assert.equal(code(() => createField({ entity: "network", key: "k", label: "", type: "text" }, db)), "fieldLabelRequired");
  const c = createField({ entity: "network", key: "crit", label: "Criticité", type: "choice", options: ["Haute", "haute", "Basse"] }, db);
  assert.deepEqual(c.options, ["Haute", "Basse"]);
  assert.equal(updateField(c.id, { label: "Criticité 2", required: true }, db).required, true);
  assert.equal(code(() => updateField(f.id, { options: ["a"] }, db)), "invalidFieldOptions");
  assert.equal(code(() => updateField(f.id, { key: "z" } as never, db)), "invalidBody");
  for (let i = 0; i < 18; i++) createField({ entity: "network", key: `f${i}`, label: "x", type: "text" }, db);
  assert.equal(code(() => createField({ entity: "network", key: "over", label: "x", type: "text" }, db)), "fieldLimit");
  deleteField(f.id, db);
  assert.equal(code(() => deleteField(f.id, db)), "fieldNotFound");
});

test("réseaux : étiquettes et champs à la création, lecture, filtre, mise à jour fusionnée, effacement", () => {
  const db = freshDb();
  createField({ entity: "network", key: "owner", label: "Propriétaire", type: "text" }, db);
  createField({ entity: "network", key: "vlans", label: "Nb", type: "number" }, db);
  createField({ entity: "network", key: "crit", label: "Criticité", type: "choice", options: ["Haute", "Basse"] }, db);
  createField({ entity: "network", key: "managed", label: "Géré", type: "bool" }, db);

  const n = createNetwork(
    { cidr: "172.31.0.0/24", name: "Meta", tags: ["Prod", "zoneq", "PROD"], customFields: { owner: " Équipe réseau ", vlans: "12", crit: "haute", managed: true } },
    db,
  );
  assert.deepEqual(n.tags.map((x) => x.name), ["Prod", "zoneq"]);
  assert.deepEqual(n.customFields, { owner: "Équipe réseau", vlans: 12, crit: "Haute", managed: true });
  assert.equal(listTags(db).length, 2);

  const listed = listNetworks({}, db).find((x) => x.id === n.id)!;
  assert.deepEqual(listed.customFields, n.customFields);
  assert.ok(listNetworks({}, db).some((x) => x.tags.length === 0)); // les autres réseaux n'ont rien
  assert.deepEqual(listNetworks({ tag: "prod" }, db).map((x) => x.id), [n.id]);
  assert.deepEqual(listNetworks({ tag: "inconnue" }, db), []);
  assert.deepEqual(listNetworks({ q: "zoneq" }, db).map((x) => x.id), [n.id]);

  // mise à jour : fusion des champs, remplacement des étiquettes, changement limité aux métadonnées
  const u = updateNetwork(n.id, { tags: ["prod"], customFields: { owner: "", crit: "Basse" } }, db);
  assert.deepEqual(u.tags.map((x) => x.name), ["Prod"]);
  assert.deepEqual(u.customFields, { vlans: 12, crit: "Basse", managed: true });
  assert.equal(getNetwork(n.id, db).customFields.crit, "Basse");
  assert.equal(code(() => updateNetwork(n.id, {}, db)), "invalidBody");

  // validations (rien n'est écrit en cas d'erreur)
  assert.equal(code(() => updateNetwork(n.id, { customFields: { nope: "x" } }, db)), "unknownField");
  assert.equal(code(() => updateNetwork(n.id, { customFields: { vlans: "abc" } }, db)), "invalidFieldValue");
  assert.equal(code(() => updateNetwork(n.id, { customFields: { crit: "Moyenne" } }, db)), "invalidFieldValue");
  assert.equal(code(() => updateNetwork(n.id, { customFields: { managed: "peut-être" } }, db)), "invalidFieldValue");
  assert.equal(code(() => updateNetwork(n.id, { customFields: { owner: "x".repeat(201) } }, db)), "textTooLong");
  assert.equal(code(() => updateNetwork(n.id, { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, db)), "tooManyTags");
  assert.equal(code(() => updateNetwork(n.id, { tags: "prod" as never }, db)), "invalidBody");
  assert.equal(getNetwork(n.id, db).customFields.vlans, 12);

  // suppression d'une étiquette et d'un champ : retirées des éléments
  deleteTag(listTags(db).find((x) => x.name === "Prod")!.id, db);
  assert.deepEqual(getNetwork(n.id, db).tags, []);
  deleteField(listFields("network", db).find((x) => x.key === "vlans")!.id, db);
  assert.equal(getNetwork(n.id, db).customFields.vlans, undefined);
});

test("création atomique : une valeur invalide n'laisse aucun réseau ni aucune étiquette orpheline", () => {
  const db = freshDb();
  createField({ entity: "network", key: "n", label: "N", type: "number" }, db);
  const before = listNetworks({}, db).length;
  assert.equal(code(() => createNetwork({ cidr: "172.31.1.0/24", name: "X", tags: ["nouvelle"], customFields: { n: "zz" } }, db)), "invalidFieldValue");
  assert.equal(listNetworks({}, db).length, before);
  assert.equal(listTags(db).length, 0);
});

test("champs obligatoires : exigés à la création et à l'effacement, pas à l'import ni sans valeur fournie à la mise à jour", () => {
  const db = freshDb();
  createField({ entity: "network", key: "owner", label: "Propriétaire", type: "text", required: true }, db);
  createField({ entity: "address", key: "ticket", label: "Ticket", type: "text", required: true }, db);
  assert.equal(code(() => createNetwork({ cidr: "172.31.2.0/24", name: "A" }, db)), "fieldRequired");
  const n = createNetwork({ cidr: "172.31.2.0/24", name: "A", customFields: { owner: "x" } }, db);
  createNetwork({ cidr: "172.31.3.0/24", name: "B" }, db, { skipRequired: true }); // import CSV, plan
  assert.equal(updateNetwork(n.id, { name: "A2" }, db).name, "A2"); // pas de valeur fournie : pas de contrôle
  assert.equal(code(() => updateNetwork(n.id, { customFields: { owner: "" } }, db)), "fieldRequired");

  assert.equal(code(() => allocateAddress(n.id, { address: "172.31.2.5" }, db)), "fieldRequired");
  const a = allocateAddress(n.id, { address: "172.31.2.5", customFields: { ticket: "INC-1" }, tags: ["vip"] }, db);
  assert.deepEqual(a.customFields, { ticket: "INC-1" });
  allocateAddress(n.id, { address: "172.31.2.6" }, db, { skipRequired: true });
  assert.equal(listAddresses(n.id, db).length, 2);
});

test("adresses : étiquettes et champs à l'allocation, à la modification et dans la liste ; champs d'un autre objet refusés", () => {
  const db = freshDb();
  createField({ entity: "address", key: "ticket", label: "Ticket", type: "text" }, db);
  createField({ entity: "network", key: "owner", label: "Propriétaire", type: "text" }, db);
  const n = createNetwork({ cidr: "172.31.4.0/24", name: "Adr" }, db);
  const a = allocateAddress(n.id, { tags: ["srv", "Web"], customFields: { ticket: "INC-9" } }, db);
  assert.deepEqual(a.tags.map((x) => x.name), ["srv", "Web"]);
  assert.equal(code(() => allocateAddress(n.id, { customFields: { owner: "x" } }, db)), "unknownField");

  const u = updateAddress(n.id, a.id, { hostname: "h1" }, db); // sans métadonnées : elles restent
  assert.equal(u.customFields.ticket, "INC-9");
  assert.equal(u.tags.length, 2);
  const v = updateAddress(n.id, a.id, { tags: [], customFields: { ticket: null } }, db);
  assert.deepEqual(v.tags, []);
  assert.deepEqual(v.customFields, {});
  updateAddress(n.id, a.id, { tags: ["Web"], customFields: { ticket: "T" } }, db);
  const listed = listAddresses(n.id, db);
  assert.deepEqual(listed[0].tags.map((x) => x.name), ["Web"]);
  assert.equal(listed[0].customFields.ticket, "T");

  // le comptage des étiquettes distingue réseaux et adresses
  const web = listTags(db).find((x) => x.name === "Web")!;
  assert.equal(web.addressCount, 1);
  assert.equal(web.networkCount, 0);
});

test("isolation par projet : étiquettes et champs d'un autre projet invisibles", () => {
  const db = freshDb();
  const p2 = Number(db.prepare("INSERT INTO projects (name, created_at) VALUES ('P2', ?)").run(new Date().toISOString()).lastInsertRowid);
  db.prepare("INSERT INTO tags (project_id, name, color) VALUES (?, 'autre', 'gray')").run(p2);
  db.prepare("INSERT INTO custom_fields (project_id, entity, key, label, type) VALUES (?, 'network', 'k', 'K', 'text')").run(p2);
  assert.deepEqual(listTags(db), []);
  assert.deepEqual(listFields(undefined, db), []);
  // même nom d'étiquette permis dans deux projets
  createTag({ name: "autre" }, db);
  assert.equal(listTags(db).length, 1);
});

test("audit : l'instantané d'un réseau et d'une adresse contient étiquettes et champs", () => {
  const db = freshDb();
  createField({ entity: "network", key: "owner", label: "O", type: "text" }, db);
  const n = createNetwork({ cidr: "172.31.5.0/24", name: "S", tags: ["b", "a"], customFields: { owner: "Z" } }, db);
  const s = snapshot("network", n.id, db)!;
  assert.equal(s.tags, "a, b");
  assert.equal(s.fields, "owner=Z");
  const t = createTag({ name: "snap", color: "green" }, db);
  assert.deepEqual(snapshot("tag", t.id, db), { name: "snap", color: "green" });
});
