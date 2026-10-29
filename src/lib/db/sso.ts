/**
 * Comptes issus d'un fournisseur d'identité (OpenID Connect) ou d'un annuaire (LDAP) : création à la première connexion
 * (« provisionnement »), rôle d'après les groupes, ouverture de session.
 *
 * - Un compte externe n'a PAS de mot de passe ici (empreinte inutilisable) : changement et réinitialisation sont refusés.
 * - Un compte existant n'est JAMAIS rattaché automatiquement à une identité externe d'après un simple nom ou une adresse
 *   (sinon, qui contrôle l'annuaire prend le compte « admin »). Si le nom est pris, le nouveau compte reçoit un suffixe.
 * - Un compte désactivé ici reste refusé ; le dernier administrateur actif n'est jamais rétrogradé par la synchronisation des groupes.
 */
import { getDb, type Db } from "./index";
import { getSsoConfig, getLdapPassword, ldapTransportOk } from "./ssosettings";
import { openSession } from "./users";
import { applyScope, defaultScopeFor } from "./access";
import { getThrottle, type LoginThrottle } from "../auth/throttle";
import { connectLdap, LdapError, type LdapConnect } from "../ldap/client";
import { renderFilter } from "../ldap/filter";
import { finishOidc, type OidcDeps } from "../auth/oidc";
import { groupAllowed, roleFromGroups, usernameFrom, type Provisioning } from "../ssoTypes";
import { ApiError, type SessionUser, type UserRole } from "../types";

export const NO_PASSWORD = "!";

interface Identity {
  source: "oidc" | "ldap";
  externalId: string;
  usernameCandidate: unknown;
  displayName: string | null;
  email: string | null;
  emailVerified: boolean;
  groups: string[];
}

type Row = { id: number; username: string; display_name: string; role: UserRole; active: number; project_scope: string };

const scopeOf = (v: string) => (v === "selected" ? "selected" : "all");

function freeUsername(db: Db, base: string): string {
  const taken = (u: string) => !!db.prepare("SELECT 1 FROM users WHERE LOWER(username) = ?").get(u);
  if (!taken(base)) return base;
  for (let i = 2; i < 100; i++) {
    const c = `${base.slice(0, 37)}.${i}`;
    if (!taken(c)) return c;
  }
  throw new ApiError("usernameTaken", 409, { name: base });
}

/** Crée ou met à jour le compte puis ouvre une session. Lève une ApiError si la personne n'a pas le droit de se connecter. */
export function signInExternal(db: Db, id: Identity, prov: Provisioning, domains: string[] = [], now: Date = new Date()): { token: string; user: SessionUser; created: boolean } {
  if (!groupAllowed(id.groups, prov)) throw new ApiError("ssoNotAllowed", 403);
  if (domains.length > 0) {
    const d = id.email?.split("@")[1];
    if (!id.email || !id.emailVerified || !d || !domains.includes(d)) throw new ApiError("ssoDomain", 403);
  }
  const wanted = roleFromGroups(id.groups, prov);

  const out = db.transaction(() => {
    const found = db.prepare("SELECT id, username, display_name, role, active, project_scope FROM users WHERE auth_source = ? AND external_id = ?").get(id.source, id.externalId) as Row | undefined;
    if (found) {
      if (found.active !== 1) throw new ApiError("ssoInactive", 403);
      let role = found.role;
      if (prov.syncRole && wanted !== found.role) {
        const lastAdmin =
          found.role === "admin" && (db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND id <> ?").get(found.id) as { c: number }).c === 0;
        if (!lastAdmin) {
          role = wanted;
          db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, found.id);
          if (role === "admin") db.prepare("UPDATE users SET project_scope = 'all' WHERE id = ?").run(found.id);
          else if (found.role === "admin") applyScope(db, found.id, role, scopeOf(defaultScopeFor(db)), []);
        }
      }
      const name = id.displayName ?? found.display_name;
      if (name !== found.display_name) db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(name, found.id);
      const token = openSession(db, found.id, now);
      return { token, user: { id: found.id, username: found.username, displayName: name, role, projectScope: scopeOf(found.project_scope) } as SessionUser, created: false };
    }

    const base = usernameFrom(id.usernameCandidate);
    if (!base) throw new ApiError("ssoNoUsername", 422);
    const username = freeUsername(db, base);
    const email = id.email && !db.prepare("SELECT 1 FROM users WHERE LOWER(email) = ?").get(id.email) ? id.email : null;
    const displayName = (id.displayName ?? username).slice(0, 80);
    const scope = wanted === "admin" ? "all" : defaultScopeFor(db);
    const uid = Number(
      db
        .prepare(
          "INSERT INTO users (username, display_name, password_hash, role, active, created_at, email, email_verified_at, project_scope, auth_source, external_id) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)",
        )
        .run(username, displayName, NO_PASSWORD, wanted, now.toISOString(), email, email && id.emailVerified && id.source === "oidc" ? now.toISOString() : null, scope, id.source, id.externalId).lastInsertRowid,
    );
    const token = openSession(db, uid, now);
    return { token, user: { id: uid, username, displayName, role: wanted, projectScope: scope } as SessionUser, created: true };
  })();
  return out;
}

