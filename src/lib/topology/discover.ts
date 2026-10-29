/**
 * Découverte de topologie par SNMP : on interroge un équipement de départ, on lit ses voisins (LLDP, CDP) puis on interroge
 * à leur tour ceux qui ont une adresse de gestion (parcours en largeur). Les tables d'adresses MAC (FDB) donnent les machines
 * branchées sur chaque port d'accès. Module pur : l'accès réseau passe par `deps.connect` (faux équipements dans les tests).
 */
import { macOf, oidSuffix, vbIp, vbNumber, vbText, type VarBind } from "../snmp/codec";
import type { SnmpLike } from "../snmp/client";
import { TOPO_CLIENTS_PER_DEVICE, TOPO_DEPTH_MAX, TOPO_DEVICES_MAX, TOPO_PORTS_MAX, type TopoKind, type TopoPort } from "../topologyTypes";

const O = {
  sysDescr: "1.3.6.1.2.1.1.1.0", sysObjectId: "1.3.6.1.2.1.1.2.0", sysName: "1.3.6.1.2.1.1.5.0", sysServices: "1.3.6.1.2.1.1.7.0",
  ifDescr: "1.3.6.1.2.1.2.2.1.2", ifType: "1.3.6.1.2.1.2.2.1.3", ifOper: "1.3.6.1.2.1.2.2.1.8",
  ifName: "1.3.6.1.2.1.31.1.1.1.1", ifHighSpeed: "1.3.6.1.2.1.31.1.1.1.15",
  lldpLocChassisSub: "1.0.8802.1.1.2.1.3.1.0", lldpLocChassis: "1.0.8802.1.1.2.1.3.2.0", lldpLocSysName: "1.0.8802.1.1.2.1.3.3.0",
  lldpLocPortId: "1.0.8802.1.1.2.1.3.7.1.3", lldpLocPortDesc: "1.0.8802.1.1.2.1.3.7.1.4",
  lldpRemChassisSub: "1.0.8802.1.1.2.1.4.1.1.4", lldpRemChassis: "1.0.8802.1.1.2.1.4.1.1.5", lldpRemPortId: "1.0.8802.1.1.2.1.4.1.1.7",
  lldpRemPortDesc: "1.0.8802.1.1.2.1.4.1.1.8", lldpRemSysName: "1.0.8802.1.1.2.1.4.1.1.9", lldpRemSysDesc: "1.0.8802.1.1.2.1.4.1.1.10",
  lldpRemCaps: "1.0.8802.1.1.2.1.4.1.1.12", lldpRemManAddr: "1.0.8802.1.1.2.1.4.2.1.3",
  cdpAddress: "1.3.6.1.4.1.9.9.23.1.2.1.1.4", cdpDeviceId: "1.3.6.1.4.1.9.9.23.1.2.1.1.6", cdpPortId: "1.3.6.1.4.1.9.9.23.1.2.1.1.7", cdpPlatform: "1.3.6.1.4.1.9.9.23.1.2.1.1.8",
  fdbQ: "1.3.6.1.2.1.17.7.1.2.2.1.2", fdbOld: "1.3.6.1.2.1.17.4.3.1.2", basePortIf: "1.3.6.1.2.1.17.1.4.1.2",
  arp: "1.3.6.1.2.1.4.22.1.2",
} as const;

export interface Neighbor {
  via: "lldp" | "cdp";
  localPort: string;
  chassisId: string | null;
  remotePort: string | null;
  name: string | null;
  address: string | null;
  info: string | null;
  kind: TopoKind | null;
}

export interface ClientSeen {
  port: string;
  mac: string;
  vlan: number | null;
}

export interface DeviceRead {
  name: string | null;
  info: string | null;
  chassisId: string | null;
  kind: TopoKind;
  ports: TopoPort[];
  neighbors: Neighbor[];
  clients: ClientSeen[];
  /** mac -> adresse IP lue dans la table ARP de l'équipement. */
  arp: Map<string, string>;
  /** port local -> débit (Mbit/s) : sert aux liens. */
  speeds: Map<string, number>;
  notes: string[];
}

