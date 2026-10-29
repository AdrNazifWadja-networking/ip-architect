/**
 * Import / export CSV des données du projet actif.
 *
 * Export : un fichier par type de donnée, en-têtes techniques fixes (identiques dans toutes les langues) pour qu'un export
 * puisse être réimporté tel quel, dans un autre projet par exemple.
 *
 * Import : chaque ligne passe par les MÊMES fonctions que l'interface (createNetwork, createVlan…) : mêmes contrôles, mêmes
 * messages. Tout se passe dans une seule transaction : s'il y a une erreur, ou en simulation, tout est annulé. La simulation
 * exécute vraiment l'import puis l'annule : l'aperçu est donc exactement ce qui se passerait.
 *
 * Ordre conseillé pour restaurer un projet : sites, vrfs, vlans, networks, addresses, dhcp_scopes, dhcp_reservations
 * (les lignes se rattachent par NOM de site / de VRF / de plage et par CIDR, jamais par identifiant interne).
 */
import { getDb, type Db } from "./index";
import { getActiveProject, createNetwork } from "./queries";
import { createVlan, allocateAddress } from "./ipam";
import { createVrf } from "./vrf";
import { createScope, createReservation } from "./dhcp";
import { createSite } from "./sites";
import { listFields, tagsFor, valuesFor } from "./meta";
import { normalizeCidr, parseIp, formatIp } from "../ip/cidr";
import { normalizeMac } from "../dhcp/config";
import { parseCsv, toCsv, detectDelimiter, CsvError, type Delimiter } from "../csv/csv";
import {
  ApiError,
  CSV_ENTITIES,
  type CsvEntity,
  type ImportResult,
  type NetworkStatus,
} from "../types";

export const MAX_CSV_CHARS = 2_000_000;
export const MAX_CSV_ROWS = 5000;

interface EntitySpec {
  header: readonly string[];
  required: readonly string[];
  /** Ligne d'exemple du gabarit. */
  example: readonly string[];
}

export const ENTITY_SPECS: Record<CsvEntity, EntitySpec> = {
  sites: {
    header: ["name", "address", "description"],
    required: ["name"],
    example: ["Siège Tchamba", "Quartier Centre, Tchamba, Togo", "Bureau principal"],
  },
  vrfs: {
    header: ["name", "rd", "rt_import", "rt_export", "description"],
    required: ["name"],
    example: ["CORP", "65000:100", "65000:100", "65000:100", "Réseau d'entreprise"],
  },
  vlans: {
    header: ["number", "name", "site"],
    required: ["number", "name"],
    example: ["10", "Utilisateurs", "Siège Tchamba"],
  },
  networks: {
    header: ["cidr", "name", "site", "vlan", "vrf", "status", "used_ips", "reserved_ips"],
    required: ["cidr", "name"],
    example: ["10.1.10.0/24", "LAN Utilisateurs", "Siège Tchamba", "10", "CORP", "active", "42", "5"],
  },
  addresses: {
    header: ["network", "vrf", "address", "status", "hostname", "description"],
    required: ["network", "address"],
    example: ["10.1.10.0/24", "CORP", "10.1.10.10", "used", "srv-files", "Serveur de fichiers"],
  },
  dhcp_scopes: {
    header: ["network", "vrf", "name", "range_start", "range_end", "gateway", "dns", "lease_seconds", "enabled"],
    required: ["network", "name", "range_start", "range_end"],
    example: ["10.1.10.0/24", "CORP", "Plage utilisateurs", "10.1.10.100", "10.1.10.200", "10.1.10.1", "10.1.1.53 10.1.1.54", "86400", "1"],
  },
  dhcp_reservations: {
    header: ["scope", "mac", "address", "hostname", "description"],
    required: ["scope", "mac", "address"],
    example: ["Plage utilisateurs", "aa:bb:cc:dd:ee:ff", "10.1.10.150", "imprimante-01", "Imprimante RH"],
  },
};

/** Colonnes d'un fichier : celles du type, plus (réseaux, adresses) « tags » et une colonne cf_<clé> par champ personnalisé du projet. */
export function headerFor(entity: CsvEntity, db: Db): string[] {
  const base = [...ENTITY_SPECS[entity].header];
  if (entity !== "networks" && entity !== "addresses") return base;
  return [...base, "tags", ...listFields(entity === "networks" ? "network" : "address", db).map((f) => `cf_${f.key}`)];
}

