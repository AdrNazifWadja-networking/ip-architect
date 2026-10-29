import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { createUser, deleteUser, sessionUser, updateUser } from "./users";
import { authenticateToken, createToken, listTokens, revokeToken } from "./tokens";
import { TOKEN_MAX_ACTIVE, TOKEN_PATTERN } from "../tokenTypes";
import { ApiError, type SessionUser } from "../types";

const PW = "Correct-Horse-42";
const T0 = new Date("2026-10-23T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const DAY = 86_400_000;

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
async function setup() {
  const db = freshDb();
  const boss = await createUser({ username: "boss", displayName: "Boss", password: PW, role: "admin" }, db, { bootstrap: true });
  const ed = await createUser({ username: "edith", displayName: "Edith", password: PW, role: "editor" }, db);
  const vw = await createUser({ username: "victor", displayName: "Victor", password: PW, role: "viewer" }, db);
  const su = (u: { id: number; username: string; displayName: string; role: string }): SessionUser => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role as SessionUser["role"], projectScope: "all" });
  return { db, boss: su(boss), ed: su(ed), vw: su(vw) };
}

test("jeton : forme ipa_ + 256 bits, valeur en clair jamais stockée, début seulement dans la liste", async () => {
  const { db, ed } = await setup();
  const { token, row } = createToken(ed, { name: "  export   nocturne ", role: "editor" }, db, T0);
  assert.ok(TOKEN_PATTERN.test(token) && token.startsWith("ipa_") && token.length === 4 + 43);
  assert.equal(row.name, "export nocturne");
  assert.equal(row.prefix, token.slice(0, 8));
  assert.equal(row.role, "editor");
  assert.equal(row.status, "active");
  // la base ne contient ni le jeton ni rien qui le contienne
  const dump = JSON.stringify(db.prepare("SELECT * FROM api_tokens").all());
  assert.ok(!dump.includes(token) && !dump.includes(token.slice(8)));
  assert.ok(!JSON.stringify(listTokens(db)).includes(token.slice(8)));
  assert.ok(!("token_hash" in listTokens(db)[0]) && !("tokenHash" in listTokens(db)[0]));
  // deux jetons ne se ressemblent pas
  assert.notEqual(createToken(ed, { name: "b" }, db, T0).token, token);
});

test("jeton : validation du nom, des droits et de la validité", async () => {
  const { db, boss, ed, vw } = await setup();
  assert.equal(await code(() => createToken(ed, {}, db, T0)), "tokenNameRequired");
  assert.equal(await code(() => createToken(ed, { name: "   " }, db, T0)), "tokenNameRequired");
  assert.equal(await code(() => createToken(ed, { name: "x".repeat(61) }, db, T0)), "tokenNameTooLong");
  assert.equal(await code(() => createToken(ed, { name: "a", role: "admin" }, db, T0)), "tokenRoleInvalid");
  assert.equal(await code(() => createToken(boss, { name: "a", role: "admin" }, db, T0)), "tokenRoleInvalid", "même un administrateur n'obtient pas de jeton admin");
  assert.equal(await code(() => createToken(ed, { name: "a", role: "root" }, db, T0)), "tokenRoleInvalid");
  assert.equal(await code(() => createToken(vw, { name: "a", role: "editor" }, db, T0)), "tokenRoleForbidden");
  assert.equal(await code(() => createToken(vw, { name: "a", role: "viewer" }, db, T0)), null);
  assert.equal(await code(() => createToken(ed, { name: "a", role: "editor" }, db, T0)), null);
  for (const bad of [-1, 1.5, "30", 731, null, NaN]) assert.equal(await code(() => createToken(ed, { name: "a", expiresInDays: bad }, db, T0)), "tokenExpiryInvalid", String(bad));
  assert.equal(await code(() => createToken(ed, null as never, db, T0)), "invalidBody");
  // le rôle par défaut est le plus faible
  assert.equal(createToken(ed, { name: "def" }, db, T0).row.role, "viewer");
});

