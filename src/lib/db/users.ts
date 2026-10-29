/**
 * Utilisateurs, mots de passe et sessions.
 *
 * - Tant qu'AUCUN compte n'existe, l'application est ouverte (comportement historique). Créer le premier compte
 *   (toujours administrateur) active la connexion pour tout le monde.
 * - Les sessions sont des jetons aléatoires de 256 bits ; seul leur hash SHA-256 est en base. Elles expirent après
 *   8 h d'inactivité ou 7 jours au total. Désactiver, supprimer ou changer le mot de passe d'un compte ferme ses sessions.
 * - Le rôle est relu en base à chaque requête : un changement de rôle s'applique immédiatement.
 * - Garde-fous : on ne peut pas retirer le dernier administrateur actif, ni modifier son propre rôle/état.
 */
import { createHash, randomBytes } from "node:crypto";
import { getDb, type Db } from "./index";
import { dummyHash, hashPassword, verifyPassword } from "../auth/password";
import { getThrottle, type LoginThrottle } from "../auth/throttle";
import { isRole, SESSION_IDLE_MS, SESSION_MAX_MS } from "../auth/roles";
import { ApiError, type CreateUserInput, type SessionUser, type UpdateUserInput, type UserRole, type UserRow } from "../types";

import { MIN_PASSWORD_LENGTH } from "../auth/constants";
import { normalizeEmail } from "../signupTypes";
import { applyScope, cleanScope, defaultScopeFor, getMemberships } from "./access";
import type { ProjectScope } from "../projectAccess";

export const MIN_PASSWORD = MIN_PASSWORD_LENGTH;
const MAX_PASSWORD = 200;
/** Une session active n'est réécrite en base qu'une fois par minute au plus. */
const TOUCH_MS = 60_000;

interface RawUser {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role: UserRole;
  active: number;
  created_at: string;
  last_login_at: string | null;
  email: string | null;
  email_verified_at: string | null;
  project_scope: string;
  auth_source: string;
}

const scopeOf = (v: string): ProjectScope => (v === "selected" ? "selected" : "all");

const mapUser = (r: RawUser, memberships: UserRow["memberships"] = []): UserRow => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  role: r.role,
  active: r.active === 1,
  createdAt: r.created_at,
  lastLoginAt: r.last_login_at,
  email: r.email,
  emailVerified: r.email_verified_at !== null,
  projectScope: scopeOf(r.project_scope),
  authSource: r.auth_source === "oidc" || r.auth_source === "ldap" ? r.auth_source : "local",
  memberships: scopeOf(r.project_scope) === "selected" ? memberships : [],
});

const USER_COLS = "id, username, display_name, password_hash, role, active, created_at, last_login_at, email, email_verified_at, project_scope, auth_source";

/* ------------------------------- Validation ------------------------------- */

export function normalizeUsername(raw: unknown): string {
  const u = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(u)) throw new ApiError("usernameInvalid", 422);
  return u;
}

function cleanDisplayName(raw: unknown): string {
  const n = typeof raw === "string" ? raw.trim() : "";
  if (!n) throw new ApiError("nameRequired", 422);
  if (n.length > 80) throw new ApiError("nameTooLong", 422);
  return n;
}

function cleanRole(raw: unknown): UserRole {
  if (!isRole(raw)) throw new ApiError("invalidBody", 400);
  return raw;
}

/** Adresse facultative d'un compte créé ou modifié par un administrateur : null = aucune. */
function cleanOptionalEmail(raw: unknown): string | null {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return null;
  const e = normalizeEmail(raw);
  if (!e) throw new ApiError("emailInvalid", 422);
  return e;
}

const emailTaken = (db: Db, email: string, exceptId?: number): boolean =>
  !!db.prepare("SELECT 1 FROM users WHERE LOWER(email) = ? AND id IS NOT ?").get(email, exceptId ?? null);

/** Une adresse est-elle déjà celle d'un compte ? (inscription : sert à NE PAS révéler la réponse). */
export const emailInUse = (email: string, db: Db = getDb()): boolean => emailTaken(db, email.toLowerCase());

export function validatePassword(raw: unknown, username?: string): string {
  const p = typeof raw === "string" ? raw : "";
  const weak = () => new ApiError("passwordWeak", 422, { min: MIN_PASSWORD });
  if (p.length < MIN_PASSWORD || p.length > MAX_PASSWORD) throw weak();
  if (new Set(p).size < 4) throw weak(); // « aaaaaaaaaa », « 1212121212 »
  if (username && p.toLowerCase().includes(username.toLowerCase())) throw weak();
  return p;
}

/* --------------------------------- Lecture --------------------------------- */

export function countUsers(db: Db = getDb()): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c;
}

/** La connexion est exigée dès qu'un compte existe. */
export const authEnabled = (db: Db = getDb()): boolean => countUsers(db) > 0;

