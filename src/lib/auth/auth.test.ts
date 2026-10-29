import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "../db/index";
import { seedDatabase } from "../db/seed";
import {
  authEnabled,
  changeOwnPassword,
  countUsers,
  createUser,
  deleteUser,
  getUser,
  listUsers,
  login,
  logout,
  normalizeUsername,
  sessionUser,
  updateUser,
  validatePassword,
} from "../db/users";
import { hashPassword, verifyPassword } from "./password";
import { LoginThrottle } from "./throttle";
import { atLeast, isRole, SESSION_IDLE_MS, SESSION_MAX_MS } from "./roles";
import { requiredAccess } from "./policy";
import { ApiError } from "../types";
import { dictionaries } from "../i18n";

function freshDb(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  seedDatabase(db);
  return db;
}

async function code(fn: () => unknown): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
}

const PW = "Correct-horse-42";
const admin = (db: Db, name = "alice") => createUser({ username: name, displayName: "Alice", password: PW, role: "admin" }, db);

/* ------------------------------- Rôles & politique ------------------------------- */

test("rôles : ordre viewer < editor < admin", () => {
  assert.ok(atLeast("admin", "editor") && atLeast("editor", "editor") && atLeast("editor", "viewer"));
  assert.ok(!atLeast("viewer", "editor") && !atLeast("editor", "admin"));
  assert.ok(isRole("admin") && !isRole("root") && !isRole(undefined));
});

test("politique : lecture = lecteur, écriture = éditeur, comptes/projets/seuils = admin, public minimal", () => {
  assert.equal(requiredAccess("GET", "/api/networks"), "viewer");
  assert.equal(requiredAccess("POST", "/api/networks"), "editor");
  assert.equal(requiredAccess("DELETE", "/api/vlans/[id]"), "editor");
  assert.equal(requiredAccess("POST", "/api/import/[entity]"), "editor");
  assert.equal(requiredAccess("POST", "/api/monitoring/probe"), "editor");
  assert.equal(requiredAccess("PATCH", "/api/monitoring/settings"), "admin");
  assert.equal(requiredAccess("POST", "/api/simulator/[mode]"), "viewer");
  assert.equal(requiredAccess("POST", "/api/projects/[id]/activate"), "viewer");
  assert.equal(requiredAccess("POST", "/api/projects"), "admin");
  assert.equal(requiredAccess("DELETE", "/api/projects/[id]"), "admin");
  assert.equal(requiredAccess("GET", "/api/users"), "admin");
  assert.equal(requiredAccess("PATCH", "/api/users/[id]"), "admin");
  assert.equal(requiredAccess("POST", "/api/auth/password"), "viewer");
  for (const r of ["/api/health", "/api/auth/login", "/api/auth/logout", "/api/auth/me", "/api/auth/register/start", "/api/auth/register/verify"]) assert.equal(requiredAccess("GET", r), "public");
});

/* ----------------------- Couverture : aucune route ni page oubliée ----------------------- */

function walk(dir: string, name: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, name, out);
    else if (e.name === name) out.push(p);
  }
  return out;
}

const APP = path.join(process.cwd(), "src", "app");

test("routes API : chaque gestionnaire appelle guard() avec EXACTEMENT le rôle de la politique", () => {
  const files = walk(APP, "route.ts");
  assert.ok(files.length >= 30, `routes trouvées : ${files.length}`);
  for (const file of files) {
    const route = "/" + path.relative(path.join(process.cwd(), "src", "app"), path.dirname(file)).split(path.sep).join("/");
    const src = fs.readFileSync(file, "utf8");
    assert.ok(!/export\s+(const|let|var)\s+(GET|POST|PUT|PATCH|DELETE)\b/.test(src), `${route} : export de gestionnaire non analysable`);
    assert.ok(!/export\s*\{[^}]*\b(GET|POST|PUT|PATCH|DELETE)\b/.test(src), `${route} : ré-export de gestionnaire non analysable`);
    const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\(/g)];
    assert.ok(handlers.length > 0, `${route} : aucun gestionnaire`);
    handlers.forEach((m, i) => {
      const end = i + 1 < handlers.length ? handlers[i + 1].index! : src.length;
      const body = src.slice(m.index!, end);
      const want = requiredAccess(m[1], route);
      if (want === "public") {
        assert.ok(!body.includes("guard("), `${m[1]} ${route} : public, ne doit pas être protégé par guard`);
      } else if (route === "/api/users") {
        // création du tout premier compte sans connexion : règle propre au fichier, marquée explicitement
        assert.ok(src.includes("// access: custom"), `${m[1]} ${route} : règle personnalisée non marquée`);
        assert.ok(body.includes('"admin"') && body.includes("currentUser()"), `${m[1]} ${route} : doit exiger admin hors création initiale`);
      } else {
        // le garde doit être la PREMIÈRE instruction du gestionnaire
        const first = body.slice(body.indexOf("{", body.indexOf(")")) + 1).trimStart();
        assert.ok(first.startsWith(`const denied = guard("${want}");`), `${m[1]} ${route} : première instruction attendue guard("${want}")`);
      }
    });
  }
});

