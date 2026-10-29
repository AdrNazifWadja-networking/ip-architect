/**
 * Modification des objets existants (réseaux, VLANs, plages DHCP, réservations, VRF, adresses IPAM).
 * Règle commune : un champ absent reste inchangé, tout est validé AVANT la première écriture,
 * et chaque modification est une transaction (aucune modification partielle).
 */
import { getDb, type Db } from "./index";
import { getActiveProject } from "./queries";
import { getNetwork, listVlans } from "./ipam";
import { attachMeta, hasMeta, writeMeta } from "./meta";
import { getScope, ipv4InNetwork, parseDns } from "./dhcp";
import { getVrf, parseRouteTargets } from "./vrf";
import { cidrOverlap } from "../ip/cidr";
import { normalizeMac, MAX_LEASE_SECONDS, MIN_LEASE_SECONDS } from "../dhcp/config";
import { VRF_NAME_PATTERN, normalizeRouteId } from "../vrf/rd";
import {
  ApiError,
  type DhcpReservationRow,
  type DhcpScopeRow,
  type IpAddressRow,
  type NetworkRow,
  type NetworkStatus,
  type UpdateAddressInput,
  type UpdateDhcpReservationInput,
  type UpdateDhcpScopeInput,
  type UpdateNetworkInput,
  type UpdateVlanInput,
  type UpdateVrfInput,
  type VlanRow,
  type VrfRow,
} from "../types";

const STATUSES: NetworkStatus[] = ["active", "inactive", "maintenance", "error"];
const val = (address: string): bigint => BigInt(address.split(".").reduce((acc, p) => acc * 256 + Number(p), 0));

/** true si la clé est présente avec une valeur (null compris) : c'est ce qui distingue « inchangé » de « effacé ». */
const has = <T extends object>(o: T, k: keyof T): boolean => o[k] !== undefined;

/** Corps = objet non vide. (Volontairement sans `asserts` : cela ferait perdre leur type aux champs de `input`.) */
function assertBody(input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length === 0) {
    throw new ApiError("invalidBody", 400);
  }
}

/** Texte libre facultatif : vide -> null, trop long -> erreur. */
function cleanText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > max) throw new ApiError("textTooLong", 422, { max });
  return s;
}

/* --------------------------------- Réseaux -------------------------------- */

