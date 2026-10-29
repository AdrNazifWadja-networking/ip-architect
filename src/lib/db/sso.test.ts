import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { createUser, loginAny, sessionUser, changeOwnPassword, updateUser, getUser } from "./users";
import { getSsoConfig, getLoginOptions, updateSsoConfig, getOidcSecret, getLdapPassword } from "./ssosettings";
import { loginLdap, loginOidc, signInExternal, NO_PASSWORD } from "./sso";
import { createBackup } from "./appsettings";
import { startOidc, clearOidcCache } from "../auth/oidc";
import { verifyIdToken, JwtError } from "../auth/jwt";
import { roleFromGroups, groupAllowed, inGroups, usernameFrom } from "../ssoTypes";
import { DIR, fakeLdap } from "../ldap/fakeServer";
import { ApiError } from "../types";
import { LoginThrottle } from "../auth/throttle";

function freshDb(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  seedDatabase(db);
  return db;
}
const codeOf = async (fn: () => unknown): Promise<string | null> => {
  try {
    await fn();
    return null;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
};
const NOW = new Date("2026-10-26T09:00:00Z");
const ldapCfg = (url: string, extra: object = {}) => ({
  ldap: { enabled: true, url, bindDn: "cn=svc,dc=ex", bindPassword: "svcpw", baseDn: "dc=ex", adminGroups: ["admins"], editorGroups: [], ...extra },
});

test("groupes : nom, DN complet ou CN, casse ignorée ; rôle et autorisation", () => {
  const g = ["CN=Admins,OU=Groups,DC=ex", "staff"];
  assert.ok(inGroups(g, ["admins"]));
  assert.ok(inGroups(g, ["cn=admins,ou=groups,dc=ex"]));
  assert.ok(!inGroups(g, ["admin"]));
  assert.ok(!inGroups(g, []));
  const p = { adminGroups: ["admins"], editorGroups: ["staff"], defaultRole: "viewer" as const, allowedGroups: ["staff"] };
  assert.equal(roleFromGroups(g, p), "admin");
  assert.equal(roleFromGroups(["staff"], p), "editor");
  assert.equal(roleFromGroups(["x"], p), "viewer");
  assert.ok(!groupAllowed(["x"], p));
  assert.ok(groupAllowed(["admins"], p));
  assert.ok(groupAllowed(["x"], { ...p, allowedGroups: [] }));
  assert.equal(usernameFrom("Jean.Dupont@exemple.fr"), "jean.dupont");
  assert.equal(usernameFrom("Élodie Martin"), "elodie.martin");
  assert.equal(usernameFrom("ab"), "ab0");
  assert.equal(usernameFrom("@@@"), null);
  assert.equal(usernameFrom(42), null);
});

test("réglages : validation, secrets jamais renvoyés, activation exige la configuration", async () => {
  const db = freshDb();
  assert.deepEqual(getLoginOptions(db), { oidc: null, ldap: false });
  assert.equal(await codeOf(() => updateSsoConfig({ oidc: { enabled: true } }, db)), "ssoNotConfigured");
  for (const bad of ["http://idp.example.com", "ftp://x", "https://u:p@x.com", "https://x.com/?a=1", "not a url"]) {
    assert.equal(await codeOf(() => updateSsoConfig({ oidc: { issuer: bad } }, db)), "ssoInvalidConfig", bad);
  }
  assert.equal(await codeOf(() => updateSsoConfig({ oidc: { scopes: "profile" } }, db)), "ssoInvalidConfig");
  assert.equal(await codeOf(() => updateSsoConfig({ oidc: { publicUrl: "https://a.fr/chemin" } }, db)), "ssoInvalidConfig");
  assert.equal(await codeOf(() => updateSsoConfig({ ldap: { userFilter: "(uid=x)" } }, db)), "ssoInvalidConfig");
  assert.equal(await codeOf(() => updateSsoConfig({ ldap: { userFilter: "(uid={username}" } }, db)), "ssoInvalidConfig");
  assert.equal(await codeOf(() => updateSsoConfig({ ldap: { url: "ldap://dc.example.com" } }, db)), "ldapPlain");
  assert.equal(await codeOf(() => updateSsoConfig({ ldap: { url: "ldap://dc.example.com", startTls: true } }, db)), null);
  const c = updateSsoConfig({ oidc: { issuer: "https://idp.example.com/realms/a", clientId: "ipa", clientSecret: "S3CRET", enabled: true, label: "Keycloak", adminGroups: ["a", "a", " b "] } }, db);
  assert.equal(c.oidc.hasSecret, true);
  assert.deepEqual(c.oidc.adminGroups, ["a", "b"]);
  assert.ok(!JSON.stringify(c).includes("S3CRET"));
  assert.equal(getOidcSecret(db), "S3CRET");
  assert.deepEqual(getLoginOptions(db), { oidc: { label: "Keycloak" }, ldap: false });
  // un secret vide efface ; omis, il est conservé
  updateSsoConfig({ oidc: { label: "SSO" } }, db);
  assert.equal(getOidcSecret(db), "S3CRET");
  updateSsoConfig({ oidc: { clientSecret: "" } }, db);
  assert.equal(getSsoConfig(db).oidc.hasSecret, false);
});

test("sauvegarde : secrets SSO et secrets de webhooks absents de la copie", () => {
  const db = freshDb();
  updateSsoConfig({ oidc: { issuer: "https://idp.example.com", clientId: "x", clientSecret: "TOPSECRET" }, ldap: { bindPassword: "LDAPPW" } }, db);
  db.prepare("INSERT INTO webhooks (project_id, name, url, events, secret, active, created_at) VALUES ((SELECT id FROM projects LIMIT 1), 'w', 'https://h.example.com', '*', 'WHSECRET', 1, 'x')").run();
  const raw = createBackup(db).toString("latin1");
  for (const s of ["TOPSECRET", "LDAPPW", "WHSECRET"]) assert.ok(!raw.includes(s), s);
});

test("LDAP : connexion, compte créé avec rôle d'après les groupes, mauvais mot de passe, inconnu, ambigu", async () => {
  const srv = await fakeLdap(DIR);
  try {
    const db = freshDb();
    updateSsoConfig(ldapCfg(srv.url, { groupAttr: "memberOf" }), db);
    const th = new LoginThrottle();
    const o = { throttle: th, now: NOW };
    const r = await loginLdap("Alice", "alicepw", o, db);
    assert.equal(r.user.username, "alice");
    assert.equal(r.user.role, "admin"); // groupe « admins »
    assert.equal(r.created, true);
    const row = getUser(r.user.id, db);
    assert.equal(row.authSource, "ldap");
    assert.equal(row.email, "alice@ex.fr");
    assert.equal(row.displayName, "Alice A");
    assert.equal(sessionUser(r.token, db, NOW)?.username, "alice");
    // deuxième connexion : même compte
    const again = await loginLdap("alice", "alicepw", { ...o, throttle: new LoginThrottle() }, db);
    assert.equal(again.user.id, r.user.id);
    assert.equal(again.created, false);
    // bob : aucun groupe -> rôle par défaut
    assert.equal((await loginLdap("bob", "bobpw", { ...o, throttle: new LoginThrottle() }, db)).user.role, "viewer");
    // refus : mauvais mot de passe, inconnu, ambigu, mot de passe vide, injection : même erreur
    for (const [u, p] of [["bob", "faux"], ["nobody", "x"], ["dup", "x"], ["bob", ""], ["*", "x"], ["*)(uid=*", "x"]] as const) {
      assert.equal(await codeOf(() => loginLdap(u, p, { throttle: new LoginThrottle(), now: NOW }, db)), "invalidCredentials", u + "/" + p);
    }
    // limite de tentatives
    const t2 = new LoginThrottle();
    for (let i = 0; i < 12; i++) await codeOf(() => loginLdap("bob", "faux", { throttle: t2, now: NOW }, db));
    assert.equal(await codeOf(() => loginLdap("bob", "bobpw", { throttle: t2, now: NOW }, db)), "tooManyAttempts");
  } finally {
    srv.close();
  }
});

test("LDAP : annuaire injoignable = ldapUnavailable ; compte désactivé refusé ; pas de mot de passe local", async () => {
  const srv = await fakeLdap(DIR);
  const db = freshDb();
  updateSsoConfig(ldapCfg(srv.url), db);
  const r = await loginLdap("bob", "bobpw", { throttle: new LoginThrottle(), now: NOW }, db);
  db.prepare("UPDATE users SET active = 0 WHERE id = ?").run(r.user.id);
  assert.equal(await codeOf(() => loginLdap("bob", "bobpw", { throttle: new LoginThrottle(), now: NOW }, db)), "ssoInactive");
  db.prepare("UPDATE users SET active = 1 WHERE id = ?").run(r.user.id);
  assert.equal(db.prepare("SELECT password_hash h FROM users WHERE id = ?").get(r.user.id) && (db.prepare("SELECT password_hash h FROM users WHERE id = ?").get(r.user.id) as { h: string }).h, NO_PASSWORD);
  assert.equal(await codeOf(() => changeOwnPassword(r.user.id, "x", "Nouveau-mdp-123", null, db)), "externalAccount");
  assert.equal(await codeOf(() => updateUser(r.user.id, { password: "Nouveau-mdp-123" }, null, db)), "externalAccount");
  srv.close();
  assert.equal(await codeOf(() => loginLdap("bob", "bobpw", { throttle: new LoginThrottle(), now: NOW }, db)), "ldapUnavailable");
});

test("connexion : un compte LOCAL reste local (jamais l'annuaire) et le nom pris reçoit un suffixe", async () => {
  const srv = await fakeLdap(DIR);
  try {
    const db = freshDb();
    await createUser({ username: "bob", displayName: "Bob local", password: "Mot-de-passe-local-1", role: "admin" }, db);
    updateSsoConfig(ldapCfg(srv.url), db);
    // « bob » existe en local : le mot de passe de l'ANNUAIRE ne l'ouvre pas
    assert.equal(await codeOf(() => loginAny("bob", "bobpw", { throttle: new LoginThrottle(), now: NOW }, db)), "invalidCredentials");
    assert.equal((await loginAny("bob", "Mot-de-passe-local-1", { throttle: new LoginThrottle(), now: NOW }, db)).user.displayName, "Bob local");
    // alice : annuaire
    assert.equal((await loginAny("alice", "alicepw", { throttle: new LoginThrottle(), now: NOW }, db)).user.username, "alice");
    // identité externe dont le nom est déjà pris : nouveau compte « bob.2 », sans toucher au local
    const x = signInExternal(db, { source: "ldap", externalId: "bob", usernameCandidate: "bob", displayName: "Autre Bob", email: null, emailVerified: false, groups: [] }, { allowedGroups: [], adminGroups: [], editorGroups: [], defaultRole: "viewer", syncRole: true }, [], NOW);
    assert.equal(x.user.username, "bob.2");
    assert.equal((db.prepare("SELECT role FROM users WHERE username = 'bob'").get() as { role: string }).role, "admin");
  } finally {
    srv.close();
  }
});

test("rôle synchronisé à chaque connexion, mais jamais en retirant le dernier administrateur", () => {
  const db = freshDb();
  const prov = { allowedGroups: [], adminGroups: ["admins"], editorGroups: ["staff"], defaultRole: "viewer" as const, syncRole: true };
  const id = (groups: string[]) => ({ source: "ldap" as const, externalId: "carol", usernameCandidate: "carol", displayName: "Carol", email: null, emailVerified: false, groups });
  assert.equal(signInExternal(db, id(["staff"]), prov, [], NOW).user.role, "editor");
  assert.equal(signInExternal(db, id(["admins"]), prov, [], NOW).user.role, "admin");
  // seule administratrice : le retrait du groupe ne la rétrograde pas
  assert.equal(signInExternal(db, id([]), prov, [], NOW).user.role, "admin");
  createUser({ username: "autre", displayName: "Autre", password: "Mot-de-passe-1234", role: "admin" }, db);
});

test("groupes autorisés et domaines d'e-mail", async () => {
  const db = freshDb();
  const prov = { allowedGroups: ["staff"], adminGroups: [], editorGroups: [], defaultRole: "viewer" as const, syncRole: true };
  const id = (groups: string[], email: string | null = null, verified = false) => ({ source: "oidc" as const, externalId: "s1", usernameCandidate: "dan", displayName: null, email, emailVerified: verified, groups });
  assert.equal(await codeOf(() => signInExternal(db, id(["autre"]), prov, [], NOW)), "ssoNotAllowed");
  assert.equal(await codeOf(() => signInExternal(db, id(["staff"]), prov, ["ex.fr"], NOW)), "ssoDomain");
  assert.equal(await codeOf(() => signInExternal(db, id(["staff"], "dan@ex.fr", false), prov, ["ex.fr"], NOW)), "ssoDomain");
  assert.equal(await codeOf(() => signInExternal(db, id(["staff"], "dan@evil.fr", true), prov, ["ex.fr"], NOW)), "ssoDomain");
  assert.equal(signInExternal(db, id(["staff"], "dan@ex.fr", true), prov, ["ex.fr"], NOW).user.username, "dan");
  assert.equal(await codeOf(() => signInExternal(db, { ...id(["staff"]), externalId: "s2", usernameCandidate: "@@" }, prov, [], NOW)), "ssoNoUsername");
});

/* ------------------------------ OpenID Connect ------------------------------ */
const ISS = "https://idp.example.com/realms/a";
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwkOf = (k: { publicKey: import("node:crypto").KeyObject }, kid: string, alg: string) => ({ ...(k.publicKey.export({ format: "jwk" }) as object), kid, use: "sig", alg });
const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt(claims: object, key = rsa.privateKey, header: object = { alg: "RS256", kid: "r1" }): string {
  const h = header as { alg: string };
  const signed = `${b(header)}.${b(claims)}`;
  const s = createSign("SHA256").update(signed);
  const sig = h.alg === "ES256" ? s.sign({ key, dsaEncoding: "ieee-p1363" }) : s.sign(key);
  return `${signed}.${sig.toString("base64url")}`;
}
const base = (extra: object = {}) => ({ iss: ISS, aud: "ipa", sub: "u-1", exp: Math.floor(NOW.getTime() / 1000) + 300, iat: Math.floor(NOW.getTime() / 1000), nonce: "N", ...extra });
const KEYS = [jwkOf(rsa, "r1", "RS256"), jwkOf(ec, "e1", "ES256")];
const vo = { issuer: ISS, audience: "ipa", nonce: "N", now: NOW.getTime() };

test("JWT : RS256 et ES256 valides ; refus de none/HS256, mauvaise signature, expiré, mauvais émetteur/destinataire/nonce", () => {
  assert.equal(verifyIdToken(jwt(base()), KEYS, vo).sub, "u-1");
  assert.equal(verifyIdToken(jwt(base(), ec.privateKey, { alg: "ES256", kid: "e1" }), KEYS, vo).sub, "u-1");
  const bad = (t: string, re: RegExp) => assert.throws(() => verifyIdToken(t, KEYS, vo), (e: unknown) => e instanceof JwtError && re.test(e.message));
  bad(`${b({ alg: "none" })}.${b(base())}.`, /algorithme/);
  bad(jwt(base(), rsa.privateKey, { alg: "HS256", kid: "r1" }), /algorithme/);
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  bad(jwt(base(), other.privateKey), /signature/);
  bad(jwt(base(), rsa.privateKey, { alg: "RS256", kid: "inconnue" }), /clé/);
  bad(jwt(base({ exp: Math.floor(NOW.getTime() / 1000) - 3600 })), /expiré/);
  bad(jwt(base({ iss: "https://evil.example" })), /émetteur/);
  bad(jwt(base({ aud: "autre" })), /destinataire/);
  bad(jwt(base({ aud: ["ipa", "autre"] })), /autorisée/);
  bad(jwt(base({ nonce: "X" })), /nonce/);
  bad(jwt(base({ sub: "" })), /sujet/);
  bad("a.b", /mal formé/);
  // le jeton signé par la clé EC ne passe pas en prétendant RS256 avec le kid de la clé EC
  bad(jwt(base(), ec.privateKey, { alg: "RS256", kid: "e1" }), /clé|signature/);
});

function fakeIdp(opts: { claims?: (nonce: string) => object; groups?: string[]; tamper?: boolean } = {}) {
  const calls: string[] = [];
  const tokenAuth: string[] = [];
  let nonce = "";
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(url);
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    if (url.endsWith("/.well-known/openid-configuration"))
      return json({ issuer: ISS, authorization_endpoint: `${ISS}/auth`, token_endpoint: `${ISS}/token`, jwks_uri: `${ISS}/certs`, userinfo_endpoint: `${ISS}/userinfo` });
    if (url.endsWith("/certs")) return json({ keys: KEYS });
    if (url.endsWith("/userinfo")) return json({ sub: "u-1", groups: opts.groups ?? [] });
    if (url.endsWith("/token")) {
      const body = new URLSearchParams(String(init?.body));
      assert.ok(body.get("code_verifier")!.length >= 43);
      assert.equal(body.get("grant_type"), "authorization_code");
      tokenAuth.push(String((init?.headers as Record<string, string>).Authorization));
      return json({ id_token: jwt(opts.claims ? opts.claims(nonce) : base({ nonce, preferred_username: "Eve.Durand", name: "Eve Durand", email: "eve@ex.fr", email_verified: true, groups: opts.groups ?? [] })), access_token: "at" });
    }
    return new Response("nope", { status: 404 });
  };
  return { fetcher, calls, tokenAuth, setNonce: (n: string) => (nonce = n) };
}

