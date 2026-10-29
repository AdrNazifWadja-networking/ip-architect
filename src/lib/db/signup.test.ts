import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { createBackup } from "./appsettings";
import { createUser, login, sessionUser, updateUser } from "./users";
import { getSignupConfig, getSmtpSecret, isSignupOpen, updateSignupConfig } from "./signupsettings";
import { newSignupLimits, startSignup, verifySignup, type SignupDeps } from "./signup";
import { SIGNUP_CODE_TTL_MS, SIGNUP_MAX_ATTEMPTS } from "../signupTypes";
import type { MailMessage } from "../mail/smtp";
import { ApiError } from "../types";

const PW = "Correct-Horse-42";
const T0 = new Date("2026-10-22T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

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
/** Base avec un administrateur (la connexion est donc exigée) et l'inscription ouverte en mode console. */
async function openDb(domains = ""): Promise<Db> {
  const db = freshDb();
  await createUser({ username: "boss", displayName: "Boss", password: PW }, db, { bootstrap: true });
  updateSignupConfig({ enabled: true, consoleMode: true, domains }, db);
  return db;
}
function mailbox() {
  const sent: MailMessage[] = [];
  const deps: SignupDeps = {
    deliver: async (_db, m) => void sent.push(m),
    limits: newSignupLimits(),
    now: T0,
  };
  const lastCode = () => /\b(\d{6})\b/.exec(sent[sent.length - 1].text)![1];
  return { sent, deps, lastCode };
}
const ctx = { locale: "fr" as const, ip: "203.0.113.5" };
const form = (over: Record<string, unknown> = {}) => ({ email: "alice@example.com", username: "alice", displayName: "Alice", password: PW, ...over });
const pending = (db: Db) => (db.prepare("SELECT COUNT(*) AS c FROM signup_requests").get() as { c: number }).c;
const users = (db: Db) => (db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c;

test("inscription : fermée par défaut, et fermée tant que la connexion n'est pas exigée", async () => {
  const db = freshDb();
  const m = mailbox();
  assert.equal(await code(() => startSignup(form(), ctx, db, m.deps)), "signupUnavailable");
  updateSignupConfig({ enabled: true, consoleMode: true }, db);
  assert.equal(isSignupOpen(db), false, "aucun compte : l'application est ouverte, pas d'inscription");
  assert.equal(await code(() => startSignup(form(), ctx, db, m.deps)), "signupUnavailable");
  assert.equal(await code(() => verifySignup({ email: "alice@example.com", code: "123456" }, ctx, db, m.deps)), "signupUnavailable");
  await createUser({ username: "boss", displayName: "Boss", password: PW }, db, { bootstrap: true });
  assert.equal(isSignupOpen(db), true);
});

test("inscription : parcours complet — code par e-mail, compte « lecteur », e-mail vérifié, session ouverte", async () => {
  const db = await openDb();
  const m = mailbox();
  const r = await startSignup(form(), ctx, db, m.deps);
  assert.equal(r.expiresInMs, SIGNUP_CODE_TTL_MS);
  assert.equal(SIGNUP_CODE_TTL_MS, 120_000);
  assert.equal(m.sent.length, 1);
  assert.equal(m.sent[0].to, "alice@example.com");
  assert.match(m.sent[0].text, /2 minutes/);
  assert.equal(users(db), 1, "aucun compte avant la vérification");

  const v = await verifySignup({ email: "ALICE@example.com", code: m.lastCode() }, ctx, db, { ...m.deps, now: at(60_000) });
  assert.equal(v.user.role, "viewer");
  assert.equal(v.user.username, "alice");
  assert.equal(pending(db), 0);
  const row = db.prepare("SELECT email, email_verified_at, role FROM users WHERE username = 'alice'").get() as { email: string; email_verified_at: string | null; role: string };
  assert.equal(row.email, "alice@example.com");
  assert.ok(row.email_verified_at);
  assert.equal(sessionUser(v.token, db, at(60_000))?.username, "alice");
  assert.equal((await login("alice", PW, {}, db)).user.role, "viewer", "le mot de passe choisi fonctionne");
});

test("inscription : code valable 2 minutes — expiré, il faut recommencer", async () => {
  const db = await openDb();
  const m = mailbox();
  await startSignup(form(), ctx, db, m.deps);
  const c = m.lastCode();
  // pile à 2 minutes : encore valable ; une milliseconde après : expiré
  assert.equal(await code(() => verifySignup({ email: "alice@example.com", code: c }, ctx, db, { ...m.deps, now: at(SIGNUP_CODE_TTL_MS + 1) })), "signupCodeExpired");
  assert.equal(pending(db), 0, "la demande expirée est supprimée");
  assert.equal(users(db), 1);
  assert.equal(await code(() => verifySignup({ email: "alice@example.com", code: c }, ctx, db, { ...m.deps, now: at(SIGNUP_CODE_TTL_MS + 2) })), "signupNoRequest");
  // recommencer fonctionne, avec un nouveau code
  await startSignup(form(), ctx, db, { ...m.deps, now: at(5 * 60_000) });
  const v = await verifySignup({ email: "alice@example.com", code: m.lastCode() }, ctx, db, { ...m.deps, now: at(5 * 60_000 + SIGNUP_CODE_TTL_MS) });
  assert.equal(v.user.username, "alice");
});

test("inscription : mauvais code — essais comptés, puis la demande est supprimée", async () => {
  const db = await openDb();
  const m = mailbox();
  await startSignup(form(), ctx, db, { ...m.deps, makeCode: () => "424242" });
  for (let i = 1; i < SIGNUP_MAX_ATTEMPTS; i++) {
    const e = await (async () => { try { await verifySignup({ email: "alice@example.com", code: "000000" }, ctx, db, m.deps); } catch (x) { return x as ApiError; } })();
    assert.equal(e!.code, "signupCodeInvalid");
    assert.equal(e!.params!.left, SIGNUP_MAX_ATTEMPTS - i);
  }
  assert.equal(await code(() => verifySignup({ email: "alice@example.com", code: "000000" }, ctx, db, m.deps)), "signupTooManyAttempts");
  assert.equal(await code(() => verifySignup({ email: "alice@example.com", code: "424242" }, ctx, db, m.deps)), "signupNoRequest", "même le bon code ne marche plus");
  assert.equal(users(db), 1);
  for (const bad of [undefined, null, 123456, "12345", "1234567", "abcdef", " 424242"]) {
    await startSignup(form(), ctx, db, { ...m.deps, makeCode: () => "424242", limits: newSignupLimits() });
    assert.equal(await code(() => verifySignup({ email: "alice@example.com", code: bad }, ctx, db, m.deps)), "signupCodeInvalid", String(bad));
  }
});

test("inscription : un nouveau départ remplace le code précédent ; le code n'est jamais stocké en clair", async () => {
  const db = await openDb();
  const m = mailbox();
  await startSignup(form(), ctx, db, { ...m.deps, makeCode: () => "111111" });
  await startSignup(form(), ctx, db, { ...m.deps, makeCode: () => "222222" });
  assert.equal(pending(db), 1);
  const dump = JSON.stringify(db.prepare("SELECT * FROM signup_requests").all());
  assert.ok(!dump.includes("111111") && !dump.includes("222222") && !dump.includes(PW), "ni code ni mot de passe en clair");
  assert.match(dump, /scrypt\$/);
  assert.equal(await code(() => verifySignup({ email: "alice@example.com", code: "111111" }, ctx, db, m.deps)), "signupCodeInvalid");
  assert.equal((await verifySignup({ email: "alice@example.com", code: "222222" }, ctx, db, m.deps)).user.role, "viewer");
});

test("inscription : adresse déjà utilisée non révélée ; identifiant pris ; réservation par une demande valide", async () => {
  const db = await openDb();
  await createUser({ username: "bob", displayName: "Bob", password: PW, email: "bob@example.com" }, db);
  const m = mailbox();
  const before = users(db);
  const r = await startSignup(form({ email: "bob@example.com" }), ctx, db, m.deps);
  assert.equal(r.expiresInMs, SIGNUP_CODE_TTL_MS, "même réponse que pour une adresse libre");
  assert.equal(pending(db), 0);
  assert.equal(users(db), before);
  assert.match(m.sent[0].subject, /déjà un compte/);
  assert.ok(!/\b\d{6}\b/.test(m.sent[0].text), "pas de code dans ce message");
  assert.equal(await code(() => startSignup(form({ email: "new@example.com", username: "BOB" }), ctx, db, m.deps)), "usernameTaken");
  await startSignup(form(), ctx, db, m.deps);
  assert.equal(await code(() => startSignup(form({ email: "other@example.com" }), ctx, db, m.deps)), "usernameTaken", "identifiant réservé 2 minutes");
});

test("inscription : validations (adresse, identifiant, mot de passe, nom) et domaines autorisés", async () => {
  const db = await openDb("exemple.fr, @example.com");
  const m = mailbox();
  const cases: [Record<string, unknown>, string][] = [
    [{ email: "pas-une-adresse" }, "emailInvalid"],
    [{ email: "x@gmail.com" }, "signupDomainNotAllowed"],
    [{ username: "A" }, "usernameInvalid"],
    [{ password: "court" }, "passwordWeak"],
    [{ password: "alice-alice-alice" }, "passwordWeak"],
    [{ displayName: "  " }, "nameRequired"],
    [{ displayName: "x".repeat(81) }, "nameTooLong"],
  ];
  for (const [over, want] of cases) assert.equal(await code(() => startSignup(form(over), ctx, db, { ...m.deps, limits: newSignupLimits() })), want, JSON.stringify(over));
  assert.equal(m.sent.length, 0, "aucun e-mail pour une demande invalide");
  assert.equal(pending(db), 0);
  await startSignup(form({ email: "ok@exemple.fr", username: "okfr" }), ctx, db, m.deps);
  assert.equal(m.sent.length, 1);
});

test("inscription : limites de débit (par adresse et par IP) et échec d'envoi sans demande orpheline", async () => {
  const db = await openDb();
  const m = mailbox();
  for (let i = 0; i < 3; i++) await startSignup(form(), ctx, db, m.deps);
  assert.equal(await code(() => startSignup(form(), ctx, db, m.deps)), "signupTooManyRequests", "4e demande pour la même adresse");
  assert.equal((await startSignup(form(), ctx, db, { ...m.deps, now: at(11 * 60_000) })).expiresInMs, SIGNUP_CODE_TTL_MS, "la fenêtre se libère");
  const m2 = mailbox();
  for (let i = 0; i < 10; i++) await startSignup(form({ email: `u${i}@example.com`, username: `user${i}` }), ctx, db, m2.deps);
  assert.equal(await code(() => startSignup(form({ email: "u11@example.com", username: "user11" }), ctx, db, m2.deps)), "signupTooManyRequests", "11e demande depuis la même IP");

  const failing = mailbox();
  failing.deps.deliver = async () => {
    throw new ApiError("mailUnreachable", 502, { host: "smtp.example.com" });
  };
  assert.equal(await code(() => startSignup(form({ email: "z@example.com", username: "zed" }), { ...ctx, ip: "198.51.100.9" }, db, failing.deps)), "mailUnreachable");
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM signup_requests WHERE email = 'z@example.com'").get() as { c: number }).c, 0);
  const v = mailbox();
  assert.equal(await code(() => verifySignup({ email: "alice@example.com", code: "123456" }, ctx, db, { ...v.deps, limits: (() => { const l = newSignupLimits(); for (let i = 0; i < 30; i++) l.verifyByIp.take("ip:203.0.113.5", T0.getTime()); return l; })() })), "signupTooManyRequests");
});

test("administrateur : toujours administrateur ; seul lui promeut ; l'inscription ne crée jamais d'administrateur", async () => {
  const db = await openDb();
  const m = mailbox();
  await startSignup(form(), ctx, db, m.deps);
  const v = await verifySignup({ email: "alice@example.com", code: m.lastCode() }, ctx, db, m.deps);
  assert.equal(v.user.role, "viewer");
  const boss = db.prepare("SELECT id, role, active FROM users WHERE username = 'boss'").get() as { id: number; role: string; active: number };
  assert.equal(boss.role, "admin");
  assert.equal(await code(() => updateUser(v.userId, { role: "admin" }, boss.id, db).then(() => null)), null, "l'administrateur peut promouvoir");
  assert.equal(sessionUser(v.token, db, T0)?.role, "admin", "le rôle est relu en base : effet immédiat");
  assert.equal(await code(() => updateUser(boss.id, { role: "viewer" }, boss.id, db)), "cannotChangeSelf");
});

test("e-mail d'un compte : validation, unicité sans tenir compte de la casse, modification = non vérifié", async () => {
  const db = await openDb();
  assert.equal(await code(() => createUser({ username: "carl1", displayName: "C", password: PW, email: "pas-valide" }, db)), "emailInvalid");
  const c = await createUser({ username: "carl1", displayName: "C", password: PW, email: "Carl@Example.com" }, db);
  assert.equal(c.email, "carl@example.com");
  assert.equal(c.emailVerified, false);
  assert.equal(await code(() => createUser({ username: "carl2", displayName: "C", password: PW, email: "CARL@example.com" }, db)), "emailTaken");
  const d = await createUser({ username: "dora3", displayName: "D", password: PW }, db);
  assert.equal(d.email, null);
  assert.equal(await code(() => updateUser(d.id, { email: "carl@example.com" }, null, db)), "emailTaken");
  assert.equal((await updateUser(d.id, { email: "d@example.com" }, null, db)).email, "d@example.com");
  assert.equal((await updateUser(d.id, { email: null }, null, db)).email, null);
});

test("réglages : validation, secrets jamais renvoyés, retirés des sauvegardes", async () => {
  const db = freshDb();
  const bad: Record<string, unknown>[] = [
    { smtpHost: "mail server" }, { smtpPort: 0 }, { smtpPort: "abc" }, { smtpSecurity: "ssl" }, { smtpFrom: "pas-une-adresse" }, { domains: ["pas un domaine"] },
    { smtpHost: "smtp.example.com", smtpSecurity: "none" }, { smtpUser: "u" }, { enabled: true }, { enabled: "oui" },
  ];
  for (const b of bad) assert.ok(["signupInvalidConfig", "signupNotConfigured", "invalidBody"].includes((await code(() => updateSignupConfig(b, db))) ?? "ok"), JSON.stringify(b));
  assert.equal(getSignupConfig(db).enabled, false, "rien d'écrit après un refus");
  assert.equal(await code(() => updateSignupConfig({ smtpHost: "localhost", smtpSecurity: "none", smtpPort: 1025 }, db)), null, "« aucune sécurité » acceptée vers la machine locale");

  const cfg = updateSignupConfig({ smtpHost: "SMTP.Gmail.com", smtpPort: "465", smtpSecurity: "tls", smtpUser: "me@gmail.com", smtpPassword: "abcd efgh ijkl mnop", smtpFrom: "Me@Gmail.com", domains: "Exemple.FR, @example.com exemple.fr" }, db);
  assert.equal(cfg.smtp.host, "smtp.gmail.com");
  assert.equal(cfg.smtp.from, "me@gmail.com");
  assert.deepEqual(cfg.domains, ["exemple.fr", "example.com"]);
  assert.equal(cfg.smtp.hasPassword, true);
  assert.ok(!JSON.stringify(cfg).includes("abcd"));
  assert.equal(getSmtpSecret(db), "abcdefghijklmnop", "espaces d'affichage retirés pour Gmail");
  updateSignupConfig({ smtpPort: 587 }, db);
  assert.equal(getSmtpSecret(db), "abcdefghijklmnop", "inchangé si non renvoyé");

  db.prepare("INSERT INTO signup_requests (email, username, display_name, password_hash, code_salt, code_hash, expires_at, created_at) VALUES ('x@y.fr','x','X','h','s','c','2099-01-01','2026-01-01')").run();
  const copy = createBackup(db);
  assert.ok(!copy.includes(Buffer.from("abcdefghijklmnop")), "pas de mot de passe SMTP dans la sauvegarde");
  assert.ok(!copy.includes(Buffer.from("x@y.fr")), "pas d'inscription en attente dans la sauvegarde");
  updateSignupConfig({ smtpPassword: "", smtpUser: "" }, db);
  assert.equal(getSignupConfig(db).smtp.hasPassword, false);
});
