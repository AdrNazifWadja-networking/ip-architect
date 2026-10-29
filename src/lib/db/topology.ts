/**
 * Topologie réseau : équipements, liens, machines vues sur les ports. Saisie à la main ou découverte SNMP (LLDP/CDP/FDB).
 * Une découverte à la fois sur le serveur, en arrière-plan. Le résultat est fusionné avec l'existant : ce qui a été saisi à la main
 * (nom, type, position, liens) n'est jamais écrasé ni supprimé par une découverte.
 */
import { getDb, type Db } from "./index";
import { getNetwork } from "./ipam";
import { runScan, type ScanDeps } from "../scan/engine";
import { scanTargets } from "../scan/targets";
import { ipInCidr } from "../ip/cidr";
import { SCAN_DEFAULT_PORTS, type ScanHost } from "../scanTypes";
import { vbText } from "../snmp/codec";
import { getActiveProject } from "./queries";
import { crawl, type CrawlResult } from "../topology/discover";
import { SnmpClient, type SnmpLike } from "../snmp/client";
import { parseIp } from "../ip/cidr";
import { scanRefusal } from "../scan/targets";
import { ApiError } from "../types";
import {
  TOPO_CREDENTIALS_MAX, TOPO_DEPTH_MAX, TOPO_DEVICES_MAX, TOPO_LINKS_MAX, isTopoKind,
  type DiscoverInput, type DiscoverStatus, type TopoClient, type TopoCredential, type TopoDevice, type TopoKind, type TopoLink, type TopoPort, type TopologyData,
} from "../topologyTypes";

const now = (): string => new Date().toISOString();
const str = (v: unknown, max: number): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new ApiError("topoInvalid", 400);
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (s.length > max) throw new ApiError("topoInvalid", 400);
  return s || null;
};
const obj = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError("invalidBody", 400);
  return raw as Record<string, unknown>;
};
const num = (v: unknown, lo: number, hi: number): number | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new ApiError("topoInvalid", 400);
  return v;
};

/** Adresse interrogeable : IPv4 privée (ou toute IPv4 avec IP_ARCHITECT_SCAN_PUBLIC=1). */
export function topoAddressRefused(address: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const p = parseIp(address);
  if (!p || p.version !== 4) return true;
  return scanRefusal(`${address}/32`, env.IP_ARCHITECT_SCAN_PUBLIC === "1") !== null;
}

/* ------------------------------ Identifiants SNMP ------------------------------ */

interface CredRow { id: number; name: string; port: number }

export function listCredentials(db: Db = getDb()): TopoCredential[] {
  const p = getActiveProject(db);
  return db.prepare("SELECT id, name, port FROM snmp_credentials WHERE project_id = ? ORDER BY name").all(p.id) as unknown as CredRow[];
}

export function createCredential(raw: unknown, db: Db = getDb()): TopoCredential {
  const o = obj(raw);
  const name = str(o.name, 60), community = typeof o.community === "string" ? o.community : null;
  const port = o.port === undefined ? 161 : num(o.port, 1, 65535);
  if (!name || !community || community.length > 128 || /[\u0000-\u001f]/.test(community) || port === null) throw new ApiError("topoInvalid", 400);
  const p = getActiveProject(db);
  if ((db.prepare("SELECT COUNT(*) AS n FROM snmp_credentials WHERE project_id = ?").get(p.id) as { n: number }).n >= TOPO_CREDENTIALS_MAX) throw new ApiError("topoCredentialLimit", 422);
  try {
    const id = Number(db.prepare("INSERT INTO snmp_credentials (project_id, name, community, port) VALUES (?, ?, ?, ?)").run(p.id, name, community, port).lastInsertRowid);
    return { id, name, port };
  } catch {
    throw new ApiError("topoDuplicate", 409);
  }
}

