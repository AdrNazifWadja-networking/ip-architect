/** Types et constantes de l'inscription par e-mail, sans accès à la base : importables côté navigateur. */

/** Durée de validité du code de vérification : deux minutes, pas une de plus (vérifié côté serveur). */
export const SIGNUP_CODE_TTL_MS = 120_000;
export const SIGNUP_CODE_LENGTH = 6;
export const SIGNUP_MAX_ATTEMPTS = 5;

export const SMTP_SECURITY = ["tls", "starttls", "none"] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY)[number];
export const isSmtpSecurity = (v: unknown): v is SmtpSecurity => typeof v === "string" && (SMTP_SECURITY as readonly string[]).includes(v);

/** Valeurs proposées (le serveur accepte n'importe quel serveur SMTP). « none » n'est accepté que vers la machine locale. */
export const SMTP_PRESETS: Record<"gmail" | "outlook" | "custom", { host: string; port: number; security: SmtpSecurity }> = {
  gmail: { host: "smtp.gmail.com", port: 465, security: "tls" },
  outlook: { host: "smtp-mail.outlook.com", port: 587, security: "starttls" },
  custom: { host: "", port: 587, security: "starttls" },
};

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string;
  /** Adresse d'expéditeur. */
  from: string;
  /** Un mot de passe est enregistré (il n'est jamais renvoyé). */
  hasPassword: boolean;
}

export interface SignupConfig {
  enabled: boolean;
  /** Domaines autorisés (vide = tous). */
  domains: string[];
  /** Test uniquement : le code est écrit dans la console du serveur au lieu d'être envoyé par e-mail. */
  consoleMode: boolean;
  smtp: SmtpConfig;
}

export interface UpdateSignupConfigInput {
  enabled?: unknown;
  domains?: unknown;
  consoleMode?: unknown;
  smtpHost?: unknown;
  smtpPort?: unknown;
  smtpSecurity?: unknown;
  smtpUser?: unknown;
  /** undefined = inchangé ; "" = effacé ; sinon nouveau mot de passe. */
  smtpPassword?: unknown;
  smtpFrom?: unknown;
}

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** Adresse en minuscules, ou null si elle n'est pas valide (ASCII uniquement, aucun caractère de contrôle ni espace). */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  if (e.length < 6 || e.length > 254) return null;
  const local = e.slice(0, e.indexOf("@"));
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  return EMAIL_RE.test(e) ? e : null;
}

export const emailDomain = (email: string): string => email.slice(email.indexOf("@") + 1);

/** Un seul code est utilisé à la fois : 6 chiffres. */
export const isCodeShape = (v: unknown): v is string => typeof v === "string" && /^\d{6}$/.test(v);

export const isLoopback = (host: string): boolean => host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
