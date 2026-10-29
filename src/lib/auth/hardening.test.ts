import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "../db";
import { seedDatabase } from "../db/seed";
import { assertSetupCode, clearSetupCode, getSetupCode, setupActive, setupRequired } from "./setup";
import { clientIpFrom, secureCookie, trustProxy } from "./proxy";
import { assertBodySize, bodyTooLarge, MAX_BODY_BYTES } from "./bodylimit";
import { securityHeaders } from "../securityHeaders.mjs";
import { changeOwnPassword, createUser } from "../db/users";
import { getThrottle } from "./throttle";
import { ApiError } from "../types";

function emptyDb(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
const code = (fn: () => unknown): string | null => {
  try { fn(); return null; } catch (e) { if (e instanceof ApiError) return e.code; throw e; }
};
const codeA = async (fn: () => Promise<unknown>): Promise<string | null> => {
  try { await fn(); return null; } catch (e) { if (e instanceof ApiError) return e.code; throw e; }
};

test("code d'installation : exigé en production seulement, forçable par variable", () => {
  assert.equal(setupRequired({ NODE_ENV: "production" }), true);
  assert.equal(setupRequired({ NODE_ENV: "development" }), false);
  assert.equal(setupRequired({ NODE_ENV: "development", IP_ARCHITECT_REQUIRE_SETUP_CODE: "1" }), true);
  assert.equal(setupRequired({ NODE_ENV: "production", IP_ARCHITECT_REQUIRE_SETUP_CODE: "0" }), false);
});

test("code d'installation : actif tant qu'aucun compte n'existe ; code stable, fixé par variable ; refus et blocage ; effacé après usage", async () => {
  const db = emptyDb();
  const prod = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
  assert.equal(setupActive(db, prod), true);
  assert.equal(setupActive(db, { NODE_ENV: "development" } as NodeJS.ProcessEnv), false);
  const c = getSetupCode(db, prod);
  assert.match(c, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(getSetupCode(db, prod), c, "le même code à chaque lecture");
  assert.equal(getSetupCode(db, { NODE_ENV: "production", IP_ARCHITECT_SETUP_CODE: " MON-CODE " } as NodeJS.ProcessEnv), "MON-CODE");
  // vérification : bon code (casse et espaces tolérés), mauvais code, absent
  assert.equal(code(() => assertSetupCode(c.toLowerCase() + " ", db, prod)), null);
  getThrottle().success("setup");
  assert.equal(code(() => assertSetupCode("AAAA-AAAA-AAAA", db, prod)), "setupCodeInvalid");
  assert.equal(code(() => assertSetupCode(undefined, db, prod)), "setupCodeInvalid");
  assert.equal(code(() => assertSetupCode(12345, db, prod)), "setupCodeInvalid");
  // hors production : pas de code à fournir
  assert.equal(code(() => assertSetupCode(undefined, db, { NODE_ENV: "development" } as NodeJS.ProcessEnv)), null);
  // 5 essais ratés bloquent même le bon code
  getThrottle().success("setup");
  for (let i = 0; i < 5; i++) code(() => assertSetupCode("FAUX", db, prod));
  assert.equal(code(() => assertSetupCode(c, db, prod)), "tooManyAttempts");
  getThrottle().success("setup");
  // le premier compte créé, l'installation est terminée et le code disparaît
  await createUser({ username: "root", displayName: "Root", password: "Correct-Horse-42" }, db, { bootstrap: true });
  assert.equal(setupActive(db, prod), false);
  clearSetupCode(db);
  assert.equal(db.prepare("SELECT 1 FROM settings WHERE key = 'setup_code'").get(), undefined);
});

test("proxy : X-Forwarded-* ignorés sans proxy de confiance, lus avec ; cookie Secure", () => {
  const h = (m: Record<string, string>) => (n: string) => m[n] ?? null;
  const spoof = h({ "x-forwarded-for": "203.0.113.9, 10.0.0.1", "x-forwarded-proto": "https" });
  assert.equal(trustProxy({}), false);
  assert.equal(clientIpFrom(spoof, {}), null, "sans proxy déclaré, une adresse envoyée par le client n'est pas crue");
  assert.equal(clientIpFrom(spoof, { IP_ARCHITECT_TRUST_PROXY: "1" }), "203.0.113.9");
  assert.equal(clientIpFrom(h({ "x-forwarded-for": "pas-une-ip" }), { IP_ARCHITECT_TRUST_PROXY: "1" }), null);
  assert.equal(clientIpFrom(h({}), { IP_ARCHITECT_TRUST_PROXY: "1" }), null);
  assert.equal(secureCookie(spoof, "http:", {}), false, "un client ne peut pas se faire passer pour du HTTPS");
  assert.equal(secureCookie(spoof, "http:", { IP_ARCHITECT_TRUST_PROXY: "1" }), true);
  assert.equal(secureCookie(h({}), "https:", {}), true);
  assert.equal(secureCookie(h({}), "http:", { IP_ARCHITECT_SECURE_COOKIES: "1" }), true);
  assert.equal(secureCookie(h({}), "http:", {}), false);
});

test("taille des requêtes : plafond, chunked refusé, valeurs absurdes refusées", () => {
  const h = (m: Record<string, string>) => (n: string) => m[n] ?? null;
  assert.equal(bodyTooLarge(h({})), false); // GET : pas de corps annoncé
  assert.equal(bodyTooLarge(h({ "content-length": "100" })), false);
  assert.equal(bodyTooLarge(h({ "content-length": String(MAX_BODY_BYTES) })), false);
  assert.equal(bodyTooLarge(h({ "content-length": String(MAX_BODY_BYTES + 1) })), true);
  assert.equal(bodyTooLarge(h({ "content-length": "-5" })), true);
  assert.equal(bodyTooLarge(h({ "content-length": "abc" })), true);
  assert.equal(bodyTooLarge(h({ "transfer-encoding": "chunked" })), true);
  assert.equal(bodyTooLarge(h({ "content-length": "70000" }), 65536), true);
  assert.equal(code(() => assertBodySize(h({ "content-length": "99999999999" }))), "requestTooLarge");
});

test("en-têtes de sécurité : toujours présents ; CSP sans eval en production ; HSTS et CSP selon les variables", () => {
  const val = (list: { key: string; value: string }[], k: string) => list.find((x) => x.key === k)?.value;
  const prod = securityHeaders({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
  assert.equal(val(prod, "X-Frame-Options"), "DENY");
  assert.equal(val(prod, "X-Content-Type-Options"), "nosniff");
  assert.ok(val(prod, "Referrer-Policy"));
  const csp = val(prod, "Content-Security-Policy")!;
  assert.ok(csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'") && csp.includes("default-src 'self'"));
  assert.ok(!csp.includes("unsafe-eval") && !csp.includes("ws:"), "ni eval ni WebSocket en production");
  assert.ok(!val(prod, "Strict-Transport-Security"), "HSTS seulement sur demande");
  const dev = val(securityHeaders({ NODE_ENV: "development" } as NodeJS.ProcessEnv), "Content-Security-Policy")!;
  assert.ok(dev.includes("'unsafe-eval'") && dev.includes("ws:"), "le rechargement à chaud en développement en a besoin");
  assert.ok(val(securityHeaders({ NODE_ENV: "production", IP_ARCHITECT_HSTS: "1" } as NodeJS.ProcessEnv), "Strict-Transport-Security"));
  assert.equal(val(securityHeaders({ NODE_ENV: "production", IP_ARCHITECT_CSP: "0" } as NodeJS.ProcessEnv), "Content-Security-Policy"), undefined);
});

test("changement de mot de passe : mauvais mot de passe actuel limité à 5 essais, puis bloqué même avec le bon", async () => {
  const db = emptyDb();
  seedDatabase(db);
  const u = await createUser({ username: "marie", displayName: "Marie", password: "Correct-Horse-42" }, db, { bootstrap: true });
  getThrottle().success(`pw:${u.id}`);
  for (let i = 0; i < 5; i++) assert.equal(await codeA(() => changeOwnPassword(u.id, "mauvais", "Autre-Phrase-77x", null, db)), "wrongCurrentPassword");
  assert.equal(await codeA(() => changeOwnPassword(u.id, "Correct-Horse-42", "Autre-Phrase-77x", null, db)), "tooManyAttempts");
  getThrottle().success(`pw:${u.id}`);
  assert.equal(await codeA(() => changeOwnPassword(u.id, "Correct-Horse-42", "Autre-Phrase-77x", null, db)), null);
});