test("jeton : validité par défaut 90 jours, 0 = sans expiration, refusé à l'instant d'expiration", async () => {
  const { db, ed } = await setup();
  const def = createToken(ed, { name: "def" }, db, T0);
  assert.equal(def.row.expiresAt, new Date(T0.getTime() + 90 * DAY).toISOString());
  const never = createToken(ed, { name: "never", expiresInDays: 0 }, db, T0);
  assert.equal(never.row.expiresAt, null);
  const short = createToken(ed, { name: "short", expiresInDays: 30 }, db, T0);
  assert.ok(authenticateToken(short.token, db, at(30 * DAY - 1)));
  assert.equal(authenticateToken(short.token, db, at(30 * DAY)), null);
  assert.equal(listTokens(db, {}, at(31 * DAY)).find((t) => t.name === "short")!.status, "expired");
  assert.ok(authenticateToken(never.token, db, at(3650 * DAY)), "sans expiration : toujours valable");
});

test("jeton : 20 jetons actifs au plus par compte ; révoquer ou expirer libère une place", async () => {
  const { db, ed, vw } = await setup();
  const made = Array.from({ length: TOKEN_MAX_ACTIVE }, (_, i) => createToken(ed, { name: `t${i}`, expiresInDays: 30 }, db, T0));
  assert.equal(await code(() => createToken(ed, { name: "extra" }, db, T0)), "tokenLimit");
  assert.equal(await code(() => createToken(vw, { name: "autre compte" }, db, T0)), null, "la limite est par compte");
  revokeToken(made[0].row.id, ed, db, T0);
  assert.equal(await code(() => createToken(ed, { name: "ok" }, db, T0)), null);
  assert.equal(await code(() => createToken(ed, { name: "extra2" }, db, T0)), "tokenLimit");
  // 31 jours plus tard, les 19 jetons de 30 jours ont expiré
  assert.equal(await code(() => createToken(ed, { name: "later" }, db, at(31 * DAY))), null);
});

test("authentification : jeton valide -> compte et rôle ; formes invalides, inconnus et cookies refusés", async () => {
  const { db, ed } = await setup();
  const { token, row } = createToken(ed, { name: "ci", role: "editor" }, db, T0);
  const a = authenticateToken(token, db, at(1000))!;
  assert.deepEqual(a.user, { id: ed.id, username: "edith", displayName: "Edith", role: "editor", projectScope: "all" });
  assert.equal(a.tokenId, row.id);
  assert.equal(a.prefix, token.slice(0, 8));
  for (const bad of ["", "ipa_", "ipa_court", "x".repeat(47), token.slice(1), token + "x", token.replace("ipa_", "ipb_"), `ipa_${"A".repeat(43)}`, "Bearer " + token, token.toLowerCase()]) {
    assert.equal(authenticateToken(bad, db, at(1000)), null, bad);
  }
  // un jeton n'est pas un jeton de session, et inversement
  assert.equal(sessionUser(token, db), null);
});

test("authentification : le rôle effectif est plafonné par le propriétaire, à tout moment", async () => {
  const { db, boss, ed } = await setup();
  const rw = createToken(ed, { name: "rw", role: "editor" }, db, T0);
  const adminRead = createToken(boss, { name: "ro", role: "viewer" }, db, T0);
  const adminRw = createToken(boss, { name: "rw", role: "editor" }, db, T0);
  assert.equal(authenticateToken(adminRead.token, db, at(1))!.user.role, "viewer");
  assert.equal(authenticateToken(adminRw.token, db, at(1))!.user.role, "editor", "jamais admin, même pour le propriétaire admin");
  // l'éditeur est rétrogradé : son jeton « écriture » ne vaut plus que lecture
  await updateUser(ed.id, { role: "viewer" }, boss.id, db);
  assert.equal(authenticateToken(rw.token, db, at(2))!.user.role, "viewer");
  // et remonté : le jeton retrouve son rôle
  await updateUser(ed.id, { role: "editor" }, boss.id, db);
  assert.equal(authenticateToken(rw.token, db, at(3))!.user.role, "editor");
});

