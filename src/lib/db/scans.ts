/**
 * Scan réseau : un seul scan à la fois sur le serveur, lancé en arrière-plan ; son résultat est enregistré à la fin
 * (les 5 derniers de chaque réseau sont gardés) et comparé à l'inventaire au moment de la lecture, pas avant :
 * une adresse importée ou libérée entre-temps change aussitôt de catégorie.
 */
import { getDb, type Db } from "./index";
import { allocateAddress, getNetwork, listAddresses } from "./ipam";
import { recordAudit } from "./audit";
import { ipInCidr, parseIp } from "../ip/cidr";
import { runScan, type ScanDeps } from "../scan/engine";
import { scanRefusal, scanTargets } from "../scan/targets";
import {
  SCANS_KEPT_PER_NETWORK, SCAN_DEFAULT_PORTS, SCAN_IMPORT_MAX, SCAN_PORTS, SCHEDULES_MAX, SCHEDULE_HOURS,
  type ScanHost, type ScanImportResult, type ScanOptions, type ScanReport, type ScanRow, type ScanSchedule, type ScanSummary, type UpdateScheduleInput,
} from "../scanTypes";
import { ApiError } from "../types";

interface Job {
  networkId: number;
  cidr: string;
  startedAt: string;
  total: number;
  done: number;
  alive: number;
  options: ScanOptions;
  abort: AbortController;
  finished: Promise<void>;
}

const G = globalThis as unknown as { __ipaScanJob?: Job | null };
const current = (): Job | null => G.__ipaScanJob ?? null;

export const scanAllowsPublic = (env: NodeJS.ProcessEnv = process.env): boolean => env.IP_ARCHITECT_SCAN_PUBLIC === "1";

export function cleanScanOptions(raw: unknown): ScanOptions {
  if (raw === undefined || raw === null) return { icmp: true, ports: [...SCAN_DEFAULT_PORTS], resolve: true };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ApiError("invalidBody", 400);
  const o = raw as Record<string, unknown>;
  const flag = (v: unknown, d: boolean): boolean => {
    if (v === undefined) return d;
    if (typeof v !== "boolean") throw new ApiError("invalidBody", 400);
    return v;
  };
  let ports: number[] = [...SCAN_DEFAULT_PORTS];
  if (o.ports !== undefined) {
    if (!Array.isArray(o.ports) || o.ports.length > SCAN_PORTS.length) throw new ApiError("scanInvalidPorts", 422);
    ports = [...new Set(o.ports)] as number[];
    if (ports.some((p) => !(SCAN_PORTS as readonly number[]).includes(p))) throw new ApiError("scanInvalidPorts", 422);
  }
  const opts = { icmp: flag(o.icmp, true), ports, resolve: flag(o.resolve, true) };
  if (!opts.icmp && opts.ports.length === 0) throw new ApiError("scanNoMethod", 422);
  return opts;
}

const summaryOf = (j: Job): ScanSummary => ({
  id: null, networkId: j.networkId, cidr: j.cidr, status: "running", startedAt: j.startedAt, finishedAt: null,
  total: j.total, done: j.done, alive: j.alive, options: j.options, notes: [],
});

/** Lance un scan en arrière-plan. `finished` se résout quand le résultat est enregistré (pratique pour les tests). */
export function startScan(networkId: number, rawOptions: unknown, db: Db = getDb(), deps: ScanDeps = {}, env: NodeJS.ProcessEnv = process.env): { scan: ScanSummary; finished: Promise<void> } {
  const net = getNetwork(networkId, db); // 404 hors du projet actif
  return startScanCore(db, { id: net.id, cidr: net.cidr }, rawOptions, deps, env, false);
}

