import { getDb, type Db } from "./index";
import { getActiveProject } from "./queries";
import { syncCounter, type AllocateOptions } from "./ipam";
import { formatIp, parseIp, ipInCidr } from "../ip/cidr";
import { isAssignable } from "../ip/allocate";
import {
  MAX_LEASE_SECONDS,
  MIN_LEASE_SECONDS,
  normalizeMac,
  renderDhcpConfig,
  type DhcpConfigFormat,
} from "../dhcp/config";
import {
  ApiError,
  type CreateDhcpReservationInput,
  type CreateDhcpScopeInput,
  type DhcpReservationRow,
  type DhcpScopeRow,
} from "../types";

/* ------------------------------- Lecture --------------------------------- */

interface RawScope {
  id: number;
  network_id: number;
  network_cidr: string;
  network_version: number;
  network_name: string;
  site_name: string | null;
  name: string;
  range_start: string;
  range_end: string;
  gateway: string | null;
  dns: string;
  lease_seconds: number;
  enabled: number;
  created_at: string;
}

const SCOPE_SELECT = `
  SELECT d.id, d.network_id, n.cidr AS network_cidr, n.version AS network_version, n.name AS network_name,
         s.name AS site_name, d.name, d.range_start, d.range_end, d.gateway, d.dns, d.lease_seconds,
         d.enabled, d.created_at
  FROM dhcp_scopes d
  JOIN networks n ON n.id = d.network_id
  LEFT JOIN sites s ON s.id = n.site_id`;

const val = (address: string): bigint => parseIp(address)?.value ?? 0n;

function splitDns(raw: string): string[] {
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function mapReservation(r: {
  id: number;
  scope_id: number;
  mac: string;
  address: string;
  hostname: string | null;
  description: string | null;
  created_at: string;
}): DhcpReservationRow {
  return {
    id: r.id,
    scopeId: r.scope_id,
    mac: r.mac,
    address: r.address,
    hostname: r.hostname,
    description: r.description,
    createdAt: r.created_at,
  };
}

/** Les statistiques d'une plage se calculent en valeur numérique (BigInt) : « .9 » est bien avant « .10 ». */
function buildScope(raw: RawScope, db: Db): DhcpScopeRow {
  const start = val(raw.range_start);
  const end = val(raw.range_end);
  const poolSize = Number(end - start) + 1;

  const reservations = db
    .prepare("SELECT address FROM dhcp_reservations WHERE scope_id = ?")
    .all(raw.id) as { address: string }[];
  const reservedSet = new Set(reservations.map((r) => r.address));
  const reservedInRange = reservations.filter((r) => val(r.address) >= start && val(r.address) <= end).length;

  const inventoried = db.prepare("SELECT address FROM ip_addresses WHERE network_id = ?").all(raw.network_id) as {
    address: string;
  }[];
  const conflictCount = inventoried.filter(
    (a) => !reservedSet.has(a.address) && val(a.address) >= start && val(a.address) <= end,
  ).length;

  return {
    id: raw.id,
    networkId: raw.network_id,
    networkCidr: raw.network_cidr,
    networkName: raw.network_name,
    siteName: raw.site_name,
    name: raw.name,
    rangeStart: raw.range_start,
    rangeEnd: raw.range_end,
    gateway: raw.gateway,
    dns: splitDns(raw.dns),
    leaseSeconds: raw.lease_seconds,
    enabled: raw.enabled === 1,
    poolSize,
    reservationCount: reservations.length,
    conflictCount,
    distributable: Math.max(0, poolSize - reservedInRange - conflictCount),
    createdAt: raw.created_at,
  };
}

function getRawScope(id: number, db: Db): RawScope {
  const project = getActiveProject(db);
  const raw = db.prepare(`${SCOPE_SELECT} WHERE d.id = ? AND n.project_id = ?`).get(id, project.id) as
    | RawScope
    | undefined;
  if (!raw) throw new ApiError("scopeNotFound", 404);
  return raw;
}

export function listScopes(filters: { q?: string } = {}, db: Db = getDb()): DhcpScopeRow[] {
  const project = getActiveProject(db);
  const where = ["n.project_id = ?"];
  const params: (string | number)[] = [project.id];
  if (filters.q?.trim()) {
    const like = `%${filters.q.trim().toLowerCase()}%`;
    where.push(
      "(LOWER(d.name) LIKE ? OR LOWER(n.cidr) LIKE ? OR LOWER(n.name) LIKE ? OR LOWER(COALESCE(s.name, '')) LIKE ?)",
    );
    params.push(like, like, like, like);
  }
  const rows = db
    .prepare(`${SCOPE_SELECT} WHERE ${where.join(" AND ")} ORDER BY s.name, d.name`)
    .all(...params) as RawScope[];
  return rows.map((r) => buildScope(r, db));
}

export function getScope(id: number, db: Db = getDb()): DhcpScopeRow {
  return buildScope(getRawScope(id, db), db);
}

/** Réservations d'une plage, triées par adresse IP (valeur numérique). */
export function listReservations(scopeId: number, db: Db = getDb()): DhcpReservationRow[] {
  getRawScope(scopeId, db); // 404 si la plage n'existe pas
  const rows = db
    .prepare(
      `SELECT id, scope_id, mac, address, hostname, description, created_at
       FROM dhcp_reservations WHERE scope_id = ?`,
    )
    .all(scopeId) as Parameters<typeof mapReservation>[0][];
  return rows
    .sort((a, b) => (val(a.address) < val(b.address) ? -1 : val(a.address) > val(b.address) ? 1 : 0))
    .map(mapReservation);
}

/* ------------------------------ Validation ------------------------------- */

function cleanText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > max) throw new ApiError("textTooLong", 422, { max });
  return s;
}