/** tags et champs d'une ligne importée (cellules vides ignorées). Étiquettes séparées par « | ». */
function metaOf(row: Row, entity: "network" | "address", db: Db): { tags?: string[]; customFields?: Record<string, string> } {
  const out: { tags?: string[]; customFields?: Record<string, string> } = {};
  const tags = row.get("tags").split("|").map((x) => x.trim()).filter(Boolean);
  if (tags.length > 0) out.tags = tags;
  const custom: Record<string, string> = {};
  for (const f of listFields(entity, db)) {
    const v = row.get(`cf_${f.key}`);
    if (v.trim() !== "") custom[f.key] = v;
  }
  if (Object.keys(custom).length > 0) out.customFields = custom;
  return out;
}

export function isCsvEntity(value: unknown): value is CsvEntity {
  return typeof value === "string" && (CSV_ENTITIES as readonly string[]).includes(value);
}

/* --------------------------------- Export --------------------------------- */

type Cell = string | number | null;

function numericIpOrder(a: string, b: string): number {
  const x = parseIp(a)?.value ?? 0n;
  const y = parseIp(b)?.value ?? 0n;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Cellules « tags » + cf_… d'un réseau ou d'une adresse, dans l'ordre de headerFor. */
function metaCells(entity: "network" | "address", id: number, db: Db): Cell[] {
  const tags = tagsFor(entity, [id], db).get(id) ?? [];
  const vals = valuesFor(entity, [id], db).get(id) ?? {};
  return [tags.map((t) => t.name).join("|"), ...listFields(entity, db).map((f) => (vals[f.key] === undefined ? "" : String(vals[f.key])))];
}

function exportRows(entity: CsvEntity, db: Db): Cell[][] {
  const project = getActiveProject(db);
  const p = project.id;
  const all = (sql: string, ...params: (string | number)[]) => db.prepare(sql).all(...params) as Record<string, any>[];
  const spaced = (csv: string | null) => (csv ?? "").split(",").filter(Boolean).join(" ");

  switch (entity) {
    case "sites":
      return all("SELECT name, address, description FROM sites WHERE project_id = ? ORDER BY LOWER(name)", p).map((r) => [
        r.name,
        r.address,
        r.description,
      ]);
    case "vrfs":
      return all("SELECT name, rd, rt_import, rt_export, description FROM vrfs WHERE project_id = ? ORDER BY LOWER(name)", p).map(
        (r) => [r.name, r.rd, spaced(r.rt_import), spaced(r.rt_export), r.description],
      );
    case "vlans":
      return all(
        `SELECT v.number, v.name, s.name AS site FROM vlans v LEFT JOIN sites s ON s.id = v.site_id
         WHERE v.project_id = ? ORDER BY LOWER(COALESCE(s.name, '')), v.number`,
        p,
      ).map((r) => [r.number, r.name, r.site]);
    case "networks":
      return all(
        `SELECT n.id, n.cidr, n.name, s.name AS site, n.vlan, v.name AS vrf, n.status, n.used_ips, n.reserved_ips
         FROM networks n LEFT JOIN sites s ON s.id = n.site_id LEFT JOIN vrfs v ON v.id = n.vrf_id
         WHERE n.project_id = ? ORDER BY n.id`,
        p,
      ).map((r) => [r.cidr, r.name, r.site, r.vlan, r.vrf, r.status, r.used_ips, r.reserved_ips, ...metaCells("network", r.id, db)]);
    case "addresses": {
      // Les adresses gérées par une réservation DHCP sont dans « dhcp_reservations » : on ne les exporte pas deux fois.
      const rows = all(
        `SELECT n.id AS nid, a.id AS aid, n.cidr, v.name AS vrf, a.address, a.status, a.hostname, a.description
         FROM ip_addresses a JOIN networks n ON n.id = a.network_id LEFT JOIN vrfs v ON v.id = n.vrf_id
         WHERE n.project_id = ?
           AND NOT EXISTS (SELECT 1 FROM dhcp_reservations r JOIN dhcp_scopes d ON d.id = r.scope_id
                           WHERE d.network_id = a.network_id AND r.address = a.address)`,
        p,
      );
      rows.sort((a, b) => a.nid - b.nid || numericIpOrder(a.address, b.address));
      return rows.map((r) => [r.cidr, r.vrf, r.address, r.status, r.hostname, r.description, ...metaCells("address", r.aid, db)]);
    }
    case "dhcp_scopes":
      return all(
        `SELECT n.cidr, v.name AS vrf, d.name, d.range_start, d.range_end, d.gateway, d.dns, d.lease_seconds, d.enabled
         FROM dhcp_scopes d JOIN networks n ON n.id = d.network_id LEFT JOIN vrfs v ON v.id = n.vrf_id
         WHERE n.project_id = ? ORDER BY d.id`,
        p,
      ).map((r) => [r.cidr, r.vrf, r.name, r.range_start, r.range_end, r.gateway, spaced(r.dns), r.lease_seconds, r.enabled ? 1 : 0]);
    case "dhcp_reservations":
      return all(
        `SELECT d.name AS scope, r.mac, r.address, r.hostname, r.description
         FROM dhcp_reservations r JOIN dhcp_scopes d ON d.id = r.scope_id JOIN networks n ON n.id = d.network_id
         WHERE n.project_id = ? ORDER BY d.id, r.id`,
        p,
      ).map((r) => [r.scope, r.mac, r.address, r.hostname, r.description]);
  }
}

/** Nom de fichier ASCII sûr : ip-architect_<projet>_<donnée>.csv */
export function csvFilename(projectName: string, entity: CsvEntity | string): string {
  const slug =
    projectName
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 40) || "projet";
  return `ip-architect_${slug}_${entity}.csv`;
}

