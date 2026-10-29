/**
 * Mot de passe oublié, par e-mail.
 *
 * 1. startReset : on répond TOUJOURS la même chose (« si un compte existe, un code part »), que l'adresse corresponde ou non
 *    à un compte actif, et sans attendre l'envoi du mail : ni la réponse ni son délai ne révèlent si une adresse existe.
 * 2. completeReset : le bon code (10 minutes, 5 essais, usage unique) + un nouveau mot de passe valide changent le mot de
 *    passe, ferment toutes les sessions du compte et marquent l'adresse comme vérifiée. Aucune connexion automatique.
 *
 * Disponible seulement si l'envoi d'e-mails est configuré (ou le mode console de test) et si la connexion est exigée.
 * Le code n'est jamais stocké en clair ; comparaison à temps constant ; limites de débit par adresse et par IP.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { getDb, type Db } from "./index";
import { getSignupConfig } from "./signupsettings";
import { applyPasswordReset, authEnabled, validatePassword } from "./users";
import { hashPassword } from "../auth/password";
import { RateLimiter } from "../ai/limit";
import { deliverMail, type Deliver } from "../mail/send";
import { resetCodeMail } from "../mail/templates";
import type { Locale } from "../i18n";
import { RESET_CODE_TTL_MS, RESET_MAX_ATTEMPTS } from "../resetTypes";
import { isCodeShape, normalizeEmail, SIGNUP_CODE_LENGTH } from "../signupTypes";
import { ApiError } from "../types";

export interface ResetLimits {
  startByEmail: RateLimiter;
  startByIp: RateLimiter;
  verifyByIp: RateLimiter;
}
export const newResetLimits = (): ResetLimits => ({
  startByEmail: new RateLimiter(3, 10 * 60_000),
  startByIp: new RateLimiter(10, 60 * 60_000),
  verifyByIp: new RateLimiter(30, 10 * 60_000),
});
export const resetLimits = newResetLimits();

export interface ResetDeps {
  deliver?: Deliver;
  limits?: ResetLimits;
  now?: Date;
  makeCode?: () => string;
}
export interface ResetCtx {
  locale: Locale;
  ip?: string | null;
}

const makeCodeDefault = (): string => String(randomInt(0, 10 ** SIGNUP_CODE_LENGTH)).padStart(SIGNUP_CODE_LENGTH, "0");
const hashCode = (salt: string, code: string): Buffer => createHash("sha256").update(`${salt}:${code}`).digest();

function limited(wait: number): never {
  throw new ApiError("signupTooManyRequests", 429, { minutes: Math.max(1, Math.ceil(wait / 60_000)) });
}

/** La réinitialisation par e-mail est possible : connexion exigée ET un moyen d'envoyer le code (SMTP, ou mode console de test). */
export function isResetAvailable(db: Db = getDb()): boolean {
  if (!authEnabled(db)) return false;
  const cfg = getSignupConfig(db);
  return cfg.consoleMode || (cfg.smtp.host !== "" && cfg.smtp.from !== "");
}

/**
 * Enregistre la demande et lance l'envoi. Renvoie tout de suite ; `done` se termine quand le mail est parti (ou a échoué :
 * l'échec est tracé dans la console du serveur, jamais montré à la personne). La route n'attend PAS `done`.
 */
