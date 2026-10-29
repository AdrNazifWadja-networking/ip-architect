import { getDb, type Db } from "./index";
import { getActiveProject } from "./queries";
import { attachMeta, writeMeta } from "./meta";
import { formatIp, parseIp, ipInCidr } from "../ip/cidr";
import { isAssignable, nextFreeAddress } from "../ip/allocate";
import {
  ApiError,
  type AddressStatus,
  type CreateAddressInput,
  type CreateVlanInput,
  type IpAddressRow,
  type NetworkRow,
  type VlanRow,
} from "../types";

/* --------------------------------- VLANs --------------------------------- */

interface RawVlan {
  id: number;
  number: number;
  name: string;
  site_id: number | null;
  site_name: string | null;
  network_count: number;
  created_at: string;
}

const VLAN_SELECT = `
  SELECT v.id, v.number, v.name, v.site_id, s.name AS site_name, v.created_at,
         (SELECT COUNT(*) FROM networks n
            WHERE n.project_id = v.project_id AND n.site_id IS v.site_id AND n.vlan = v.number) AS network_count
  FROM vlans v LEFT JOIN sites s ON s.id = v.site_id`;

function mapVlan(r: RawVlan): VlanRow {
  return {
    id: r.id,
    number: r.number,
    name: r.name,
    siteId: r.site_id,
    siteName: r.site_name,
    networkCount: r.network_count,
    createdAt: r.created_at,
  };
}

export interface VlanFilters {
  q?: string;
  siteId?: number;
}

export function listVlans(filters: VlanFilters = {}, db: Db = getDb()): VlanRow[] {
  const project = getActiveProject(db);
  const where: string[] = ["v.project_id = ?"];
  const params: (string | number)[] = [project.id];

  if (filters.siteId !== undefined && Number.isInteger(filters.siteId)) {
    where.push("v.site_id = ?");
    params.push(filters.siteId);
  }
  if (filters.q?.trim()) {
    const like = `%${filters.q.trim().toLowerCase()}%`;
    where.push("(CAST(v.number AS TEXT) LIKE ? OR LOWER(v.name) LIKE ? OR LOWER(COALESCE(s.name, '')) LIKE ?)");
    params.push(like, like, like);
  }

  const rows = db
    .prepare(`${VLAN_SELECT} WHERE ${where.join(" AND ")} ORDER BY s.name, v.number`)
    .all(...params) as RawVlan[];
  return rows.map(mapVlan);
}