test("OIDC : flux complet (PKCE, state, nonce, cookie de liaison), compte créé, tentative à usage unique", async () => {
  clearOidcCache();
  const db = freshDb();
  updateSsoConfig({ oidc: { issuer: ISS, clientId: "ipa", clientSecret: "sec", enabled: true, adminGroups: ["admins"], domains: ["ex.fr"] } }, db);
  const idp = fakeIdp({ groups: ["admins"] });
  const { url, bind } = await startOidc(db, "https://ipam.example.com", { fetch: idp.fetcher, now: NOW });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, `${ISS}/auth`);
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("redirect_uri"), "https://ipam.example.com/api/auth/oidc/callback");
  assert.equal(u.searchParams.get("scope"), "openid profile email");
  idp.setNonce(u.searchParams.get("nonce")!);
  const state = u.searchParams.get("state")!;
  // mauvais cookie de liaison (autre navigateur) : refusé, et la tentative est consommée
  assert.equal(await codeOf(() => loginOidc(db, { code: "c", state, bind: "autre", requestOrigin: "https://ipam.example.com" }, { fetch: idp.fetcher, now: NOW })), "ssoState");
  const second = await startOidc(db, "https://ipam.example.com", { fetch: idp.fetcher, now: NOW });
  const u2 = new URL(second.url);
  idp.setNonce(u2.searchParams.get("nonce")!);
  const r = await loginOidc(db, { code: "c", state: u2.searchParams.get("state"), bind: second.bind, requestOrigin: "https://ipam.example.com" }, { fetch: idp.fetcher, now: NOW });
  assert.match(idp.tokenAuth[0], /^Basic /);
  assert.equal(r.user.username, "eve.durand");
  assert.equal(r.user.role, "admin");
  const row = getUser(r.user.id, db);
  assert.equal(row.authSource, "oidc");
  assert.equal(row.emailVerified, true);
  // rejouer le même state : refusé
  assert.equal(await codeOf(() => loginOidc(db, { code: "c", state: u2.searchParams.get("state"), bind: second.bind, requestOrigin: "x" }, { fetch: idp.fetcher, now: NOW })), "ssoState");
  assert.equal(bind.length > 20, true);
});