export function exportCsv(
  entity: CsvEntity,
  opts: { delimiter?: Delimiter; template?: boolean } = {},
  db: Db = getDb(),
): { filename: string; content: string; rows: number } {
  const spec = ENTITY_SPECS[entity];
  const header = headerFor(entity, db);
  const delimiter = opts.delimiter ?? ";";
  const project = getActiveProject(db);
  const example: Cell[] = [...spec.example, ...header.slice(spec.example.length).map(() => "")];
  const rows: Cell[][] = opts.template ? [example] : exportRows(entity, db);
  return {
    filename: opts.template ? `ip-architect_modele_${entity}.csv` : csvFilename(project.name, entity),
    content: toCsv(header, rows, delimiter),
    rows: opts.template ? 0 : rows.length,
  };
}

/** Nombre de lignes exportables par type de donnée (affiché sur la page). */
export function exportCounts(db: Db = getDb()): Record<CsvEntity, number> {
  return Object.fromEntries(CSV_ENTITIES.map((e) => [e, exportRows(e, db).length])) as Record<CsvEntity, number>;
}

/* --------------------------------- Import --------------------------------- */

export interface ImportOptions {
  /** true (défaut) : rien n'est écrit, on renvoie seulement ce qui se passerait. */
  dryRun?: boolean;
  /** "skip" : une ligne qui existe déjà est ignorée (réimport possible). "error" : elle est signalée comme erreur. */
  onExisting?: "skip" | "error";
  delimiter?: Delimiter;
}

class Rollback extends Error {}

/** Ligne du fichier, accessible par nom de colonne ; "" = cellule vide. */
class Row {
  constructor(private readonly cells: Map<string, string>) {}
  get(col: string): string {
    return this.cells.get(col) ?? "";
  }
  /** Vide -> null. */
  opt(col: string): string | null {
    return this.get(col) === "" ? null : this.get(col);
  }
  int(col: string): number | null {
    const v = this.get(col);
    if (v === "") return null;
    if (!/^\d+$/.test(v)) throw new ApiError("csvBadNumber", 422, { column: col, value: v });
    return Number(v);
  }
  bool(col: string): boolean | undefined {
    const v = this.get(col).toLowerCase();
    if (v === "") return undefined;
    if (["1", "true", "yes", "oui", "vrai"].includes(v)) return true;
    if (["0", "false", "no", "non", "faux"].includes(v)) return false;
    throw new ApiError("csvBadBoolean", 422, { column: col, value: this.get(col) });
  }
}

interface Ctx {
  db: Db;
  projectId: number;
  onExisting: "skip" | "error";
}

type Outcome = "created" | "skipped";

const lc = (s: string) => s.toLowerCase();

function siteIdByName(ctx: Ctx, name: string | null): number | null {
  if (name === null) return null;
  const r = ctx.db.prepare("SELECT id FROM sites WHERE project_id = ? AND LOWER(name) = LOWER(?)").get(ctx.projectId, name) as
    | { id: number }
    | undefined;
  if (!r) throw new ApiError("csvSiteUnknown", 422, { name });
  return r.id;
}

function vrfIdByName(ctx: Ctx, name: string | null): number | null {
  if (name === null) return null;
  const r = ctx.db.prepare("SELECT id FROM vrfs WHERE project_id = ? AND LOWER(name) = LOWER(?)").get(ctx.projectId, name) as
    | { id: number }
    | undefined;
  if (!r) throw new ApiError("csvVrfUnknown", 422, { name });
  return r.id;
}