export function updateCredential(id: number, raw: unknown, db: Db = getDb()): TopoCredential {
  const o = obj(raw);
  const p = getActiveProject(db);
  const cur = db.prepare("SELECT id, name, port FROM snmp_credentials WHERE id = ? AND project_id = ?").get(id, p.id) as CredRow | undefined;
  if (!cur) throw new ApiError("topoCredentialNotFound", 404);
  const name = o.name === undefined ? cur.name : str(o.name, 60);
  const port = o.port === undefined ? cur.port : num(o.port, 1, 65535);
  if (!name || port === null) throw new ApiError("topoInvalid", 400);
  try {
    db.prepare("UPDATE snmp_credentials SET name = ?, port = ? WHERE id = ?").run(name, port, id);
    // communauté absente ou vide = inchangée
    if (typeof o.community === "string" && o.community !== "") {
      if (o.community.length > 128 || /[\u0000-\u001f]/.test(o.community)) throw new ApiError("topoInvalid", 400);
      db.prepare("UPDATE snmp_credentials SET community = ? WHERE id = ?").run(o.community, id);
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("topoDuplicate", 409);
  }
  return { id, name, port };
}

export function deleteCredential(id: number, db: Db = getDb()): void {
  const p = getActiveProject(db);
  if (db.prepare("DELETE FROM snmp_credentials WHERE id = ? AND project_id = ?").run(id, p.id).changes === 0) throw new ApiError("topoCredentialNotFound", 404);
}

/* ------------------------------ Équipements et liens ------------------------------ */

interface DevRow {
  id: number; name: string; address: string | null; kind: string; info: string | null; chassis_id: string | null; site_id: number | null; credential_id: number | null;
  source: string; pos_x: number | null; pos_y: number | null; last_seen_at: string | null; ports: string; clients: number;
}

const toDevice = (r: DevRow): TopoDevice => ({
  id: r.id, name: r.name, address: r.address, kind: isTopoKind(r.kind) ? r.kind : "other", info: r.info, chassisId: r.chassis_id, siteId: r.site_id,
  credentialId: r.credential_id, source: r.source === "snmp" || r.source === "lldp" || r.source === "scan" ? r.source : "manual", x: r.pos_x, y: r.pos_y, lastSeenAt: r.last_seen_at,
  ports: JSON.parse(r.ports) as TopoPort[], clientCount: r.clients,
});

const DEV_SQL = `SELECT d.*, (SELECT COUNT(*) FROM topo_clients c WHERE c.device_id = d.id) AS clients FROM topo_devices d`;

export function getTopology(db: Db = getDb()): TopologyData {
  const p = getActiveProject(db);
  const devices = (db.prepare(`${DEV_SQL} WHERE d.project_id = ? ORDER BY d.name`).all(p.id) as unknown as DevRow[]).map(toDevice);
  const links = (db.prepare("SELECT id, a_device, a_port, b_device, b_port, source, speed_mbps, last_seen_at FROM topo_links WHERE project_id = ? ORDER BY id").all(p.id) as unknown as Array<Record<string, unknown>>).map(
    (r): TopoLink => ({ id: r.id as number, aDevice: r.a_device as number, aPort: r.a_port as string | null, bDevice: r.b_device as number, bPort: r.b_port as string | null, source: r.source as TopoLink["source"], speedMbps: r.speed_mbps as number | null, lastSeenAt: r.last_seen_at as string | null }),
  );
  return { devices, links };
}

function ownDevice(db: Db, id: number): DevRow {
  const p = getActiveProject(db);
  const r = db.prepare(`${DEV_SQL} WHERE d.id = ? AND d.project_id = ?`).get(id, p.id) as DevRow | undefined;
  if (!r) throw new ApiError("topoDeviceNotFound", 404);
  return r;
}

export const getDevice = (id: number, db: Db = getDb()): TopoDevice => toDevice(ownDevice(db, id));

export function listClients(deviceId: number, db: Db = getDb()): TopoClient[] {
  ownDevice(db, deviceId);
  return (db.prepare("SELECT device_id, port, mac, ip, vlan, last_seen_at FROM topo_clients WHERE device_id = ? ORDER BY port, mac").all(deviceId) as unknown as Array<Record<string, unknown>>).map(
    (r) => ({ deviceId: r.device_id as number, port: r.port as string | null, mac: r.mac as string, ip: r.ip as string | null, vlan: r.vlan as number | null, lastSeenAt: r.last_seen_at as string }),
  );
}

function cleanAddress(v: unknown): string | null {
  const a = str(v, 45);
  if (a !== null && !parseIp(a)) throw new ApiError("topoInvalid", 400);
  return a;
}

function checkRefs(db: Db, projectId: number, siteId: number | null, credentialId: number | null): void {
  if (siteId !== null && !db.prepare("SELECT 1 FROM sites WHERE id = ? AND project_id = ?").get(siteId, projectId)) throw new ApiError("topoInvalid", 400);
  if (credentialId !== null && !db.prepare("SELECT 1 FROM snmp_credentials WHERE id = ? AND project_id = ?").get(credentialId, projectId)) throw new ApiError("topoCredentialNotFound", 404);
}

export function createDevice(raw: unknown, db: Db = getDb()): TopoDevice {
  const o = obj(raw);
  const p = getActiveProject(db);
  const name = str(o.name, 80);
  const kind = o.kind === undefined ? "other" : o.kind;
  if (!name || !isTopoKind(kind)) throw new ApiError("topoInvalid", 400);
  const siteId = o.siteId === undefined || o.siteId === null ? null : (num(o.siteId, 1, 2 ** 31) as number);
  const credentialId = o.credentialId === undefined || o.credentialId === null ? null : (num(o.credentialId, 1, 2 ** 31) as number);
  checkRefs(db, p.id, siteId, credentialId);
  if ((db.prepare("SELECT COUNT(*) AS n FROM topo_devices WHERE project_id = ?").get(p.id) as { n: number }).n >= TOPO_DEVICES_MAX) throw new ApiError("topoLimit", 422);
  const id = Number(db.prepare("INSERT INTO topo_devices (project_id, name, address, kind, info, site_id, credential_id, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')").run(p.id, name, cleanAddress(o.address), kind, str(o.info, 300), siteId, credentialId).lastInsertRowid);
  return getDevice(id, db);
}

export function updateDevice(id: number, raw: unknown, db: Db = getDb()): TopoDevice {
  const o = obj(raw);
  const cur = ownDevice(db, id);
  const p = getActiveProject(db);
  const name = o.name === undefined ? cur.name : str(o.name, 80);
  const kind = o.kind === undefined ? cur.kind : o.kind;
  if (!name || !isTopoKind(kind)) throw new ApiError("topoInvalid", 400);
  const address = o.address === undefined ? cur.address : cleanAddress(o.address);
  const info = o.info === undefined ? cur.info : str(o.info, 300);
  const siteId = o.siteId === undefined ? cur.site_id : o.siteId === null ? null : (num(o.siteId, 1, 2 ** 31) as number);
  const credentialId = o.credentialId === undefined ? cur.credential_id : o.credentialId === null ? null : (num(o.credentialId, 1, 2 ** 31) as number);
  checkRefs(db, p.id, siteId, credentialId);
  let x = cur.pos_x, y = cur.pos_y;
  if (o.x !== undefined || o.y !== undefined) {
    x = o.x === null ? null : num(o.x, -100000, 100000);
    y = o.y === null ? null : num(o.y, -100000, 100000);
    if ((x === null) !== (y === null)) throw new ApiError("topoInvalid", 400);
  }
  db.prepare("UPDATE topo_devices SET name = ?, address = ?, kind = ?, info = ?, site_id = ?, credential_id = ?, pos_x = ?, pos_y = ? WHERE id = ?").run(name, address, kind, info, siteId, credentialId, x, y, id);
  return getDevice(id, db);
}

export function deleteDevice(id: number, db: Db = getDb()): void {
  ownDevice(db, id);
  db.prepare("DELETE FROM topo_devices WHERE id = ?").run(id);
}

/** Positions saisies en bloc (glisser-déposer) ; `null` pour tout remettre en automatique. */
export function setPositions(raw: unknown, db: Db = getDb()): number {
  const p = getActiveProject(db);
  if (raw === null || (raw && typeof raw === "object" && !Array.isArray(raw) && (raw as { reset?: unknown }).reset === true)) {
    return db.prepare("UPDATE topo_devices SET pos_x = NULL, pos_y = NULL WHERE project_id = ?").run(p.id).changes as number;
  }
  const list = (raw as { positions?: unknown })?.positions;
  if (!Array.isArray(list) || list.length > TOPO_DEVICES_MAX) throw new ApiError("topoInvalid", 400);
  let n = 0;
  db.transaction(() => {
    for (const it of list) {
      const o = obj(it);
      const id = num(o.id, 1, 2 ** 31), x = num(o.x, -100000, 100000), y = num(o.y, -100000, 100000);
      if (id === null || x === null || y === null) throw new ApiError("topoInvalid", 400);
      n += db.prepare("UPDATE topo_devices SET pos_x = ?, pos_y = ? WHERE id = ? AND project_id = ?").run(x, y, id, p.id).changes as number;
    }
  })();
  return n;
}

export function createLink(raw: unknown, db: Db = getDb()): TopoLink {
  const o = obj(raw);
  const p = getActiveProject(db);
  const a = num(o.aDevice, 1, 2 ** 31), b = num(o.bDevice, 1, 2 ** 31);
  if (a === null || b === null || a === b) throw new ApiError("topoInvalidLink", 422);
  for (const d of [a, b]) if (!db.prepare("SELECT 1 FROM topo_devices WHERE id = ? AND project_id = ?").get(d, p.id)) throw new ApiError("topoDeviceNotFound", 404);
  const speed = num(o.speedMbps, 1, 1_000_000);
  const [lo, hi, loPort, hiPort] = a < b ? [a, b, str(o.aPort, 60), str(o.bPort, 60)] : [b, a, str(o.bPort, 60), str(o.aPort, 60)];
  if (db.prepare("SELECT 1 FROM topo_links WHERE project_id = ? AND a_device = ? AND b_device = ? AND IFNULL(a_port, '') = ? AND IFNULL(b_port, '') = ?").get(p.id, lo, hi, loPort ?? "", hiPort ?? "")) throw new ApiError("topoInvalidLink", 422);
  if ((db.prepare("SELECT COUNT(*) AS n FROM topo_links WHERE project_id = ?").get(p.id) as { n: number }).n >= TOPO_LINKS_MAX) throw new ApiError("topoLimit", 422);
  const id = Number(db.prepare("INSERT INTO topo_links (project_id, a_device, a_port, b_device, b_port, source, speed_mbps) VALUES (?, ?, ?, ?, ?, 'manual', ?)").run(p.id, lo, loPort, hi, hiPort, speed).lastInsertRowid);
  return getTopology(db).links.find((l) => l.id === id)!;
}

export function deleteLink(id: number, db: Db = getDb()): void {
  const p = getActiveProject(db);
  if (db.prepare("DELETE FROM topo_links WHERE id = ? AND project_id = ?").run(id, p.id).changes === 0) throw new ApiError("topoLinkNotFound", 404);
}

/* ------------------------------ Découverte ------------------------------ */

const norm = (s: string | null): string => (s ?? "").trim().toLowerCase();

/** Fusionne un résultat de parcours dans le projet. Rien de ce qui est manuel n'est supprimé. */
export function applyCrawl(db: Db, projectId: number, res: CrawlResult, credentialId: number | null, at = now()): { devices: number; links: number; clients: number } {
  const ids = new Map<string, number>();
  const polledIds: number[] = [];
  let links = 0, clients = 0;
  db.transaction(() => {
    const existing = db.prepare("SELECT id, name, address, chassis_id, source FROM topo_devices WHERE project_id = ?").all(projectId) as unknown as Array<{ id: number; name: string; address: string | null; chassis_id: string | null; source: string }>;
    let total = existing.length;
    for (const d of res.devices) {
      const hit = existing.find((e) => (d.chassisId && e.chassis_id && norm(e.chassis_id) === norm(d.chassisId)) || (d.address && e.address === d.address) || (!d.address && !d.chassisId && norm(e.name) === norm(d.name)));
      const ports = JSON.stringify(d.ports);
      if (hit) {
        // un équipement saisi à la main garde son nom et son type ; on complète le reste
        const manual = hit.source === "manual";
        db.prepare(`UPDATE topo_devices SET name = ${manual ? "name" : "?"}, kind = ${manual ? "kind" : "?"}, address = COALESCE(address, ?), info = COALESCE(?, info), chassis_id = COALESCE(chassis_id, ?),
          source = CASE WHEN ? = 1 THEN 'snmp' ELSE source END, credential_id = CASE WHEN ? = 1 THEN ? ELSE credential_id END, last_seen_at = ?, ports = CASE WHEN ? = 1 THEN ? ELSE ports END WHERE id = ?`).run(
          ...(manual ? [] : [d.name, d.kind]), d.address, d.info, d.chassisId, d.polled ? 1 : 0, d.polled ? 1 : 0, credentialId, at, d.polled ? 1 : 0, ports, hit.id);
        ids.set(d.key, hit.id);
        if (!hit.chassis_id && d.chassisId) hit.chassis_id = d.chassisId;
      } else {
        if (total >= TOPO_DEVICES_MAX) continue;
        total++;
        const id = Number(db.prepare("INSERT INTO topo_devices (project_id, name, address, kind, info, chassis_id, credential_id, source, last_seen_at, ports) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          projectId, d.name.slice(0, 80), d.address, d.kind, d.info?.slice(0, 300) ?? null, d.chassisId, d.polled ? credentialId : null, d.polled ? "snmp" : "lldp", at, ports).lastInsertRowid);
        ids.set(d.key, id);
        existing.push({ id, name: d.name, address: d.address, chassis_id: d.chassisId, source: d.polled ? "snmp" : "lldp" });
      }
      if (d.polled) polledIds.push(ids.get(d.key)!);
    }
    // les liens annoncés par un équipement interrogé cette fois sont remplacés par ce qu'il annonce aujourd'hui
    for (const id of polledIds) db.prepare("DELETE FROM topo_links WHERE project_id = ? AND reported_by = ? AND source != 'manual'").run(projectId, id);
    for (const id of polledIds) db.prepare("DELETE FROM topo_clients WHERE device_id = ?").run(id);
    let linkCount = (db.prepare("SELECT COUNT(*) AS n FROM topo_links WHERE project_id = ?").get(projectId) as { n: number }).n;
    for (const l of res.links) {
      const a = ids.get(l.a), b = ids.get(l.b);
      if (!a || !b || a === b || linkCount >= TOPO_LINKS_MAX) continue;
      const [lo, hi, lp, hp] = a < b ? [a, b, l.aPort, l.bPort] : [b, a, l.bPort, l.aPort];
      const dup = db.prepare("SELECT id FROM topo_links WHERE project_id = ? AND a_device = ? AND b_device = ? AND (IFNULL(a_port, '') = ? OR IFNULL(b_port, '') = ?)").get(projectId, lo, hi, lp ?? "", hp ?? "") as { id: number } | undefined;
      if (dup) {
        db.prepare("UPDATE topo_links SET a_port = COALESCE(a_port, ?), b_port = COALESCE(b_port, ?), speed_mbps = COALESCE(?, speed_mbps), last_seen_at = ? WHERE id = ?").run(lp, hp, l.speedMbps, at, dup.id);
        continue;
      }
      db.prepare("INSERT INTO topo_links (project_id, a_device, a_port, b_device, b_port, source, reported_by, speed_mbps, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(projectId, lo, lp, hi, hp, l.via, ids.get(l.reportedBy) ?? null, l.speedMbps, at);
      linkCount++;
      links++;
    }
    for (const c of res.clients) {
      const dev = ids.get(c.device);
      if (!dev) continue;
      db.prepare("INSERT OR REPLACE INTO topo_clients (device_id, mac, port, ip, vlan, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)").run(dev, c.mac, c.port, c.ip, c.vlan, at);
      clients++;
    }
  })();
  return { devices: ids.size, links, clients };
}

interface Job { status: DiscoverStatus; abort: AbortController; finished: Promise<void> }
const G = globalThis as unknown as { __ipaTopoJob?: Job | null };
const IDLE: DiscoverStatus = { status: "idle", seed: null, phase: null, startedAt: null, finishedAt: null, visited: 0, queued: 0, devices: 0, links: 0, clients: 0, notes: [] };
const TOPO_MAX_MS = 5 * 60_000;

export const discoveryStatus = (): DiscoverStatus => G.__ipaTopoJob?.status ?? IDLE;
export function cancelDiscovery(): boolean {
  const j = G.__ipaTopoJob;
  if (!j || j.status.status !== "running") return false;
  j.abort.abort();
  return true;
}

export interface TopoDeps { connect?(address: string, community: string, port: number): SnmpLike; scan?: ScanDeps }

export function startDiscovery(raw: unknown, db: Db = getDb(), deps: TopoDeps = {}, env: NodeJS.ProcessEnv = process.env): { status: DiscoverStatus; finished: Promise<void> } {
  const o = obj(raw);
  if (o.networkId !== undefined) return startNetworkDiscovery(o, db, deps, env);
  const seed = str(o.seed, 45);
  const credId = num(o.credentialId, 1, 2 ** 31);
  const depth = o.depth === undefined ? 3 : num(o.depth, 0, TOPO_DEPTH_MAX);
  if (!seed || credId === null || depth === null || !parseIp(seed)) throw new ApiError("topoInvalid", 400);
  const loopback = env.IP_ARCHITECT_TOPO_TEST_LOOPBACK === "1";
  const refuse = (a: string): string | null => (loopback && a.startsWith("127.") ? null : topoAddressRefused(a, env) ? "adresse refusée" : null);
  if (refuse(seed)) throw new ApiError("topoAddressRefused", 422);
  const p = getActiveProject(db);
  const cred = db.prepare("SELECT community, port FROM snmp_credentials WHERE id = ? AND project_id = ?").get(credId, p.id) as { community: string; port: number } | undefined;
  if (!cred) throw new ApiError("topoCredentialNotFound", 404);
  if (G.__ipaTopoJob?.status.status === "running") throw new ApiError("topoBusy", 409);

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TOPO_MAX_MS);
  const status: DiscoverStatus = { ...IDLE, status: "running", seed, phase: "snmp", startedAt: now() };
  const connect = deps.connect ?? ((a: string, c: string, port: number) => new SnmpClient({ host: a, community: c, port }));
  const finished = (async () => {
    try {
      const res = await crawl(seed, depth, {
        connect: (a) => connect(a, cred.community, cred.port), refuse, signal: abort.signal,
        onProgress: (pr) => Object.assign(status, pr),
      });
      const done = applyCrawl(db, p.id, res, credId);
      Object.assign(status, { devices: done.devices, links: done.links, clients: done.clients, notes: res.notes.slice(0, 50), status: res.cancelled ? "cancelled" : "done" });
    } catch (e) {
      status.status = "failed";
      status.notes = [(e as Error).message];
    } finally {
      clearTimeout(timer);
      status.finishedAt = now();
    }
  })();
  G.__ipaTopoJob = { status, abort, finished };
  return { status, finished };
}

/* ------------------------------ Découverte d'un réseau de l'IPAM ------------------------------ */

const guessKind = (h: ScanHost, gateway: string | null): TopoKind => {
  if (gateway && h.address === gateway) return "router";
  if (h.via.includes("tcp:53")) return "server";
  if (h.via.includes("tcp:3389") || h.via.includes("tcp:445") || h.via.includes("tcp:135")) return "host";
  return "other";
};

/**
 * Place dans la topologie les hôtes trouvés par le scan d'un réseau : un nuage « réseau » relié à la passerelle ; chaque hôte est relié
 * au port du switch qui l'a vu (table MAC lue en SNMP) ou, faute de mieux, au nuage. Rien de saisi à la main n'est modifié.
 */
export function applyScanHosts(db: Db, projectId: number, net: { cidr: string; name: string; gateway: string | null }, hosts: ScanHost[], at = now()): { devices: number; links: number } {
  let devices = 0, links = 0;
  db.transaction(() => {
    const all = () => db.prepare("SELECT id, name, address, kind, source FROM topo_devices WHERE project_id = ?").all(projectId) as unknown as Array<{ id: number; name: string; address: string | null; kind: string; source: string }>;
    let total = all().length;
    const cloudName = `${net.cidr} ${net.name}`.slice(0, 80);
    let cloud = all().find((d) => d.kind === "network" && d.name === cloudName);
    if (!cloud && total < TOPO_DEVICES_MAX) {
      const id = Number(db.prepare("INSERT INTO topo_devices (project_id, name, kind, info, source, last_seen_at) VALUES (?, ?, 'network', ?, 'scan', ?)").run(projectId, cloudName, net.cidr, at).lastInsertRowid);
      cloud = { id, name: cloudName, address: null, kind: "network", source: "scan" };
      total++;
    }
    // les anciens liens du scan de ce réseau sont refaits : un hôte qui a changé de port ne doit pas rester sur l'ancien
    const old = db.prepare("SELECT l.id, a.address AS aa, b.address AS ba, l.a_device, l.b_device FROM topo_links l JOIN topo_devices a ON a.id = l.a_device JOIN topo_devices b ON b.id = l.b_device WHERE l.project_id = ? AND l.source = 'scan'").all(projectId) as unknown as Array<{ id: number; aa: string | null; ba: string | null; a_device: number; b_device: number }>;
    for (const l of old) if ((l.aa && ipInCidr(l.aa, net.cidr)) || (l.ba && ipInCidr(l.ba, net.cidr)) || (cloud && (l.a_device === cloud.id || l.b_device === cloud.id))) db.prepare("DELETE FROM topo_links WHERE id = ?").run(l.id);
    const linkOnce = (x: number, xPort: string | null, y: number, yPort: string | null): void => {
      if (x === y) return;
      const [lo, hi, lp, hp] = x < y ? [x, y, xPort, yPort] : [y, x, yPort, xPort];
      if (db.prepare("SELECT 1 FROM topo_links WHERE project_id = ? AND a_device = ? AND b_device = ?").get(projectId, lo, hi)) return;
      if ((db.prepare("SELECT COUNT(*) AS n FROM topo_links WHERE project_id = ?").get(projectId) as { n: number }).n >= TOPO_LINKS_MAX) return;
      db.prepare("INSERT INTO topo_links (project_id, a_device, a_port, b_device, b_port, source, last_seen_at) VALUES (?, ?, ?, ?, ?, 'scan', ?)").run(projectId, lo, lp, hi, hp, at);
      links++;
    };
    const attached = new Set<number>();
    for (const h of hosts) {
      let dev = all().find((d) => d.address === h.address);
      if (!dev) {
        if (total >= TOPO_DEVICES_MAX) continue;
        const name = (h.hostname ?? h.address).slice(0, 80);
        const info = h.mac ? `MAC ${h.mac}` : null;
        const id = Number(db.prepare("INSERT INTO topo_devices (project_id, name, address, kind, info, source, last_seen_at) VALUES (?, ?, ?, ?, ?, 'scan', ?)").run(projectId, name, h.address, guessKind(h, net.gateway), info, at).lastInsertRowid);
        dev = { id, name, address: h.address, kind: guessKind(h, net.gateway), source: "scan" };
        total++;
        devices++;
      } else db.prepare("UPDATE topo_devices SET last_seen_at = ? WHERE id = ?").run(at, dev.id);
      // vu par un switch (table MAC) : branché sur son port
      const seen = h.mac ? (db.prepare("SELECT device_id, port FROM topo_clients c JOIN topo_devices d ON d.id = c.device_id WHERE d.project_id = ? AND c.mac = ?").get(projectId, h.mac) as { device_id: number; port: string | null } | undefined) : undefined;
      if (seen && seen.device_id !== dev.id) {
        linkOnce(dev.id, null, seen.device_id, seen.port);
        db.prepare("DELETE FROM topo_clients WHERE device_id = ? AND mac = ?").run(seen.device_id, h.mac);
        attached.add(dev.id);
      }
    }
    // tout ce qui n'a aucun lien va sur le nuage ; la passerelle est reliée au nuage dans tous les cas
    if (cloud) {
      const linked = new Set<number>();
      for (const l of db.prepare("SELECT a_device, b_device FROM topo_links WHERE project_id = ?").all(projectId) as unknown as Array<{ a_device: number; b_device: number }>) { linked.add(l.a_device); linked.add(l.b_device); }
      const gw = net.gateway ? all().find((d) => d.address === net.gateway) : undefined;
      if (gw) linkOnce(cloud.id, null, gw.id, null);
      for (const h of hosts) {
        const d = all().find((x) => x.address === h.address);
        if (d && !linked.has(d.id) && d.id !== gw?.id) linkOnce(cloud.id, null, d.id, null);
      }
    }
  })();
  return { devices, links };
}

function startNetworkDiscovery(o: Record<string, unknown>, db: Db, deps: TopoDeps, env: NodeJS.ProcessEnv): { status: DiscoverStatus; finished: Promise<void> } {
  const networkId = num(o.networkId, 1, 2 ** 31);
  const credId = o.credentialId === undefined || o.credentialId === null ? null : num(o.credentialId, 1, 2 ** 31);
  const depth = o.depth === undefined ? 3 : num(o.depth, 0, TOPO_DEPTH_MAX);
  if (networkId === null || depth === null) throw new ApiError("topoInvalid", 400);
  const net = getNetwork(networkId, db); // 404 hors du projet actif
  const refusal = scanRefusal(net.cidr, env.IP_ARCHITECT_SCAN_PUBLIC === "1");
  if (refusal === "ipv6") throw new ApiError("scanIpv6", 422);
  if (refusal === "tooBig") throw new ApiError("scanTooBig", 422);
  if (refusal === "notPrivate") throw new ApiError("scanNotPrivate", 422);
  const p = getActiveProject(db);
  const rows = (credId === null
    ? db.prepare("SELECT id, community, port FROM snmp_credentials WHERE project_id = ? ORDER BY id").all(p.id)
    : db.prepare("SELECT id, community, port FROM snmp_credentials WHERE id = ? AND project_id = ?").all(credId, p.id)) as unknown as Array<{ id: number; community: string; port: number }>;
  if (credId !== null && rows.length === 0) throw new ApiError("topoCredentialNotFound", 404);
  if (G.__ipaTopoJob?.status.status === "running") throw new ApiError("topoBusy", 409);

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TOPO_MAX_MS);
  const gateway = (db.prepare("SELECT gateway FROM dhcp_scopes WHERE network_id = ? AND gateway IS NOT NULL AND gateway != '' ORDER BY enabled DESC, id LIMIT 1").get(net.id) as { gateway: string } | undefined)?.gateway ?? null;
  const targets = scanTargets(net.cidr);
  const status: DiscoverStatus = { ...IDLE, status: "running", seed: net.cidr, phase: "scan", startedAt: now(), queued: targets.length };
  const connect = deps.connect ?? ((a: string, c: string, port: number) => new SnmpClient({ host: a, community: c, port, timeoutMs: 1000, retries: 0 }));
  const notes: string[] = [];
  const finished = (async () => {
    try {
      // 1. quels hôtes répondent (même méthode que le scan réseau)
      const out = await runScan(targets, { icmp: true, ports: [...SCAN_DEFAULT_PORTS], resolve: true }, abort.signal, (pr) => { status.visited = pr.done; status.queued = targets.length - pr.done; status.devices = pr.alive; }, deps.scan ?? {});
      notes.push(...out.notes.map((n) => `scan : ${n}`));
      // 2. lesquels parlent SNMP (avec chacun des identifiants) : ils servent de point de départ à la lecture du câblage
      const seeds: Array<{ address: string; cred: (typeof rows)[number] }> = [];
      if (rows.length > 0 && !out.cancelled) {
        status.phase = "snmp";
        status.visited = 0; status.queued = out.hosts.length;
        let next = 0;
        const worker = async () => {
          while (next < out.hosts.length && !abort.signal.aborted) {
            const h = out.hosts[next++];
            for (const c of rows) {
              let sess: SnmpLike | null = null;
              try {
                sess = connect(h.address, c.community, c.port);
                const r = await sess.get(["1.3.6.1.2.1.1.1.0"]);
                if (vbText(r[0])) { seeds.push({ address: h.address, cred: c }); break; }
              } catch { /* pas de SNMP ici : normal pour la plupart des hôtes */ } finally { sess?.close(); }
            }
            status.visited++; status.queued = out.hosts.length - status.visited;
          }
        };
        await Promise.all(Array.from({ length: 16 }, worker));
        seeds.sort((a, b) => a.address.localeCompare(b.address, undefined, { numeric: true }));
        const credOf = new Map<string, (typeof rows)[number]>();
        const done = new Set<string>();
        for (const sd of seeds) {
          if (abort.signal.aborted) break;
          if (done.has(sd.address)) continue;
          const res = await crawl(sd.address, depth, {
            connect: (a) => { const c = credOf.get(a) ?? sd.cred; return connect(a, c.community, c.port); },
            refuse: (a) => (a === sd.address || !topoAddressRefused(a, env) ? null : "adresse refusée"), signal: abort.signal,
            onProgress: (pr) => { status.devices = Math.max(status.devices, pr.devices); },
          });
          for (const d of res.devices) if (d.polled && d.address) done.add(d.address);
          applyCrawl(db, p.id, res, sd.cred.id);
          notes.push(...res.notes.filter((n) => n !== "limit").slice(0, 5));
          if (res.notes.includes("limit")) notes.push("limit");
        }
      }
      // 3. les hôtes trouvés par le scan rejoignent le schéma
      status.phase = "merge";
      const merged = applyScanHosts(db, p.id, { cidr: net.cidr, name: net.name, gateway }, out.hosts);
      const t = getTopology(db);
      Object.assign(status, { devices: t.devices.length, links: t.links.length, clients: (db.prepare("SELECT COUNT(*) AS n FROM topo_clients c JOIN topo_devices d ON d.id = c.device_id WHERE d.project_id = ?").get(p.id) as { n: number }).n, notes: notes.slice(0, 50), status: out.cancelled || abort.signal.aborted ? "cancelled" : "done" });
      void merged;
    } catch (e) {
      status.status = "failed";
      status.notes = [(e as Error).message];
    } finally {
      clearTimeout(timer);
      status.phase = null;
      status.finishedAt = now();
    }
  })();
  G.__ipaTopoJob = { status, abort, finished };
  return { status, finished };
}
