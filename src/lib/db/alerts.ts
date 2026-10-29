/**
 * Alertes par e-mail sur la supervision.
 *
 * À chaque passage : pour chaque projet, on calcule les contrôles en cours (gravité ≥ seuil choisi) ; ceux qui n'ont pas
 * encore été signalés partent dans UN seul message (par destinataire). Un problème déjà signalé n'est pas renvoyé tant qu'il dure ;
 * s'il disparaît puis revient, il est de nouveau signalé. Si l'envoi échoue, rien n'est marqué : le passage suivant réessaie.
 * Le premier passage après l'activation signale les problèmes déjà présents (c'est le but : être prévenu).
 */
import { getDb, type Db } from "./index";
import { getMonitoring } from "./monitoring";
import { fingerprint } from "./notifications";
import { getSignupConfig } from "./signupsettings";
import { deliverMail, type Deliver } from "../mail/send";
import { alertMail, type AlertLine } from "../mail/templates";
import { dictionaries, format, type Locale } from "../i18n";
import {
  ALERT_DEFAULT_INTERVAL_MIN,
  ALERT_MAX_INTERVAL_MIN,
  ALERT_MAX_LINES,
  ALERT_MAX_RECIPIENTS,
  ALERT_MIN_INTERVAL_MIN,
  ALERT_SEVERITIES,
  type AlertConfig,
  type AlertRunResult,
  type AlertSeverity,
  type UpdateAlertConfigInput,
} from "../alertTypes";
import { normalizeEmail } from "../signupTypes";
import { ApiError } from "../types";

const K = { enabled: "alerts_enabled", recipients: "alerts_recipients", min: "alerts_min_severity", interval: "alerts_interval_min", locale: "alerts_locale", last: "alerts_last_run" } as const;

const read = (db: Db, key: string): string | null => {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r ? r.value : null;
};
const write = (db: Db, key: string, value: string) =>
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);

export function mailReady(db: Db): boolean {
  const c = getSignupConfig(db);
  return c.consoleMode || (c.smtp.host !== "" && c.smtp.from !== "");
}

export function getAlertConfig(db: Db = getDb()): AlertConfig {
  const interval = Number(read(db, K.interval));
  const min = read(db, K.min);
  let lastRun: AlertRunResult | null = null;
  try {
    const raw = read(db, K.last);
    if (raw) lastRun = JSON.parse(raw) as AlertRunResult;
  } catch {
    lastRun = null;
  }
  return {
    enabled: read(db, K.enabled) === "1",
    recipients: (read(db, K.recipients) ?? "").split(",").filter(Boolean),
    minSeverity: (ALERT_SEVERITIES as readonly string[]).includes(min ?? "") ? (min as AlertSeverity) : "critical",
    intervalMin: Number.isInteger(interval) && interval >= ALERT_MIN_INTERVAL_MIN && interval <= ALERT_MAX_INTERVAL_MIN ? interval : ALERT_DEFAULT_INTERVAL_MIN,
    locale: read(db, K.locale) === "en" ? "en" : "fr",
    projectRecipients: (db.prepare("SELECT id, name FROM projects ORDER BY id").all() as { id: number; name: string }[]).map((p) => ({
      projectId: p.id,
      name: p.name,
      recipients: (db.prepare("SELECT email FROM project_alert_recipients WHERE project_id = ? ORDER BY email").all(p.id) as { email: string }[]).map((r) => r.email),
    })),
    lastRun,
    mailReady: mailReady(db),
  };
}

const bad = (field: string) => new ApiError("alertsInvalidConfig", 422, { field });

function parseRecipients(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,;\s]+/) : null;
  if (!parts) throw bad("recipients");
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p !== "string" || p.trim() === "") continue;
    const e = normalizeEmail(p);
    if (!e) throw bad("recipients");
    if (!out.includes(e)) out.push(e);
  }
  if (out.length > ALERT_MAX_RECIPIENTS) throw bad("recipients");
  return out;
}

export function updateAlertConfig(input: UpdateAlertConfigInput, db: Db = getDb()): AlertConfig {
  const cur = getAlertConfig(db);
  let enabled = cur.enabled;
  let recipients = cur.recipients;
  let min = cur.minSeverity;
  let interval = cur.intervalMin;
  let locale = cur.locale;
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw bad("enabled");
    enabled = input.enabled;
  }
  if (input.recipients !== undefined) recipients = parseRecipients(input.recipients);
  if (input.minSeverity !== undefined) {
    if (!(ALERT_SEVERITIES as readonly string[]).includes(input.minSeverity)) throw bad("minSeverity");
    min = input.minSeverity as AlertSeverity;
  }
  if (input.intervalMin !== undefined) {
    if (!Number.isInteger(input.intervalMin) || input.intervalMin < ALERT_MIN_INTERVAL_MIN || input.intervalMin > ALERT_MAX_INTERVAL_MIN) throw bad("intervalMin");
    interval = input.intervalMin;
  }
  if (input.locale !== undefined) {
    if (input.locale !== "fr" && input.locale !== "en") throw bad("locale");
    locale = input.locale;
  }
  // listes par projet : validées avant toute écriture
  const perProject = new Map<number, string[]>();
  if (input.projectRecipients !== undefined) {
    if (!Array.isArray(input.projectRecipients) || input.projectRecipients.length > 500) throw bad("projectRecipients");
    for (const e of input.projectRecipients) {
      if (!e || typeof e !== "object" || !Number.isInteger(e.projectId)) throw bad("projectRecipients");
      if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(e.projectId)) throw new ApiError("projectNotFound", 404);
      perProject.set(e.projectId, parseRecipients(e.recipients));
    }
  }
  const anyProject = cur.projectRecipients.some((p) => (perProject.has(p.projectId) ? perProject.get(p.projectId)! : p.recipients).length > 0);
  if (enabled && recipients.length === 0 && !anyProject) throw bad("recipients");
  db.transaction(() => {
    for (const [pid, list] of perProject) {
      db.prepare("DELETE FROM project_alert_recipients WHERE project_id = ?").run(pid);
      for (const email of list) db.prepare("INSERT INTO project_alert_recipients (project_id, email) VALUES (?, ?)").run(pid, email);
    }
    write(db, K.enabled, enabled ? "1" : "0");
    write(db, K.recipients, recipients.join(","));
    write(db, K.min, min);
    write(db, K.interval, String(interval));
    write(db, K.locale, locale);
  })();
  return getAlertConfig(db);
}