/** Réseau désigné par son CIDR (et sa VRF si elle existe) : le même CIDR peut exister dans plusieurs VRF. */
function networkByCidr(ctx: Ctx, cidrRaw: string, vrfName: string | null): { id: number; cidr: string } {
  const cidr = normalizeCidr(cidrRaw);
  if (!cidr) throw new ApiError("invalidCidr", 422);
  const vrfId = vrfIdByName(ctx, vrfName);
  const r = ctx.db
    .prepare("SELECT id, cidr FROM networks WHERE project_id = ? AND cidr = ? AND vrf_id IS ?")
    .get(ctx.projectId, cidr, vrfId) as { id: number; cidr: string } | undefined;
  if (!r) throw new ApiError("csvNetworkUnknown", 422, { cidr });
  return r;
}

function scopeByName(ctx: Ctx, name: string): { id: number } {
  const r = ctx.db
    .prepare(
      `SELECT d.id FROM dhcp_scopes d JOIN networks n ON n.id = d.network_id
       WHERE n.project_id = ? AND LOWER(d.name) = LOWER(?)`,
    )
    .get(ctx.projectId, name) as { id: number } | undefined;
  if (!r) throw new ApiError("csvScopeUnknown", 422, { name });
  return r;
}

const IMPORTERS: Record<CsvEntity, (row: Row, ctx: Ctx) => Outcome> = {
  sites(row, ctx) {
    const name = row.get("name");
    if (ctx.onExisting === "skip" && name) {
      if (ctx.db.prepare("SELECT 1 FROM sites WHERE project_id = ? AND LOWER(name) = LOWER(?)").get(ctx.projectId, name)) return "skipped";
    }
    createSite({ name, address: row.opt("address"), description: row.opt("description") }, ctx.db);
    return "created";
  },

  vrfs(row, ctx) {
    const name = row.get("name");
    if (ctx.onExisting === "skip" && name) {
      if (ctx.db.prepare("SELECT 1 FROM vrfs WHERE project_id = ? AND LOWER(name) = LOWER(?)").get(ctx.projectId, name)) return "skipped";
    }
    createVrf(
      { name, rd: row.opt("rd"), rtImport: row.get("rt_import"), rtExport: row.get("rt_export"), description: row.opt("description") },
      ctx.db,
    );
    return "created";
  },

  vlans(row, ctx) {
    const number = row.int("number");
    const siteId = siteIdByName(ctx, row.opt("site"));
    if (ctx.onExisting === "skip" && number !== null) {
      if (ctx.db.prepare("SELECT 1 FROM vlans WHERE project_id = ? AND site_id IS ? AND number = ?").get(ctx.projectId, siteId, number)) {
        return "skipped";
      }
    }
    createVlan({ number: number ?? NaN, name: row.get("name"), siteId }, ctx.db);
    return "created";
  },

  networks(row, ctx) {
    const siteId = siteIdByName(ctx, row.opt("site"));
    const vrfId = vrfIdByName(ctx, row.opt("vrf"));
    const cidr = normalizeCidr(row.get("cidr"));
    if (ctx.onExisting === "skip" && cidr) {
      if (ctx.db.prepare("SELECT 1 FROM networks WHERE project_id = ? AND cidr = ? AND vrf_id IS ?").get(ctx.projectId, cidr, vrfId)) {
        return "skipped";
      }
    }
    const status = row.get("status").toLowerCase();
    createNetwork(
      {
        cidr: row.get("cidr"),
        name: row.get("name"),
        siteId,
        vlan: row.int("vlan"),
        vrfId,
        status: (status || "active") as NetworkStatus,
        usedIps: row.int("used_ips") ?? 0,
        reservedIps: row.int("reserved_ips") ?? 0,
        ...metaOf(row, "network", ctx.db),
      },
      ctx.db,
      { skipRequired: true },
    );
    return "created";
  },

  addresses(row, ctx) {
    const net = networkByCidr(ctx, row.get("network"), row.opt("vrf"));
    const parsed = parseIp(row.get("address"));
    if (ctx.onExisting === "skip" && parsed) {
      const address = formatIp(parsed.version, parsed.value);
      if (ctx.db.prepare("SELECT 1 FROM ip_addresses WHERE network_id = ? AND address = ?").get(net.id, address)) return "skipped";
    }
    // adresse obligatoire dans l'import : une cellule vide ne doit pas « allouer la première libre »
    if (!row.get("address")) throw new ApiError("invalidAddress", 422);
    allocateAddress(
      net.id,
      {
        address: row.get("address"),
        status: (row.get("status").toLowerCase() || "used") as "used" | "reserved",
        hostname: row.opt("hostname") ?? undefined,
        description: row.opt("description") ?? undefined,
        ...metaOf(row, "address", ctx.db),
      },
      ctx.db,
      { syncCounters: true, skipRequired: true },
    );
    return "created";
  },

  dhcp_scopes(row, ctx) {
    const name = row.get("name");
    if (ctx.onExisting === "skip" && name) {
      const dup = ctx.db
        .prepare(
          `SELECT 1 FROM dhcp_scopes d JOIN networks n ON n.id = d.network_id
           WHERE n.project_id = ? AND LOWER(d.name) = LOWER(?)`,
        )
        .get(ctx.projectId, name);
      if (dup) return "skipped";
    }
    const net = networkByCidr(ctx, row.get("network"), row.opt("vrf"));
    createScope(
      {
        networkId: net.id,
        name,
        rangeStart: row.get("range_start"),
        rangeEnd: row.get("range_end"),
        gateway: row.opt("gateway"),
        dns: row.get("dns"),
        leaseSeconds: row.int("lease_seconds") ?? undefined,
        enabled: row.bool("enabled"),
      },
      ctx.db,
    );
    return "created";
  },

  dhcp_reservations(row, ctx) {
    const scope = scopeByName(ctx, row.get("scope"));
    const mac = normalizeMac(row.get("mac"));
    if (ctx.onExisting === "skip" && mac) {
      if (ctx.db.prepare("SELECT 1 FROM dhcp_reservations WHERE scope_id = ? AND mac = ?").get(scope.id, mac)) return "skipped";
    }
    createReservation(
      scope.id,
      { mac: row.get("mac"), address: row.get("address"), hostname: row.opt("hostname") ?? undefined, description: row.opt("description") ?? undefined },
      ctx.db,
      { syncCounters: true },
    );
    return "created";
  },
};