const idxByLast = (vs: VarBind[], prefix: string): Map<number, VarBind> => {
  const m = new Map<number, VarBind>();
  for (const v of vs) {
    const s = oidSuffix(v.oid, prefix);
    if (s && s.length === 1) m.set(s[0], v);
  }
  return m;
};

/** Identifiant de châssis : 6 octets = adresse MAC, sinon du texte. */
export function chassisText(v: VarBind | undefined): string | null {
  if (!v || v.type !== "str") return null;
  return macOf(v.value) ?? vbText(v);
}

/** Bits de capacité LLDP (premier octet : autre, répéteur, pont, borne Wi-Fi, routeur, téléphone, DOCSIS, station). */
export function kindFromCaps(b: Buffer | null, descr: string | null): TopoKind | null {
  if (descr && /firewall|pfsense|opnsense|fortigate|\bASA\b|palo alto|sophos|\bUSG\b|UDM|dream machine/i.test(descr)) return "firewall";
  if (!b || b.length === 0) return null;
  const c = b[0];
  if (c & 0x10) return "ap";
  if (c & 0x20) return "switch";
  if (c & 0x08) return "router";
  if (c & 0x04) return "phone";
  if (c & 0x01) return "host";
  return null;
}

function kindFromServices(services: number | null, descr: string | null): TopoKind {
  if (descr && /firewall|pfsense|opnsense|fortigate|\bASA\b|palo alto|sophos|\bUSG\b/i.test(descr)) return "firewall";
  if (descr && /access point|\bUAP\b|\bU6\b|\bAP\d|wireless/i.test(descr)) return "ap";
  if (services === null) return "other";
  if (services & 2) return "switch";
  if (services & 4) return "router";
  return "other";
}

async function safeWalk(s: SnmpLike, prefix: string, notes: string[]): Promise<VarBind[]> {
  try {
    return await s.walk(prefix);
  } catch (e) {
    notes.push(`${prefix} : ${(e as Error).message}`);
    return [];
  }
}

