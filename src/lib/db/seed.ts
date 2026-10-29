import type { Db } from "./index";
import { markDemoProject } from "./demoMark";
import { calcSubnet } from "../ip/cidr";
import { addressAt } from "../ip/allocate";

/** Générateur pseudo-aléatoire déterministe (mêmes données de démo à chaque installation). */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SITES = [
  { name: "Site Principal - Tchamba", octet: 1, pct: 75.3 },
  { name: "Datacenter - Lomé", octet: 2, pct: 62.8 },
  { name: "Succursale - Sokodé", octet: 3, pct: 45.6 },
  { name: "Datacenter - Kara", octet: 4, pct: 33.2 },
  { name: "Agence - Atakpamé", octet: 5, pct: 28.7 },
];

const VLANS = [
  { number: 10, name: "LAN Utilisateurs" },
  { number: 20, name: "Serveurs" },
  { number: 30, name: "DMZ" },
  { number: 40, name: "Management" },
  { number: 50, name: "Wi-Fi" },
  { number: 60, name: "VoIP" },
];

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString();

export function seedDatabase(db: Db): void {
  const rand = mulberry32(20261016);
  const now = Date.now();

  const tx = db.transaction(() => {
    const projectId = Number(
      db.prepare("INSERT INTO projects (name) VALUES (?)").run("Entreprise Globale").lastInsertRowid,
    );
    markDemoProject(db, projectId); // repère du projet de démonstration (voir « Quitter la démo », lib/db/demo.ts)

    const insSite = db.prepare("INSERT INTO sites (project_id, name) VALUES (?, ?)");
    const insVlan = db.prepare(
      "INSERT INTO vlans (project_id, site_id, number, name, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    const insNet = db.prepare(
      `INSERT INTO networks (project_id, site_id, cidr, version, name, vlan, status, used_ips, reserved_ips, capacity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    SITES.forEach((site, si) => {
      const siteId = Number(insSite.run(projectId, site.name).lastInsertRowid);

      VLANS.forEach((v, vi) => {
        const created = iso(new Date(now - Math.floor(rand() * 60) * DAY));
        insVlan.run(projectId, siteId, v.number, `${v.name} - ${site.name.split(" - ")[1]}`, created);

        // --- réseau IPv4 (/24) ---
        const cidr4 = `10.${site.octet}.${v.number}.0/24`;
        const info4 = calcSubnet(cidr4)!;
        const capacity4 = Number(info4.usable);
        const jitter = 0.85 + rand() * 0.3;
        const used4 = Math.min(capacity4, Math.round((capacity4 * site.pct * jitter) / 100));
        const reserved4 = Math.round(capacity4 * 0.04);

        let status = "active";
        if (si === 2 && vi === 4) status = "maintenance";
        if (si === 3 && vi === 3) status = "inactive";
        if (si === 2 && vi === 2) status = "error";
        if (si === 4 && vi === 5) status = "inactive";

        insNet.run(
          projectId, siteId, cidr4, 4, v.name, v.number, status,
          used4, reserved4, capacity4,
          iso(new Date(now - Math.floor(rand() * 60) * DAY)),
        );

        // --- réseau IPv6 (/64) pour les deux premiers VLAN de chaque site ---
        if (vi < 2) {
          const cidr6 = `2001:db8:${site.octet}:${v.number}::/64`;
          const info6 = calcSubnet(cidr6)!;
          const capacity6 = Number(
            info6.usable > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : info6.usable,
          );
          const idle = (si === 1 && vi === 1) || (si === 4 && vi === 0); // préfixes alloués mais pas encore déployés
          insNet.run(
            projectId, siteId, cidr6, 6, `${v.name} (IPv6)`, v.number, idle ? "inactive" : "active",
            idle ? 0 : 40 + Math.floor(rand() * 460), 0, capacity6,
            iso(new Date(now - Math.floor(rand() * 60) * DAY)),
          );
        }
      });
    });

    seedAlerts(db, projectId, now);
    seedDemoAddresses(db, projectId, now);
    seedDemoDhcp(db, projectId, now);
    seedDemoVrfs(db, projectId, now);

    // --- historique d'utilisation sur 31 jours (tendance haussière réaliste) ---
    const live = db
      .prepare(
        `SELECT
           (SELECT SUM(used_ips) * 100.0 / SUM(capacity) FROM networks WHERE project_id = @p AND version = 4) AS v4,
           (SELECT SUM(CASE WHEN status = 'active' AND used_ips > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*)
              FROM networks WHERE project_id = @p AND version = 6) AS v6,
           (SELECT SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) * 100.0 / COUNT(*)
              FROM networks WHERE project_id = @p) AS act`,
      )
      .get({ p: projectId }) as { v4: number; v6: number; act: number };
    const insHist = db.prepare(
      "INSERT OR REPLACE INTO usage_history (project_id, day, ipv4, ipv6, active) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 30; i >= 0; i--) {
      const k = i / 30; // 1 = il y a 30 jours, 0 = aujourd'hui
      const noise = () => (rand() - 0.5) * 3;
      const clamp = (n: number) => Math.min(100, Math.max(0, n));
      const ipv4 = clamp(live.v4 - k * 14 + noise());
      const ipv6 = clamp(live.v6 - k * 22 + noise());
      const active = clamp(live.act - k * 8 + noise());
      insHist.run(projectId, new Date(now - i * DAY).toISOString().slice(0, 10), ipv4, ipv6, active);
    }
  });

  tx();
}

/** Alertes de démonstration (structurées : le texte est produit à l'affichage, dans la langue de l'utilisateur). */
export function seedAlerts(db: Db, projectId: number, now: number = Date.now()): void {
  const insAlert = db.prepare(
    `INSERT INTO alerts (project_id, kind, severity, subject, subject_type, resolved, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const ago = (min: number) => iso(new Date(now - min * 60_000));
  insAlert.run(projectId, "overlap", "critical", "10.1.10.0/24", "network", 0, ago(5));
  insAlert.run(projectId, "dhcp", "warning", "VLAN_20_DHCP", "pool", 0, ago(15));
  insAlert.run(projectId, "usage", "warning", "10.1.20.0/24 (90%)", "network", 0, ago(30));
  insAlert.run(projectId, "prefix", "critical", "2001:db8::/33", "network", 0, ago(60));
  insAlert.run(projectId, "backup", "info", "Entreprise Globale", "project", 1, ago(120));
  insAlert.run(projectId, "usage", "warning", "10.2.10.0/24 (82%)", "network", 0, ago(40 * 24 * 60));
  insAlert.run(projectId, "dhcp", "warning", "VLAN_10_DHCP", "pool", 0, ago(41 * 24 * 60));
}

/** Préfixe de nom d'hôte par rôle de VLAN (données de démonstration, volontairement sans langue). */
const HOST_PREFIX: Record<number, string> = { 10: "pc", 20: "srv", 30: "dmz", 40: "mgmt", 50: "ap", 60: "voip" };

/**
 * Adresses de démonstration pour l'IPAM : une passerelle réservée + quelques hôtes par réseau de démo.
 * Ne touche QUE les réseaux de démonstration (10.x.VLAN.0/24 et 2001:db8:x:VLAN::/64 des sites de démo)
 * et respecte l'invariant « compteurs ≥ adresses inventoriées » : sinon le réseau est ignoré.
 */
export function seedDemoAddresses(db: Db, projectId: number, now: number = Date.now()): void {
  const networks = db
    .prepare(
      `SELECT n.id, n.cidr, n.version, n.vlan, n.used_ips, n.reserved_ips, s.name AS site_name
       FROM networks n JOIN sites s ON s.id = n.site_id
       WHERE n.project_id = ?`,
    )
    .all(projectId) as {
    id: number;
    cidr: string;
    version: 4 | 6;
    vlan: number | null;
    used_ips: number;
    reserved_ips: number;
    site_name: string;
  }[];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO ip_addresses (network_id, address, status, hostname, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  for (const n of networks) {
    const site = SITES.find((s) => s.name === n.site_name);
    const isDemoCidr =
      site !== undefined &&
      n.vlan !== null &&
      HOST_PREFIX[n.vlan] !== undefined &&
      n.cidr === (n.version === 4 ? `10.${site.octet}.${n.vlan}.0/24` : `2001:db8:${site.octet}:${n.vlan}::/64`);
    if (!isDemoCidr || !site || n.vlan === null) continue;

    const rand = mulberry32(900 + n.id);
    const code = n.site_name.split(" - ")[1].slice(0, 3).toLowerCase();
    const prefix = HOST_PREFIX[n.vlan];
    const created = iso(new Date(now - Math.floor(rand() * 30) * DAY));

    const hosts: { offset: number; status: "used" | "reserved"; hostname: string; description: string | null }[] = [];
    if (n.version === 4) hosts.push({ offset: 1, status: "reserved", hostname: `gw-${code}-v${n.vlan}`, description: "Gateway" });
    const hostCount = 6 + Math.floor(rand() * 4);
    let offset = 10;
    for (let i = 1; i <= hostCount; i++) {
      hosts.push({ offset, status: "used", hostname: `${prefix}-${code}-${String(i).padStart(2, "0")}`, description: null });
      offset += 1 + Math.floor(rand() * 6);
    }

    // l'invariant doit tenir : on n'inventorie jamais plus que ce que les compteurs annoncent
    const usedCount = hosts.filter((h) => h.status === "used").length;
    const reservedCount = hosts.length - usedCount;
    if (n.used_ips < usedCount || n.reserved_ips < reservedCount) continue;

    for (const h of hosts) {
      const address = addressAt(n.cidr, h.offset);
      if (address) insert.run(n.id, address, h.status, h.hostname, h.description, created);
    }
  }
}

/**
 * Plages DHCP de démonstration : VLAN 10 (utilisateurs), 50 (Wi-Fi) et 60 (voix) de chaque site de démo,
 * plus deux réservations (imprimante, borne) hors de la plage dynamique.
 * Ne touche QUE les réseaux de démonstration et respecte l'invariant « compteurs ≥ adresses inventoriées ».
 */
export function seedDemoDhcp(db: Db, projectId: number, now: number = Date.now()): void {
  const networks = db
    .prepare(
      `SELECT n.id, n.cidr, n.version, n.vlan, n.reserved_ips, s.name AS site_name
       FROM networks n JOIN sites s ON s.id = n.site_id
       WHERE n.project_id = ? AND n.version = 4`,
    )
    .all(projectId) as { id: number; cidr: string; version: 4; vlan: number | null; reserved_ips: number; site_name: string }[];

  const insScope = db.prepare(
    `INSERT INTO dhcp_scopes (network_id, name, range_start, range_end, gateway, dns, lease_seconds, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  );
  const insRes = db.prepare(
    `INSERT INTO dhcp_reservations (scope_id, mac, address, hostname, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insAddr = db.prepare(
    `INSERT OR IGNORE INTO ip_addresses (network_id, address, status, hostname, description, created_at)
     VALUES (?, ?, 'reserved', ?, ?, ?)`,
  );
  const countReserved = db.prepare("SELECT COUNT(*) AS c FROM ip_addresses WHERE network_id = ? AND status = 'reserved'");

  const LEASE: Record<number, number> = { 10: 28_800, 50: 14_400, 60: 86_400 };
  const created = iso(new Date(now - 20 * DAY));

  for (const n of networks) {
    const site = SITES.find((s) => s.name === n.site_name);
    if (!site || n.vlan === null || LEASE[n.vlan] === undefined) continue;
    if (n.cidr !== `10.${site.octet}.${n.vlan}.0/24`) continue;

    const base = `10.${site.octet}.${n.vlan}`;
    const code = n.site_name.split(" - ")[1].slice(0, 3).toLowerCase();
    const scopeId = Number(
      insScope.run(
        n.id,
        `VLAN_${n.vlan}_DHCP_${code.toUpperCase()}`,
        `${base}.100`,
        `${base}.220`,
        `${base}.1`,
        `10.${site.octet}.40.10,10.${site.octet}.40.11`,
        LEASE[n.vlan],
        created,
      ).lastInsertRowid,
    );

    // les réservations sont aussi inventoriées (statut « réservée ») : possible seulement si le compteur le permet
    const rows = (countReserved.get(n.id) as { c: number }).c;
    if (n.reserved_ips < rows + 2) continue;
    const mac = (i: number) => `00:1a:2b:${site.octet.toString(16).padStart(2, "0")}:${n.vlan!.toString(16).padStart(2, "0")}:${i.toString(16).padStart(2, "0")}`;
    const hosts = [
      { offset: 240, hostname: `print-${code}-v${n.vlan}`, description: "Printer" },
      { offset: 241, hostname: `ap-${code}-v${n.vlan}`, description: "Access point" },
    ];
    hosts.forEach((h, i) => {
      const address = `${base}.${h.offset}`;
      insRes.run(scopeId, mac(i + 1), address, h.hostname, h.description, created);
      insAddr.run(n.id, address, h.hostname, h.description, created);
    });
  }
}

/**
 * VRF de démonstration : CORP (VLAN 10 et 20), DMZ (30), MGMT (40) et GUEST (50). Le VLAN 60 reste dans la table globale.
 * Seuls les réseaux de démonstration (IPv4 et IPv6) sans VRF sont rattachés : vos propres réseaux ne sont jamais modifiés.
 */
export function seedDemoVrfs(db: Db, projectId: number, now: number = Date.now()): void {
  const VRFS = [
    { name: "CORP", rd: "65000:10", imp: "65000:10,65000:40", exp: "65000:10", desc: "Users and servers", vlans: [10, 20] },
    { name: "DMZ", rd: "65000:30", imp: "65000:30", exp: "65000:30", desc: "Internet-facing services", vlans: [30] },
    { name: "MGMT", rd: "65000:40", imp: "65000:10,65000:20,65000:30,65000:40", exp: "65000:40", desc: "Network management", vlans: [40] },
    { name: "GUEST", rd: "65000:50", imp: "65000:50", exp: "65000:50", desc: "Guest Wi-Fi, isolated from the rest", vlans: [50] },
  ];
  const created = iso(new Date(now - 25 * DAY));
  const insVrf = db.prepare(
    `INSERT INTO vrfs (project_id, name, rd, rt_import, rt_export, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const assign = db.prepare("UPDATE networks SET vrf_id = ? WHERE id = ? AND project_id = ? AND vrf_id IS NULL");

  const networks = db
    .prepare(
      `SELECT n.id, n.cidr, n.version, n.vlan, s.name AS site_name
       FROM networks n JOIN sites s ON s.id = n.site_id WHERE n.project_id = ?`,
    )
    .all(projectId) as { id: number; cidr: string; version: 4 | 6; vlan: number | null; site_name: string }[];

  for (const v of VRFS) {
    if (db.prepare("SELECT 1 FROM vrfs WHERE project_id = ? AND LOWER(name) = LOWER(?)").get(projectId, v.name)) continue;
    const vrfId = Number(insVrf.run(projectId, v.name, v.rd, v.imp, v.exp, v.desc, created).lastInsertRowid);
    for (const n of networks) {
      const site = SITES.find((x) => x.name === n.site_name);
      if (!site || n.vlan === null || !v.vlans.includes(n.vlan)) continue;
      const demoCidr = n.version === 4 ? `10.${site.octet}.${n.vlan}.0/24` : `2001:db8:${site.octet}:${n.vlan}::/64`;
      if (n.cidr === demoCidr) assign.run(vrfId, n.id, projectId);
    }
  }
}