/** Coeur du lancement, sans notion de projet actif (le planificateur n'a pas d'utilisateur). */
function startScanCore(db: Db, net: { id: number; cidr: string }, rawOptions: unknown, deps: ScanDeps, env: NodeJS.ProcessEnv, scheduled: boolean): { scan: ScanSummary; finished: Promise<void> } {
  const refusal = scanRefusal(net.cidr, scanAllowsPublic(env));
  if (refusal === "ipv6") throw new ApiError("scanIpv6", 422);
  if (refusal === "tooBig") throw new ApiError("scanTooBig", 422);
  if (refusal === "notPrivate") throw new ApiError("scanNotPrivate", 422);
  if (current()) throw new ApiError("scanBusy", 409);
  const options = cleanScanOptions(rawOptions);

  const targets = scanTargets(net.cidr);
  const abort = new AbortController();
  const job: Job = { networkId: net.id, cidr: net.cidr, startedAt: new Date().toISOString(), total: targets.length, done: 0, alive: 0, options, abort, finished: Promise.resolve() };
  G.__ipaScanJob = job;
  job.finished = (async () => {
    try {
      const out = await runScan(targets, options, abort.signal, (p) => { job.done = p.done; job.alive = p.alive; }, deps);
      save(db, job, out.cancelled ? "cancelled" : "done", out.hosts, scheduled ? [...out.notes, "scheduled"] : out.notes);
    } catch (e) {
      console.error("scan", e);
    } finally {
      if (G.__ipaScanJob === job) G.__ipaScanJob = null;
    }
  })();
  return { scan: summaryOf(job), finished: job.finished };
}

