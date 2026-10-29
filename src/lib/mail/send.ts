/** Envoi d'un e-mail avec les réglages enregistrés. Les échecs sont traduits en codes d'erreur de l'application. */
import type { Db } from "../db";
import { getSignupConfig, getSmtpSecret } from "../db/signupsettings";
import { ApiError } from "../types";
import { sendMail, SmtpError, type MailMessage, type SmtpHooks } from "./smtp";

/** Remplaçable dans les tests. */
export type Deliver = (db: Db, msg: MailMessage) => Promise<void>;

export const deliverMail: Deliver = async (db, msg) => {
  const cfg = getSignupConfig(db);
  if (cfg.consoleMode) {
    // TEST UNIQUEMENT (réglage explicite d'un administrateur) : le code apparaît dans la console du serveur
    console.log(`[mail - mode console] à ${msg.to} | ${msg.subject}\n${msg.text}`);
    return;
  }
  if (!cfg.smtp.host || !cfg.smtp.from) throw new ApiError("signupNotConfigured", 409);
  return deliverVia({ ...cfg.smtp, password: getSmtpSecret(db) }, msg);
};

export async function deliverVia(ep: Parameters<typeof sendMail>[0] | (Omit<Parameters<typeof sendMail>[0], never>), msg: MailMessage, hooks?: SmtpHooks): Promise<void> {
  try {
    await sendMail(ep, msg, hooks);
  } catch (e) {
    if (!(e instanceof SmtpError)) throw e;
    console.error(`mail : échec d'envoi (${ep.host}:${ep.port}) ${e.message}`.slice(0, 300)); // jamais d'identifiants dans ce message
    const map = { unreachable: ["mailUnreachable", 502], tls: ["mailTls", 502], auth: ["mailAuth", 502], timeout: ["mailTimeout", 504], rejected: ["mailRejected", 502], protocol: ["mailRejected", 502] } as const;
    const [code, status] = map[e.kind];
    throw new ApiError(code, status, { host: ep.host });
  }
}
