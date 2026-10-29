/**
 * Inscription en libre-service avec vérification de l'adresse e-mail.
 *
 * 1. startSignup : on valide tout (adresse, identifiant, mot de passe), on enregistre une demande EN ATTENTE (mot de passe
 *    déjà haché, code salé + haché) et on envoie un code à 6 chiffres. Le code est valable 2 minutes (SIGNUP_CODE_TTL_MS).
 * 2. verifySignup : le bon code, dans les 2 minutes et en 5 essais au plus, crée le compte (TOUJOURS « lecteur ») et ouvre
 *    la session. Délai dépassé : la demande est supprimée et la personne doit recommencer l'inscription.
 *
 * Garde-fous : l'inscription doit être activée par un administrateur ET la connexion doit déjà être exigée ; limites de
 * débit par adresse et par IP ; une adresse déjà utilisée n'est jamais révélée (la même réponse est renvoyée, et un mail
 * le dit à son propriétaire) ; le code n'est jamais stocké en clair ; comparaison à temps constant.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { getDb, type Db } from "./index";
import { getSignupConfig, isSignupOpen } from "./signupsettings";
import { createVerifiedUser, emailInUse, normalizeUsername, openSession, validatePassword } from "./users";
import { hashPassword } from "../auth/password";
import { RateLimiter } from "../ai/limit";
import { deliverMail, type Deliver } from "../mail/send";
import { alreadyRegisteredMail, codeMail } from "../mail/templates";
import type { Locale } from "../i18n";
import { emailDomain, isCodeShape, normalizeEmail, SIGNUP_CODE_LENGTH, SIGNUP_CODE_TTL_MS, SIGNUP_MAX_ATTEMPTS } from "../signupTypes";
import { ApiError, type SessionUser } from "../types";

/** Limites en mémoire (remises à zéro au redémarrage du serveur). */
export interface SignupLimits {
  startByEmail: RateLimiter;
  startByIp: RateLimiter;
  verifyByIp: RateLimiter;
}
export const newSignupLimits = (): SignupLimits => ({
  startByEmail: new RateLimiter(3, 10 * 60_000),
  startByIp: new RateLimiter(10, 60 * 60_000),
  verifyByIp: new RateLimiter(30, 10 * 60_000),
});
export const signupLimits = newSignupLimits();

export interface SignupDeps {
  deliver?: Deliver;
  limits?: SignupLimits;
  now?: Date;
  /** Remplaçable dans les tests. */
  makeCode?: () => string;
}

export interface SignupCtx {
  locale: Locale;
  ip?: string | null;
}

const makeCodeDefault = (): string => String(randomInt(0, 10 ** SIGNUP_CODE_LENGTH)).padStart(SIGNUP_CODE_LENGTH, "0");
const hashCode = (salt: string, code: string): Buffer => createHash("sha256").update(`${salt}:${code}`).digest();

function limited(wait: number): never {
  throw new ApiError("signupTooManyRequests", 429, { minutes: Math.max(1, Math.ceil(wait / 60_000)) });
}

function purge(db: Db, now: Date): void {
  // les demandes expirées ne servent plus à rien ; on garde une marge d'une heure pour répondre « expiré » plutôt que « introuvable »
  db.prepare("DELETE FROM signup_requests WHERE expires_at < ?").run(new Date(now.getTime() - 3_600_000).toISOString());
}

export interface StartInput {
  email?: unknown;
  username?: unknown;
  displayName?: unknown;
  password?: unknown;
}