function save(db: Db, job: Job, status: "done" | "cancelled", hosts: ScanHost[], notes: string[]): void {
  db.transaction(() => {
    // le réseau a pu être supprimé pendant le scan : rien à enregistrer
    if (!db.prepare("SELECT 1 FROM networks WHERE id = ?").get(job.networkId)) return;
    db.prepare("INSERT INTO scans (network_id, cidr, status, started_at, finished_at, total, options, hosts, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(job.networkId, job.cidr, status, job.startedAt, new Date().toISOString(), job.total, JSON.stringify(job.options), JSON.stringify(hosts), JSON.stringify(notes));
    db.prepare("DELETE FROM scans WHERE network_id = ? AND id NOT IN (SELECT id FROM scans WHERE network_id = ? ORDER BY id DESC LIMIT ?)").run(job.networkId, job.networkId, SCANS_KEPT_PER_NETWORK);
  })();
}

/** Annule le scan en cours (celui d'un autre projet aussi : un seul scan à la fois sur le serveur, donc seul le propriétaire du réseau peut l'annuler). */
export function cancelScan(networkId: number, db: Db = getDb()): void {
  getNetwork(networkId, db);
  const j = current();
  if (!j || j.networkId !== networkId) throw new ApiError("scanNotRunning", 404);
  j.abort.abort();
}

interface RawScan { id: number; network_id: number; cidr: string; status: string; started_at: string; finished_at: string; total: number; options: string; hosts: string; notes: string }

const latest = (db: Db, networkId: number): RawScan | undefined =>
  db.prepare("SELECT id, network_id, cidr, status, started_at, finished_at, total, options, hosts, notes FROM scans WHERE network_id = ? ORDER BY id DESC LIMIT 1").get(networkId) as RawScan | undefined;

const emptyCounts = (): ScanReport["counts"] => ({ new: 0, known: 0, silent: 0, ignored: 0 });
const num = (a: string) => a.split(".").reduce((x, o) => x * 256 + Number(o), 0);

/** Compare les hôtes trouvés à l'inventaire (fonction pure). `previous` : hôtes du scan d'avant, pour repérer un changement de MAC. */
export function diffScan(
  hosts: readonly ScanHost[],
  inventory: readonly { address: string; status: "used" | "reserved"; hostname: string | null }[],
  ignored: ReadonlySet<string> = new Set(),
  previous: readonly ScanHost[] = [],
): { rows: ScanRow[]; counts: ScanReport["counts"] } {
  const inv = new Map(inventory.map((a) => [a.address, a]));
  const alive = new Set(hosts.map((h) => h.address));
  const before = new Map(previous.map((h) => [h.address, h.mac ?? null]));
  const rows: ScanRow[] = [];
  for (const h of hosts) {
    const a = inv.get(h.address);
    const mac = h.mac ?? null;
    const old = before.get(h.address) ?? null;
    rows.push({
      address: h.address, state: a ? "known" : ignored.has(h.address) ? "ignored" : "new", ms: h.ms, via: h.via, discoveredHostname: h.hostname,
      hostname: a?.hostname ?? null, inventoryStatus: a?.status ?? null, mac, prevMac: mac && old && old !== mac ? old : null,
    });
  }
  for (const a of inventory) {
    if (a.status === "used" && !alive.has(a.address)) rows.push({ address: a.address, state: "silent", ms: null, via: [], discoveredHostname: null, hostname: a.hostname, inventoryStatus: a.status, mac: null, prevMac: null });
  }
  rows.sort((a, b) => num(a.address) - num(b.address));
  const counts = emptyCounts();
  for (const r of rows) counts[r.state]++;
  return { rows, counts };
}

const ignoredSet = (db: Db, networkId: number): Set<string> =>
  new Set((db.prepare("SELECT address FROM scan_ignored WHERE network_id = ?").all(networkId) as { address: string }[]).map((r) => r.address));

/** Scan en cours pour ce réseau, sinon le dernier scan enregistré, comparé à l'inventaire d'aujourd'hui. */
export function getScanReport(networkId: number, db: Db = getDb()): ScanReport {
  getNetwork(networkId, db);
  const j = current();
  if (j && j.networkId === networkId) return { scan: summaryOf(j), rows: [], counts: emptyCounts() };
  const two = db.prepare("SELECT id, network_id, cidr, status, started_at, finished_at, total, options, hosts, notes FROM scans WHERE network_id = ? ORDER BY id DESC LIMIT 2").all(networkId) as RawScan[];
  const s = two[0];
  if (!s) return { scan: null, rows: [], counts: emptyCounts() };
  const hosts = JSON.parse(s.hosts) as ScanHost[];
  const previous = two[1] ? (JSON.parse(two[1].hosts) as ScanHost[]) : [];
  const d = diffScan(hosts, listAddresses(networkId, db).map((a) => ({ address: a.address, status: a.status, hostname: a.hostname })), ignoredSet(db, networkId), previous);
  const scan: ScanSummary = {
    id: s.id, networkId, cidr: s.cidr, status: s.status === "cancelled" ? "cancelled" : "done", startedAt: s.started_at, finishedAt: s.finished_at,
    total: s.total, done: s.status === "cancelled" ? 0 : s.total, alive: hosts.length, options: JSON.parse(s.options) as ScanOptions, notes: JSON.parse(s.notes) as string[],
  };
  return { scan, ...d };
}

/** Marque (ou démarque) des adresses comme « ignorées » : connues, mais volontairement absentes de l'inventaire. */
export function setIgnored(networkId: number, addresses: unknown, ignored: unknown, db: Db = getDb()): { changed: number } {
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > SCAN_IMPORT_MAX || typeof ignored !== "boolean") throw new ApiError("invalidBody", 400);
  const net = getNetwork(networkId, db);
  const list = [...new Set(addresses)] as unknown[];
  for (const a of list) {
    const p = typeof a === "string" ? parseIp(a) : null;
    if (!p || p.version !== 4 || !ipInCidr(a as string, net.cidr)) throw new ApiError("addressOutsideNetwork", 422, { address: String(a).slice(0, 45), cidr: net.cidr });
  }
  let changed = 0;
  db.transaction(() => {
    for (const a of list as string[]) {
      changed += ignored
        ? Number(db.prepare("INSERT OR IGNORE INTO scan_ignored (network_id, address, created_at) VALUES (?, ?, ?)").run(networkId, a, new Date().toISOString()).changes)
        : Number(db.prepare("DELETE FROM scan_ignored WHERE network_id = ? AND address = ?").run(networkId, a).changes);
    }
  })();
  return { changed };
}

/**
 * Importe dans l'IPAM des hôtes DÉCOUVERTS par le dernier scan (statut « utilisée », nom = DNS inverse). Seules les
 * adresses de ce scan, encore non inventoriées, sont acceptées. Tout ou rien.
 */
