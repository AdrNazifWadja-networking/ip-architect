/**
 * Notifications = les contrôles de supervision EN COURS (critiques et avertissements), calculés à la demande sur les
 * données réelles : rien n'est stocké sauf « ce compte a lu ce contrôle ». Un contrôle qui disparaît (problème corrigé)
 * disparaît aussi des notifications ; s'il revient, il est de nouveau non lu après sa disparition (voir pruneReads).
 *
 * Le journal « lu » est propre à chaque compte (user_id = 0 quand l'application est ouverte, sans compte).
 */
import { getDb, type Db } from "./index";
import { getActiveProject } from "./queries";
import { getMonitoring, type Finding } from "./monitoring";
import { NOTIF_MAX_ITEMS, NOTIF_MAX_READ_IDS, type NotificationItem, type NotificationsData } from "../notifTypes";
import { ApiError } from "../types";

const DAY_MS = 86_400_000;
const KEEP_DAYS = 90;

/** Identifie un contrôle de façon stable d'une lecture à l'autre : projet, type, page de correction et valeurs fixes. */
export function fingerprint(projectId: number, f: Finding): string {
  // les valeurs qui changent à chaque lecture (pourcentage, compteurs) ne font pas partie de l'identité du problème
  const volatile = new Set(["pct", "used", "n", "capacity"]);
  const stable = Object.entries(f.params)
    .filter(([k]) => !volatile.has(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  // la gravité en fait partie : un passage d'« avertissement » à « critique » est de nouveau non lu
  return `${projectId}|${f.severity}|${f.kind}|${f.href}|${stable}`.slice(0, 400);
}

const userKey = (userId: number | null | undefined): number => userId ?? 0;

function currentItems(db: Db): { id: string; finding: Finding }[] {
  const project = getActiveProject(db);
  return getMonitoring(db)
    .findings.filter((f) => f.severity !== "info")
    .map((finding) => ({ id: fingerprint(project.id, finding), finding }));
}

export function getNotifications(userId: number | null | undefined, db: Db = getDb()): NotificationsData {
  const key = userKey(userId);
  const cur = currentItems(db);
  const readSet = new Set(
    (db.prepare("SELECT fingerprint FROM notification_reads WHERE user_id = ?").all(key) as { fingerprint: string }[]).map((r) => r.fingerprint),
  );
  const seen = new Set<string>();
  const items: NotificationItem[] = [];
  for (const { id, finding } of cur) {
    if (seen.has(id)) continue; // deux contrôles identiques : une seule notification
    seen.add(id);
    items.push({ id, kind: finding.kind, severity: finding.severity as "critical" | "warning", params: finding.params, href: finding.href, read: readSet.has(id) });
  }
  const unread = items.filter((i) => !i.read).length;
  // non lus d'abord ; l'ordre de gravité (déjà trié par la supervision) est conservé à l'intérieur de chaque groupe
  const ordered = [...items.filter((i) => !i.read), ...items.filter((i) => i.read)];
  return { items: ordered.slice(0, NOTIF_MAX_ITEMS), unread, total: items.length };
}

/**
 * Marque comme lus les contrôles indiqués (`ids`) ou tous (`"all"`). Seuls les identifiants qui correspondent à un
 * contrôle actuel sont retenus : on ne stocke jamais de texte arbitraire venu du navigateur.
 */
export function markRead(userId: number | null | undefined, ids: unknown, db: Db = getDb(), now: Date = new Date()): NotificationsData {
  const key = userKey(userId);
  const cur = new Set(currentItems(db).map((c) => c.id));
  let target: string[];
  if (ids === "all") target = [...cur];
  else {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > NOTIF_MAX_READ_IDS || ids.some((x) => typeof x !== "string")) throw new ApiError("invalidBody", 400);
    target = (ids as string[]).filter((x) => cur.has(x));
  }
  const ins = db.prepare("INSERT OR IGNORE INTO notification_reads (user_id, fingerprint, read_at) VALUES (?, ?, ?)");
  db.transaction(() => {
    for (const id of target) ins.run(key, id, now.toISOString());
    pruneReads(db, now);
  })();
  return getNotifications(userId, db);
}

/** Retire les marques de comptes supprimés et celles de plus de 90 jours. */
export function pruneReads(db: Db = getDb(), now: Date = new Date()): void {
  db.prepare("DELETE FROM notification_reads WHERE read_at < ?").run(new Date(now.getTime() - KEEP_DAYS * DAY_MS).toISOString());
  db.prepare("DELETE FROM notification_reads WHERE user_id != 0 AND user_id NOT IN (SELECT id FROM users)").run();
}