/** Adresse IPv4 attribuable du réseau, en forme canonique. */
export function ipv4InNetwork(raw: string, cidr: string, errorCode: "invalidAddress" | "invalidGateway"): string {
  const parsed = parseIp(raw.trim());
  if (!parsed || parsed.version !== 4) throw new ApiError(errorCode, 422);
  const address = formatIp(4, parsed.value);
  if (!ipInCidr(address, cidr)) throw new ApiError("addressOutsideNetwork", 422, { address, cidr });
  if (!isAssignable(cidr, address)) throw new ApiError("addressNotAssignable", 422, { address });
  return address;
}

/** Serveurs DNS : 4 maximum, doublons ignorés, forme canonique. */
export function parseDns(input: string | string[] | undefined): string[] {
  const items = Array.isArray(input) ? input : String(input ?? "").split(/[\s,;]+/);
  const out: string[] = [];
  for (const item of items.map((x) => String(x).trim()).filter(Boolean)) {
    const p = parseIp(item);
    if (!p) throw new ApiError("invalidDns", 422, { value: item });
    const canon = formatIp(p.version, p.value);
    if (!out.includes(canon)) out.push(canon);
  }
  if (out.length > 4) throw new ApiError("tooManyDns", 422);
  return out;
}

/* ------------------------------ Plages (scopes) --------------------------- */

