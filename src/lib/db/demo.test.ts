import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { getDemoInfo, leaveDemo } from "./demo";
import { demoDismissed } from "./demoMark";
import { getActiveProject } from "./queries";
import { ApiError } from "../types";

function fresh(): Db {
  const db: Db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  seedDatabase(db);
  return db;
}
const count = (db: Db, table: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

test("démo : le jeu de données est repéré, avec ses compteurs", () => {
  const db = fresh();
  const demo = getDemoInfo(db);
  assert.ok(demo);
  assert.equal(demo.name, "Entreprise Globale");
  assert.ok(demo.networks > 0 && demo.sites > 0 && demo.vlans > 0);
});

test("démo : une base ancienne (sans repère) est reconnue par le nom du projet", () => {
  const db = fresh();
  db.prepare("DELETE FROM settings WHERE key = 'demo_project_id'").run();
  assert.equal(getDemoInfo(db)?.name, "Entreprise Globale");
});

test("démo : quitter crée un projet vide actif et supprime toute la démonstration", () => {
  const db = fresh();
  const { project, removed } = leaveDemo({ name: "Mon entreprise" }, db);
  assert.equal(project.name, "Mon entreprise");
  assert.equal(project.networkCount, 0);
  assert.equal(getActiveProject(db).id, project.id);
  assert.equal(db.prepare("SELECT 1 FROM projects WHERE id = ?").get(removed.id), undefined);
  for (const t of ["networks", "sites", "vlans", "vrfs", "ip_addresses", "dhcp_scopes", "alerts"]) assert.equal(count(db, t), 0, `${t} vidé`);
  assert.equal(getDemoInfo(db), null);
  assert.ok(demoDismissed(db));
});

test("démo : on ne peut quitter qu'une fois (404), et un nom invalide ne supprime rien", () => {
  const db = fresh();
  assert.throws(() => leaveDemo({ name: "   " }, db), (e) => e instanceof ApiError && e.code === "nameRequired");
  assert.ok(getDemoInfo(db), "démo intacte après un refus");
  assert.throws(() => leaveDemo({ name: "Entreprise Globale" }, db), (e) => e instanceof ApiError && e.code === "projectNameTaken");
  assert.ok(getDemoInfo(db));
  leaveDemo({ name: "Réel" }, db);
  assert.throws(() => leaveDemo({ name: "Autre" }, db), (e) => e instanceof ApiError && e.code === "demoGone" && e.status === 404);
});

test("démo : le réglage du projet actif ne pointe plus vers le projet supprimé", () => {
  const db = fresh();
  const demo = getDemoInfo(db)!;
  db.prepare("INSERT INTO settings (key, value) VALUES ('active_project_id', ?)").run(String(demo.id));
  const { project } = leaveDemo({ name: "Réel" }, db);
  assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'active_project_id'").get() as { value: string }).value, String(project.id));
});