/** Un compte porte-t-il ce nom ? (sert à décider si un nom saisi lors d'un échec de connexion peut être journalisé.) */
export function accountExists(name: string, db: Db = getDb()): boolean {
  return !!db.prepare("SELECT 1 FROM users WHERE LOWER(username) = ?").get(name.trim().toLowerCase());
}

export function listUsers(db: Db = getDb()): UserRow[] {
  const all = db.prepare("SELECT project_id, user_id, role FROM project_members ORDER BY project_id").all() as { project_id: number; user_id: number; role: "viewer" | "editor" }[];
  return (db.prepare(`SELECT ${USER_COLS} FROM users ORDER BY LOWER(username)`).all() as RawUser[]).map((r) =>
    mapUser(r, all.filter((m) => m.user_id === r.id).map((m) => ({ projectId: m.project_id, role: m.role }))),
  );
}

function loadUser(db: Db, id: number): RawUser {
  const r = db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id) as RawUser | undefined;
  if (!r) throw new ApiError("userNotFound", 404);
  return r;
}

export function getUser(id: number, db: Db = getDb()): UserRow {
  return mapUser(loadUser(db, id), getMemberships(db, id));
}

const activeAdmins = (db: Db, exceptId?: number): number =>
  (db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND id IS NOT ?").get(exceptId ?? null) as { c: number }).c;

/* -------------------------------- Écriture -------------------------------- */

/**
 * Crée un compte. `bootstrap: true` = création du tout premier compte (l'application était ouverte) : le rôle est
 * alors forcé à administrateur, et la création est refusée si un compte est apparu entre-temps.
 */
export async function createUser(input: CreateUserInput, db: Db = getDb(), opts: { bootstrap?: boolean } = {}): Promise<UserRow> {
  if (!input || typeof input !== "object") throw new ApiError("invalidBody", 400);
  const username = normalizeUsername(input.username);
  const displayName = cleanDisplayName(input.displayName);
  const password = validatePassword(input.password, username);
  const role: UserRole = opts.bootstrap ? "admin" : input.role === undefined ? "viewer" : cleanRole(input.role);
  const email = cleanOptionalEmail(input.email);
  const hash = await hashPassword(password);
  return db.transaction(() => {
    if (opts.bootstrap && countUsers(db) > 0) throw new ApiError("forbidden", 403);
    const sc = cleanScope(db, role, { scope: "all", memberships: [] }, input);
    if (db.prepare("SELECT 1 FROM users WHERE LOWER(username) = ?").get(username)) throw new ApiError("usernameTaken", 409, { name: username });
    if (email && emailTaken(db, email)) throw new ApiError("emailTaken", 409);
    const id = Number(
      db
        .prepare("INSERT INTO users (username, display_name, password_hash, role, active, created_at, email) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(username, displayName, hash, role, new Date().toISOString(), email).lastInsertRowid,
    );
    applyScope(db, id, role, sc.scope, sc.memberships);
    return getUser(id, db);
  })();
}

/**
 * Compte créé par l'inscription en libre-service, une fois l'adresse e-mail vérifiée par code : TOUJOURS « lecteur »
 * (un administrateur peut ensuite changer le rôle). Le mot de passe est déjà haché. Revérifie l'unicité (course possible).
 */
export function createVerifiedUser(
  input: { username: string; displayName: string; passwordHash: string; email: string },
  db: Db = getDb(),
  now: Date = new Date(),
): UserRow {
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM users WHERE LOWER(username) = ?").get(input.username)) throw new ApiError("usernameTaken", 409, { name: input.username });
    if (emailTaken(db, input.email)) throw new ApiError("emailTaken", 409);
    const iso = now.toISOString();
    const id = Number(
      db
        .prepare("INSERT INTO users (username, display_name, password_hash, role, active, created_at, email, email_verified_at) VALUES (?, ?, ?, 'viewer', 1, ?, ?, ?)")
        .run(input.username, input.displayName, input.passwordHash, iso, input.email, iso).lastInsertRowid,
    );
    // plusieurs projets (souvent : plusieurs clients) : une inscription libre ne donne accès à aucun d'eux tant qu'un administrateur ne l'a pas décidé
    db.prepare("UPDATE users SET project_scope = ? WHERE id = ?").run(defaultScopeFor(db), id);
    return getUser(id, db);
  })();
}

function revokeSessions(db: Db, userId: number, exceptTokenHash?: string): void {
  db.prepare("DELETE FROM user_sessions WHERE user_id = ? AND token_hash IS NOT ?").run(userId, exceptTokenHash ?? null);
}

/**
 * Fixe un nouveau mot de passe après une réinitialisation par e-mail : la personne a prouvé qu'elle lit la boîte de l'adresse
 * du compte, qui devient donc « vérifiée ». Toutes les sessions du compte sont fermées (les jetons d'API ne sont pas touchés).
 */