export function createScope(input: CreateDhcpScopeInput, db: Db = getDb()): DhcpScopeRow {
  const project = getActiveProject(db);

  const name = (input.name ?? "").trim();
  if (!name) throw new ApiError("nameRequired", 422);
  if (name.length > 80) throw new ApiError("nameTooLong", 422);

  if (!Number.isInteger(input.networkId)) throw new ApiError("invalidId", 400);
  const net = db
    .prepare("SELECT id, cidr, version FROM networks WHERE id = ? AND project_id = ?")
    .get(input.networkId, project.id) as { id: number; cidr: string; version: number } | undefined;
  if (!net) throw new ApiError("networkNotFound", 404);
  if (net.version !== 4) throw new ApiError("dhcpIpv4Only", 422);

  const rangeStart = ipv4InNetwork(String(input.rangeStart ?? ""), net.cidr, "invalidAddress");
  const rangeEnd = ipv4InNetwork(String(input.rangeEnd ?? ""), net.cidr, "invalidAddress");
  if (val(rangeStart) > val(rangeEnd)) throw new ApiError("invalidRange", 422);

  const gatewayRaw = (input.gateway ?? "").toString().trim();
  const gateway = gatewayRaw ? ipv4InNetwork(gatewayRaw, net.cidr, "invalidGateway") : null;

  const dns = parseDns(input.dns);

  const lease = input.leaseSeconds ?? 86_400;
  if (!Number.isInteger(lease) || lease < MIN_LEASE_SECONDS || lease > MAX_LEASE_SECONDS) {
    throw new ApiError("invalidLease", 422);
  }

  const enabled = input.enabled === undefined ? true : !!input.enabled;

  const run = db.transaction((): number => {
    const dup = db
      .prepare(
        `SELECT 1 FROM dhcp_scopes d JOIN networks n ON n.id = d.network_id
         WHERE n.project_id = ? AND LOWER(d.name) = LOWER(?)`,
      )
      .get(project.id, name);
    if (dup) throw new ApiError("scopeNameTaken", 409, { name });

    // deux plages d'un même réseau ne doivent jamais se recouvrir : le même client recevrait deux offres
    const others = db
      .prepare("SELECT name, range_start, range_end FROM dhcp_scopes WHERE network_id = ?")
      .all(net.id) as { name: string; range_start: string; range_end: string }[];
    for (const o of others) {
      if (val(rangeStart) <= val(o.range_end) && val(o.range_start) <= val(rangeEnd)) {
        throw new ApiError("scopeOverlap", 409, { name: o.name, start: o.range_start, end: o.range_end });
      }
    }

    const res = db
      .prepare(
        `INSERT INTO dhcp_scopes (network_id, name, range_start, range_end, gateway, dns, lease_seconds, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(net.id, name, rangeStart, rangeEnd, gateway, dns.join(","), lease, enabled ? 1 : 0, new Date().toISOString());
    return Number(res.lastInsertRowid);
  });

  return getScope(run(), db);
}

/**
 * Supprime une plage. Ses réservations disparaissent avec elle et les adresses qu'elles occupaient dans l'IPAM
 * sont libérées (les compteurs du réseau restent cohérents).
 */
export function deleteScope(id: number, db: Db = getDb()): void {
  const raw = getRawScope(id, db);
  const run = db.transaction(() => {
    const reservations = db.prepare("SELECT address FROM dhcp_reservations WHERE scope_id = ?").all(id) as {
      address: string;
    }[];
    for (const r of reservations) releaseInventory(raw.network_id, r.address, db);
    db.prepare("DELETE FROM dhcp_scopes WHERE id = ?").run(id);
  });
  run();
}

/** Retire l'adresse de l'inventaire IPAM (statut « réservée ») et décrémente le compteur, si elle y est encore. */
function releaseInventory(networkId: number, address: string, db: Db): void {
  const row = db
    .prepare("SELECT id FROM ip_addresses WHERE network_id = ? AND address = ? AND status = 'reserved'")
    .get(networkId, address) as { id: number } | undefined;
  if (!row) return;
  db.prepare("DELETE FROM ip_addresses WHERE id = ?").run(row.id);
  db.prepare("UPDATE networks SET reserved_ips = MAX(0, reserved_ips - 1) WHERE id = ?").run(networkId);
}

/* ------------------------------ Réservations ------------------------------ */

/**
 * Crée une réservation MAC -> IP. L'adresse est aussi inventoriée dans l'IPAM (statut « réservée ») :
 * les deux écritures et le compteur du réseau changent ensemble, ou pas du tout.
 */
export function createReservation(
  scopeId: number,
  input: CreateDhcpReservationInput,
  db: Db = getDb(),
  opts: AllocateOptions = {},
): DhcpReservationRow {
  const scope = getRawScope(scopeId, db);

  const mac = normalizeMac(String(input.mac ?? ""));
  if (!mac) throw new ApiError("invalidMac", 422);
  const address = ipv4InNetwork(String(input.address ?? ""), scope.network_cidr, "invalidAddress");
  const hostname = cleanText(input.hostname, 100);
  const description = cleanText(input.description, 200);

  const run = db.transaction((): DhcpReservationRow => {
    const net = db
      .prepare("SELECT used_ips, reserved_ips, capacity FROM networks WHERE id = ?")
      .get(scope.network_id) as { used_ips: number; reserved_ips: number; capacity: number };
    if (opts.syncCounters) {
      const n = (db.prepare("SELECT COUNT(*) AS c FROM ip_addresses WHERE network_id = ?").get(scope.network_id) as { c: number }).c;
      if (n >= net.capacity) throw new ApiError("networkFull", 409);
    } else if (net.used_ips + net.reserved_ips >= net.capacity) throw new ApiError("networkFull", 409);

    if (db.prepare("SELECT 1 FROM dhcp_reservations WHERE scope_id = ? AND mac = ?").get(scopeId, mac)) {
      throw new ApiError("macTaken", 409, { mac });
    }
    if (db.prepare("SELECT 1 FROM ip_addresses WHERE network_id = ? AND address = ?").get(scope.network_id, address)) {
      throw new ApiError("addressTaken", 409, { address });
    }

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO ip_addresses (network_id, address, status, hostname, description, created_at)
       VALUES (?, ?, 'reserved', ?, ?, ?)`,
    ).run(scope.network_id, address, hostname, description, now);
    if (opts.syncCounters) syncCounter(db, scope.network_id, "reserved");
    else db.prepare("UPDATE networks SET reserved_ips = reserved_ips + 1 WHERE id = ?").run(scope.network_id);

    const res = db
      .prepare(
        `INSERT INTO dhcp_reservations (scope_id, mac, address, hostname, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(scopeId, mac, address, hostname, description, now);

    return { id: Number(res.lastInsertRowid), scopeId, mac, address, hostname, description, createdAt: now };
  });

  return run();
}

export function deleteReservation(scopeId: number, reservationId: number, db: Db = getDb()): void {
  const scope = getRawScope(scopeId, db);
  const row = db
    .prepare("SELECT address FROM dhcp_reservations WHERE id = ? AND scope_id = ?")
    .get(reservationId, scopeId) as { address: string } | undefined;
  if (!row) throw new ApiError("reservationNotFound", 404);

  const run = db.transaction(() => {
    db.prepare("DELETE FROM dhcp_reservations WHERE id = ?").run(reservationId);
    releaseInventory(scope.network_id, row.address, db);
  });
  run();
}

/* -------------------------------- Export ---------------------------------- */

/** Fichier de configuration prêt à coller sur un serveur (ISC dhcpd) ou un routeur (Cisco IOS). */
export function exportScopeConfig(scopeId: number, format: DhcpConfigFormat, db: Db = getDb()): string {
  const scope = getScope(scopeId, db);
  const reservations = listReservations(scopeId, db);
  return renderDhcpConfig(
    format,
    {
      name: scope.name,
      networkCidr: scope.networkCidr,
      rangeStart: scope.rangeStart,
      rangeEnd: scope.rangeEnd,
      gateway: scope.gateway,
      dns: scope.dns,
      leaseSeconds: scope.leaseSeconds,
      enabled: scope.enabled,
    },
    reservations.map((r) => ({ mac: r.mac, address: r.address, hostname: r.hostname })),
  );
}