export function startReset(input: { email?: unknown }, ctx: ResetCtx, db: Db = getDb(), deps: ResetDeps = {}): { expiresInMs: number; done: Promise<void> } {
  const now = deps.now ?? new Date();
  const limits = deps.limits ?? resetLimits;
  if (!isResetAvailable(db)) throw new ApiError("resetUnavailable", 403);
  if (!input || typeof input !== "object") throw new ApiError("invalidBody", 400);
  const email = normalizeEmail(input.email);
  if (!email) throw new ApiError("emailInvalid", 422);
  const wait = Math.max(limits.startByEmail.take(`e:${email}`, now.getTime()), ctx.ip ? limits.startByIp.take(`ip:${ctx.ip}`, now.getTime()) : 0);
  if (wait > 0) limited(wait);

  const same = { expiresInMs: RESET_CODE_TTL_MS };
  db.prepare("DELETE FROM password_resets WHERE expires_at < ?").run(new Date(now.getTime() - 3_600_000).toISOString());
  const user = db.prepare("SELECT id FROM users WHERE LOWER(email) = ? AND active = 1 AND auth_source = 'local'").get(email) as { id: number } | undefined;
  if (!user) return { ...same, done: Promise.resolve() };

  const code = (deps.makeCode ?? makeCodeDefault)();
  const salt = randomBytes(16).toString("hex");
  db.prepare(
    `INSERT INTO password_resets (user_id, code_salt, code_hash, attempts, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET code_salt = excluded.code_salt, code_hash = excluded.code_hash, attempts = 0, expires_at = excluded.expires_at, created_at = excluded.created_at`,
  ).run(user.id, salt, hashCode(salt, code).toString("hex"), new Date(now.getTime() + RESET_CODE_TTL_MS).toISOString(), now.toISOString());

  const deliver = deps.deliver ?? deliverMail;
  const done = deliver(db, { to: email, ...resetCodeMail(ctx.locale, code, RESET_CODE_TTL_MS / 60_000) }).catch((e: unknown) => {
    // pas de demande orpheline si le mail n'est pas parti ; l'erreur n'est visible que dans la console du serveur
    db.prepare("DELETE FROM password_resets WHERE user_id = ?").run(user.id);
    console.error("réinitialisation : envoi du code impossible", e instanceof Error ? e.message.slice(0, 200) : e);
  });
  return { ...same, done };
}

export interface ResetResult {
  userId: number;
  username: string;
}

export async function completeReset(
  input: { email?: unknown; code?: unknown; newPassword?: unknown },
  ctx: ResetCtx,
  db: Db = getDb(),
  deps: ResetDeps = {},
): Promise<ResetResult> {
  const now = deps.now ?? new Date();
  const limits = deps.limits ?? resetLimits;
  if (!isResetAvailable(db)) throw new ApiError("resetUnavailable", 403);
  if (!input || typeof input !== "object") throw new ApiError("invalidBody", 400);
  if (ctx.ip) {
    const wait = limits.verifyByIp.take(`ip:${ctx.ip}`, now.getTime());
    if (wait > 0) limited(wait);
  }
  const email = normalizeEmail(input.email);
  if (!email) throw new ApiError("emailInvalid", 422);

  const row = db
    .prepare(
      `SELECT r.user_id, r.code_salt, r.code_hash, r.attempts, r.expires_at, u.username
       FROM password_resets r JOIN users u ON u.id = r.user_id WHERE LOWER(u.email) = ? AND u.active = 1`,
    )
    .get(email) as { user_id: number; code_salt: string; code_hash: string; attempts: number; expires_at: string; username: string } | undefined;
  // même réponse qu'un code absent : on ne distingue pas « adresse inconnue » de « pas de demande en cours »
  if (!row) throw new ApiError("resetNoRequest", 404);
  const drop = () => db.prepare("DELETE FROM password_resets WHERE user_id = ?").run(row.user_id);

  if (now.getTime() > Date.parse(row.expires_at)) {
    drop();
    throw new ApiError("resetCodeExpired", 410);
  }
  if (row.attempts >= RESET_MAX_ATTEMPTS) {
    drop();
    throw new ApiError("resetTooManyAttempts", 429);
  }
  const given = isCodeShape(input.code) ? hashCode(row.code_salt, input.code) : Buffer.alloc(32);
  const expected = Buffer.from(row.code_hash, "hex");
  const ok = isCodeShape(input.code) && expected.length === given.length && timingSafeEqual(given, expected);
  if (!ok) {
    const attempts = row.attempts + 1;
    if (attempts >= RESET_MAX_ATTEMPTS) {
      drop();
      throw new ApiError("resetTooManyAttempts", 429);
    }
    db.prepare("UPDATE password_resets SET attempts = ? WHERE user_id = ?").run(attempts, row.user_id);
    throw new ApiError("resetCodeInvalid", 422, { left: RESET_MAX_ATTEMPTS - attempts });
  }
  // le code est bon : le nouveau mot de passe est validé APRÈS (un mot de passe refusé ne brûle pas le code) et le code ne sert qu'une fois
  const password = validatePassword(input.newPassword, row.username);
  const hash = await hashPassword(password);
  applyPasswordReset(db, row.user_id, hash, now);
  drop();
  return { userId: row.user_id, username: row.username };
}
