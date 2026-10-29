import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { createBackup } from "./appsettings";
import { createUser, login, sessionUser } from "./users";
import { updateSignupConfig } from "./signupsettings";
import { completeReset, isResetAvailable, newResetLimits, startReset, type ResetDeps } from "./passwordreset";
import { RESET_CODE_TTL_MS, RESET_MAX_ATTEMPTS } from "../resetTypes";
import type { MailMessage } from "../mail/smtp";
import { ApiError } from "../types";

const PW = "Correct-Horse-42";
const NEW = "Brand-New-Pass-77";
const T0 = new Date("2026-10-22T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const ctx = { locale: "fr" as const, ip: "203.0.113.5" };

async function code(fn: () => unknown): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
}
async function setup(): Promise<Db> {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  seedDatabase(db);
  await createUser({ username: "boss", displayName: "Boss", password: PW }, db, { bootstrap: true });
  await createUser({ username: "alice", displayName: "Alice", password: PW, email: "alice@example.com" }, db);
  updateSignupConfig({ consoleMode: true }, db);
  return db;
}
function mailbox(): { sent: MailMessage[]; deps: ResetDeps } {
  const sent: MailMessage[] = [];
  return { sent, deps: { deliver: async (_d, m) => void sent.push(m), limits: newResetLimits(), now: T0, makeCode: () => "123456" } };
}

test("réinitialisation : indisponible sans connexion exigée ou sans moyen d'envoi", async () => {
  const empty = new Database(":memory:");
  empty.exec(SCHEMA);
  assert.equal(isResetAvailable(empty), false);
  const db = await setup();
  assert.equal(isResetAvailable(db), true);
  updateSignupConfig({ consoleMode: false }, db);
  assert.equal(isResetAvailable(db), false);
  assert.equal(await code(() => startReset({ email: "alice@example.com" }, ctx, db, mailbox().deps)), "resetUnavailable");
});

test("réinitialisation : même réponse pour une adresse inconnue, et rien n'est envoyé", async () => {
  const db = await setup();
  const m = mailbox();
  const known = startReset({ email: "Alice@Example.com" }, ctx, db, m.deps);
  const unknown = startReset({ email: "nobody@example.com" }, ctx, db, m.deps);
  await Promise.all([known.done, unknown.done]);
  assert.equal(known.expiresInMs, unknown.expiresInMs);
  assert.equal(m.sent.length, 1);
  assert.equal(m.sent[0].to, "alice@example.com");
  assert.match(m.sent[0].text, /123456/);
  assert.equal(await code(() => startReset({ email: "pas-un-mail" }, ctx, db, m.deps)), "emailInvalid");
});

test("réinitialisation : le bon code change le mot de passe, ferme les sessions, usage unique", async () => {
  const db = await setup();
  const m = mailbox();
  const old = await login("alice", PW, {}, db);
  await startReset({ email: "alice@example.com" }, ctx, db, m.deps).done;
  const raw = db.prepare("SELECT code_hash FROM password_resets").get() as { code_hash: string };
  assert.ok(!raw.code_hash.includes("123456"));
  const r = await completeReset({ email: "alice@example.com", code: "123456", newPassword: NEW }, ctx, db, m.deps);
  assert.equal(r.username, "alice");
  assert.equal(sessionUser(old.token, db, T0), null);
  assert.equal(await code(() => login("alice", PW, {}, db)), "invalidCredentials");
  assert.ok((await login("alice", NEW, {}, db)).token);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM password_resets").get() as { c: number }).c, 0);
  assert.equal(await code(() => completeReset({ email: "alice@example.com", code: "123456", newPassword: NEW }, ctx, db, m.deps)), "resetNoRequest");
});

test("réinitialisation : mauvais code (essais comptés puis demande détruite), expiration", async () => {
  const db = await setup();
  const m = mailbox();
  await startReset({ email: "alice@example.com" }, ctx, db, m.deps).done;
  const bad = () => completeReset({ email: "alice@example.com", code: "000000", newPassword: NEW }, ctx, db, m.deps);
  for (let i = 1; i < RESET_MAX_ATTEMPTS; i++) assert.equal(await code(bad), "resetCodeInvalid");
  assert.equal(await code(bad), "resetTooManyAttempts");
  assert.equal(await code(() => completeReset({ email: "alice@example.com", code: "123456", newPassword: NEW }, ctx, db, m.deps)), "resetNoRequest");

  await startReset({ email: "alice@example.com" }, ctx, db, m.deps).done;
  const late = { ...m.deps, now: at(RESET_CODE_TTL_MS + 1000) };
  assert.equal(await code(() => completeReset({ email: "alice@example.com", code: "123456", newPassword: NEW }, ctx, db, late)), "resetCodeExpired");
  assert.equal(await code(() => completeReset({ email: "ghost@example.com", code: "123456", newPassword: NEW }, ctx, db, m.deps)), "resetNoRequest");
});

test("réinitialisation : un mot de passe refusé ne brûle pas le code", async () => {
  const db = await setup();
  const m = mailbox();
  await startReset({ email: "alice@example.com" }, ctx, db, m.deps).done;
  assert.ok(await code(() => completeReset({ email: "alice@example.com", code: "123456", newPassword: "court" }, ctx, db, m.deps)));
  assert.ok((await completeReset({ email: "alice@example.com", code: "123456", newPassword: NEW }, ctx, db, m.deps)).userId > 0);
});

test("réinitialisation : échec d'envoi = pas de demande orpheline ; limites de débit ; compte désactivé ignoré", async () => {
  const db = await setup();
  const failing: ResetDeps = { ...mailbox().deps, deliver: async () => { throw new Error("smtp down"); } };
  const origErr = console.error;
  console.error = () => {};
  try {
    await startReset({ email: "alice@example.com" }, ctx, db, failing).done;
  } finally {
    console.error = origErr;
  }
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM password_resets").get() as { c: number }).c, 0);

  const m = mailbox();
  for (let i = 0; i < 3; i++) startReset({ email: "alice@example.com" }, ctx, db, m.deps);
  assert.equal(await code(() => startReset({ email: "alice@example.com" }, ctx, db, m.deps)), "signupTooManyRequests");

  const db2 = await setup();
  db2.prepare("UPDATE users SET active = 0 WHERE username = 'alice'").run();
  const m2 = mailbox();
  await startReset({ email: "alice@example.com" }, ctx, db2, m2.deps).done;
  assert.equal(m2.sent.length, 0);
});

test("réinitialisation : les demandes en cours ne sont pas dans la sauvegarde", async () => {
  const db = await setup();
  const m = mailbox();
  await startReset({ email: "alice@example.com" }, ctx, db, m.deps).done;
  const salt = (db.prepare("SELECT code_salt FROM password_resets").get() as { code_salt: string }).code_salt;
  const bak = createBackup(db);
  assert.ok(!bak.includes(Buffer.from(salt)), "pas de demande de réinitialisation dans la sauvegarde");
});