const normHeader = (h: string) => lc(h.trim()).replace(/[\s-]+/g, "_");

export function importCsv(entity: CsvEntity, text: string, opts: ImportOptions = {}, db: Db = getDb()): ImportResult {
  if (typeof text !== "string") throw new ApiError("invalidBody", 400);
  if (text.length > MAX_CSV_CHARS) throw new ApiError("csvTooLarge", 413, { max: Math.round(MAX_CSV_CHARS / 1_000_000) });
  const dryRun = opts.dryRun !== false;
  const spec = ENTITY_SPECS[entity];

  let records: string[][];
  try {
    records = parseCsv(text, opts.delimiter);
  } catch (e) {
    if (e instanceof CsvError) throw new ApiError("csvUnterminatedQuote", 422, { line: e.line });
    throw e;
  }
  if (records.length === 0) throw new ApiError("csvEmpty", 422);
  if (records.length - 1 > MAX_CSV_ROWS) throw new ApiError("csvTooManyRows", 413, { max: MAX_CSV_ROWS });

  // En-tête : colonnes reconnues par nom (ordre libre), les autres sont ignorées
  const headerNames = records[0].map(normHeader);
  for (const col of spec.required) {
    if (!headerNames.includes(col)) throw new ApiError("csvMissingColumn", 422, { column: col });
  }
  const known = headerFor(entity, db);
  const ignoredColumns = records[0].filter((_, i) => !known.includes(headerNames[i]) && headerNames[i] !== "");
  const colIndex = new Map<string, number>();
  headerNames.forEach((h, i) => {
    if (known.includes(h) && !colIndex.has(h)) colIndex.set(h, i);
  });

  const project = getActiveProject(db);
  const ctx: Ctx = { db, projectId: project.id, onExisting: opts.onExisting === "error" ? "error" : "skip" };
  const result: ImportResult = {
    entity,
    dryRun,
    committed: false,
    total: records.length - 1,
    created: 0,
    skipped: 0,
    errors: [],
    ignoredColumns,
    delimiter: opts.delimiter ?? detectDelimiter(text),
  };

  const run = db.transaction(() => {
    for (let i = 1; i < records.length; i++) {
      const rec = records[i];
      const cells = new Map<string, string>();
      for (const [col, idx] of colIndex) cells.set(col, rec[idx] ?? "");
      try {
        const outcome = IMPORTERS[entity](new Row(cells), ctx);
        if (outcome === "created") result.created++;
        else result.skipped++;
      } catch (e) {
        if (e instanceof ApiError) {
          result.errors.push({ line: i + 1, code: e.code, params: e.params });
        } else throw e;
      }
    }
    // Tout ou rien : une erreur, ou une simulation, annule toutes les écritures
    if (dryRun || result.errors.length > 0) throw new Rollback();
  });

  try {
    run();
    result.committed = true;
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return result;
}