/** Lit un équipement : identité, ports, voisins LLDP/CDP, machines vues sur les ports (FDB) et table ARP. */
export async function readDevice(s: SnmpLike): Promise<DeviceRead> {
  const notes: string[] = [];
  const g = await s.get([O.sysDescr, O.sysName, O.sysServices, O.lldpLocChassis, O.lldpLocSysName]);
  const info = vbText(g[0]);
  const sysName = vbText(g[1]) ?? vbText(g[4]);

  /* ports */
  const [names, descrs, types, opers, speeds] = await Promise.all([
    safeWalk(s, O.ifName, notes), safeWalk(s, O.ifDescr, notes), safeWalk(s, O.ifType, notes), safeWalk(s, O.ifOper, notes), safeWalk(s, O.ifHighSpeed, notes),
  ]);
  const ifName = idxByLast(names, O.ifName), ifDescr = idxByLast(descrs, O.ifDescr), ifType = idxByLast(types, O.ifType);
  const ifOper = idxByLast(opers, O.ifOper), ifSpeed = idxByLast(speeds, O.ifHighSpeed);
  const portName = (idx: number): string => vbText(ifName.get(idx)) ?? vbText(ifDescr.get(idx)) ?? `if${idx}`;
  const ports: TopoPort[] = [];
  const speedByName = new Map<string, number>();
  for (const idx of [...new Set([...ifName.keys(), ...ifDescr.keys()])].sort((a, b) => a - b)) {
    const t = vbNumber(ifType.get(idx));
    if (t !== null && t !== 6 && t !== 71) continue; // Ethernet et Wi-Fi seulement
    if (ports.length >= TOPO_PORTS_MAX) { notes.push("ports : liste tronquée"); break; }
    const sp = vbNumber(ifSpeed.get(idx));
    const op = vbNumber(ifOper.get(idx));
    const name = portName(idx);
    ports.push({ name, speedMbps: sp && sp > 0 ? sp : null, up: op === null ? null : op === 1 });
    if (sp && sp > 0) speedByName.set(name, sp);
  }

  /* voisins LLDP */
  const neighbors: Neighbor[] = [];
  const [locId, locDesc, remChassis, remPortId, remPortDesc, remName, remDesc, remCaps, remAddr, remSub] = await Promise.all([
    safeWalk(s, O.lldpLocPortId, notes), safeWalk(s, O.lldpLocPortDesc, notes), safeWalk(s, O.lldpRemChassis, notes), safeWalk(s, O.lldpRemPortId, notes),
    safeWalk(s, O.lldpRemPortDesc, notes), safeWalk(s, O.lldpRemSysName, notes), safeWalk(s, O.lldpRemSysDesc, notes), safeWalk(s, O.lldpRemCaps, notes),
    safeWalk(s, O.lldpRemManAddr, notes), safeWalk(s, O.lldpRemChassisSub, notes),
  ]);
  void remSub;
  const locPortName = (n: number): string => vbText(locDesc.find((v) => oidSuffix(v.oid, O.lldpLocPortDesc)?.[0] === n)) ?? vbText(locId.find((v) => oidSuffix(v.oid, O.lldpLocPortId)?.[0] === n)) ?? portName(n);
  const byKey = (vs: VarBind[], prefix: string): Map<string, VarBind> => {
    const m = new Map<string, VarBind>();
    for (const v of vs) {
      const sfx = oidSuffix(v.oid, prefix);
      if (sfx && sfx.length === 3) m.set(sfx.join("."), v);
    }
    return m;
  };
  const cc = byKey(remChassis, O.lldpRemChassis), pi = byKey(remPortId, O.lldpRemPortId), pd = byKey(remPortDesc, O.lldpRemPortDesc);
  const nm = byKey(remName, O.lldpRemSysName), ds = byKey(remDesc, O.lldpRemSysDesc), cp = byKey(remCaps, O.lldpRemCaps);
  const addrOf = new Map<string, string>();
  for (const v of remAddr) {
    const sfx = oidSuffix(v.oid, O.lldpRemManAddr);
    // index : temps.portLocal.indexDistant.sous-type.longueur.octets…  (sous-type 1 = IPv4)
    if (sfx && sfx.length >= 9 && sfx[3] === 1 && sfx[4] === 4) addrOf.set(sfx.slice(0, 3).join("."), sfx.slice(5, 9).join("."));
  }
  for (const [key, c] of cc) {
    const lp = Number(key.split(".")[1]);
    const descr = vbText(ds.get(key));
    neighbors.push({
      via: "lldp", localPort: locPortName(lp), chassisId: chassisText(c),
      remotePort: vbText(pd.get(key)) ?? chassisText(pi.get(key)), name: vbText(nm.get(key)), address: addrOf.get(key) ?? null,
      info: descr, kind: kindFromCaps(cp.get(key)?.value ?? null, descr),
    });
  }

  /* voisins CDP (Cisco) : on n'ajoute que ceux que LLDP n'a pas déjà donnés sur ce port */
  const [cdpA, cdpD, cdpP, cdpT] = await Promise.all([safeWalk(s, O.cdpAddress, notes), safeWalk(s, O.cdpDeviceId, notes), safeWalk(s, O.cdpPortId, notes), safeWalk(s, O.cdpPlatform, notes)]);
  const cdpKey = (vs: VarBind[], prefix: string): Map<string, VarBind> => {
    const m = new Map<string, VarBind>();
    for (const v of vs) {
      const sfx = oidSuffix(v.oid, prefix);
      if (sfx && sfx.length === 2) m.set(sfx.join("."), v);
    }
    return m;
  };
  const ca = cdpKey(cdpA, O.cdpAddress), cd = cdpKey(cdpD, O.cdpDeviceId), cpo = cdpKey(cdpP, O.cdpPortId), ct = cdpKey(cdpT, O.cdpPlatform);
  for (const [key, d] of cd) {
    const lp = portName(Number(key.split(".")[0]));
    if (neighbors.some((n) => n.localPort === lp && n.via === "lldp")) continue;
    const platform = vbText(ct.get(key));
    neighbors.push({ via: "cdp", localPort: lp, chassisId: null, remotePort: vbText(cpo.get(key)), name: vbText(d), address: vbIp(ca.get(key)), info: platform, kind: kindFromCaps(null, platform) });
  }

  /* machines vues sur les ports : FDB (802.1Q puis repli sur l'ancienne table), port de pont -> ifIndex -> nom */
  const baseIf = idxByLast(await safeWalk(s, O.basePortIf, notes), O.basePortIf);
  const bridgeToName = (p: number): string => portName(vbNumber(baseIf.get(p)) ?? p);
  const clients: ClientSeen[] = [];
  const linkPorts = new Set(neighbors.map((n) => n.localPort));
  let fdb = await safeWalk(s, O.fdbQ, notes);
  let withVlan = true;
  if (fdb.length === 0) { fdb = await safeWalk(s, O.fdbOld, notes); withVlan = false; }
  for (const v of fdb) {
    const sfx = oidSuffix(v.oid, withVlan ? O.fdbQ : O.fdbOld);
    const need = withVlan ? 7 : 6;
    const port = vbNumber(v);
    if (!sfx || sfx.length !== need || port === null || port === 0) continue;
    const m = sfx.slice(need - 6);
    const mac = macOf(Buffer.from(m));
    const name = bridgeToName(port);
    if (!mac || linkPorts.has(name)) continue; // le trafic d'un port de liaison n'est pas « un client »
    if (clients.length >= TOPO_CLIENTS_PER_DEVICE) { notes.push("clients : liste tronquée"); break; }
    clients.push({ port: name, mac, vlan: withVlan ? sfx[0] : null });
  }

  /* table ARP (routeurs) : mac -> IP */
  const arp = new Map<string, string>();
  for (const v of await safeWalk(s, O.arp, notes)) {
    const sfx = oidSuffix(v.oid, O.arp);
    const mac = v.type === "str" ? macOf(v.value) : null;
    if (sfx && sfx.length === 5 && mac) arp.set(mac, sfx.slice(1).join("."));
  }

  return {
    name: sysName, info, chassisId: chassisText(g[3]),
    kind: kindFromServices(vbNumber(g[2]), info), ports, neighbors, clients, arp, speeds: speedByName, notes,
  };
}

