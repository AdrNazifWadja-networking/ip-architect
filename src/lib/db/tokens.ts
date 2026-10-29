/**
 * Jetons d'API : accès programmatique (scripts, outils d'automatisation) au nom d'un compte, sans cookie de session.
 *
 * - Le jeton (« ipa_ » + 256 bits aléatoires) n'est montré qu'à sa création ; seul son hash SHA-256 est stocké.
 * - Son rôle est celui qu'on lui donne (lecteur ou éditeur), plafonné en permanence par le rôle actuel du propriétaire :
 *   un propriétaire rétrogradé, désactivé ou supprimé réduit ou coupe ses jetons immédiatement.
 * - Jamais « administrateur » : comptes, projets, réglages et sauvegardes exigent une session de navigateur.
 * - Révoquer ne supprime pas la ligne (trace de l'existence du jeton) ; un jeton révoqué ou expiré est refusé.
 */
import { createHash, randomBytes } from "node:crypto";
import { getDb, type Db } from "./index";
import { atLeast, type Role } from "../auth/roles";
import {
  TOKEN_DEFAULT_EXPIRY_DAYS,
  TOKEN_MAX_ACTIVE,
  TOKEN_MAX_EXPIRY_DAYS,
  TOKEN_NAME_MAX,
  TOKEN_PATTERN,
  TOKEN_PREFIX,
  isTokenRole,
  type ApiTokenRow,
  type CreateTokenInput,
  type TokenRole,
  type TokenStatus,
} from "../tokenTypes";
import { ApiError, type SessionUser } from "../types";

const DAY_MS = 86_400_000;
/** On n'écrit « dernière utilisation » qu'une fois par minute au plus (pas une écriture par requête). */
const TOUCH_MS = 60_000;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

interface Raw {
  id: number;
  user_id: number;
  username: string;
  name: string;
  prefix: string;
  role: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

function statusOf(r: Raw, now: Date): TokenStatus {
  if (r.revoked_at) return "revoked";
  if (r.expires_at && Date.parse(r.expires_at) <= now.getTime()) return "expired";
  return "active";
}

function map(r: Raw, now: Date): ApiTokenRow {
  return {
    id: r.id,
    userId: r.user_id,
    username: r.username,
    name: r.name,
    prefix: r.prefix,
    role: isTokenRole(r.role) ? r.role : "viewer",
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
    status: statusOf(r, now),
  };
}

const SELECT = `SELECT t.id, t.user_id, u.username, t.name, t.prefix, t.role, t.created_at, t.expires_at, t.last_used_at, t.revoked_at
                FROM api_tokens t JOIN users u ON u.id = t.user_id`;

function activeCount(userId: number, db: Db, now: Date): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)")
      .get(userId, now.toISOString()) as { c: number }
  ).c;
}

/** Crée un jeton pour `owner`. Retourne le jeton en clair (à montrer UNE fois) et sa ligne. */
export function createToken(owner: SessionUser, input: CreateTokenInput, db: Db = getDb(), now: Date = new Date()): { token: string; row: ApiTokenRow } {
  if (!input || typeof input !== "object") throw new ApiError("invalidBody", 400);
  const name = typeof input.name === "string" ? input.name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/ {2,}/g, " ").trim() : "";
  if (!name) throw new ApiError("tokenNameRequired", 422);
  if (name.length > TOKEN_NAME_MAX) throw new ApiError("tokenNameTooLong", 422, { max: TOKEN_NAME_MAX });

  const role: TokenRole | null = input.role === undefined ? "viewer" : isTokenRole(input.role) ? input.role : null;
  if (!role) throw new ApiError("tokenRoleInvalid", 422);
  if (!atLeast(owner.role as Role, role)) throw new ApiError("tokenRoleForbidden", 403);

  let days = TOKEN_DEFAULT_EXPIRY_DAYS;
  if (input.expiresInDays !== undefined) {
    const n = input.expiresInDays;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > TOKEN_MAX_EXPIRY_DAYS) throw new ApiError("tokenExpiryInvalid", 422, { max: TOKEN_MAX_EXPIRY_DAYS });
    days = n;
  }
  if (activeCount(owner.id, db, now) >= TOKEN_MAX_ACTIVE) throw new ApiError("tokenLimit", 409, { max: TOKEN_MAX_ACTIVE });

  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const iso = now.toISOString();
  const expires = days === 0 ? null : new Date(now.getTime() + days * DAY_MS).toISOString();
  const id = Number(
    db
      .prepare("INSERT INTO api_tokens (user_id, name, prefix, token_hash, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(owner.id, name, token.slice(0, 8), sha256(token), role, iso, expires).lastInsertRowid,
  );
  return { token, row: listTokens(db, {}, now).find((t) => t.id === id)! };
}