export function createVlan(input: CreateVlanInput, db: Db = getDb()): VlanRow {
  const project = getActiveProject(db);

  const name = (input.name ?? "").trim();
  if (!name) throw new ApiError("nameRequired", 422);
  if (name.length > 80) throw new ApiError("nameTooLong", 422);

  const number = input.number;
  if (!Number.isInteger(number) || number < 1 || number > 4094) throw new ApiError("invalidVlan", 422);

  const siteId = input.siteId ?? null;
  if (siteId !== null) {
    const exists = db.prepare("SELECT 1 FROM sites WHERE id = ? AND project_id = ?").get(siteId, project.id);
    if (!exists) throw new ApiError("siteNotFound", 422);
  }

  // `IS` compare aussi les NULL : un VLAN global (sans site) est unique parmi les VLAN globaux
  const clash = db
    .prepare("SELECT 1 FROM vlans WHERE project_id = ? AND site_id IS ? AND number = ?")
    .get(project.id, siteId, number);
  if (clash) throw new ApiError("vlanExists", 409, { number });

  const res = db
    .prepare("INSERT INTO vlans (project_id, site_id, number, name, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(project.id, siteId, number, name, new Date().toISOString());

  const row = db.prepare(`${VLAN_SELECT} WHERE v.id = ?`).get(Number(res.lastInsertRowid)) as RawVlan;
  return mapVlan(row);
}

export function deleteVlan(id: number, db: Db = getDb()): void {
  const project = getActiveProject(db);
  const row = db.prepare(`${VLAN_SELECT} WHERE v.id = ? AND v.project_id = ?`).get(id, project.id) as
    | RawVlan
    | undefined;
  if (!row) throw new ApiError("vlanNotFound", 404);
  // On refuse de supprimer un VLAN encore utilisé : les réseaux garderaient un numéro orphelin.
  if (row.network_count > 0) throw new ApiError("vlanInUse", 409, { n: row.network_count });
  db.prepare("DELETE FROM vlans WHERE id = ?").run(id);
}

/* ------------------------------ IPAM : adresses --------------------------- */

interface RawAddress {
  id: number;
  network_id: number;
  address: string;
  status: AddressStatus;
  hostname: string | null;
  description: string | null;
  created_at: string;
}

function mapAddress(r: RawAddress): IpAddressRow {
  return {
    id: r.id,
    networkId: r.network_id,
    address: r.address,
    status: r.status,
    hostname: r.hostname,
    description: r.description,
    createdAt: r.created_at,
    tags: [],
    customFields: {},
  };
}

interface RawNetworkCore {
  id: number;
  cidr: string;
  version: 4 | 6;
  name: string;
  site_id: number | null;
  site_name: string | null;
  vlan: number | null;
  vrf_id: number | null;
  vrf_name: string | null;
  status: NetworkRow["status"];
  used_ips: number;
  reserved_ips: number;
  capacity: number;
  created_at: string;
}

function getNetworkCore(networkId: number, db: Db): RawNetworkCore {
  const project = getActiveProject(db);
  const row = db
    .prepare(
      `SELECT n.id, n.cidr, n.version, n.name, n.site_id, s.name AS site_name, n.vlan, n.vrf_id, v.name AS vrf_name,
              n.status, n.used_ips, n.reserved_ips, n.capacity, n.created_at
       FROM networks n LEFT JOIN sites s ON s.id = n.site_id LEFT JOIN vrfs v ON v.id = n.vrf_id
       WHERE n.id = ? AND n.project_id = ?`,
    )
    .get(networkId, project.id) as RawNetworkCore | undefined;
  if (!row) throw new ApiError("networkNotFound", 404);
  return row;
}

export function getNetwork(networkId: number, db: Db = getDb()): NetworkRow {
  const r = getNetworkCore(networkId, db);
  return attachMeta("network", [mapNetworkCore(r)], db)[0];
}

function mapNetworkCore(r: RawNetworkCore): NetworkRow {
  return {
    id: r.id,
    cidr: r.cidr,
    version: r.version,
    name: r.name,
    siteId: r.site_id,
    siteName: r.site_name,
    vlan: r.vlan,
    vrfId: r.vrf_id,
    vrfName: r.vrf_name,
    status: r.status,
    usedIps: r.used_ips,
    reservedIps: r.reserved_ips,
    capacity: r.capacity,
    usagePct: r.capacity > 0 ? Math.min(100, (r.used_ips / r.capacity) * 100) : 0,
    createdAt: r.created_at,
    tags: [],
    customFields: {},
  };
}

/** Adresses inventoriées d'un réseau, triées par valeur numérique (le tri texte classerait 10.0.0.10 avant 10.0.0.2). */
export function listAddresses(networkId: number, db: Db = getDb()): IpAddressRow[] {
  getNetworkCore(networkId, db); // 404 si le réseau n'existe pas
  const rows = db
    .prepare(
      `SELECT id, network_id, address, status, hostname, description, created_at
       FROM ip_addresses WHERE network_id = ?`,
    )
    .all(networkId) as RawAddress[];

  const list = rows
    .map((r) => ({ row: r, value: parseIp(r.address)?.value ?? 0n }))
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    .map((x) => mapAddress(x.row));
  return attachMeta("address", list, db);
}

/** Texte libre optionnel : espaces retirés, vide -> null, trop long -> erreur. */
function cleanText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > max) throw new ApiError("textTooLong", 422, { max });
  return s;
}

export interface AllocateOptions {
  /**
   * true : au lieu d'ajouter 1 au compteur, on le relève seulement s'il est inférieur au nombre d'adresses inventoriées.
   * C'est le mode de l'import CSV : le fichier des réseaux porte déjà les compteurs, les compter deux fois les fausserait.
   */
  syncCounters?: boolean;
  /** true : ne pas exiger les champs personnalisés obligatoires (import CSV, qui ne les porte pas). */
  skipRequired?: boolean;
}

/** Relève le compteur du réseau au nombre d'adresses inventoriées de ce statut (jamais à la baisse). */
export function syncCounter(db: Db, networkId: number, status: AddressStatus): void {
  const counter = status === "used" ? "used_ips" : "reserved_ips";
  db.prepare(
    `UPDATE networks SET ${counter} = MAX(${counter},
       (SELECT COUNT(*) FROM ip_addresses WHERE network_id = ? AND status = ?)) WHERE id = ?`,
  ).run(networkId, status, networkId);
}