export function importScanHosts(networkId: number, addresses: unknown, db: Db = getDb()): ScanImportResult & { created: number[] } {
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > SCAN_IMPORT_MAX || addresses.some((a) => typeof a !== "string")) throw new ApiError("invalidBody", 400);
  getNetwork(networkId, db);
  const s = latest(db, networkId);
  if (!s) throw new ApiError("scanNone", 404);
  const found = new Map((JSON.parse(s.hosts) as ScanHost[]).map((h) => [h.address, h]));
  const day = s.finished_at.slice(0, 10);
  const taken = new Set(listAddresses(networkId, db).map((a) => a.address));
  const want = [...new Set(addresses as string[])];
  let skipped = 0;
  const created: number[] = [];
  db.transaction(() => {
    for (const a of want) {
      const h = found.get(a);
      if (!h) throw new ApiError("scanHostUnknown", 422, { address: a });
      if (taken.has(a)) { skipped++; continue; }
      created.push(allocateAddress(networkId, { address: a, status: "used", hostname: h.hostname ?? undefined, description: h.mac ? `Scan ${day} · MAC ${h.mac}` : `Scan ${day}` }, db).id);
    }
  })();
  return { imported: created.length, skipped, created };
}

/* ------------------------------ Scans programmés ------------------------------ */

interface RawSchedule { network_id: number; every_hours: number; enabled: number; alert: number; options: string; last_started_at: string | null }

const mapSchedule = (r: RawSchedule): ScanSchedule => ({
  networkId: r.network_id,
  everyHours: r.every_hours,
  enabled: r.enabled === 1,
  alert: r.alert === 1,
  options: JSON.parse(r.options) as ScanOptions,
  lastStartedAt: r.last_started_at,
  nextAt: r.enabled === 1 && r.last_started_at ? new Date(Date.parse(r.last_started_at) + r.every_hours * 3_600_000).toISOString() : null,
});

export function getSchedule(networkId: number, db: Db = getDb()): ScanSchedule | null {
  getNetwork(networkId, db);
  const r = db.prepare("SELECT network_id, every_hours, enabled, alert, options, last_started_at FROM scan_schedules WHERE network_id = ?").get(networkId) as RawSchedule | undefined;
  return r ? mapSchedule(r) : null;
}

/** Crée ou modifie le scan programmé d'un réseau (un par réseau). Un réseau non scannable est refusé tout de suite. */
export function setSchedule(networkId: number, input: UpdateScheduleInput, db: Db = getDb(), env: NodeJS.ProcessEnv = process.env): ScanSchedule {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length === 0) throw new ApiError("invalidBody", 400);
  const net = getNetwork(networkId, db);
  const refusal = scanRefusal(net.cidr, scanAllowsPublic(env));
  if (refusal === "ipv6") throw new ApiError("scanIpv6", 422);
  if (refusal === "tooBig") throw new ApiError("scanTooBig", 422);
  if (refusal === "notPrivate") throw new ApiError("scanNotPrivate", 422);

  const cur = db.prepare("SELECT network_id, every_hours, enabled, alert, options, last_started_at FROM scan_schedules WHERE network_id = ?").get(networkId) as RawSchedule | undefined;
  const base = cur ? mapSchedule(cur) : null;
  if (input.everyHours !== undefined && !(SCHEDULE_HOURS as readonly number[]).includes(input.everyHours as number)) throw new ApiError("scanInvalidSchedule", 422);
  for (const k of ["enabled", "alert"] as const) if (input[k] !== undefined && typeof input[k] !== "boolean") throw new ApiError("invalidBody", 400);
  const every = input.everyHours ?? base?.everyHours ?? 24;
  const enabled = input.enabled ?? base?.enabled ?? true;
  const alert = input.alert ?? base?.alert ?? true;
  const opt: Record<string, unknown> = { ...(base?.options ?? {}) };
  for (const k of ["icmp", "ports", "resolve"] as const) if (input[k] !== undefined) opt[k] = input[k];
  const options = cleanScanOptions(Object.keys(opt).length ? opt : undefined);

  if (!cur) {
    const n = (db.prepare(
      `SELECT COUNT(*) AS c FROM scan_schedules s JOIN networks n ON n.id = s.network_id
       WHERE n.project_id = (SELECT project_id FROM networks WHERE id = ?)`,
    ).get(networkId) as { c: number }).c;
    if (n >= SCHEDULES_MAX) throw new ApiError("scanScheduleLimit", 409, { max: SCHEDULES_MAX });
  }
  db.prepare(
    `INSERT INTO scan_schedules (network_id, every_hours, enabled, alert, options, last_started_at) VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT(network_id) DO UPDATE SET every_hours = excluded.every_hours, enabled = excluded.enabled, alert = excluded.alert, options = excluded.options`,
  ).run(networkId, every, enabled ? 1 : 0, alert ? 1 : 0, JSON.stringify(options));
  return getSchedule(networkId, db)!;
}