test("authentification : compte désactivé ou supprimé, jeton révoqué -> refus immédiat", async () => {
  const { db, boss, ed, vw } = await setup();
  const a = createToken(ed, { name: "a", role: "editor" }, db, T0);
  const b = createToken(vw, { name: "b" }, db, T0);
  const c = createToken(ed, { name: "c" }, db, T0);
  await updateUser(ed.id, { active: false }, boss.id, db);
  assert.equal(authenticateToken(a.token, db, at(1)), null);
  await updateUser(ed.id, { active: true }, boss.id, db);
  assert.ok(authenticateToken(a.token, db, at(2)));
  revokeToken(a.row.id, ed, db, at(3));
  assert.equal(authenticateToken(a.token, db, at(4)), null);
  assert.ok(authenticateToken(c.token, db, at(4)), "les autres jetons du compte ne sont pas touchés");
  deleteUser(vw.id, boss.id, db);
  assert.equal(authenticateToken(b.token, db, at(5)), null);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM api_tokens WHERE user_id = ?").get(vw.id) as { c: number }).c, 0, "supprimés avec le compte");
});

test("révocation : propriétaire ou administrateur ; un autre compte ne voit même pas le jeton ; idempotente", async () => {
  const { db, boss, ed, vw } = await setup();
  const t = createToken(ed, { name: "x" }, db, T0);
  assert.equal(await code(() => revokeToken(t.row.id, vw, db, T0)), "tokenNotFound", "404 et non 403 : pas de sondage d'identifiants");
  assert.equal(await code(() => revokeToken(9999, ed, db, T0)), "tokenNotFound");
  assert.equal(authenticateToken(t.token, db, at(1))!.user.id, ed.id);
  const r1 = revokeToken(t.row.id, boss, db, at(10));
  assert.equal(r1.status, "revoked");
  const when = (db.prepare("SELECT revoked_at FROM api_tokens WHERE id = ?").get(t.row.id) as { revoked_at: string }).revoked_at;
  assert.equal(when, at(10).toISOString());
  revokeToken(t.row.id, ed, db, at(99999)); // idempotent : la date d'origine est conservée
  assert.equal((db.prepare("SELECT revoked_at FROM api_tokens WHERE id = ?").get(t.row.id) as { revoked_at: string }).revoked_at, when);
  assert.equal(authenticateToken(t.token, db, at(11)), null);
  assert.equal(listTokens(db).find((x) => x.id === t.row.id)!.status, "revoked", "la ligne est conservée");
});

test("liste : par compte ou pour tous, plus récents d'abord ; dernière utilisation écrite au plus une fois par minute", async () => {
  const { db, ed, vw } = await setup();
  const a = createToken(ed, { name: "a" }, db, T0);
  createToken(vw, { name: "b" }, db, T0);
  createToken(ed, { name: "c" }, db, T0);
  assert.deepEqual(listTokens(db, { userId: ed.id }, T0).map((t) => t.name), ["c", "a"]);
  assert.equal(listTokens(db, {}, T0).length, 3);
  assert.equal(listTokens(db, { userId: ed.id }, T0)[1].lastUsedAt, null);
  authenticateToken(a.token, db, at(1000));
  assert.equal(listTokens(db, { userId: ed.id })[1].lastUsedAt, at(1000).toISOString());
  authenticateToken(a.token, db, at(30_000)); // moins d'une minute : pas d'écriture
  assert.equal(listTokens(db, { userId: ed.id })[1].lastUsedAt, at(1000).toISOString());
  authenticateToken(a.token, db, at(62_000));
  assert.equal(listTokens(db, { userId: ed.id })[1].lastUsedAt, at(62_000).toISOString());
});