test("pages : chaque page appelle requireUser() (sauf /login, publique)", () => {
  const files = walk(APP, "page.tsx");
  assert.ok(files.length >= 18, `pages trouvées : ${files.length}`);
  for (const file of files) {
    const rel = path.relative(APP, file).split(path.sep).join("/");
    const src = fs.readFileSync(file, "utf8");
    if (rel === "login/page.tsx" || rel === "inscription/page.tsx" || rel === "mot-de-passe-oublie/page.tsx") {
      assert.ok(!src.includes("requireUser("), "les pages de connexion, d'inscription et de mot de passe oublié sont publiques");
      continue;
    }
    if (rel === "utilisateurs/page.tsx") {
      // sans compte, cette page est la seule accessible (création du premier administrateur) : requireUser() n'est exigé qu'une fois la connexion active
      assert.ok(/if \(enabled\) requireUser\(\)/.test(src), "utilisateurs/page.tsx : requireUser() conditionné à l'existence d'un compte");
      continue;
    }
    const m = src.match(/export default (async )?function \w+\([^]*?\)\s*\{\s*(requireUser\()/);
    assert.ok(m, `${rel} : requireUser() doit être la première instruction de la page`);
  }
});

/* ------------------------------------ Mots de passe ------------------------------------ */

test("mot de passe : hash salé, vérification, formats corrompus refusés sans exception", async () => {
  const h1 = await hashPassword(PW);
  const h2 = await hashPassword(PW);
  assert.notEqual(h1, h2, "sel différent à chaque fois");
  assert.ok(h1.startsWith("scrypt$16384$8$1$"));
  assert.ok(await verifyPassword(PW, h1));
  assert.ok(!(await verifyPassword(PW + "x", h1)));
  for (const bad of ["", "abc", "scrypt$1$1$1$a$b", "scrypt$16384$8$1$AAAA", "md5$16384$8$1$AAAA$BBBB", `scrypt$${1 << 30}$8$1$AAAA$BBBB`, "scrypt$16384$8$1$AAAA$BBBB"]) {
    assert.equal(await verifyPassword(PW, bad), false, bad);
  }
  // normalisation Unicode : « é » composé ou décomposé donne le même mot de passe
  const hu = await hashPassword("passéword-long");
  assert.ok(await verifyPassword("passéword-long", hu));
});

test("mot de passe : règles (longueur, variété, sans l'identifiant)", () => {
  assert.equal(validatePassword(PW, "alice"), PW);
  for (const bad of ["court", "aaaaaaaaaaaa", "1212121212121", "xxalicexx-secret", 42, undefined, "a".repeat(201)]) {
    assert.throws(() => validatePassword(bad, "alice"), (e) => e instanceof ApiError && e.code === "passwordWeak", String(bad));
  }
});

test("identifiant : normalisé en minuscules, format strict", () => {
  assert.equal(normalizeUsername("  Alice.Martin "), "alice.martin");
  for (const bad of ["ab", "a b", "é-user", "-start", "x".repeat(41), "", null, "a/b"]) {
    assert.throws(() => normalizeUsername(bad), (e) => e instanceof ApiError && e.code === "usernameInvalid", String(bad));
  }
});

/* ------------------------------------- Limitation ------------------------------------- */

test("limitation : blocage après 5 échecs, fenêtre glissante, déblocage, réussite remet à zéro", () => {
  const t = new LoginThrottle(5, 15 * 60_000, 15 * 60_000);
  let now = 1_000_000;
  for (let i = 0; i < 4; i++) t.fail("u:bob", now++);
  assert.equal(t.remaining("u:bob", now), 0);
  t.fail("u:bob", now);
  assert.ok(t.remaining("u:bob", now) > 14 * 60_000);
  assert.equal(t.remaining("u:carol", now), 0, "les autres clés ne sont pas touchées");
  assert.equal(t.remaining("u:bob", now + 15 * 60_000 + 1), 0, "débloqué après la durée");
  // échecs espacés de plus que la fenêtre : jamais bloqué
  const t2 = new LoginThrottle(3, 1000, 60_000);
  for (let i = 0; i < 10; i++) t2.fail("k", i * 2000);
  assert.equal(t2.remaining("k", 20_000), 0);
  // succès : compteur remis à zéro
  const t3 = new LoginThrottle(3, 60_000, 60_000);
  t3.fail("k", 1);
  t3.fail("k", 2);
  t3.success("k");
  t3.fail("k", 3);
  t3.fail("k", 4);
  assert.equal(t3.remaining("k", 5), 0);
});

/* ------------------------------------ Comptes & sessions ------------------------------------ */

test("comptes : application ouverte tant qu'il n'y a aucun compte ; le premier est administrateur", async () => {
  const db = freshDb();
  assert.equal(countUsers(db), 0);
  assert.equal(authEnabled(db), false);
  const first = await createUser({ username: "Root", displayName: "Root", password: PW, role: "viewer" }, db, { bootstrap: true });
  assert.equal(first.role, "admin", "rôle forcé");
  assert.equal(first.username, "root");
  assert.equal(authEnabled(db), true);
  // amorçage refusé s'il y a déjà un compte (course entre deux créations)
  assert.equal(await code(() => createUser({ username: "other", displayName: "O", password: PW }, db, { bootstrap: true })), "forbidden");
  assert.equal(countUsers(db), 1);
});

test("comptes : création (rôle par défaut lecteur), doublon insensible à la casse, validations, aucun hash exposé", async () => {
  const db = freshDb();
  await admin(db);
  const v = await createUser({ username: "bob", displayName: " Bob ", password: PW }, db);
  assert.equal(v.role, "viewer");
  assert.equal(v.displayName, "Bob");
  assert.equal(await code(() => createUser({ username: "BOB", displayName: "x", password: PW }, db)), "usernameTaken");
  assert.equal(await code(() => createUser({ username: "eve", displayName: "", password: PW }, db)), "nameRequired");
  assert.equal(await code(() => createUser({ username: "eve", displayName: "E", password: "court" }, db)), "passwordWeak");
  assert.equal(await code(() => createUser({ username: "eve", displayName: "E", password: PW, role: "root" as never }, db)), "invalidBody");
  assert.equal(listUsers(db).length, 2);
  assert.ok(!JSON.stringify(listUsers(db)).includes("scrypt"), "pas de hash dans les lignes renvoyées");
  const stored = db.prepare("SELECT password_hash FROM users WHERE username = 'bob'").get() as { password_hash: string };
  assert.ok(!stored.password_hash.includes(PW));
});

test("connexion : succès, session, déconnexion ; erreurs identiques pour inconnu / mauvais mot de passe / compte désactivé", async () => {
  const db = freshDb();
  const a = await admin(db);
  const t = new LoginThrottle();
  const ok = await login("ALICE", PW, { throttle: t }, db);
  assert.equal(ok.user.username, "alice");
  assert.ok(ok.token.length >= 40);
  assert.deepEqual(sessionUser(ok.token, db)?.role, "admin");
  assert.ok(getUser(a.id, db).lastLoginAt);
  // le jeton n'est jamais stocké en clair
  const rows = db.prepare("SELECT token_hash FROM user_sessions").all() as { token_hash: string }[];
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, ok.token);
  logout(ok.token, db);
  assert.equal(sessionUser(ok.token, db), null);

  const bad = [
    await code(() => login("alice", "mauvais-mot-de-passe", { throttle: t }, db)),
    await code(() => login("inconnu", PW, { throttle: t }, db)),
    await code(() => login("", "", { throttle: t }, db)),
    await code(() => login(null, 42, { throttle: t }, db)),
  ];
  assert.deepEqual(bad, ["invalidCredentials", "invalidCredentials", "invalidCredentials", "invalidCredentials"]);
  await createUser({ username: "bob", displayName: "B", password: PW, role: "viewer" }, db);
  const bob = listUsers(db).find((u) => u.username === "bob")!;
  await updateUser(bob.id, { active: false }, a.id, db);
  assert.equal(await code(() => login("bob", PW, { throttle: t }, db)), "invalidCredentials");
});

test("connexion : trop d'échecs -> 429 même avec le bon mot de passe, puis déblocage", async () => {
  const db = freshDb();
  await admin(db);
  const t = new LoginThrottle(3, 60_000, 60_000);
  const t0 = new Date("2026-01-01T10:00:00Z");
  for (let i = 0; i < 3; i++) assert.equal(await code(() => login("alice", "faux-mot-de-passe", { throttle: t, now: t0 }, db)), "invalidCredentials");
  try {
    await login("alice", PW, { throttle: t, now: t0 }, db);
    assert.fail("devait être bloqué");
  } catch (e) {
    assert.ok(e instanceof ApiError && e.code === "tooManyAttempts" && e.status === 429 && e.params?.minutes === 1);
  }
  const later = new Date(t0.getTime() + 61_000);
  assert.ok((await login("alice", PW, { throttle: t, now: later }, db)).token);
});

test("sessions : expirent après inactivité ou durée maximale ; l'activité prolonge l'inactivité seulement", async () => {
  const db = freshDb();
  await admin(db);
  const t0 = new Date("2026-01-01T08:00:00Z");
  const { token } = await login("alice", PW, { throttle: new LoginThrottle(), now: t0 }, db);
  const at = (ms: number) => new Date(t0.getTime() + ms);
  assert.ok(sessionUser(token, db, at(SESSION_IDLE_MS - 1000)));
  // activité à H+7h59 -> l'inactivité repart de zéro
  assert.ok(sessionUser(token, db, at(SESSION_IDLE_MS + 5 * 60_000 - 1000)), "activité récente");
  const { token: t2 } = await login("alice", PW, { throttle: new LoginThrottle(), now: t0 }, db);
  assert.equal(sessionUser(t2, db, at(SESSION_IDLE_MS + 1000)), null, "inactif trop longtemps");
  // durée maximale : on reste actif toutes les 7 h, mais la session meurt à 7 jours
  const { token: t3 } = await login("alice", PW, { throttle: new LoginThrottle(), now: t0 }, db);
  for (let h = 7; h <= 7 * 24; h += 7) assert.ok(sessionUser(t3, db, at(h * 3600_000)), `H+${h}`);
  assert.equal(sessionUser(t3, db, at(SESSION_MAX_MS + 3600_000)), null, "durée maximale dépassée");
  assert.equal(sessionUser("n'importe-quoi", db), null);
  assert.equal(sessionUser("", db), null);
  assert.equal(sessionUser(null, db), null);
});

test("sessions : désactiver, supprimer ou réinitialiser le mot de passe ferme les sessions ; le rôle est relu à chaque requête", async () => {
  const db = freshDb();
  const a = await admin(db);
  const b = await createUser({ username: "bob", displayName: "Bob", password: PW, role: "editor" }, db);
  const t = new LoginThrottle();
  const s1 = (await login("bob", PW, { throttle: t }, db)).token;
  assert.equal(sessionUser(s1, db)?.role, "editor");
  await updateUser(b.id, { role: "viewer" }, a.id, db);
  assert.equal(sessionUser(s1, db)?.role, "viewer", "rétrogradation immédiate");
  await updateUser(b.id, { password: "Nouveau-mot-de-passe-9" }, a.id, db);
  assert.equal(sessionUser(s1, db), null, "réinitialisation du mot de passe : sessions fermées");
  const s2 = (await login("bob", "Nouveau-mot-de-passe-9", { throttle: t }, db)).token;
  await updateUser(b.id, { active: false }, a.id, db);
  assert.equal(sessionUser(s2, db), null, "désactivation");
  await updateUser(b.id, { active: true }, a.id, db);
  const s3 = (await login("bob", "Nouveau-mot-de-passe-9", { throttle: t }, db)).token;
  deleteUser(b.id, a.id, db);
  assert.equal(sessionUser(s3, db), null, "suppression");
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM user_sessions").get() as { c: number }).c, 0);
});

test("garde-fous : dernier administrateur, soi-même, inconnu, corps invalide", async () => {
  const db = freshDb();
  const a = await admin(db);
  const b = await admin(db, "bruno");
  // soi-même : ni rôle, ni état, ni suppression
  assert.equal(await code(() => updateUser(a.id, { role: "viewer" }, a.id, db)), "cannotChangeSelf");
  assert.equal(await code(() => updateUser(a.id, { active: false }, a.id, db)), "cannotChangeSelf");
  assert.equal(await code(() => deleteUser(a.id, a.id, db)), "cannotChangeSelf");
  // changer son propre nom affiché reste permis
  assert.equal((await updateUser(a.id, { displayName: "Alice M." }, a.id, db)).displayName, "Alice M.");
  // retirer un admin quand il en reste un autre : permis ; retirer le dernier : refusé
  await updateUser(b.id, { role: "viewer" }, a.id, db);
  assert.equal(await code(() => updateUser(a.id, { role: "viewer" }, null, db)), "lastAdmin");
  assert.equal(await code(() => updateUser(a.id, { active: false }, null, db)), "lastAdmin");
  assert.equal(await code(() => deleteUser(a.id, b.id, db)), "lastAdmin");
  assert.equal(await code(() => updateUser(999, { displayName: "x" }, a.id, db)), "userNotFound");
  assert.equal(await code(() => deleteUser(999, a.id, db)), "userNotFound");
  assert.equal(await code(() => updateUser(a.id, {}, a.id, db)), "invalidBody");
  assert.equal(await code(() => updateUser(a.id, { active: "oui" as never }, null, db)), "invalidBody");
  assert.equal(await code(() => updateUser(b.id, { role: "root" as never }, a.id, db)), "invalidBody");
  assert.equal(listUsers(db).length, 2, "rien n'a été supprimé par erreur");
});

test("mot de passe personnel : exige l'actuel, ferme les AUTRES sessions et garde la courante", async () => {
  const db = freshDb();
  const a = await admin(db);
  const t = new LoginThrottle();
  const s1 = (await login("alice", PW, { throttle: t }, db)).token;
  const s2 = (await login("alice", PW, { throttle: t }, db)).token;
  assert.equal(await code(() => changeOwnPassword(a.id, "faux", "Autre-mot-de-passe-7", s1, db)), "wrongCurrentPassword");
  assert.equal(await code(() => changeOwnPassword(a.id, PW, "court", s1, db)), "passwordWeak");
  assert.ok(sessionUser(s2, db), "un échec ne ferme rien");
  await changeOwnPassword(a.id, PW, "Autre-mot-de-passe-7", s1, db);
  assert.ok(sessionUser(s1, db), "la session courante reste ouverte");
  assert.equal(sessionUser(s2, db), null, "les autres sont fermées");
  assert.equal(await code(() => login("alice", PW, { throttle: t }, db)), "invalidCredentials", "l'ancien mot de passe ne marche plus");
  assert.ok((await login("alice", "Autre-mot-de-passe-7", { throttle: t }, db)).token);
});

test("traductions : tous les codes d'erreur d'authentification existent en français et en anglais", () => {
  const keys = ["authRequired", "forbidden", "invalidCredentials", "tooManyAttempts", "usernameInvalid", "usernameTaken", "passwordWeak", "userNotFound", "lastAdmin", "cannotChangeSelf", "wrongCurrentPassword", "crossOrigin"];
  for (const k of keys) {
    for (const loc of ["fr", "en"] as const) assert.ok((dictionaries[loc].errors as Record<string, string>)[k], `${loc}.errors.${k}`);
  }
});