/** Valide, enregistre la demande en attente et envoie le code. Renvoie la durée de validité restante. */
export async function startSignup(input: StartInput, ctx: SignupCtx, db: Db = getDb(), deps: SignupDeps = {}): Promise<{ expiresInMs: number }> {
  const now = deps.now ?? new Date();
  const limits = deps.limits ?? signupLimits;
  if (!isSignupOpen(db)) throw new ApiError("signupUnavailable", 403);
  if (!input || typeof input !== "object") throw new ApiError("invalidBody", 400);

  const email = normalizeEmail(input.email);
  if (!email) throw new ApiError("emailInvalid", 422);
  const wait = Math.max(limits.startByEmail.take(`e:${email}`, now.getTime()), ctx.ip ? limits.startByIp.take(`ip:${ctx.ip}`, now.getTime()) : 0);
  if (wait > 0) limited(wait);

  const cfg = getSignupConfig(db);
  if (cfg.domains.length > 0 && !cfg.domains.includes(emailDomain(email))) throw new ApiError("signupDomainNotAllowed", 422, { domains: cfg.domains.join(", ") });

  const username = normalizeUsername(input.username);
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
  if (!displayName) throw new ApiError("nameRequired", 422);
  if (displayName.length > 80) throw new ApiError("nameTooLong", 422);
  const password = validatePassword(input.password, username);
  if (db.prepare("SELECT 1 FROM users WHERE LOWER(username) = ?").get(username)) throw new ApiError("usernameTaken", 409, { name: username });
  // identifiant réservé par une autre demande encore valide : même réponse qu'un identifiant pris
  const holder = db.prepare("SELECT email FROM signup_requests WHERE username = ? AND expires_at >= ? AND email != ?").get(username, now.toISOString(), email) as { email: string } | undefined;
  if (holder) throw new ApiError("usernameTaken", 409, { name: username });

  const deliver = deps.deliver ?? deliverMail;
  purge(db, now);

  if (emailInUse(email, db)) {
    // même réponse que le cas normal : on ne révèle pas qu'un compte existe ; son propriétaire est prévenu par e-mail
    await deliver(db, { to: email, ...alreadyRegisteredMail(ctx.locale) });
    return { expiresInMs: SIGNUP_CODE_TTL_MS };
  }

  const code = (deps.makeCode ?? makeCodeDefault)();
  const salt = randomBytes(16).toString("hex");
  const passwordHash = await hashPassword(password);
  const expiresAt = new Date(now.getTime() + SIGNUP_CODE_TTL_MS);
  db.prepare(
    `INSERT INTO signup_requests (email, username, display_name, password_hash, code_salt, code_hash, attempts, expires_at, created_at, ip)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET username = excluded.username, display_name = excluded.display_name, password_hash = excluded.password_hash,
       code_salt = excluded.code_salt, code_hash = excluded.code_hash, attempts = 0, expires_at = excluded.expires_at, created_at = excluded.created_at, ip = excluded.ip`,
  ).run(email, username, displayName, passwordHash, salt, hashCode(salt, code).toString("hex"), expiresAt.toISOString(), now.toISOString(), ctx.ip ?? null);

  try {
    await deliver(db, { to: email, ...codeMail(ctx.locale, code, SIGNUP_CODE_TTL_MS / 60_000, displayName) });
  } catch (e) {
    db.prepare("DELETE FROM signup_requests WHERE email = ?").run(email); // pas de demande orpheline si le mail n'est pas parti
    throw e;
  }
  return { expiresInMs: SIGNUP_CODE_TTL_MS };
}

export interface VerifyResult {
  token: string;
  user: SessionUser;
  userId: number;
}

/** Vérifie le code ; crée le compte « lecteur » et ouvre la session. */
export async function verifySignup(input: { email?: unknown; code?: unknown }, ctx: SignupCtx, db: Db = getDb(), deps: SignupDeps = {}): Promise<VerifyResult> {
  const now = deps.now ?? new Date();
  const limits = deps.limits ?? signupLimits;
  if (!isSignupOpen(db)) throw new ApiError("signupUnavailable", 403);
  if (!input || typeof input !== "object") throw new ApiError("invalidBody", 400);
  if (ctx.ip) {
    const wait = limits.verifyByIp.take(`ip:${ctx.ip}`, now.getTime());
    if (wait > 0) limited(wait);
  }
  const email = normalizeEmail(input.email);
  if (!email) throw new ApiError("emailInvalid", 422);

  const row = db.prepare("SELECT * FROM signup_requests WHERE email = ?").get(email) as
    | { username: string; display_name: string; password_hash: string; code_salt: string; code_hash: string; attempts: number; expires_at: string }
    | undefined;
  if (!row) throw new ApiError("signupNoRequest", 404);
  const drop = () => db.prepare("DELETE FROM signup_requests WHERE email = ?").run(email);

  if (now.getTime() > Date.parse(row.expires_at)) {
    drop();
    throw new ApiError("signupCodeExpired", 410); // il faut recommencer l'inscription
  }
  if (row.attempts >= SIGNUP_MAX_ATTEMPTS) {
    drop();
    throw new ApiError("signupTooManyAttempts", 429);
  }
  const given = isCodeShape(input.code) ? hashCode(row.code_salt, input.code) : Buffer.alloc(32);
  const expected = Buffer.from(row.code_hash, "hex");
  const ok = isCodeShape(input.code) && expected.length === given.length && timingSafeEqual(given, expected);
  if (!ok) {
    const attempts = row.attempts + 1;
    if (attempts >= SIGNUP_MAX_ATTEMPTS) {
      drop();
      throw new ApiError("signupTooManyAttempts", 429);
    }
    db.prepare("UPDATE signup_requests SET attempts = ? WHERE email = ?").run(attempts, email);
    throw new ApiError("signupCodeInvalid", 422, { left: SIGNUP_MAX_ATTEMPTS - attempts });
  }

  let user;
  try {
    user = createVerifiedUser({ username: row.username, displayName: row.display_name, passwordHash: row.password_hash, email }, db, now);
  } catch (e) {
    drop(); // identifiant ou adresse pris entre-temps : la demande ne peut plus aboutir
    throw e;
  }
  drop();
  const token = openSession(db, user.id, now);
  return { token, userId: user.id, user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role, projectScope: user.projectScope } };
}