/** Les jetons d'un compte (`userId`) ou, sans filtre, de tous les comptes (administrateur), les plus récents d'abord. */
export function listTokens(db: Db = getDb(), filter: { userId?: number } = {}, now: Date = new Date()): ApiTokenRow[] {
  const rows = (
    filter.userId !== undefined
      ? db.prepare(`${SELECT} WHERE t.user_id = ? ORDER BY t.id DESC`).all(filter.userId)
      : db.prepare(`${SELECT} ORDER BY t.id DESC`).all()
  ) as unknown as Raw[];
  return rows.map((r) => map(r, now));
}

/** Révoque un jeton : son propriétaire ou un administrateur. Idempotent. Retourne la ligne (avec son statut). */
export function revokeToken(id: number, actor: SessionUser, db: Db = getDb(), now: Date = new Date()): ApiTokenRow {
  const raw = db.prepare(`${SELECT} WHERE t.id = ?`).get(id) as Raw | undefined;
  // un jeton d'un autre compte n'existe pas pour qui n'est pas administrateur (pas de sondage d'identifiants)
  if (!raw || (raw.user_id !== actor.id && actor.role !== "admin")) throw new ApiError("tokenNotFound", 404);
  if (!raw.revoked_at) db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ?").run(now.toISOString(), id);
  return map({ ...raw, revoked_at: raw.revoked_at ?? now.toISOString() }, now);
}

export interface TokenAuth {
  tokenId: number;
  prefix: string;
  user: SessionUser;
}

/**
 * Authentifie un jeton présenté dans l'en-tête Authorization. null si : forme invalide, inconnu, révoqué, expiré,
 * ou propriétaire désactivé. Le rôle effectif est le plus faible entre celui du jeton et celui du propriétaire.
 */
export function authenticateToken(raw: string, db: Db = getDb(), now: Date = new Date()): TokenAuth | null {
  if (!TOKEN_PATTERN.test(raw)) return null;
  const r = db
    .prepare(
      `SELECT t.id, t.prefix, t.role AS trole, t.expires_at, t.revoked_at, t.last_used_at,
              u.id AS uid, u.username, u.display_name, u.role AS urole, u.active, u.project_scope
       FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
    )
    .get(sha256(raw)) as
    | { id: number; prefix: string; trole: string; expires_at: string | null; revoked_at: string | null; last_used_at: string | null; uid: number; username: string; display_name: string; urole: Role; active: number; project_scope: string }
    | undefined;
  if (!r || r.revoked_at || r.active !== 1) return null;
  if (r.expires_at && Date.parse(r.expires_at) <= now.getTime()) return null;
  const tokenRole: Role = isTokenRole(r.trole) ? r.trole : "viewer";
  const role: Role = atLeast(r.urole, tokenRole) ? tokenRole : r.urole;
  if (!r.last_used_at || now.getTime() - Date.parse(r.last_used_at) > TOUCH_MS) {
    db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now.toISOString(), r.id);
  }
  return { tokenId: r.id, prefix: r.prefix, user: { id: r.uid, username: r.username, displayName: r.display_name, role, projectScope: r.project_scope === "selected" ? "selected" : "all" } };
}
