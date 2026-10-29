import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { createNetwork, getActiveProject, listNetworks, listSites } from "./queries";
import { createVlan, listVlans } from "./ipam";
import { createSite, deleteSite, getSite, listSitesDetailed, updateSite } from "./sites";
import { activateProject, createProject, deleteProject, getProject, listProjects, updateProject } from "./projects";
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

test("sites : création, normalisation et liste détaillée", () => {
  const db = freshDb();
  const before = listSitesDetailed({}, db).length;
  const s = createSite({ name: "  Zeta Site  ", address: " 1 rue X ", description: "   " }, db);
  assert.equal(s.name, "Zeta Site");
  assert.equal(s.address, "1 rue X");
  assert.equal(s.description, null);
  assert.equal(s.networkCount, 0);
  assert.equal(s.ipv4UsagePct, null);
  assert.equal(listSitesDetailed({}, db).length, before + 1);
  assert.equal(listSitesDetailed({ q: "zeta" }, db).length, 1);
  assert.equal(listSitesDetailed({ q: "1 RUE" }, db).length, 1);
  assert.equal(listSites(db).some((x) => x.id === s.id), true);
});

test("sites : validations (nom obligatoire/trop long/doublon, texte trop long)", () => {
  const db = freshDb();
  assert.equal(code(() => createSite({ name: "   " }, db)), "nameRequired");
  assert.equal(code(() => createSite({ name: "x".repeat(81) }, db)), "nameTooLong");
  assert.equal(code(() => createSite({ name: "A", address: "x".repeat(201) }, db)), "textTooLong");
  createSite({ name: "Lomé" }, db);
  assert.equal(code(() => createSite({ name: "LOMÉ" }, db)), "siteNameTaken");
  assert.equal(code(() => createSite(null as never, db)), "invalidBody");
});

test("sites : modification partielle, null efface, doublon refusé, rien d'écrit en cas d'échec", () => {
  const db = freshDb();
  const a = createSite({ name: "A", address: "adr", description: "desc" }, db);
  const b = createSite({ name: "B" }, db);
  assert.equal(updateSite(a.id, { name: "A2" }, db).address, "adr");
  const cleared = updateSite(a.id, { address: null }, db);
  assert.equal(cleared.address, null);
  assert.equal(cleared.description, "desc");
  assert.equal(updateSite(a.id, { name: "a2" }, db).name, "a2"); // même nom, autre casse : autorisé
  assert.equal(code(() => updateSite(b.id, { name: "A2" }, db)), "siteNameTaken");
  assert.equal(code(() => updateSite(b.id, { name: "" }, db)), "nameRequired");
  assert.equal(getSite(b.id, db).name, "B");
  assert.equal(code(() => updateSite(a.id, {}, db)), "invalidBody");
  assert.equal(code(() => updateSite(99999, { name: "z" }, db)), "siteNotFound");
});

test("sites : un site utilisé (réseaux ou VLANs) ne se supprime pas ; un site vide oui", () => {
  const db = freshDb();
  const s = createSite({ name: "Kara" }, db);
  const net = createNetwork({ cidr: "10.200.0.0/24", name: "N", siteId: s.id }, db);
  assert.equal(getSite(s.id, db).networkCount, 1);
  assert.equal(code(() => deleteSite(s.id, db)), "siteInUse");
  assert.equal(getSite(s.id, db).networkCount, 1); // rien n'a été détaché
  db.prepare("DELETE FROM networks WHERE id = ?").run(net.id);
  createVlan({ number: 77, name: "V", siteId: s.id }, db);
  assert.equal(code(() => deleteSite(s.id, db)), "siteInUse");
  const v = listVlans({}, db).find((x) => x.number === 77)!;
  db.prepare("DELETE FROM vlans WHERE id = ?").run(v.id);
  deleteSite(s.id, db);
  assert.equal(code(() => getSite(s.id, db)), "siteNotFound");
});