export interface AlertDeps {
  deliver?: Deliver;
  now?: Date;
}

export interface RunOutcome extends AlertRunResult {
  /** Le passage n'a rien fait (alertes désactivées, ou pas encore l'heure). */
  skipped?: "disabled" | "notDue";
}

/**
 * Un passage. `force` ignore le délai (bouton « lancer maintenant ») mais pas l'activation. Ne lève jamais pour un échec d'envoi :
 * il est consigné dans le résultat (`error`) et le passage suivant réessaie.
 */
export async function runAlerts(db: Db = getDb(), deps: AlertDeps = {}, opts: { force?: boolean } = {}): Promise<RunOutcome> {
  const now = deps.now ?? new Date();
  const cfg = getAlertConfig(db);
  const empty = { at: now.toISOString(), fresh: 0, sent: 0, error: null };
  if (!cfg.enabled) return { ...empty, skipped: "disabled" };
  if (!opts.force && cfg.lastRun && now.getTime() - Date.parse(cfg.lastRun.at) < cfg.intervalMin * 60_000) return { ...empty, skipped: "notDue" };
  if (!cfg.mailReady) return finish(db, { ...empty, error: "signupNotConfigured" });

  const t = dictionaries[cfg.locale as Locale];
  const wanted = cfg.minSeverity === "critical" ? ["critical"] : ["critical", "warning"];
  const projects = db.prepare("SELECT id, name FROM projects ORDER BY id").all() as { id: number; name: string }[];
  type Entry = { line: AlertLine; projectId: number; fp: string };
  const fresh: Entry[] = [];
  const audience = new Map<number, string[]>(); // projet -> destinataires communs + propres au projet
  for (const p of projects) {
    const own = cfg.projectRecipients.find((x) => x.projectId === p.id)?.recipients ?? [];
    audience.set(p.id, [...new Set([...cfg.recipients, ...own])]);
    const current = new Map<string, AlertLine>();
    for (const f of getMonitoring(db, p.id).findings) {
      if (!wanted.includes(f.severity)) continue;
      const fp = fingerprint(p.id, f);
      if (!current.has(fp)) current.set(fp, { project: p.name, severity: f.severity as "critical" | "warning", text: format(t.monitoring.findings[f.kind], f.params), href: f.href });
    }
    const known = new Set((db.prepare("SELECT fingerprint FROM alert_state WHERE project_id = ?").all(p.id) as { fingerprint: string }[]).map((r) => r.fingerprint));
    // un problème disparu est oublié : s'il revient, on le signale de nouveau
    for (const k of known) if (!current.has(k)) db.prepare("DELETE FROM alert_state WHERE project_id = ? AND fingerprint = ?").run(p.id, k);
    // un projet sans aucun destinataire n'est pas marqué : ses problèmes seront signalés dès qu'une adresse sera ajoutée
    if (audience.get(p.id)!.length === 0) continue;
    for (const [fp, line] of current) if (!known.has(fp)) fresh.push({ line, projectId: p.id, fp });
  }
  // projets supprimés
  db.prepare("DELETE FROM alert_state WHERE project_id NOT IN (SELECT id FROM projects)").run();
  if (fresh.length === 0) return finish(db, empty);

  // un message par destinataire, avec seulement les problèmes des projets qui le concernent
  const byRecipient = new Map<string, Entry[]>();
  for (const e of fresh) for (const to of audience.get(e.projectId)!) byRecipient.set(to, [...(byRecipient.get(to) ?? []), e]);
  const deliver = deps.deliver ?? deliverMail;
  let sent = 0;
  let error: string | null = null;
  const reached = new Set<string>(); // « projet|empreinte » reçus par au moins une personne
  for (const [to, entries] of byRecipient) {
    const lines = entries.map((e) => e.line).sort((x, y) => (x.severity === y.severity ? 0 : x.severity === "critical" ? -1 : 1));
    const msg = alertMail(cfg.locale as Locale, lines.slice(0, ALERT_MAX_LINES), Math.max(0, lines.length - ALERT_MAX_LINES));
    try {
      await deliver(db, { to, ...msg });
      sent++;
      for (const e of entries) reached.add(`${e.projectId}|${e.fp}`);
    } catch (e) {
      error = e instanceof ApiError ? e.code : "mailUnreachable";
      console.error("alertes : envoi impossible", e instanceof Error ? e.message.slice(0, 200) : e);
    }
  }
  // marqué comme signalé dès qu'au moins un destinataire du projet a reçu le message ; sinon le passage suivant réessaie
  const ins = db.prepare("INSERT OR IGNORE INTO alert_state (project_id, fingerprint, first_sent_at) VALUES (?, ?, ?)");
  db.transaction(() => {
    for (const e of fresh) if (reached.has(`${e.projectId}|${e.fp}`)) ins.run(e.projectId, e.fp, now.toISOString());
  })();
  return finish(db, { at: now.toISOString(), fresh: fresh.length, sent, error });
}

function finish(db: Db, r: AlertRunResult): AlertRunResult {
  write(db, K.last, JSON.stringify(r));
  return r;
}