test("OIDC : tentative expirée, jeton au mauvais nonce, émetteur annoncé différent, SSO désactivé", async () => {
  clearOidcCache();
  const db = freshDb();
  assert.equal(await codeOf(() => startOidc(db, "https://x", { fetch: fakeIdp().fetcher })), "ssoDisabled");
  updateSsoConfig({ oidc: { issuer: ISS, clientId: "ipa", enabled: true } }, db);
  const idp = fakeIdp();
  const a = await startOidc(db, "https://x", { fetch: idp.fetcher, now: NOW });
  const ua = new URL(a.url);
  idp.setNonce(ua.searchParams.get("nonce")!);
  const late = new Date(NOW.getTime() + 11 * 60_000);
  assert.equal(await codeOf(() => loginOidc(db, { code: "c", state: ua.searchParams.get("state"), bind: a.bind, requestOrigin: "https://x" }, { fetch: idp.fetcher, now: late })), "ssoState");
  const b2 = await startOidc(db, "https://x", { fetch: idp.fetcher, now: NOW });
  const ub = new URL(b2.url);
  idp.setNonce("nonce-d-une-autre-tentative");
  assert.equal(await codeOf(() => loginOidc(db, { code: "c", state: ub.searchParams.get("state"), bind: b2.bind, requestOrigin: "https://x" }, { fetch: idp.fetcher, now: NOW })), "ssoToken");
  clearOidcCache();
  const liar = async (url: string) => (url.endsWith("openid-configuration") ? new Response(JSON.stringify({ issuer: "https://autre.example", authorization_endpoint: "https://a/b", token_endpoint: "https://a/t", jwks_uri: "https://a/j" })) : new Response("", { status: 404 }));
  assert.equal(await codeOf(() => startOidc(db, "https://x", { fetch: liar as never })), "ssoProvider");
});