test("sites : l'utilisation IPv4 suit les réseaux du site", () => {
  const db = freshDb();
  const s = createSite({ name: "Sokodé" }, db);
  createNetwork({ cidr: "10.201.0.0/24", name: "N", siteId: s.id, usedIps: 127 }, db);
  const pct = getSite(s.id, db).ipv4UsagePct!;
  assert.ok(pct > 49 && pct < 51, String(pct));
});

test("projets : création vide, nom unique, modification, non activé automatiquement", () => {
  const db = freshDb();
  const active = getActiveProject(db);
  const p = createProject({ name: " Client ACME ", description: "x" }, db);
  assert.equal(p.name, "Client ACME");
  assert.equal(p.active, false);
  assert.equal(p.networkCount + p.siteCount + p.vlanCount + p.vrfCount, 0);
  assert.equal(getActiveProject(db).id, active.id);
  assert.equal(code(() => createProject({ name: "client acme" }, db)), "projectNameTaken");
  assert.equal(code(() => createProject({ name: "" }, db)), "nameRequired");
  assert.equal(updateProject(p.id, { name: "ACME" }, db).name, "ACME");
  assert.equal(updateProject(p.id, { description: null }, db).description, null);
  assert.equal(code(() => updateProject(p.id, {}, db)), "invalidBody");
  assert.equal(code(() => updateProject(p.id, { name: active.name }, db)), "projectNameTaken");
  assert.equal(code(() => getProject(99999, db)), "projectNotFound");
});

test("projets : activer change l'espace de travail (réseaux et sites isolés)", () => {
  const db = freshDb();
  const first = getActiveProject(db);
  const demoNetworks = listNetworks({}, db).length;
  assert.ok(demoNetworks > 0);
  const p = createProject({ name: "Vide" }, db);
  const res = activateProject(p.id, db);
  assert.equal(res.active, true);
  assert.equal(getActiveProject(db).id, p.id);
  assert.equal(listNetworks({}, db).length, 0);
  assert.equal(listSitesDetailed({}, db).length, 0);
  // un site du projet 1 n'est pas utilisable dans le projet 2
  const other = db.prepare("SELECT id FROM sites WHERE project_id = ? LIMIT 1").get(first.id) as { id: number };
  assert.equal(code(() => createNetwork({ cidr: "10.9.9.0/24", name: "x", siteId: other.id }, db)), "siteNotFound");
  // et le même nom de site peut exister dans deux projets
  createSite({ name: "Tchamba" }, db);
  activateProject(first.id, db);
  assert.equal(listProjects(db).find((x) => x.id === first.id)!.active, true);
  assert.equal(listProjects(db).filter((x) => x.active).length, 1);
  assert.equal(code(() => activateProject(99999, db)), "projectNotFound");
});

test("projets : le projet actif ne se supprime pas ; un autre disparaît avec son contenu", () => {
  const db = freshDb();
  const first = getActiveProject(db);
  assert.equal(code(() => deleteProject(first.id, db)), "projectActive");
  const p = createProject({ name: "Jetable" }, db);
  activateProject(p.id, db);
  const s = createSite({ name: "S" }, db);
  createNetwork({ cidr: "10.50.0.0/24", name: "N", siteId: s.id }, db);
  createVlan({ number: 5, name: "V" }, db);
  activateProject(first.id, db);
  const demoBefore = listNetworks({}, db).length;
  deleteProject(p.id, db);
  assert.equal(code(() => getProject(p.id, db)), "projectNotFound");
  const left = (t: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE project_id = ?`).get(p.id) as { c: number }).c;
  assert.equal(left("networks") + left("sites") + left("vlans"), 0);
  assert.equal(listNetworks({}, db).length, demoBefore); // le projet de démo est intact
});

test("projets : si le projet actif a disparu, on retombe sur le premier", () => {
  const db = freshDb();
  const first = getActiveProject(db);
  const p = createProject({ name: "Tmp" }, db);
  activateProject(p.id, db);
  db.prepare("DELETE FROM projects WHERE id = ?").run(p.id); // suppression « sauvage »
  assert.equal(getActiveProject(db).id, first.id);
});