/** Fin du flux OpenID Connect : jeton déjà vérifié par `finishOidc`, rôle d'après les groupes. */
export async function loginOidc(db: Db, input: { code: unknown; state: unknown; bind: unknown; requestOrigin: string }, deps: OidcDeps = {}) {
  const { oidc } = getSsoConfig(db);
  const ident = await finishOidc(db, input, deps);
  return signInExternal(db, { source: "oidc", externalId: ident.subject, ...ident }, oidc, oidc.domains, deps.now);
}

/* ---------------------------------- LDAP ---------------------------------- */

export interface LdapLoginOptions {
  throttle?: LoginThrottle;
  ip?: string | null;
  now?: Date;
  connect?: LdapConnect;
}

const unavailable = (e: unknown): ApiError => (e instanceof ApiError ? e : new ApiError("ldapUnavailable", 502));

/**
 * Connexion par l'annuaire : (1) recherche de l'entrée avec le compte de service (ou anonymement), (2) « bind » avec le
 * mot de passe saisi, (3) groupes lus dans l'entrée. Mêmes limites de tentatives que la connexion locale.
 */
export async function loginLdap(username: unknown, password: unknown, opts: LdapLoginOptions = {}, db: Db = getDb()) {
  const { ldap } = getSsoConfig(db);
  if (!ldap.enabled) throw new ApiError("invalidCredentials", 401);
  const throttle = opts.throttle ?? getThrottle();
  const now = opts.now ?? new Date();
  const name = typeof username === "string" ? username.trim().slice(0, 80) : "";
  const keys = [`u:${name.toLowerCase()}`, ...(opts.ip ? [`ip:${opts.ip}`] : [])];
  const wait = Math.max(...keys.map((k) => throttle.remaining(k, now.getTime())));
  if (wait > 0) throw new ApiError("tooManyAttempts", 429, { minutes: Math.ceil(wait / 60_000) });
  const fail = (): never => {
    for (const k of keys) throttle.fail(k, now.getTime());
    throw new ApiError("invalidCredentials", 401);
  };
  if (!name || /[\u0000-\u001f\u007f]/.test(name) || typeof password !== "string" || password === "" || password.length > 200) return fail();
  if (!ldapTransportOk(ldap.url, ldap.startTls)) throw new ApiError("ldapPlain", 422);

  const connect = opts.connect ?? connectLdap;
  let entry: { dn: string; attrs: Record<string, string[]> };
  try {
    const search = await connect({ url: ldap.url, startTls: ldap.startTls });
    try {
      const svcPass = getLdapPassword(db);
      if (ldap.bindDn) {
        if (!svcPass || !(await search.bind(ldap.bindDn, svcPass))) throw new LdapError("result", "compte de service refusé");
      }
      const attrs = [ldap.usernameAttr, ldap.displayNameAttr, ldap.emailAttr, ldap.groupAttr];
      const found = await search.search(ldap.baseDn, renderFilter(ldap.userFilter, name), attrs, 2);
      if (found.length !== 1) return fail(); // inconnu, ou ambigu : on ne devine pas
      entry = found[0];
    } finally {
      await search.close();
    }
    const auth = await connect({ url: ldap.url, startTls: ldap.startTls });
    try {
      if (!(await auth.bind(entry.dn, password))) return fail();
    } catch (e) {
      // mot de passe vide ou refus de protocole côté client : identifiants invalides, pas une panne
      if (e instanceof LdapError && e.kind === "protocol") return fail();
      throw e;
    } finally {
      await auth.close();
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw unavailable(e);
  }

  for (const k of keys) throttle.success(k);
  const first = (a: string) => entry.attrs[a.toLowerCase()]?.[0] ?? null;
  const login = first(ldap.usernameAttr) ?? name;
  return signInExternal(
    db,
    {
      source: "ldap",
      externalId: login.toLowerCase(),
      usernameCandidate: login,
      displayName: first(ldap.displayNameAttr)?.trim().slice(0, 80) || null,
      email: first(ldap.emailAttr)?.toLowerCase().slice(0, 254) ?? null,
      emailVerified: false,
      groups: (entry.attrs[ldap.groupAttr.toLowerCase()] ?? []).slice(0, 500),
    },
    ldap,
    [],
    now,
  );
}
