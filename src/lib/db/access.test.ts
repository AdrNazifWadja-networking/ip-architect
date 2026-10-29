import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { createProject, deleteProject } from "./projects";
import { createUser, createVerifiedUser, getUser, listUsers, sessionUser, updateUser, login } from "./users";
import { accessibleProjects, projectRole, resolveProjectFor, setActiveProjectFor } from "./access";
import { createToken, authenticateToken } from "./tokens";
import { ApiError } from "../types";

const PW = "Correct-Horse-42";

async function setup() {
  const db: Db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  seedDatabase(db);
  const boss = await createUser({ username: "boss", displayName: "Boss", password: PW }, db, { bootstrap: true });
  const a = createProject({ name: "Client A" }, db);
  const b = createProject({ name: "Client B" }, db);
  const c = createProject({ name: "Client C" }, db);
  return { db, boss, a, b, c };
}
const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
};
const su = (db: Db, id: number) => {
  const u = getUser(id, db);
  return { id: u.id, role: u.role, projectScope: u.projectScope } as const;
};

test("accès par projet : un compte existant garde l'accès à tout, y compris aux projets créés plus tard", async () => {
  const { db, a } = await setup();
  const ed = await createUser({ username: "edith", displayName: "Edith", password: PW, role: "editor" }, db);
  assert.equal(ed.projectScope, "all");
  assert.equal(projectRole(db, su(db, ed.id), a.id), "editor");
  const later = createProject({ name: "Plus tard" }, db);
  assert.equal(projectRole(db, su(db, ed.id), later.id), "editor");
  assert.equal(accessibleProjects(db, su(db, ed.id)).length, (db.prepare("SELECT COUNT(*) AS c FROM projects").get() as { c: number }).c);
});

test("accès par projet : « projets choisis » = un rôle par projet, rien ailleurs, rôle global aligné", async () => {
  const { db, boss, a, b, c } = await setup();
  const u = await createUser(
    { username: "tech", displayName: "Tech", password: PW, projectScope: "selected", memberships: [{ projectId: a.id, role: "editor" }, { projectId: b.id, role: "viewer" }] },
    db,
  );
  assert.equal(u.projectScope, "selected");
  assert.equal(u.role, "editor", "plafond = plus haut rôle de projet");
  const me = su(db, u.id);
  assert.equal(projectRole(db, me, a.id), "editor");
  assert.equal(projectRole(db, me, b.id), "viewer");
  assert.equal(projectRole(db, me, c.id), null);
  assert.deepEqual(accessibleProjects(db, me).map((p) => p.id), [a.id, b.id]);
  assert.equal(codeOf(() => resolveProjectFor(db, me, c.id)), "projectForbidden");
  assert.equal(resolveProjectFor(db, me, b.id).id, b.id);
  assert.equal(resolveProjectFor(db, me).id, a.id, "par défaut : le premier accessible");
  setActiveProjectFor(db, me, b.id);
  assert.equal(resolveProjectFor(db, me).id, b.id, "projet actif propre au compte");
  assert.equal(codeOf(() => setActiveProjectFor(db, me, c.id)), "projectForbidden");

  // plus aucun rôle éditeur : le plafond redescend
  const down = await updateUser(u.id, { memberships: [{ projectId: b.id, role: "viewer" }] }, boss.id, db);
  assert.equal(down.role, "viewer");
  assert.equal(resolveProjectFor(db, su(db, u.id)).id, b.id);
  // retour à « tous les projets » : le rôle choisi s'applique partout
  const back = await updateUser(u.id, { projectScope: "all", role: "editor" }, boss.id, db);
  assert.deepEqual([back.projectScope, back.role, back.memberships], ["all", "editor", []]);
  assert.equal(projectRole(db, su(db, u.id), c.id), "editor");
});

test("accès par projet : sans projet = erreur claire ; administrateur jamais restreint ; entrées invalides", async () => {
  const { db, boss, a } = await setup();
  const u = await createUser({ username: "nobody", displayName: "N", password: PW, projectScope: "selected", memberships: [] }, db);
  assert.equal(u.role, "viewer");
  assert.equal(codeOf(() => resolveProjectFor(db, su(db, u.id))), "noProjectAccess");
  assert.equal(codeOf(() => accessibleProjects(db, su(db, u.id)).length || null), null);

  assert.equal(codeOf(() => su(db, boss.id).projectScope === "all" && resolveProjectFor(db, su(db, boss.id))), null);
  await assert.rejects(() => updateUser(u.id, { role: "admin" }, boss.id, db), (e: unknown) => (e as ApiError).code === "adminAllProjects");
  await assert.rejects(createUser({ username: "adm", displayName: "A", password: PW, role: "admin", projectScope: "selected", memberships: [] }, db), (e: unknown) => (e as ApiError).code === "adminAllProjects");
  const bad = [
    { memberships: [{ projectId: a.id, role: "admin" }] },
    { memberships: [{ projectId: a.id, role: "editor" }, { projectId: a.id, role: "viewer" }] },
    { memberships: [{ projectId: 99999, role: "viewer" }] },
    { memberships: "x" },
    { projectScope: "none" },
  ];
  for (const input of bad) await assert.rejects(() => updateUser(u.id, input as never, boss.id, db), ApiError, JSON.stringify(input));
});

test("accès par projet : supprimer un projet retire les accès ; la session et le jeton portent la portée", async () => {
  const { db, a, b } = await setup();
  const u = await createUser({ username: "tech", displayName: "Tech", password: PW, projectScope: "selected", memberships: [{ projectId: a.id, role: "editor" }, { projectId: b.id, role: "viewer" }] }, db);
  const s = await login("tech", PW, {}, db);
  assert.equal(s.user.projectScope, "selected");
  assert.equal(sessionUser(s.token, db)!.projectScope, "selected");
  const tok = createToken(s.user, { name: "ci", role: "editor" }, db);
  assert.equal(authenticateToken(tok.token, db)!.user.projectScope, "selected");

  db.prepare("UPDATE users SET active_project_id = ? WHERE id = ?").run(a.id, u.id);
  deleteProject(a.id, db);
  assert.deepEqual(getUser(u.id, db).memberships.map((m) => m.projectId), [b.id]);
  assert.equal(resolveProjectFor(db, su(db, u.id)).id, b.id, "le projet actif supprimé laisse place à un projet accessible");
  assert.equal(listUsers(db).find((x) => x.id === u.id)!.memberships.length, 1);
});

test("accès par projet : une inscription libre ne reçoit rien dès qu'il y a plusieurs projets", async () => {
  const { db } = await setup();
  const hash = "x".repeat(10);
  const many = createVerifiedUser({ username: "visiteur", displayName: "V", passwordHash: hash, email: "v@example.com" }, db);
  assert.equal(many.projectScope, "selected");
  assert.deepEqual(many.memberships, []);

  const solo = new Database(":memory:");
  solo.pragma("foreign_keys = ON");
  solo.exec(SCHEMA);
  solo.prepare("INSERT INTO projects (name, created_at) VALUES ('Unique', '2026-01-01')").run();
  const one = createVerifiedUser({ username: "visiteur", displayName: "V", passwordHash: hash, email: "v@example.com" }, solo);
  assert.equal(one.projectScope, "all", "un seul projet : comportement inchangé");
});