export function applyPasswordReset(db: Db, userId: number, passwordHash: string, now: Date = new Date()): void {
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?").run(passwordHash, now.toISOString(), userId);
    revokeSessions(db, userId);
  })();
}

export async function updateUser(id: number, input: UpdateUserInput, actorId: number | null, db: Db = getDb()): Promise<UserRow> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length === 0) throw new ApiError("invalidBody", 400);
  const current = loadUser(db, id);
  const displayName = input.displayName !== undefined ? cleanDisplayName(input.displayName) : current.display_name;
  const role = input.role !== undefined ? cleanRole(input.role) : current.role;
  if (input.active !== undefined && typeof input.active !== "boolean") throw new ApiError("invalidBody", 400);
  const active = input.active !== undefined ? input.active : current.active === 1;
  if (input.password !== undefined && current.auth_source !== "local") throw new ApiError("externalAccount", 409);
  const newHash = input.password !== undefined ? await hashPassword(validatePassword(input.password, current.username)) : null;
  const email = input.email !== undefined ? cleanOptionalEmail(input.email) : current.email;
  const emailChanged = (email ?? null) !== (current.email ?? null);

  const sc = cleanScope(db, role, { scope: scopeOf(current.project_scope), memberships: getMemberships(db, id) }, input);
  const changesAccess = role !== current.role || active !== (current.active === 1) || sc.scope !== scopeOf(current.project_scope);
  if (changesAccess && actorId === id) throw new ApiError("cannotChangeSelf", 409);

  return db.transaction(() => {
    // le dernier administrateur actif ne peut ni être rétrogradé ni désactivé
    const wasActiveAdmin = current.role === "admin" && current.active === 1;
    const staysActiveAdmin = role === "admin" && active;
    if (wasActiveAdmin && !staysActiveAdmin && activeAdmins(db, id) === 0) throw new ApiError("lastAdmin", 409);

    if (emailChanged && email && emailTaken(db, email, id)) throw new ApiError("emailTaken", 409);
    db.prepare(
      "UPDATE users SET display_name = ?, role = ?, active = ?, password_hash = COALESCE(?, password_hash), email = ?, email_verified_at = CASE WHEN ? THEN NULL ELSE email_verified_at END WHERE id = ?",
    ).run(
      displayName,
      role,
      active ? 1 : 0,
      newHash,
      email,
      emailChanged ? 1 : 0,
      id,
    );
    if (input.projectScope !== undefined || input.memberships !== undefined || role !== current.role) applyScope(db, id, role, sc.scope, sc.memberships);
    if (!active || newHash) revokeSessions(db, id);
    return getUser(id, db);
  })();
}

export function deleteUser(id: number, actorId: number | null, db: Db = getDb()): void {
  const current = loadUser(db, id);
  if (actorId === id) throw new ApiError("cannotChangeSelf", 409);
  db.transaction(() => {
    if (current.role === "admin" && current.active === 1 && activeAdmins(db, id) === 0) throw new ApiError("lastAdmin", 409);
    db.prepare("DELETE FROM users WHERE id = ?").run(id); // les sessions partent en cascade
  })();
}

/** Changement de son propre mot de passe : exige l'actuel ; les autres sessions du compte sont fermées. */
export async function changeOwnPassword(userId: number, current: unknown, next: unknown, keepToken: string | null, db: Db = getDb()): Promise<void> {
  const u = loadUser(db, userId);
  if (u.auth_source !== "local") throw new ApiError("externalAccount", 409);
  // même limitation que la connexion : une session volée ne doit pas permettre de deviner le mot de passe actuel
  const throttle = getThrottle();
  const key = `pw:${userId}`;
  const wait = throttle.remaining(key);
  if (wait > 0) throw new ApiError("tooManyAttempts", 429, { minutes: Math.ceil(wait / 60_000) });
  if (typeof current !== "string" || !(await verifyPassword(current, u.password_hash))) {
    throttle.fail(key);
    throw new ApiError("wrongCurrentPassword", 403);
  }
  throttle.success(key);
  const hash = await hashPassword(validatePassword(next, u.username));
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);
    revokeSessions(db, userId, keepToken ? hashToken(keepToken) : undefined);
  })();
}

/* --------------------------------- Sessions --------------------------------- */

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export interface LoginOptions {
  throttle?: LoginThrottle;
  /** Adresse du client, si connue : limite aussi les essais par adresse. */
  ip?: string | null;
  now?: Date;
}

/**
 * Vérifie l'identifiant et le mot de passe, ouvre une session. Même erreur pour « identifiant inconnu », « mot de passe
 * faux » et « compte désactivé » (rien à deviner), et même temps de calcul. Trop d'échecs bloquent temporairement.
 */