/**
 * Alloue (ou réserve) une adresse. Sans adresse fournie : première adresse libre du réseau.
 * Tout se passe dans une transaction : l'adresse et les compteurs du réseau changent ensemble ou pas du tout.
 */
export function allocateAddress(
  networkId: number,
  input: CreateAddressInput,
  db: Db = getDb(),
  opts: AllocateOptions = {},
): IpAddressRow {
  const net = getNetworkCore(networkId, db);

  const status = input.status ?? "used";
  if (status !== "used" && status !== "reserved") throw new ApiError("invalidAddressStatus", 422);
  const hostname = cleanText(input.hostname, 100);
  const description = cleanText(input.description, 200);

  const run = db.transaction((): IpAddressRow => {
    if (opts.syncCounters) {
      // import : les compteurs du réseau comptent déjà ces adresses ; on ne vérifie que la place dans l'inventaire
      const n = (db.prepare("SELECT COUNT(*) AS c FROM ip_addresses WHERE network_id = ?").get(networkId) as { c: number }).c;
      if (n >= net.capacity) throw new ApiError("networkFull", 409);
    } else if (net.used_ips + net.reserved_ips >= net.capacity) throw new ApiError("networkFull", 409);

    const taken = new Set(
      (db.prepare("SELECT address FROM ip_addresses WHERE network_id = ?").all(networkId) as { address: string }[]).map(
        (r) => r.address,
      ),
    );

    const raw = (input.address ?? "").trim();
    let address: string;
    if (raw) {
      const parsed = parseIp(raw);
      if (!parsed) throw new ApiError("invalidAddress", 422);
      address = formatIp(parsed.version, parsed.value);
      if (parsed.version !== net.version || !ipInCidr(address, net.cidr)) {
        throw new ApiError("addressOutsideNetwork", 422, { address, cidr: net.cidr });
      }
      if (!isAssignable(net.cidr, address)) throw new ApiError("addressNotAssignable", 422, { address });
      if (taken.has(address)) throw new ApiError("addressTaken", 409, { address });
    } else {
      const next = nextFreeAddress(net.cidr, taken);
      if (!next) throw new ApiError("networkFull", 409);
      address = next;
    }

    const res = db
      .prepare(
        `INSERT INTO ip_addresses (network_id, address, status, hostname, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(networkId, address, status, hostname, description, new Date().toISOString());

    const counter = status === "used" ? "used_ips" : "reserved_ips";
    if (opts.syncCounters) syncCounter(db, networkId, status);
    else db.prepare(`UPDATE networks SET ${counter} = ${counter} + 1 WHERE id = ?`).run(networkId);

    const newId = Number(res.lastInsertRowid);
    writeMeta("address", newId, input, db, { creating: true, skipRequired: opts.skipRequired });
    return {
      id: newId,
      networkId,
      address,
      status,
      hostname,
      description,
      createdAt: new Date().toISOString(),
      tags: [],
      customFields: {},
    };
  });

  const created = run();
  return attachMeta("address", [created], db)[0];
}

/** Libère une adresse inventoriée et décrémente le compteur correspondant (jamais en dessous de 0). */
export function releaseAddress(networkId: number, addressId: number, db: Db = getDb()): void {
  getNetworkCore(networkId, db);
  const row = db
    .prepare("SELECT status FROM ip_addresses WHERE id = ? AND network_id = ?")
    .get(addressId, networkId) as { status: AddressStatus } | undefined;
  if (!row) throw new ApiError("addressNotFound", 404);

  const run = db.transaction(() => {
    db.prepare("DELETE FROM ip_addresses WHERE id = ?").run(addressId);
    const counter = row.status === "used" ? "used_ips" : "reserved_ips";
    db.prepare(`UPDATE networks SET ${counter} = MAX(0, ${counter} - 1) WHERE id = ?`).run(networkId);
  });
  run();
}

/** Nombre d'adresses inventoriées par réseau (clé = id du réseau). Pour la liste IPAM. */
export function countInventoried(db: Db = getDb()): Map<number, number> {
  const project = getActiveProject(db);
  const rows = db
    .prepare(
      `SELECT a.network_id AS id, COUNT(*) AS c
       FROM ip_addresses a JOIN networks n ON n.id = a.network_id
       WHERE n.project_id = ? GROUP BY a.network_id`,
    )
    .all(project.id) as { id: number; c: number }[];
  return new Map(rows.map((r) => [r.id, r.c]));
}