export function deleteSchedule(networkId: number, db: Db = getDb()): void {
  getNetwork(networkId, db);
  if (db.prepare("DELETE FROM scan_schedules WHERE network_id = ?").run(networkId).changes === 0) throw new ApiError("scanNoSchedule", 404);
}

/**
 * Lance le scan programmé le plus en retard, s'il y en a un et si aucun scan ne tourne. Appelé chaque minute par le
 * planificateur. L'heure de lancement est écrite AVANT le scan : un réseau devenu non scannable n'est pas relancé en boucle.
 * Renvoie l'id du réseau lancé, et une promesse qui se résout quand le résultat est enregistré.
 */
export function runDueSchedules(db: Db = getDb(), now: Date = new Date(), deps: ScanDeps = {}, env: NodeJS.ProcessEnv = process.env): { networkId: number; finished: Promise<void> } | null {
  if (current()) return null;
  const rows = db.prepare(
    `SELECT s.network_id, s.every_hours, s.options, s.last_started_at, n.cidr, n.project_id
     FROM scan_schedules s JOIN networks n ON n.id = s.network_id
     WHERE s.enabled = 1 ORDER BY COALESCE(s.last_started_at, '') ASC, s.network_id ASC`,
  ).all() as { network_id: number; every_hours: number; options: string; last_started_at: string | null; cidr: string; project_id: number }[];
  const due = rows.find((r) => !r.last_started_at || now.getTime() - Date.parse(r.last_started_at) >= r.every_hours * 3_600_000);
  if (!due) return null;
  db.prepare("UPDATE scan_schedules SET last_started_at = ? WHERE network_id = ?").run(now.toISOString(), due.network_id);
  try {
    const { finished } = startScanCore(db, { id: due.network_id, cidr: due.cidr }, JSON.parse(due.options), deps, env, true);
    recordAudit({ action: "create", entity: "scan", entityId: due.network_id, detail: "scan programmé", userId: null, username: null, projectId: due.project_id }, db, now);
    return { networkId: due.network_id, finished };
  } catch (e) {
    if (e instanceof ApiError) return null; // réseau devenu non scannable : ignoré jusqu'au prochain créneau
    throw e;
  }
}

/** Réseaux (programmés avec alerte) dont le dernier scan a trouvé des hôtes absents de l'inventaire et non ignorés. Pour la supervision. */
export function scanNewHostCounts(db: Db, projectId: number): { cidr: string; name: string; count: number; hosts: string; networkId: number }[] {
  const nets = db.prepare(
    `SELECT n.id, n.cidr, n.name FROM scan_schedules s JOIN networks n ON n.id = s.network_id
     WHERE n.project_id = ? AND s.enabled = 1 AND s.alert = 1 ORDER BY n.id`,
  ).all(projectId) as { id: number; cidr: string; name: string }[];
  const out: { cidr: string; name: string; count: number; hosts: string; networkId: number }[] = [];
  for (const n of nets) {
    const s = latest(db, n.id);
    if (!s) continue;
    const inv = new Set((db.prepare("SELECT address FROM ip_addresses WHERE network_id = ?").all(n.id) as { address: string }[]).map((r) => r.address));
    const ign = ignoredSet(db, n.id);
    const fresh = (JSON.parse(s.hosts) as ScanHost[]).map((h) => h.address).filter((a) => !inv.has(a) && !ign.has(a)).sort((a, b) => num(a) - num(b));
    if (fresh.length > 0) out.push({ cidr: n.cidr, name: n.name, count: fresh.length, hosts: fresh.slice(0, 5).join(", ") + (fresh.length > 5 ? "…" : ""), networkId: n.id });
  }
  return out;
}