export function updateNetwork(id: number, input: UpdateNetworkInput, db: Db = getDb()): NetworkRow {
  assertBody(input);
  const project = getActiveProject(db);
  const net = db
    .prepare("SELECT id, cidr, version, vrf_id, used_ips, reserved_ips, capacity FROM networks WHERE id = ? AND project_id = ?")
    .get(id, project.id) as
    | { id: number; cidr: string; version: number; vrf_id: number | null; used_ips: number; reserved_ips: number; capacity: number }
    | undefined;
  if (!net) throw new ApiError("networkNotFound", 404);

  const set: Record<string, string | number | null> = {};

  if (has(input, "name")) {
    const name = String(input.name ?? "").trim();
    if (!name) throw new ApiError("nameRequired", 422);
    if (name.length > 80) throw new ApiError("nameTooLong", 422);
    set.name = name;
  }
  if (has(input, "siteId")) {
    const siteId = input.siteId ?? null;
    if (siteId !== null) {
      if (!Number.isInteger(siteId) || !db.prepare("SELECT 1 FROM sites WHERE id = ? AND project_id = ?").get(siteId, project.id)) {
        throw new ApiError("siteNotFound", 422);
      }
    }
    set.site_id = siteId;
  }
  if (has(input, "vlan")) {
    const vlan = input.vlan ?? null;
    if (vlan !== null && (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094)) throw new ApiError("invalidVlan", 422);
    set.vlan = vlan;
  }
  if (has(input, "status")) {
    if (!STATUSES.includes(input.status as NetworkStatus)) throw new ApiError("invalidStatus", 422);
    set.status = input.status as string;
  }

  // compteurs : jamais sous le nombre d'adresses déjà inventoriées, jamais au-dessus de la capacité
  if (has(input, "usedIps") || has(input, "reservedIps")) {
    const used = has(input, "usedIps") ? (input.usedIps as number) : net.used_ips;
    const reserved = has(input, "reservedIps") ? (input.reservedIps as number) : net.reserved_ips;
    if (!Number.isInteger(used) || !Number.isInteger(reserved) || used < 0 || reserved < 0) {
      throw new ApiError("invalidCounters", 422);
    }
    if (used + reserved > net.capacity) throw new ApiError("tooManyAddresses", 422, { n: net.capacity });
    const inv = db
      .prepare(
        `SELECT COALESCE(SUM(status = 'used'), 0) AS u, COALESCE(SUM(status = 'reserved'), 0) AS r
         FROM ip_addresses WHERE network_id = ?`,
      )
      .get(id) as { u: number; r: number };
    if (used < inv.u || reserved < inv.r) throw new ApiError("countersBelowInventory", 422, { used: inv.u, reserved: inv.r });
    set.used_ips = used;
    set.reserved_ips = reserved;
  }

  let vrfId = net.vrf_id;
  if (has(input, "vrfId")) {
    vrfId = input.vrfId ?? null;
    if (vrfId !== null) {
      if (!Number.isInteger(vrfId)) throw new ApiError("invalidId", 400);
      getVrf(vrfId, db); // 404 si la VRF n'existe pas
    }
    set.vrf_id = vrfId;
  }

  if (Object.keys(set).length === 0 && !hasMeta(input)) throw new ApiError("invalidBody", 400);

  const run = db.transaction(() => {
    // le réseau change de VRF : pas de chevauchement dans la VRF de destination
    if (vrfId !== net.vrf_id) {
      const others = db
        .prepare("SELECT cidr, name FROM networks WHERE project_id = ? AND version = ? AND vrf_id IS ? AND id != ?")
        .all(project.id, net.version, vrfId, id) as { cidr: string; name: string }[];
      const clash = others.find((o) => cidrOverlap(o.cidr, net.cidr));
      if (clash) throw new ApiError("overlap", 409, { cidr: clash.cidr, name: clash.name });
    }
    const cols = Object.keys(set);
    if (cols.length > 0) {
      db.prepare(`UPDATE networks SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.map((c) => set[c]), id);
    }
    if (hasMeta(input)) writeMeta("network", id, input, db, { creating: false });
  });
  run();
  return getNetwork(id, db);
}

/* ---------------------------------- VLANs --------------------------------- */

export function updateVlan(id: number, input: UpdateVlanInput, db: Db = getDb()): VlanRow {
  assertBody(input);
  const project = getActiveProject(db);
  const current = listVlans({}, db).find((v) => v.id === id);
  if (!current) throw new ApiError("vlanNotFound", 404);

  const name = has(input, "name") ? String(input.name ?? "").trim() : current.name;
  if (!name) throw new ApiError("nameRequired", 422);
  if (name.length > 80) throw new ApiError("nameTooLong", 422);

  const number = has(input, "number") ? (input.number as number) : current.number;
  if (!Number.isInteger(number) || number < 1 || number > 4094) throw new ApiError("invalidVlan", 422);

  const siteId = has(input, "siteId") ? (input.siteId ?? null) : current.siteId;
  if (siteId !== null) {
    if (!Number.isInteger(siteId) || !db.prepare("SELECT 1 FROM sites WHERE id = ? AND project_id = ?").get(siteId, project.id)) {
      throw new ApiError("siteNotFound", 422);
    }
  }

  // les réseaux rattachés se retrouvent par (site, numéro) : on ne peut donc renommer que le VLAN qu'ils utilisent
  const identityChanged = number !== current.number || siteId !== current.siteId;
  if (identityChanged && current.networkCount > 0) throw new ApiError("vlanLocked", 409, { n: current.networkCount });

  const clash = db
    .prepare("SELECT 1 FROM vlans WHERE project_id = ? AND site_id IS ? AND number = ? AND id != ?")
    .get(project.id, siteId, number, id);
  if (clash) throw new ApiError("vlanExists", 409, { number });

  db.prepare("UPDATE vlans SET name = ?, number = ?, site_id = ? WHERE id = ?").run(name, number, siteId, id);
  return listVlans({}, db).find((v) => v.id === id)!;
}

/* ------------------------------- Plages DHCP ------------------------------ */

export function updateScope(id: number, input: UpdateDhcpScopeInput, db: Db = getDb()): DhcpScopeRow {
  assertBody(input);
  const project = getActiveProject(db);
  const cur = getScope(id, db);

  const name = has(input, "name") ? String(input.name ?? "").trim() : cur.name;
  if (!name) throw new ApiError("nameRequired", 422);
  if (name.length > 80) throw new ApiError("nameTooLong", 422);

  const rangeStart = has(input, "rangeStart") ? ipv4InNetwork(String(input.rangeStart), cur.networkCidr, "invalidAddress") : cur.rangeStart;
  const rangeEnd = has(input, "rangeEnd") ? ipv4InNetwork(String(input.rangeEnd), cur.networkCidr, "invalidAddress") : cur.rangeEnd;
  if (val(rangeStart) > val(rangeEnd)) throw new ApiError("invalidRange", 422);

  let gateway = cur.gateway;
  if (has(input, "gateway")) {
    const raw = (input.gateway ?? "").toString().trim();
    gateway = raw ? ipv4InNetwork(raw, cur.networkCidr, "invalidGateway") : null;
  }

  const dns = has(input, "dns") ? parseDns(input.dns) : cur.dns;

  const lease = has(input, "leaseSeconds") ? (input.leaseSeconds as number) : cur.leaseSeconds;
  if (!Number.isInteger(lease) || lease < MIN_LEASE_SECONDS || lease > MAX_LEASE_SECONDS) throw new ApiError("invalidLease", 422);

  const enabled = has(input, "enabled") ? !!input.enabled : cur.enabled;

  const run = db.transaction(() => {
    const dup = db
      .prepare(
        `SELECT 1 FROM dhcp_scopes d JOIN networks n ON n.id = d.network_id
         WHERE n.project_id = ? AND LOWER(d.name) = LOWER(?) AND d.id != ?`,
      )
      .get(project.id, name, id);
    if (dup) throw new ApiError("scopeNameTaken", 409, { name });

    const others = db
      .prepare("SELECT name, range_start, range_end FROM dhcp_scopes WHERE network_id = ? AND id != ?")
      .all(cur.networkId, id) as { name: string; range_start: string; range_end: string }[];
    for (const o of others) {
      if (val(rangeStart) <= val(o.range_end) && val(o.range_start) <= val(rangeEnd)) {
        throw new ApiError("scopeOverlap", 409, { name: o.name, start: o.range_start, end: o.range_end });
      }
    }
    db.prepare(
      `UPDATE dhcp_scopes SET name = ?, range_start = ?, range_end = ?, gateway = ?, dns = ?, lease_seconds = ?, enabled = ?
       WHERE id = ?`,
    ).run(name, rangeStart, rangeEnd, gateway, dns.join(","), lease, enabled ? 1 : 0, id);
  });
  run();
  return getScope(id, db);
}

/** Réservation : MAC, nom d'hôte et description. Pour changer l'adresse IP, supprimez puis recréez la réservation. */
export function updateReservation(
  scopeId: number,
  reservationId: number,
  input: UpdateDhcpReservationInput,
  db: Db = getDb(),
): DhcpReservationRow {
  assertBody(input);
  const scope = getScope(scopeId, db); // 404 si la plage n'existe pas
  const cur = db
    .prepare("SELECT id, scope_id, mac, address, hostname, description, created_at FROM dhcp_reservations WHERE id = ? AND scope_id = ?")
    .get(reservationId, scopeId) as
    | { id: number; scope_id: number; mac: string; address: string; hostname: string | null; description: string | null; created_at: string }
    | undefined;
  if (!cur) throw new ApiError("reservationNotFound", 404);

  let mac = cur.mac;
  if (has(input, "mac")) {
    const m = normalizeMac(String(input.mac ?? ""));
    if (!m) throw new ApiError("invalidMac", 422);
    mac = m;
  }
  const hostname = has(input, "hostname") ? cleanText(input.hostname, 100) : cur.hostname;
  const description = has(input, "description") ? cleanText(input.description, 200) : cur.description;

  const run = db.transaction(() => {
    if (db.prepare("SELECT 1 FROM dhcp_reservations WHERE scope_id = ? AND mac = ? AND id != ?").get(scopeId, mac, reservationId)) {
      throw new ApiError("macTaken", 409, { mac });
    }
    db.prepare("UPDATE dhcp_reservations SET mac = ?, hostname = ?, description = ? WHERE id = ?").run(mac, hostname, description, reservationId);
    // l'adresse est aussi inventoriée dans l'IPAM : on garde les deux à l'identique
    db.prepare("UPDATE ip_addresses SET hostname = ?, description = ? WHERE network_id = ? AND address = ? AND status = 'reserved'").run(
      hostname,
      description,
      scope.networkId,
      cur.address,
    );
  });
  run();
  return {
    id: cur.id,
    scopeId: cur.scope_id,
    mac,
    address: cur.address,
    hostname,
    description,
    createdAt: cur.created_at,
  };
}

/* ----------------------------------- VRF ---------------------------------- */

export function updateVrf(id: number, input: UpdateVrfInput, db: Db = getDb()): VrfRow {
  assertBody(input);
  const project = getActiveProject(db);
  const cur = getVrf(id, db);

  const name = has(input, "name") ? String(input.name ?? "").trim() : cur.name;
  if (!name) throw new ApiError("nameRequired", 422);
  if (!VRF_NAME_PATTERN.test(name)) throw new ApiError("invalidVrfName", 422);

  let rd = cur.rd;
  if (has(input, "rd")) {
    const raw = (input.rd ?? "").toString().trim();
    rd = raw ? normalizeRouteId(raw) : null;
    if (raw && !rd) throw new ApiError("invalidRd", 422);
  }
  const rtImport = has(input, "rtImport") ? parseRouteTargets(input.rtImport) : cur.rtImport;
  const rtExport = has(input, "rtExport") ? parseRouteTargets(input.rtExport) : cur.rtExport;
  // retirer le RD d'une VRF qui a des route targets les rendrait inutilisables : on l'explique plutôt que de les perdre en silence
  if (!rd && (rtImport.length > 0 || rtExport.length > 0)) throw new ApiError("rtNeedsRd", 422);

  const description = has(input, "description") ? cleanText(input.description, 200) : cur.description;

  const run = db.transaction(() => {
    if (db.prepare("SELECT 1 FROM vrfs WHERE project_id = ? AND LOWER(name) = LOWER(?) AND id != ?").get(project.id, name, id)) {
      throw new ApiError("vrfNameTaken", 409, { name });
    }
    if (rd && db.prepare("SELECT 1 FROM vrfs WHERE project_id = ? AND rd = ? AND id != ?").get(project.id, rd, id)) {
      throw new ApiError("rdTaken", 409, { rd });
    }
    db.prepare("UPDATE vrfs SET name = ?, rd = ?, rt_import = ?, rt_export = ?, description = ? WHERE id = ?").run(
      name,
      rd,
      rtImport.join(","),
      rtExport.join(","),
      description,
      id,
    );
  });
  run();
  return getVrf(id, db);
}

/* ------------------------------ Adresses IPAM ----------------------------- */

/**
 * Adresse inventoriée : nom d'hôte, description et type (utilisée / réservée). L'adresse elle-même ne change pas.
 * Le changement de type déplace une unité d'un compteur du réseau à l'autre. Une adresse créée par une réservation
 * DHCP reste « réservée » (sinon la réservation et l'inventaire ne correspondraient plus).
 */
export function updateAddress(networkId: number, addressId: number, input: UpdateAddressInput, db: Db = getDb()): IpAddressRow {
  assertBody(input);
  getNetwork(networkId, db); // 404 si le réseau n'existe pas
  const cur = db
    .prepare("SELECT id, network_id, address, status, hostname, description, created_at FROM ip_addresses WHERE id = ? AND network_id = ?")
    .get(addressId, networkId) as
    | { id: number; network_id: number; address: string; status: "used" | "reserved"; hostname: string | null; description: string | null; created_at: string }
    | undefined;
  if (!cur) throw new ApiError("addressNotFound", 404);

  const status = has(input, "status") ? input.status : cur.status;
  if (status !== "used" && status !== "reserved") throw new ApiError("invalidAddressStatus", 422);
  const hostname = has(input, "hostname") ? cleanText(input.hostname, 100) : cur.hostname;
  const description = has(input, "description") ? cleanText(input.description, 200) : cur.description;

  const run = db.transaction(() => {
    const managed = db
      .prepare(
        `SELECT r.id FROM dhcp_reservations r JOIN dhcp_scopes s ON s.id = r.scope_id
         WHERE s.network_id = ? AND r.address = ?`,
      )
      .get(networkId, cur.address) as { id: number } | undefined;

    if (status !== cur.status) {
      if (managed) throw new ApiError("addressManagedByDhcp", 409, { address: cur.address });
      const from = cur.status === "used" ? "used_ips" : "reserved_ips";
      const to = status === "used" ? "used_ips" : "reserved_ips";
      db.prepare(`UPDATE networks SET ${from} = MAX(0, ${from} - 1), ${to} = ${to} + 1 WHERE id = ?`).run(networkId);
    }
    db.prepare("UPDATE ip_addresses SET status = ?, hostname = ?, description = ? WHERE id = ?").run(status, hostname, description, addressId);
    if (managed) {
      db.prepare("UPDATE dhcp_reservations SET hostname = ?, description = ? WHERE id = ?").run(hostname, description, managed.id);
    }
    if (hasMeta(input)) writeMeta("address", addressId, input, db, { creating: false });
  });
  run();
  const meta = attachMeta("address", [{ id: addressId, tags: [], customFields: {} }], db)[0];

  return {
    id: cur.id,
    networkId,
    address: cur.address,
    status,
    hostname,
    description,
    createdAt: cur.created_at,
    tags: meta.tags,
    customFields: meta.customFields,
  };
}