/* ------------------------------ Parcours en largeur ------------------------------ */

export interface CrawlDevice {
  key: string;
  name: string;
  address: string | null;
  kind: TopoKind;
  info: string | null;
  chassisId: string | null;
  polled: boolean;
  ports: TopoPort[];
}
export interface CrawlLink { a: string; aPort: string | null; b: string; bPort: string | null; via: "lldp" | "cdp"; speedMbps: number | null; reportedBy: string }
export interface CrawlClient { device: string; port: string; mac: string; ip: string | null; vlan: number | null }
export interface CrawlResult { devices: CrawlDevice[]; links: CrawlLink[]; clients: CrawlClient[]; notes: string[]; cancelled: boolean }

export interface CrawlDeps {
  /** Ouvre une session SNMP vers l'adresse (une exception = injoignable). */
  connect(address: string): SnmpLike;
  /** Refus éventuel de l'adresse (null = autorisée). */
  refuse?(address: string): string | null;
  signal?: AbortSignal;
  onProgress?(p: { visited: number; queued: number; devices: number; links: number; clients: number }): void;
}

const norm = (s: string | null): string => (s ?? "").trim().toLowerCase();

/** Parcourt le réseau depuis `seed`. Chaque équipement est identifié par son identifiant de châssis, à défaut par son adresse, à défaut par son nom. */
export async function crawl(seed: string, depthMax: number, deps: CrawlDeps): Promise<CrawlResult> {
  const depthLimit = Math.max(0, Math.min(depthMax, TOPO_DEPTH_MAX));
  const notes: string[] = [];
  const devices: CrawlDevice[] = [];
  const links: CrawlLink[] = [];
  const clients: CrawlClient[] = [];
  const reads = new Map<string, DeviceRead>();
  const visitedAddr = new Set<string>();
  const queue: { address: string; depth: number }[] = [{ address: seed, depth: 0 }];
  let n = 0;

  const find = (chassis: string | null, address: string | null, name: string | null): CrawlDevice | undefined =>
    devices.find((d) => (chassis && d.chassisId && norm(d.chassisId) === norm(chassis)) || (address && d.address === address) || (!chassis && !address && name && norm(d.name) === norm(name)));

  const addDevice = (d: Omit<CrawlDevice, "key">): CrawlDevice | null => {
    if (devices.length >= TOPO_DEVICES_MAX) {
      if (!notes.includes("limit")) notes.push("limit");
      return null;
    }
    const dev = { ...d, key: `d${++n}` };
    devices.push(dev);
    return dev;
  };

  const progress = (): void => deps.onProgress?.({ visited: visitedAddr.size, queued: queue.length, devices: devices.length, links: links.length, clients: clients.length });

  let cancelled = false;
  while (queue.length) {
    if (deps.signal?.aborted) { cancelled = true; break; }
    const { address, depth } = queue.shift()!;
    if (visitedAddr.has(address)) continue;
    visitedAddr.add(address);
    const refused = deps.refuse?.(address) ?? null;
    if (refused) { notes.push(`${address} : ${refused}`); continue; }
    let read: DeviceRead;
    let session: SnmpLike | null = null;
    try {
      session = deps.connect(address);
      read = await readDevice(session);
    } catch (e) {
      notes.push(`${address} : ${(e as Error).message}`);
      continue;
    } finally {
      session?.close();
    }
    for (const x of read.notes) notes.push(`${address} : ${x}`);
    const existing = find(read.chassisId, address, read.name);
    let dev: CrawlDevice | null;
    if (existing) {
      Object.assign(existing, { name: read.name ?? existing.name, address, kind: read.kind !== "other" ? read.kind : existing.kind, info: read.info ?? existing.info, chassisId: read.chassisId ?? existing.chassisId, polled: true, ports: read.ports });
      dev = existing;
    } else {
      dev = addDevice({ name: read.name ?? address, address, kind: read.kind, info: read.info, chassisId: read.chassisId, polled: true, ports: read.ports });
    }
    if (!dev) continue;
    reads.set(dev.key, read);

    for (const nb of read.neighbors) {
      let other: CrawlDevice | null | undefined = find(nb.chassisId, nb.address, nb.name);
      if (!other) other = addDevice({ name: nb.name ?? nb.address ?? nb.chassisId ?? "?", address: nb.address, kind: nb.kind ?? "other", info: nb.info, chassisId: nb.chassisId, polled: false, ports: [] });
      else if (!other.polled) {
        other.address = other.address ?? nb.address;
        other.chassisId = other.chassisId ?? nb.chassisId;
        if (other.kind === "other" && nb.kind) other.kind = nb.kind;
      }
      if (!other || other.key === dev.key) continue;
      // le même lien est souvent annoncé des deux côtés : on le fusionne (même paire d'équipements, même port d'un des côtés)
      const dup = links.find((l) => ((l.a === dev!.key && l.b === other!.key && (norm(l.aPort) === norm(nb.localPort) || (nb.remotePort && norm(l.bPort) === norm(nb.remotePort)))) ||
        (l.a === other!.key && l.b === dev!.key && (norm(l.bPort) === norm(nb.localPort) || (nb.remotePort && norm(l.aPort) === norm(nb.remotePort))))));
      if (dup) {
        if (dup.a === dev.key) dup.aPort = dup.aPort ?? nb.localPort; else dup.bPort = dup.bPort ?? nb.localPort;
        dup.speedMbps = dup.speedMbps ?? read.speeds.get(nb.localPort) ?? null;
      } else {
        links.push({ a: dev.key, aPort: nb.localPort, b: other.key, bPort: nb.remotePort, via: nb.via, speedMbps: read.speeds.get(nb.localPort) ?? null, reportedBy: dev.key });
      }
      if (nb.address && !other.polled && depth < depthLimit && !visitedAddr.has(nb.address)) queue.push({ address: nb.address, depth: depth + 1 });
    }
    progress();
  }

  // machines : IP trouvée dans la table ARP de n'importe quel équipement interrogé
  const arpAll = new Map<string, string>();
  for (const r of reads.values()) for (const [m, ip] of r.arp) arpAll.set(m, ip);
  const polledMacs = new Set(devices.filter((d) => d.chassisId).map((d) => norm(d.chassisId)));
  for (const [key, r] of reads) {
    for (const c of r.clients) {
      if (polledMacs.has(c.mac)) continue; // c'est un équipement du réseau, pas une machine
      clients.push({ device: key, port: c.port, mac: c.mac, ip: arpAll.get(c.mac) ?? null, vlan: c.vlan });
    }
  }
  progress();
  return { devices, links, clients, notes, cancelled };
}