export async function login(username: unknown, password: unknown, opts: LoginOptions = {}, db: Db = getDb()): Promise<{ token: string; user: SessionUser }> {
  const throttle = opts.throttle ?? getThrottle();
  const now = opts.now ?? new Date();
  const name = typeof username === "string" ? username.trim().toLowerCase().slice(0, 80) : "";
  const keys = [`u:${name}`, ...(opts.ip ? [`ip:${opts.ip}`] : [])];

  const wait = Math.max(...keys.map((k) => throttle.remaining(k, now.getTime())));
  if (wait > 0) throw new ApiError("tooManyAttempts", 429, { minutes: Math.ceil(wait / 60_000) });

  const row = typeof password === "string" && name ? (db.prepare(`SELECT ${USER_COLS} FROM users WHERE LOWER(username) = ?`).get(name) as RawUser | undefined) : undefined;
  const ok = await verifyPassword(typeof password === "string" ? password.slice(0, MAX_PASSWORD) : "", row ? row.password_hash : await dummyHash());
  if (!row || !ok || row.active !== 1) {
    for (const k of keys) throttle.fail(k, now.getTime());
    throw new ApiError("invalidCredentials", 401);
  }
  for (const k of keys) throttle.success(k);

  const token = openSession(db, row.id, now);
  return { token, user: { id: row.id, username: row.username, displayName: row.display_name, role: row.role, projectScope: scopeOf(row.project_scope) } };
}

/** Ouvre une session pour un compte déjà authentifié (mot de passe vérifié, ou adresse e-mail vérifiée à l'inscription). */
export function openSession(db: Db, userId: number, now: Date = new Date()): string {
  const token = randomBytes(32).toString("base64url");
  const iso = now.toISOString();
  db.transaction(() => {
    db.prepare("INSERT INTO user_sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)").run(hashToken(token), userId, iso, iso);
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(iso, userId);
    // ménage : sessions expirées de tout le monde
    db.prepare("DELETE FROM user_sessions WHERE last_seen_at < ? OR created_at < ?").run(
      new Date(now.getTime() - SESSION_IDLE_MS).toISOString(),
      new Date(now.getTime() - SESSION_MAX_MS).toISOString(),
    );
  })();
  return token;
}

/** L'utilisateur d'un jeton de session, ou null (inconnu, expiré, compte désactivé ou supprimé). */
export function sessionUser(token: string | null | undefined, db: Db = getDb(), now: Date = new Date()): SessionUser | null {
  if (!token || token.length < 20 || token.length > 200) return null;
  const th = hashToken(token);
  const r = db
    .prepare(
      `SELECT s.created_at AS s_created, s.last_seen_at AS s_seen, u.id, u.username, u.display_name, u.role, u.active, u.project_scope
       FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .get(th) as { s_created: string; s_seen: string; id: number; username: string; display_name: string; role: UserRole; active: number; project_scope: string } | undefined;
  if (!r) return null;
  const t = now.getTime();
  if (r.active !== 1 || t - Date.parse(r.s_seen) > SESSION_IDLE_MS || t - Date.parse(r.s_created) > SESSION_MAX_MS) {
    db.prepare("DELETE FROM user_sessions WHERE token_hash = ?").run(th);
    return null;
  }
  if (t - Date.parse(r.s_seen) > TOUCH_MS) db.prepare("UPDATE user_sessions SET last_seen_at = ? WHERE token_hash = ?").run(now.toISOString(), th);
  return { id: r.id, username: r.username, displayName: r.display_name, role: r.role, projectScope: scopeOf(r.project_scope) };
}

export function logout(token: string | null | undefined, db: Db = getDb()): void {
  if (token) db.prepare("DELETE FROM user_sessions WHERE token_hash = ?").run(hashToken(token));
}

/**
 * Point d'entrée de la connexion par identifiant et mot de passe : un compte LOCAL existant passe toujours par son mot de
 * passe (jamais par l'annuaire : un nom d'annuaire identique ne doit pas ouvrir un compte local) ; sinon, si l'annuaire est
 * activé, c'est lui qui décide.
 */
export async function loginAny(
  username: unknown,
  password: unknown,
  opts: LoginOptions & { connect?: import("../ldap/client").LdapConnect } = {},
  db: Db = getDb(),
): Promise<{ token: string; user: SessionUser }> {
  const name = typeof username === "string" ? username.trim().toLowerCase().slice(0, 80) : "";
  const local = name ? (db.prepare("SELECT auth_source FROM users WHERE LOWER(username) = ?").get(name) as { auth_source: string } | undefined) : undefined;
  const { getSsoConfig } = await import("./ssosettings");
  if ((local && local.auth_source === "local") || !getSsoConfig(db).ldap.enabled) return login(username, password, opts, db);
  const { loginLdap } = await import("./sso");
  return loginLdap(username, password, opts, db);
}
